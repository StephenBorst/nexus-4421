// ── The ONE H4 ATR ─────────────────────────────────────────────────────────────
// A single canonical "H4 (4-hour) ATR-14 as a fraction of the last close", shared by BOTH
// the Lab's live stop (h4AtrPct, off Orderly tv/history) and the research harness's grade
// (atrPctH4At, off candle:hist) so the stop a fade is BUILT on and the R it is GRADED in are
// literally one number — not two ATRs that drift. No period knob: H4 ATR-14 is a fixed ruler.
//
// Method (matches what the Lab BUILD IT shows): bucket hourly candles into 4-hour bars (merge
// OHLC), then a 14-period ATR over the last 15 bars (14 true ranges). TR = max(range,
// |h−prevClose|, |l−prevClose|). Needs ≥15 H4 bars (~60h of hourly candles) → else null.
//
// Input: an array of hourly candles [{ t, h, l, c }] with t in SECONDS (callers normalize —
// tv/history is already seconds; candle:hist stores ms, so divide by 1000). Pure + fail-soft.
export function h4Atr14Frac(hourly) {
  if (!Array.isArray(hourly) || hourly.length < 15) return null;
  const sorted = [...hourly].sort((a, b) => Number(a.t) - Number(b.t));
  const buckets = new Map();
  for (const c of sorted) {
    if (!c || ![c.h, c.l, c.c].every(Number.isFinite)) continue;
    const b = Math.floor(Number(c.t) / (4 * 3600)); // 4h bucket, t in seconds
    const cur = buckets.get(b);
    if (!cur) buckets.set(b, { h: c.h, l: c.l, c: c.c });
    else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; } // sorted → last close wins
  }
  const bars = [...buckets.keys()].sort((a, b) => a - b).map((k) => buckets.get(k));
  if (bars.length < 15) return null;
  const seg = bars.slice(-15); // 15 bars → 14 true ranges
  let trSum = 0;
  for (let i = 1; i < seg.length; i++) {
    trSum += Math.max(seg[i].h - seg[i].l, Math.abs(seg[i].h - seg[i - 1].c), Math.abs(seg[i].l - seg[i - 1].c));
  }
  const atr = trSum / 14;
  const px = bars[bars.length - 1].c;
  return px > 0 && Number.isFinite(atr) ? atr / px : null;
}
