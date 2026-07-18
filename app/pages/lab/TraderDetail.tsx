// One unified "trader detail" — opens from anywhere a trader appears in Smart
// Money. Orderly traders get a native x-ray from the public settlement indexer
// (realized+unrealized PnL by market + live positions, via account_id). HL
// traders link to the full wallet x-ray (/analyze), which reads their fills.
import { useEffect, useState } from "react";

const AGENT_API = "https://og.nexustradinglabs.com";
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : `${a.toFixed(0)}`;
  return `${n < 0 ? "-" : ""}$${s}`;
};

interface SymRow { sym: string; realized: number; unrealized: number; open: boolean; side: "LONG" | "SHORT" | null; szUsd: number; entry: number; }
interface Detail { address: string | null; totalRealized: number; totalUnrealized: number; profitableMarketsPct: number; markets: number; wins: number; losses: number; bySymbol: SymRow[]; }

export function TraderDetail({ source, address, accountId, onClose }: {
  source: "orderly" | "hl"; address: string; accountId?: string; onClose: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(source === "orderly");

  useEffect(() => {
    if (source !== "orderly" || !accountId) { setLoading(false); return; }
    let cancel = false;
    fetch(`${AGENT_API}/smart/trader?account_id=${encodeURIComponent(accountId)}`)
      .then((r) => r.json())
      .then((x) => { if (!cancel && !x.error) setD(x); })
      .catch(() => {})
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [source, accountId]);

  const label = { fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase" as const, marginBottom: 3 };
  const statVal = (n: number) => ({ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: n >= 0 ? "#3ecf8e" : "#f7525f" });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="nx-fade-in" onClick={(e) => e.stopPropagation()} style={{ width: "min(620px, 96vw)", maxHeight: "88vh", overflowY: "auto", background: "#0f0f11", border: "1px solid #33333a", borderRadius: 10 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid #232327", position: "sticky", top: 0, background: "#0f0f11" }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.05em", color: source === "orderly" ? "#3ecf8e" : "#71717a", border: `1px solid ${source === "orderly" ? "#1e3a2a" : "#232327"}`, borderRadius: 3, padding: "1px 5px" }}>{source === "orderly" ? "◆ ORDERLY" : "HL"}</span>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#f4f4f5" }}>{short(address)}</span>
          <a href={source === "hl" ? `/analyze?address=${address}` : `https://orderly-dashboard.orderly.network/address/${address}`} target="_blank" rel="noopener noreferrer"
            style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", textDecoration: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 8px" }}>
            {source === "hl" ? "full x-ray ↗" : "explorer ↗"}
          </a>
          <button onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "1px solid #232327", borderRadius: 3, color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "3px 8px", cursor: "pointer" }}>CLOSE</button>
        </div>

        <div style={{ padding: 16 }}>
          {source === "hl" && (
            <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12, color: "#a1a1aa", lineHeight: 1.6 }}>
              This is a Hyperliquid trader. Open the full wallet x-ray for their complete graded record — trading score, risk-adjusted ratios, hold-time, streaks and per-asset edge.
              <div style={{ marginTop: 12 }}>
                <a href={`/analyze?address=${address}`} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#3ecf8e", textDecoration: "none", border: "1px solid #1e3a2a", borderRadius: 4, padding: "8px 14px", display: "inline-block" }}>X-ray this wallet ↗</a>
              </div>
            </div>
          )}

          {source === "orderly" && loading && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#71717a", padding: "20px 0", textAlign: "center" }}>// pulling on-chain record…</div>}

          {source === "orderly" && !loading && !d && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#71717a", padding: "20px 0", textAlign: "center" }}>No indexed record for this account.</div>}

          {source === "orderly" && d && (
            <>
              {/* Stat tiles */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginBottom: 16 }}>
                <div><div style={label}>Realized PnL</div><div style={statVal(d.totalRealized)}>{d.totalRealized >= 0 ? "+" : ""}{usd(d.totalRealized)}</div></div>
                <div><div style={label}>Unrealized</div><div style={statVal(d.totalUnrealized)}>{d.totalUnrealized >= 0 ? "+" : ""}{usd(d.totalUnrealized)}</div></div>
                <div><div style={label}>Profitable Markets</div><div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#ededf0" }}>{d.profitableMarketsPct}%</div></div>
                <div><div style={label}>Markets Traded</div><div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#ededf0" }}>{d.markets} <span style={{ fontSize: 10, color: "#52525b" }}>{d.wins}W/{d.losses}L</span></div></div>
              </div>

              {/* By market */}
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase", marginBottom: 6 }}>Realized P&amp;L by market</div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {d.bySymbol.slice(0, 18).map((s) => (
                  <div key={s.sym} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid #0d1117" }}>
                    <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#c0c0c0", width: 84, flexShrink: 0 }}>{s.sym}</span>
                    {s.open && s.side
                      ? <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: s.side === "LONG" ? "#3ecf8e" : "#f7525f", flexShrink: 0 }}>● {s.side} {usd(s.szUsd)}</span>
                      : <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#3f3f46", flexShrink: 0 }}>flat</span>}
                    <span style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600, color: s.realized >= 0 ? "#3ecf8e" : "#f7525f", flexShrink: 0 }}>{s.realized >= 0 ? "+" : ""}{usd(s.realized)}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#3f3f46", marginTop: 10 }}>
                From the public Orderly settlement indexer. Realized PnL is cumulative; profitable-markets % is the share of markets they're net-green on.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
