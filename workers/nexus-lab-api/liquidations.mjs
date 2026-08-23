// ── LIVE LIQUIDATION FEED (OKX) ──────────────────────────────────────────────
// Free, public, CF-accessible (we already proxy OKX for L/S — not geo-blocked like
// Binance). OKX /public/liquidation-orders returns recent forced-closes: posSide
// (which side was liquidated), sz (contracts), bkPx (bankruptcy price), ts. We
// aggregate the flow per hour into liq:hist:{coin} — the SAME accumulate-hourly
// pattern that solved OI history (Orderly/exchanges expose no deep liq history), so
// the liquidation-flush signal becomes backtestable as the series matures, and the
// live read powers THE READ now.
//
// Semantics: posSide "long" liquidated = longs force-SOLD (a DOWN flush); "short"
// liquidated = shorts force-BOUGHT (an UP squeeze). For a funding fade (crowd long →
// fade short), a LONG-liquidation flush is the crowd capitulating = the entry window.
//
// Magnitude note: sz is in CONTRACTS and ctVal differs per instrument, but it's
// CONSTANT per symbol — so sz*bkPx is a stable relative magnitude for detecting a
// flush against that symbol's OWN history (which is all the signal needs). Not exact USD.

import { okxJson } from "./okx.mjs";

export const OKX_LIQ = "https://www.okx.com/api/v5/public/liquidation-orders";

// Our perp coin → OKX USDT-swap instFamily. OKX liquidity is deepest on USDT swaps.
export function coinToInstFamily(coin) {
  const c = String(coin || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "").replace(/_USDT$/, "");
  return c ? `${c}-USDT` : null;
}

// Pure: fold raw OKX liquidation `details` into {longMag, shortMag, count} over the
// window [sinceMs, now]. longMag = notional-ish size of LONGS liquidated (down flush),
// shortMag = SHORTS liquidated (up squeeze). Exported for tests.
export function aggregateLiquidations(details, sinceMs) {
  let longMag = 0, shortMag = 0, count = 0;
  for (const d of details || []) {
    const ts = Number(d.ts ?? d.time ?? 0);
    if (!(ts >= sinceMs)) continue;
    const sz = Math.abs(parseFloat(d.sz || "0"));
    const px = Math.abs(parseFloat(d.bkPx || "0"));
    if (!sz || !px) continue;
    const mag = sz * px;
    if (d.posSide === "long") longMag += mag;       // longs force-sold → DOWN flush
    else if (d.posSide === "short") shortMag += mag; // shorts force-bought → UP squeeze
    count++;
  }
  const round = (n) => Math.round(n);
  return { longMag: round(longMag), shortMag: round(shortMag), count };
}

// Pure: cluster liquidation events by PRICE into buckets → the recent liq "levels"
// (a heatmap-lite from real data: where forced closes actually happened). bucketPct wide
// buckets; returns the top clusters by magnitude with their dominant side. Exported for tests.
export function computeLevels(details, sinceMs, bucketPct = 0.3, topN = 4) {
  const buckets = new Map();
  for (const d of details || []) {
    const ts = Number(d.ts ?? d.time ?? 0);
    if (!(ts >= sinceMs)) continue;
    const sz = Math.abs(parseFloat(d.sz || "0")), px = Math.abs(parseFloat(d.bkPx || "0"));
    if (!sz || !px) continue;
    const key = Math.round(px / (px * bucketPct / 100)) * (px * bucketPct / 100); // snap to bucketPct-wide grid
    const b = buckets.get(key) || { price: 0, mag: 0, long: 0, short: 0 };
    b.price = key; b.mag += sz * px;
    if (d.posSide === "long") b.long += sz * px; else if (d.posSide === "short") b.short += sz * px;
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .map((b) => ({ price: Math.round(b.price), mag: Math.round(b.mag), side: b.long >= b.short ? "DOWN" : "UP" }))
    .sort((a, b) => b.mag - a.mag).slice(0, topN);
}

// ── PENDING liquidation levels (heatmap approximation) ───────────────────────
// Forward-looking "magnets" — where leveraged positions WILL be force-closed, vs the
// recent-liq levels above (where they already were). No position data (that's Coinglass-
// gated), so we APPROXIMATE the Coinglass-style heatmap: positions were opened where price
// recently traded (weighted by volume); a long opened at P liquidates ≈ P·(1−1/L), a short
// at ≈ P·(1+1/L). Project every recent bar across common leverage bands, bucket by price →
// the clusters are the magnets price tends to get pulled toward (cascade fuel). An estimate,
// clearly labeled — a heatmap-lite, not exchange truth. Pure + tested.
// candles: [{ c, h, l, v? }] recent (hourly), NEWEST-FIRST (OKX order). Returns { above,
// below } nearest big clusters. Weighting: volume × RECENCY decay — recent price zones are
// where positions most likely still sit, so they dominate the projected liq magnets (a
// position opened 2 weeks ago is more likely already closed/liquidated than one from today).
export function estimatePendingLevels(candles, currentPrice, opts = {}) {
  const { bucketPct = 0.5, rangePct = 25, topN = 5, halfLifeBars = 96, levs = [[10, 0.15], [25, 0.3], [50, 0.3], [100, 0.25]] } = opts;
  if (!Array.isArray(candles) || !candles.length || !(currentPrice > 0)) return { above: [], below: [] };
  const buckets = new Map();
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const entry = Number(c.c) || 0;
    const recency = Math.pow(0.5, i / halfLifeBars); // i=0 newest → weight 1, decays with age
    const vol = (Number(c.v) || (Number(c.h) - Number(c.l)) || 1) * recency;
    if (!(entry > 0)) continue;
    for (const [L, w] of levs) {
      for (const [liq, side] of [[entry * (1 - 1 / L), "long"], [entry * (1 + 1 / L), "short"]]) {
        if (!(liq > 0)) continue;
        if (Math.abs(liq - currentPrice) / currentPrice * 100 > rangePct) continue; // ignore far levels
        const bw = entry * bucketPct / 100;
        const key = Math.round(liq / bw) * bw;
        const b = buckets.get(key) || { price: 0, long: 0, short: 0 };
        b.price = key; if (side === "long") b.long += vol * w; else b.short += vol * w;
        buckets.set(key, b);
      }
    }
  }
  const all = [...buckets.values()].map((b) => ({ price: Math.round(b.price), mag: Math.round(b.long + b.short), side: b.long >= b.short ? "long" : "short" }));
  const above = all.filter((x) => x.price > currentPrice).sort((a, b) => b.mag - a.mag).slice(0, topN);
  const below = all.filter((x) => x.price < currentPrice).sort((a, b) => b.mag - a.mag).slice(0, topN);
  return { above, below };
}

// Network: recent liquidations for one coin over the last `windowMs` (default ~65min).
export async function fetchLiquidations(coin, windowMs = 65 * 60 * 1000) {
  const fam = coinToInstFamily(coin);
  if (!fam) return null;
  try {
    const j = await okxJson(`${OKX_LIQ}?instType=SWAP&instFamily=${fam}&state=filled&limit=100`);
    if (j.code !== "0") return null;
    // Response: data:[{ details:[{posSide, sz, bkPx, ts}, ...] }]
    const details = (j.data || []).flatMap((row) => row.details || []);
    const since = Date.now() - windowMs;
    const agg = aggregateLiquidations(details, since);
    // Levels over a WIDER window (24h) so the clusters are meaningful, not just the last hour.
    const levels = computeLevels(details, Date.now() - 24 * 3600 * 1000);
    return { coin: fam.replace("-USDT", ""), ...agg, levels };
  } catch { return null; }
}

// Hourly cron: append one {t, longMag, shortMag, count} point per coin to
// liq:hist:{coin} (≥55-min guard dedupes to hourly; ~90d cap). Best-effort per coin.
export async function snapshotLiquidations(env, coins) {
  const KV = env.NEXUS_AGENT || env.LAB_STORE;
  let n = 0;
  for (const coin of coins) {
    try {
      const liq = await fetchLiquidations(coin);
      if (!liq) continue;
      const bare = String(coin).toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
      const key = `liq:hist:${bare}`;
      const raw = await KV.get(key);
      const hist = raw ? JSON.parse(raw) : [];
      const last = hist[hist.length - 1];
      const now = Date.now();
      if (last && now - last.t < 55 * 60 * 1000) continue; // keep it hourly
      hist.push({ t: now, longMag: liq.longMag, shortMag: liq.shortMag, count: liq.count });
      if (hist.length > 2200) hist.splice(0, hist.length - 2200);
      await KV.put(key, JSON.stringify(hist));
      n++;
    } catch { /* per-coin best-effort */ }
  }
  return n;
}

// Pure: classify a live FLUSH from the current point vs the symbol's own trailing
// history — a flush = this hour's liquidation magnitude on a side >> its trailing
// median (a spike of forced unwinding). Returns the dominant side + how extreme.
// side "DOWN" = longs capitulating (fade-short entry window); "UP" = shorts squeezed.
export function classifyFlush(hist, current) {
  const pts = (hist || []).filter((p) => Number.isFinite(p?.longMag) && Number.isFinite(p?.shortMag));
  if (pts.length < 12 || !current) return null;
  const longs = pts.map((p) => p.longMag).sort((a, b) => a - b);
  const shorts = pts.map((p) => p.shortMag).sort((a, b) => a - b);
  const med = (arr) => arr[Math.floor(arr.length / 2)] || 0;
  const lMed = med(longs), sMed = med(shorts);
  const lRatio = lMed > 0 ? current.longMag / lMed : (current.longMag > 0 ? 99 : 0);
  const sRatio = sMed > 0 ? current.shortMag / sMed : (current.shortMag > 0 ? 99 : 0);
  const FLUSH = 2.5; // 2.5x the trailing median = a genuine cascade
  if (lRatio < FLUSH && sRatio < FLUSH) return null;
  const side = lRatio >= sRatio ? "DOWN" : "UP"; // DOWN = longs liquidated
  return { side, ratio: Math.round((side === "DOWN" ? lRatio : sRatio) * 10) / 10 };
}
