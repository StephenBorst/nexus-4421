// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL READS — how you TRADE, not just what you trade
// ═══════════════════════════════════════════════════════════════════════════
// Two patterns that only your own sequenced, timestamped record can reveal —
// computed here as pure functions so the Briefing AND the Operator Profile read
// the SAME behavioral truth (no drift), and so the profile stays pure composition
// (it consumes these, it doesn't recompute them).
//
//  tiltRead        — do the trades you take right after a loss underperform? (revenge)
//  sessionEdge     — which trading session (UTC) do you actually make money in?
//  overtradingRead — do the trades AFTER your first couple each day bleed? (the "kept clicking" leak)
//
// A trade is { pnl:number, timestamp:number(ms) }. Break-even (pnl === 0) is
// treated as neither a win nor a loss. Pure + tested: node --test app/lib/behavioral.test.mjs

const wrOf = (rows) => (rows.length ? Math.round((rows.filter((t) => t.pnl > 0).length / rows.length) * 1000) / 10 : 0);

/**
 * The tilt / revenge-trade read: win rate on trades taken IMMEDIATELY after a losing
 * close vs the overall baseline. Fires only on a real sample (>= minAfter after-loss
 * trades) and when the gap is material — otherwise null (nothing honest to say).
 * @returns {{ afterLossWr, baselineWr, gapPts, n, netUsd } | null}
 */
export function tiltRead(trades, { minAfter = 5, minGapPts = 12 } = {}) {
  const list = (trades || []).filter((t) => t && Number.isFinite(t.pnl) && Number.isFinite(t.timestamp));
  if (list.length < 8) return null;
  const asc = [...list].sort((a, b) => a.timestamp - b.timestamp);
  const afterLoss = [];
  for (let i = 1; i < asc.length; i++) if (asc[i - 1].pnl < 0) afterLoss.push(asc[i]);
  if (afterLoss.length < minAfter) return null;
  const afterLossWr = wrOf(afterLoss);
  const baselineWr = wrOf(list);
  const gapPts = Math.round((baselineWr - afterLossWr) * 10) / 10;
  if (gapPts < minGapPts) return null;
  const netUsd = Math.round(afterLoss.reduce((s, t) => s + t.pnl, 0) * 100) / 100;
  return { afterLossWr, baselineWr, gapPts, n: afterLoss.length, netUsd };
}

// UTC trading sessions — coarse on purpose so buckets stay populated enough to trust.
export const SESSIONS = [
  { name: "Asia", from: 0, to: 8 },
  { name: "Europe", from: 8, to: 15 },
  { name: "US", from: 15, to: 24 },
];
const sessionOf = (ts) => {
  const h = new Date(ts).getUTCHours();
  return h < 8 ? "Asia" : h < 15 ? "Europe" : "US";
};

/**
 * The session read: which UTC session pays and which bleeds. Fires only when at least
 * two sessions have a real sample (>= minPer) AND one is net-positive while another is
 * net-negative — otherwise there's no honest "trade your hours" story. null otherwise.
 * @returns {{ best:{name,net,n,wr}, worst:{name,net,n,wr} } | null}
 */
export function sessionEdge(trades, { minPer = 4 } = {}) {
  const list = (trades || []).filter((t) => t && Number.isFinite(t.pnl) && Number.isFinite(t.timestamp));
  const m = new Map();
  for (const t of list) {
    const k = sessionOf(t.timestamp);
    const cur = m.get(k) || { name: k, net: 0, n: 0, wins: 0 };
    cur.net += t.pnl; cur.n += 1; if (t.pnl > 0) cur.wins += 1; m.set(k, cur);
  }
  const arr = [...m.values()].filter((v) => v.n >= minPer)
    .map((v) => ({ name: v.name, net: Math.round(v.net * 100) / 100, n: v.n, wr: Math.round((v.wins / v.n) * 100) }));
  if (arr.length < 2) return null;
  arr.sort((a, b) => b.net - a.net);
  const best = arr[0], worst = arr[arr.length - 1];
  if (best.name === worst.name || !(best.net > 0) || !(worst.net < 0)) return null;
  return { best, worst };
}

const utcDayKey = (ts) => { const d = new Date(ts); return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; };

/**
 * The overtrading read: within each UTC day, do the trades taken AFTER the first
 * `cutoff` underperform the disciplined early ones? The classic "I made my trade, then
 * kept clicking" leak — boredom / revenge / FOMO after the plan is done. Only your
 * sequenced, timestamped record reveals it.
 *
 * Fires only on a real excess sample (>= minExcess trades beyond the cutoff, and enough
 * disciplined trades to compare against) AND a material win-rate gap — otherwise null
 * (a trader who stops after their plan has no overtrading story, and we say nothing).
 * @returns {{ firstWr, excessWr, gapPts, excessN, firstN, excessNet, cutoff } | null}
 */
export function overtradingRead(trades, { cutoff = 2, minExcess = 5, minFirst = 5, minGapPts = 12 } = {}) {
  const list = (trades || []).filter((t) => t && Number.isFinite(t.pnl) && Number.isFinite(t.timestamp));
  if (list.length < 10) return null;
  const byDay = new Map();
  for (const t of list) {
    const k = utcDayKey(t.timestamp);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(t);
  }
  const first = [], excess = [];
  for (const day of byDay.values()) {
    day.sort((a, b) => a.timestamp - b.timestamp);
    day.forEach((t, i) => (i < cutoff ? first : excess).push(t));
  }
  if (excess.length < minExcess || first.length < minFirst) return null;
  const firstWr = wrOf(first), excessWr = wrOf(excess);
  const gapPts = Math.round((firstWr - excessWr) * 10) / 10;
  if (gapPts < minGapPts) return null;
  const excessNet = Math.round(excess.reduce((s, t) => s + t.pnl, 0) * 100) / 100;
  return { firstWr, excessWr, gapPts, excessN: excess.length, firstN: first.length, excessNet, cutoff };
}
