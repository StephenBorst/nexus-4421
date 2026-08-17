// ── Strategy backtest engine (canonical) ─────────────────────────────────────
// Replays a config over historical candles using the REAL deployed logic —
// deriveSignal (brain) for entries, evaluateExit (exec) for exits — so a backtest
// reflects how the live agent would actually behave. Imported by lab-api (the
// "Test my strategy" endpoint) AND the dev runner in tools/backtest, so there is
// ONE engine and it can't drift from production.
//
// Data reality (Orderly): price OHLC + funding-rate history exist; OI history does
// NOT (only current). So oiChange is fed as 0 → CONFLUENCE / OI_ONLY are inert here;
// MOMENTUM / MEAN_REVERSION / FUNDING_ONLY + the full exit toolkit are backtestable.
import { deriveSignal } from "../nexus-agent-brain/logic.mjs";
import { computePnl, evaluateExit, breakevenArmed, volScaledLevels } from "../nexus-agent-exec/logic.mjs";
import { percentileRank } from "./logic.mjs";

// Rolling ATR% at candle index i, from the `periods` candles BEFORE i (no lookahead).
// Mirrors the exec's live fetchAtrPct (ATR as a % of price) so a vol-scaled-stops
// backtest matches how the agent actually sets its stop at entry. Returns null when
// there isn't enough history yet → caller falls back to the fixed config stop.
export function atrPctAt(candles, i, periods = 14) {
  const start = Math.max(1, i - periods);
  if (i - start < 3) return null;
  let trSum = 0, cnt = 0;
  for (let k = start; k < i; k++) {
    const tr = Math.max(candles[k].h - candles[k].l, Math.abs(candles[k].h - candles[k - 1].c), Math.abs(candles[k].l - candles[k - 1].c));
    if (Number.isFinite(tr)) { trSum += tr; cnt++; }
  }
  const lastClose = candles[i - 1].c;
  return cnt && lastClose > 0 ? (trSum / cnt / lastClose) * 100 : null;
}

// Build a NO-LOOKAHEAD funding-percentile lookup from raw funding rows
// ([{ts(ms), rate}]). At candle time t it ranks the current rate against only the
// funding history that existed at/before t — so a backtest can test the adaptive
// funding-percentile filter honestly (no peeking at the future).
export function makeFundingPctAt(rows) {
  const sorted = [...(rows || [])].sort((a, b) => a.ts - b.ts);
  return (tsSec, rate) => {
    const cutoff = tsSec * 1000;
    const past = [];
    for (const r of sorted) { if (r.ts <= cutoff) past.push(r.rate); else break; }
    return percentileRank(past, rate);
  };
}

// Build a NO-LOOKAHEAD OI-change lookup from the brain's recorded oi:hist series
// ([{ t(ms), price, oi, funding }], hourly). At candle time t it returns the
// FRACTIONAL OI change (decimal, e.g. 0.02 = +2%) from the previous recorded
// sample to the sample at/before t — the hourly OI delta, matching the hourly
// priceChange the engine already uses (both over the same bar). Returns null when
// fewer than two samples exist at/before t (→ engine treats OI as absent, so
// CONFLUENCE/OI_ONLY simply don't fire there — honest, no fabricated divergence).
// This is what unlocks CONFLUENCE/OI_ONLY backtests once oi:hist has matured.
export function makeOiChangeAt(rows) {
  const sorted = [...(rows || [])].filter((r) => Number.isFinite(r?.oi) && r.oi > 0).sort((a, b) => a.t - b.t);
  return (tsSec) => {
    const cutoff = tsSec * 1000;
    let prev = null, cur = null;
    for (const r of sorted) {
      if (r.t <= cutoff) { prev = cur; cur = r; } else break;
    }
    if (!cur || !prev || !(prev.oi > 0)) return null;
    return (cur.oi - prev.oi) / prev.oi;
  };
}

// Coverage summary of an oi:hist series — how many samples and how many days it
// spans. The backtest maturity-gate uses this to decide whether CONFLUENCE/OI_ONLY
// are testable yet (they need enough recorded OI history; funding+price come from
// Orderly and are always rich).
export function oiSeriesInfo(rows) {
  const s = (rows || []).filter((r) => Number.isFinite(r?.oi) && r.oi > 0).sort((a, b) => a.t - b.t);
  if (s.length < 2) return { samples: s.length, days: 0 };
  return { samples: s.length, days: Math.round((s[s.length - 1].t - s[0].t) / 86400000) };
}

// candles: [{ t(sec), o, h, l, c }] ascending. fundingAt(tsSec) → funding rate
// (decimal) at/before ts. oiChangeAt(tsSec) → fractional OI change (or null) —
// pass it to make CONFLUENCE/OI_ONLY testable; omit for funding/price-only modes.
// config: an agent config. Returns aggregate + trade list.
// entryFilter (optional): (candles, i, sig, config) => boolean. A no-lookahead gate
// applied AFTER deriveSignal fires — returns false to SUPPRESS an otherwise-valid
// entry. This is the conditioning hook: it lets research test "the signal only works
// in <regime/session/vol>" without changing the signal itself. Default null = no gate,
// so every existing caller (lab-api endpoints) is byte-for-byte unchanged.
export function runBacktest(candles, fundingAt, config, fundingPctAt = null, oiChangeAt = null, entryFilter = null) {
  const trades = [];
  let pos = null;
  let lastExitIdx = -Infinity;
  const cooldownBars = Number.isFinite(config.cooldownBars) ? config.cooldownBars : 1;

  const openTrade = (direction, price, t, lvl = null) => ({
    direction, entry: price, entryT: t, remaining: 1, realized: 0,
    // Vol-scaled stops (opt-in) override the single tp/sl per-position; an explicit
    // takeProfits ladder still takes over TP — exactly matching the live exec, which
    // vol-scales the SL + single-TP fallback but passes config.takeProfits through.
    state: {
      tpPercent: lvl ? lvl.tpPercent : config.tpPercent,
      slPercent: lvl ? lvl.slPercent : config.slPercent,
      takeProfits: config.takeProfits, tp_hits: [], peak_pnl_pct: 0,
    },
  });
  const record = (p, exitPrice, reason, exitT) => {
    const { pnlPct } = computePnl(p.direction, p.entry, exitPrice, 1);
    trades.push({ direction: p.direction, entry: p.entry, exit: exitPrice, reason, pnlPct: p.realized + pnlPct * p.remaining, holdH: (exitT - p.entryT) / 3600, entryT: p.entryT });
  };

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    if (pos) {
      const holdMs = (c.t - pos.entryT) * 1000;
      const adv = pos.direction === "LONG" ? c.l : c.h;
      const fav = pos.direction === "LONG" ? c.h : c.l;
      let closed = false;
      for (const px of [adv, fav, c.c]) {
        const { pnlPct } = computePnl(pos.direction, pos.entry, px, 1);
        pos.state.be_armed = breakevenArmed(pos.state, pnlPct, config.breakevenTriggerPct);
        const action = evaluateExit(pos.state, pnlPct, holdMs, config);
        if (!action) continue;
        if (action.type === "TRAIL_UPDATE") {
          pos.state.peak_pnl_pct = action.peak; pos.state.trail_stop = action.trailStop;
        } else if (action.type === "PARTIAL_TP") {
          pos.realized += pnlPct * (action.sizePct / 100);
          pos.remaining -= action.sizePct / 100;
          pos.state.tp_hits = [...pos.state.tp_hits, action.level];
          if (pos.remaining <= 1e-9) { record(pos, px, "TP", c.t); pos = null; closed = true; break; }
        } else if (action.type === "FULL_CLOSE") {
          record(pos, px, action.reason, c.t); pos = null; closed = true; break;
        }
      }
      if (closed) { lastExitIdx = i; continue; }
      if (pos) continue;
    }
    if (!pos && (i - lastExitIdx) > cooldownBars) {
      const priceChange = (c.c - prev.c) / prev.c;
      // OI change from the recorded series when available (null → 0, so the OI
      // rule / CONFLUENCE stays inert exactly where we have no history).
      const oiChange = oiChangeAt ? (oiChangeAt(c.t) ?? 0) : 0;
      const raw = { priceChange, oiChange, fundingRate: fundingAt(c.t) || 0, hasPrev: true };
      if (fundingPctAt && (config.fundingPercentileMin || 0) > 0) raw.fundingPct = fundingPctAt(c.t, raw.fundingRate);
      const sig = deriveSignal(raw, config);
      if (sig.direction && sig.direction !== "NONE" && (sig.confidence ?? 0) >= 50
          && (!entryFilter || entryFilter(candles, i, sig, config))) {
        // Vol-scaled stops: size the stop to recent ATR at entry (no lookahead),
        // preserving the configured reward:risk. Falls back to fixed when ATR unavailable.
        let lvl = null;
        if (config.volScaledStops) {
          const atrPct = atrPctAt(candles, i);
          if (Number.isFinite(atrPct) && atrPct > 0) lvl = volScaledLevels(atrPct, config);
        }
        pos = openTrade(sig.direction, c.c, c.t, lvl);
      }
    }
  }
  // Attach the per-trade detail (entryT + %) so a walk-forward validator can bucket
  // REAL trades by entry time — no fold-boundary artifacts. Additive; existing callers
  // read the summary fields and ignore _trades.
  return { ...aggregate(trades, config), _trades: trades };
}

export function aggregate(trades, config = {}) {
  const n = trades.length;
  const notional = (config.capitalPerTrade || 50) * (config.leverage || 1);
  // Optional cost model: a taker fee per side (config.feeBps, e.g. 3 = 0.03%).
  // A round trip = entry + exit ≈ 2× → deducted from each trade's % return so the
  // net reflects real trading costs. (Conservative: ignores funding RECEIVED while
  // fading, which is a tailwind for this strategy — so real edge ≥ this.)
  const feePct = ((config.feeBps || 0) / 100) * 2;
  let net = 0, grossWin = 0, grossLoss = 0, wins = 0;
  for (const t of trades) {
    const usd = ((t.pnlPct - feePct) / 100) * notional;
    net += usd;
    if (usd > 0) { grossWin += usd; wins++; } else { grossLoss += Math.abs(usd); }
  }
  return {
    trades: n,
    winRate: n ? Math.round((wins / n) * 1000) / 10 : 0,
    netUsd: Math.round(net * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round(Math.min(grossWin / grossLoss, 99) * 100) / 100 : (grossWin > 0 ? 99 : 0),
    avgPnlPct: n ? Math.round((trades.reduce((s, t) => s + t.pnlPct, 0) / n) * 1000) / 1000 : 0,
  };
}

// ── Data loading (Cloudflare-Worker + node compatible via global fetch) ──────
const ORDERLY = "https://api-evm.orderly.org";

export async function fetchCandles(symbol, days) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 86400;
  const out = [];
  let cursor = from;
  const step = 20 * 86400;
  while (cursor < now) {
    const to = Math.min(cursor + step, now);
    const r = await fetch(`${ORDERLY}/tv/history?symbol=${symbol}&resolution=60&from=${cursor}&to=${to}`);
    const d = await r.json();
    if (d && d.s === "ok" && Array.isArray(d.t)) for (let i = 0; i < d.t.length; i++) out.push({ t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i] });
    cursor = to;
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.t) ? false : seen.add(c.t))).sort((a, b) => a.t - b.t);
}

export async function fetchFundingAt(symbol) {
  const rows = [];
  for (let page = 1; page <= 3; page++) {
    const r = await fetch(`${ORDERLY}/v1/public/funding_rate_history?symbol=${symbol}&page=${page}&size=100`);
    const d = await r.json();
    const rs = d?.data?.rows || [];
    rows.push(...rs.map((x) => ({ ts: x.funding_rate_timestamp, rate: x.funding_rate })));
    if (rs.length < 100) break;
  }
  rows.sort((a, b) => a.ts - b.ts);
  const at = (tsSec) => { const ms = tsSec * 1000; let rate = 0; for (const row of rows) { if (row.ts <= ms) rate = row.rate; else break; } return rate; };
  return { at, rows };
}

// Realistic taker fee (bps/side) applied to every user-facing backtest so results
// are honest by default. Verified the Proven-Edge config survives it with margin.
const DEFAULT_FEE_BPS = 3;

// Sweep: fetch each symbol's data ONCE, then run a grid of backtestable configs
// (mode × threshold × exit style) reusing that data, ranked by net P&L. This is the
// terminal sweep, in-app. Bounded (~36 configs) to stay within a request's budget.
export async function runSweep(base, { symbols, days }, oiHistBySymbol = {}) {
  const data = {};
  for (const s of symbols) {
    const [candles, funding] = await Promise.all([fetchCandles(s, days), fetchFundingAt(s)]);
    const oiRows = oiHistBySymbol[s];
    data[s] = {
      candles, fundingAt: funding.at, fundingPctAt: makeFundingPctAt(funding.rows),
      oiChangeAt: oiRows && oiRows.length >= 2 ? makeOiChangeAt(oiRows) : null,
    };
  }
  const EXITS = {
    "fixed tp1.5/sl0.75": { tpPercent: 1.5, slPercent: 0.75 },
    "scale-out 1/2.5": { tpPercent: 1, slPercent: 1, takeProfits: [{ pct: 1, sizePct: 50 }, { pct: 2.5, sizePct: 50 }] },
    "trail 0.5": { tpPercent: 1.5, slPercent: 0.75, trailingStopPct: 0.5 },
  };
  const common = { leverage: base.leverage || 5, capitalPerTrade: base.capitalPerTrade || 50, maxHoldHours: base.maxHoldHours || 4, oiChangeThreshold: 0, feeBps: DEFAULT_FEE_BPS };
  // Only fold the OI-driven modes (CONFLUENCE / OI_ONLY) into the grid when EVERY
  // symbol has usable recorded OI — otherwise they'd contribute empty rows. The
  // endpoint only passes oiHistBySymbol once it's judged mature, so this lights up
  // the flagship CONFLUENCE in discovery exactly when the data can back it.
  const oiReady = symbols.length > 0 && symbols.every((s) => data[s].oiChangeAt);
  const configs = [];
  for (const [exName, ex] of Object.entries(EXITS)) {
    for (const p of [0.3, 0.5, 0.8]) for (const mode of ["MOMENTUM", "MEAN_REVERSION"]) configs.push({ name: `${mode} · p${p} · ${exName}`, config: { ...common, ...ex, signalMode: mode, priceChangeThreshold: p } });
    for (const f of [0.005, 0.01, 0.02]) configs.push({ name: `FUNDING_ONLY · f${f} · ${exName}`, config: { ...common, ...ex, signalMode: "FUNDING_ONLY", fundingThreshold: f } });
    // The adaptive funding-PERCENTILE filter — the only net-positive family found.
    for (const pctMin of [90, 95]) configs.push({ name: `FUNDING · f0.01 · pct${pctMin} · ${exName}`, config: { ...common, ...ex, signalMode: "FUNDING_ONLY", fundingThreshold: 0.01, fundingPercentileMin: pctMin } });
    if (oiReady) {
      configs.push({ name: `CONFLUENCE · f0.01 · ${exName}`, config: { ...common, ...ex, signalMode: "CONFLUENCE", fundingThreshold: 0.01 } });
      configs.push({ name: `OI_ONLY · ${exName}`, config: { ...common, ...ex, signalMode: "OI_ONLY" } });
    }
  }
  const results = configs.map(({ name, config }) => {
    let net = 0, trades = 0, wins = 0;
    for (const s of symbols) {
      const r = runBacktest(data[s].candles, data[s].fundingAt, config, data[s].fundingPctAt, data[s].oiChangeAt);
      net += r.netUsd; trades += r.trades; wins += Math.round((r.winRate / 100) * r.trades);
    }
    // Include the strategy-defining params so the UI can one-click APPLY a winner.
    const applied = {
      signalMode: config.signalMode, priceChangeThreshold: config.priceChangeThreshold,
      fundingThreshold: config.fundingThreshold, fundingPercentileMin: config.fundingPercentileMin || 0,
      oiChangeThreshold: config.oiChangeThreshold || 0,
      tpPercent: config.tpPercent, slPercent: config.slPercent,
      takeProfits: config.takeProfits || null, trailingStopPct: config.trailingStopPct || 0,
    };
    return { name, trades, winRate: trades ? Math.round((wins / trades) * 1000) / 10 : 0, netUsd: Math.round(net * 100) / 100, config: applied };
  }).sort((a, b) => b.netUsd - a.netUsd);
  return { days, symbols, notional: common.capitalPerTrade * common.leverage, results };
}

// Orchestrator: run one config across symbols, return per-symbol + combined stats.
// oiHistBySymbol (optional) = { symbol: [{t(ms),price,oi,funding}] } from the brain's
// recorded oi:hist — pass it to make CONFLUENCE/OI_ONLY testable (the endpoint reads
// it from KV and gates on maturity first).
export async function backtestConfig(config, { symbols, days }, oiHistBySymbol = {}) {
  const perSymbol = [];
  let net = 0, trades = 0, wins = 0;
  for (const symbol of symbols) {
    const [candles, funding] = await Promise.all([fetchCandles(symbol, days), fetchFundingAt(symbol)]);
    const oiRows = oiHistBySymbol[symbol];
    const oiChangeAt = oiRows && oiRows.length >= 2 ? makeOiChangeAt(oiRows) : null;
    const r = runBacktest(candles, funding.at, { feeBps: DEFAULT_FEE_BPS, ...config }, makeFundingPctAt(funding.rows), oiChangeAt);
    const { _trades, ...summary } = r; // don't leak the full trade list into the API response
    perSymbol.push({ symbol, candles: candles.length, ...summary });
    net += r.netUsd; trades += r.trades; wins += Math.round((r.winRate / 100) * r.trades);
  }
  return {
    days, symbols,
    combined: { trades, winRate: trades ? Math.round((wins / trades) * 1000) / 10 : 0, netUsd: Math.round(net * 100) / 100 },
    perSymbol,
  };
}

// Bucket a backtest's REAL closed trades into `folds` sequential windows by ENTRY time
// (no boundary artifacts) and return per-fold net$ + counts. Fees applied here.
export function foldsByEntry(res, candles, config, folds) {
  const t0 = candles[0]?.t ?? 0, tN = candles[candles.length - 1]?.t ?? 0, span = (tN - t0) / folds || 1;
  const notional = (config.capitalPerTrade || 50) * (config.leverage || 1);
  const feePct = ((config.feeBps || 0) / 100) * 2;
  const net = new Array(folds).fill(0), cnt = new Array(folds).fill(0);
  for (const t of res._trades || []) {
    const k = Math.min(folds - 1, Math.max(0, Math.floor((t.entryT - t0) / span)));
    net[k] += ((t.pnlPct - feePct) / 100) * notional; cnt[k]++;
  }
  return { net: net.map((n) => Math.round(n * 100) / 100), cnt };
}

// Assign a robustness verdict from cross-market + cross-time consistency. An edge is
// only ROBUST if it's net-positive on a majority of symbols AND in a majority of folds
// — that's what separates a real edge from a single-window overfit.
export function robustnessVerdict(posSymbols, totalSymbols, foldConsistencyPct) {
  if (posSymbols >= Math.ceil(totalSymbols / 2) && foldConsistencyPct >= 55) return "ROBUST";
  if (posSymbols >= 2 && foldConsistencyPct >= 45) return "FRAGILE";
  return "NOT_ROBUST";
}

// Walk-forward validator (the honest layer over backtestConfig): runs ONE backtest per
// symbol over `days`, buckets real trades into `folds`, and returns a cross-market +
// cross-time verdict. oiHistBySymbol makes CONFLUENCE/OI_ONLY testable (endpoint gates
// maturity). Kept lean on symbol count so it fits a Worker's subrequest budget.
export async function walkForwardValidate(config, { symbols, days, folds = 4 }, oiHistBySymbol = {}) {
  const cfg = { feeBps: DEFAULT_FEE_BPS, ...config };
  const perSymbol = [];
  let posSymbols = 0, foldPos = 0, foldTotal = 0, totNet = 0, totTrades = 0;
  for (const symbol of symbols) {
    const [candles, funding] = await Promise.all([fetchCandles(symbol, days), fetchFundingAt(symbol)]);
    const oiRows = oiHistBySymbol[symbol];
    const oiChangeAt = oiRows && oiRows.length >= 2 ? makeOiChangeAt(oiRows) : null;
    const res = runBacktest(candles, funding.at, cfg, makeFundingPctAt(funding.rows), oiChangeAt);
    const { net, cnt } = foldsByEntry(res, candles, cfg, folds);
    const symNet = Math.round(net.reduce((a, b) => a + b, 0) * 100) / 100;
    const symTrades = cnt.reduce((a, b) => a + b, 0);
    const foldsPos = net.filter((n) => n > 0).length;
    if (symNet > 0) posSymbols++;
    for (const n of net) { foldTotal++; if (n > 0) foldPos++; }
    totNet += symNet; totTrades += symTrades;
    perSymbol.push({ symbol, net: symNet, trades: symTrades, foldsPositive: foldsPos, folds: net });
  }
  const foldConsistency = foldTotal ? Math.round((foldPos / foldTotal) * 100) : 0;
  return {
    days, folds, symbols,
    verdict: robustnessVerdict(posSymbols, symbols.length, foldConsistency),
    posSymbols, totalSymbols: symbols.length, foldConsistency,
    totalNet: Math.round(totNet * 100) / 100, totalTrades: totTrades,
    perSymbol,
  };
}
