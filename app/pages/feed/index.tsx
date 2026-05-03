/**
 * /feed — Public Thesis Feed
 *
 * Shows all theses marked isPublic=true across all wallets.
 * Each card shows: PFP + name, symbol/direction, entry/SL/TP, R:R, status, timestamp.
 */

import { useState, useEffect, useMemo } from "react";
import { useLivePrices, calcUnrealizedPnl, distancePct } from "@/hooks/useLivePrices";

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

function FeedCard({ thesis, markPrice }: { thesis: FeedThesis; markPrice?: number | null }) {
  const cfg = STATUS_CONFIG[thesis.status];
  const shortAddr = `${thesis.wallet.slice(0, 6)}…${thesis.wallet.slice(-4)}`;
  const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
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
      {/* Header: avatar + identity + status + time */}
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

type FilterStatus = "ALL" | "ACTIVE" | "HIT_TP" | "STOPPED_OUT" | "INVALIDATED";

export default function FeedPage() {
  const [feed, setFeed] = useState<FeedThesis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<FilterStatus>("ALL");
  const [search, setSearch] = useState("");

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
              <FeedCard key={`${t.wallet}-${t.id}`} thesis={t} markPrice={livePrices[t.symbol] ?? null} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
