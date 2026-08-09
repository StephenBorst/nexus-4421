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

interface XrayTrack {
  points: number; building: boolean;
  daysTracked?: number; netRealized?: number; windows?: number;
  winWindowRate?: number | null; maxDrawdown?: number; curve?: number[];
  trend?: "UP" | "DOWN" | "FLAT"; operatorScore?: number | null;
  tier?: { tier: string; title: string; glyph: string } | null;
}

// Dependency-free equity sparkline of the tracked realized-PnL window. Plots the
// cumulative-delta curve with a dashed zero baseline; colour follows the net.
function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  if (!data || data.length < 2) return null;
  const w = 260, h = 44, pad = 3;
  const min = Math.min(0, ...data), max = Math.max(0, ...data);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / range) * (h - 2 * pad);
  const path = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  const color = positive ? "#3ecf8e" : "#f7525f";
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <line x1={pad} x2={w - pad} y1={zeroY} y2={zeroY} stroke="#33333a" strokeWidth="1" strokeDasharray="2 3" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function TraderDetail({ source, address, accountId, onClose }: {
  source: "orderly" | "hl"; address: string; accountId?: string; onClose: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(source === "orderly");
  const [track, setTrack] = useState<XrayTrack | null>(null);

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

  // The accruing Tracked Record — keyed by ADDRESS (the trader detail always has
  // one). This read self-seeds the first snapshot server-side, so opening a
  // wallet begins its graded record.
  useEffect(() => {
    if (source !== "orderly" || !address) return;
    let cancel = false;
    fetch(`${AGENT_API}/smart/xray/history?address=${address}`)
      .then((r) => r.json())
      .then((x) => { if (!cancel && x && x.track) setTrack(x.track); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [source, address]);

  const label = { fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase" as const, marginBottom: 3 };
  const statVal = (n: number) => ({ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: n >= 0 ? "#3ecf8e" : "#f7525f" });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="nx-fade-in" onClick={(e) => e.stopPropagation()} style={{ width: "min(620px, 96vw)", maxHeight: "88vh", overflowY: "auto", background: "#0f0f11", border: "1px solid #33333a", borderRadius: 10 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid #232327", position: "sticky", top: 0, background: "#0f0f11" }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.05em", color: source === "orderly" ? "#3ecf8e" : "#71717a", border: `1px solid ${source === "orderly" ? "#33333a" : "#232327"}`, borderRadius: 3, padding: "1px 5px" }}>{source === "orderly" ? "◆ ORDERLY" : "HL"}</span>
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
                <a href={`/analyze?address=${address}`} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#ededf0", textDecoration: "none", border: "1px solid #33333a", borderRadius: 4, padding: "8px 14px", display: "inline-block" }}>X-ray this wallet ↗</a>
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

              {/* Tracked Record — the accruing, self-grading monitor */}
              {track && (
                <div style={{ border: "1px solid #232327", borderRadius: 8, padding: 12, marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase" }}>Tracked Record</span>
                    {track.tier && (
                      <span title={`${track.tier.title} — earned from ${track.windows} graded daily windows`} style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#3ecf8e", border: "1px solid #33333a", borderRadius: 3, padding: "1px 5px" }}>{track.tier.glyph} {track.tier.title.toUpperCase()}</span>
                    )}
                    {typeof track.operatorScore === "number" && (
                      <span style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a" }}>OPERATOR SCORE <span style={{ color: "#ededf0", fontWeight: 700, fontSize: 12 }}>{track.operatorScore}</span></span>
                    )}
                  </div>

                  {track.building ? (
                    <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#71717a", lineHeight: 1.6, padding: "6px 0" }}>
                      Tracking started. A graded record accrues each day this wallet is watched — realized-PnL trend, consistency and drawdown, computed from public settlement. Check back.
                    </div>
                  ) : (
                    <>
                      {track.curve && track.curve.length >= 2 && (
                        <div style={{ marginBottom: 10 }}><Sparkline data={track.curve} positive={(track.netRealized || 0) >= 0} /></div>
                      )}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: 10 }}>
                        <div>
                          <div style={label}>Net (tracked)</div>
                          <div style={statVal(track.netRealized || 0)}>{(track.netRealized || 0) >= 0 ? "+" : ""}{usd(track.netRealized || 0)}</div>
                        </div>
                        <div>
                          <div style={label}>Days Tracked</div>
                          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#ededf0" }}>{track.daysTracked}</div>
                        </div>
                        <div>
                          <div style={label}>Green Days</div>
                          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#ededf0" }}>{track.winWindowRate ?? 0}%</div>
                        </div>
                        <div>
                          <div style={label}>Max Drawdown</div>
                          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#f7525f" }}>-{usd(track.maxDrawdown || 0)}</div>
                        </div>
                      </div>
                      <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 8, lineHeight: 1.5 }}>
                        Graded from the change in realized PnL between daily snapshots — the P&amp;L earned while watched, not lifetime history. Score is earned from a track length, so a short streak can&apos;t inflate it.
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* By market */}
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase", marginBottom: 6 }}>Realized P&amp;L by market</div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {d.bySymbol.slice(0, 18).map((s) => (
                  <div key={s.sym} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid #232327" }}>
                    <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#d4d4d8", width: 84, flexShrink: 0 }}>{s.sym}</span>
                    {s.open && s.side
                      ? <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: s.side === "LONG" ? "#3ecf8e" : "#f7525f", flexShrink: 0 }}>● {s.side} {usd(s.szUsd)}</span>
                      : <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", flexShrink: 0 }}>flat</span>}
                    <span style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600, color: s.realized >= 0 ? "#3ecf8e" : "#f7525f", flexShrink: 0 }}>{s.realized >= 0 ? "+" : ""}{usd(s.realized)}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 10 }}>
                From the public Orderly settlement indexer. Realized PnL is cumulative; profitable-markets % is the share of markets they're net-green on.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
