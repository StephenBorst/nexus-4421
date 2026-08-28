// ── AXIS BACKTEST HARNESS — does a read actually PREDICT? ─────────────────────
// The scientist's rig for Sept-14: for each candidate axis, take every hour it fired a
// directional signal, measure the FORWARD price return over the next N hours (strictly
// future to the signal — no lookahead), and pool across coins for statistical power.
// Reports hit-rate + mean forward return (bps) per horizon, plus a walk-forward stability
// check (first half vs second half of the sample must agree in sign). A signal is only
// "PREDICTIVE" if it clears a minimum sample AND is positive AND stable — the same
// discipline that killed the naive dials (in-sample sweeps mislead; always walk-forward).
//
// Signal generators are pure (events from stored series, using only data ≤ the signal
// hour); the CVD one REUSES the deployed classifier so the backtest scores live behavior.
// Pure + tested. Fed entirely by the self-logged series (oi/cvd/sm/stance:hist) — which is
// why it only becomes meaningful as that history matures (~Sept 14).
import { classifyCvdDivergence } from "./flow.mjs";

export function hourBucket(t) { return Math.round(Number(t) / 3600000); }

// Price spine: hour → price, from oi:hist ({t, price, oi, funding}).
export function priceByHour(oiHist) {
  const m = new Map();
  for (const p of oiHist || []) if (p && Number.isFinite(p.price) && p.price > 0) m.set(hourBucket(p.t), p.price);
  return m;
}

// Forward return over `h` hours — NO LOOKAHEAD (outcome strictly after the signal).
export function forwardReturn(pmap, t, h) {
  const h0 = hourBucket(t), p0 = pmap.get(h0), p1 = pmap.get(h0 + h);
  if (!(p0 > 0) || !(p1 > 0)) return null;
  return (p1 - p0) / p0;
}

// P&L of a directional call given the forward return.
export function callPnl(fwdRet, side) { return side === "SHORT" ? -fwdRet : fwdRet; }

// ── Signal generators: (coinSet, priceByHourMap) → [{ t, side }] ──────────────
// coinSet = { coin, oiHist, cvdHist, smHist, stanceHist, basisHist }.

// Fade the crowd: at each hour with stretched funding, take the contrarian side.
export function fundingFadeEvents(cs, _pmap, { threshold = 0.0001 } = {}) {
  const ev = [];
  for (const p of cs.oiHist || []) {
    if (!p || !Number.isFinite(p.funding) || Math.abs(p.funding) < threshold) continue;
    ev.push({ t: p.t, side: p.funding > 0 ? "SHORT" : "LONG" });
  }
  return ev;
}

// CVD divergence: prior-1h price move vs concurrent aggressor flow (reuses the classifier).
export function cvdDivergenceEvents(cs, pmap) {
  const ev = [];
  for (const c of cs.cvdHist || []) {
    if (!c) continue;
    const h0 = hourBucket(c.t), p0 = pmap.get(h0), pPrev = pmap.get(h0 - 1);
    if (!(p0 > 0) || !(pPrev > 0)) continue;
    const sig = classifyCvdDivergence(((p0 - pPrev) / pPrev) * 100, c);
    if (sig) ev.push({ t: c.t, side: sig.side });
  }
  return ev;
}

// Smart lean by hour (from sm:hist {t, side}).
function smByHour(smHist) {
  const m = new Map();
  for (const s of smHist || []) if (s && (s.side === "LONG" || s.side === "SHORT")) m.set(hourBucket(s.t), s.side);
  return m;
}

// The "one open door": the funding fade CONDITIONED on smart money agreeing.
export function smartFadeEvents(cs, _pmap, { threshold = 0.0001 } = {}) {
  const sm = smByHour(cs.smHist);
  const ev = [];
  for (const p of cs.oiHist || []) {
    if (!p || !Number.isFinite(p.funding) || Math.abs(p.funding) < threshold) continue;
    const fade = p.funding > 0 ? "SHORT" : "LONG";
    if (sm.get(hourBucket(p.t)) === fade) ev.push({ t: p.t, side: fade });
  }
  return ev;
}

// Baseline for comparison: just follow the smart-money lean.
export function smartFollowEvents(cs) {
  return (cs.smHist || []).filter((s) => s && (s.side === "LONG" || s.side === "SHORT")).map((s) => ({ t: s.t, side: s.side }));
}

// ── RSI momentum-cooldown continuation (Stoic's H4 study, done rigorously) ────
// EMA of a numeric series.
export function ema(values, period) {
  const out = []; const k = 2 / (period + 1); let prev = null;
  for (const v of values) { prev = prev == null ? v : v * k + prev * (1 - k); out.push(prev); }
  return out;
}
// Wilder's RSI(period) over closes → array aligned to closes (first `period` entries null).
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const ch = closes[i] - closes[i - 1]; if (ch >= 0) gain += ch; else loss -= ch; }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1], g = ch >= 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
// The community claim: in an uptrend, an RSI cooldown that HOLDS the ~45+ shelf then turns
// up = a long continuation; a reset that plunges BELOW 45 = the floor gives way. We test it
// with OUR discipline — the trend is measured AT the reset (price > EMA50, NO lookahead), and
// EVERY qualifying reset is scored forward (including the ones that then failed), so there is
// no survivorship bias (nico_quant's critique). The harness then grades it vs the null baseline.
// `held` true = trough in [floorMin,floorMax] (the shelf); false = trough < floorMin (deep).
export function rsiResetEvents(cs, _pmap, { emaPeriod = 50, rsiPeriod = 14, floorMin = 45, floorMax = 68, held = true } = {}) {
  const rows = (cs.oiHist || []).filter((p) => p && Number.isFinite(p.price) && p.price > 0).sort((a, b) => (a.t || 0) - (b.t || 0));
  if (rows.length < emaPeriod + rsiPeriod + 5) return [];
  const closes = rows.map((r) => r.price);
  const e = ema(closes, emaPeriod), r = rsi(closes, rsiPeriod);
  const ev = [];
  for (let i = 2; i < rows.length - 1; i++) {
    const a = r[i - 2], b = r[i - 1], c = r[i];
    if (a == null || b == null || c == null) continue;
    if (!(a > b && c > b)) continue;                 // b is a local RSI trough turning up
    const onShelf = b >= floorMin && b <= floorMax;
    if (held ? !onShelf : !(b < floorMin)) continue; // held the shelf vs plunged below it
    if (!(closes[i] > e[i])) continue;               // uptrend measured AT the reset (no lookahead)
    ev.push({ t: rows[i].t, side: "LONG" });
  }
  return ev;
}
export function rsiResetDeepEvents(cs, pmap, cfg = {}) { return rsiResetEvents(cs, pmap, { ...cfg, held: false }); }

// ── Grok's map: REGIME gate + RELATIVE STRENGTH (the universe) ────────────────
// "The map is the product; RSI is optional seasoning." Continuation events should only
// fire in a real uptrend, and only on the strong horses. These are the conditioning
// layers to run the A/B/C/D isolation (all → +regime → +RS → +value) on Sept 14.

// trend_up AT bar i, no lookahead: price > EMA50 AND a positive `slope`-bar slope.
export function slopeUp(closes, i, slope = 20) {
  if (i < slope) return false;
  return closes[i] > closes[i - slope];
}
// Relative strength of a coin vs BTC over the aligned window = its return minus BTC's
// (residual). >0 = outperforming BTC (a "fast horse"). Aligns by hour, needs overlap.
export function relStrength(coinSeries, btcSeries, { minSamples = 24 } = {}) {
  const hour = (t) => Math.round(Number(t) / 3600000);
  const cm = new Map(), bm = new Map();
  for (const p of coinSeries || []) if (p && Number.isFinite(p.price) && p.price > 0) cm.set(hour(p.t), p.price);
  for (const p of btcSeries || []) if (p && Number.isFinite(p.price) && p.price > 0) bm.set(hour(p.t), p.price);
  const hrs = [...cm.keys()].filter((h) => bm.has(h)).sort((a, b) => a - b);
  if (hrs.length < minSamples) return null;
  const c0 = cm.get(hrs[0]), c1 = cm.get(hrs[hrs.length - 1]);
  const b0 = bm.get(hrs[0]), b1 = bm.get(hrs[hrs.length - 1]);
  if (!(c0 > 0 && b0 > 0)) return null;
  return Math.round((((c1 - c0) / c0) - ((b1 - b0) / b0)) * 1000) / 1000; // residual return
}

// RSI reset held + REGIME gate (trend_up = price>EMA50 AND 20-bar slope up). Grok's "B".
export function rsiResetTrendEvents(cs, _pmap, opts = {}) {
  const { emaPeriod = 50, rsiPeriod = 14, floorMin = 45, floorMax = 68, slope = 20 } = opts;
  const rows = (cs.oiHist || []).filter((p) => p && Number.isFinite(p.price) && p.price > 0).sort((a, b) => (a.t || 0) - (b.t || 0));
  if (rows.length < emaPeriod + rsiPeriod + slope + 5) return [];
  const closes = rows.map((r) => r.price);
  const e = ema(closes, emaPeriod), r = rsi(closes, rsiPeriod);
  const ev = [];
  for (let i = 2; i < rows.length - 1; i++) {
    const a = r[i - 2], b = r[i - 1], c = r[i];
    if (a == null || b == null || c == null) continue;
    if (!(a > b && c > b) || !(b >= floorMin && b <= floorMax)) continue;
    if (!(closes[i] > e[i]) || !slopeUp(closes, i, slope)) continue; // regime: EMA50 + slope up
    ev.push({ t: rows[i].t, side: "LONG" });
  }
  return ev;
}

// ── Grok's D0/D1: RS + VALUE pullback in a regime, with the BTC hard-veto ─────
// The filter stack: universe (RS>0 vs BTC, computed BEFORE the event) → regime (price >
// EMA50 AND > a value anchor) → BTC gate (a HARD VETO — if BTC is bleeding, no alt
// continuation prints) → value tag (a pullback that's within k×vol of the value anchor).
// RSI is optional seasoning layered ON TOP (D1). ⚠️ oi:hist has no volume/OHLC, so the
// "weekly VWAP" is an SMA value anchor and "ATR" is close-to-close vol — labeled proxies;
// logging real candles is the upgrade. No lookahead: every input ends at the event bar.
export function sma(closes, period, i) {
  if (i < period - 1) return null;
  let s = 0; for (let k = i - period + 1; k <= i; k++) s += closes[k];
  return s / period;
}
export function volProxy(closes, period, i) {
  if (i < period) return null;
  let s = 0; for (let k = i - period + 1; k <= i; k++) s += Math.abs(closes[k] - closes[k - 1]);
  return s / period; // mean absolute close-to-close move ≈ an ATR proxy
}
// BTC regime map (hour → {price, ema}) so an alt event can veto on BTC bleed at its own time.
export function btcRegimeByHour(btcSeries, emaPeriod = 50) {
  const rows = (btcSeries || []).filter((p) => p && Number.isFinite(p.price) && p.price > 0).sort((a, b) => (a.t || 0) - (b.t || 0));
  const closes = rows.map((r) => r.price), e = ema(closes, emaPeriod), m = new Map();
  for (let i = emaPeriod; i < rows.length; i++) m.set(hourBucket(rows[i].t), { price: closes[i], ema: e[i], bleed: closes[i] < e[i] });
  return m;
}
export function rsValuePullbackEvents(cs, _pmap, ctx = {}, opts = {}) {
  const { emaPeriod = 50, anchorPeriod = 168, volPeriod = 24, rsLookback = 168, tagK = 1.0, rsi45 = false } = opts;
  const btcMap = ctx.btcMap, btcPrice = ctx.btcPrice; // hour→regime, hour→price
  const rows = (cs.oiHist || []).filter((p) => p && Number.isFinite(p.price) && p.price > 0).sort((a, b) => (a.t || 0) - (b.t || 0));
  if (!btcMap || !btcPrice || rows.length < Math.max(anchorPeriod, rsLookback) + 5) return [];
  const closes = rows.map((r) => r.price), e = ema(closes, emaPeriod);
  const r14 = rsi45 ? rsi(closes, 14) : null;
  const ev = [];
  for (let i = 2; i < rows.length - 1; i++) {
    const anchor = sma(closes, anchorPeriod, i), vol = volProxy(closes, volPeriod, i);
    if (anchor == null || vol == null || e[i] == null) continue;
    // regime: above EMA50 AND above the value anchor (Grok: not one or the other)
    if (!(closes[i] > e[i] && closes[i] > anchor)) continue;
    // BTC hard veto — no alt continuation while BTC bleeds (or its regime is unknown)
    const hourI = hourBucket(rows[i].t), br = btcMap.get(hourI);
    if (!br || br.bleed) continue;
    // RS BEFORE the event — residual vs BTC over the lookback ending at i
    const bNow = btcPrice.get(hourI), bThen = btcPrice.get(hourI - rsLookback);
    if (!(bNow > 0 && bThen > 0) || i - rsLookback < 0) continue;
    const rs = ((closes[i] - closes[i - rsLookback]) / closes[i - rsLookback]) - ((bNow - bThen) / bThen);
    if (!(rs > 0)) continue; // outperforming BTC
    // value tag — a pullback sitting within k×vol of the value anchor
    if (!(Math.abs(closes[i] - anchor) <= tagK * vol * 6)) continue;
    // optional RSI seasoning (D1): the reset held the 45+ shelf
    if (rsi45) { const b = r14[i]; if (b == null || b < 45) continue; }
    ev.push({ t: rows[i].t, side: "LONG" });
  }
  return ev;
}
export function rsValuePullbackRsiEvents(cs, pmap, ctx, opts = {}) { return rsValuePullbackEvents(cs, pmap, ctx, { ...opts, rsi45: true }); }

// ── Scoring: pool events across coins, aggregate forward P&L per horizon ──────
function agg(arr) {
  if (!arr.length) return { samples: 0, hitRate: 0, meanBps: 0 };
  const wins = arr.reduce((n, x) => n + (x > 0 ? 1 : 0), 0);
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  return { samples: arr.length, hitRate: Math.round((wins / arr.length) * 100), meanBps: Math.round(mean * 100000) / 10 };
}

export function scoreEvents(coinSets, signalGen, { horizons = [4, 12, 24], minSamples = 20 } = {}) {
  // BTC context (regime map + price map) for the RS/veto gens — built once, passed to every gen.
  const btcCs = (coinSets || []).find((c) => String(c.coin || "").toUpperCase() === "BTC");
  const ctx = btcCs ? { btcMap: btcRegimeByHour(btcCs.oiHist), btcPrice: priceByHour(btcCs.oiHist) } : {};
  const all = [];
  for (const cs of coinSets || []) {
    const pmap = priceByHour(cs.oiHist);
    if (pmap.size < 2) continue;
    for (const e of signalGen(cs, pmap, ctx) || []) if (e && (e.side === "LONG" || e.side === "SHORT")) all.push({ t: e.t, side: e.side, pmap });
  }
  if (!all.length) return { samples: 0, horizons: horizons.map((h) => ({ h, samples: 0, hitRate: 0, meanBps: 0, stable: false, verdict: "INSUFFICIENT" })), verdict: "INSUFFICIENT", bestHorizon: null };
  const times = all.map((e) => e.t).sort((a, b) => a - b);
  const medT = times[Math.floor(times.length / 2)];
  const horizonsOut = horizons.map((h) => {
    const pnls = [], fst = [], snd = [];
    for (const e of all) {
      const fr = forwardReturn(e.pmap, e.t, h);
      if (fr == null) continue;
      const pnl = callPnl(fr, e.side);
      pnls.push(pnl); (e.t <= medT ? fst : snd).push(pnl);
    }
    const a = agg(pnls), f = agg(fst), s = agg(snd);
    const stable = f.samples >= 5 && s.samples >= 5 && (f.meanBps > 0) === (s.meanBps > 0);
    let verdict = "INSUFFICIENT";
    if (a.samples >= minSamples) verdict = a.meanBps > 0 && stable ? "PREDICTIVE" : a.meanBps > 0 ? "PROMISING" : "NOISE";
    return { h, ...a, stable, verdict };
  });
  const bestHorizon = horizonsOut.reduce((b, x) => (x.meanBps > (b ? b.meanBps : -Infinity) ? x : b), null);
  return { samples: agg(all.map(() => 0)).samples, horizons: horizonsOut, verdict: bestHorizon ? bestHorizon.verdict : "INSUFFICIENT", bestHorizon };
}

// The full scorecard across every registered axis, ranked by best-horizon mean return.
export const AXES = [
  { name: "funding_fade", label: "Funding fade (baseline)", gen: fundingFadeEvents },
  { name: "cvd_divergence", label: "CVD divergence", gen: cvdDivergenceEvents },
  { name: "smart_fade", label: "Funding fade × smart money", gen: smartFadeEvents },
  { name: "smart_follow", label: "Follow smart money", gen: smartFollowEvents },
  { name: "rsi_reset_held", label: "RSI reset held 45+ (A: uptrend)", gen: rsiResetEvents },
  { name: "rsi_reset_trend", label: "RSI reset held + trend_up (B: +regime)", gen: rsiResetTrendEvents },
  { name: "rs_value_pullback", label: "RS + value pullback, BTC-gated (D0: no RSI)", gen: rsValuePullbackEvents },
  { name: "rs_value_pullback_rsi", label: "RS + value + RSI≥45 (D1: +RSI)", gen: rsValuePullbackRsiEvents },
  { name: "rsi_reset_deep", label: "RSI reset <45 (uptrend)", gen: rsiResetDeepEvents },
];

export function runScorecard(coinSets, cfg = {}) {
  const axes = AXES.map((a) => {
    const r = scoreEvents(coinSets, a.gen, cfg);
    return { name: a.name, label: a.label, verdict: r.verdict, best: r.bestHorizon, horizons: r.horizons };
  });
  // rank: PREDICTIVE > PROMISING > NOISE > INSUFFICIENT, then by best meanBps
  const RANK = { PREDICTIVE: 3, PROMISING: 2, NOISE: 1, INSUFFICIENT: 0 };
  axes.sort((x, y) => (RANK[y.verdict] - RANK[x.verdict]) || ((y.best ? y.best.meanBps : -1e9) - (x.best ? x.best.meanBps : -1e9)));
  // UNIVERSE — rank the coins by relative strength vs BTC (Grok's "fastest horses").
  // Surfaced so the RS filter (the C/D isolation) can be applied + shown; the map is the product.
  const btc = (coinSets || []).find((c) => String(c.coin || "").toUpperCase() === "BTC");
  const universe = btc
    ? coinSets.filter((c) => c !== btc).map((c) => ({ coin: c.coin, rs: relStrength(c.oiHist, btc.oiHist) })).filter((x) => x.rs != null).sort((a, b) => b.rs - a.rs)
    : [];
  return { axes, coins: coinSets.length, universe };
}
