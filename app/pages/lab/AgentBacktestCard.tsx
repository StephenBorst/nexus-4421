// ── Agent BACKTEST card ──
// Extracted from AgentView.tsx (god-file split). Read-only analysis: it replays a
// config against real history and renders the result. It is NOT on the money path —
// nothing here places an order or mutates agent state — which is why it was the right
// ~140 lines to lift out first.
//
// ⚠️ Mechanical move: markup unchanged. `any` on the result shapes is inherited from
// the original state declarations (the payloads are broad and server-shaped); typing
// them properly is a separate change, not a silent rider on a refactor.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgentConfig } from "./types";
import { agentCardStyle, agentLabelStyle, btnPrimary, navBtnStyle } from "./styles";

export function AgentBacktestCard({
  isPro, config, backtest, backtesting, sweep, sweeping, validation, validating,
  runConfigBacktest, runConfigSweep, runValidation, applySweepConfig,
}: {
  isPro: boolean;
  config: AgentConfig;
  backtest: any | null;
  backtesting: boolean;
  sweep: any | null;
  sweeping: boolean;
  validation: any | null;
  validating: boolean;
  runConfigBacktest: () => void;
  runConfigSweep: () => void;
  runValidation: () => void;
  applySweepConfig: (cfg: any) => void;
}) {
  // ── BACKTEST — test this exact config on real history (PRO) ──
  return (
    <div style={agentCardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={agentLabelStyle}>BACKTEST</div>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#ededf0", border: "1px solid #33333a", borderRadius: 3, padding: "2px 8px" }}>◆ PRO</span>
        </div>
        {isPro && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={runConfigBacktest} disabled={backtesting || sweeping} style={{ ...btnPrimary, fontSize: 10, padding: "6px 16px", opacity: (backtesting || sweeping) ? 0.5 : 1 }}>
              {backtesting ? "RUNNING…" : "▶ TEST THIS CONFIG"}
            </button>
            <button onClick={runConfigSweep} disabled={backtesting || sweeping || validating} style={{ ...navBtnStyle, fontSize: 10, padding: "6px 16px", opacity: (backtesting || sweeping || validating) ? 0.5 : 1 }}>
              {sweeping ? "SWEEPING…" : "⊞ SWEEP CONFIGS"}
            </button>
            <button onClick={runValidation} disabled={backtesting || sweeping || validating} title="Walk-forward across markets + time — the honest robustness test" style={{ ...navBtnStyle, fontSize: 10, padding: "6px 16px", color: "#ededf0", borderColor: "#33333a", opacity: (backtesting || sweeping || validating) ? 0.5 : 1 }}>
              {validating ? "VALIDATING…" : "✓ VALIDATE"}
            </button>
          </div>
        )}
      </div>
      {!isPro ? (
        <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
          Replay this exact config over 60 days of real BTC/ETH/SOL data — using the same engine the agent runs on — before risking a cent. A Nexus PRO feature.
        </div>
      ) : (
        <>
          <div style={{ color: "#71717a", fontFamily: "var(--nx-font-ui)", fontSize: 10, marginTop: 8, lineHeight: 1.5 }}>
            Replays your config on real Orderly history with the deployed signal + exit logic. Verify before you deploy capital.
          </div>
          {backtest && (
            <div style={{ marginTop: 12 }}>
              {backtest.untestable && (
                <div style={{ color: "#fbbf24", fontFamily: "var(--nx-font-ui)", fontSize: 10, lineHeight: 1.5, marginBottom: 10, padding: "6px 8px", border: "1px solid #fbbf2430", borderRadius: 3 }}>
                  ⚠ {backtest.note}
                </div>
              )}
              {/* When OI-driven modes ARE testable, surface the OI-window caveat
                  (funding+price span the full window; confluence only the recorded OI). */}
              {!backtest.untestable && backtest.note && (
                <div style={{ color: "#71717a", fontFamily: "var(--nx-font-ui)", fontSize: 10, lineHeight: 1.5, marginBottom: 10, padding: "6px 8px", border: "1px solid #232327", borderRadius: 3 }}>
                  ◆ {backtest.note}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12 }}>
                {[
                  { label: "NET P&L (60d)", value: `${backtest.combined.netUsd >= 0 ? "+" : ""}$${backtest.combined.netUsd}`, color: backtest.combined.netUsd >= 0 ? "#3ecf8e" : "#f7525f" },
                  { label: "WIN RATE", value: `${backtest.combined.winRate}%`, color: "#d4d4d8" },
                  { label: "TRADES", value: String(backtest.combined.trades), color: "#d4d4d8" },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                    <div style={{ color, fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 600 }}>{value}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {backtest.perSymbol.map((s: any) => (
                  <div key={s.symbol} style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#a1a1aa", borderTop: "1px solid #232327", paddingTop: 4 }}>
                    <span>{s.symbol.replace("PERP_", "").replace("_USDC", "")}</span>
                    <span>{s.trades} trades · {s.winRate}% win · PF {s.profitFactor} · <span style={{ color: s.netUsd >= 0 ? "#3ecf8e" : "#f7525f" }}>{s.netUsd >= 0 ? "+" : ""}${s.netUsd}</span></span>
                  </div>
                ))}
              </div>
              <div style={{ color: "#52525b", fontFamily: "var(--nx-font-ui)", fontSize: 9, marginTop: 8, lineHeight: 1.5 }}>
                Past performance ≠ future results. Taker fees modeled (~3bps/side); funding RECEIVED while fading is not (a tailwind — live may run better). 60d hourly, ${(config.capitalPerTrade * config.leverage).toFixed(0)} notional/trade.
              </div>
            </div>
          )}
          {validation && (() => {
            const v = validation.verdict;
            const vc = v === "ROBUST" ? "#3ecf8e" : v === "FRAGILE" ? "#fbbf24" : "#f7525f";
            const vlabel = v === "ROBUST" ? "✅ ROBUST" : v === "FRAGILE" ? "🟨 FRAGILE" : "❌ NOT ROBUST";
            return (
              <div style={{ marginTop: 14 }}>
                <div style={{ ...agentLabelStyle, fontSize: 9, marginBottom: 6 }}>
                  WALK-FORWARD — {validation.totalSymbols} symbols · {validation.folds} time folds · {validation.days}d · fees on
                </div>
                {validation.untestable ? (
                  <div style={{ color: "#fbbf24", fontFamily: "var(--nx-font-ui)", fontSize: 10, lineHeight: 1.5, padding: "6px 8px", border: "1px solid #fbbf2430", borderRadius: 3 }}>⚠ {validation.note}</div>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", border: `1px solid ${vc}44`, borderRadius: 4, background: `${vc}0c` }}>
                      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 14, fontWeight: 700, color: vc }}>{vlabel}</span>
                      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#a1a1aa" }}>
                        net-positive on {validation.posSymbols}/{validation.totalSymbols} markets · {validation.foldConsistency}% of folds positive · net <span style={{ color: validation.totalNet >= 0 ? "#3ecf8e" : "#f7525f" }}>{validation.totalNet >= 0 ? "+" : ""}${validation.totalNet}</span>
                      </span>
                    </div>
                    <div style={{ marginTop: 8, overflowX: "auto" }}>
                      <div style={{ minWidth: 320 }}>
                        {validation.perSymbol.map((s: any) => (
                          <div key={s.symbol} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "3px 0", borderTop: "1px solid #141416" }}>
                            <span style={{ width: 46, color: "#d4d4d8" }}>{s.symbol.replace("PERP_", "").replace("_USDC", "")}</span>
                            <span style={{ width: 66, textAlign: "right", color: s.net >= 0 ? "#3ecf8e" : "#f7525f" }}>{s.net >= 0 ? "+" : ""}${s.net}</span>
                            <span style={{ width: 54, textAlign: "right", color: "#a1a1aa" }}>{s.foldsPositive}/{validation.folds}f</span>
                            <span style={{ display: "flex", gap: 2, marginLeft: 6 }}>
                              {s.folds.map((n: number, i: number) => <span key={i} title={`fold ${i + 1}: ${n >= 0 ? "+" : ""}$${n}`} style={{ width: 8, height: 12, borderRadius: 1, background: n > 0 ? "#3ecf8e" : n < 0 ? "#f7525f" : "#33333a" }} />)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{ color: "#52525b", fontFamily: "var(--nx-font-ui)", fontSize: 9, marginTop: 8, lineHeight: 1.5 }}>
                      The honest test: an edge that only works on one market in one window is NOT robust. We hold our own presets to this — nothing wears "proven" until it passes. Past performance ≠ future results.
                    </div>
                  </>
                )}
              </div>
            );
          })()}
          {sweep && (
            <div style={{ marginTop: 14 }}>
              <div style={{ ...agentLabelStyle, fontSize: 9, marginBottom: 6 }}>
                RANKED — {sweep.results.length} configs · {sweep.symbols.map((s: string) => s.replace("PERP_", "").replace("_USDC", "")).join("/")} · {sweep.days}d · ${sweep.notional} notional
              </div>
              <div style={{ overflowX: "auto" }}>
                <div style={{ minWidth: 340 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 52px 56px", gap: 6, fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", padding: "0 0 4px", borderBottom: "1px solid #232327" }}>
                    <span>STRATEGY</span><span style={{ textAlign: "right" }}>NET$</span><span style={{ textAlign: "right" }}>WIN%</span><span style={{ textAlign: "right" }}>TRADES</span>
                  </div>
                  {sweep.results.slice(0, 12).map((r: any, i: number) => (
                    <div key={i} onClick={() => r.config && applySweepConfig(r.config)} title="Apply this config to the editor above" style={{ display: "grid", gridTemplateColumns: "1fr 70px 52px 56px", gap: 6, fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "5px 4px", borderBottom: "1px solid #141416", color: "#a1a1aa", cursor: r.config ? "pointer" : "default", borderRadius: 3 }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#141416"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}>
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i === 0 ? "★ " : ""}{r.name}</span>
                      <span style={{ textAlign: "right", color: r.netUsd >= 0 ? "#3ecf8e" : "#f7525f", fontWeight: 600 }}>{r.netUsd >= 0 ? "+" : ""}{r.netUsd}</span>
                      <span style={{ textAlign: "right" }}>{r.winRate}</span>
                      <span style={{ textAlign: "right" }}>{r.trades}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ color: "#52525b", fontFamily: "var(--nx-font-ui)", fontSize: 9, marginTop: 8, lineHeight: 1.5 }}>
                ↑ Click any row to apply that config to the editor. {sweep.oiTested
                  ? `CONFLUENCE + OI-divergence are now in the sweep${sweep.oiCoverage?.minDays ? `, graded on ${sweep.oiCoverage.minDays}d of recorded OI history` : ""}.`
                  : "CONFLUENCE/OI aren't in the sweep yet — they fold in automatically once recorded OI history is deep enough."} Every config here was graded on real price — apply a winner, then paper-test before going live.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
