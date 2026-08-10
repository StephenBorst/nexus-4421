// ── The coaching loop — continuity + accountability ──────────────────────────
// The intelligence shouldn't be goldfish-memoried. When the fusion flags "your setup",
// we remember it, then measure whether the trader actually ACTED on it — did a matching
// trade land in the window after the flag. "You acted on 2 of your last 5 flagged setups"
// closes the loop between the signal and the behaviour. Honest by construction: we state
// that you traded it, never that you traded it BECAUSE of the flag. Pure + tested.

const DAY = 86400000;
const bare = (s) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
const dayOf = (ts) => Math.floor(ts / DAY);

// Append a flag, deduped to once per symbol|direction|day, pruned to 30 days, capped 40.
export function recordFlag(store, setup, now) {
  if (!setup || !setup.symbol || (setup.direction !== "LONG" && setup.direction !== "SHORT")) return store || [];
  const sym = bare(setup.symbol);
  const arr = (store || []).filter((f) => f && now - f.ts <= 30 * DAY);
  const key = `${sym}|${setup.direction}|${dayOf(now)}`;
  if (arr.some((f) => `${bare(f.symbol)}|${f.direction}|${dayOf(f.ts)}` === key)) return arr; // already today
  arr.push({ symbol: sym, direction: setup.direction, ts: now });
  return arr.slice(-40);
}

// Measure follow-through: for each flag in the last 30d, was there a matching trade
// (same bare symbol + direction) opened within windowMs after it? Returns null below
// minFlags — no coaching from a sample of one.
export function coachingInsight(flagged, trades, now, cfg = {}) {
  const windowMs = cfg.windowMs ?? 3 * DAY;
  const minFlags = cfg.minFlags ?? 3;
  const flags = (flagged || []).filter((f) => f && now - f.ts <= 30 * DAY);
  if (flags.length < minFlags) return null;
  let taken = 0, takenPnl = 0;
  for (const f of flags) {
    const match = (trades || []).find((t) =>
      t && bare(t.symbol) === bare(f.symbol) && t.direction === f.direction &&
      t.timestamp >= f.ts && t.timestamp <= f.ts + windowMs);
    if (match) { taken++; takenPnl += Number(match.pnl) || 0; }
  }
  return {
    flags: flags.length,
    taken,
    skipped: flags.length - taken,
    takenPnl: Math.round(takenPnl * 100) / 100,
    rate: Math.round((taken / flags.length) * 100),
  };
}
