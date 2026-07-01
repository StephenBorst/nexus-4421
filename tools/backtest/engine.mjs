// ── Agent strategy backtest engine ───────────────────────────────────────────
// Replays a strategy config over historical candles using the REAL deployed
// logic — deriveSignal (brain) for entries, evaluateExit (exec) for exits — so
// results reflect how the live agent would actually behave, not a reimplementation.
//
// Data reality (Orderly): price OHLC + funding-rate history are available; OI
// history is NOT (only current). So oiChange is fed as 0 → CONFLUENCE / OI_ONLY
// stay inert here; MOMENTUM, MEAN_REVERSION, and FUNDING_ONLY are backtestable,
// as is the full exit toolkit (TP/SL/timeout/scale-out/trailing) on any entry.
//
// Pure + deterministic. Not deployed (dev tool), so cross-worker imports are fine.
import { deriveSignal } from "../../workers/nexus-agent-brain/logic.mjs";
import { computePnl, evaluateExit } from "../../workers/nexus-agent-exec/logic.mjs";

// candles: [{ t(sec), o, h, l, c }] ascending. fundingAt(tsSec) → funding rate
// (decimal) most recent at/before ts. config: an agent config (same shape the
// brain/exec consume). Returns aggregate stats + the trade list.
export function runBacktest(candles, fundingAt, config) {
  const trades = [];
  let pos = null;
  let lastExitIdx = -Infinity;
  const cooldownBars = Number.isFinite(config.cooldownBars) ? config.cooldownBars : 1;

  const openTrade = (direction, price, t) => ({
    direction, entry: price, entryT: t, entryIdx: null,
    remaining: 1, realized: 0, // fraction of position + accumulated pnl% (size-weighted)
    state: {
      tpPercent: config.tpPercent, slPercent: config.slPercent,
      takeProfits: config.takeProfits, tp_hits: [], peak_pnl_pct: 0,
    },
  });

  const record = (p, exitPrice, reason, exitT) => {
    // Close the remaining fraction at exitPrice, add to size-weighted pnl%.
    const { pnlPct } = computePnl(p.direction, p.entry, exitPrice, 1);
    const total = p.realized + pnlPct * p.remaining;
    trades.push({ direction: p.direction, entry: p.entry, exit: exitPrice, reason, pnlPct: total, holdH: (exitT - p.entryT) / 3600 });
  };

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];

    if (pos) {
      const holdMs = (c.t - pos.entryT) * 1000;
      const adv = pos.direction === "LONG" ? c.l : c.h; // worst-for-position first
      const fav = pos.direction === "LONG" ? c.h : c.l;
      let closed = false;
      // Evaluate at adverse extreme, favorable extreme, then close (conservative,
      // mirrors first-touch SL-before-TP grading).
      for (const px of [adv, fav, c.c]) {
        const { pnlPct } = computePnl(pos.direction, pos.entry, px, 1);
        const action = evaluateExit(pos.state, pnlPct, holdMs, config);
        if (!action) continue;
        if (action.type === "TRAIL_UPDATE") {
          pos.state.peak_pnl_pct = action.peak; pos.state.trail_stop = action.trailStop;
        } else if (action.type === "PARTIAL_TP") {
          // Bank this slice at the favorable extreme, keep the runner.
          const slicePnl = pnlPct; // pnl at this price
          pos.realized += slicePnl * (action.sizePct / 100);
          pos.remaining -= action.sizePct / 100;
          pos.state.tp_hits = [...pos.state.tp_hits, action.level];
          if (pos.remaining <= 1e-9) { record(pos, px, "TP", c.t); pos = null; closed = true; break; }
        } else if (action.type === "FULL_CLOSE") {
          record(pos, px, action.reason, c.t); pos = null; closed = true; break;
        }
      }
      if (closed) { lastExitIdx = i; continue; }
      if (pos) continue; // still holding — no new entry this bar
    }

    if (!pos && (i - lastExitIdx) > cooldownBars) {
      const priceChange = (c.c - prev.c) / prev.c;
      const raw = { priceChange, oiChange: 0, fundingRate: fundingAt(c.t) || 0, hasPrev: true };
      const sig = deriveSignal(raw, config);
      if (sig.direction && sig.direction !== "NONE" && (sig.confidence ?? 0) >= 50) {
        pos = openTrade(sig.direction, c.c, c.t);
      }
    }
  }

  return aggregate(trades, config);
}

export function aggregate(trades, config = {}) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlPct > 0);
  // Convert pnl% to $ using the config's per-trade notional so nets are comparable.
  const notional = (config.capitalPerTrade || 50) * (config.leverage || 1);
  let net = 0, grossWin = 0, grossLoss = 0;
  for (const t of trades) {
    const usd = (t.pnlPct / 100) * notional;
    net += usd;
    if (usd > 0) grossWin += usd; else grossLoss += Math.abs(usd);
  }
  const winRate = n ? wins.length / n : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0);
  const avgPnlPct = n ? trades.reduce((s, t) => s + t.pnlPct, 0) / n : 0;
  return {
    trades: n,
    winRate: Math.round(winRate * 1000) / 10,
    netUsd: Math.round(net * 100) / 100,
    profitFactor: Math.round(Math.min(profitFactor, 99) * 100) / 100,
    avgPnlPct: Math.round(avgPnlPct * 1000) / 1000,
    tradeList: trades,
  };
}
