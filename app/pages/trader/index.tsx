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
import type { ThesisTrade } from "@/pages/lab/types";
import CommentsPanel from "@/components/CommentsPanel";
import { deployToAgent } from "@/utils/agentPrefill";
import { deriveStyle } from "@/config/agentStyles";

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
  ACTIVE:      { label: "ACTIVE",      color: "#4a9fff", bg: "#0a1a2a", border: "#1a3a5a" },
  HIT_TP:      { label: "HIT TP",      color: "#00ff88", bg: "#0a2a0a", border: "#1a4a2a" },
  STOPPED_OUT: { label: "STOPPED OUT", color: "#ff4444", bg: "#2a0a0a", border: "#4a1a1a" },
  INVALIDATED: { label: "INVALIDATED", color: "#fbbf24", bg: "#2a1a00", border: "#4a3a00" },
  CLOSED:      { label: "CLOSED",      color: "#8aaa9a", bg: "#12161a", border: "#2a3a4a" },
  PENDING:     { label: "PENDING",     color: "#8aaa9a", bg: "#0d120d", border: "#2a4a3a" },
};

// Neutral fallback for any unrecognized / future status value so the row never crashes.
const STATUS_FALLBACK = { label: "UNKNOWN", color: "#8aaa9a", bg: "#0d120d", border: "#2a4a3a" };

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
      border: "2px solid #1a3a1a", background: "#0d120d",
      overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
      color: "#3a5a4a", flexShrink: 0,
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
      background: "#0d120d",
      border: "1px solid #1a2e1a",
      borderRadius: 4,
      padding: "12px 16px",
      textAlign: "center",
    }}>
      <div style={{ fontFamily: "monospace", fontSize: 8, color: "#3a5a4a", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: "bold", color: color ?? "#8aaa9a" }}>{value}</div>
      {sub && <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a", marginTop: 2 }}>{sub}</div>}
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
      background: "#0d120d",
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
          <span style={{ fontFamily: "monospace", fontSize: 15, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
          <span style={{
            fontFamily: "monospace", fontSize: 10,
            color: thesis.direction === "LONG" ? "#00ff88" : "#ff4444",
          }}>
            {thesis.direction === "LONG" ? "↑" : "↓"} {thesis.direction}
          </span>
          {(thesis.copyCount ?? 0) > 0 && (
            <span style={{
              fontFamily: "monospace", fontSize: 8, color: "#5a8a6a",
              background: "#0a1a0a", border: "1px solid #1a3a1a",
              borderRadius: 3, padding: "1px 5px",
            }}>
              📋 {thesis.copyCount}
            </span>
          )}
        </div>

        {/* Levels */}
        <div style={{ display: "flex", gap: 16, flex: 1, flexWrap: "wrap" }}>
          {[
            { label: "ENTRY", val: `$${thesis.entryPrice.toFixed(2)}`, color: "#8aaa9a" },
            { label: "STOP",  val: `$${thesis.stopLoss.toFixed(2)}`,   color: "#ff4444" },
            { label: "TP1",   val: `$${thesis.takeProfit1.toFixed(2)}`, color: "#00ff88" },
            { label: "R:R",   val: `1:${thesis.riskReward.toFixed(2)}`, color: thesis.riskReward >= 2 ? "#00ff88" : "#fbbf24" },
            { label: "SIZE",  val: `$${thesis.positionSize.toFixed(0)}`, color: "#8aaa9a" },
          ].map(({ label, val, color }) => (
            <div key={label}>
              <div style={{ fontSize: 7, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</div>
              <div style={{ fontSize: 11, color, fontFamily: "monospace" }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Live P&L badge (if active) */}
        {pnlData && (
          <div style={{
            fontFamily: "monospace", fontSize: 11, fontWeight: "bold",
            color: pnlData.pnl >= 0 ? "#00ff88" : "#ff4444",
          }}>
            {pnlData.pnl >= 0 ? "+" : ""}${pnlData.pnl.toFixed(2)}
            <span style={{ fontSize: 9, opacity: 0.7, marginLeft: 3 }}>({pnlData.pct >= 0 ? "+" : ""}{pnlData.pct.toFixed(2)}%)</span>
          </div>
        )}

        {/* Actual PnL (closed) */}
        {thesis.actualPnl !== null && thesis.status !== "ACTIVE" && (
          <div style={{ fontFamily: "monospace", fontSize: 11, fontWeight: "bold", color: thesis.actualPnl >= 0 ? "#00ff88" : "#ff4444" }}>
            {thesis.actualPnl >= 0 ? "+" : ""}${thesis.actualPnl.toFixed(2)}
          </div>
        )}

        {/* Status + time */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            fontFamily: "monospace", fontSize: 8, letterSpacing: "0.08em",
            padding: "2px 7px", borderRadius: 3,
            background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
          }}>{cfg.label}</div>
          <div style={{ fontFamily: "monospace", fontSize: 9, color: "#2a4a3a" }}>{timeAgo}</div>
        </div>

        {/* Copy button */}
        {walletAddress && !isOwn && onCopy && (
          <button
            onClick={(e) => { e.stopPropagation(); onCopy(thesis); }}
            style={{
              background: "none", border: "1px solid #1a3a1a", borderRadius: 3,
              color: "#3a6a4a", fontFamily: "monospace", fontSize: 9,
              padding: "3px 8px", cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "#00ff88";
              (e.currentTarget as HTMLButtonElement).style.color = "#00ff88";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a3a1a";
              (e.currentTarget as HTMLButtonElement).style.color = "#3a6a4a";
            }}
          >COPY</button>
        )}

        {/* Comments toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setCommentsOpen((o) => !o); }}
          style={{
            background: commentsOpen ? "#0a1a0a" : "none",
            border: `1px solid ${commentsOpen ? "#00ff88" : "#1a2e1a"}`,
            borderRadius: 3,
            color: commentsOpen ? "#00ff88" : "#3a5a4a",
            fontFamily: "monospace",
            fontSize: 9,
            padding: "3px 7px",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          💬 {commentCount}
        </button>
        <div style={{ color: "#2a4a3a", fontSize: 10 }}>{expanded ? "▲" : "▼"}</div>
      </div>

      {/* Expanded: full details + notes + live grid */}
      {expanded && (
        <div style={{ borderTop: "1px solid #1a2e1a", padding: "12px 16px" }}>
          {/* Live price grid */}
          {thesis.status === "ACTIVE" && markPrice != null && (() => {
            const { pnl, pct } = calcUnrealizedPnl(thesis.direction, thesis.entryPrice, markPrice, thesis.positionSize);
            const toSL = distancePct(markPrice, thesis.stopLoss);
            const toTP = distancePct(markPrice, thesis.takeProfit1);
            return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px 12px", marginBottom: 12, padding: 10, background: "#080c08", borderRadius: 4, border: "1px solid #1a2e1a" }}>
                {[
                  { label: "MARK", val: `$${markPrice.toFixed(markPrice < 10 ? 4 : 2)}`, color: "#fff" },
                  { label: "UNREALIZED", val: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`, color: pnl >= 0 ? "#00ff88" : "#ff4444" },
                  { label: "TO SL", val: `${toSL.toFixed(2)}%`, color: "#ff4444" },
                  { label: "TO TP1", val: `${toTP.toFixed(2)}%`, color: "#00ff88" },
                ].map(({ label, val, color }) => (
                  <div key={label}>
                    <div style={{ fontSize: 7, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</div>
                    <div style={{ fontSize: 11, color, fontFamily: "monospace", fontWeight: "bold" }}>{val}</div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Notes */}
          {thesis.notes && (
            <div style={{
              fontFamily: "monospace", fontSize: 10, color: "#5a8a6a",
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
    background: "#080c08", border: "1px solid #1a2e1a", borderRadius: 3,
    color: "#00ff88", fontFamily: "monospace", fontSize: 11,
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
      <div style={{ background: "#0d120d", border: "1px solid #1a3a1a", borderRadius: 6, padding: 20, width: "100%", maxWidth: 400, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: 15, fontWeight: "bold", color: "#fff" }}>
              {ticker} <span style={{ fontSize: 11, color: thesis.direction === "LONG" ? "#00ff88" : "#ff4444" }}>{thesis.direction}</span>
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a", marginTop: 2 }}>📋 copying from {traderName}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#3a5a4a", cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>

        {/* Inputs */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 4 }}>ACCOUNT SIZE ($)</div>
            <input style={{ ...inputStyle, borderColor: accErr ? "#4a1a1a" : "#1a2e1a" }} type="number" placeholder="10000" value={accountSize} onChange={(e) => setAccountSize(e.target.value)} />
            {accErr && <div style={{ fontFamily: "monospace", fontSize: 8, color: "#ff4444", marginTop: 3 }}>{accErr}</div>}
          </div>
          <div>
            <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 4 }}>RISK %</div>
            <input style={{ ...inputStyle, borderColor: riskErr ? "#4a1a1a" : "#1a2e1a" }} type="number" placeholder="1.5" step="0.1" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} />
            {riskErr && <div style={{ fontFamily: "monospace", fontSize: 8, color: "#ff4444", marginTop: 3 }}>{riskErr}</div>}
          </div>
          <div>
            <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 4 }}>FUNDING %</div>
            <input style={inputStyle} type="number" placeholder="0.01" step="0.001" value={fundingRate} onChange={(e) => setFundingRate(e.target.value)} />
          </div>
        </div>

        {/* Calc output */}
        <div style={{ marginTop: 10, marginBottom: 12 }}>
          {calc ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px 10px", padding: 10, background: "#0a1a0a", borderRadius: 4, border: "1px solid #1a3a1a" }}>
              <div>
                <div style={{ fontSize: 7, color: "#3a5a4a", fontFamily: "monospace" }}>YOUR SIZE</div>
                <div style={{ fontFamily: "monospace", fontSize: 13, color: "#00ff88", fontWeight: "bold" }}>${calc.positionSize.toFixed(0)}</div>
              </div>
              <div>
                <div style={{ fontSize: 7, color: "#3a5a4a", fontFamily: "monospace" }}>LEVERAGE</div>
                <div style={{ fontFamily: "monospace", fontSize: 13, fontWeight: "bold", color: calc.leverage > 25 ? "#ff4444" : calc.leverage > 10 ? "#fbbf24" : "#00ff88" }}>{calc.leverage.toFixed(1)}x</div>
              </div>
              <div>
                <div style={{ fontSize: 7, color: "#3a5a4a", fontFamily: "monospace" }}>R:R</div>
                <div style={{ fontFamily: "monospace", fontSize: 13, fontWeight: "bold", color: calc.riskReward >= 2 ? "#00ff88" : "#fbbf24" }}>1:{calc.riskReward.toFixed(2)}</div>
              </div>
              <div>
                <div style={{ fontSize: 7, color: "#3a5a4a", fontFamily: "monospace" }}>MAX LOSS</div>
                <div style={{ fontFamily: "monospace", fontSize: 13, color: "#ff4444", fontWeight: "bold" }}>${calc.riskAmount.toFixed(2)}</div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 10, background: "#080c08", borderRadius: 4, border: "1px solid #1a2e1a", fontFamily: "monospace", fontSize: 9, color: "#2a4a3a", textAlign: "center" }}>
              enter account size + risk % to calculate
            </div>
          )}
        </div>

        {err && <div style={{ fontFamily: "monospace", fontSize: 10, color: "#ff4444", marginBottom: 10 }}>{err}</div>}
        <button
          onClick={handleSave}
          disabled={saving || saved || !calc || hasValidationErr}
          style={{
            width: "100%", background: saved ? "#0a2a0a" : calc && !hasValidationErr ? "#0a1a0a" : "#080c08",
            border: `1px solid ${saved ? "#00ff88" : calc && !hasValidationErr ? "#00ff88" : "#1a2e1a"}`,
            color: saved ? "#00ff88" : calc && !hasValidationErr ? "#00ff88" : "#2a4a3a",
            fontFamily: "monospace", fontSize: 11, letterSpacing: "0.1em",
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

  const displayName = theses[0]?.displayName ?? null;
  const pfp = theses[0]?.pfp ?? null;
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
  const repColor = repForDisplay >= 70 ? "#00ff88" : repForDisplay >= 40 ? "#fbbf24" : "#ff4444";
  const showRepBadge = stats.closed > 0 || onChainRep !== null;

  return (
    <div style={{ background: "#0a0e0a", minHeight: "100dvh" }}>
      {/* Copy modal */}
      {copyTarget && walletAddress && (
        <CopyModal thesis={copyTarget} walletAddress={walletAddress} onClose={() => setCopyTarget(null)} />
      )}

      {/* Header */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #1a2e1a", background: "#080c08", display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={() => navigate("/feed")}
          style={{ background: "none", border: "none", color: "#3a5a4a", cursor: "pointer", fontFamily: "monospace", fontSize: 10, padding: 0 }}
        >
          ← FEED
        </button>
        <div style={{ flex: 1, fontFamily: "monospace", fontSize: 10, color: "#2a4a3a", letterSpacing: "0.05em" }}>
          / TRADER
        </div>
        {/* DM button — only when viewing another trader */}
        {walletAddress && !isOwn && (
          <button
            onClick={() => navigate(`/messages?dm=${wallet}`)}
            title="Send encrypted DM via XMTP"
            style={{
              background: "none", border: "1px solid #1a2e1a", borderRadius: 3,
              color: "#3a5a4a", fontFamily: "monospace", fontSize: 9,
              padding: "4px 10px", cursor: "pointer", letterSpacing: "0.05em",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "#00ff88";
              (e.currentTarget as HTMLButtonElement).style.color = "#00ff88";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a2e1a";
              (e.currentTarget as HTMLButtonElement).style.color = "#3a5a4a";
            }}
          >
            ⬡ MSG
          </button>
        )}
        {/* Share link button */}
        <button
          onClick={copyLink}
          style={{
            background: "none", border: "1px solid #1a2e1a", borderRadius: 3,
            color: copied ? "#00ff88" : "#3a5a4a", fontFamily: "monospace", fontSize: 9,
            padding: "4px 10px", cursor: "pointer", letterSpacing: "0.05em",
          }}
        >
          {copied ? "✓ COPIED" : "⎘ SHARE"}
        </button>
      </div>

      <div style={{ padding: 16, maxWidth: 860, margin: "0 auto" }}>
        {loading && (
          <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "monospace", fontSize: 12, color: "#2a4a3a" }}>
            loading trader profile...
          </div>
        )}

        {error && !loading && (
          <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "monospace", fontSize: 12, color: "#ff4444" }}>
            failed to load — check connection
          </div>
        )}

        {!loading && !error && (
          <>
            {/* Trader identity */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24, padding: "16px 20px", background: "#0d120d", border: "1px solid #1a3a1a", borderRadius: 6 }}>
              <Avatar pfp={pfp} displayName={displayName} size={56} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span style={{ fontFamily: "monospace", fontSize: 18, fontWeight: "bold", color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {displayName ?? shortAddr}
                  </span>
                  {isOwn && <span style={{ color: "#00ff88", fontSize: 11, flexShrink: 0 }}>YOU</span>}
                  {wallet && <span style={{ flexShrink: 0 }}><NexusTierBadge address={wallet} /></span>}
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 10, color: "#3a5a4a", marginTop: 2 }}>{shortAddr}</div>
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#2a4a3a", marginTop: 4 }}>
                  {theses.length} public thesis{theses.length !== 1 ? "es" : ""}
                </div>
              </div>
              {/* Rep Score badge — Ph26: on-chain value from NexusRepScore contract */}
              {showRepBadge && (
                <div style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  padding: "8px 14px", border: `1px solid ${repColor}22`, borderRadius: 4,
                  background: `${repColor}08`, flexShrink: 0,
                }}>
                  <div style={{ fontFamily: "monospace", fontSize: 8, color: isOnChainRep ? "#00ff88" : "#3a5a4a", letterSpacing: "0.08em" }}>
                    {isOnChainRep ? "⛓REP" : "REP"}
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 28, fontWeight: "bold", color: repColor, lineHeight: 1.1 }}>{repForDisplay}</div>
                </div>
              )}
            </div>

            {theses.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0" }}>
                <div style={{ fontSize: 20, color: "#2a4a3a", marginBottom: 8 }}>◆</div>
                <div style={{ fontFamily: "monospace", fontSize: 12, color: "#2a4a3a" }}>
                  no public theses from this trader yet
                </div>
              </div>
            ) : (
              <>
                {/* Stats grid */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 8, marginBottom: 24 }}>
                  <StatBox
                    label="WIN RATE"
                    value={stats.winRate !== null ? `${stats.winRate.toFixed(0)}%` : "—"}
                    sub={stats.closed > 0 ? `${stats.wins}W / ${stats.losses}L` : "no closed trades"}
                    color={stats.winRate === null ? "#3a5a4a" : stats.winRate >= 60 ? "#00ff88" : stats.winRate >= 40 ? "#fbbf24" : "#ff4444"}
                  />
                  <StatBox
                    label="AVG R:R"
                    value={`1:${stats.avgRR.toFixed(2)}`}
                    sub="all theses"
                    color={stats.avgRR >= 2 ? "#00ff88" : "#fbbf24"}
                  />
                  <StatBox
                    label="ACTIVE"
                    value={String(stats.active)}
                    sub="live trades"
                    color={stats.active > 0 ? "#4a9fff" : "#3a5a4a"}
                  />
                  <StatBox
                    label="TOTAL"
                    value={String(theses.length)}
                    sub={`${stats.invalidated} invalidated`}
                    color="#8aaa9a"
                  />
                  {stats.hasPnl && (
                    <StatBox
                      label="REALIZED P&L"
                      value={`${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}`}
                      sub="closed trades"
                      color={stats.totalPnl >= 0 ? "#00ff88" : "#ff4444"}
                    />
                  )}
                  {stats.bestTrade && (
                    <StatBox
                      label="BEST R:R"
                      value={`1:${stats.bestTrade.riskReward.toFixed(2)}`}
                      sub={stats.bestTrade.symbol.replace("PERP_", "").replace("_USDC", "")}
                      color="#00ff88"
                    />
                  )}
                </div>

                {/* Hub: this trader's graded autonomous-agent record */}
                {agentRec && (
                  <div style={{ marginBottom: 16, border: "1px solid #1a2e1a", borderRadius: 6, padding: 14, background: "#0a0e0a" }}>
                    <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a", letterSpacing: "0.08em", marginBottom: 10 }}>AUTONOMOUS AGENT — GRADED RECORD</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(80px,1fr))", gap: 12 }}>
                      {[
                        { l: "NET P&L", v: `${agentRec.netUsd >= 0 ? "+" : ""}$${agentRec.netUsd}`, c: agentRec.netUsd >= 0 ? "#00ff88" : "#ff4444" },
                        { l: "WIN RATE", v: `${agentRec.winRate}%`, c: "#c0c0c0" },
                        { l: "TRADES", v: String(agentRec.trades), c: "#c0c0c0" },
                        { l: "SCORE", v: `${agentRec.score}`, c: "#4a9fff" },
                      ].map((x) => (
                        <div key={x.l}>
                          <div style={{ fontFamily: "monospace", fontSize: 9, color: "#4a7a5a", letterSpacing: "0.1em", marginBottom: 3 }}>{x.l}</div>
                          <div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 600, color: x.c }}>{x.v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Hub: this trader's published strategies — copyable to your own agent */}
                {pubStrats.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a", letterSpacing: "0.08em", marginBottom: 10 }}>PUBLISHED STRATEGIES — copy to your agent</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {pubStrats.map((s) => (
                        <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "8px 10px", background: "#0a0e0a", border: "1px solid #1a2e1a", borderRadius: 3 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: "#c0c0c0" }}>{s.name} <span style={{ color: "#4a9fff", fontSize: 9 }}>{deriveStyle(s.config)}</span></div>
                            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#5a7a6a", marginTop: 2 }}>{s.config.signalMode} · {s.config.leverage}x · TP{s.config.tpPercent}/SL{s.config.slPercent}</div>
                          </div>
                          <button onClick={() => deployToAgent(s.config, `${displayName ?? shortAddr}'s "${s.name}"`)} style={{ background: "none", border: "1px solid #1a4a2a", color: "#00ff88", fontFamily: "monospace", fontSize: 9, padding: "5px 14px", borderRadius: 3, cursor: "pointer", flexShrink: 0 }}>COPY →</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Thesis list */}
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a", letterSpacing: "0.08em", marginBottom: 10 }}>
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
