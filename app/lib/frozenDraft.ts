// ── The ONE frozen thesis-draft levels ───────────────────────────────────────────
// Build the frozen BUILD-IT levels — a 1.2× H4 ATR-14 stop, a 1.5R target, a 7d hold — for a
// market from live Orderly candles. The multiples come from the ONE shared R_CONTRACT and the
// ruler from the ONE shared h4Atr14Frac, so the stop a setup is BUILT on and the R it is GRADED
// in are literally one number. Used by BOTH the Catalyst card and The Board's PLAY → draft, so a
// fade drafted from either lands as the SAME object (no second schema). Returns null when the
// candles can't fill it (<~60h of history / no mark) so callers stay honest — draft nothing, or
// fall back to an entry-only prefill. Client-only (fetches tv/history).
import { h4Atr14Frac } from "@/lib/atr.mjs";
import { R_CONTRACT } from "@/lib/rContract.mjs";

export type FrozenLevels = {
  entryPrice: number;   // live mark, rounded to the market's price precision
  stopLoss: number;
  takeProfit1: number;
  riskReward: number;   // R_CONTRACT.rMultiple (1.5)
  holdDays: number;     // R_CONTRACT.maxHoldH / 24 (7)
};

// `market` is the canonical Orderly PERP id (e.g. "PERP_SOL_USDC"); `direction` the trade side.
export async function frozenLevelsFor(market: string, direction: "LONG" | "SHORT"): Promise<FrozenLevels | null> {
  const now = Math.floor(Date.now() / 1000);
  let entry = 0;
  let atrFrac: number | null = null;
  try {
    const j = await fetch(`https://api-evm.orderly.org/tv/history?symbol=${market}&resolution=60&from=${now - 100 * 3600}&to=${now}`).then((r) => r.json());
    if (j?.s === "ok" && Array.isArray(j.t) && Array.isArray(j.c) && Array.isArray(j.h) && Array.isArray(j.l)) {
      const hourly = j.t
        .map((t: number, i: number) => ({ t: Number(t), h: Number(j.h[i]), l: Number(j.l[i]), c: Number(j.c[i]) }))
        .filter((p: { c: number }) => Number.isFinite(p.c) && p.c > 0);
      if (hourly.length) entry = hourly[hourly.length - 1].c;
      atrFrac = h4Atr14Frac(hourly);
    }
  } catch { /* fall through — caller handles null */ }
  if (!(entry > 0) || atrFrac == null) return null;
  const isShort = direction === "SHORT";
  const risk = entry * R_CONTRACT.atrMult * atrFrac;
  const RR = R_CONTRACT.rMultiple;
  const dp = entry >= 1000 ? 0 : entry >= 1 ? 2 : 6;
  const round = (x: number) => Number(x.toFixed(dp));
  return {
    entryPrice: round(entry),
    stopLoss: round(isShort ? entry + risk : entry - risk),
    takeProfit1: round(isShort ? entry - RR * risk : entry + RR * risk),
    riskReward: RR,
    holdDays: R_CONTRACT.maxHoldH / 24,
  };
}
