// Thesis Engine tab: the thesis calculator, thesis cards, and the thesis
// analytics (accuracy/streaks/equity). Extracted from index.tsx (god-file split).
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { THESIS_DRAFT_KEY } from "@/config/assistantTools";
import { useAccount, useMutation, useCollateral } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { useThesisRegistry } from "@/hooks/useThesisRegistry";
import { useLivePrices, calcUnrealizedPnl, distancePct } from "@/hooks/useLivePrices";
import { useIsMobile } from "./useIsMobile";
import type { ThesisTrade, ThesisStatus, ProcessedTrade } from "./types";
import { LiveRead } from "./LiveRead";
import { SimComposer } from "./SimComposer";
import { cardStyle, labelStyle, navBtnStyle, inputStyle, fieldLabelStyle, STATUS_CONFIG, CLOSED_STATUSES } from "./styles";
import { deployToAgent, thesisToAgentConfig, thesisAgentNotice, deployDirectiveFromThesis } from "@/utils/agentPrefill";
import { formatPnl, chartImageSrc, chartImageList, effectiveStatus, resolveSuggestion, CHART_HOST_HINT, MAX_CHARTS } from "./helpers";
import { LOSS_REASONS, lossReason } from "@/lib/postmortem.mjs";
import { parseThesis } from "@/lib/thesisParse.mjs";
import { AGENT_API } from "./agentTypes";
import { ThesisTimeline } from "./ThesisTimeline";
import { ThesisAdvisor } from "./ThesisAdvisor";
import { PnlChart, EmptyState, Coachmark } from "./components";
import { Collapsible } from "./Collapsible";
import { SharePoster, type PosterData } from "./SharePoster";

// Crash-proof number formatting — a partial thesis (e.g. a systematic house call with
// no leverage/positionSize/fundingCost) must NEVER take the whole app down with
// `undefined.toFixed` (it did, on mobile). NaN/undefined → 0. Prices auto-scale decimals
// so a sub-dollar coin (POL $0.11) keeps precision instead of rounding to "$0.11".
const nf = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : 0).toFixed(d);
const priceDp = (v: unknown) => { const n = Math.abs(Number(v) || 0); return n >= 1000 ? 2 : n >= 1 ? 2 : n >= 0.01 ? 4 : 6; };

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
  const [poster, setPoster] = useState<PosterData | null>(null);
  const navigate = useNavigate();
  const eff = effectiveStatus(t); // objective grade wins over self-report — used everywhere the card branches on outcome
  const cfg = STATUS_CONFIG[eff] ?? STATUS_CONFIG.ACTIVE;
  const isClosed = CLOSED_STATUSES.includes(eff);
  // 2px state left-rule (Proof/feed card signature). Win/loss carry the only
  // chroma; active/other stay a quiet neutral.
  const leftRule = eff === "HIT_TP" ? "#3ecf8e" : eff === "STOPPED_OUT" ? "#f7525f" : eff === "INVALIDATED" ? "#3f3f46" : "#33333a";

  // Auto-grade the dollar P&L from the plan the trader already logged, so a HIT TP /
  // STOPPED OUT click fills the number instead of making them do entry→exit × size
  // math by hand. HIT_TP → exit at TP1, STOPPED_OUT → exit at stop, INVALIDATED →
  // never triggered → $0. It's an estimate at the planned levels (ignores slippage /
  // partials) and is fully DERIVED — never typed. The on-chain grade is computed
  // objectively vs public price regardless of this figure.
  const autoPnlFor = (s: ThesisStatus): number | null => {
    if (s === "INVALIDATED") return 0;
    const exit = s === "HIT_TP" ? t.takeProfit1 : s === "STOPPED_OUT" ? t.stopLoss : null;
    if (exit == null) return null;
    return Math.round(calcUnrealizedPnl(t.direction, t.entryPrice, exit, t.positionSize).pnl * 100) / 100;
  };

  const handleStatusClick = (s: ThesisStatus) => {
    const next = t.status === s ? "ACTIVE" : s;
    if (CLOSED_STATUSES.includes(next)) {
      const auto = autoPnlFor(next);
      onUpdate(t.id, auto !== null ? { status: next, actualPnl: auto } : { status: next });
    } else {
      onUpdate(t.id, { status: next });
    }
  };

  return (
    <div style={{
      ...cardStyle,
      border: "1px solid #232327",
      borderLeft: `2px solid ${leftRule}`,
      background: isClosed ? "#08080a" : "#0f0f11",
      opacity: eff === "INVALIDATED" ? 0.7 : 1,
    }}>
      {poster && <SharePoster data={poster} onClose={() => setPoster(null)} />}
      {/* Top row */}
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "stretch" : "flex-start", justifyContent: "space-between", marginBottom: 10, gap: isMobile ? 10 : 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flex: 1, minWidth: 0 }}>
          <div style={{ minWidth: 52 }}>
            <div style={{ fontSize: 16, color: "#fff", fontWeight: "bold", fontFamily: "var(--nx-font-mono)" }}>{t.symbol.replace("PERP_","").replace("_USDC","")}</div>
            <div style={{ fontSize: 10, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)" }}>
              {t.direction === "LONG" ? "↑" : "↓"} {t.direction} · {nf(t.leverage, 1)}x
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(3, 1fr)" : "repeat(6, auto)", gap: isMobile ? "8px 12px" : "0 16px", flex: 1 }}>
            {[
              { label: "ENTRY", val: `$${nf(t.entryPrice, priceDp(t.entryPrice))}` },
              { label: "STOP", val: `$${nf(t.stopLoss, priceDp(t.stopLoss))}`, color: "#f7525f" },
              { label: "TP1", val: `$${nf(t.takeProfit1, priceDp(t.takeProfit1))}`, color: "#ededf0" },
              { label: "SIZE", val: (Number(t.positionSize) || 0) > 0 ? `$${nf(t.positionSize, 0)}` : "—" },
              { label: "R:R", val: `1:${nf(t.riskReward, 2)}`, color: (Number(t.riskReward) || 0) >= 2 ? "#ededf0" : "#fbbf24" },
              { label: "72H FUND", val: (Number(t.fundingCost72h) || 0) !== 0 ? `$${nf(t.fundingCost72h, 3)}` : "—", color: "#a1a1aa" },
            ].map(({ label, val, color }) => (
              <div key={label}>
                <div style={{ fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: "#71717a", fontFamily: "var(--nx-font-mono)" }}>{label}</div>
                <div style={{ fontSize: 12, color: color ?? "#a1a1aa", fontFamily: "var(--nx-font-mono)", marginTop: 2 }}>{val}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: isMobile ? "row" : "column", alignItems: isMobile ? "center" : "flex-end", justifyContent: isMobile ? "space-between" : "flex-start", gap: 6, flexShrink: 0 }}>
          {!isMobile && <div style={{ fontSize: 9, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>{new Date(t.createdAt).toLocaleDateString()}</div>}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {eff === "ACTIVE" && walletAddress && (
              <a
                href={`https://t.me/nexustradinglabs_bot?start=${walletAddress.toLowerCase()}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...navBtnStyle, fontSize: 10, color: "#6cb6ff", borderColor: "#1a1a1e", textDecoration: "none", display: "inline-block", textAlign: "center", minHeight: 36, lineHeight: "22px", padding: "6px 12px" }}
              >
                🔔 ALERTS
              </a>
            )}
            {t.isPublic && walletAddress && (() => {
              // Share your own public call → pulls external eyes back to the feed.
              const tk = t.symbol.replace("PERP_", "").replace("_USDC", "");
              // Share via the worker OG proxy so the per-thesis card unfurls on X/etc
              // (the SPA's JS-injected OG tags are invisible to crawlers). It redirects
              // humans straight to the app page.
              const url = `https://og.nexustradinglabs.com/share/thesis/${walletAddress.toLowerCase()}/${t.id}`;
              // Use the NaN/undefined-safe formatter (nf) — a public call missing any numeric
              // field (older/partial theses) otherwise crashed the whole card on render (undefined.toFixed).
              const text = `📡 ${tk} ${t.direction} ${nf(t.leverage, 1)}x\n\nEntry $${nf(t.entryPrice, 2)} · Stop $${nf(t.stopLoss, 2)} · TP $${nf(t.takeProfit1, 2)} (R:R 1:${nf(t.riskReward, 2)})\n\nGraded on-chain vs public price on Nexus Trading Labs 👇`;
              const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
              return (
                <a href={xUrl} target="_blank" rel="noopener noreferrer" title="Share this call on X"
                  style={{ ...navBtnStyle, fontSize: 10, color: "#a1a1aa", borderColor: "#232327", textDecoration: "none", display: "inline-block", textAlign: "center", minHeight: 36, lineHeight: "22px", padding: "6px 12px" }}>
                  𝕏 SHARE
                </a>
              );
            })()}
            {t.isPublic && (
              <button
                title="Generate a branded, downloadable share card for this call"
                onClick={() => setPoster({
                  kind: "thesis", symbol: t.symbol, direction: t.direction,
                  entry: t.entryPrice, stop: t.stopLoss, target: t.takeProfit1,
                  rr: t.riskReward, note: t.notes ?? null,
                })}
                style={{ ...navBtnStyle, fontSize: 10, color: "#a1a1aa", borderColor: "#232327", minHeight: 36, padding: "6px 12px", cursor: "pointer" }}
              >◆ CARD</button>
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
                PRIVATE: { label: "📡 PRIVATE", color: "#52525b", border: "#232327", bg: "transparent" },
                PUBLIC:  { label: "📡 PUBLIC",  color: "#ededf0", border: "#33333a", bg: "#1a1a1e" },
                HOLDERS: { label: "◆ HOLDERS",  color: "#ededf0", border: "#33333a", bg: "#1a1a1e" },
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
            <button onClick={() => deployToAgent(
                thesisToAgentConfig(t),
                `your ${t.symbol.replace("PERP_", "").replace("_USDC", "")} thesis`,
                thesisAgentNotice(t),
                navigate,
              )}
              title="Prefill the agent to trade this symbol on funding/OI signals, using this thesis's TP/SL and leverage as risk bounds. The agent is signal-driven — it may enter either direction."
              style={{ ...navBtnStyle, fontSize: 10, color: "#ededf0", borderColor: "#33333a", minHeight: 36, padding: "6px 12px" }}>
              ⚡ AUTOMATE
            </button>
            <button onClick={() => deployDirectiveFromThesis({
                id: t.id, symbol: t.symbol, direction: t.direction,
                entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfit1: t.takeProfit1,
                takeProfit2: t.takeProfit2, leverage: t.leverage,
                // #2 attribution: a COPIED call deployed to the agent credits the original
                // caller (source_leader) so they earn the creator fee-share. Self-copies are
                // excluded server-side in the earnings calc (wallet_address === leader).
                source: t.copiedFromWallet || undefined,
              }, navigate)}
              title="Hand the agent THIS exact trade: it enters your direction and manages to your stop/targets with the agent's full exit engine (scale-out, trailing, breakeven, timeout). One-shot."
              style={{ ...navBtnStyle, fontSize: 10, color: "#ededf0", borderColor: "#33333a", minHeight: 36, padding: "6px 12px" }}>
              ▶ TRADE
            </button>
            <button onClick={() => onRemove(t.id)} style={{ ...navBtnStyle, fontSize: 10, color: "#f7525f", borderColor: "#4a1e22", minHeight: 36, padding: "6px 12px" }}>REMOVE</button>
          </div>
        </div>
      </div>

      {/* Outcome — the objective grade LEADS; win/loss is never self-reported. Graded
          → an authoritative banner (the tape decided). Un-resolved → a calm "it grades
          itself" line. INVALIDATE (abandon early) is the one call the grader genuinely
          can't infer, so it's the only manual control left. */}
      {(() => {
        const isGraded = t.gradedOutcome === "WIN" || t.gradedOutcome === "LOSS";
        if (isGraded) {
          const win = t.gradedOutcome === "WIN";
          const color = win ? "#3ecf8e" : "#f7525f";
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: `1px solid ${color}55`, background: `${color}10`, borderRadius: 4, padding: "8px 10px", marginBottom: 10 }}>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: 700, color }}>
                ✓ NEXUS GRADED · {win ? "WIN" : "LOSS"}{t.gradedR != null ? ` ${t.gradedR >= 0 ? "+" : ""}${t.gradedR.toFixed(2)}R` : ""}
              </span>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a" }}>
                first-touch {win ? "TP1" : "stop"} vs public price{t.gradedAt ? ` · ${new Date(t.gradedAt).toLocaleDateString()}` : ""} — the tape marked this, not you
              </span>
            </div>
          );
        }
        if (eff === "INVALIDATED") {
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a" }}>◌ INVALIDATED — you abandoned this thesis before it resolved (excluded from your graded record)</span>
              <button onClick={() => handleStatusClick("INVALIDATED")} title="Reopen — put this thesis back live so Nexus grades it from public price on resolution"
                style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "5px 10px", borderRadius: 3, border: "1px solid #232327", background: "transparent", color: "#71717a", cursor: "pointer" }}>↺ REOPEN</button>
            </div>
          );
        }
        if (eff === "HIT_TP" || eff === "STOPPED_OUT") {
          // Resolved by an earlier self-mark (legacy / pre-grade) — NOT objectively graded
          // yet. Shown neutrally (not claimed as "graded"); the objective grade lands
          // automatically from public price. REOPEN clears the self-mark back to live.
          const win = eff === "HIT_TP";
          const color = win ? "#3ecf8e" : "#f7525f";
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: `1px solid ${color}33`, background: `${color}0c`, borderRadius: 4, padding: "8px 10px", marginBottom: 10 }}>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: 700, color }}>● {win ? "WIN" : "LOSS"} <span style={{ color: "#52525b", fontWeight: 400 }}>· self-marked</span></span>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a" }}>Nexus grades every public call from public price — the objective grade lands automatically.</span>
              <button onClick={() => handleStatusClick(eff)} title="Reopen — clear this self-mark and let Nexus grade it from public price"
                style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "5px 10px", borderRadius: 3, border: "1px solid #232327", background: "transparent", color: "#71717a", cursor: "pointer" }}>↺ REOPEN</button>
            </div>
          );
        }
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a" }}>◷ LIVE — Nexus grades this automatically from public price the moment it resolves. Nothing to mark.</span>
            <button onClick={() => handleStatusClick("INVALIDATED")} title="Abandon this thesis early — it's no longer valid. The grader can't infer this, so it's the one call that's yours to make."
              style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "5px 10px", borderRadius: 3, border: "1px solid #232327", background: "transparent", color: "#52525b", cursor: "pointer" }}>◌ INVALIDATE</button>
          </div>
        );
      })()}

      {/* ── LIFECYCLE TIMELINE — a call is a story, not a frozen post.
          Editable while the thesis is open; read-only once it's closed (the story
          ended). Additive only — never re-grades. */}
      <ThesisTimeline t={t} onUpdate={onUpdate} canEdit={!isClosed} />

      {/* ── POSTMORTEM — appears the moment a thesis becomes a loss ──
          The highest-value 5 seconds a trader can spend, and a fixed taxonomy means
          it aggregates into a real leak profile instead of unsearchable notes.
          Optional, one tap, self-reported → never touches the graded record. */}
      {(t.gradedOutcome === "LOSS" || t.status === "STOPPED_OUT") && (() => {
        const picked = lossReason(t.lossReason ?? "");
        return (
          <div style={{ borderTop: "1px solid #232327", paddingTop: 10, marginBottom: 10 }}>
            {picked ? (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                  <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 3 }}>WHY IT LOST</div>
                  <div style={{ fontSize: 12, color: "#d4d4d8", fontFamily: "var(--nx-font-ui)" }}>{picked.label}</div>
                  <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginTop: 3, lineHeight: 1.5 }}>{picked.fix}</div>
                </div>
                <button
                  onClick={() => onUpdate(t.id, { lossReason: undefined })}
                  style={{ ...navBtnStyle, fontSize: 9, minHeight: 28, padding: "4px 10px", flexShrink: 0 }}
                >CHANGE</button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 6 }}>
                  WHY DID IT LOSE? <span style={{ color: "#33333a" }}>· optional · private · never affects your graded record</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {LOSS_REASONS.map((r) => (
                    <button
                      key={r.key}
                      title={r.hint}
                      onClick={() => onUpdate(t.id, { lossReason: r.key })}
                      style={{
                        fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "5px 10px",
                        cursor: "pointer", borderRadius: 3, letterSpacing: "0.04em", minHeight: 30,
                        border: "1px solid #232327", background: "transparent", color: "#71717a",
                      }}
                    >{r.label}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Provisional pending notice — the live mark has tagged a level but Nexus hasn't
          stamped the objective grade yet (first-touch OHLC, computed server-side).
          Informational ONLY: the grade lands automatically from public price, so there's
          nothing to click. Once graded, the authoritative banner above takes over. */}
      {eff === "ACTIVE" && (() => {
        const sug = resolveSuggestion(t, markPrice);
        if (!sug || sug.graded) return null; // graded → shown by the grade banner above
        const isTp = sug.outcome === "HIT_TP";
        const color = isTp ? "#3ecf8e" : "#f7525f";
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: `1px solid ${color}55`, background: `${color}10`, borderRadius: 4, padding: "8px 10px", marginBottom: 10 }}>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color }}>
              ◆ price {isTp ? "tagged your TP1" : "tagged your stop"}{markPrice != null ? ` at $${markPrice.toFixed(markPrice < 10 ? 4 : 2)}` : ""} — Nexus is grading this from public price…
            </span>
          </div>
        );
      })()}

      {/* Live P&L — only shown for still-live (ungraded) theses with a mark price */}
      {eff === "ACTIVE" && markPrice != null && (() => {
        const { pnl, pct } = calcUnrealizedPnl(t.direction, t.entryPrice, markPrice, t.positionSize);
        const toSL = distancePct(markPrice, t.stopLoss);
        const toTP = distancePct(markPrice, t.takeProfit1);
        const isWinning = pnl >= 0;
        return (
          <div style={{ borderTop: "1px solid #232327", paddingTop: 10, marginBottom: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: "8px 16px" }}>
              <div>
                <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 2 }}>MARK PRICE</div>
                <div style={{ fontSize: 13, color: "#fff", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>
                  ${markPrice.toFixed(markPrice < 10 ? 4 : 2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 2 }}>UNREALIZED P&L</div>
                <div style={{ fontSize: 13, fontFamily: "var(--nx-font-mono)", fontWeight: "bold", color: isWinning ? "#3ecf8e" : "#f7525f" }}>
                  {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                  <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.7 }}>({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 2 }}>TO SL</div>
                <div style={{ fontSize: 13, color: "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>
                  {toSL.toFixed(2)}%
                </div>
              </div>
              <div>
                <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 2 }}>TO TP1</div>
                <div style={{ fontSize: 13, color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>
                  {toTP.toFixed(2)}%
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* P&L — fully DERIVED by the engine from the resolved outcome at the planned
          levels. No manual entry: the graded record is R vs public price (shown above),
          and this dollar figure follows from it — never typed. */}
      {isClosed && (() => {
        const shown = t.actualPnl ?? autoPnlFor(eff);
        if (shown == null) return null;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, paddingTop: 8, borderTop: "1px solid #232327", flexWrap: "wrap" }}>
            <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", whiteSpace: "nowrap" }}>P&amp;L</div>
            <div style={{ fontSize: 16, color: shown >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>
              {formatPnl(shown)}
            </div>
            <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>est. at planned levels</div>
          </div>
        );
      })()}

      {/* Charts — validated per-item at RENDER time, so one bad stored URL is dropped
          and the rest still show. Single chart goes full width; multiples pair up. */}
      {(() => {
        const charts = chartImageList(t);
        if (!charts.length) return null;
        return (
          <div style={{ display: "grid", gridTemplateColumns: charts.length === 1 ? "1fr" : "1fr 1fr", gap: 6, marginTop: 8 }}>
            {charts.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noopener noreferrer" style={{ display: "block" }}>
                <img
                  src={src} alt={`${t.symbol} chart ${i + 1}`} loading="lazy" referrerPolicy="no-referrer"
                  style={{ width: "100%", maxHeight: charts.length === 1 ? 220 : 150, objectFit: "contain", borderRadius: 3, border: "1px solid #232327", background: "#0a0a0b" }}
                />
              </a>
            ))}
          </div>
        );
      })()}

      {/* Signal framing — catalyst (why now) + defined exit window, when present. */}
      {(t.catalyst || t.targetWindow) && (
        <div style={{ marginTop: 6, paddingTop: 8, borderTop: "1px solid #232327", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {t.catalyst && (
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#a1a1aa", background: "#141416", border: "1px solid #232327", borderRadius: 3, padding: "2px 7px" }}>
              ⚡ {t.catalyst}
            </span>
          )}
          {t.targetWindow && (
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a" }}>⌛ exit by {t.targetWindow}</span>
          )}
        </div>
      )}
      {/* Notes */}
      {t.notes && (
        <div style={{ marginTop: 6, paddingTop: 8, borderTop: "1px solid #232327", fontSize: 11, color: "#52525b", fontFamily: "var(--nx-font-mono)", fontStyle: "italic" }}>
          &quot;{t.notes}&quot;
        </div>
      )}
    </div>
  );
}

// ─── Thesis Analytics Section ─────────────────────────────
function ThesisAnalyticsSection({ trades }: { trades: ThesisTrade[] }) {
  // Objective grade drives every count — win rate reflects how Nexus scored the calls
  // from public price (first-touch OHLC), NOT what the trader clicked. INVALIDATED is
  // the one user action the grader can't infer, so effectiveStatus preserves it.
  const closedTrades = trades.filter((t) => CLOSED_STATUSES.includes(effectiveStatus(t)));
  const withPnl = closedTrades.filter((t) => t.actualPnl !== null);

  if (closedTrades.length === 0) return null;

  const hits = trades.filter((t) => effectiveStatus(t) === "HIT_TP").length;
  const stoppedOut = trades.filter((t) => effectiveStatus(t) === "STOPPED_OUT").length;
  const invalidated = trades.filter((t) => effectiveStatus(t) === "INVALIDATED").length;
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
        <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 16, fontFamily: "var(--nx-font-mono)" }}>
          <span style={{ color: "#52525b" }}>&#9632;</span> ACCURACY BREAKDOWN
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
          <div style={{ background: "#141416", border: "1px solid #33333a", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 6 }}>HIT TP</div>
            <div style={{ fontSize: 28, color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{hits}</div>
          </div>
          <div style={{ background: "#241012", border: "1px solid #4a1e22", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 6 }}>STOPPED OUT</div>
            <div style={{ fontSize: 28, color: "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{stoppedOut}</div>
          </div>
          <div style={{ background: "#2a1a00", border: "1px solid #4a3a00", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 6 }}>INVALIDATED</div>
            <div style={{ fontSize: 28, color: "#fbbf24", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{invalidated}</div>
          </div>
          <div style={{ background: "#0a0a0b", border: "1px solid #33333a", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 6 }}>WIN RATE</div>
            <div style={{ fontSize: 28, color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{winRate}%</div>
            <div style={{ height: 3, background: "#232327", borderRadius: 2, marginTop: 8 }}>
              <div style={{ height: 3, background: "#d4d4d8", borderRadius: 2, width: `${winRate}%` }} />
            </div>
          </div>
        </div>
        {/* TOTAL P&L — its own full-width row so the number matches the count tiles'
            size (congruent, easy on the eye) without ever overflowing a narrow tile. */}
        <div style={{ background: "#0a0a0b", border: `1px solid ${totalActualPnl >= 0 ? "#33333a" : "#4a1e22"}`, borderRadius: 4, padding: "10px 14px", marginTop: 8, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 6 }}>TOTAL ACTUAL P&amp;L</div>
            <div style={{ fontSize: 28, color: totalActualPnl >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold", whiteSpace: "nowrap" }}>
              {withPnl.length > 0 ? formatPnl(totalActualPnl) : "—"}
            </div>
          </div>
          {withPnl.length > 0 && (
            <div style={{ fontSize: 9, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>{withPnl.length} logged</div>
          )}
        </div>
      </div>

      {/* Best / Worst + Cumulative Chart */}
      {withPnl.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
          {/* Best Thesis */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "var(--nx-font-mono)" }}>&#9632; BEST THESIS</div>
            {bestThesis ? (
              <>
                <div style={{ background: "#141416", border: "1px solid #232327", borderRadius: 4, padding: "10px 12px", marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                    <span style={{ fontSize: 15, color: "#fff", fontWeight: "bold", fontFamily: "var(--nx-font-mono)" }}>{bestThesis.symbol}</span>
                    <span style={{ fontSize: 16, color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{formatPnl(bestThesis.actualPnl ?? 0)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ fontSize: 10, color: bestThesis.direction === "LONG" ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)" }}>
                      {bestThesis.direction === "LONG" ? "↑" : "↓"} {bestThesis.direction}
                    </div>
                    <div style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>1:{bestThesis.riskReward.toFixed(2)} R:R</div>
                  </div>
                </div>
                <div style={{ fontSize: 9, color: STATUS_CONFIG[effectiveStatus(bestThesis)].color, fontFamily: "var(--nx-font-mono)", letterSpacing: "0.06em" }}>
                  {STATUS_CONFIG[effectiveStatus(bestThesis)].label}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>no P&L logged yet</div>
            )}
          </div>

          {/* Worst Thesis */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "var(--nx-font-mono)" }}>&#9632; WORST THESIS</div>
            {worstThesis ? (
              <>
                <div style={{ background: "#241012", border: "1px solid #4a1e22", borderRadius: 4, padding: "10px 12px", marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                    <span style={{ fontSize: 15, color: "#fff", fontWeight: "bold", fontFamily: "var(--nx-font-mono)" }}>{worstThesis.symbol}</span>
                    <span style={{ fontSize: 16, color: "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{formatPnl(worstThesis.actualPnl ?? 0)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ fontSize: 10, color: worstThesis.direction === "LONG" ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)" }}>
                      {worstThesis.direction === "LONG" ? "↑" : "↓"} {worstThesis.direction}
                    </div>
                    <div style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>1:{worstThesis.riskReward.toFixed(2)} R:R</div>
                  </div>
                </div>
                <div style={{ fontSize: 9, color: STATUS_CONFIG[effectiveStatus(worstThesis)].color, fontFamily: "var(--nx-font-mono)", letterSpacing: "0.06em" }}>
                  {STATUS_CONFIG[effectiveStatus(worstThesis)].label}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>
                {withPnl.length === 1 ? "need 2+ results" : "no P&L logged yet"}
              </div>
            )}
          </div>

          {/* Cumulative Thesis P&L Chart — spans the full row so the curve stretches
              across the frame (mirrors the P&L accuracy breakdown), not a half tile. */}
          <div style={{ ...cardStyle, gridColumn: "1 / -1" }}>
            <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 4, fontFamily: "var(--nx-font-mono)" }}>&#9632; THESIS P&amp;L</div>
            <PnlChart points={cumulativePoints} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{sortedByDate.length} results plotted</div>
              <div style={{ fontSize: 10, color: totalActualPnl >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{formatPnl(totalActualPnl)}</div>
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

  // Count the OBJECTIVE grade (effectiveStatus prefers gradedOutcome over the raw /
  // self-reported status) so these analytics agree with the breakdown card above and
  // with every public trustless surface, instead of quietly using two truth sources.
  const closed = useMemo(
    () => theses.filter((t) => { const e = effectiveStatus(t); return e === "HIT_TP" || e === "STOPPED_OUT"; }),
    [theses]
  );

  const summaryStats = useMemo(() => {
    const wins = closed.filter((t) => effectiveStatus(t) === "HIT_TP").length;
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
      if (effectiveStatus(t) === "HIT_TP") current++;
      else break;
    }
    const sortedAsc = [...closed].sort((a, b) => a.createdAt - b.createdAt);
    let best = 0;
    let streak = 0;
    for (const t of sortedAsc) {
      if (effectiveStatus(t) === "HIT_TP") { streak++; if (streak > best) best = streak; }
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
      if (effectiveStatus(t) === "HIT_TP") s.wins++;
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
    return <EmptyState message="no thesis analytics yet" unlock="Connect your wallet to load the calls you've written — these charts are built from your own theses." />;
  }

  const endVal = equityPoints.length > 0 ? equityPoints[equityPoints.length - 1] : 0;
  const lineColor = endVal >= 0 ? "#3ecf8e" : "#f7525f";

  const renderEquityCurve = () => {
    if (equityPoints.length < 2) {
      return (
        <div style={{ padding: "20px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#33333a" }}>
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
        <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="#232327" strokeWidth="1" strokeDasharray="4,4" />
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
        borderBottom: i < maxIdx ? "1px solid #141416" : "none",
        alignItems: "center",
      }}
    >
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#fff" }}>{a.sym}</span>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, textAlign: "right", color: a.winRate >= 50 ? "#3ecf8e" : "#f7525f" }}>
        {a.winRate.toFixed(0)}%
      </span>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, textAlign: "right", color: "#52525b" }}>{a.total}</span>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, textAlign: "right", color: a.avgRR >= 2 ? "#ededf0" : "#fbbf24" }}>
        1:{a.avgRR.toFixed(1)}
      </span>
    </div>
  );

  const tableHeader = () => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 54px 40px 54px", gap: 8, marginBottom: 6 }}>
      {["SYMBOL", "WR", "N", "AVG R:R"].map((col) => (
        <span key={col} style={{ fontSize: 8, color: "#33333a", fontFamily: "var(--nx-font-mono)", textAlign: col !== "SYMBOL" ? "right" : "left" }}>
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
          { label: "TOTAL THESES", val: summaryStats.total.toString(), color: "#a1a1aa" as string },
          {
            label: "WIN RATE",
            val: closed.length > 0 ? `${summaryStats.winRate.toFixed(1)}%` : "—",
            color: (closed.length > 0 ? (summaryStats.winRate >= 50 ? "#3ecf8e" : "#f7525f") : "#52525b") as string,
          },
          {
            label: "AVG R:R",
            val: theses.length > 0 ? `1:${summaryStats.avgRR.toFixed(2)}` : "—",
            color: (theses.length > 0 ? (summaryStats.avgRR >= 2 ? "#ededf0" : "#fbbf24") : "#52525b") as string,
          },
          {
            label: "TOTAL P&L",
            val: closed.length > 0 ? `${summaryStats.totalPnl >= 0 ? "+" : "-"}$${Math.abs(summaryStats.totalPnl).toFixed(2)}` : "—",
            color: (closed.length > 0 ? (summaryStats.totalPnl >= 0 ? "#3ecf8e" : "#f7525f") : "#52525b") as string,
          },
        ].map(({ label, val, color }) => (
          <div key={label} style={cardStyle}>
            <div style={labelStyle}>{label}</div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 22, fontWeight: "bold", color }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Equity curve */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", letterSpacing: "0.1em" }}>◆ EQUITY CURVE</span>
          {equityPoints.length >= 2 && (
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: "bold", color: lineColor }}>
              {summaryStats.totalPnl >= 0 ? "+" : "-"}${Math.abs(summaryStats.totalPnl).toFixed(2)}
            </span>
          )}
        </div>
        {renderEquityCurve()}
      </div>

      {/* Streak + best/worst markets */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
        {/* Win streak */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 14 }}>◆ WIN STREAK</div>
          <div style={{ marginBottom: 14 }}>
            <div style={labelStyle}>CURRENT STREAK</div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 28, fontWeight: "bold", color: streaks.current > 0 ? "#ededf0" : "#33333a" }}>
              {streaks.current}
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#52525b", marginLeft: 6 }}>wins</span>
            </div>
          </div>
          <div>
            <div style={labelStyle}>BEST STREAK</div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 22, fontWeight: "bold", color: streaks.best > 0 ? "#ededf0" : "#33333a" }}>
              {streaks.best}
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#52525b", marginLeft: 6 }}>wins</span>
            </div>
          </div>
        </div>

        {/* Best markets */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 10 }}>◆ BEST MARKETS</div>
          {bestAssets.length === 0 ? (
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#33333a" }}>no closed theses yet</div>
          ) : (
            <>
              {tableHeader()}
              {bestAssets.map((a, i) => assetRow(a, i, bestAssets.length - 1))}
            </>
          )}
        </div>

        {/* Worst markets */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 10 }}>◆ WORST MARKETS</div>
          {worstAssets.length === 0 ? (
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#33333a" }}>no closed theses yet</div>
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
export function ThesisView({ realizedTrades, wallet }: { realizedTrades?: ProcessedTrade[]; wallet?: string | null } = {}) {
  const isMobile = useIsMobile();
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const { theses: trades, saveTheses } = useLabStorage(walletAddress);
  const { registerOnChain, closeOnChain } = useThesisRegistry();
  const { availableBalance } = useCollateral();

  // Live prices for all active theses
  const activeSymbols = useMemo(
    () => [...new Set(trades.filter((t) => effectiveStatus(t) === "ACTIVE").map((t) => t.symbol))],
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
    catalyst: "",
    targetWindow: "",
    chartUrls: [""] as string[],
  });

  // Done-for-you: seed account size from the connected collateral so position sizing
  // works without typing an account number. Only fills when the field is empty, so it
  // never clobbers an edit; the "= MY COLLATERAL" button still re-fills on demand.
  useEffect(() => {
    const bal = Number(availableBalance);
    if (bal > 0) setForm((f) => (f.accountSize === "" ? { ...f, accountSize: String(Math.floor(bal)) } : f));
  }, [availableBalance]);


  // Paste-to-fill: drop a TradingView analysis (or any freeform thesis) and the
  // heuristic parser prefills the fields the trader already wrote out. Conservative
  // by design — it only fills clearly-anchored values and always keeps the full text.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteResult, setPasteResult] = useState<string[] | null>(null);
  const applyPaste = () => {
    const r = parseThesis(pasteText);
    setForm((f) => ({
      ...f,
      symbol: r.symbol ?? f.symbol,
      direction: r.direction ?? f.direction,
      entryPrice: r.entryPrice ?? f.entryPrice,
      stopLoss: r.stopLoss ?? f.stopLoss,
      takeProfit1: r.takeProfit1 ?? f.takeProfit1,
      takeProfit2: r.takeProfit2 ?? f.takeProfit2,
      // Only seed notes if empty, so we don't clobber something the trader typed.
      notes: f.notes.trim() ? f.notes : r.notes,
    }));
    setPasteResult(r.filled);
  };

  const [deployed, setDeployed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [filter, setFilter] = useState<ThesisStatus | "ALL">("ALL");
  const [markBusy, setMarkBusy] = useState(false);
  const [fundingBusy, setFundingBusy] = useState(false);
  const [chartBusy, setChartBusy] = useState<number | null>(null); // index being uploaded
  const [chartErr, setChartErr] = useState<string | null>(null);
  // ⚡ Quick Call — the premium fast path. Two knobs (stop %, target R); a build fetches
  // the live mark and sets entry/stop/TP atomically (sequential helpers can't — setForm
  // is async). Defaults tuned so "symbol → side → post" needs zero typing.
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickStopPct, setQuickStopPct] = useState(2);
  const [quickTpR, setQuickTpR] = useState(2);

  // Full listed-markets set → validate the symbol (a typo makes an ungradeable call)
  // and power the autocomplete datalist. Fetched once, fail-soft (no list ⇒ no warning).
  const [marketTickers, setMarketTickers] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await (await fetch("https://api-evm.orderly.org/v1/public/info")).json();
        const rows = d?.data?.rows ?? [];
        const tickers = rows.map((x: { symbol?: string }) => String(x.symbol || "").replace("PERP_", "").replace("_USDC", "")).filter(Boolean);
        if (alive && tickers.length) setMarketTickers([...new Set<string>(tickers)].sort());
      } catch { /* fail-soft — no validation rather than a false warning */ }
    })();
    return () => { alive = false; };
  }, []);

  // Remember the account size across theses — it's the one field that never changes
  // between trades, yet the form used to make you retype it every time.
  const ACCT_KEY = "nexus_thesis_account";
  useEffect(() => {
    try { const v = window.localStorage.getItem(ACCT_KEY); if (v) setForm((f) => (f.accountSize ? f : { ...f, accountSize: v })); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Consume a thesis draft handed off by the AI assistant (draft_thesis tool):
  // pre-fill the form once, then clear the draft so it doesn't re-apply. Runs on
  // mount (tab switched in from elsewhere) AND on the `nexus:thesis-draft` event —
  // the event is what makes it work when this view is ALREADY mounted (user already
  // on the Thesis tab), where a re-navigate to the same URL is a no-op and the mount
  // effect never re-fires. That gap was the "not prefilling" bug.
  useEffect(() => {
    const consume = () => {
      try {
        const raw = window.localStorage.getItem(THESIS_DRAFT_KEY);
        if (!raw) return;
        const d = JSON.parse(raw);
        setForm((f) => ({
          ...f,
          symbol: d.symbol ?? f.symbol,
          direction: d.direction === "SHORT" ? "SHORT" : "LONG",
          entryPrice: d.entryPrice ?? f.entryPrice,
          stopLoss: d.stopLoss ?? f.stopLoss,
          takeProfit1: d.takeProfit1 ?? f.takeProfit1,
          notes: d.notes ?? f.notes,
          catalyst: d.catalyst ?? f.catalyst,
          targetWindow: d.targetWindow ?? f.targetWindow,
        }));
        // ⚠️ Contract survival (Grok): a FROZEN draft carries absolute stop/TP. The Quick Call
        // knobs default to 2% / 2R and would DISPLAY those (and clobber the draft on a rebuild),
        // so derive stop% and R from the drafted levels — the knobs now match the frozen stop/TP.
        const e = parseFloat(d.entryPrice), s = parseFloat(d.stopLoss), tp = parseFloat(d.takeProfit1);
        if (Number.isFinite(e) && Number.isFinite(s) && Number.isFinite(tp) && e > 0 && Math.abs(s - e) > 0) {
          setQuickStopPct(Math.round((Math.abs(s - e) / e * 100) * 10) / 10);
          setQuickTpR(Math.round((Math.abs(tp - e) / Math.abs(s - e)) * 10) / 10);
        }
        // A drafted direction is a SUGGESTION, not the trader's pick — let the WATCH
        // gate re-evaluate it against the base rate (the [form.symbol] effect re-arms;
        // this covers a re-draft of the same symbol, where that effect wouldn't fire).
        userChoseDir.current = false;
        window.localStorage.removeItem(THESIS_DRAFT_KEY);
      } catch { /* ignore malformed draft */ }
    };
    consume();
    window.addEventListener("nexus:thesis-draft", consume);
    return () => window.removeEventListener("nexus:thesis-draft", consume);
  }, []);

  // ── Live execution ──────────────────────────────────────
  const [doOrder] = useMutation("/v1/order", "POST");
  const [doAlgoOrder] = useMutation("/v1/algo/order", "POST");
  const [liveConfirm, setLiveConfirm] = useState(false);
  const [liveStatus, setLiveStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [liveError, setLiveError] = useState<string | null>(null);
  const isWalletReady = !!(accountState && (accountState as { status?: number }).status !== undefined && (accountState as { status?: number }).status !== 0);

  // ── Default-to-WATCH (Grok) ───────────────────────────────────────────────
  // When a setup's OWN historical base rate is weak (fading it reverted ≤42% of recent
  // stretched-funding instances — a TRAP), don't pre-arm a direction. The suggested side
  // stays VISIBLE but un-checked; the trader must pick it deliberately before we'll build
  // or publish — "direction is visible, not pre-checked." A good OR absent base rate arms
  // normally. The signal is the SAME reversion/last-N-fades clock the GAPS ticket vetoes
  // on, lifted up via LiveRead's onWeakEdge — ONE veto series, so the two can never fork.
  const [dirArmed, setDirArmed] = useState(true);
  const [weakSetup, setWeakSetup] = useState<{ histPct: number | null } | null>(null);
  const userChoseDir = useRef(false);
  // ONE veto clock (Grok): LiveRead feeds the SAME reversion/last-N-fades signal the GAPS
  // ticket vetoes on — so a coin can never read WATCH on the ticket and armed here (or the
  // reverse). No /intel/baserate here, no averaging of two series.
  const handleWeakEdge = useCallback((w: { weak: boolean; histPct: number | null }) => {
    setWeakSetup(w.weak ? { histPct: w.histPct } : null);
    if (!userChoseDir.current) setDirArmed(!w.weak);
  }, []);
  // New market → forget the prior pick and re-arm until this coin's base rate is read.
  useEffect(() => { userChoseDir.current = false; setDirArmed(true); setWeakSetup(null); }, [form.symbol]);

  const calc = useMemo(() => calcThesis(form), [form]);
  // A thesis is only valid to save if it produces a real, finite, positive size
  // (catches missing fields, entry===stop, 0 risk → $0 / Infinity positions) AND a
  // direction has been committed (the WATCH gate: a weak base rate must be overridden
  // on purpose, never by a pre-checked default).
  const formValid = !!form.symbol && dirArmed && !!calc
    && Number.isFinite(calc.positionSize) && calc.positionSize > 0
    && Number.isFinite(calc.riskReward) && calc.riskReward > 0;
  // string | string[] — chartUrls is a list; every other field is a plain string.
  const set = (field: string, value: string | string[]) => setForm((f) => ({ ...f, [field]: value }));

  // Symbol validation: warn only once the market list has loaded, so we never flash a
  // false "not listed" while it's still fetching.
  const symbolUpper = form.symbol.trim().toUpperCase();
  const symbolListed = !marketTickers || !symbolUpper || marketTickers.includes(symbolUpper);

  // Plan geometry sanity — calcThesis uses Math.abs, so a stop on the WRONG side of
  // entry (or a target on the wrong side) still produces a "valid" size. Catch the
  // fat-finger before it becomes a nonsensical call. Warn, don't block (rare valid cases).
  const planWarnings = (() => {
    const e = parseFloat(form.entryPrice), s = parseFloat(form.stopLoss), tp = parseFloat(form.takeProfit1);
    const w: string[] = [];
    if (e > 0 && s > 0) {
      if (form.direction === "LONG" && s >= e) w.push("Stop is at/above entry on a LONG — a long's stop sits below entry. Did you mean SHORT?");
      if (form.direction === "SHORT" && s <= e) w.push("Stop is at/below entry on a SHORT — a short's stop sits above entry. Did you mean LONG?");
    }
    if (e > 0 && tp > 0) {
      if (form.direction === "LONG" && tp <= e) w.push("TP1 is at/below entry on a LONG — your target should be above entry.");
      if (form.direction === "SHORT" && tp >= e) w.push("TP1 is at/above entry on a SHORT — your target should be below entry.");
    }
    if (calc && Number.isFinite(calc.riskReward) && calc.riskReward > 0 && calc.riskReward < 1)
      w.push(`R:R is 1:${calc.riskReward.toFixed(2)} — you're risking more than the target pays.`);
    return w;
  })();

  // ── Guided-entry helpers (kill the blank-form friction) ──────────────────
  const roundPrice = (n: number) => Number(n.toFixed(n < 1 ? 6 : n < 100 ? 4 : 2));
  // Fill entry from the live mark price so the plan is anchored to reality.
  const fillEntryFromMark = async () => {
    if (!form.symbol) return;
    setMarkBusy(true);
    try {
      const sym = `PERP_${form.symbol.toUpperCase()}_USDC`;
      const r = await fetch(`https://api-evm.orderly.org/v1/public/futures/${sym}`);
      const d = await r.json();
      const mark = parseFloat(d?.data?.mark_price);
      if (mark > 0) set("entryPrice", String(roundPrice(mark)));
    } catch { /* fail-soft */ }
    finally { setMarkBusy(false); }
  };
  // Fill the funding rate from the live 8h rate (signed → the "who pays" line is
  // right too), so the funding-cost estimate is real instead of the 0.01 placeholder.
  const fillFundingFromLive = async () => {
    if (!form.symbol) return;
    setFundingBusy(true);
    try {
      const sym = `PERP_${form.symbol.toUpperCase()}_USDC`;
      const d = await (await fetch(`https://api-evm.orderly.org/v1/public/futures/${sym}`)).json();
      const fr = parseFloat(d?.data?.last_funding_rate); // decimal fraction per 8h
      if (Number.isFinite(fr)) set("fundingRate", String(Math.round(fr * 100 * 1e4) / 1e4));
    } catch { /* fail-soft */ }
    finally { setFundingBusy(false); }
  };
  // Persist account size whenever it changes (see ACCT_KEY seed effect above).
  useEffect(() => {
    try { if (parseFloat(form.accountSize) > 0) window.localStorage.setItem(ACCT_KEY, form.accountSize); } catch { /* ignore */ }
  }, [form.accountSize]);
  // Stop = pct adverse from entry (direction-aware).
  const applyStopPct = (pct: number) => {
    const e = parseFloat(form.entryPrice);
    if (!(e > 0)) return;
    const stop = form.direction === "LONG" ? e * (1 - pct / 100) : e * (1 + pct / 100);
    set("stopLoss", String(roundPrice(stop)));
  };
  // TP1 = R multiple of the entry→stop risk (reinforces R:R thinking).
  const applyTpR = (mult: number) => {
    const e = parseFloat(form.entryPrice);
    const s = parseFloat(form.stopLoss);
    if (!(e > 0) || !(s > 0)) return;
    const risk = Math.abs(e - s);
    const tp = form.direction === "LONG" ? e + mult * risk : e - mult * risk;
    set("takeProfit1", String(roundPrice(tp)));
  };

  // ⚡ Quick Call build: ONE fetch → entry (live mark) + stop (stopPct) + TP (tpR·risk) +
  // live funding, all set atomically (a sequence of the single-field helpers can't — each
  // setForm is async, so the next would read a stale entry). Pass `dir` when the side is
  // changing this same tick so we don't read a stale form.direction. Fail-soft.
  const quickSetup = async (stopPct: number, tpR: number, dir?: "LONG" | "SHORT") => {
    const direction = dir ?? form.direction;
    if (!form.symbol) return;
    setQuickBusy(true);
    try {
      const sym = `PERP_${form.symbol.toUpperCase()}_USDC`;
      const d = await (await fetch(`https://api-evm.orderly.org/v1/public/futures/${sym}`)).json();
      const mark = parseFloat(d?.data?.mark_price);
      const fr = parseFloat(d?.data?.last_funding_rate);
      if (mark > 0) {
        const entry = roundPrice(mark);
        const stop = direction === "LONG" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
        const risk = Math.abs(entry - stop);
        const tp = direction === "LONG" ? entry + tpR * risk : entry - tpR * risk;
        setForm((f) => ({
          ...f, direction,
          entryPrice: String(entry),
          stopLoss: String(roundPrice(stop)),
          takeProfit1: String(roundPrice(tp)),
          fundingRate: Number.isFinite(fr) ? String(Math.round(fr * 100 * 1e4) / 1e4) : f.fundingRate,
        }));
      }
    } catch { /* fail-soft — leave the form as-is */ }
    finally { setQuickBusy(false); }
  };
  // Re-snap stop + TP off the EXISTING entry (adjusting the knobs after a build; no refetch).
  const rebuildLevels = (stopPct: number, tpR: number) => {
    const entry = parseFloat(form.entryPrice);
    if (!(entry > 0)) return;
    const stop = form.direction === "LONG" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
    const risk = Math.abs(entry - stop);
    const tp = form.direction === "LONG" ? entry + tpR * risk : entry - tpR * risk;
    setForm((f) => ({ ...f, stopLoss: String(roundPrice(stop)), takeProfit1: String(roundPrice(tp)) }));
  };

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
    catalyst: form.catalyst.trim() || undefined,
    targetWindow: form.targetWindow.trim() || undefined,
    chartUrls: (() => { const v = form.chartUrls.map((u) => u.trim()).filter(Boolean); return v.length ? v : undefined; })(),
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
    setForm((f) => ({ ...f, symbol: "", entryPrice: "", stopLoss: "", takeProfit1: "", takeProfit2: "", notes: "", catalyst: "", targetWindow: "", chartUrls: [""] }));

  // Saves the thesis PRIVATELY. Places no order of any kind — it was called
  // "deployPaper" and labelled "DEPLOY (PAPER)", which read as paper *trading* and
  // hid the fact that this is simply "save". Renamed to match what it does.
  const saveThesis = () => {
    if (!formValid) return;
    persist([buildThesisTrade(), ...trades]);
    setDeployed(true);
    setTimeout(() => setDeployed(false), 2500);
    resetForm();
  };

  // Save AND publish in one step — the missing path. Previously the only way to make
  // a graded call was: save (via a button named for paper trading) → find the card in
  // the list → cycle a small visibility chip. buildThesisTrade() never sets isPublic,
  // so every thesis defaulted to private and was therefore never graded.
  // Mirrors updateTrade()'s on-chain semantics exactly: a user REJECTION keeps it
  // private, while an on-chain ERROR still publishes to KV so the feed works.
  const publishAsCall = async () => {
    if (!formValid) return;
    const t = buildThesisTrade();
    const base = [t, ...trades];
    persist(base);
    resetForm();
    setPublishing(true);
    const makePublic = (extra: Partial<ThesisTrade> = {}) =>
      persist(base.map((x) => (x.id === t.id ? { ...x, isPublic: true, ...extra } : x)));
    try {
      const result = await registerOnChain({ ...t, isPublic: true });
      if (result) {
        makePublic({
          onChainTxHash: result.hash,
          ...(result.onChainId !== undefined ? { onChainId: result.onChainId } : {}),
        });
        setPublished(true);
        setTimeout(() => setPublished(false), 2500);
      }
      // result == null → user rejected the signature: stays private, same as the card toggle.
    } catch {
      makePublic(); // on-chain failed (not rejected) — publish anyway so the feed still works
      setPublished(true);
      setTimeout(() => setPublished(false), 2500);
    } finally {
      setPublishing(false);
    }
  };

  const deployLive = async () => {
    if (!formValid) return;
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

  // Objective grade drives header stats + the filter — a call Nexus graded from public
  // price counts as resolved even if the trader never self-marked it (raw status ACTIVE).
  const closedTrades = trades.filter((t) => CLOSED_STATUSES.includes(effectiveStatus(t)));
  const hits = trades.filter((t) => effectiveStatus(t) === "HIT_TP").length;
  const thesisAccuracy = closedTrades.length ? Math.round((hits / closedTrades.length) * 100) : null;
  const filteredTrades = filter === "ALL" ? trades : trades.filter((t) => effectiveStatus(t) === filter);
  // The trustless count: calls Nexus objectively graded from public price (WIN/LOSS),
  // as opposed to ones you abandoned. This is the number that builds your caller record.
  const gradedCount = trades.filter((t) => t.gradedOutcome === "WIN" || t.gradedOutcome === "LOSS").length;

  // "To resolve" summary — ACTIVE calls that have tagged a level or been graded but not
  // yet synced, surfaced at the top so they aren't buried below the fold.
  const resolveList = trades
    .map((t) => ({ t, sug: resolveSuggestion(t, livePrices[t.symbol]) }))
    .filter((x): x is { t: ThesisTrade; sug: { outcome: "HIT_TP" | "STOPPED_OUT"; graded: boolean } } => x.sug != null);
  const gradedReady = resolveList.filter((x) => x.sug.graded).length;
  // Batch-sync every graded-but-unsynced call in ONE write (looping updateTrade would
  // clobber, each mapping over stale `trades`). Auto-fills P&L from entry→exit×size.
  const syncGraded = () => {
    const updated = trades.map((t) => {
      const sug = resolveSuggestion(t, livePrices[t.symbol]);
      if (!sug || !sug.graded) return t;
      const exit = sug.outcome === "HIT_TP" ? t.takeProfit1 : t.stopLoss;
      const pnl = Math.round(calcUnrealizedPnl(t.direction, t.entryPrice, exit, t.positionSize).pnl * 100) / 100;
      return { ...t, status: sug.outcome, actualPnl: pnl };
    });
    persist(updated);
  };

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #232327", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 9, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 5 }}>
            Plan
          </div>
          <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: 24, fontWeight: 700, color: "#f4f4f5", lineHeight: 1.1, letterSpacing: "-0.01em" }}>
            The Nexus Thesis Engine
          </div>
        </div>
        {thesisAccuracy !== null && (
          <div style={{ ...cardStyle, padding: "8px 16px", display: "flex", gap: 20 }}>
            <div>
              <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>THESIS ACCURACY</div>
              <div style={{ fontSize: 20, color: thesisAccuracy >= 50 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{thesisAccuracy}%</div>
            </div>
            <div style={{ width: 1, background: "#232327" }} />
            <div title="Calls Nexus objectively graded from public price — first-touch TP vs stop. The trustless record that builds your caller rank.">
              <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>GRADED</div>
              <div style={{ fontSize: 20, color: gradedCount > 0 ? "#3ecf8e" : "#52525b", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{gradedCount}</div>
            </div>
            <div style={{ width: 1, background: "#232327" }} />
            <div>
              <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>CLOSED</div>
              <div style={{ fontSize: 20, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{closedTrades.length}</div>
            </div>
            <div style={{ width: 1, background: "#232327" }} />
            <div>
              <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>ACTIVE</div>
              <div style={{ fontSize: 20, color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{trades.filter((t) => effectiveStatus(t) === "ACTIVE").length}</div>
            </div>
          </div>
        )}
      </div>

      {/* What makes a Signal — the plain recipe (congruent with the Mispriced Board). */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 14, padding: "11px 13px", border: "1px solid #232327", borderLeft: "2px solid #71717a", borderRadius: 6, background: "#0f0f11" }}>
        <span style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 12, flexShrink: 0 }}>?</span>
        <span style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: 12.5, lineHeight: 1.55, color: "#a1a1aa" }}>
          <b style={{ color: "#f4f4f5" }}>A good call is a Signal, not a guess</b> — it names three things: an <b style={{ color: "#f4f4f5" }}>edge</b> (why
          the market is wrong — your levels + the funding read), a <b style={{ color: "#f4f4f5" }}>catalyst</b> (why it moves now), and a{" "}
          <b style={{ color: "#f4f4f5" }}>defined exit</b> (target, stop, and when you'll know). Fill those in and it grades itself against real price.
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 320px", gap: 12, alignItems: "start" }}>
        {/* Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* ⚡ QUICK CALL — the premium fast path: symbol → side → post, auto-built from
              live price, on-chain + graded, zero manual marking. The detailed form below
              is the "fine-tune" for power users; this is how most calls should be made. */}
          {(() => {
            const built = parseFloat(form.entryPrice) > 0 && parseFloat(form.stopLoss) > 0 && parseFloat(form.takeProfit1) > 0;
            const long = form.direction === "LONG";
            const entryN = parseFloat(form.entryPrice), stopN = parseFloat(form.stopLoss), tpN = parseFloat(form.takeProfit1);
            const stopPctShown = entryN > 0 ? Math.abs((entryN - stopN) / entryN) * 100 : 0;
            const px = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 4 : 2 })}`;
            const knob = (on: boolean, accent: string): React.CSSProperties => ({
              fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "5px 10px", borderRadius: 3, cursor: "pointer",
              border: `1px solid ${on ? accent : "#232327"}`, background: on ? `${accent}1e` : "#0a0a0b", color: on ? accent : "#71717a",
            });
            const canBuild = !!form.symbol && symbolListed;
            return (
              <div style={{ ...cardStyle, borderColor: "#33333a", background: "linear-gradient(180deg,#15151a 0%,#0f0f11 100%)" }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 700, color: "#ededf0", letterSpacing: "0.04em" }}>⚡ QUICK CALL</span>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a" }}>on-chain · graded from public price · no manual marking</span>
                </div>
                {published && (
                  <div className="nx-fade-in" style={{ marginBottom: 10, padding: "8px 10px", borderRadius: 4, border: "1px solid #3ecf8e55", background: "#0f2318", fontFamily: "var(--nx-font-mono)", fontSize: 10.5, color: "#3ecf8e", lineHeight: 1.5 }}>
                    ◆ Call posted on-chain — it&apos;s grading itself against public price now. Fire off another. 🎯
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 210px", gap: 8 }}>
                  <div>
                    <span style={fieldLabelStyle}>SYMBOL</span>
                    <input style={{ ...inputStyle, borderColor: symbolListed ? "#232327" : "#4a1e22" }} placeholder="BTC, ETH, SOL…" value={form.symbol}
                      list="nexus-thesis-symbols" autoCapitalize="characters" autoComplete="off" onChange={(e) => set("symbol", e.target.value)} />
                  </div>
                  <div>
                    <span style={fieldLabelStyle}>DIRECTION{!dirArmed && <span style={{ color: "#e0a458" }}> · WATCH</span>}</span>
                    <div style={{ display: "flex", gap: 4 }}>
                      {(["LONG", "SHORT"] as const).map((d) => {
                        const on = form.direction === d && dirArmed;          // committed side
                        const suggested = form.direction === d && !dirArmed;  // shown, not pre-checked
                        return (
                        <button key={d} onClick={() => { userChoseDir.current = true; setDirArmed(true); set("direction", d); if (canBuild) quickSetup(quickStopPct, quickTpR, d); }} style={{
                          flex: 1, padding: "8px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11, cursor: "pointer", borderRadius: 3, border: "1px solid",
                          background: on ? (d === "LONG" ? "#1a1a1e" : "#241012") : "#0f0f11",
                          borderColor: on ? (d === "LONG" ? "#3ecf8e" : "#f7525f") : suggested ? "#e0a45866" : "#232327",
                          color: on ? (d === "LONG" ? "#3ecf8e" : "#f7525f") : suggested ? "#e0a458" : "#52525b",
                        }}>{d === "LONG" ? "↑ LONG" : "↓ SHORT"}</button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                {!symbolListed && form.symbol && (
                  <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9.5, color: "#fbbf24", marginTop: 6 }}>⚠ Not a listed market — pick from the list so Nexus can grade it.</div>
                )}
                {/* WATCH gate (Grok): a weak base rate un-arms the direction so the trader
                    overrides a bad setup on purpose, not by our pre-check. Direction stays visible. */}
                {!dirArmed && weakSetup && (
                  <div className="nx-fade-in" style={{ marginTop: 8, padding: "8px 10px", borderRadius: 4, border: "1px solid #e0a45855", background: "#1c1710", fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#e0a458", lineHeight: 1.55 }}>
                    ⚠ WATCH — fading {form.symbol.toUpperCase()} has historically underperformed{weakSetup.histPct != null ? ` (reverted only ${weakSetup.histPct}% of recent stretched-funding instances)` : ""}. The {form.direction.toLowerCase()} side is shown, not pre-selected — tap it to commit.
                  </div>
                )}

                {/* THE READ — the pre-trade fusion: positioning + funding + callers + your
                    own record on this market, synthesized against the direction you're
                    drafting. Intelligence AT the decision, not scattered across tabs. */}
                {form.symbol && symbolListed && (
                  <div style={{ marginTop: 12 }}>
                    <LiveRead symbol={form.symbol} direction={form.direction} trades={realizedTrades}
                      levels={built ? { entryPrice: entryN, stopLoss: stopN, takeProfit1: tpN } : undefined} wallet={wallet} onWeakEdge={handleWeakEdge} />
                  </div>
                )}

                {/* SIM — pressure-test this thesis (or any scenario) with Miroshark.
                    Seeded from the draft; fully editable, so you can sim whatever you want. */}
                {form.symbol && (
                  <div style={{ marginTop: 12 }}>
                    <SimComposer wallet={wallet ?? null} seed={{
                      coin: form.symbol, direction: form.direction,
                      entry: built && entryN > 0 ? String(entryN) : form.entryPrice || undefined,
                      target: built && tpN > 0 ? String(tpN) : form.takeProfit1 || undefined,
                    }} />
                  </div>
                )}

                {!built ? (
                  <button onClick={() => quickSetup(quickStopPct, quickTpR)} disabled={!canBuild || quickBusy || !dirArmed}
                    style={{ marginTop: 12, width: "100%", padding: "11px 0", fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", cursor: canBuild && dirArmed && !quickBusy ? "pointer" : "not-allowed", borderRadius: 4,
                      border: `1px solid ${canBuild && dirArmed ? "#33333a" : "#232327"}`, background: canBuild && dirArmed ? "#1a1a1e" : "#0a0a0b", color: canBuild && dirArmed ? "#ededf0" : "#52525b" }}>
                    {quickBusy ? "BUILDING…" : !dirArmed ? "⚠ PICK A SIDE TO BUILD" : "⚡ BUILD IT — auto-fill from live price"}
                  </button>
                ) : (
                  <>
                    <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(70px, 1fr))", gap: 8, padding: "10px 12px", border: "1px solid #232327", borderRadius: 6, background: "#0a0a0b" }}>
                      {[
                        { l: "ENTRY", v: entryN > 0 ? px(entryN) : "—", c: "#a1a1aa" },
                        { l: `STOP ${long ? "−" : "+"}${stopPctShown.toFixed(1)}%`, v: stopN > 0 ? px(stopN) : "—", c: "#f7525f" },
                        { l: `TP ${quickTpR}R`, v: tpN > 0 ? px(tpN) : "—", c: "#ededf0" },
                        { l: "SIZE", v: calc ? `$${calc.positionSize.toFixed(0)}` : "set acct ↓", c: calc ? "#d4d4d8" : "#52525b" },
                        // R:R is fixed by the target knob (TP built at exactly tpR·risk), so show it
                        // always — it doesn't need the account size the way position SIZE does.
                        { l: "R:R", v: `1:${quickTpR.toFixed(2)}`, c: quickTpR >= 2 ? "#3ecf8e" : "#fbbf24" },
                      ].map(({ l, v, c }) => (
                        <div key={l}>
                          <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.03em", whiteSpace: "nowrap" }}>{l}</div>
                          <div style={{ fontSize: 13, color: c, fontFamily: "var(--nx-font-mono)", fontWeight: 700 }}>{v}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                      <span style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>STOP</span>
                      {[1, 2, 3].map((p) => (
                        <button key={p} onClick={() => { setQuickStopPct(p); rebuildLevels(p, quickTpR); }} style={knob(Math.abs(quickStopPct - p) < 0.01, "#f7525f")}>−{p}%</button>
                      ))}
                      <span style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginLeft: 6 }}>TARGET</span>
                      {[1.5, 2, 3].map((r) => (
                        <button key={r} onClick={() => { setQuickTpR(r); rebuildLevels(quickStopPct, r); }} style={knob(Math.abs(quickTpR - r) < 0.01, "#ededf0")}>{r}R</button>
                      ))}
                      <button onClick={() => quickSetup(quickStopPct, quickTpR)} title="Re-anchor entry to the current mark" style={{ ...knob(false, "#33333a"), marginLeft: "auto", color: "#71717a" }}>{quickBusy ? "…" : "⟳ re-price"}</button>
                    </div>
                    {!(parseFloat(form.accountSize) > 0) ? (
                      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginTop: 10 }}>
                        <div style={{ flex: 1 }}>
                          <span style={fieldLabelStyle}>ACCOUNT SIZE (USDC) — sizes your call</span>
                          <input style={inputStyle} type="number" placeholder="10000" value={form.accountSize} onChange={(e) => set("accountSize", e.target.value)} />
                        </div>
                        {Number(availableBalance) > 0 && (
                          <button onClick={() => set("accountSize", String(Math.floor(Number(availableBalance))))} style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "9px 10px", borderRadius: 3, border: "1px solid #33333a", background: "#0a0a0b", color: "#d4d4d8", cursor: "pointer", whiteSpace: "nowrap" }}>= MY COLLATERAL</button>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 8 }}>sized off ${Math.round(parseFloat(form.accountSize)).toLocaleString()} account · {form.riskPercent}% risk · change in fine-tune ↓</div>
                    )}
                    {formValid && (
                      <div style={{ marginTop: 10 }}>
                        <ThesisAdvisor symbol={form.symbol} direction={form.direction} entryPrice={form.entryPrice} stopLoss={form.stopLoss} takeProfit1={form.takeProfit1} riskReward={calc?.riskReward} wallet={walletAddress} compact />
                      </div>
                    )}
                    {planWarnings.length > 0 && (
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                        {planWarnings.map((msg, i) => <div key={i} style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9.5, color: "#fbbf24", lineHeight: 1.4 }}>⚠ {msg}</div>)}
                      </div>
                    )}
                    <button onClick={publishAsCall} disabled={!formValid || publishing}
                      style={{ marginTop: 12, width: "100%", padding: "13px 0", fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", cursor: formValid && !publishing ? "pointer" : "not-allowed", borderRadius: 4,
                        border: `1px solid ${formValid || published ? "#3ecf8e" : "#232327"}`,
                        background: published ? "#0f2318" : formValid ? "#12241a" : "#0a0a0b",
                        color: formValid || published ? "#3ecf8e" : "#52525b" }}>
                      {published ? "◆ PUBLISHED — NOW GRADED" : publishing ? "PUBLISHING…" : "◆ POST CALL — grades itself"}
                    </button>
                    <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8.5, color: "#52525b", textAlign: "center", marginTop: 6, lineHeight: 1.5 }}>
                      Posts on-chain + public. Nexus grades it from public price — first-touch TP vs stop. You never mark it yourself.
                    </div>
                  </>
                )}
                <div style={{ borderTop: "1px solid #1a1a1e", marginTop: 12, paddingTop: 8, textAlign: "center" }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>want a catalyst, charts, TP2, or a live order? fine-tune below ↓</span>
                </div>
              </div>
            );
          })()}

          {/* Paste-to-fill: import a TradingView analysis (or any thesis text) */}
          <div style={cardStyle}>
            <button
              onClick={() => setPasteOpen((o) => !o)}
              style={{ ...navBtnStyle, width: "100%", textAlign: "left", fontSize: 10, letterSpacing: "0.08em", color: pasteOpen ? "#ededf0" : "#a1a1aa", borderColor: pasteOpen ? "#33333a" : "#232327", padding: "8px 10px" }}
              title="Paste a thesis from TradingView (or anywhere) — Nexus prefills the fields it can read"
            >
              {pasteOpen ? "▾" : "▸"} PASTE THESIS TO AUTOFILL
            </button>
            {pasteOpen && (
              <div style={{ marginTop: 8 }}>
                <textarea
                  value={pasteText}
                  onChange={(e) => { setPasteText(e.target.value); setPasteResult(null); }}
                  placeholder="Paste your TradingView analysis here — e.g. &quot;ZECUSD… net bullish… stop below $415… supply zone $624–$685…&quot;"
                  rows={5}
                  style={{ ...inputStyle, width: "100%", resize: "vertical", fontSize: 11, lineHeight: 1.5, minHeight: 90 }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                  <button onClick={applyPaste} disabled={!pasteText.trim()}
                    style={{ ...navBtnStyle, fontSize: 10, color: pasteText.trim() ? "#ededf0" : "#3f3f46", borderColor: pasteText.trim() ? "#33333a" : "#232327", cursor: pasteText.trim() ? "pointer" : "not-allowed", padding: "6px 12px" }}>
                    ✧ AUTOFILL FIELDS
                  </button>
                  {pasteResult && (
                    <span style={{ fontSize: 9, color: pasteResult.length ? "#a1a1aa" : "#71717a", fontFamily: "var(--nx-font-mono)" }}>
                      {pasteResult.length
                        ? `filled ${pasteResult.join(" · ")} — review below, then adjust`
                        : "couldn't read fields — fill them in manually"}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginTop: 6, letterSpacing: "0.04em" }}>
                  Best-effort read of symbol / direction / entry / stop / targets. Always confirm the numbers before saving. Full text is kept in NOTES.
                </div>
              </div>
            )}
          </div>

          {/* The full manual calculator — levels, sizing, catalyst, charts. QUICK CALL
              above is a self-contained fast path (posts a graded call on its own), so the
              detailed builder folds behind disclosure. Auto-opens when a draft (catalyst /
              notes prefilled) is in play, so the "draft this fade → thesis" flow shows its
              levels; collapsed for a fresh quick call. */}
          <Collapsible title="◆ FINE-TUNE THE CALL" subtitle="levels, sizing, catalyst, charts — for a full plan or a live order" defaultOpen={!!(form.catalyst || form.notes)} storageKey="nx_thesis_finetune">
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; INSTRUMENT</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 160px", gap: 8 }}>
              <div>
                <span style={fieldLabelStyle}>SYMBOL</span>
                <input
                  style={{ ...inputStyle, borderColor: symbolListed ? "#232327" : "#4a1e22" }}
                  placeholder="BTC, ETH, SOL..." value={form.symbol}
                  list="nexus-thesis-symbols" autoCapitalize="characters" autoComplete="off"
                  onChange={(e) => set("symbol", e.target.value)}
                />
                {marketTickers && <datalist id="nexus-thesis-symbols">{marketTickers.map((s) => <option key={s} value={s} />)}</datalist>}
                {!symbolListed && (
                  <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9.5, color: "#fbbf24", marginTop: 4, lineHeight: 1.45 }}>
                    ⚠ Not a listed market — this call can&apos;t be graded. Pick from the list.
                  </div>
                )}
              </div>
              <div>
                <span style={fieldLabelStyle}>DIRECTION</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["LONG", "SHORT"] as const).map((d) => (
                    <button key={d} onClick={() => set("direction", d)} style={{
                      flex: 1, padding: "8px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11,
                      cursor: "pointer", borderRadius: 3, border: "1px solid",
                      background: form.direction === d ? (d === "LONG" ? "#1a1a1e" : "#241012") : "#0f0f11",
                      borderColor: form.direction === d ? (d === "LONG" ? "#3ecf8e" : "#f7525f") : "#232327",
                      color: form.direction === d ? (d === "LONG" ? "#3ecf8e" : "#f7525f") : "#52525b",
                    }}>{d === "LONG" ? "↑ LONG" : "↓ SHORT"}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; PRICE LEVELS</div>
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
                    style={{ ...inputStyle, borderColor: key === "stopLoss" ? "#4a1e22" : key.startsWith("take") ? "#232327" : "#232327" }}
                    type="number" placeholder={placeholder}
                    value={form[key as keyof typeof form] as string}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </div>
              ))}
            </div>
            {/* Guided quick-fill: anchor entry to the live mark, then snap stop/target */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 10 }}>
              {(() => {
                const chip = (extra?: React.CSSProperties): React.CSSProperties => ({
                  fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "5px 9px", borderRadius: 3,
                  border: "1px solid #232327", background: "#0a0a0b", color: "#71717a", cursor: "pointer", ...extra,
                });
                const hasEntry = parseFloat(form.entryPrice) > 0;
                const hasStop = parseFloat(form.stopLoss) > 0;
                return (
                  <>
                    <button onClick={fillEntryFromMark} disabled={!form.symbol || markBusy}
                      title="Fill entry with the current mark price"
                      style={chip({ color: form.symbol ? "#d4d4d8" : "#33333a", borderColor: "#33333a", cursor: form.symbol ? "pointer" : "not-allowed" })}>
                      {markBusy ? "…" : "⟳ ENTRY = MARK"}
                    </button>
                    <span style={{ fontSize: 8, color: "#33333a", fontFamily: "var(--nx-font-mono)", marginLeft: 4 }}>STOP</span>
                    {[1, 2, 5].map((p) => (
                      <button key={p} onClick={() => applyStopPct(p)} disabled={!hasEntry}
                        title={`Stop ${p}% ${form.direction === "LONG" ? "below" : "above"} entry`}
                        style={chip({ color: hasEntry ? "#f7525f" : "#52525b", borderColor: "#4a1e22", cursor: hasEntry ? "pointer" : "not-allowed" })}>
                        −{p}%
                      </button>
                    ))}
                    <span style={{ fontSize: 8, color: "#33333a", fontFamily: "var(--nx-font-mono)", marginLeft: 4 }}>TP</span>
                    {[1, 2, 3].map((r) => (
                      <button key={r} onClick={() => applyTpR(r)} disabled={!hasEntry || !hasStop}
                        title={`Target at ${r}× the entry→stop risk`}
                        style={chip({ color: hasEntry && hasStop ? "#ededf0" : "#33333a", borderColor: "#232327", cursor: hasEntry && hasStop ? "pointer" : "not-allowed" })}>
                        {r}R
                      </button>
                    ))}
                  </>
                );
              })()}
            </div>
            {planWarnings.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {planWarnings.map((msg, i) => (
                  <div key={i} style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9.5, color: "#fbbf24", lineHeight: 1.45 }}>⚠ {msg}</div>
                ))}
              </div>
            )}
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; RISK + FUNDING</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr", gap: 8 }}>
              <div>
                <span style={fieldLabelStyle}>ACCOUNT SIZE (USDC)</span>
                <input style={inputStyle} type="number" placeholder="10000" value={form.accountSize} onChange={(e) => set("accountSize", e.target.value)} />
                {Number(availableBalance) > 0 && (
                  <button
                    onClick={() => set("accountSize", String(Math.floor(Number(availableBalance))))}
                    title="Use your connected Orderly free collateral"
                    style={{ marginTop: 5, fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "4px 8px", borderRadius: 3, border: "1px solid #33333a", background: "#0a0a0b", color: "#d4d4d8", cursor: "pointer" }}
                  >
                    = MY COLLATERAL (${Math.floor(Number(availableBalance)).toLocaleString()})
                  </button>
                )}
              </div>
              <div>
                <span style={fieldLabelStyle}>RISK %</span>
                <input style={inputStyle} type="number" placeholder="1.5" step="0.1" value={form.riskPercent} onChange={(e) => set("riskPercent", e.target.value)} />
              </div>
              <div>
                <span style={fieldLabelStyle}>FUNDING RATE (% per 8h)</span>
                <input
                  style={{ ...inputStyle, borderColor: fundingIsPositive ? "#232327" : "#4a1e22", color: fundingIsPositive ? "#3ecf8e" : "#f7525f" }}
                  type="number" placeholder="0.01" step="0.001"
                  value={form.fundingRate} onChange={(e) => set("fundingRate", e.target.value)}
                />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: 4 }}>
                  <span style={{ fontSize: 9, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>
                    {fundingIsPositive ? "longs pay shorts" : "shorts pay longs"}
                  </span>
                  <button onClick={fillFundingFromLive} disabled={!form.symbol || fundingBusy}
                    title="Fill with the current live 8h funding rate"
                    style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "3px 7px", borderRadius: 3, border: "1px solid #33333a", background: "#0a0a0b", color: form.symbol ? "#d4d4d8" : "#33333a", cursor: form.symbol ? "pointer" : "not-allowed" }}>
                    {fundingBusy ? "…" : "⟳ LIVE"}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 8 }}>&#9632; THESIS / REASONING</div>
            <textarea
              style={{ ...inputStyle, height: 80, resize: "none" }}
              placeholder="Why are you taking this trade? What needs to be true for it to work? What invalidates it?"
              value={form.notes} onChange={(e) => set("notes", e.target.value)}
            />

            {/* Signal framing — a thesis becomes a "Signal" when it names the near-term
                CATALYST (why now) and a defined EXIT WINDOW (when you'll know). Both
                optional; they sharpen the call and surface on Proof of Edge. */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 8, marginTop: 10, alignItems: "end" }}>
              <div>
                <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>⚡ CATALYST <span style={{ color: "#33333a" }}>(why now · optional)</span></div>
                <input
                  style={inputStyle} type="text"
                  placeholder="the near-term trigger — e.g. CPI Thu, funding reset, range breakout"
                  value={form.catalyst} onChange={(e) => set("catalyst", e.target.value)}
                />
              </div>
              <div>
                <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>⌛ EXIT BY <span style={{ color: "#33333a" }}>(optional)</span></div>
                <input
                  style={inputStyle} type="text"
                  placeholder="7D · 48h · FOMC"
                  value={form.targetWindow} onChange={(e) => set("targetWindow", e.target.value)}
                />
              </div>
            </div>

            {/* Charts — the levels are the claim, the charts are the reasoning. Traders
                usually show more than one timeframe, so this takes up to MAX_CHARTS.
                Inputs grow as you fill them rather than showing four empty boxes. */}
            <div style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", margin: "14px 0 8px" }}>
              ■ CHARTS <span style={{ color: "#33333a" }}>(optional · up to {MAX_CHARTS})</span>
            </div>
            {(() => {
              const urls = form.chartUrls;
              const filled = urls.filter((u) => u.trim()).length;
              const shown = Math.min(MAX_CHARTS, Math.max(1, filled + 1));
              const setAt = (i: number, v: string) => {
                const next = [...urls];
                next[i] = v;
                while (next.length < shown) next.push("");
                set("chartUrls", next);
              };
              // Paste a screenshot straight from the clipboard → upload → fill the URL,
              // so the trader never has to find a hosted link. Text paste falls through.
              const onPasteImage = (e: React.ClipboardEvent<HTMLInputElement>, i: number) => {
                const item = Array.from(e.clipboardData.items).find((it) => it.type.startsWith("image/"));
                if (!item) return;
                e.preventDefault();
                const file = item.getAsFile();
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) { setChartErr("Image too large — 2MB max."); return; }
                setChartErr(null); setChartBusy(i);
                (async () => {
                  try {
                    const r = await fetch(`${AGENT_API}/upload/chart`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
                    const d = await r.json();
                    if (d?.url) setAt(i, d.url); else setChartErr("Upload failed — paste a hosted link instead.");
                  } catch { setChartErr("Upload failed — paste a hosted link instead."); }
                  finally { setChartBusy(null); }
                })();
              };
              return (
                <>
                  {Array.from({ length: shown }).map((_, i) => {
                    const val = urls[i] ?? "";
                    const src = chartImageSrc(val);
                    const typed = val.trim().length > 0;
                    return (
                      <div key={i} style={{ marginBottom: 8 }}>
                        <input
                          style={inputStyle}
                          placeholder={i === 0 ? "paste a screenshot, or https://…snapshot" : `chart ${i + 1} (optional)`}
                          value={chartBusy === i ? "uploading…" : val}
                          onPaste={(e) => onPasteImage(e, i)}
                          onChange={(e) => setAt(i, e.target.value)}
                          readOnly={chartBusy === i}
                        />
                        {chartBusy === i && (
                          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9.5, color: "#a1a1aa", marginTop: 4 }}>⟳ uploading screenshot…</div>
                        )}
                        {chartErr && i === 0 && chartBusy === null && (
                          <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9.5, color: "#fbbf24", marginTop: 4, lineHeight: 1.45 }}>⚠ {chartErr}</div>
                        )}
                        {typed && !src && chartBusy !== i && (
                          <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9.5, color: "#fbbf24", marginTop: 4, lineHeight: 1.45 }}>
                            ⚠ Not a supported image link — use a {CHART_HOST_HINT} (https only). It won&apos;t be shown.
                          </div>
                        )}
                        {src && (
                          <img
                            src={src} alt={`chart ${i + 1} preview`} loading="lazy" referrerPolicy="no-referrer"
                            style={{ width: "100%", maxHeight: 170, objectFit: "contain", marginTop: 6, borderRadius: 3, border: "1px solid #232327", background: "#0a0a0b" }}
                          />
                        )}
                      </div>
                    );
                  })}
                  {filled === 0 && (
                    <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9.5, color: "#52525b", lineHeight: 1.45 }}>
                      Paste a screenshot straight into the box (Ctrl/⌘+V) and we&apos;ll host it — or drop a {CHART_HOST_HINT}.
                      In TradingView, the camera icon → &ldquo;Copy link to the chart image&rdquo;. Charts show on your call
                      in the public feed; the first one also goes on the share card.
                    </div>
                  )}
                </>
              );
            })()}
          </div>
          </Collapsible>
        </div>

        {/* Output Panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, position: isMobile ? "static" : "sticky", top: 16 }}>
          <div style={{ ...cardStyle, border: "1px solid #232327" }}>
            <div style={{ fontSize: 10, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 16 }}>&#9632; CALCULATED OUTPUT</div>
            {!calc ? (
              <>
                <div style={{ fontSize: 11, color: "#33333a", fontFamily: "var(--nx-font-mono)", textAlign: "center", padding: "20px 0" }}>
                  fill in entry, stop, tp1,<br />account size + risk %
                </div>
                {/* Shown BEFORE the form is valid on purpose — the "I need capital to
                    post a call" belief stops people before they type anything, so the
                    correction has to land in the empty state, not just at deploy time. */}
                <div style={{
                  fontFamily: "var(--nx-font-ui)", fontSize: 10.5, color: "#a1a1aa", lineHeight: 1.55,
                  padding: "8px 10px", background: "#0f0f11", border: "1px solid #232327", borderRadius: 3,
                }}>
                  <strong style={{ color: "#ededf0" }}>You don&apos;t need capital to build a record here.</strong>{" "}
                  A public thesis is graded from public price — first touch of your target vs your
                  stop — whether or not you take the trade.
                </div>
              </>
            ) : (
              <>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.08em" }}>POSITION SIZE</div>
                  <div style={{ fontSize: 28, color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>${calc.positionSize.toFixed(0)}</div>
                  <div style={{ fontSize: 10, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>usdc notional</div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.08em" }}>LEVERAGE REQUIRED</div>
                  <div style={{ fontSize: 22, fontFamily: "var(--nx-font-mono)", fontWeight: "bold", color: calc.leverage > 25 ? "#f7525f" : calc.leverage > 10 ? "#fbbf24" : "#3ecf8e" }}>
                    {calc.leverage.toFixed(1)}x
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.08em" }}>RISK AMOUNT</div>
                  <div style={{ fontSize: 18, color: "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>${calc.riskAmount.toFixed(2)}</div>
                  <div style={{ fontSize: 10, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>{form.riskPercent}% of account</div>
                </div>
                <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid #232327" }}>
                  <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.08em" }}>RISK / REWARD</div>
                  <div style={{ fontSize: 22, fontFamily: "var(--nx-font-mono)", fontWeight: "bold", color: calc.riskReward >= 2 ? "#3ecf8e" : calc.riskReward >= 1 ? "#fbbf24" : "#f7525f" }}>
                    1 : {calc.riskReward.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>
                    {calc.riskReward >= 2 ? "good setup" : calc.riskReward >= 1 ? "marginal" : "unfavorable"}
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.08em", marginBottom: 8 }}>
                    FUNDING COST ({parseFloat(form.fundingRate) >= 0 ? form.direction : form.direction === "LONG" ? "SHORT" : "LONG"} pays)
                  </div>
                  {[
                    { label: "8h", val: calc.fundingCost8h },
                    { label: "24h", val: calc.fundingCost24h },
                    { label: "72h", val: calc.fundingCost72h },
                  ].map(({ label, val }) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{label}</span>
                      <span style={{ fontSize: 13, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>${val.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
                {/* Confirmation overlay */}
                {liveConfirm && calc && (
                  <div style={{ background: "#2a1a00", border: "1px solid #fbbf24", borderRadius: 4, padding: "12px 14px", marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: "#fbbf24", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 10 }}>
                      &#9632; CONFIRM LIVE ORDER
                    </div>
                    {[
                      { label: "SYMBOL", val: `PERP_${form.symbol.toUpperCase()}_USDC` },
                      { label: "SIDE", val: form.direction, color: form.direction === "LONG" ? "#3ecf8e" : "#f7525f" },
                      { label: "ENTRY", val: `$${parseFloat(form.entryPrice).toLocaleString()}` },
                      { label: "QTY", val: (calc.positionSize / parseFloat(form.entryPrice)).toFixed(6) },
                      { label: "SIZE", val: `$${calc.positionSize.toFixed(0)} notional` },
                      { label: "STOP", val: `$${parseFloat(form.stopLoss).toLocaleString()}`, color: "#f7525f" },
                      { label: "TP1", val: `$${parseFloat(form.takeProfit1).toLocaleString()}`, color: "#ededf0" },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{label}</span>
                        <span style={{ fontSize: 10, color: color ?? "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{val}</span>
                      </div>
                    ))}
                    <div style={{ fontSize: 9, color: "#f7525f", fontFamily: "var(--nx-font-ui)", marginTop: 10, marginBottom: 10, lineHeight: 1.5 }}>
                      ⚠ REAL FUNDS. This places a live order on Orderly<br />
                      with your connected wallet. Cannot be undone.
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => setLiveConfirm(false)} style={{
                        flex: 1, padding: "8px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11,
                        cursor: "pointer", borderRadius: 3, border: "1px solid #232327",
                        background: "#0a0a0b", color: "#52525b", letterSpacing: "0.06em",
                      }}>ABORT</button>
                      <button onClick={deployLive} style={{
                        flex: 2, padding: "8px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11,
                        cursor: "pointer", borderRadius: 3, border: "1px solid #fbbf24",
                        background: "#2a1a00", color: "#fbbf24", letterSpacing: "0.08em", fontWeight: "bold",
                      }}>&#9632; CONFIRM — DEPLOY LIVE</button>
                    </div>
                  </div>
                )}

                {/* Live status feedback */}
                {liveStatus === "submitting" && (
                  <div style={{ padding: "10px 0", textAlign: "center", fontSize: 11, color: "#fbbf24", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.08em" }}>
                    &#9632; SUBMITTING TO ORDERLY...
                  </div>
                )}
                {liveStatus === "success" && (
                  <div style={{ padding: "10px 12px", background: "#141416", border: "1px solid #33333a", borderRadius: 4, fontSize: 11, color: "#ededf0", fontFamily: "var(--nx-font-mono)", marginBottom: 8 }}>
                    &#9632; ORDER LIVE — entry limit + TP/SL bracket set
                  </div>
                )}
                {liveStatus === "error" && (
                  <div style={{ padding: "10px 12px", background: "#241012", border: "1px solid #4a1e22", borderRadius: 4, marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: "#f7525f", fontFamily: "var(--nx-font-mono)" }}>&#9632; ORDER FAILED</div>
                    {liveError && <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginTop: 4 }}>{liveError}</div>}
                  </div>
                )}

                {/* The single most misunderstood thing in the product: publishing a
                    thesis PUBLIC is already the graded call. gradeCall() replays public
                    candles from createdAt — it never reads a position, fill or balance,
                    and the leaderboard's only gate is `isPublic && symbol && createdAt`.
                    So a track record costs nothing to build. Stated here because even
                    the person who built this assumed calls required capital. */}
                {!liveConfirm && liveStatus !== "submitting" && (
                  <div style={{
                    fontFamily: "var(--nx-font-ui)", fontSize: 10.5, color: "#a1a1aa",
                    lineHeight: 1.55, marginBottom: 8, padding: "8px 10px",
                    background: "#0f0f11", border: "1px solid #232327", borderRadius: 3,
                  }}>
                    <strong style={{ color: "#ededf0" }}>Publishing makes this a graded call.</strong>{" "}
                    It&apos;s scored from public price the moment you post it — first touch of your
                    target vs your stop. <strong style={{ color: "#ededf0" }}>You don&apos;t have to take
                    the trade.</strong> Save private if you&apos;d rather not be graded, or DEPLOY (LIVE)
                    to also place a real order with real funds.
                  </div>
                )}

                {/* LIVE ADVISOR — the coach speaks while the plan is still editable.
                    This is the difference between a dashboard and intelligence. */}
                {!liveConfirm && liveStatus !== "submitting" && formValid && (
                  <ThesisAdvisor
                    symbol={form.symbol}
                    direction={form.direction}
                    entryPrice={form.entryPrice}
                    stopLoss={form.stopLoss}
                    takeProfit1={form.takeProfit1}
                    riskReward={calc?.riskReward}
                    wallet={walletAddress}
                  />
                )}

                {/* Deploy buttons */}
                {!liveConfirm && liveStatus !== "submitting" && (
                  <>
                    {form.symbol && !formValid && (
                      <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#fbbf24", marginBottom: 6, lineHeight: 1.4 }}>
                        Enter valid entry, stop &amp; targets — size must be &gt; $0 (check entry ≠ stop and risk % &gt; 0).
                      </div>
                    )}
                    {/* PRIMARY action — this is the one that builds a track record. */}
                    <button onClick={publishAsCall} disabled={!formValid || publishing} style={{
                      width: "100%", padding: "10px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11,
                      cursor: formValid && !publishing ? "pointer" : "not-allowed", borderRadius: 3,
                      border: `1px solid ${formValid ? "#ededf0" : "#33333a"}`,
                      background: published ? "#1a1a1e" : formValid ? "#ededf0" : "#0f0f11",
                      color: published ? "#ededf0" : formValid ? "#0a0a0b" : "#33333a",
                      fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      {published ? "◆ PUBLISHED — NOW GRADED" : publishing ? "PUBLISHING…" : "◆ PUBLISH AS CALL"}
                    </button>
                    <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9.5, color: "#52525b", lineHeight: 1.45, marginBottom: 8 }}>
                      Publishing registers the call on-chain (one wallet signature, no funds moved) and
                      starts grading it from public price. Reject the signature and it stays private.
                    </div>
                    <button onClick={saveThesis} disabled={!formValid} style={{
                      width: "100%", padding: "9px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11,
                      cursor: formValid ? "pointer" : "not-allowed", borderRadius: 3,
                      border: `1px solid ${deployed ? "#ededf0" : "#33333a"}`,
                      background: deployed ? "#1a1a1e" : "#0f0f11",
                      color: deployed ? "#ededf0" : formValid ? "#d4d4d8" : "#33333a",
                      letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      {/* NB: "&#9632;" as a JS string is NOT decoded by JSX — it rendered
                          literally on the old DEPLOY (PAPER) button. Use the character. */}
                      {deployed ? "■ SAVED (PRIVATE)" : "■ SAVE PRIVATE — NOT GRADED"}
                    </button>
                    <button
                      onClick={() => { if (formValid) setLiveConfirm(true); }}
                      disabled={!formValid || !isWalletReady}
                      style={{
                        width: "100%", padding: "9px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11,
                        cursor: formValid && isWalletReady ? "pointer" : "not-allowed", borderRadius: 3,
                        border: `1px solid ${!form.symbol || !isWalletReady ? "#52525b" : "#fbbf24"}`,
                        background: "#0a0a0b",
                        color: !form.symbol || !isWalletReady ? "#52525b" : "#fbbf24",
                        letterSpacing: "0.08em",
                      }}>
                      &#9632; DEPLOY (LIVE)
                    </button>
                    {!form.symbol && <div style={{ fontSize: 9, color: "#33333a", fontFamily: "var(--nx-font-mono)", textAlign: "center", marginTop: 6 }}>enter symbol to deploy</div>}
                    {form.symbol && !isWalletReady && <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", textAlign: "center", marginTop: 6 }}>connect wallet to deploy live</div>}
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
            <div style={{ fontSize: 10, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.12em" }}>
              &#9632; THESIS_LOG ({filteredTrades.length}/{trades.length})
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {(["ALL", ...Object.keys(STATUS_CONFIG)] as (ThesisStatus | "ALL")[]).map((f) => {
                const active = filter === f;
                const c = f !== "ALL" ? STATUS_CONFIG[f as ThesisStatus] : null;
                return (
                  <button key={f} onClick={() => setFilter(f)} style={{
                    fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "3px 9px",
                    cursor: "pointer", borderRadius: 3, letterSpacing: "0.06em",
                    border: `1px solid ${active ? (c?.border ?? "#33333a") : "#232327"}`,
                    background: active ? (c?.bg ?? "#1a1a1e") : "transparent",
                    color: active ? (c?.color ?? "#ededf0") : "#33333a",
                  }}>{f === "ALL" ? "ALL" : STATUS_CONFIG[f as ThesisStatus].label}</button>
                );
              })}
            </div>
          </div>
          {resolveList.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", border: "1px solid #33333a", background: "#111114", borderRadius: 4, padding: "9px 12px", marginBottom: 10 }}>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#d4d4d8" }}>
                ◆ {resolveList.length} call{resolveList.length === 1 ? "" : "s"} ready to resolve
                {gradedReady > 0 && <span style={{ color: "#71717a" }}> · {gradedReady} already graded by Nexus</span>}
              </span>
              {gradedReady > 0 && (
                <button onClick={syncGraded}
                  title="Sync every call Nexus has already graded from public price, and auto-fill their P&L"
                  style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "5px 12px", borderRadius: 3, border: "1px solid #3ecf8e", background: "transparent", color: "#3ecf8e", cursor: "pointer", whiteSpace: "nowrap" }}>
                  SYNC {gradedReady} GRADED →
                </button>
              )}
            </div>
          )}
          {filteredTrades.length > 0 && (
            <Coachmark storageKey="nexus_coach_directional_v1" badge="STEP 1 / 2" title="Turn a thesis into a graded trade">
              See <strong style={{ color: "#d4d4d8" }}>▶ TRADE</strong> on a thesis? That hands your exact call to the agent — it executes <strong style={{ color: "#d4d4d8" }}>your</strong> direction with full exit management, then grades the result on-chain. Your read, our rigor, trustless proof. (<strong style={{ color: "#d4d4d8" }}>⚡ AUTOMATE</strong> is different — it lets the agent pick entries from funding/OI signals.)
            </Coachmark>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filteredTrades.map((t) => (
              <ThesisCard key={t.id} t={t} onUpdate={updateTrade} onRemove={removeTrade} walletAddress={walletAddress} isMobile={isMobile} markPrice={livePrices[t.symbol] ?? null} />
            ))}
          </div>
        </div>
      )}

      {trades.length === 0 && (
        <div style={{ marginTop: 24 }}>
          <EmptyState message="no theses deployed yet" unlock="Write your first one above. Post it public and it grades itself against real price — that graded record is the only thing that ranks here." />
        </div>
      )}
    </div>
  );
}
