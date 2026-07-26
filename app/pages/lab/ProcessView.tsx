// ═══════════════════════════════════════════════════════════════════════════
// PROCESS — the two readouts that answer "how do I get better", not "how did I do"
// ═══════════════════════════════════════════════════════════════════════════
//  REGIME EDGE      which market your edge actually lives in. Server-computed from
//                   public candles (GET /theses/process/:wallet) — trustless, same
//                   evidence as the grade, so it can be shown publicly.
//  PLAN ADHERENCE   did you trade the plan you wrote. Computed IN THE BROWSER from
//                   your own fills, which no server can see (there is no public
//                   per-trade tape on Orderly). Private coaching — never ranked.
//
// Both stay silent rather than guess: a confident insight drawn from three calls is
// worse than an empty state, because the trader will act on it.
import { useEffect, useMemo, useState } from "react";
import type { ProcessedTrade, ThesisTrade } from "./types";
import { cardStyle, labelStyle } from "./styles";
import { useIsMobile } from "./useIsMobile";
import { C, MONO, S, RADIUS } from "@/config/theme";
import { adherenceReport, ADHERENCE_LABELS } from "@/lib/adherence.mjs";
import { leakProfile, needsPostmortem, lossReason } from "@/lib/postmortem.mjs";

const AGENT_API = "https://og.nexustradinglabs.com";

// ── shared bits ──────────────────────────────────────────────────────
const hint: React.CSSProperties = { fontSize: 9, color: C.text.faint, fontFamily: MONO, lineHeight: 1.6 };

// Bucket keys → human labels. Trend/vol/alignment are the trader's language.
const BUCKET_LABEL: Record<string, string> = {
  "trend:TREND_UP": "Uptrend",
  "trend:TREND_DOWN": "Downtrend",
  "trend:CHOP": "Chop",
  "vol:CALM": "Calm",
  "vol:NORMAL": "Normal vol",
  "vol:VOLATILE": "Volatile",
  "align:WITH_TREND": "With the trend",
  "align:AGAINST_TREND": "Fighting the trend",
  "align:CHOP": "No trend",
};
const bucketLabel = (b: string) => BUCKET_LABEL[b] ?? b;

// Plan-quality flags (server side, public). Mirrors PLAN_PENALTY in lab-api logic.mjs.
const PLAN_FLAG_LABEL: Record<string, string> = {
  LATE_ENTRY: "Posted after the move",
  STOP_IN_NOISE: "Stop inside the noise",
  STOP_TOO_WIDE: "Stop too wide to be risk control",
  RR_MISMATCH: "Claimed R:R doesn't match the levels",
  BAD_LEVELS: "Malformed levels",
};

type FetchState = "idle" | "loading" | "error";
type Bucket = { bucket: string; calls: number; wins: number; rSum: number; avgR: number; hitRate: number };
type Edge = { dimension: string; best: Bucket; worst: Bucket; gapR: number } | null;
type Expectancy = { expectancy: number; profitFactor: number; tailRatio: number; avgWinR: number; avgLossR: number };
type Calibration = { highR: number; lowR: number; gap: number; highN: number; lowN: number; calibrated: boolean; inverted: boolean };
type ProcessData = {
  calls: number;
  hitRate?: number;
  avgR?: number;
  attributed?: number;
  expectancy?: Expectancy | null;
  calibration?: Calibration | null;
  regime?: Record<string, Bucket>;
  regimeEdges?: { trend: Edge; vol: Edge; align: Edge };
  discipline?: { score: number; scored: number; flagCounts: Record<string, number>; topFlag: { flag: string; count: number; rate: number } | null } | null;
};

function ScoreDial({ score }: { score: number }) {
  // Monochrome by law — amber only as CAUTION at the low end, never decoration.
  const tone = score >= 80 ? C.text.bright : score >= 55 ? C.text.fog : C.warn;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontFamily: MONO, fontSize: 28, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums" }}>{score}</span>
      <span style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint }}>/100</span>
    </div>
  );
}

function BucketRow({ b, best, worst }: { b: Bucket; best?: boolean; worst?: boolean }) {
  // R is the only chromatic signal here (green profit / red loss) — the design law.
  const tone = b.avgR > 0 ? C.pos : b.avgR < 0 ? C.neg : C.text.fog;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: "1 1 120px", minWidth: 0, fontFamily: MONO, fontSize: 11, color: C.text.fog, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {best ? "▲ " : worst ? "▼ " : ""}{bucketLabel(b.bucket)}
      </div>
      <div style={{ flexShrink: 0, fontFamily: MONO, fontSize: 10, color: C.text.faint, width: 62, textAlign: "right" }}>{b.calls} calls</div>
      <div style={{ flexShrink: 0, fontFamily: MONO, fontSize: 10, color: C.text.faint, width: 52, textAlign: "right" }}>{b.hitRate}%</div>
      <div style={{ flexShrink: 0, fontFamily: MONO, fontSize: 12, color: tone, width: 62, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {b.avgR > 0 ? "+" : ""}{b.avgR}R
      </div>
    </div>
  );
}

// ── REGIME EDGE ──────────────────────────────────────────────────────
export function RegimeEdgeCard({ wallet, data, state }: { wallet: string | null; data: ProcessData | null; state: FetchState }) {
  const isMobile = useIsMobile();
  if (!wallet || state === "error") return null;

  const edges = data?.regimeEdges;
  const edge = edges?.trend || edges?.align || edges?.vol || null;
  const buckets = Object.values(data?.regime || {});
  const trendRows = buckets.filter((b) => b.bucket.startsWith("trend:")).sort((a, b) => b.avgR - a.avgR);
  const alignRows = buckets.filter((b) => b.bucket.startsWith("align:")).sort((a, b) => b.avgR - a.avgR);
  const volRows = buckets.filter((b) => b.bucket.startsWith("vol:")).sort((a, b) => b.avgR - a.avgR);

  return (
    <div style={{ ...cardStyle, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={labelStyle}>&#9632; REGIME EDGE</div>
        <div style={{ ...hint, letterSpacing: "0.08em" }}>graded calls, split by the market they were posted into</div>
      </div>

      {state === "loading" && <div style={{ ...hint, padding: "10px 0" }}>reading your graded calls…</div>}

      {state === "idle" && !data?.calls && (
        <div style={{ ...hint, padding: "10px 0" }}>
          No resolved public calls yet. Post theses publicly and they grade themselves against public price — the regime split appears as they resolve.
        </div>
      )}

      {state === "idle" && !!data?.calls && (
        <>
          {/* The verdict. Withheld unless both regimes clear the sample + gap gate,
              because this is the line a trader will actually change behavior on. */}
          {edge ? (
            <div style={{ margin: "10px 0 14px", padding: "10px 12px", background: C.inset, border: `1px solid ${C.borderStrong}`, borderRadius: RADIUS.sm }}>
              <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 13, color: C.text.bright, lineHeight: 1.5 }}>
                Your edge lives in <strong style={{ color: C.pos }}>{bucketLabel(edge.best.bucket).toLowerCase()}</strong> ({edge.best.avgR > 0 ? "+" : ""}{edge.best.avgR}R over {edge.best.calls} calls).
                {" "}It disappears in <strong style={{ color: C.neg }}>{bucketLabel(edge.worst.bucket).toLowerCase()}</strong> ({edge.worst.avgR > 0 ? "+" : ""}{edge.worst.avgR}R over {edge.worst.calls}).
              </div>
              <div style={{ ...hint, marginTop: 6 }}>a {edge.gapR}R spread between the two — the single highest-leverage filter available to you</div>
            </div>
          ) : (
            <div style={{ ...hint, margin: "10px 0 14px", padding: "10px 12px", background: C.inset, border: `1px solid ${C.border}`, borderRadius: RADIUS.sm }}>
              No verdict yet — a regime needs 5+ resolved calls on both sides and a real gap between them before it means anything. The breakdown below is still forming.
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
            {[["TREND", trendRows], ["ALIGNMENT", alignRows], ["VOLATILITY", volRows]].map(([title, rows]) => {
              const list = rows as Bucket[];
              if (!list.length) return null;
              return (
                <div key={title as string}>
                  <div style={{ ...labelStyle, marginBottom: 2 }}>{title as string}</div>
                  {list.map((b, i) => (
                    <BucketRow key={b.bucket} b={b} best={list.length > 1 && i === 0} worst={list.length > 1 && i === list.length - 1} />
                  ))}
                </div>
              );
            })}
          </div>

          <div style={{ ...hint, marginTop: 10 }}>
            {data.attributed ?? 0} of {data.calls} resolved calls classified · regime read from the 48 hourly candles BEFORE each call, so no outcome leaks into the label · public data, recomputable by anyone
          </div>
        </>
      )}
    </div>
  );
}

// ── PLAN QUALITY (public) ────────────────────────────────────────────
// Shown next to adherence because they answer adjacent questions: was the plan
// sound, and did you follow it. This half is the one strangers can verify.
export function PlanQualityCard({ discipline }: { discipline: ProcessData["discipline"] }) {
  if (!discipline?.scored) return null;
  const flags = Object.entries(discipline.flagCounts || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ ...cardStyle, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={labelStyle}>&#9632; PLAN QUALITY</div>
        <div style={{ ...hint, letterSpacing: "0.08em" }}>public · scored at the moment each call was posted</div>
      </div>
      <div style={{ marginTop: 8 }}><ScoreDial score={discipline.score} /></div>
      <div style={{ ...hint, marginTop: 2 }}>across {discipline.scored} scored calls</div>
      {flags.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          {flags.map(([flag, count]) => (
            <div key={flag} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12, color: C.text.fog }}>{PLAN_FLAG_LABEL[flag] ?? flag}</span>
              <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 11, color: C.warn }}>{count}×</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ ...hint, marginTop: 8 }}>Every call was well-formed when posted — obtainable entry, a real stop, honest R:R.</div>
      )}
    </div>
  );
}

// ── EXPECTANCY (public) ──────────────────────────────────────────────
// What the leaderboard now RANKS on — surfaced so the number is legible, not a
// black box. Expectancy (what an average call is worth) + profit factor + tail
// concentration + the conviction-calibration read.
function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, letterSpacing: "0.12em", color: C.text.faint, fontFamily: MONO, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: tone ?? C.text.bright, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ ...hint, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

export function ExpectancyCard({ data }: { data: ProcessData | null }) {
  const e = data?.expectancy;
  const cal = data?.calibration;
  if (!e || !data?.calls) return null;
  const expTone = e.expectancy > 0 ? C.pos : e.expectancy < 0 ? C.neg : C.text.fog;
  const pfTone = e.profitFactor >= 1 ? C.pos : C.neg;

  return (
    <div style={{ ...cardStyle, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={labelStyle}>&#9632; EXPECTANCY</div>
        <div style={{ ...hint, letterSpacing: "0.08em" }}>what the board ranks on — not hit rate</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 14, marginTop: 10 }}>
        <Stat label="Expectancy" value={`${e.expectancy > 0 ? "+" : ""}${e.expectancy}R`} tone={expTone} sub="per call" />
        <Stat label="Profit factor" value={e.profitFactor >= 99 ? "∞" : `${e.profitFactor}`} tone={pfTone} sub="R won ÷ R lost" />
        <Stat label="Avg win / loss" value={`+${e.avgWinR} / −${e.avgLossR}`} sub="in R" />
        <Stat label="Tail" value={`${Math.round(e.tailRatio * 100)}%`} sub="from top 20% of wins" />
      </div>

      {/* The expectancy lesson, said plainly — this is why hit rate was the wrong
          thing to rank on. */}
      <div style={{ ...hint, marginTop: 10 }}>
        {data.hitRate != null && (
          <>Hit rate {data.hitRate}% — {data.hitRate < 50
            ? "below half, yet net-positive: the wins are big enough to carry the misses. That's the profile hit-rate ranking hides."
            : "and each call carries positive expectancy."} </>
        )}
      </div>

      {/* Conviction calibration — the "when you bet bigger, were you more right?" read. */}
      {cal && (cal.calibrated || cal.inverted) && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: C.inset, border: `1px solid ${cal.inverted ? "#4a3a00" : C.borderStrong}`, borderRadius: RADIUS.sm }}>
          <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 13, color: C.text.bright, lineHeight: 1.5 }}>
            {cal.calibrated ? (
              <>◎ <strong>Calibrated.</strong> Your higher-conviction calls average <strong style={{ color: C.pos }}>+{cal.gap}R more</strong> than your smaller ones — you size up on the right ideas.</>
            ) : (
              <>⚠ <strong style={{ color: C.warn }}>Inverted sizing.</strong> Your bigger bets average <strong style={{ color: C.neg }}>{cal.gap}R</strong> vs your smaller ones — conviction is pointing the wrong way, and it's expensive.</>
            )}
          </div>
          <div style={{ ...hint, marginTop: 6 }}>{cal.highN} high-conviction vs {cal.lowN} low, split at your median position size</div>
        </div>
      )}
    </div>
  );
}

// ── PLAN ADHERENCE (private) ─────────────────────────────────────────
export function PlanAdherenceCard({ theses, orders }: { theses: ThesisTrade[]; orders: ProcessedTrade[] }) {
  const isMobile = useIsMobile();
  const report = useMemo(() => adherenceReport(theses || [], orders || []), [theses, orders]);

  if (!theses?.length || !orders?.length) return null;

  const money = (n: number) => `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const leak = report.topLeak;
  const leakInfo = leak ? ADHERENCE_LABELS[leak.flag as keyof typeof ADHERENCE_LABELS] : null;

  return (
    <div style={{ ...cardStyle, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={labelStyle}>&#9632; PLAN ADHERENCE</div>
        <div style={{ ...hint, letterSpacing: "0.08em" }}>private · computed in your browser, never uploaded</div>
      </div>

      {!report.matched ? (
        <div style={{ ...hint, padding: "10px 0" }}>
          No theses matched to fills yet. Write a thesis before you take the trade (same market + direction, within 72h) and this scores whether you actually traded your own plan.
          {report.unmatched > 0 && <> · {report.unmatched} thesis{report.unmatched === 1 ? "" : "es"} with no matching fill</>}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "180px 1fr", gap: 16, marginTop: 8, alignItems: "start" }}>
            <div>
              <ScoreDial score={report.score ?? 0} />
              <div style={{ ...hint, marginTop: 2 }}>{report.matched} plan{report.matched === 1 ? "" : "s"} vs your fills</div>
              {report.unmatched > 0 && <div style={{ ...hint, marginTop: 4 }}>{report.unmatched} never traded</div>}
            </div>

            <div>
              {/* The dollar figure is the point. A score is abstract; "this cost you
                  $1,240" is what changes behavior. */}
              {leak && leakInfo && (
                <div style={{ padding: "10px 12px", background: C.inset, border: `1px solid ${C.borderStrong}`, borderRadius: RADIUS.sm, marginBottom: 10 }}>
                  <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 13, color: C.text.bright, lineHeight: 1.5 }}>
                    Your biggest leak is <strong>{leakInfo.label.toLowerCase()}</strong>
                    {leak.costUsd ? <> — it has cost you <strong style={{ color: C.neg }}>{money(leak.costUsd)}</strong> across {leak.count} trade{leak.count === 1 ? "" : "s"}.</> : <> — {leak.count} time{leak.count === 1 ? "" : "s"}.</>}
                  </div>
                  <div style={{ ...hint, marginTop: 6 }}>{leakInfo.why}</div>
                </div>
              )}

              {Object.entries(report.flagCounts).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([flag, count]) => {
                const info = ADHERENCE_LABELS[flag as keyof typeof ADHERENCE_LABELS];
                const cost = report.costUsd[flag];
                return (
                  <div key={flag} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12, color: C.text.fog, minWidth: 0 }}>{info?.label ?? flag}</span>
                    <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 11, color: C.text.faint }}>
                      {count as number}× {cost ? <span style={{ color: C.neg }}>· −{money(cost)}</span> : null}
                    </span>
                  </div>
                );
              })}
              {!Object.keys(report.flagCounts).length && (
                <div style={{ ...hint }}>You traded every plan the way you wrote it. That is rarer than a good win rate.</div>
              )}
            </div>
          </div>

          <div style={{ ...hint, marginTop: 10 }}>
            A win off a broken plan is a bad trade that got paid; a loss that respected its stop is a good one. Scored against your own written levels — never shown publicly, never ranked.
          </div>
        </>
      )}
    </div>
  );
}

// ── LEAK PROFILE (private) ───────────────────────────────────────────
// The postmortem payoff: across every loss you tagged, which failure mode is
// actually costing you? Ranked by dollars where recorded (a score is abstract; a
// dollar figure changes behavior). Self-reported → private, never ranked.
export function LeakProfileCard({ theses }: { theses: ThesisTrade[] }) {
  const profile = useMemo(() => leakProfile(theses || []), [theses]);
  const pending = useMemo(() => needsPostmortem(theses || []).length, [theses]);

  if (!profile.tagged && !pending) return null;
  const money = (n: number) => `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const top = profile.top ? lossReason(profile.top.reason) : null;

  return (
    <div style={{ ...cardStyle, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={labelStyle}>&#9632; LEAK PROFILE</div>
        <div style={{ ...hint, letterSpacing: "0.08em" }}>private · your own postmortems</div>
      </div>

      {!profile.tagged ? (
        <div style={{ ...hint, padding: "10px 0" }}>
          {pending} losing {pending === 1 ? "thesis" : "theses"} untagged. Tag why each one lost (one tap on the thesis card) and the pattern shows up here — the failure mode costing you the most.
        </div>
      ) : (
        <>
          {top && profile.top && (
            <div style={{ margin: "10px 0", padding: "10px 12px", background: C.inset, border: `1px solid ${C.borderStrong}`, borderRadius: RADIUS.sm }}>
              <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 13, color: C.text.bright, lineHeight: 1.5 }}>
                Your costliest pattern is <strong>{top.label.toLowerCase()}</strong>
                {profile.top.costUsd
                  ? <> — <strong style={{ color: C.neg }}>{money(profile.top.costUsd)}</strong> across {profile.top.count} {profile.top.count === 1 ? "trade" : "trades"}.</>
                  : <> — {profile.top.count} {profile.top.count === 1 ? "time" : "times"}.</>}
              </div>
              <div style={{ ...hint, marginTop: 6 }}>{top.fix}</div>
            </div>
          )}

          {Object.entries(profile.counts).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([key, count]) => {
            const r = lossReason(key);
            const cost = profile.costUsd[key];
            return (
              <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", borderBottom: `1px solid ${C.border}` }}>
                <span style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12, color: C.text.fog, minWidth: 0 }}>{r?.label ?? key}</span>
                <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 11, color: C.text.faint }}>
                  {count as number}× {cost ? <span style={{ color: C.neg }}>· −{money(cost)}</span> : null}
                </span>
              </div>
            );
          })}

          <div style={{ ...hint, marginTop: 10 }}>
            {profile.tagged} tagged{pending > 0 && <> · {pending} still untagged</>} · dollar totals only count losses where you recorded a P&L
          </div>
        </>
      )}
    </div>
  );
}

// ── section wrapper ──────────────────────────────────────────────────
export function ProcessSection({ wallet, theses, orders }: { wallet: string | null; theses: ThesisTrade[]; orders: ProcessedTrade[] }) {
  // ONE fetch for both public cards — they read different slices of the same payload.
  const [data, setData] = useState<ProcessData | null>(null);
  const [state, setState] = useState<FetchState>("idle");

  useEffect(() => {
    if (!wallet) { setData(null); return; }
    let cancelled = false;
    setState("loading");
    fetch(`${AGENT_API}/theses/process/${wallet}`)
      .then((r) => r.json())
      .then((d: ProcessData) => { if (!cancelled) { setData(d); setState("idle"); } })
      .catch(() => { if (!cancelled) setState("error"); }); // fail-soft: cards render nothing
    return () => { cancelled = true; };
  }, [wallet]);

  return (
    <div style={{ marginTop: S.lg }}>
      {state === "idle" && <ExpectancyCard data={data} />}
      <RegimeEdgeCard wallet={wallet} data={data} state={state} />
      {state === "idle" && <PlanQualityCard discipline={data?.discipline ?? null} />}
      <PlanAdherenceCard theses={theses} orders={orders} />
      <LeakProfileCard theses={theses} />
    </div>
  );
}
