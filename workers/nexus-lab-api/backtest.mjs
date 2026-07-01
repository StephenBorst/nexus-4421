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
import { computePnl, evaluateExit } from "../nexus-agent-exec/logic.mjs";

// candles: [{ t(sec), o, h, l, c }] ascending. fundingAt(tsSec) → funding rate
// (decimal) at/before ts. config: an agent config. Returns aggregate + trade list.
export function runBacktest(candles, fundingAt, config) {
  const trades = [];
  let pos = null;
  let lastExitIdx = -Infinity;
  const cooldownBars = Number.isFinite(config.cooldownBars) ? config.cooldownBars : 1;

  const openTrade = (direction, price, t) => ({
    direction, entry: price, entryT: t, remaining: 1, realized: 0,
    state: { tpPercent: config.tpPercent, slPercent: config.slPercent, takeProfits: config.takeProfits, tp_hits: [], peak_pnl_pct: 0 },
  });
  const record = (p, exitPrice, reason, exitT) => {
    const { pnlPct } = computePnl(p.direction, p.entry, exitPrice, 1);
    trades.push({ direction: p.direction, entry: p.entry, exit: exitPrice, reason, pnlPct: p.realized + pnlPct * p.remaining, holdH: (exitT - p.entryT) / 3600 });
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
      const raw = { priceChange, oiChange: 0, fundingRate: fundingAt(c.t) || 0, hasPrev: true };
      const sig = deriveSignal(raw, config);
      if (sig.direction && sig.direction !== "NONE" && (sig.confidence ?? 0) >= 50) pos = openTrade(sig.direction, c.c, c.t);
    }
  }
  return aggregate(trades, config);
}

export function aggregate(trades, config = {}) {
  const n = trades.length;
  const notional = (config.capitalPerTrade || 50) * (config.leverage || 1);
  let net = 0, grossWin = 0, grossLoss = 0, wins = 0;
  for (const t of trades) {
    const usd = (t.pnlPct / 100) * notional;
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
  return (tsSec) => { const ms = tsSec * 1000; let rate = 0; for (const row of rows) { if (row.ts <= ms) rate = row.rate; else break; } return rate; };
}

// Orchestrator: run one config across symbols, return per-symbol + combined stats.
export async function backtestConfig(config, { symbols, days }) {
  const perSymbol = [];
  let net = 0, trades = 0, wins = 0;
  for (const symbol of symbols) {
    const [candles, fundingAt] = await Promise.all([fetchCandles(symbol, days), fetchFundingAt(symbol)]);
    const r = runBacktest(candles, fundingAt, config);
    perSymbol.push({ symbol, candles: candles.length, ...r });
    net += r.netUsd; trades += r.trades; wins += Math.round((r.winRate / 100) * r.trades);
  }
  return {
    days, symbols,
    combined: { trades, winRate: trades ? Math.round((wins / trades) * 1000) / 10 : 0, netUsd: Math.round(net * 100) / 100 },
    perSymbol,
  };
}
