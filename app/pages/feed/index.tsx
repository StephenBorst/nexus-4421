/**
 * /feed — Public Thesis Feed
 *
 * Shows all theses marked isPublic=true across all wallets.
 * Phase 6: COPY button — pre-fills a modal so any trader can copy a thesis into their LAB.
 * Phase 7: RANKS view — thesis leaderboard aggregated from feed data.
 */

import { useState, useEffect, useMemo } from "react";
import { useAccount } from "@orderly.network/hooks";
import { useNavigate } from "react-router-dom";
import { useLivePrices, calcUnrealizedPnl, distancePct } from "@/hooks/useLivePrices";
import { fetchOnChainRepScore } from "@/hooks/useThesisRegistry";
import type { ThesisTrade } from "@/pages/lab/types";

const API_BASE = "https://nexus-lab-api.stephenpatrick24.workers.dev";

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
  status: "ACTIVE" | "HIT_TP" | "STOPPED_OUT" | "INVALIDATED";
  actualPnl: number | null;
  createdAt: number;
  notes: string;
  wallet: string;
  pfp: string | null;
  displayName: string | null;
  fundingCost72h?: number;
  riskPercent?: number;
  accountSize?: number;
  onChainId?: number;
  onChainTxHash?: string;
};

const STATUS_CONFIG = {
  ACTIVE:      { label: "ACTIVE",      color: "#4a9fff", bg: "#0a1a2a", border: "#1a3a5a" },
  HIT_TP:      { label: "HIT TP",      color: "#00ff88", bg: "#0a2a0a", border: "#1a4a2a" },
  STOPPED_OUT: { label: "STOPPED OUT", color: "#ff4444", bg: "#2a0a0a", border: "#4a1a1a" },
  INVALIDATED: { label: "INVALIDATED", color: "#fbbf24", bg: "#2a1a00", border: "#4a3a00" },
};

// ─── Calc helper (mirrors lab/index.tsx calcThesis) ─────────────────────────
function calcCopy(
  entry: number,
  sl: number,
  tp1: number,
  accountSize: number,
  riskPct: number,
  fundingRate: number,
  direction: "LONG" | "SHORT",
) {
  if (!entry || !sl || !tp1 || !accountSize || !riskPct) return null;
  const stopDistancePct = Math.abs(entry - sl) / entry;
  const rewardDistance = Math.abs(tp1 - entry) / entry;
  if (stopDistancePct === 0) return null;
  const riskAmount = accountSize * (riskPct / 100);
  const positionSize = Math.min(riskAmount / stopDistancePct, accountSize * 100);
  const leverage = positionSize / accountSize;
  const riskReward = rewardDistance / stopDistancePct;
  const fundingPerPeriod = positionSize * (Math.abs(fundingRate) / 100);
  return { positionSize, leverage, riskReward, riskAmount, fundingPerPeriod };
}

// ─── Copy Modal ──────────────────────────────────────────────────────────────
function CopyModal({
  thesis,
  walletAddress,
  onClose,
}: {
  thesis: FeedThesis;
  walletAddress: string;
  onClose: () => void;
}) {
  const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
  const traderName = thesis.displayName ?? `${thesis.wallet.slice(0, 6)}…${thesis.wallet.slice(-4)}`;

  const [accountSize, setAccountSize] = useState("");
  const [riskPct, setRiskPct] = useState("1.5");
  const [fundingRate, setFundingRate] = useState("0.01");
  const [extraNotes, setExtraNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const calc = useMemo(() => {
    const acc = parseFloat(accountSize);
    const risk = parseFloat(riskPct);
    const fund = parseFloat(fundingRate);
    if (!acc || !risk) return null;
    return calcCopy(
      thesis.entryPrice, thesis.stopLoss, thesis.takeProfit1,
      acc, risk, fund, thesis.direction,
    );
  }, [accountSize, riskPct, fundingRate, thesis]);

  const inputStyle: React.CSSProperties = {
    background: "#080c08",
    border: "1px solid #1a2e1a",
    borderRadius: 3,
    color: "#00ff88",
    fontFamily: "monospace",
    fontSize: 11,
    padding: "6px 8px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 8,
    color: "#3a5a4a",
    fontFamily: "monospace",
    marginBottom: 4,
    letterSpacing: "0.05em",
  };

  async function handleSave() {
    if (!calc) { setErr("fill in account size and risk %"); return; }
    setSaving(true);
    setErr("");
    try {
      // Fetch existing LAB data
      const resp = await fetch(`${API_BASE}/lab/${walletAddress}`);
      const existing = resp.ok ? await resp.json() : { theses: [], notes: "" };
      const existingTheses: ThesisTrade[] = existing.theses ?? [];

      const attribution = `📋 Copied from ${traderName}${thesis.notes ? `\n\n${thesis.notes}` : ""}${extraNotes ? `\n\n${extraNotes}` : ""}`;

      const newThesis: ThesisTrade = {
        id: `copy_${Date.now()}`,
        symbol: thesis.symbol,
        direction: thesis.direction,
        entryPrice: thesis.entryPrice,
        stopLoss: thesis.stopLoss,
        takeProfit1: thesis.takeProfit1,
        takeProfit2: thesis.takeProfit2,
        riskPercent: parseFloat(riskPct),
        accountSize: parseFloat(accountSize),
        fundingRate: parseFloat(fundingRate),
        positionSize: calc.positionSize,
        leverage: calc.leverage,
        riskReward: calc.riskReward,
        fundingCost8h: calc.fundingPerPeriod,
        fundingCost24h: calc.fundingPerPeriod * 3,
        fundingCost72h: calc.fundingPerPeriod * 9,
        notes: attribution,
        createdAt: Date.now(),
        status: "ACTIVE",
        actualPnl: null,
        isPublic: false,
      };

      const updated = [newThesis, ...existingTheses];
      await fetch(`${API_BASE}/lab/${walletAddress}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theses: updated,
          notes: existing.notes ?? {},
          copiedFromWallet: thesis.wallet,
          copiedThesisSymbol: thesis.symbol,
          copiedThesisDirection: thesis.direction,
        }),
      });

      setSaved(true);
      setTimeout(onClose, 1200);
    } catch {
      setErr("failed to save — check connection");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.75)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
    >
      <div style={{
        background: "#0d120d",
        border: "1px solid #1a3a1a",
        borderRadius: 6,
        padding: 20,
        width: "100%",
        maxWidth: 420,
        maxHeight: "90vh",
        overflowY: "auto",
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: "bold", color: "#fff" }}>
              {ticker}
              <span style={{ fontSize: 11, marginLeft: 8, color: thesis.direction === "LONG" ? "#00ff88" : "#ff4444" }}>
                {thesis.direction === "LONG" ? "↑" : "↓"} {thesis.direction}
              </span>
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a", marginTop: 2 }}>
              📋 copying from {traderName}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#3a5a4a", cursor: "pointer", fontSize: 16, padding: 0 }}
          >✕</button>
        </div>

        {/* Original levels (read-only) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px 12px", marginBottom: 16, padding: 10, background: "#080c08", borderRadius: 4, border: "1px solid #1a2e1a" }}>
          {[
            { label: "ENTRY", val: `$${thesis.entryPrice.toFixed(2)}`, color: "#8aaa9a" },
            { label: "STOP",  val: `$${thesis.stopLoss.toFixed(2)}`,   color: "#ff4444" },
            { label: "TP1",   val: `$${thesis.takeProfit1.toFixed(2)}`, color: "#00ff88" },
            { label: "R:R",   val: `1:${thesis.riskReward.toFixed(2)}`, color: thesis.riskReward >= 2 ? "#00ff88" : "#fbbf24" },
          ].map(({ label, val, color }) => (
            <div key={label}>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</div>
              <div style={{ fontSize: 11, color, fontFamily: "monospace", fontWeight: "bold" }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Editable: account size + risk */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={labelStyle}>ACCOUNT SIZE ($)</div>
            <input
              style={inputStyle}
              type="number"
              placeholder="10000"
              value={accountSize}
              onChange={(e) => setAccountSize(e.target.value)}
            />
          </div>
          <div>
            <div style={labelStyle}>RISK %</div>
            <input
              style={inputStyle}
              type="number"
              placeholder="1.5"
              step="0.1"
              value={riskPct}
              onChange={(e) => setRiskPct(e.target.value)}
            />
          </div>
          <div>
            <div style={labelStyle}>FUNDING %</div>
            <input
              style={inputStyle}
              type="number"
              placeholder="0.01"
              step="0.001"
              value={fundingRate}
              onChange={(e) => setFundingRate(e.target.value)}
            />
          </div>
        </div>

        {/* Live calc output */}
        {calc ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px 12px", marginBottom: 12, padding: 10, background: "#0a1a0a", borderRadius: 4, border: "1px solid #1a3a1a" }}>
            <div>
              <div style={labelStyle}>YOUR SIZE</div>
              <div style={{ fontFamily: "monospace", fontSize: 14, color: "#00ff88", fontWeight: "bold" }}>${calc.positionSize.toFixed(0)}</div>
            </div>
            <div>
              <div style={labelStyle}>LEVERAGE</div>
              <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: "bold", color: calc.leverage > 25 ? "#ff4444" : calc.leverage > 10 ? "#fbbf24" : "#00ff88" }}>
                {calc.leverage.toFixed(1)}x
              </div>
            </div>
            <div>
              <div style={labelStyle}>RISK $</div>
              <div style={{ fontFamily: "monospace", fontSize: 14, color: "#ff4444", fontWeight: "bold" }}>${calc.riskAmount.toFixed(2)}</div>
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 12, padding: 10, background: "#080c08", borderRadius: 4, border: "1px solid #1a2e1a", fontFamily: "monospace", fontSize: 9, color: "#2a4a3a", textAlign: "center" }}>
            enter account size + risk % to calculate your position
          </div>
        )}

        {/* Additional notes */}
        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>ADDITIONAL NOTES (optional)</div>
          <textarea
            style={{ ...inputStyle, resize: "vertical", minHeight: 60 }}
            placeholder="your thoughts on this trade..."
            value={extraNotes}
            onChange={(e) => setExtraNotes(e.target.value)}
          />
        </div>

        {/* Attribution preview */}
        <div style={{ marginBottom: 14, padding: 8, background: "#080c08", borderRadius: 3, border: "1px solid #1a2e1a" }}>
          <div style={labelStyle}>ATTRIBUTION (auto-added to notes)</div>
          <div style={{ fontFamily: "monospace", fontSize: 9, color: "#5a8a6a", lineHeight: 1.5 }}>
            📋 Copied from {traderName}
          </div>
        </div>

        {/* Error */}
        {err && (
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#ff4444", marginBottom: 10 }}>{err}</div>
        )}

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving || saved || !calc}
          style={{
            width: "100%",
            background: saved ? "#0a2a0a" : calc ? "#0a1a0a" : "#080c08",
            border: `1px solid ${saved ? "#00ff88" : calc ? "#00ff88" : "#1a2e1a"}`,
            color: saved ? "#00ff88" : calc ? "#00ff88" : "#2a4a3a",
            fontFamily: "monospace",
            fontSize: 11,
            letterSpacing: "0.1em",
            padding: "10px 0",
            borderRadius: 4,
            cursor: calc && !saving && !saved ? "pointer" : "default",
          }}
        >
          {saved ? "✓ SAVED TO LAB" : saving ? "saving..." : "SAVE TO LAB →"}
        </button>
      </div>
    </div>
  );
}

// ─── Avatar ──────────────────────────────────────────────────────────────────
function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="14" rx="2" />
      <path d="M16 12h4" />
      <circle cx="18" cy="12" r="1" fill="currentColor" />
      <path d="M6 2h8a2 2 0 0 1 2 2v2H4V4a2 2 0 0 1 2-2z" />
    </svg>
  );
}

function Avatar({ pfp, displayName, size = 32 }: { pfp: string | null; displayName: string | null; size?: number }) {
  const [err, setErr] = useState(false);
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      border: "1px solid #1a2e1a", background: "#0d120d",
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

// ─── Feed Card ───────────────────────────────────────────────────────────────
function FeedCard({
  thesis,
  markPrice,
  walletAddress,
  onCopy,
  following,
  onFollowToggle,
}: {
  thesis: FeedThesis;
  markPrice?: number | null;
  walletAddress: string | null;
  onCopy: (t: FeedThesis) => void;
  following: Set<string>;
  onFollowToggle: (wallet: string) => void;
}) {
  const cfg = STATUS_CONFIG[thesis.status];
  const shortAddr = `${thesis.wallet.slice(0, 6)}…${thesis.wallet.slice(-4)}`;
  const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
  const isOwnThesis = walletAddress?.toLowerCase() === thesis.wallet.toLowerCase();
  const isFollowing = following.has(thesis.wallet.toLowerCase());
  const navigate = useNavigate();
  const timeAgo = (() => {
    const diff = Date.now() - thesis.createdAt;
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    return "just now";
  })();

  return (
    <div style={{
      background: "#0d120d",
      border: `1px solid ${cfg.border}`,
      borderRadius: 4,
      padding: "14px 16px",
      opacity: thesis.status === "INVALIDATED" ? 0.65 : 1,
    }}>
      {/* Header: avatar + identity + status + time + copy */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Avatar pfp={thesis.pfp} displayName={thesis.displayName} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "monospace", fontSize: 11, color: "#8aaa9a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {thesis.displayName ?? shortAddr}
          </div>
          <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a" }}>{shortAddr}</div>
        </div>
        <div style={{
          fontFamily: "monospace", fontSize: 9, letterSpacing: "0.08em",
          padding: "3px 8px", borderRadius: 3,
          background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
          flexShrink: 0,
        }}>
          {cfg.label}
        </div>
        <div style={{ fontFamily: "monospace", fontSize: 9, color: "#2a4a3a", flexShrink: 0 }}>{timeAgo}</div>
        {/* On-chain verified badge */}
        {thesis.onChainId !== undefined && (
          thesis.onChainTxHash ? (
            <a
              href={`https://arbiscan.io/tx/${thesis.onChainTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`On-chain verified · thesis #${thesis.onChainId}`}
              style={{ fontSize: 12, textDecoration: "none", flexShrink: 0 }}
              onClick={(e) => e.stopPropagation()}
            >⛓</a>
          ) : (
            <span title={`On-chain verified · thesis #${thesis.onChainId}`} style={{ fontSize: 12, flexShrink: 0 }}>⛓</span>
          )
        )}
        {/* Share link button */}
        <button
          onClick={() => navigate(`/feed/thesis/${thesis.wallet}/${thesis.id}`)}
          title="View thesis permalink"
          style={{
            background: "none", border: "1px solid #1a2e1a", borderRadius: 3,
            color: "#2a4a3a", fontFamily: "monospace", fontSize: 9,
            padding: "3px 7px", cursor: "pointer", flexShrink: 0, letterSpacing: "0.05em",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#4a9fff"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a3a5a"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#2a4a3a"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a2e1a"; }}
        >↗</button>
        {/* Follow button — only if wallet connected and not own wallet */}
        {walletAddress && !isOwnThesis && (
          <button
            onClick={() => onFollowToggle(thesis.wallet.toLowerCase())}
            title={isFollowing ? "Unfollow trader" : "Follow trader"}
            style={{
              background: isFollowing ? "#0a1a0a" : "none",
              border: `1px solid ${isFollowing ? "#1a4a2a" : "#1a2e1a"}`,
              borderRadius: 3, color: isFollowing ? "#00ff88" : "#3a5a4a",
              fontFamily: "monospace", fontSize: 9,
              padding: "3px 7px", cursor: "pointer", flexShrink: 0, letterSpacing: "0.05em",
            }}
          >{isFollowing ? "✓" : "+"}</button>
        )}
        {/* Copy button — only if wallet connected and not your own thesis */}
        {walletAddress && !isOwnThesis && (
          <button
            onClick={() => onCopy(thesis)}
            title="Copy this thesis to your LAB"
            style={{
              background: "none",
              border: "1px solid #1a3a1a",
              borderRadius: 3,
              color: "#3a6a4a",
              fontFamily: "monospace",
              fontSize: 9,
              padding: "3px 7px",
              cursor: "pointer",
              flexShrink: 0,
              letterSpacing: "0.05em",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "#00ff88";
              (e.currentTarget as HTMLButtonElement).style.color = "#00ff88";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a3a1a";
              (e.currentTarget as HTMLButtonElement).style.color = "#3a6a4a";
            }}
          >
            COPY
          </button>
        )}
      </div>

      {/* Symbol + direction */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{ fontFamily: "monospace", fontSize: 18, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
        <span style={{
          fontFamily: "monospace", fontSize: 11,
          color: thesis.direction === "LONG" ? "#00ff88" : "#ff4444",
        }}>
          {thesis.direction === "LONG" ? "↑" : "↓"} {thesis.direction} · {thesis.leverage.toFixed(1)}x
        </span>
      </div>

      {/* Key levels grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "8px 12px", marginBottom: 10 }}>
        {[
          { label: "ENTRY", val: `$${thesis.entryPrice.toFixed(2)}`, color: undefined },
          { label: "STOP",  val: `$${thesis.stopLoss.toFixed(2)}`,   color: "#ff4444" },
          { label: "TP1",   val: `$${thesis.takeProfit1.toFixed(2)}`, color: "#00ff88" },
          { label: "R:R",   val: `1:${thesis.riskReward.toFixed(2)}`, color: thesis.riskReward >= 2 ? "#00ff88" : "#fbbf24" },
          { label: "SIZE",  val: `$${thesis.positionSize.toFixed(0)}`, color: undefined },
        ].map(({ label, val, color }) => (
          <div key={label}>
            <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</div>
            <div style={{ fontSize: 12, color: color ?? "#8aaa9a", fontFamily: "monospace" }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Live P&L — active theses with mark price */}
      {thesis.status === "ACTIVE" && markPrice != null && (() => {
        const { pnl, pct } = calcUnrealizedPnl(thesis.direction, thesis.entryPrice, markPrice, thesis.positionSize);
        const toSL = distancePct(markPrice, thesis.stopLoss);
        const toTP = distancePct(markPrice, thesis.takeProfit1);
        const isWinning = pnl >= 0;
        return (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px 12px", marginBottom: 10, paddingTop: 10, borderTop: "1px solid #1a2e1a" }}>
            <div>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>MARK</div>
              <div style={{ fontSize: 12, color: "#fff", fontFamily: "monospace", fontWeight: "bold" }}>
                ${markPrice.toFixed(markPrice < 10 ? 4 : 2)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>UNREALIZED</div>
              <div style={{ fontSize: 12, fontFamily: "monospace", fontWeight: "bold", color: isWinning ? "#00ff88" : "#ff4444" }}>
                {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.7 }}>({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>TO SL</div>
              <div style={{ fontSize: 12, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>{toSL.toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>TO TP1</div>
              <div style={{ fontSize: 12, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>{toTP.toFixed(2)}%</div>
            </div>
          </div>
        );
      })()}

      {/* Actual PnL (if closed) */}
      {thesis.actualPnl !== null && thesis.status !== "ACTIVE" && (
        <div style={{ fontFamily: "monospace", fontSize: 12, color: thesis.actualPnl >= 0 ? "#00ff88" : "#ff4444", marginBottom: 8 }}>
          ACTUAL PnL: {thesis.actualPnl >= 0 ? "+" : ""}${thesis.actualPnl.toFixed(2)}
        </div>
      )}

      {/* Notes */}
      {thesis.notes && (
        <div style={{
          fontFamily: "monospace", fontSize: 10, color: "#5a8a6a",
          borderTop: "1px solid #1a2e1a", paddingTop: 8, marginTop: 4,
          lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {thesis.notes}
        </div>
      )}
    </div>
  );
}

// ─── Rep Score ───────────────────────────────────────────────────────────────
function calcRepScore(wins: number, losses: number, avgRR: number): number {
  const closed = wins + losses;
  const winRate = closed > 0 ? (wins / closed) * 100 : 0;
  const rrBonus = Math.min(avgRR * 10, 20);
  const samplePenalty = Math.max(0, 10 - closed) * 2;
  return Math.max(0, Math.min(100, Math.round(winRate + rrBonus - samplePenalty)));
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────
type TraderStats = {
  wallet: string;
  displayName: string | null;
  pfp: string | null;
  total: number;
  wins: number;
  losses: number;
  active: number;
  invalidated: number;
  winRate: number;
  avgRR: number;
  bestRR: number;
  bestTicker: string;
};

function buildLeaderboard(feed: FeedThesis[]): TraderStats[] {
  const map = new Map<string, TraderStats>();

  for (const t of feed) {
    const key = t.wallet.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        wallet: t.wallet,
        displayName: t.displayName,
        pfp: t.pfp,
        total: 0, wins: 0, losses: 0, active: 0, invalidated: 0,
        winRate: 0, avgRR: 0, bestRR: 0, bestTicker: "",
      });
    }
    const s = map.get(key)!;
    s.total++;
    if (t.status === "ACTIVE") s.active++;
    else if (t.status === "HIT_TP") s.wins++;
    else if (t.status === "STOPPED_OUT") s.losses++;
    else if (t.status === "INVALIDATED") s.invalidated++;

    if (t.riskReward > s.bestRR) {
      s.bestRR = t.riskReward;
      s.bestTicker = t.symbol.replace("PERP_", "").replace("_USDC", "");
    }
  }

  // Compute derived stats
  for (const s of map.values()) {
    const closed = s.wins + s.losses;
    s.winRate = closed > 0 ? (s.wins / closed) * 100 : 0;

    // Avg R:R from all theses for this wallet
    const walletTheses = feed.filter(t => t.wallet.toLowerCase() === s.wallet.toLowerCase());
    s.avgRR = walletTheses.length > 0
      ? walletTheses.reduce((sum, t) => sum + t.riskReward, 0) / walletTheses.length
      : 0;
  }

  // Ph18: sort by Rep Score (composite: winRate + R:R bonus - sample penalty)
  return [...map.values()].sort((a, b) => {
    const aRep = calcRepScore(a.wins, a.losses, a.avgRR);
    const bRep = calcRepScore(b.wins, b.losses, b.avgRR);
    if (bRep !== aRep) return bRep - aRep;
    return b.total - a.total;
  });
}

const RANK_MEDALS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

function LeaderboardView({ feed, walletAddress, onCopy }: {
  feed: FeedThesis[];
  walletAddress: string | null;
  onCopy: (t: FeedThesis) => void;
}) {
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);
  const board = useMemo(() => buildLeaderboard(feed), [feed]);
  const navigate = useNavigate();

  // Ph12/26 -- trustless on-chain stats + Rep Score from NexusRepScore contract
  const [onChainStats, setOnChainStats] = useState<Map<string, { wins: number; losses: number; active: number; repScore: number; avgRR: number }>>(new Map());
  const [onChainLoading, setOnChainLoading] = useState(false);

  useEffect(() => {
    if (board.length === 0) return;
    setOnChainLoading(true);
    Promise.all(
      board.map(async (trader) => {
        try {
          const stats = await fetchOnChainRepScore(trader.wallet);
          return { wallet: trader.wallet.toLowerCase(), stats };
        } catch {
          return { wallet: trader.wallet.toLowerCase(), stats: null };
        }
      })
    ).then((results) => {
      const map = new Map<string, { wins: number; losses: number; active: number; repScore: number; avgRR: number }>();
      for (const { wallet, stats } of results) {
        if (stats && (stats.wins + stats.losses + stats.active + stats.invalidated) > 0) {
          map.set(wallet, { wins: stats.wins, losses: stats.losses, active: stats.active, repScore: stats.repScore, avgRR: stats.avgRR });
        }
      }
      setOnChainStats(map);
      setOnChainLoading(false);
    });
  }, [board.length]);

  // Ph26: Re-rank using on-chain Rep Score from NexusRepScore contract (trustless ordering)
  const sortedBoard = useMemo(() => {
    return [...board]
      .map((trader) => {
        const oc = onChainStats.get(trader.wallet.toLowerCase());
        if (!oc) return { ...trader, onChainRepScore: null as number | null };
        const closed = oc.wins + oc.losses;
        return {
          ...trader,
          wins: oc.wins,
          losses: oc.losses,
          active: oc.active,
          avgRR: oc.avgRR,
          winRate: closed > 0 ? (oc.wins / closed) * 100 : 0,
          onChainRepScore: oc.repScore,
        };
      })
      .sort((a, b) => {
        // Prefer on-chain score; fall back to JS score
        const aRep = a.onChainRepScore ?? calcRepScore(a.wins, a.losses, a.avgRR);
        const bRep = b.onChainRepScore ?? calcRepScore(b.wins, b.losses, b.avgRR);
        if (bRep !== aRep) return bRep - aRep;
        return b.total - a.total;
      });
  }, [board, onChainStats]);

  if (board.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "60px 0" }}>
        <div style={{ fontSize: 20, color: "#2a4a3a", marginBottom: 8 }}>◆</div>
        <div style={{ fontFamily: "monospace", fontSize: 12, color: "#2a4a3a" }}>
          no public theses yet — rankings appear once traders publish
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, paddingLeft: 2 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: onChainLoading ? "#fbbf24" : onChainStats.size > 0 ? "#00ff88" : "#3a5a4a" }} />
        <span style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a" }}>
          {onChainLoading ? "VERIFYING ON-CHAIN STATS..." : onChainStats.size > 0 ? `⛓ ${onChainStats.size} TRADER${onChainStats.size !== 1 ? "S" : ""} VERIFIED ON-CHAIN` : "RANKED BY KV DATA"}
        </span>
      </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {sortedBoard.map((trader, i) => {
        const rank = i + 1;
        const isOnChainVerified = onChainStats.has(trader.wallet.toLowerCase());
        const closed = trader.wins + trader.losses;
        const shortAddr = `${trader.wallet.slice(0, 6)}…${trader.wallet.slice(-4)}`;
        const isExpanded = expandedWallet === trader.wallet.toLowerCase();
        const traderTheses = feed.filter(t => t.wallet.toLowerCase() === trader.wallet.toLowerCase());
        const isOwn = walletAddress?.toLowerCase() === trader.wallet.toLowerCase();

        return (
          <div key={trader.wallet} style={{
            background: "#0d120d",
            border: `1px solid ${rank === 1 ? "#2a4a1a" : "#1a2e1a"}`,
            borderRadius: 4,
            overflow: "hidden",
          }}>
            {/* Trader row */}
            <div
              onClick={() => setExpandedWallet(isExpanded ? null : trader.wallet.toLowerCase())}
              style={{ padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}
            >
              {/* Rank */}
              <div style={{ fontFamily: "monospace", fontSize: RANK_MEDALS[rank] ? 16 : 12, minWidth: 28, textAlign: "center", color: "#3a5a4a" }}>
                {RANK_MEDALS[rank] ?? `#${rank}`}
              </div>

              {/* Avatar */}
              <Avatar pfp={trader.pfp} displayName={trader.displayName} size={32} />

              {/* Identity */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "monospace", fontSize: 11, color: "#8aaa9a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {trader.displayName ?? shortAddr}
                  {isOwn && <span style={{ color: "#00ff88", marginLeft: 6, fontSize: 9 }}>YOU</span>}
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a" }}>{shortAddr}</div>
              </div>

              {/* Win rate — hero stat */}
              <div style={{ textAlign: "center", minWidth: 60 }}>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>WIN RATE</div>
                <div style={{
                  fontFamily: "monospace", fontSize: 16, fontWeight: "bold",
                  color: closed === 0 ? "#3a5a4a" : trader.winRate >= 60 ? "#00ff88" : trader.winRate >= 40 ? "#fbbf24" : "#ff4444",
                }}>
                  {closed === 0 ? "—" : `${trader.winRate.toFixed(0)}%`}
                </div>
              </div>

              {/* W / L */}
              <div style={{ textAlign: "center", minWidth: 44 }}>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>W / L</div>
                <div style={{ fontFamily: "monospace", fontSize: 12 }}>
                  <span style={{ color: "#00ff88" }}>{trader.wins}</span>
                  <span style={{ color: "#3a5a4a" }}> / </span>
                  <span style={{ color: "#ff4444" }}>{trader.losses}</span>
                </div>
              </div>

              {/* Avg R:R */}
              <div style={{ textAlign: "center", minWidth: 50 }}>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>AVG R:R</div>
                <div style={{ fontFamily: "monospace", fontSize: 12, color: trader.avgRR >= 2 ? "#00ff88" : "#fbbf24" }}>
                  1:{trader.avgRR.toFixed(1)}
                </div>
              </div>

              {/* Active */}
              <div style={{ textAlign: "center", minWidth: 40 }}>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>ACTIVE</div>
                <div style={{ fontFamily: "monospace", fontSize: 12, color: trader.active > 0 ? "#4a9fff" : "#3a5a4a" }}>
                  {trader.active}
                </div>
              </div>

              {/* Rep Score — Ph26: on-chain value when available */}
              {(() => {
                const onChain = (trader as typeof trader & { onChainRepScore?: number | null }).onChainRepScore;
                const rep = onChain ?? calcRepScore(trader.wins, trader.losses, trader.avgRR);
                const isOnChain = onChain != null;
                return (
                  <div style={{ textAlign: "center", minWidth: 44 }}>
                    <div style={{ fontSize: 8, color: isOnChain ? "#00ff88" : "#3a5a4a", fontFamily: "monospace" }}>
                      {isOnChain ? "⛓REP" : "REP"}
                    </div>
                    <div style={{
                      fontFamily: "monospace", fontSize: 12, fontWeight: "bold",
                      color: closed === 0 ? "#3a5a4a" : rep >= 70 ? "#00ff88" : rep >= 40 ? "#fbbf24" : "#ff4444",
                    }}>
                      {closed === 0 ? "—" : rep}
                    </div>
                  </div>
                );
              })()}

              {/* Expand chevron */}
              <div style={{ color: "#2a4a3a", fontSize: 10, fontFamily: "monospace" }}>
                {isExpanded ? "▲" : "▼"}
              </div>
            </div>

            {/* Expanded: trader's theses */}
            {isExpanded && (
              <div style={{ borderTop: "1px solid #1a2e1a", padding: "10px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Profile link */}
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); navigate(`/feed/trader/${trader.wallet}`); }}
                    style={{
                      background: "none", border: "1px solid #1a2e1a", borderRadius: 3,
                      color: "#3a5a4a", fontFamily: "monospace", fontSize: 9,
                      padding: "3px 8px", cursor: "pointer", letterSpacing: "0.05em",
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
                    VIEW PROFILE →
                  </button>
                </div>
                {traderTheses.length === 0 ? (
                  <div style={{ fontFamily: "monospace", fontSize: 10, color: "#2a4a3a" }}>no theses</div>
                ) : traderTheses.map((t) => {
                  const cfg = STATUS_CONFIG[t.status];
                  const ticker = t.symbol.replace("PERP_", "").replace("_USDC", "");
                  return (
                    <div key={t.id} style={{
                      background: "#080c08", border: `1px solid ${cfg.border}`,
                      borderRadius: 3, padding: "10px 12px",
                      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                    }}>
                      <div style={{ flex: 1, minWidth: 120 }}>
                        <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
                        <span style={{ fontFamily: "monospace", fontSize: 10, marginLeft: 8, color: t.direction === "LONG" ? "#00ff88" : "#ff4444" }}>
                          {t.direction === "LONG" ? "↑" : "↓"} {t.direction}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 16 }}>
                        {[
                          { label: "ENTRY", val: `$${t.entryPrice.toFixed(2)}`, color: "#8aaa9a" },
                          { label: "R:R",   val: `1:${t.riskReward.toFixed(2)}`, color: t.riskReward >= 2 ? "#00ff88" : "#fbbf24" },
                        ].map(({ label, val, color }) => (
                          <div key={label}>
                            <div style={{ fontSize: 7, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</div>
                            <div style={{ fontSize: 11, color, fontFamily: "monospace" }}>{val}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{
                        fontFamily: "monospace", fontSize: 8, padding: "2px 6px",
                        borderRadius: 2, background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
                      }}>{cfg.label}</div>
                      {walletAddress && !isOwn && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onCopy(t); }}
                          style={{
                            background: "none", border: "1px solid #1a3a1a", borderRadius: 3,
                            color: "#3a6a4a", fontFamily: "monospace", fontSize: 8,
                            padding: "2px 6px", cursor: "pointer",
                          }}
                        >COPY</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
    </>
  );
}

// ─── Feed Page ───────────────────────────────────────────────────────────────
type FilterStatus = "ALL" | "ACTIVE" | "HIT_TP" | "STOPPED_OUT" | "INVALIDATED";
type DirFilter = "ALL" | "LONG" | "SHORT";

export default function FeedPage() {
  const [feed, setFeed] = useState<FeedThesis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<FilterStatus>("ALL");
  // Ph23: direction filter
  const [dirFilter, setDirFilter] = useState<DirFilter>("ALL");
  const [search, setSearch] = useState("");
  const [copyTarget, setCopyTarget] = useState<FeedThesis | null>(null);
  const [view, setView] = useState<"feed" | "ranks" | "following">("feed");
  // Ph19: on-chain trader count (trustless roster from ThesisRegistered logs)
  const [onChainCount, setOnChainCount] = useState<number | null>(null);
  // Ph24: follow graph
  const [following, setFollowing] = useState<Set<string>>(new Set());

  // Get connected wallet address
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;

  // Ph19: fetch on-chain wallet roster in parallel with feed
  useEffect(() => {
    fetch(`${API_BASE}/wallets/onchain`)
      .then((r) => r.json())
      .then((data: { wallets?: string[] }) => {
        setOnChainCount((data.wallets ?? []).length);
      })
      .catch(() => {});
  }, []);

  // Ph24: load follow graph when wallet connects
  useEffect(() => {
    if (!walletAddress) { setFollowing(new Set()); return; }
    fetch(`${API_BASE}/follows/${walletAddress}`)
      .then((r) => r.json())
      .then((data: { following?: string[] }) => {
        setFollowing(new Set((data.following ?? []).map((a: string) => a.toLowerCase())));
      })
      .catch(() => {});
  }, [walletAddress]);

  // Ph24: follow/unfollow handler
  async function handleFollowToggle(targetWallet: string) {
    if (!walletAddress) return;
    const lower = targetWallet.toLowerCase();
    const next = new Set(following);
    if (next.has(lower)) next.delete(lower);
    else next.add(lower);
    setFollowing(next);
    // persist
    try {
      await fetch(`${API_BASE}/follows/${walletAddress}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ following: [...next] }),
      });
    } catch { /* revert on failure would be nice but not critical */ }
  }

  useEffect(() => {
    setLoading(true);
    setError(false);
    fetch(`${API_BASE}/feed`)
      .then((r) => r.json())
      .then((data: { feed: FeedThesis[] }) => {
        setFeed(data.feed ?? []);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  // Live prices for all active feed theses
  const activeSymbols = useMemo(
    () => [...new Set(feed.filter((t) => t.status === "ACTIVE").map((t) => t.symbol))],
    [feed]
  );
  const livePrices = useLivePrices(activeSymbols);

  // Ph24: following feed is the full feed filtered to followed wallets
  const followingFeed = feed.filter((t) => following.has(t.wallet.toLowerCase()));

  const baseForFilter = view === "following" ? followingFeed : feed;
  const filtered = baseForFilter.filter((t) => {
    if (filter !== "ALL" && t.status !== filter) return false;
    if (dirFilter !== "ALL" && t.direction !== dirFilter) return false; // Ph23
    if (search) {
      const q = search.toLowerCase();
      const ticker = t.symbol.replace("PERP_", "").replace("_USDC", "").toLowerCase();
      const name = (t.displayName ?? "").toLowerCase();
      const addr = t.wallet.toLowerCase();
      if (!ticker.includes(q) && !name.includes(q) && !addr.includes(q)) return false;
    }
    return true;
  });

  const navBtnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? "#0a1a0a" : "none",
    border: `1px solid ${active ? "#00ff88" : "#1a2e1a"}`,
    color: active ? "#00ff88" : "#4a7a5a",
    fontFamily: "monospace",
    fontSize: 10,
    padding: "5px 10px",
    cursor: "pointer",
    borderRadius: 3,
    letterSpacing: "0.05em",
  });

  return (
    <div style={{ background: "#0a0e0a", minHeight: "100vh", padding: 0 }}>
      {/* Copy modal */}
      {copyTarget && walletAddress && (
        <CopyModal
          thesis={copyTarget}
          walletAddress={walletAddress}
          onClose={() => setCopyTarget(null)}
        />
      )}

      {/* Tab bar / header */}
      <div style={{ display: "flex", gap: 8, padding: "8px 16px", borderBottom: "1px solid #1a2e1a", background: "#080c08", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => setView("feed")}
            style={{
              background: view === "feed" ? "#0a1a0a" : "none",
              border: `1px solid ${view === "feed" ? "#00ff88" : "#1a2e1a"}`,
              color: view === "feed" ? "#00ff88" : "#4a7a5a",
              fontFamily: "monospace", fontSize: 10,
              padding: "4px 10px", cursor: "pointer", borderRadius: 3, letterSpacing: "0.08em",
            }}
          >■ FEED</button>
          <button
            onClick={() => setView("ranks")}
            style={{
              background: view === "ranks" ? "#0a1a0a" : "none",
              border: `1px solid ${view === "ranks" ? "#00ff88" : "#1a2e1a"}`,
              color: view === "ranks" ? "#00ff88" : "#4a7a5a",
              fontFamily: "monospace", fontSize: 10,
              padding: "4px 10px", cursor: "pointer", borderRadius: 3, letterSpacing: "0.08em",
            }}
          >◆ RANKS</button>
          {/* Ph24: following tab — only when connected */}
          {walletAddress && (
            <button
              onClick={() => setView("following")}
              style={{
                background: view === "following" ? "#0a1a2a" : "none",
                border: `1px solid ${view === "following" ? "#4a9fff" : "#1a2e1a"}`,
                color: view === "following" ? "#4a9fff" : "#4a7a5a",
                fontFamily: "monospace", fontSize: 10,
                padding: "4px 10px", cursor: "pointer", borderRadius: 3, letterSpacing: "0.08em",
              }}
            >◈ FOLLOWING{following.size > 0 ? ` (${following.size})` : ""}</button>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#3a5a4a" }}>
            {loading ? "loading..." : view === "ranks"
              ? `${feed.length > 0 ? [...new Set(feed.map(t => t.wallet.toLowerCase()))].length : 0} trader${[...new Set(feed.map(t => t.wallet.toLowerCase()))].length !== 1 ? "s" : ""}`
              : `${filtered.length} thesis${filtered.length !== 1 ? "es" : ""}`}
          </div>
          {/* Ph19: on-chain trader count from ThesisRegistered event log scan */}
          {onChainCount !== null && onChainCount > 0 && (
            <div style={{ fontSize: 8, fontFamily: "monospace", color: "#2a5a3a" }}>
              ⛓ {onChainCount} on-chain
            </div>
          )}
          {!loading && view === "feed" && feed.length > 0 && (() => {
            const verifiedCount = feed.filter(t => t.onChainId !== undefined).length;
            if (verifiedCount === 0) return null;
            return (
              <div style={{ fontSize: 8, fontFamily: "monospace", color: "#1a4a2a" }}>
                {verifiedCount}/{feed.length} theses verified
              </div>
            );
          })()}
        </div>
      </div>

      <div style={{ padding: 16, maxWidth: 860, margin: "0 auto" }}>

        {/* ── FOLLOWING VIEW ── */}
        {view === "following" && (
          <>
            {following.size === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0" }}>
                <div style={{ fontSize: 20, color: "#2a4a3a", marginBottom: 8 }}>◈</div>
                <div style={{ fontFamily: "monospace", fontSize: 12, color: "#2a4a3a" }}>
                  not following anyone yet — hit + on a trader card to follow them
                </div>
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0" }}>
                <div style={{ fontFamily: "monospace", fontSize: 12, color: "#2a4a3a" }}>
                  no public theses from traders you follow
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {filtered.map((t) => (
                  <FeedCard
                    key={`${t.wallet}-${t.id}`}
                    thesis={t}
                    markPrice={livePrices[t.symbol] ?? null}
                    walletAddress={walletAddress}
                    onCopy={setCopyTarget}
                    following={following}
                    onFollowToggle={handleFollowToggle}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── RANKS VIEW ── */}
        {view === "ranks" && (
          <>
            {loading && (
              <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "monospace", fontSize: 12, color: "#2a4a3a" }}>
                loading rankings...
              </div>
            )}
            {error && !loading && (
              <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "monospace", fontSize: 12, color: "#ff4444" }}>
                failed to load feed — check connection
              </div>
            )}
            {!loading && !error && (
              <LeaderboardView feed={feed} walletAddress={walletAddress} onCopy={setCopyTarget} />
            )}
          </>
        )}

        {/* ── FEED VIEW ── */}
        {view === "feed" && (
          <>
            {/* Filters */}
            <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
              {(["ALL", "ACTIVE", "HIT_TP", "STOPPED_OUT", "INVALIDATED"] as FilterStatus[]).map((f) => (
                <button key={f} onClick={() => setFilter(f)} style={navBtnStyle(filter === f)}>
                  {f === "ALL" ? "ALL" : STATUS_CONFIG[f].label}
                </button>
              ))}
              {/* Ph23: direction filter */}
              <div style={{ width: 1, height: 18, background: "#1a2e1a", margin: "0 2px" }} />
              {(["ALL", "LONG", "SHORT"] as DirFilter[]).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirFilter(d)}
                  style={{
                    ...navBtnStyle(dirFilter === d),
                    color: dirFilter === d ? (d === "LONG" ? "#00ff88" : d === "SHORT" ? "#ff4444" : "#00ff88") : "#4a7a5a",
                    borderColor: dirFilter === d ? (d === "LONG" ? "#00ff88" : d === "SHORT" ? "#ff4444" : "#00ff88") : "#1a2e1a",
                  }}
                >
                  {d === "ALL" ? "L+S" : d === "LONG" ? "↑ LONG" : "↓ SHORT"}
                </button>
              ))}
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search symbol / trader..."
                style={{
                  marginLeft: "auto",
                  background: "#080c08",
                  border: "1px solid #1a2e1a",
                  borderRadius: 3,
                  color: "#00ff88",
                  fontFamily: "monospace",
                  fontSize: 10,
                  padding: "5px 10px",
                  outline: "none",
                  width: 200,
                }}
              />
            </div>

            {loading && (
              <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "monospace", fontSize: 12, color: "#2a4a3a" }}>
                loading feed...
              </div>
            )}

            {error && !loading && (
              <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "monospace", fontSize: 12, color: "#ff4444" }}>
                failed to load feed — check connection
              </div>
            )}

            {!loading && !error && filtered.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 0" }}>
                <div style={{ fontSize: 20, color: "#2a4a3a", marginBottom: 8 }}>■</div>
                <div style={{ fontFamily: "monospace", fontSize: 12, color: "#2a4a3a" }}>
                  {feed.length === 0
                    ? "no public theses yet — go to LAB and hit 📡 to publish yours"
                    : "no results for this filter"}
                </div>
              </div>
            )}

            {!loading && !error && filtered.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {filtered.map((t) => (
                  <FeedCard
                    key={`${t.wallet}-${t.id}`}
                    thesis={t}
                    markPrice={livePrices[t.symbol] ?? null}
                    walletAddress={walletAddress}
                    onCopy={setCopyTarget}
                    following={following}
                    onFollowToggle={handleFollowToggle}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
