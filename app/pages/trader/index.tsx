/**
 * /trader/:wallet — Public Trader Profile
 *
 * Phase 8: Full stats breakdown for a single trader.
 * Accessible from the feed leaderboard or via shareable URL.
 */

import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAccount } from "@orderly.network/hooks";
import { useLivePrices, calcUnrealizedPnl, distancePct } from "@/hooks/useLivePrices";
import { fetchOnChainRepScore } from "@/hooks/useThesisRegistry";
import { NexusTierBadge } from "@/components/NexusTierBadge";
import { MessageTraderButton } from "@/components/MessageTraderButton";
import type { ThesisTrade } from "@/pages/lab/types";
import CommentsPanel from "@/components/CommentsPanel";
import { deployToAgent } from "@/utils/agentPrefill";
import { deriveStyle } from "@/config/agentStyles";
import { PublicOperatorProfile, InFlightCalls, VenueEvidence } from "./ProfileSynthesis";
import { TrackedRecordCard } from "@/components/TrackedRecordCard";

const API_BASE = "https://og.nexustradinglabs.com";

// ─── Rep Score ───────────────────────────────────────────────────────────────
function calcRepScore(wins: number, losses: number, avgRR: number): number {
  const closed = wins + losses;
  const winRate = closed > 0 ? (wins / closed) * 100 : 0;
  const rrBonus = Math.min(avgRR * 10, 20);
  const samplePenalty = Math.max(0, 10 - closed) * 2;
  return Math.max(0, Math.min(100, Math.round(winRate + rrBonus - samplePenalty)));
}

type FeedThesis = {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward: number;
  positionSize: number;
  leverage: number;
  status: "ACTIVE" | "HIT_TP" | "STOPPED_OUT" | "INVALIDATED" | "CLOSED";
  actualPnl: number | null;
  createdAt: number;
  notes: string;
  wallet: string;
  pfp: string | null;
  displayName: string | null;
  fundingCost72h?: number;
  riskPercent?: number;
  accountSize?: number;
  copyCount?: number;
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  ACTIVE:      { label: "ACTIVE",      color: "#d4d4d8", bg: "#1a1a1e", border: "#33333a" },
  HIT_TP:      { label: "HIT TP",      color: "#ededf0", bg: "#1a1a1e", border: "#33333a" },
  STOPPED_OUT: { label: "STOPPED OUT", color: "#f7525f", bg: "#241012", border: "#4a1e22" },
  INVALIDATED: { label: "INVALIDATED", color: "#fbbf24", bg: "#2a1a00", border: "#4a3a00" },
  CLOSED:      { label: "CLOSED",      color: "#a1a1aa", bg: "#1a1a1e", border: "#33333a" },
  PENDING:     { label: "PENDING",     color: "#a1a1aa", bg: "#141416", border: "#33333a" },
};

// Neutral fallback for any unrecognized / future status value so the row never crashes.
const STATUS_FALLBACK = { label: "UNKNOWN", color: "#a1a1aa", bg: "#141416", border: "#33333a" };

// ─── Avatar ──────────────────────────────────────────────────────────────────
function WalletIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="14" rx="2" />
      <path d="M16 12h4" />
      <circle cx="18" cy="12" r="1" fill="currentColor" />
      <path d="M6 2h8a2 2 0 0 1 2 2v2H4V4a2 2 0 0 1 2-2z" />
    </svg>
  );
}

function Avatar({ pfp, displayName, size = 48 }: { pfp: string | null; displayName: string | null; size?: number }) {
  const [err, setErr] = useState(false);
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      border: "2px solid #232327", background: "#141416",
      overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
      color: "#52525b", flexShrink: 0,
    }}>
      {pfp && !err ? (
        <img src={pfp} alt={displayName ?? ""} onError={() => setErr(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <WalletIcon />
      )}
    </div>
  );
}

// ─── Stat Box ─────────────────────────────────────────────────────────────────
function StatBox({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{
      background: "#141416",
      border: "1px solid #232327",
      borderRadius: 4,
      padding: "12px 16px",
      textAlign: "center",
    }}>
      <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#52525b", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 17, fontWeight: "bold", color: color ?? "#a1a1aa", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      {sub && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ─── Thesis Row ───────────────────────────────────────────────────────────────
function ThesisRow({
  thesis,
  markPrice,
  onCopy,
  isOwn,
  walletAddress,
}: {
  thesis: FeedThesis;
  markPrice?: number | null;
  onCopy?: (t: FeedThesis) => void;
  isOwn: boolean;
  walletAddress: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentCount, setCommentCount] = useState(0);
  const cfg = STATUS_CONFIG[thesis.status] ?? STATUS_FALLBACK;
  const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
  const timeAgo = (() => {
    const diff = Date.now() - thesis.createdAt;
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    return "just now";
  })();

  const pnlData = thesis.status === "ACTIVE" && markPrice != null
    ? calcUnrealizedPnl(thesis.direction, thesis.entryPrice, markPrice, thesis.positionSize)
    : null;

  return (
    <div style={{
      background: "#141416",
      border: `1px solid ${cfg.border}`,
      borderRadius: 4,
      overflow: "hidden",
      opacity: thesis.status === "INVALIDATED" ? 0.65 : 1,
    }}>
      {/* Main row */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
      >
        {/* Ticker + direction */}
        <div style={{ minWidth: 100, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 15, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
          <span style={{
            fontFamily: "var(--nx-font-mono)", fontSize: 10,
            color: thesis.direction === "LONG" ? "#3ecf8e" : "#f7525f",
          }}>
            {thesis.direction === "LONG" ? "↑" : "↓"} {thesis.direction}
          </span>
          {(thesis.copyCount ?? 0) > 0 && (
            <span style={{
              fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#a1a1aa",
              background: "#1a1a1e", border: "1px solid #232327",
              borderRadius: 3, padding: "1px 5px",
            }}>
              📋 {thesis.copyCount}
            </span>
          )}
        </div>

        {/* Levels */}
        <div style={{ display: "flex", gap: 16, flex: 1, flexWrap: "wrap" }}>
          {[
            { label: "ENTRY", val: `$${thesis.entryPrice.toFixed(2)}`, color: "#a1a1aa" },
            { label: "STOP",  val: `$${thesis.stopLoss.toFixed(2)}`,   color: "#f7525f" },
            { label: "TP1",   val: `$${thesis.takeProfit1.toFixed(2)}`, color: "#ededf0" },
            { label: "R:R",   val: `1:${thesis.riskReward.toFixed(2)}`, color: thesis.riskReward >= 2 ? "#ededf0" : "#fbbf24" },
            { label: "SIZE",  val: `$${thesis.positionSize.toFixed(0)}`, color: "#a1a1aa" },
          ].map(({ label, val, color }) => (
            <div key={label}>
              <div style={{ fontSize: 7, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{label}</div>
              <div style={{ fontSize: 11, color, fontFamily: "var(--nx-font-mono)" }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Live P&L badge (if active) */}
        {pnlData && (
          <div style={{
            fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold",
            color: pnlData.pnl >= 0 ? "#3ecf8e" : "#f7525f",
          }}>
            {pnlData.pnl >= 0 ? "+" : ""}${pnlData.pnl.toFixed(2)}
            <span style={{ fontSize: 9, opacity: 0.7, marginLeft: 3 }}>({pnlData.pct >= 0 ? "+" : ""}{pnlData.pct.toFixed(2)}%)</span>
          </div>
        )}

        {/* Actual PnL (closed) */}
        {thesis.actualPnl !== null && thesis.status !== "ACTIVE" && (
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold", color: thesis.actualPnl >= 0 ? "#3ecf8e" : "#f7525f" }}>
            {thesis.actualPnl >= 0 ? "+" : ""}${thesis.actualPnl.toFixed(2)}
          </div>
        )}

        {/* Status + time */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.08em",
            padding: "2px 7px", borderRadius: 3,
            background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
          }}>{cfg.label}</div>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#33333a" }}>{timeAgo}</div>
        </div>

        {/* Copy button */}
        {walletAddress && !isOwn && onCopy && (
          <button
            onClick={(e) => { e.stopPropagation(); onCopy(thesis); }}
            style={{
              background: "none", border: "1px solid #232327", borderRadius: 3,
              color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 9,
              padding: "3px 8px", cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "#ededf0";
              (e.currentTarget as HTMLButtonElement).style.color = "#ededf0";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "#232327";
              (e.currentTarget as HTMLButtonElement).style.color = "#71717a";
            }}
          >COPY</button>
        )}

        {/* Comments toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setCommentsOpen((o) => !o); }}
          style={{
            background: commentsOpen ? "#1a1a1e" : "none",
            border: `1px solid ${commentsOpen ? "#ededf0" : "#232327"}`,
            borderRadius: 3,
            color: commentsOpen ? "#ededf0" : "#52525b",
            fontFamily: "var(--nx-font-mono)",
            fontSize: 9,
            padding: "3px 7px",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          💬 {commentCount}
        </button>
        <div style={{ color: "#33333a", fontSize: 10 }}>{expanded ? "▲" : "▼"}</div>
      </div>

      {/* Expanded: full details + notes + live grid */}
      {expanded && (
        <div style={{ borderTop: "1px solid #232327", padding: "12px 16px" }}>
          {/* Live price grid */}
          {thesis.status === "ACTIVE" && markPrice != null && (() => {
            const { pnl, pct } = calcUnrealizedPnl(thesis.direction, thesis.entryPrice, markPrice, thesis.positionSize);
            const toSL = distancePct(markPrice, thesis.stopLoss);
            const toTP = distancePct(markPrice, thesis.takeProfit1);
            return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px 12px", marginBottom: 12, padding: 10, background: "#0f0f11", borderRadius: 4, border: "1px solid #232327" }}>
                {[
                  { label: "MARK", val: `$${markPrice.toFixed(markPrice < 10 ? 4 : 2)}`, color: "#fff" },
                  { label: "UNREALIZED", val: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`, color: pnl >= 0 ? "#3ecf8e" : "#f7525f" },
                  { label: "TO SL", val: `${toSL.toFixed(2)}%`, color: "#f7525f" },
                  { label: "TO TP1", val: `${toTP.toFixed(2)}%`, color: "#ededf0" },
                ].map(({ label, val, color }) => (
                  <div key={label}>
                    <div style={{ fontSize: 7, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{label}</div>
                    <div style={{ fontSize: 11, color, fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{val}</div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Notes */}
          {thesis.notes && (
            <div style={{
              fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#a1a1aa",
              lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>
              {thesis.notes}
            </div>
          )}
        </div>
      )}
      <CommentsPanel
        thesisId={thesis.id}
        walletAddress={walletAddress}
        isOpen={commentsOpen}
        onCountChange={setCommentCount}
      />
    </div>
  );
}

const COPY_PREFS_KEY = "nexus-copy-prefs";

// ─── Copy Modal (inline, same logic as feed) ──────────────────────────────────
function CopyModal({ thesis, walletAddress, onClose }: { thesis: FeedThesis; walletAddress: string; onClose: () => void }) {
  const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
  const traderName = thesis.displayName ?? `${thesis.wallet.slice(0, 6)}…${thesis.wallet.slice(-4)}`;

  const [accountSize, setAccountSize] = useState(() => {
    try { return JSON.parse(localStorage.getItem(COPY_PREFS_KEY) ?? "{}").accountSize ?? ""; }
    catch { return ""; }
  });
  const [riskPct, setRiskPct] = useState(() => {
    try { return JSON.parse(localStorage.getItem(COPY_PREFS_KEY) ?? "{}").riskPct ?? "1.5"; }
    catch { return "1.5"; }
  });
  const [fundingRate, setFundingRate] = useState("0.01");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  // Persist prefs on change
  useEffect(() => {
    try { localStorage.setItem(COPY_PREFS_KEY, JSON.stringify({ accountSize, riskPct })); }
    catch { /* ignore */ }
  }, [accountSize, riskPct]);

  const accNum = parseFloat(accountSize);
  const riskNum = parseFloat(riskPct);
  const accErr = accountSize !== "" && (isNaN(accNum) || accNum <= 0) ? "must be > 0" : "";
  const riskErr = riskPct !== "" && (isNaN(riskNum) || riskNum < 0.1 || riskNum > 100) ? "must be 0.1–100" : "";
  const hasValidationErr = !!accErr || !!riskErr;

  const calc = useMemo(() => {
    if (hasValidationErr) return null;
    const acc = parseFloat(accountSize);
    const risk = parseFloat(riskPct);
    const fund = parseFloat(fundingRate);
    if (!acc || !risk || !thesis.entryPrice || !thesis.stopLoss || !thesis.takeProfit1) return null;
    const stopDist = Math.abs(thesis.entryPrice - thesis.stopLoss) / thesis.entryPrice;
    const rewardDist = Math.abs(thesis.takeProfit1 - thesis.entryPrice) / thesis.entryPrice;
    if (stopDist === 0) return null;
    const riskAmount = acc * (risk / 100);
    const positionSize = Math.min(riskAmount / stopDist, acc * 100);
    const leverage = positionSize / acc;
    const riskReward = rewardDist / stopDist;
    const fundingPerPeriod = positionSize * (Math.abs(fund) / 100);
    return { positionSize, leverage, riskReward, riskAmount, fundingPerPeriod };
  }, [accountSize, riskPct, fundingRate, thesis, hasValidationErr]);

  const inputStyle: React.CSSProperties = {
    background: "#0f0f11", border: "1px solid #232327", borderRadius: 3,
    color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 11,
    padding: "6px 8px", outline: "none", width: "100%", boxSizing: "border-box",
  };

  async function handleSave() {
    if (!calc || hasValidationErr) { setErr("check inputs"); return; }
    setSaving(true); setErr("");
    try {
      const resp = await fetch(`${API_BASE}/lab/${walletAddress}`);
      const existing = resp.ok ? await resp.json() : { theses: [], notes: {} };
      const existingTheses: ThesisTrade[] = existing.theses ?? [];
      const newThesis: ThesisTrade = {
        id: `copy_${Date.now()}`, symbol: thesis.symbol, direction: thesis.direction,
        entryPrice: thesis.entryPrice, stopLoss: thesis.stopLoss,
        takeProfit1: thesis.takeProfit1, takeProfit2: thesis.takeProfit2,
        riskPercent: parseFloat(riskPct), accountSize: parseFloat(accountSize),
        fundingRate: parseFloat(fundingRate), positionSize: calc.positionSize,
        leverage: calc.leverage, riskReward: calc.riskReward,
        fundingCost8h: calc.fundingPerPeriod, fundingCost24h: calc.fundingPerPeriod * 3,
        fundingCost72h: calc.fundingPerPeriod * 9,
        notes: `📋 Copied from ${traderName}${thesis.notes ? `\n\n${thesis.notes}` : ""}`,
        createdAt: Date.now(), status: "ACTIVE", actualPnl: null, isPublic: false,
        copiedFromWallet: thesis.wallet,
      };
      await fetch(`${API_BASE}/lab/${walletAddress}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theses: [newThesis, ...existingTheses],
          notes: existing.notes ?? {},
          copiedFromWallet: thesis.wallet,
          copiedThesisSymbol: thesis.symbol,
          copiedThesisDirection: thesis.direction,
          copiedThesisId: thesis.id,
        }),
      });
      setSaved(true);
      setTimeout(onClose, 1200);
    } catch { setErr("failed to save — check connection"); }
    finally { setSaving(false); }
  }

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{
      position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{ background: "#141416", border: "1px solid #232327", borderRadius: 6, padding: 20, width: "100%", maxWidth: 400, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 15, fontWeight: "bold", color: "#fff" }}>
              {ticker} <span style={{ fontSize: 11, color: thesis.direction === "LONG" ? "#3ecf8e" : "#f7525f" }}>{thesis.direction}</span>
            </div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 2 }}>📋 copying from {traderName}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#52525b", cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>

        {/* Inputs */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 4 }}>ACCOUNT SIZE ($)</div>
            <input style={{ ...inputStyle, borderColor: accErr ? "#4a1e22" : "#232327" }} type="number" placeholder="10000" value={accountSize} onChange={(e) => setAccountSize(e.target.value)} />
            {accErr && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#f7525f", marginTop: 3 }}>{accErr}</div>}
          </div>
          <div>
            <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 4 }}>RISK %</div>
            <input style={{ ...inputStyle, borderColor: riskErr ? "#4a1e22" : "#232327" }} type="number" placeholder="1.5" step="0.1" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} />
            {riskErr && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#f7525f", marginTop: 3 }}>{riskErr}</div>}
          </div>
          <div>
            <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 4 }}>FUNDING %</div>
            <input style={inputStyle} type="number" placeholder="0.01" step="0.001" value={fundingRate} onChange={(e) => setFundingRate(e.target.value)} />
          </div>
        </div>

        {/* Calc output */}
        <div style={{ marginTop: 10, marginBottom: 12 }}>
          {calc ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px 10px", padding: 10, background: "#1a1a1e", borderRadius: 4, border: "1px solid #232327" }}>
              <div>
                <div style={{ fontSize: 7, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>YOUR SIZE</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#ededf0", fontWeight: "bold" }}>${calc.positionSize.toFixed(0)}</div>
              </div>
              <div>
                <div style={{ fontSize: 7, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>LEVERAGE</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: "bold", color: calc.leverage > 25 ? "#f7525f" : calc.leverage > 10 ? "#fbbf24" : "#3ecf8e" }}>{calc.leverage.toFixed(1)}x</div>
              </div>
              <div>
                <div style={{ fontSize: 7, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>R:R</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: "bold", color: calc.riskReward >= 2 ? "#ededf0" : "#fbbf24" }}>1:{calc.riskReward.toFixed(2)}</div>
              </div>
              <div>
                <div style={{ fontSize: 7, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>MAX LOSS</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#f7525f", fontWeight: "bold" }}>${calc.riskAmount.toFixed(2)}</div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 10, background: "#0f0f11", borderRadius: 4, border: "1px solid #232327", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#33333a", textAlign: "center" }}>
              enter account size + risk % to calculate
            </div>
          )}
        </div>

        {err && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#f7525f", marginBottom: 10 }}>{err}</div>}
        <button
          onClick={handleSave}
          disabled={saving || saved || !calc || hasValidationErr}
          style={{
            width: "100%", background: saved ? "#1a1a1e" : calc && !hasValidationErr ? "#1a1a1e" : "#0f0f11",
            border: `1px solid ${saved ? "#ededf0" : calc && !hasValidationErr ? "#ededf0" : "#232327"}`,
            color: saved ? "#ededf0" : calc && !hasValidationErr ? "#ededf0" : "#33333a",
            fontFamily: "var(--nx-font-mono)", fontSize: 11, letterSpacing: "0.1em",
            padding: "10px 0", borderRadius: 4, cursor: calc && !saving && !saved && !hasValidationErr ? "pointer" : "default",
          }}
        >
          {saved ? "✓ SAVED TO LAB" : saving ? "saving..." : "SAVE TO LAB →"}
        </button>
      </div>
    </div>
  );
}

// ─── Trader Page ──────────────────────────────────────────────────────────────
export default function TraderPage() {
  const { wallet } = useParams<{ wallet: string }>();
  const navigate = useNavigate();
  const [theses, setTheses] = useState<FeedThesis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [copyTarget, setCopyTarget] = useState<FeedThesis | null>(null);
  const [copied, setCopied] = useState(false);
  // Ph26: on-chain Rep Score from NexusRepScore contract
  const [onChainRep, setOnChainRep] = useState<number | null>(null);
  const [agentRec, setAgentRec] = useState<any | null>(null);
  const [pubStrats, setPubStrats] = useState<any[]>([]);

  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const isOwn = walletAddress?.toLowerCase() === wallet?.toLowerCase();

  // Fetch all public theses, filter to this wallet
  useEffect(() => {
    if (!wallet) return;
    setLoading(true);
    setError(false);
    setOnChainRep(null);
    fetch(`${API_BASE}/feed`)
      .then((r) => r.json())
      .then((data: { feed: FeedThesis[] }) => {
        const all = data.feed ?? [];
        setTheses(all.filter((t) => t.wallet.toLowerCase() === wallet.toLowerCase()));
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
    // Ph26: fetch on-chain Rep Score in parallel
    fetchOnChainRepScore(wallet)
      .then((result) => setOnChainRep(result.repScore))
      .catch(() => {});
    // Hub: this trader's graded AGENT record + their published strategies.
    setAgentRec(null); setPubStrats([]);
    fetch(`${API_BASE}/agents/standing/${wallet}`).then((r) => r.ok ? r.json() : null).then((d) => setAgentRec(d?.stats && d.stats.trades > 0 ? d.stats : null)).catch(() => {});
    fetch(`${API_BASE}/agent/${wallet}/strategies`).then((r) => r.ok ? r.json() : null).then((d) => setPubStrats((d?.strategies || []).filter((s: any) => s.public))).catch(() => {});
  }, [wallet]);

  // Live prices for active theses
  const activeSymbols = useMemo(
    () => [...new Set(theses.filter((t) => t.status === "ACTIVE").map((t) => t.symbol))],
    [theses]
  );
  const livePrices = useLivePrices(activeSymbols);
  // The unresolved book — what the in-flight tracker and the says-vs-holds check read.
  const openCalls = useMemo(
    () => theses.filter((t) => t.status === "ACTIVE").map((t) => ({
      symbol: t.symbol, direction: t.direction,
      entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfit1: t.takeProfit1,
    })),
    [theses],
  );

  // Derived stats
  const stats = useMemo(() => {
    const wins = theses.filter((t) => t.status === "HIT_TP").length;
    const losses = theses.filter((t) => t.status === "STOPPED_OUT").length;
    const active = theses.filter((t) => t.status === "ACTIVE").length;
    const invalidated = theses.filter((t) => t.status === "INVALIDATED").length;
    const closed = wins + losses;
    const winRate = closed > 0 ? (wins / closed) * 100 : null;
    const avgRR = theses.length > 0
      ? theses.reduce((sum, t) => sum + t.riskReward, 0) / theses.length
      : 0;
    const bestTrade = theses.reduce<FeedThesis | null>((best, t) =>
      !best || t.riskReward > best.riskReward ? t : best, null);
    const totalPnl = theses
      .filter((t) => t.actualPnl !== null)
      .reduce((sum, t) => sum + (t.actualPnl ?? 0), 0);
    const hasPnl = theses.some((t) => t.actualPnl !== null);
    return { wins, losses, active, invalidated, closed, winRate, avgRR, bestTrade, totalPnl, hasPnl };
  }, [theses]);

  // Pull each identity field from the first thesis that actually has it — a wallet's
  // theses can carry different snapshots, so keying both off theses[0] left us showing
  // a name with a mismatched / missing picture.
  const displayName = theses.find((t) => t.displayName)?.displayName ?? null;
  const pfp = theses.find((t) => t.pfp)?.pfp ?? null;
  const shortAddr = wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "";

  function copyLink() {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // Ph14 — OG meta tags for social sharing
  useEffect(() => {
    if (loading || !wallet) return;
    const name = displayName ?? shortAddr;
    const rep = onChainRep ?? calcRepScore(stats.wins, stats.losses, stats.avgRR);
    const winRateStr = stats.winRate !== null ? `${stats.winRate.toFixed(0)}%` : "—";
    const title = `${name} on Nexus`;
    const description = `Win rate: ${winRateStr} | Avg R:R: 1:${stats.avgRR.toFixed(2)} | Rep: ${rep}`;

    const setMeta = (property: string, content: string) => {
      let el = document.querySelector(`meta[property="${property}"]`);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute("property", property);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
    };

    const OG_BASE = "https://og.nexustradinglabs.com"; // Ph20: custom domain on nexus-lab-api Worker
    setMeta("og:title", title);
    setMeta("og:description", description);
    setMeta("og:image", `${OG_BASE}/og/trader/${wallet}`);            // SVG — Discord, Telegram, iMessage
    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:title", title);
    setMeta("twitter:description", description);
    setMeta("twitter:image", `${OG_BASE}/og/trader/${wallet}.png`);   // Ph21: PNG for Twitter
    setMeta("og:url", window.location.href);
    document.title = title;

    return () => {
      setMeta("og:title", "Nexus Trading Labs");
      setMeta("og:description", "Non-custodial Perpetual DEX on Arbitrum");
      setMeta("og:image", "https://nexustradinglabs.com/og.png");
      setMeta("og:url", "https://trade.nexustradinglabs.com");
      setMeta("twitter:card", "summary_large_image");
      setMeta("twitter:title", "Nexus Trading Labs");
      setMeta("twitter:description", "Non-custodial Perpetual DEX on Arbitrum");
      setMeta("twitter:image", "https://nexustradinglabs.com/og.png");
      document.title = "Nexus Trading Labs";
    };
  }, [wallet, loading, displayName, shortAddr, stats.wins, stats.losses, stats.avgRR, stats.winRate]);

  if (!wallet) return null;

  // Ph26: pre-compute rep display values to avoid IIFE pattern in JSX (TSC cascade errors)
  const repForDisplay = onChainRep ?? calcRepScore(stats.wins, stats.losses, stats.avgRR);
  const isOnChainRep = onChainRep !== null;
  const repColor = repForDisplay >= 70 ? "#3ecf8e" : repForDisplay >= 40 ? "#fbbf24" : "#f7525f";
  const showRepBadge = stats.closed > 0 || onChainRep !== null;

  return (
    <div style={{ background: "#0a0a0b", minHeight: "100svh" }}>
      {/* Copy modal */}
      {copyTarget && walletAddress && (
        <CopyModal thesis={copyTarget} walletAddress={walletAddress} onClose={() => setCopyTarget(null)} />
      )}

      {/* Header */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #232327", background: "#0f0f11", display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={() => navigate("/feed")}
          style={{ background: "none", border: "none", color: "#52525b", cursor: "pointer", fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: 0 }}
        >
          ← FEED
        </button>
        <div style={{ flex: 1, fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#33333a", letterSpacing: "0.05em" }}>
          / TRADER
        </div>
        {/* DM button — shared affordance; hidden for your own profile */}
        <MessageTraderButton wallet={wallet} myWallet={walletAddress} variant="full" />
        {/* Share link button */}
        <button
          onClick={copyLink}
          style={{
            background: "none", border: "1px solid #232327", borderRadius: 3,
            color: copied ? "#ededf0" : "#52525b", fontFamily: "var(--nx-font-mono)", fontSize: 9,
            padding: "4px 10px", cursor: "pointer", letterSpacing: "0.05em",
          }}
        >
          {copied ? "✓ COPIED" : "⎘ SHARE"}
        </button>
      </div>

      <div style={{ padding: 16, maxWidth: 860, margin: "0 auto" }}>
        {loading && (
          <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#33333a" }}>
            loading trader profile...
          </div>
        )}

        {error && !loading && (
          <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#f7525f" }}>
            failed to load — check connection
          </div>
        )}

        {!loading && !error && (
          <>
            {/* Trader identity */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24, padding: "16px 20px", background: "#141416", border: "1px solid #232327", borderRadius: 6 }}>
              <Avatar pfp={pfp} displayName={displayName} size={56} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: "bold", color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {displayName ?? shortAddr}
                  </span>
                  {isOwn && <span style={{ color: "#ededf0", fontSize: 11, flexShrink: 0 }}>YOU</span>}
                  {wallet && <span style={{ flexShrink: 0 }}><NexusTierBadge address={wallet} /></span>}
                </div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#52525b", marginTop: 2 }}>{shortAddr}</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#33333a", marginTop: 4 }}>
                  {theses.length} public thesis{theses.length !== 1 ? "es" : ""}
                </div>
              </div>
              {/* Cross-check: this board ranks GRADED CALLS, but a caller's real
                  venue record is separate evidence. New tab on purpose — verifying
                  shouldn't cost you your place on the profile. */}
              {wallet && (
                <a
                  href={`/analyze?address=${wallet}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="X-ray this wallet's actual perp record on Hyperliquid + Orderly — verify before you copy"
                  style={{
                    flexShrink: 0, fontFamily: "var(--nx-font-mono)", fontSize: 10,
                    color: "#ededf0", textDecoration: "none", border: "1px solid #33333a",
                    borderRadius: 4, padding: "8px 12px", whiteSpace: "nowrap",
                  }}
                >
                  ⌕ X-RAY ↗
                </a>
              )}
              {/* Rep Score badge — Ph26: on-chain value from NexusRepScore contract */}
              {showRepBadge && (
                <div style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  padding: "8px 14px", border: `1px solid ${repColor}22`, borderRadius: 4,
                  background: `${repColor}08`, flexShrink: 0,
                }}>
                  <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: isOnChainRep ? "#ededf0" : "#52525b", letterSpacing: "0.08em" }}>
                    {isOnChainRep ? "⛓REP" : "REP"}
                  </div>
                  <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 28, fontWeight: "bold", color: repColor, lineHeight: 1.1 }}>{repForDisplay}</div>
                </div>
              )}
            </div>

            {theses.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0" }}>
                <div style={{ fontSize: 20, color: "#33333a", marginBottom: 8 }}>◆</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#33333a" }}>
                  no public theses from this trader yet
                </div>
              </div>
            ) : (
              <>
                {/* SYNTHESIS FIRST — who this trader is, what's in flight, and what the
                    venue independently says. The raw stat grid below is the evidence. */}
                <PublicOperatorProfile wallet={wallet ?? null} isOwn={isOwn} />
                <InFlightCalls calls={openCalls} prices={livePrices} />
                <VenueEvidence wallet={wallet ?? null} openCalls={openCalls} />

                {/* The accruing, self-grading on-chain record (Operator Score, trend,
                    copy record) — same surface as the Smart Money x-ray, so a trader's
                    public page and their x-ray can never tell a different story. */}
                {wallet && <TrackedRecordCard address={wallet} />}

                {/* Stats grid */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 8, marginBottom: 24 }}>
                  <StatBox
                    label="WIN RATE"
                    value={stats.winRate !== null ? `${stats.winRate.toFixed(0)}%` : "—"}
                    sub={stats.closed > 0 ? `${stats.wins}W / ${stats.losses}L` : "no closed trades"}
                    color={stats.winRate === null ? "#52525b" : stats.winRate >= 60 ? "#3ecf8e" : stats.winRate >= 40 ? "#fbbf24" : "#f7525f"}
                  />
                  <StatBox
                    label="AVG R:R"
                    value={`1:${stats.avgRR.toFixed(2)}`}
                    sub="all theses"
                    color={stats.avgRR >= 2 ? "#ededf0" : "#fbbf24"}
                  />
                  <StatBox
                    label="ACTIVE"
                    value={String(stats.active)}
                    sub="live trades"
                    color={stats.active > 0 ? "#d4d4d8" : "#52525b"}
                  />
                  <StatBox
                    label="TOTAL"
                    value={String(theses.length)}
                    sub={`${stats.invalidated} invalidated`}
                    color="#a1a1aa"
                  />
                  {stats.hasPnl && (
                    <StatBox
                      label="REALIZED P&L"
                      value={`${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}`}
                      sub="closed trades"
                      color={stats.totalPnl >= 0 ? "#3ecf8e" : "#f7525f"}
                    />
                  )}
                  {stats.bestTrade && (
                    <StatBox
                      label="BEST R:R"
                      value={`1:${stats.bestTrade.riskReward.toFixed(2)}`}
                      sub={stats.bestTrade.symbol.replace("PERP_", "").replace("_USDC", "")}
                      color="#ededf0"
                    />
                  )}
                </div>

                {/* Hub: this trader's graded autonomous-agent record */}
                {agentRec && (
                  <div style={{ marginBottom: 16, border: "1px solid #232327", borderRadius: 6, padding: 14, background: "#0a0a0b" }}>
                    <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.08em", marginBottom: 10 }}>AUTONOMOUS AGENT — GRADED RECORD</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(80px,1fr))", gap: 12 }}>
                      {[
                        { l: "NET P&L", v: `${agentRec.netPnl >= 0 ? "+" : ""}$${agentRec.netPnl}`, c: agentRec.netPnl >= 0 ? "#3ecf8e" : "#f7525f" },
                        { l: "WIN RATE", v: `${agentRec.winRate}%`, c: "#d4d4d8" },
                        { l: "TRADES", v: String(agentRec.trades), c: "#d4d4d8" },
                        { l: "SCORE", v: `${agentRec.score}`, c: "#d4d4d8" },
                      ].map((x) => (
                        <div key={x.l}>
                          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", letterSpacing: "0.1em", marginBottom: 3 }}>{x.l}</div>
                          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 16, fontWeight: 600, color: x.c }}>{x.v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Hub: this trader's published strategies — copyable to your own agent */}
                {pubStrats.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.08em", marginBottom: 10 }}>PUBLISHED STRATEGIES — copy to your agent</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {pubStrats.map((s) => (
                        <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "8px 10px", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600, color: "#d4d4d8" }}>{s.name} <span style={{ color: "#d4d4d8", fontSize: 9 }}>{deriveStyle(s.config)}</span></div>
                            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#a1a1aa", marginTop: 2 }}>{s.config.signalMode} · {s.config.leverage}x · TP{s.config.tpPercent}/SL{s.config.slPercent}</div>
                          </div>
                          <button onClick={() => deployToAgent(s.config, `${displayName ?? shortAddr}'s "${s.name}"`, undefined, navigate)} style={{ background: "none", border: "1px solid #33333a", color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "5px 14px", borderRadius: 3, cursor: "pointer", flexShrink: 0 }}>COPY →</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Thesis list */}
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.08em", marginBottom: 10 }}>
                  THESES — click to expand
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {theses
                    .slice()
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map((t) => (
                      <ThesisRow
                        key={t.id}
                        thesis={t}
                        markPrice={livePrices[t.symbol] ?? null}
                        onCopy={setCopyTarget}
                        isOwn={isOwn}
                        walletAddress={walletAddress}
                      />
                    ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
