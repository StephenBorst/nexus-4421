/**
 * /feed — Public Thesis Feed
 *
 * Shows all theses marked isPublic=true across all wallets.
 * Each card shows: PFP + name, symbol/direction, entry/SL/TP, R:R, status, timestamp.
 * Phase 6: COPY button — pre-fills a modal so any trader can copy a thesis into their LAB.
 */

import { useState, useEffect, useMemo } from "react";
import { useAccount } from "@orderly.network/hooks";
import { useLivePrices, calcUnrealizedPnl, distancePct } from "@/hooks/useLivePrices";
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
        body: JSON.stringify({ theses: updated, notes: existing.notes ?? "" }),
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
}: {
  thesis: FeedThesis;
  markPrice?: number | null;
  walletAddress: string | null;
  onCopy: (t: FeedThesis) => void;
}) {
  const cfg = STATUS_CONFIG[thesis.status];
  const shortAddr = `${thesis.wallet.slice(0, 6)}…${thesis.wallet.slice(-4)}`;
  const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
  const isOwnThesis = walletAddress?.toLowerCase() === thesis.wallet.toLowerCase();
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

// ─── Feed Page ───────────────────────────────────────────────────────────────
type FilterStatus = "ALL" | "ACTIVE" | "HIT_TP" | "STOPPED_OUT" | "INVALIDATED";

export default function FeedPage() {
  const [feed, setFeed] = useState<FeedThesis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<FilterStatus>("ALL");
  const [search, setSearch] = useState("");
  const [copyTarget, setCopyTarget] = useState<FeedThesis | null>(null);

  // Get connected wallet address
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;

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

  const filtered = feed.filter((t) => {
    if (filter !== "ALL" && t.status !== filter) return false;
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
      <div style={{ display: "flex", gap: 2, padding: "8px 16px", borderBottom: "1px solid #1a2e1a", background: "#080c08", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: "#00ff88", letterSpacing: "0.1em" }}>
          ■ PUBLIC FEED
        </div>
        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#3a5a4a" }}>
          {loading ? "loading..." : `${filtered.length} thesis${filtered.length !== 1 ? "es" : ""}`}
        </div>
      </div>

      <div style={{ padding: 16, maxWidth: 860, margin: "0 auto" }}>
        {/* Filters */}
        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          {(["ALL", "ACTIVE", "HIT_TP", "STOPPED_OUT", "INVALIDATED"] as FilterStatus[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={navBtnStyle(filter === f)}>
              {f === "ALL" ? "ALL" : STATUS_CONFIG[f].label}
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

        {/* Content */}
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
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
