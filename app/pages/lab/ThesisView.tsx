// Thesis Engine tab: the thesis calculator, thesis cards, and the thesis
// analytics (accuracy/streaks/equity). Extracted from index.tsx (god-file split).
import { useState, useMemo } from "react";
import { useAccount, useMutation } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { useThesisRegistry } from "@/hooks/useThesisRegistry";
import { useLivePrices, calcUnrealizedPnl, distancePct } from "@/hooks/useLivePrices";
import { useIsMobile } from "./useIsMobile";
import type { ThesisTrade, ThesisStatus } from "./types";
import { cardStyle, labelStyle, navBtnStyle, inputStyle, fieldLabelStyle, STATUS_CONFIG, CLOSED_STATUSES } from "./styles";
import { formatPnl } from "./helpers";
import { PnlChart, EmptyState } from "./components";

function calcThesis(form: {
  entryPrice: string; stopLoss: string; takeProfit1: string; takeProfit2: string;
  riskPercent: string; accountSize: string; fundingRate: string; direction: "LONG" | "SHORT";
}) {
  const entry = parseFloat(form.entryPrice);
  const stop = parseFloat(form.stopLoss);
  const tp1 = parseFloat(form.takeProfit1);
  const account = parseFloat(form.accountSize);
  const riskPct = parseFloat(form.riskPercent);
  const funding = parseFloat(form.fundingRate);
  if (!entry || !stop || !tp1 || !account || !riskPct) return null;
  const riskAmount = account * (riskPct / 100);
  const stopDistancePct = Math.abs((entry - stop) / entry);
  if (stopDistancePct === 0) return null;
  const positionSize = riskAmount / stopDistancePct;
  const leverage = positionSize / account;
  const rewardDistance = Math.abs((tp1 - entry) / entry);
  const riskReward = rewardDistance / stopDistancePct;
  const fundingPerPeriod = positionSize * (Math.abs(funding) / 100);
  return {
    positionSize: Math.min(positionSize, account * 100),
    leverage: Math.min(leverage, 100),
    riskReward, riskAmount,
    fundingCost8h: fundingPerPeriod,
    fundingCost24h: fundingPerPeriod * 3,
    fundingCost72h: fundingPerPeriod * 9,
  };
}

// ─── Thesis Card ──────────────────────────────────────────
function ThesisCard({ t, onUpdate, onRemove, walletAddress, isMobile, markPrice }: {
  t: ThesisTrade;
  onUpdate: (id: string, patch: Partial<ThesisTrade>) => void;
  onRemove: (id: string) => void;
  walletAddress?: string | null;
  isMobile?: boolean;
  markPrice?: number | null;
}) {
  const [actualInput, setActualInput] = useState(t.actualPnl !== null ? String(t.actualPnl) : "");
  const [inputVisible, setInputVisible] = useState(false);
  const cfg = STATUS_CONFIG[t.status];
  const isClosed = CLOSED_STATUSES.includes(t.status);

  const handleStatusClick = (s: ThesisStatus) => {
    const next = t.status === s ? "ACTIVE" : s;
    onUpdate(t.id, { status: next });
    if (CLOSED_STATUSES.includes(next)) setInputVisible(true);
    else setInputVisible(false);
  };

  const saveActual = () => {
    const val = parseFloat(actualInput);
    if (!isNaN(val)) onUpdate(t.id, { actualPnl: val });
    setInputVisible(false);
  };

  const plannedPnl = t.riskReward * (t.riskPercent / 100) * t.accountSize;
  const accuracy = t.actualPnl !== null && plannedPnl !== 0
    ? Math.min(200, Math.max(0, (t.actualPnl / plannedPnl) * 100))
    : null;

  return (
    <div style={{
      ...cardStyle,
      border: `1px solid ${cfg.border}`,
      background: isClosed ? "#0a0c0a" : "#0d120d",
      opacity: t.status === "INVALIDATED" ? 0.7 : 1,
    }}>
      {/* Top row */}
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "stretch" : "flex-start", justifyContent: "space-between", marginBottom: 10, gap: isMobile ? 10 : 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flex: 1, minWidth: 0 }}>
          <div style={{ minWidth: 52 }}>
            <div style={{ fontSize: 16, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{t.symbol.replace("PERP_","").replace("_USDC","")}</div>
            <div style={{ fontSize: 10, color: t.direction === "LONG" ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>
              {t.direction === "LONG" ? "↑" : "↓"} {t.direction} · {t.leverage.toFixed(1)}x
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(3, 1fr)" : "repeat(6, auto)", gap: isMobile ? "8px 12px" : "0 16px", flex: 1 }}>
            {[
              { label: "ENTRY", val: `$${t.entryPrice.toFixed(2)}` },
              { label: "STOP", val: `$${t.stopLoss.toFixed(2)}`, color: "#ff4444" },
              { label: "TP1", val: `$${t.takeProfit1.toFixed(2)}`, color: "#00ff88" },
              { label: "SIZE", val: `$${t.positionSize.toFixed(0)}` },
              { label: "R:R", val: `1:${t.riskReward.toFixed(2)}`, color: t.riskReward >= 2 ? "#00ff88" : "#fbbf24" },
              { label: "72H FUND", val: `$${t.fundingCost72h.toFixed(3)}`, color: "#fbbf24" },
            ].map(({ label, val, color }) => (
              <div key={label}>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</div>
                <div style={{ fontSize: 12, color: color ?? "#8aaa9a", fontFamily: "monospace" }}>{val}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: isMobile ? "row" : "column", alignItems: isMobile ? "center" : "flex-end", justifyContent: isMobile ? "space-between" : "flex-start", gap: 6, flexShrink: 0 }}>
          {!isMobile && <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace" }}>{new Date(t.createdAt).toLocaleDateString()}</div>}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {t.status === "ACTIVE" && walletAddress && (
              <a
                href={`https://t.me/nexustradinglabs_bot?start=${walletAddress.toLowerCase()}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...navBtnStyle, fontSize: 10, color: "#29b6f6", borderColor: "#0a2a3a", textDecoration: "none", display: "inline-block", textAlign: "center", minHeight: 36, lineHeight: "22px", padding: "6px 12px" }}
              >
                🔔 ALERTS
              </a>
            )}
            {(() => {
              // 3-state visibility cycle: PRIVATE → PUBLIC → HOLDERS → PRIVATE
              const vis = t.holdersOnly ? "HOLDERS" : t.isPublic ? "PUBLIC" : "PRIVATE";
              const next = vis === "PRIVATE"
                ? { isPublic: true, holdersOnly: false }
                : vis === "PUBLIC"
                ? { isPublic: false, holdersOnly: true }
                : { isPublic: false, holdersOnly: false };
              const meta = {
                PRIVATE: { label: "📡 PRIVATE", color: "#3a5a4a", border: "#1a2e1a", bg: "transparent" },
                PUBLIC:  { label: "📡 PUBLIC",  color: "#00ff88", border: "#1a4a2a", bg: "#0a2a0a" },
                HOLDERS: { label: "◆ HOLDERS",  color: "#5fd6a0", border: "#1a4a3a", bg: "#0a2a1a" },
              }[vis];
              return (
                <button
                  onClick={() => onUpdate(t.id, next)}
                  title={`Visibility: ${vis} — click to cycle (PRIVATE → PUBLIC → HOLDERS-ONLY)`}
                  style={{
                    ...navBtnStyle, fontSize: 10, minHeight: 36, padding: "6px 12px",
                    color: meta.color, borderColor: meta.border, background: meta.bg,
                  }}
                >
                  {meta.label}
                </button>
              );
            })()}
            <button onClick={() => onRemove(t.id)} style={{ ...navBtnStyle, fontSize: 10, color: "#ff4444", borderColor: "#2a1a1a", minHeight: 36, padding: "6px 12px" }}>REMOVE</button>
          </div>
        </div>
      </div>

      {/* Status buttons */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {(Object.keys(STATUS_CONFIG) as ThesisStatus[]).map((s) => {
          const c = STATUS_CONFIG[s];
          const active = t.status === s;
          return (
            <button key={s} onClick={() => handleStatusClick(s)} style={{
              fontFamily: "monospace", fontSize: 9, padding: "6px 12px",
              cursor: "pointer", borderRadius: 3, letterSpacing: "0.06em",
              minHeight: 32,
              border: `1px solid ${active ? c.border : "#1a2e1a"}`,
              background: active ? c.bg : "transparent",
              color: active ? c.color : "#2a4a3a",
            }}>{c.label}</button>
          );
        })}
      </div>

      {/* Live P&L — only shown for ACTIVE theses with a mark price */}
      {t.status === "ACTIVE" && markPrice != null && (() => {
        const { pnl, pct } = calcUnrealizedPnl(t.direction, t.entryPrice, markPrice, t.positionSize);
        const toSL = distancePct(markPrice, t.stopLoss);
        const toTP = distancePct(markPrice, t.takeProfit1);
        const isWinning = pnl >= 0;
        return (
          <div style={{ borderTop: "1px solid #1a2e1a", paddingTop: 10, marginBottom: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: "8px 16px" }}>
              <div>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 2 }}>MARK PRICE</div>
                <div style={{ fontSize: 13, color: "#fff", fontFamily: "monospace", fontWeight: "bold" }}>
                  ${markPrice.toFixed(markPrice < 10 ? 4 : 2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 2 }}>UNREALIZED P&L</div>
                <div style={{ fontSize: 13, fontFamily: "monospace", fontWeight: "bold", color: isWinning ? "#00ff88" : "#ff4444" }}>
                  {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                  <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.7 }}>({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 2 }}>TO SL</div>
                <div style={{ fontSize: 13, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>
                  {toSL.toFixed(2)}%
                </div>
              </div>
              <div>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 2 }}>TO TP1</div>
                <div style={{ fontSize: 13, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>
                  {toTP.toFixed(2)}%
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Actual P&L — only shown when closed */}
      {isClosed && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, paddingTop: 8, borderTop: "1px solid #1a2e1a" }}>
          <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", whiteSpace: "nowrap" }}>ACTUAL P&L</div>
          {t.actualPnl !== null && !inputVisible ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 16, color: t.actualPnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>
                {formatPnl(t.actualPnl)}
              </div>
              {accuracy !== null && (
                <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>
                  {accuracy.toFixed(0)}% of plan
                </div>
              )}
              <button onClick={() => setInputVisible(true)} style={{ ...navBtnStyle, fontSize: 9, padding: "3px 8px" }}>EDIT</button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="number"
                placeholder="e.g. 142.50 or -87.00"
                value={actualInput}
                onChange={(e) => setActualInput(e.target.value)}
                style={{ ...inputStyle, width: 180, padding: "5px 8px", fontSize: 11 }}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
              />
              <button onClick={saveActual} style={{ ...navBtnStyle, fontSize: 10, color: "#00ff88", borderColor: "#1a4a2a" }}>SAVE</button>
              {t.actualPnl !== null && (
                <button onClick={() => setInputVisible(false)} style={{ ...navBtnStyle, fontSize: 10 }}>CANCEL</button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Notes */}
      {t.notes && (
        <div style={{ marginTop: 6, paddingTop: 8, borderTop: "1px solid #1a2e1a", fontSize: 11, color: "#3a5a4a", fontFamily: "monospace", fontStyle: "italic" }}>
          &quot;{t.notes}&quot;
        </div>
      )}
    </div>
  );
}

// ─── Thesis Analytics Section ─────────────────────────────
function ThesisAnalyticsSection({ trades }: { trades: ThesisTrade[] }) {
  const closedTrades = trades.filter((t) => CLOSED_STATUSES.includes(t.status));
  const withPnl = closedTrades.filter((t) => t.actualPnl !== null);

  if (closedTrades.length === 0) return null;

  const hits = trades.filter((t) => t.status === "HIT_TP").length;
  const stoppedOut = trades.filter((t) => t.status === "STOPPED_OUT").length;
  const invalidated = trades.filter((t) => t.status === "INVALIDATED").length;
  const winRate = closedTrades.length ? Math.round((hits / closedTrades.length) * 100) : 0;
  const totalActualPnl = withPnl.reduce((s, t) => s + (t.actualPnl ?? 0), 0);

  const sortedByPnl = [...withPnl].sort((a, b) => (b.actualPnl ?? 0) - (a.actualPnl ?? 0));
  const bestThesis = sortedByPnl[0] ?? null;
  const worstThesis = sortedByPnl.length > 1 ? sortedByPnl[sortedByPnl.length - 1] : null;

  const sortedByDate = [...withPnl].sort((a, b) => a.createdAt - b.createdAt);
  let running = 0;
  const cumulativePoints = [0, ...sortedByDate.map((t) => { running += (t.actualPnl ?? 0); return running; })];

  return (
    <div style={{ marginTop: 16, marginBottom: 16 }}>
      {/* Breakdown Card */}
      <div style={{ ...cardStyle, marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 16, fontFamily: "monospace" }}>
          <span style={{ color: "#3a5a4a" }}>&#9632;</span> ACCURACY BREAKDOWN
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))", gap: 8 }}>
          <div style={{ background: "#0a150a", border: "1px solid #1a4a2a", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 6 }}>HIT TP</div>
            <div style={{ fontSize: 28, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>{hits}</div>
          </div>
          <div style={{ background: "#150a0a", border: "1px solid #4a1a1a", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 6 }}>STOPPED OUT</div>
            <div style={{ fontSize: 28, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>{stoppedOut}</div>
          </div>
          <div style={{ background: "#150e00", border: "1px solid #4a3a00", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 6 }}>INVALIDATED</div>
            <div style={{ fontSize: 28, color: "#fbbf24", fontFamily: "monospace", fontWeight: "bold" }}>{invalidated}</div>
          </div>
          <div style={{ background: "#0a0e0a", border: "1px solid #1a3a5a", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 6 }}>WIN RATE</div>
            <div style={{ fontSize: 28, color: "#4a9fff", fontFamily: "monospace", fontWeight: "bold" }}>{winRate}%</div>
            <div style={{ height: 3, background: "#1a2e1a", borderRadius: 2, marginTop: 8 }}>
              <div style={{ height: 3, background: "#4a9fff", borderRadius: 2, width: `${winRate}%` }} />
            </div>
          </div>
          <div style={{ background: "#0a0e0a", border: `1px solid ${totalActualPnl >= 0 ? "#1a4a2a" : "#4a1a1a"}`, borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 6 }}>TOTAL ACTUAL P&amp;L</div>
            <div style={{ fontSize: 22, color: totalActualPnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>
              {withPnl.length > 0 ? formatPnl(totalActualPnl) : "—"}
            </div>
            {withPnl.length > 0 && (
              <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace", marginTop: 4 }}>{withPnl.length} logged</div>
            )}
          </div>
        </div>
      </div>

      {/* Best / Worst + Cumulative Chart */}
      {withPnl.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
          {/* Best Thesis */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; BEST THESIS</div>
            {bestThesis ? (
              <>
                <div style={{ background: "#0a150a", border: "1px solid #1a3a1a", borderRadius: 4, padding: "10px 12px", marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                    <span style={{ fontSize: 15, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{bestThesis.symbol}</span>
                    <span style={{ fontSize: 16, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>{formatPnl(bestThesis.actualPnl ?? 0)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ fontSize: 10, color: bestThesis.direction === "LONG" ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>
                      {bestThesis.direction === "LONG" ? "↑" : "↓"} {bestThesis.direction}
                    </div>
                    <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>1:{bestThesis.riskReward.toFixed(2)} R:R</div>
                  </div>
                </div>
                <div style={{ fontSize: 9, color: STATUS_CONFIG[bestThesis.status].color, fontFamily: "monospace", letterSpacing: "0.06em" }}>
                  {STATUS_CONFIG[bestThesis.status].label}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#2a4a3a", fontFamily: "monospace" }}>no P&L logged yet</div>
            )}
          </div>

          {/* Worst Thesis */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#ff4444", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; WORST THESIS</div>
            {worstThesis ? (
              <>
                <div style={{ background: "#150a0a", border: "1px solid #3a1a1a", borderRadius: 4, padding: "10px 12px", marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                    <span style={{ fontSize: 15, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{worstThesis.symbol}</span>
                    <span style={{ fontSize: 16, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>{formatPnl(worstThesis.actualPnl ?? 0)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ fontSize: 10, color: worstThesis.direction === "LONG" ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>
                      {worstThesis.direction === "LONG" ? "↑" : "↓"} {worstThesis.direction}
                    </div>
                    <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>1:{worstThesis.riskReward.toFixed(2)} R:R</div>
                  </div>
                </div>
                <div style={{ fontSize: 9, color: STATUS_CONFIG[worstThesis.status].color, fontFamily: "monospace", letterSpacing: "0.06em" }}>
                  {STATUS_CONFIG[worstThesis.status].label}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#2a4a3a", fontFamily: "monospace" }}>
                {withPnl.length === 1 ? "need 2+ results" : "no P&L logged yet"}
              </div>
            )}
          </div>

          {/* Cumulative Thesis P&L Chart */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 4, fontFamily: "monospace" }}>&#9632; THESIS P&amp;L</div>
            <PnlChart points={cumulativePoints} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>{sortedByDate.length} results plotted</div>
              <div style={{ fontSize: 10, color: totalActualPnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>{formatPnl(totalActualPnl)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Thesis Analytics View ───────────────────────────────
export function ThesisAnalyticsView() {
  const isMobile = useIsMobile();
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const { theses } = useLabStorage(walletAddress);

  const closed = useMemo(
    () => theses.filter((t) => t.status === "HIT_TP" || t.status === "STOPPED_OUT"),
    [theses]
  );

  const summaryStats = useMemo(() => {
    const wins = closed.filter((t) => t.status === "HIT_TP").length;
    const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
    const avgRR = theses.length > 0 ? theses.reduce((s, t) => s + t.riskReward, 0) / theses.length : 0;
    const totalPnl = closed.reduce((s, t) => s + (t.actualPnl ?? 0), 0);
    return { total: theses.length, winRate, avgRR, totalPnl };
  }, [theses, closed]);

  const equityPoints = useMemo(() => {
    const sorted = [...closed].sort((a, b) => a.createdAt - b.createdAt);
    let running = 0;
    return sorted.map((t) => { running += (t.actualPnl ?? 0); return running; });
  }, [closed]);

  const streaks = useMemo(() => {
    const sortedDesc = [...closed].sort((a, b) => b.createdAt - a.createdAt);
    let current = 0;
    for (const t of sortedDesc) {
      if (t.status === "HIT_TP") current++;
      else break;
    }
    const sortedAsc = [...closed].sort((a, b) => a.createdAt - b.createdAt);
    let best = 0;
    let streak = 0;
    for (const t of sortedAsc) {
      if (t.status === "HIT_TP") { streak++; if (streak > best) best = streak; }
      else streak = 0;
    }
    return { current, best };
  }, [closed]);

  const assetStats = useMemo(() => {
    const map = new Map<string, { wins: number; total: number; rrSum: number }>();
    for (const t of closed) {
      const sym = t.symbol.replace("PERP_", "").replace("_USDC", "");
      if (!map.has(sym)) map.set(sym, { wins: 0, total: 0, rrSum: 0 });
      const s = map.get(sym)!;
      s.total++;
      if (t.status === "HIT_TP") s.wins++;
      s.rrSum += t.riskReward;
    }
    return [...map.entries()]
      .map(([sym, s]) => ({
        sym,
        winRate: (s.wins / s.total) * 100,
        total: s.total,
        avgRR: s.rrSum / s.total,
      }))
      .sort((a, b) => b.winRate - a.winRate);
  }, [closed]);

  const bestAssets = assetStats.slice(0, 5);
  const worstAssets = [...assetStats].reverse().slice(0, 3);

  if (!walletAddress) {
    return <EmptyState message="connect wallet to view thesis analytics" />;
  }

  const endVal = equityPoints.length > 0 ? equityPoints[equityPoints.length - 1] : 0;
  const lineColor = endVal >= 0 ? "#00ff88" : "#ff4444";

  const renderEquityCurve = () => {
    if (equityPoints.length < 2) {
      return (
        <div style={{ padding: "20px 0", fontFamily: "monospace", fontSize: 11, color: "#2a4a3a" }}>
          Not enough data yet.
        </div>
      );
    }
    const w = 500; const svgH = 120;
    const allPoints = [0, ...equityPoints];
    const minV = Math.min(...allPoints);
    const maxV = Math.max(...allPoints);
    const range = maxV - minV || 1;
    const n = allPoints.length;
    const toY = (v: number) => svgH - ((v - minV) / range) * svgH * 0.85 + svgH * 0.075;
    const pts = allPoints.map((v, i) => `${(i / (n - 1)) * w},${toY(v)}`).join(" ");
    const zeroY = toY(0);
    const lastY = toY(equityPoints[equityPoints.length - 1]);
    return (
      <svg viewBox={`0 0 ${w} ${svgH}`} style={{ width: "100%", height: 120 }}>
        <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="#1a2e1a" strokeWidth="1" strokeDasharray="4,4" />
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="2" />
        <circle cx={w} cy={lastY} r="4" fill={lineColor} />
      </svg>
    );
  };

  const assetRow = (a: { sym: string; winRate: number; total: number; avgRR: number }, i: number, maxIdx: number) => (
    <div
      key={a.sym}
      style={{
        display: "grid", gridTemplateColumns: "1fr 54px 40px 54px", gap: 8,
        padding: "5px 0",
        borderBottom: i < maxIdx ? "1px solid #0f1f0f" : "none",
        alignItems: "center",
      }}
    >
      <span style={{ fontFamily: "monospace", fontSize: 11, color: "#fff" }}>{a.sym}</span>
      <span style={{ fontFamily: "monospace", fontSize: 11, textAlign: "right", color: a.winRate >= 50 ? "#00ff88" : "#ff4444" }}>
        {a.winRate.toFixed(0)}%
      </span>
      <span style={{ fontFamily: "monospace", fontSize: 10, textAlign: "right", color: "#3a5a4a" }}>{a.total}</span>
      <span style={{ fontFamily: "monospace", fontSize: 10, textAlign: "right", color: a.avgRR >= 2 ? "#00ff88" : "#fbbf24" }}>
        1:{a.avgRR.toFixed(1)}
      </span>
    </div>
  );

  const tableHeader = () => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 54px 40px 54px", gap: 8, marginBottom: 6 }}>
      {["SYMBOL", "WR", "N", "AVG R:R"].map((col) => (
        <span key={col} style={{ fontSize: 8, color: "#2a4a3a", fontFamily: "monospace", textAlign: col !== "SYMBOL" ? "right" : "left" }}>
          {col}
        </span>
      ))}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Summary stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
        {[
          { label: "TOTAL THESES", val: summaryStats.total.toString(), color: "#8aaa9a" as string },
          {
            label: "WIN RATE",
            val: closed.length > 0 ? `${summaryStats.winRate.toFixed(1)}%` : "—",
            color: (closed.length > 0 ? (summaryStats.winRate >= 50 ? "#00ff88" : "#ff4444") : "#3a5a4a") as string,
          },
          {
            label: "AVG R:R",
            val: theses.length > 0 ? `1:${summaryStats.avgRR.toFixed(2)}` : "—",
            color: (theses.length > 0 ? (summaryStats.avgRR >= 2 ? "#00ff88" : "#fbbf24") : "#3a5a4a") as string,
          },
          {
            label: "TOTAL P&L",
            val: closed.length > 0 ? `${summaryStats.totalPnl >= 0 ? "+" : ""}$${Math.abs(summaryStats.totalPnl).toFixed(2)}` : "—",
            color: (closed.length > 0 ? (summaryStats.totalPnl >= 0 ? "#00ff88" : "#ff4444") : "#3a5a4a") as string,
          },
        ].map(({ label, val, color }) => (
          <div key={label} style={cardStyle}>
            <div style={labelStyle}>{label}</div>
            <div style={{ fontFamily: "monospace", fontSize: 22, fontWeight: "bold", color }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Equity curve */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span style={{ fontFamily: "monospace", fontSize: 10, color: "#00ff88", letterSpacing: "0.1em" }}>◆ EQUITY CURVE</span>
          {equityPoints.length >= 2 && (
            <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: "bold", color: lineColor }}>
              {summaryStats.totalPnl >= 0 ? "+" : ""}${Math.abs(summaryStats.totalPnl).toFixed(2)}
            </span>
          )}
        </div>
        {renderEquityCurve()}
      </div>

      {/* Streak + best/worst markets */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
        {/* Win streak */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#fbbf24", letterSpacing: "0.1em", marginBottom: 14 }}>◆ WIN STREAK</div>
          <div style={{ marginBottom: 14 }}>
            <div style={labelStyle}>CURRENT STREAK</div>
            <div style={{ fontFamily: "monospace", fontSize: 28, fontWeight: "bold", color: streaks.current > 0 ? "#00ff88" : "#2a4a3a" }}>
              {streaks.current}
              <span style={{ fontFamily: "monospace", fontSize: 12, color: "#3a5a4a", marginLeft: 6 }}>wins</span>
            </div>
          </div>
          <div>
            <div style={labelStyle}>BEST STREAK</div>
            <div style={{ fontFamily: "monospace", fontSize: 22, fontWeight: "bold", color: streaks.best > 0 ? "#00ff88" : "#2a4a3a" }}>
              {streaks.best}
              <span style={{ fontFamily: "monospace", fontSize: 12, color: "#3a5a4a", marginLeft: 6 }}>wins</span>
            </div>
          </div>
        </div>

        {/* Best markets */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 10 }}>◆ BEST MARKETS</div>
          {bestAssets.length === 0 ? (
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#2a4a3a" }}>no closed theses yet</div>
          ) : (
            <>
              {tableHeader()}
              {bestAssets.map((a, i) => assetRow(a, i, bestAssets.length - 1))}
            </>
          )}
        </div>

        {/* Worst markets */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#ff4444", letterSpacing: "0.1em", marginBottom: 10 }}>◆ WORST MARKETS</div>
          {worstAssets.length === 0 ? (
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#2a4a3a" }}>no closed theses yet</div>
          ) : (
            <>
              {tableHeader()}
              {worstAssets.map((a, i) => assetRow(a, i, worstAssets.length - 1))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Thesis View ──────────────────────────────────────────
export function ThesisView() {
  const isMobile = useIsMobile();
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const { theses: trades, saveTheses } = useLabStorage(walletAddress);
  const { registerOnChain, closeOnChain } = useThesisRegistry();

  // Live prices for all active theses
  const activeSymbols = useMemo(
    () => [...new Set(trades.filter((t) => t.status === "ACTIVE").map((t) => t.symbol))],
    [trades]
  );
  const livePrices = useLivePrices(activeSymbols);

  const [form, setForm] = useState({
    symbol: "",
    direction: "LONG" as "LONG" | "SHORT",
    entryPrice: "",
    stopLoss: "",
    takeProfit1: "",
    takeProfit2: "",
    riskPercent: "1.5",
    accountSize: "",
    fundingRate: "0.01",
    notes: "",
  });


  const [deployed, setDeployed] = useState(false);
  const [filter, setFilter] = useState<ThesisStatus | "ALL">("ALL");

  // ── Live execution ──────────────────────────────────────
  const [doOrder] = useMutation("/v1/order", "POST");
  const [doAlgoOrder] = useMutation("/v1/algo/order", "POST");
  const [liveConfirm, setLiveConfirm] = useState(false);
  const [liveStatus, setLiveStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [liveError, setLiveError] = useState<string | null>(null);
  const isWalletReady = !!(accountState && (accountState as { status?: number }).status !== undefined && (accountState as { status?: number }).status !== 0);

  const calc = useMemo(() => calcThesis(form), [form]);
  const set = (field: string, value: string) => setForm((f) => ({ ...f, [field]: value }));

  const persist = (updated: ThesisTrade[]) => saveTheses(updated);

  const buildThesisTrade = (id?: string): ThesisTrade => ({
    id: id ?? Date.now().toString(),
    symbol: form.symbol.toUpperCase(),
    direction: form.direction,
    entryPrice: parseFloat(form.entryPrice),
    stopLoss: parseFloat(form.stopLoss),
    takeProfit1: parseFloat(form.takeProfit1),
    takeProfit2: parseFloat(form.takeProfit2) || 0,
    riskPercent: parseFloat(form.riskPercent),
    accountSize: parseFloat(form.accountSize),
    fundingRate: parseFloat(form.fundingRate),
    notes: form.notes,
    createdAt: Date.now(),
    positionSize: calc!.positionSize,
    leverage: calc!.leverage,
    riskReward: calc!.riskReward,
    fundingCost8h: calc!.fundingCost8h,
    fundingCost24h: calc!.fundingCost24h,
    fundingCost72h: calc!.fundingCost72h,
    status: "ACTIVE",
    actualPnl: null,
  });

  const resetForm = () =>
    setForm((f) => ({ ...f, symbol: "", entryPrice: "", stopLoss: "", takeProfit1: "", takeProfit2: "", notes: "" }));

  const deployPaper = () => {
    if (!calc || !form.symbol) return;
    persist([buildThesisTrade(), ...trades]);
    setDeployed(true);
    setTimeout(() => setDeployed(false), 2500);
    resetForm();
  };

  const deployLive = async () => {
    if (!calc || !form.symbol) return;
    setLiveConfirm(false);
    setLiveStatus("submitting");
    setLiveError(null);

    const symbol = `PERP_${form.symbol.toUpperCase()}_USDC`;
    const side = form.direction === "LONG" ? "BUY" : "SELL";
    const closeSide = form.direction === "LONG" ? "SELL" : "BUY";

    // Fetch step size and snap quantity to valid increment
    let baseTick = 0.0001;
    try {
      const infoRes = await fetch(`https://api-evm.orderly.org/v1/public/info/${symbol}`);
      const infoJson = await infoRes.json();
      baseTick = infoJson?.data?.base_tick ?? 0.0001;
    } catch { /* fallback to default */ }

    const rawQty = calc.positionSize / parseFloat(form.entryPrice);
    const qty = Math.floor(rawQty / baseTick) * baseTick;
    // Round to avoid floating-point noise
    const precision = Math.max(0, -Math.floor(Math.log10(baseTick)));
    const snappedQty = parseFloat(qty.toFixed(precision));

    if (snappedQty <= 0) {
      setLiveStatus("error");
      setLiveError(`Position too small — minimum order size for ${form.symbol.toUpperCase()} is ${baseTick}`);
      return;
    }

    try {
      // Step 1 — entry limit order
      await (doOrder as (data: unknown) => Promise<unknown>)({
        symbol,
        order_type: "LIMIT",
        side,
        order_price: parseFloat(form.entryPrice),
        order_quantity: snappedQty,
        order_tag: "nexus_thesis",
      });

      // Step 2 — positional TP/SL bracket
      await (doAlgoOrder as (data: unknown) => Promise<unknown>)({
        symbol,
        algo_type: "POSITIONAL_TP_SL",
        side: closeSide,
        quantity: snappedQty,
        tp_trigger_price: String(parseFloat(form.takeProfit1)),
        tp_order_type: "LIMIT",
        tp_order_price: String(parseFloat(form.takeProfit1)),
        sl_trigger_price: String(parseFloat(form.stopLoss)),
        sl_order_type: "MARKET",
      });

      persist([buildThesisTrade(`live_${Date.now()}`), ...trades]);
      setLiveStatus("success");
      resetForm();
      setTimeout(() => setLiveStatus("idle"), 4000);
    } catch (err: unknown) {
      setLiveStatus("error");
      setLiveError(err instanceof Error ? err.message : "order failed — check console");
    }
  };

  const updateTrade = async (id: string, patch: Partial<ThesisTrade>) => {
    const thesis = trades.find((t) => t.id === id);
    if (!thesis) return;

    // Publishing to feed for the first time → register on-chain
    if (patch.isPublic === true && !thesis.isPublic && !thesis.onChainId) {
      console.log("[ThesisRegistry] attempting registerOnChain for thesis:", thesis.id, thesis.symbol);
      const mergedThesis = { ...thesis, ...patch };
      try {
        const result = await registerOnChain(mergedThesis);
        console.log("[ThesisRegistry] registerOnChain result:", result);
        if (result) {
          const { hash, onChainId } = result;
          persist(trades.map((t) => t.id === id ? {
            ...t, ...patch,
            onChainTxHash: hash,
            ...(onChainId !== undefined ? { onChainId } : {}),
          } : t));
          return;
        }
        // User rejected — keep private
        return;
      } catch (err) {
        console.error("[ThesisRegistry] registerOnChain threw:", err);
        // Fall through to save as public in KV even if on-chain fails
        // so the feed still works while we debug
      }
    }

    // Closing a thesis that was registered on-chain → call closeThesis()
    const closingStatuses = ["HIT_TP", "STOPPED_OUT", "INVALIDATED"] as const;
    type ClosingStatus = typeof closingStatuses[number];
    const isClosingStatus = (s: string): s is ClosingStatus => closingStatuses.includes(s as ClosingStatus);

    if (
      patch.status &&
      isClosingStatus(patch.status) &&
      thesis.status === "ACTIVE" &&
      thesis.onChainId !== undefined &&
      thesis.isPublic
    ) {
      await closeOnChain(thesis.onChainId, patch.status as ClosingStatus, "");
    }

    persist(trades.map((t) => t.id === id ? { ...t, ...patch } : t));
  };

  const removeTrade = (id: string) => persist(trades.filter((t) => t.id !== id));

  const fundingIsPositive = parseFloat(form.fundingRate) >= 0;

  const closedTrades = trades.filter((t) => CLOSED_STATUSES.includes(t.status));
  const hits = trades.filter((t) => t.status === "HIT_TP").length;
  const thesisAccuracy = closedTrades.length ? Math.round((hits / closedTrades.length) * 100) : null;
  const filteredTrades = filter === "ALL" ? trades : trades.filter((t) => t.status === filter);

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #1a2e1a", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "monospace", letterSpacing: "0.12em", marginBottom: 4 }}>
            &#9632; THESIS EXECUTOR — PAPER MODE
          </div>
          <div style={{ fontSize: 11, color: "#3a5a4a", fontFamily: "monospace" }}>
          </div>
        </div>
        {thesisAccuracy !== null && (
          <div style={{ ...cardStyle, padding: "8px 16px", display: "flex", gap: 20 }}>
            <div>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>THESIS ACCURACY</div>
              <div style={{ fontSize: 20, color: thesisAccuracy >= 50 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>{thesisAccuracy}%</div>
            </div>
            <div style={{ width: 1, background: "#1a2e1a" }} />
            <div>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>CLOSED</div>
              <div style={{ fontSize: 20, color: "#8aaa9a", fontFamily: "monospace", fontWeight: "bold" }}>{closedTrades.length}</div>
            </div>
            <div style={{ width: 1, background: "#1a2e1a" }} />
            <div>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>ACTIVE</div>
              <div style={{ fontSize: 20, color: "#4a9fff", fontFamily: "monospace", fontWeight: "bold" }}>{trades.filter((t) => t.status === "ACTIVE").length}</div>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 320px", gap: 12, alignItems: "start" }}>
        {/* Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#fbbf24", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; INSTRUMENT</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 160px", gap: 8 }}>
              <div>
                <span style={fieldLabelStyle}>SYMBOL</span>
                <input style={inputStyle} placeholder="BTC, ETH, SOL..." value={form.symbol} onChange={(e) => set("symbol", e.target.value)} />
              </div>
              <div>
                <span style={fieldLabelStyle}>DIRECTION</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["LONG", "SHORT"] as const).map((d) => (
                    <button key={d} onClick={() => set("direction", d)} style={{
                      flex: 1, padding: "8px 0", fontFamily: "monospace", fontSize: 11,
                      cursor: "pointer", borderRadius: 3, border: "1px solid",
                      background: form.direction === d ? (d === "LONG" ? "#0a2a0a" : "#2a0a0a") : "#080c08",
                      borderColor: form.direction === d ? (d === "LONG" ? "#00ff88" : "#ff4444") : "#1a2e1a",
                      color: form.direction === d ? (d === "LONG" ? "#00ff88" : "#ff4444") : "#3a5a4a",
                    }}>{d === "LONG" ? "↑ LONG" : "↓ SHORT"}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#4a9fff", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; PRICE LEVELS</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 8 }}>
              {[
                { key: "entryPrice", label: "ENTRY", placeholder: "95000" },
                { key: "stopLoss", label: "STOP LOSS", placeholder: "93000" },
                { key: "takeProfit1", label: "TP1", placeholder: "98000" },
                { key: "takeProfit2", label: "TP2 (OPT)", placeholder: "102000" },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <span style={fieldLabelStyle}>{label}</span>
                  <input
                    style={{ ...inputStyle, borderColor: key === "stopLoss" ? "#2a1a1a" : key.startsWith("take") ? "#1a2a1a" : "#1a2e1a" }}
                    type="number" placeholder={placeholder}
                    value={form[key as keyof typeof form] as string}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#a855f7", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; RISK + FUNDING</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr", gap: 8 }}>
              <div>
                <span style={fieldLabelStyle}>ACCOUNT SIZE (USDC)</span>
                <input style={inputStyle} type="number" placeholder="10000" value={form.accountSize} onChange={(e) => set("accountSize", e.target.value)} />
              </div>
              <div>
                <span style={fieldLabelStyle}>RISK %</span>
                <input style={inputStyle} type="number" placeholder="1.5" step="0.1" value={form.riskPercent} onChange={(e) => set("riskPercent", e.target.value)} />
              </div>
              <div>
                <span style={fieldLabelStyle}>FUNDING RATE (% per 8h)</span>
                <input
                  style={{ ...inputStyle, borderColor: fundingIsPositive ? "#1a2a1a" : "#2a1a1a", color: fundingIsPositive ? "#00ff88" : "#ff4444" }}
                  type="number" placeholder="0.01" step="0.001"
                  value={form.fundingRate} onChange={(e) => set("fundingRate", e.target.value)}
                />
                <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace", marginTop: 4 }}>
                  {fundingIsPositive ? "longs pay shorts" : "shorts pay longs"}
                </div>
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 8 }}>&#9632; THESIS / REASONING</div>
            <textarea
              style={{ ...inputStyle, height: 80, resize: "none" }}
              placeholder="Why are you taking this trade? What needs to be true for it to work? What invalidates it?"
              value={form.notes} onChange={(e) => set("notes", e.target.value)}
            />
          </div>
        </div>

        {/* Output Panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, position: isMobile ? "static" : "sticky", top: 16 }}>
          <div style={{ ...cardStyle, border: "1px solid #1a3a2a" }}>
            <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 16 }}>&#9632; CALCULATED OUTPUT</div>
            {!calc ? (
              <div style={{ fontSize: 11, color: "#2a4a3a", fontFamily: "monospace", textAlign: "center", padding: "20px 0" }}>
                fill in entry, stop, tp1,<br />account size + risk %
              </div>
            ) : (
              <>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>POSITION SIZE</div>
                  <div style={{ fontSize: 28, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>${calc.positionSize.toFixed(0)}</div>
                  <div style={{ fontSize: 10, color: "#2a4a3a", fontFamily: "monospace" }}>usdc notional</div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>LEVERAGE REQUIRED</div>
                  <div style={{ fontSize: 22, fontFamily: "monospace", fontWeight: "bold", color: calc.leverage > 25 ? "#ff4444" : calc.leverage > 10 ? "#fbbf24" : "#00ff88" }}>
                    {calc.leverage.toFixed(1)}x
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>RISK AMOUNT</div>
                  <div style={{ fontSize: 18, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>${calc.riskAmount.toFixed(2)}</div>
                  <div style={{ fontSize: 10, color: "#2a4a3a", fontFamily: "monospace" }}>{form.riskPercent}% of account</div>
                </div>
                <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid #1a2e1a" }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>RISK / REWARD</div>
                  <div style={{ fontSize: 22, fontFamily: "monospace", fontWeight: "bold", color: calc.riskReward >= 2 ? "#00ff88" : calc.riskReward >= 1 ? "#fbbf24" : "#ff4444" }}>
                    1 : {calc.riskReward.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: "#2a4a3a", fontFamily: "monospace" }}>
                    {calc.riskReward >= 2 ? "good setup" : calc.riskReward >= 1 ? "marginal" : "unfavorable"}
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em", marginBottom: 8 }}>
                    FUNDING COST ({parseFloat(form.fundingRate) >= 0 ? form.direction : form.direction === "LONG" ? "SHORT" : "LONG"} pays)
                  </div>
                  {[
                    { label: "8h", val: calc.fundingCost8h },
                    { label: "24h", val: calc.fundingCost24h },
                    { label: "72h", val: calc.fundingCost72h },
                  ].map(({ label, val }) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</span>
                      <span style={{ fontSize: 13, color: "#fbbf24", fontFamily: "monospace", fontWeight: "bold" }}>${val.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
                {/* Confirmation overlay */}
                {liveConfirm && calc && (
                  <div style={{ background: "#1a0a00", border: "1px solid #ff6600", borderRadius: 4, padding: "12px 14px", marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: "#ff6600", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 10 }}>
                      &#9632; CONFIRM LIVE ORDER
                    </div>
                    {[
                      { label: "SYMBOL", val: `PERP_${form.symbol.toUpperCase()}_USDC` },
                      { label: "SIDE", val: form.direction, color: form.direction === "LONG" ? "#00ff88" : "#ff4444" },
                      { label: "ENTRY", val: `$${parseFloat(form.entryPrice).toLocaleString()}` },
                      { label: "QTY", val: (calc.positionSize / parseFloat(form.entryPrice)).toFixed(6) },
                      { label: "SIZE", val: `$${calc.positionSize.toFixed(0)} notional` },
                      { label: "STOP", val: `$${parseFloat(form.stopLoss).toLocaleString()}`, color: "#ff4444" },
                      { label: "TP1", val: `$${parseFloat(form.takeProfit1).toLocaleString()}`, color: "#00ff88" },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</span>
                        <span style={{ fontSize: 10, color: color ?? "#8aaa9a", fontFamily: "monospace", fontWeight: "bold" }}>{val}</span>
                      </div>
                    ))}
                    <div style={{ fontSize: 9, color: "#ff4444", fontFamily: "monospace", marginTop: 10, marginBottom: 10, lineHeight: 1.5 }}>
                      ⚠ REAL FUNDS. This places a live order on Orderly<br />
                      with your connected wallet. Cannot be undone.
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => setLiveConfirm(false)} style={{
                        flex: 1, padding: "8px 0", fontFamily: "monospace", fontSize: 11,
                        cursor: "pointer", borderRadius: 3, border: "1px solid #2a2a2a",
                        background: "#0a0a0a", color: "#3a5a4a", letterSpacing: "0.06em",
                      }}>ABORT</button>
                      <button onClick={deployLive} style={{
                        flex: 2, padding: "8px 0", fontFamily: "monospace", fontSize: 11,
                        cursor: "pointer", borderRadius: 3, border: "1px solid #ff6600",
                        background: "#1a0800", color: "#ff6600", letterSpacing: "0.08em", fontWeight: "bold",
                      }}>&#9632; CONFIRM — DEPLOY LIVE</button>
                    </div>
                  </div>
                )}

                {/* Live status feedback */}
                {liveStatus === "submitting" && (
                  <div style={{ padding: "10px 0", textAlign: "center", fontSize: 11, color: "#ff6600", fontFamily: "monospace", letterSpacing: "0.08em" }}>
                    &#9632; SUBMITTING TO ORDERLY...
                  </div>
                )}
                {liveStatus === "success" && (
                  <div style={{ padding: "10px 12px", background: "#0a1a00", border: "1px solid #1a4a00", borderRadius: 4, fontSize: 11, color: "#00ff88", fontFamily: "monospace", marginBottom: 8 }}>
                    &#9632; ORDER LIVE — entry limit + TP/SL bracket set
                  </div>
                )}
                {liveStatus === "error" && (
                  <div style={{ padding: "10px 12px", background: "#1a0a0a", border: "1px solid #4a1a1a", borderRadius: 4, marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: "#ff4444", fontFamily: "monospace" }}>&#9632; ORDER FAILED</div>
                    {liveError && <div style={{ fontSize: 9, color: "#3a2a2a", fontFamily: "monospace", marginTop: 4 }}>{liveError}</div>}
                  </div>
                )}

                {/* Deploy buttons */}
                {!liveConfirm && liveStatus !== "submitting" && (
                  <>
                    <button onClick={deployPaper} disabled={!form.symbol} style={{
                      width: "100%", padding: "9px 0", fontFamily: "monospace", fontSize: 11,
                      cursor: form.symbol ? "pointer" : "not-allowed", borderRadius: 3,
                      border: `1px solid ${deployed ? "#00ff88" : "#1a4a2a"}`,
                      background: deployed ? "#0a2a0a" : "#080c08",
                      color: deployed ? "#00ff88" : form.symbol ? "#4a9fff" : "#2a4a3a",
                      letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      {deployed ? "&#9632; DEPLOYED" : "&#9632; DEPLOY (PAPER)"}
                    </button>
                    <button
                      onClick={() => { if (form.symbol && calc) setLiveConfirm(true); }}
                      disabled={!form.symbol || !isWalletReady}
                      style={{
                        width: "100%", padding: "9px 0", fontFamily: "monospace", fontSize: 11,
                        cursor: form.symbol && isWalletReady ? "pointer" : "not-allowed", borderRadius: 3,
                        border: `1px solid ${!form.symbol || !isWalletReady ? "#2a1a0a" : "#ff6600"}`,
                        background: "#0a0500",
                        color: !form.symbol || !isWalletReady ? "#2a1a0a" : "#ff6600",
                        letterSpacing: "0.08em",
                      }}>
                      &#9632; DEPLOY (LIVE)
                    </button>
                    {!form.symbol && <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace", textAlign: "center", marginTop: 6 }}>enter symbol to deploy</div>}
                    {form.symbol && !isWalletReady && <div style={{ fontSize: 9, color: "#3a2a1a", fontFamily: "monospace", textAlign: "center", marginTop: 6 }}>connect wallet to deploy live</div>}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Analytics Bridge */}
      <ThesisAnalyticsSection trades={trades} />

      {/* Thesis List */}
      {trades.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "monospace", letterSpacing: "0.12em" }}>
              &#9632; THESIS_LOG ({filteredTrades.length}/{trades.length})
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {(["ALL", ...Object.keys(STATUS_CONFIG)] as (ThesisStatus | "ALL")[]).map((f) => {
                const active = filter === f;
                const c = f !== "ALL" ? STATUS_CONFIG[f as ThesisStatus] : null;
                return (
                  <button key={f} onClick={() => setFilter(f)} style={{
                    fontFamily: "monospace", fontSize: 9, padding: "3px 9px",
                    cursor: "pointer", borderRadius: 3, letterSpacing: "0.06em",
                    border: `1px solid ${active ? (c?.border ?? "#1a4a2a") : "#1a2e1a"}`,
                    background: active ? (c?.bg ?? "#0a1a0a") : "transparent",
                    color: active ? (c?.color ?? "#00ff88") : "#2a4a3a",
                  }}>{f === "ALL" ? "ALL" : STATUS_CONFIG[f as ThesisStatus].label}</button>
                );
              })}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filteredTrades.map((t) => (
              <ThesisCard key={t.id} t={t} onUpdate={updateTrade} onRemove={removeTrade} walletAddress={walletAddress} isMobile={isMobile} markPrice={livePrices[t.symbol] ?? null} />
            ))}
          </div>
        </div>
      )}

      {trades.length === 0 && (
        <div style={{ marginTop: 24 }}>
          <EmptyState message="no theses deployed yet — fill the form above and hit deploy" />
        </div>
      )}
    </div>
  );
}
