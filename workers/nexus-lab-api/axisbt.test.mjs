// Tests for the axis backtest harness (event-study, no-lookahead, walk-forward).
// Run: node --test workers/nexus-lab-api/axisbt.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { hourBucket, priceByHour, forwardReturn, callPnl, fundingFadeEvents, cvdDivergenceEvents, scoreEvents, runScorecard, ema, rsi, rsiResetEvents, slopeUp, relStrength, rsiResetTrendEvents, candlesByHour, vwapAt, atrPctAt, volGrowth, volumeRotatesInto, rsValuePullbackCandleEvents, rsValuePullbackEvents, rsQuartiles, gradeEventR } from "./axisbt.mjs";

const HR = 3600 * 1000;
const BASE = 1_000_000_000_000;
const mkOi = (prices, funding = 0.0003) => prices.map((price, i) => ({ t: BASE + i * HR, price, oi: 1000 + i, funding }));
const rising = Array.from({ length: 60 }, (_, i) => 100 + i); // 100..159 monotonic

test("hourBucket: consecutive hourly timestamps step by exactly 1", () => {
  assert.equal(hourBucket(BASE + HR) - hourBucket(BASE), 1);
});

test("forwardReturn: strictly future, null on gaps (no lookahead)", () => {
  const pmap = priceByHour(mkOi([100, 110, 121]));
  assert.ok(Math.abs(forwardReturn(pmap, BASE, 1) - 0.1) < 1e-9);
  assert.ok(Math.abs(forwardReturn(pmap, BASE, 2) - 0.21) < 1e-9);
  assert.equal(forwardReturn(pmap, BASE, 5), null); // beyond the series → null, never guessed
});

test("callPnl: SHORT inverts the forward return", () => {
  assert.equal(callPnl(0.05, "LONG"), 0.05);
  assert.equal(callPnl(0.05, "SHORT"), -0.05);
});

test("fundingFadeEvents: positive funding → SHORT, negative → LONG, flat → skipped", () => {
  const cs = { oiHist: [
    { t: BASE, price: 100, funding: 0.0005 },
    { t: BASE + HR, price: 101, funding: -0.0005 },
    { t: BASE + 2 * HR, price: 102, funding: 0.00001 },
  ] };
  const ev = fundingFadeEvents(cs, null);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].side, "SHORT");
  assert.equal(ev[1].side, "LONG");
});

test("cvdDivergenceEvents: price up on sell-flow → SHORT event", () => {
  const cs = {
    oiHist: mkOi([100, 101, 102.5]), // +~1.5% into hour 2
    cvdHist: [{ t: BASE + 2 * HR, cvd: -500000, buy: 250000, sell: 750000 }],
  };
  const ev = cvdDivergenceEvents(cs, priceByHour(cs.oiHist));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].side, "SHORT");
});

test("scoreEvents: a signal that always aligns with a rising tape → PREDICTIVE", () => {
  const coinSets = [{ oiHist: mkOi(rising) }];
  const gen = (cs) => cs.oiHist.slice(0, 34).map((p) => ({ t: p.t, side: "LONG" })); // room for h=24
  const r = scoreEvents(coinSets, gen, { horizons: [4, 12, 24], minSamples: 20 });
  assert.ok(r.bestHorizon.meanBps > 0);
  assert.equal(r.bestHorizon.hitRate, 100);
  assert.equal(r.verdict, "PREDICTIVE");
});

test("scoreEvents: the same signal shorting a rising tape → NOISE", () => {
  const coinSets = [{ oiHist: mkOi(rising) }];
  const gen = (cs) => cs.oiHist.slice(0, 34).map((p) => ({ t: p.t, side: "SHORT" }));
  const r = scoreEvents(coinSets, gen, { horizons: [4, 12, 24], minSamples: 20 });
  assert.ok(r.bestHorizon.meanBps < 0);
  assert.equal(r.verdict, "NOISE");
});

test("scoreEvents: too few samples → INSUFFICIENT (never overclaims on thin data)", () => {
  const coinSets = [{ oiHist: mkOi(rising) }];
  const gen = (cs) => cs.oiHist.slice(0, 3).map((p) => ({ t: p.t, side: "LONG" }));
  const r = scoreEvents(coinSets, gen, { horizons: [4], minSamples: 20 });
  assert.equal(r.verdict, "INSUFFICIENT");
});

test("runScorecard: returns every axis, ranked, with a coin count", () => {
  const coinSets = [{ oiHist: mkOi(rising), cvdHist: [], smHist: [] }];
  const sc = runScorecard(coinSets, { horizons: [4, 12], minSamples: 20 });
  assert.equal(sc.coins, 1);
  assert.equal(sc.axes.length, 12);
  assert.ok(sc.axes.every((a) => typeof a.verdict === "string"));
  assert.ok(sc.axes.some((a) => a.name === "rs_value_pullback"));
});

test("slopeUp: true when price is above the lookback bar", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(slopeUp(up, 25, 20), true);
  assert.equal(slopeUp(up.slice().reverse(), 25, 20), false);
});

test("relStrength: outperforming BTC → positive residual; matching → ~0", () => {
  const HR2 = 3600 * 1000, B = 1_000_000_000_000;
  const mk = (arr) => arr.map((price, i) => ({ t: B + i * HR2, price }));
  const btc = mk(Array.from({ length: 30 }, (_, i) => 100 + i));       // +29%
  const strong = mk(Array.from({ length: 30 }, (_, i) => 100 + i * 2)); // +58%
  assert.ok(relStrength(strong, btc) > 0.2);
  assert.ok(Math.abs(relStrength(btc, btc)) < 0.001);
});

test("rsiResetTrendEvents: fires in trend_up; runScorecard exposes the RS universe", () => {
  const upWobble = mkOi(Array.from({ length: 260 }, (_, i) => 100 + i * 0.4 + 6 * Math.sin(i / 5)));
  assert.ok(rsiResetTrendEvents({ oiHist: upWobble }, null).length >= 0); // runs without error
  const HR3 = 3600 * 1000, B3 = 1_000_000_000_000;
  const mk = (arr, coin) => ({ coin, oiHist: arr.map((price, i) => ({ t: B3 + i * HR3, price, funding: 0, oi: 1000 })) });
  const sc = runScorecard([mk(Array.from({ length: 40 }, (_, i) => 100 + i), "BTC"), mk(Array.from({ length: 40 }, (_, i) => 100 + i * 2), "SOL")], { horizons: [4], minSamples: 20 });
  assert.ok(Array.isArray(sc.universe));
  assert.equal(sc.universe[0].coin, "SOL"); // outperformer ranks first
});

test("ema: converges toward a constant series", () => {
  const e = ema(new Array(50).fill(100), 10);
  assert.ok(Math.abs(e[e.length - 1] - 100) < 1e-6);
});

test("rsi: strong uptrend → high (>70), downtrend → low (<30)", () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const down = Array.from({ length: 40 }, (_, i) => 100 - i);
  const ru = rsi(up), rd = rsi(down);
  assert.ok(ru[ru.length - 1] > 70);
  assert.ok(rd[rd.length - 1] < 30);
});

test("rsiResetEvents: uptrend with shelf cooldowns → LONG events; pure downtrend → none", () => {
  // rising trend (above EMA50) with gentle dips that trough RSI in the 45-68 shelf
  const upWobble = mkOi(Array.from({ length: 260 }, (_, i) => 100 + i * 0.4 + 6 * Math.sin(i / 5)));
  const evUp = rsiResetEvents({ oiHist: upWobble }, null);
  assert.ok(evUp.length > 0);
  assert.ok(evUp.every((e) => e.side === "LONG"));
  const down = mkOi(Array.from({ length: 260 }, (_, i) => 260 - i * 0.4 + 6 * Math.sin(i / 5)));
  assert.equal(rsiResetEvents({ oiHist: down }, null).length, 0); // no uptrend → no continuation events
});

test("rsiResetEvents: thin history → no events", () => {
  assert.equal(rsiResetEvents({ oiHist: mkOi([100, 101, 102]) }, null).length, 0);
});

// ── Roadmap #1/#2: real candle inputs (VWAP/ATR), volume rotation, rs quartiles ──
test("candlesByHour: buckets by hour, drops bad closes", () => {
  const cbh = candlesByHour([
    { t: BASE, o: 100, h: 102, l: 98, c: 101, v: 10 },
    { t: BASE + HR, o: 101, h: 103, l: 100, c: 102, v: 20 },
    { t: BASE + 2 * HR, o: 0, h: 0, l: 0, c: 0, v: 5 }, // bad close → dropped
  ]);
  assert.equal(cbh.size, 2);
  assert.equal(cbh.get(hourBucket(BASE)).c, 101);
});

test("vwapAt: volume-weighted typical price; empty window → null", () => {
  const cbh = candlesByHour([
    { t: BASE, o: 100, h: 102, l: 98, c: 100, v: 10 },       // typ 100
    { t: BASE + HR, o: 100, h: 112, l: 108, c: 110, v: 30 }, // typ 110
  ]);
  const h1 = hourBucket(BASE + HR);
  assert.ok(Math.abs(vwapAt(cbh, h1, 2) - 107.5) < 1e-9); // (100·10 + 110·30)/40
  assert.equal(vwapAt(cbh, h1 + 50, 2), null);
});

test("atrPctAt: true ATR as a fraction of close", () => {
  const arr = Array.from({ length: 6 }, (_, i) => ({ t: BASE + i * HR, o: 100, h: 105, l: 95, c: 100, v: 1 }));
  const cbh = candlesByHour(arr);
  assert.ok(Math.abs(atrPctAt(cbh, hourBucket(BASE + 5 * HR), 4) - 0.1) < 1e-9); // TR 10 / close 100
});

test("volGrowth & volumeRotatesInto: alt volume rising faster than BTC → rotation in", () => {
  const alt = candlesByHour(Array.from({ length: 8 }, (_, i) => ({ t: BASE + i * HR, o: 100, h: 101, l: 99, c: 100, v: i < 4 ? 10 : 30 })));
  const btc = candlesByHour(Array.from({ length: 8 }, (_, i) => ({ t: BASE + i * HR, o: 100, h: 101, l: 99, c: 100, v: 20 })));
  const h = hourBucket(BASE + 7 * HR);
  assert.ok(volGrowth(alt, h, 8) > 0);
  assert.ok(Math.abs(volGrowth(btc, h, 8)) < 1e-9);
  assert.equal(volumeRotatesInto(alt, btc, h, 8), true);
  assert.equal(volumeRotatesInto(btc, alt, h, 8), false); // BTC not rotating in vs a hot alt
});

test("rsValuePullbackCandleEvents: no candles logged yet → [] (INSUFFICIENT by design)", () => {
  const cs = { coin: "SOL", oiHist: mkOi(rising) }; // no candleHist
  assert.deepEqual(rsValuePullbackCandleEvents(cs, null, { btcMap: new Map(), btcPrice: new Map() }), []);
});

test("rsQuartiles: assigns rank + quartile (Q1 strongest)", () => {
  const u = rsQuartiles([{ coin: "A", rs: 5 }, { coin: "B", rs: 4 }, { coin: "C", rs: 3 }, { coin: "D", rs: 2 }]);
  assert.equal(u[0].rsRank, 1);
  assert.equal(u[0].quartile, 1);
  assert.equal(u[3].quartile, 4);
});

test("runScorecard: candle + rotation axes registered; runs on a candle series", () => {
  const N = 200;
  const mkCS = (coin, slope, vol) => {
    const prices = Array.from({ length: N }, (_, i) => 100 + i * slope + 4 * Math.sin(i / 6));
    return {
      coin,
      oiHist: prices.map((price, i) => ({ t: BASE + i * HR, price, oi: 1000, funding: 0 })),
      candleHist: prices.map((c, i) => ({ t: BASE + i * HR, o: c, h: c * 1.01, l: c * 0.99, c, v: vol(i) })),
    };
  };
  const sc = runScorecard([mkCS("BTC", 0.2, () => 100), mkCS("SOL", 0.5, (i) => (i > N / 2 ? 200 : 50))], { horizons: [4], minSamples: 20 });
  assert.equal(sc.axes.length, 12);
  assert.ok(sc.axes.some((a) => a.name === "rs_value_pullback_candle"));
  assert.ok(sc.axes.some((a) => a.name === "rs_value_pullback_rotation"));
  assert.ok(sc.universe[0].quartile >= 1); // rs quartiles attached to the universe
});

// ── Grok #2: thesis-in-R grading at the harness (the ONE grader object) ────────
test("gradeEventR: first-touch TP → +R, SL → −1, timeout → mark-to-market, no candles → null", () => {
  const H0 = hourBucket(BASE);
  // 30 flat bars: ATR = (102−98)/100 = 0.04 → risk = 100·0.04·1.2 = 4.8; 1.5R target = 107.2, stop = 95.2
  const flat = (over = {}) => {
    const a = Array.from({ length: 30 }, (_, i) => ({ t: BASE + i * HR, o: 100, h: 102, l: 98, c: 100, v: 1 }));
    for (const [k, v] of Object.entries(over)) a[Number(k)] = { ...a[Number(k)], ...v };
    return candlesByHour(a);
  };
  assert.equal(gradeEventR(flat({ 26: { h: 108, l: 100, c: 107 } }), H0 + 25, "LONG", 100), 1.5); // TP hit
  assert.equal(gradeEventR(flat({ 26: { h: 101, l: 94, c: 95 } }), H0 + 25, "LONG", 100), -1);    // SL hit
  assert.ok(Math.abs(gradeEventR(flat(), H0 + 25, "LONG", 100)) < 1e-9);                          // never touches → ~0R
  assert.equal(gradeEventR(candlesByHour([]), H0 + 25, "LONG", 100), null);                       // no candles → null
});

test("scoreEvents: grades in R off candles — headline flips to R once enough samples", () => {
  const N = 90;
  const closes = Array.from({ length: N }, (_, i) => 100 + i);
  const oiHist = closes.map((price, i) => ({ t: BASE + i * HR, price, oi: 1000, funding: 0 }));
  const candleHist = closes.map((c, i) => ({ t: BASE + i * HR, o: c, h: c * 1.02, l: c * 0.98, c, v: 1 }));
  const gen = (cs) => cs.oiHist.slice(25, 60).map((p) => ({ t: p.t, side: "LONG" })); // 35 events past the ATR warmup
  const res = scoreEvents([{ coin: "SOL", oiHist, candleHist }], gen, { horizons: [4], minSamples: 20 });
  assert.equal(res.r.available, true);
  assert.ok(res.r.samples >= 20);
  assert.equal(res.headline, "R");            // R is the graded object once we have the samples
  assert.ok(Number.isFinite(res.r.meanR));
  assert.ok(res.r.meanR > 0);                 // a rising tape long → positive expectancy in R
});

test("scoreEvents: no candles → R unavailable, headline stays bps (unchanged legacy behavior)", () => {
  const coinSets = [{ oiHist: mkOi(rising) }];
  const gen = (cs) => cs.oiHist.slice(0, 34).map((p) => ({ t: p.t, side: "LONG" }));
  const res = scoreEvents(coinSets, gen, { horizons: [4, 12, 24], minSamples: 20 });
  assert.equal(res.r.available, false);
  assert.equal(res.headline, "bps");
  assert.equal(res.verdict, "PREDICTIVE"); // falls back to the forward-bps verdict, same as before
});

// ── Grok's frozen contract: timeout = 0, headline stats, book split, rs_quartile ──
test("gradeEventR: time-stop / no touch → exactly 0 (flat, no unrealized drift)", () => {
  const H0 = hourBucket(BASE);
  const flat = candlesByHour(Array.from({ length: 30 }, (_, i) => ({ t: BASE + i * HR, o: 100, h: 102, l: 98, c: 100, v: 1 })));
  assert.strictEqual(gradeEventR(flat, H0 + 25, "LONG", 100), 0); // never touches TP(107.2)/SL(95.2) → 0, not mark-to-market
});

test("scoreEvents: R headline carries avg_R|win and max_dd_R (Grok's scorecard row)", () => {
  const N = 90;
  const closes = Array.from({ length: N }, (_, i) => 100 + i);
  const oiHist = closes.map((price, i) => ({ t: BASE + i * HR, price, oi: 1000, funding: 0 }));
  const candleHist = closes.map((c, i) => ({ t: BASE + i * HR, o: c, h: c * 1.02, l: c * 0.98, c, v: 1 }));
  const gen = (cs) => cs.oiHist.slice(25, 60).map((p) => ({ t: p.t, side: "LONG" }));
  const res = scoreEvents([{ coin: "SOL", oiHist, candleHist }], gen, { horizons: [4], minSamples: 20 });
  assert.ok(Number.isFinite(res.r.avgRWin) && res.r.avgRWin > 0); // rising tape → wins average ~+1.5R
  assert.ok(Number.isFinite(res.r.maxDdR) && res.r.maxDdR >= 0);
});

test("scoreEvents: rs_quartile written on every RS event row from closes (not candle-gated)", () => {
  // Two coins so the cross-sectional quartile has a distribution; proxy gen carries rs.
  const HRx = 3600 * 1000, B = 1_000_000_000_000;
  const mk = (coin, slope) => {
    const prices = Array.from({ length: 220 }, (_, i) => 100 + i * slope + 3 * Math.sin(i / 7));
    return { coin, oiHist: prices.map((price, i) => ({ t: B + i * HRx, price, oi: 1000, funding: 0 })) }; // NO candleHist — proxy path
  };
  const btcCs = { coin: "BTC", oiHist: Array.from({ length: 220 }, (_, i) => ({ t: B + i * HRx, price: 100 + i * 0.2, oi: 1000, funding: 0 })) };
  // rsValuePullbackEvents needs the BTC ctx; scoreEvents builds it. Use the proxy axis gen directly.
  const res = scoreEvents([btcCs, mk("SOL", 0.6), mk("ARB", 0.4)], rsValuePullbackEvents, { horizons: [4], minSamples: 5 });
  // rs_quartile is exposed even though there are NO candles (from closes) — the point of Grok #4.
  assert.ok(Array.isArray(res.rsQuartileDist));
});

test("runScorecard: D1_candle axis registered (the D0/D1 candle ablation)", () => {
  const sc = runScorecard([{ oiHist: mkOi(rising), cvdHist: [], smHist: [] }], { horizons: [4], minSamples: 20 });
  assert.ok(sc.axes.some((a) => a.name === "rs_value_pullback_candle_rsi"));
  assert.ok(sc.axes.some((a) => a.name === "rs_value_pullback_candle"));
  assert.ok(sc.axes.every((a) => Array.isArray(a.rsQuartileDist))); // every axis exposes the rs quartile dist
});
