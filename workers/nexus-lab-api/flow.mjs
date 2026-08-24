// ── SPOT-PERP BASIS + CVD (OKX) ──────────────────────────────────────────────
// Tool #4 in the orthogonal-signal stack. Two reads a funding rate can't give you:
//
// BASIS = (perp − spot) / spot. A funding extreme sitting on a perp PREMIUM (basis > 0)
// is leverage-driven froth — safe to fade. The same funding on a perp at/below spot is
// backed by real spot demand — a dangerous fade. So basis grades the QUALITY of the fade:
//   basis > 0  → perp premium (longs paying up)  → confirms a SHORT fade
//   basis < 0  → perp discount (shorts pressing) → confirms a LONG fade
//
// CVD = cumulative volume delta = Σ(taker-buy notional) − Σ(taker-sell notional). Aggressor
// flow. A price push on FALLING CVD is distribution (weak) — the reversal fuel. We record
// it hourly (cvd:hist) so CVD-divergence becomes backtestable as the series matures; the
// live delta shows aggressor pressure now.
//
// Both accumulate hourly (basis:hist / cvd:hist) — same pattern as oi:hist / liq:hist.
// OKX is CF-accessible (unlike Binance). Magnitudes are notional-ish (consistent per symbol).

import { okxJson, deribitResult } from "./okx.mjs";

export const OKX_TICKER = "https://www.okx.com/api/v5/market/ticker";
export const OKX_TRADES = "https://www.okx.com/api/v5/market/trades";

export function coinToSpot(coin) {
  const c = String(coin || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "").replace(/_USDT$/, "");
  return c ? `${c}-USDT` : null;
}

// Pure: basis % from spot + perp last. Positive = perp premium. Guards bad ticks.
export function computeBasisPct(spotLast, perpLast) {
  const s = parseFloat(spotLast), p = parseFloat(perpLast);
  if (!Number.isFinite(s) || !Number.isFinite(p) || s <= 0) return null;
  const pct = ((p - s) / s) * 100;
  return Math.abs(pct) > 10 ? null : Math.round(pct * 1000) / 1000; // >10% = bad data
}

// Pure: fold OKX taker trades into CVD (buy notional − sell notional) + total, over
// [sinceMs, now]. side is the AGGRESSOR side. Exported for tests.
export function aggregateCvd(trades, sinceMs) {
  let buy = 0, sell = 0, n = 0;
  for (const t of trades || []) {
    const ts = Number(t.ts ?? 0);
    if (!(ts >= sinceMs)) continue;
    const notional = Math.abs(parseFloat(t.sz || "0")) * Math.abs(parseFloat(t.px || "0"));
    if (!notional) continue;
    if (t.side === "buy") buy += notional; else if (t.side === "sell") sell += notional;
    n++;
  }
  const r = (x) => Math.round(x);
  return { cvd: r(buy - sell), buy: r(buy), sell: r(sell), count: n };
}

// Network: live basis for one coin (spot vs perp ticker on OKX).
export async function fetchBasis(coin) {
  const spot = coinToSpot(coin);
  if (!spot) return null;
  try {
    const [s, p] = await Promise.all([
      okxJson(`${OKX_TICKER}?instId=${spot}`),
      okxJson(`${OKX_TICKER}?instId=${spot}-SWAP`),
    ]);
    if (s.code !== "0" || p.code !== "0") return null;
    const basisPct = computeBasisPct(s.data?.[0]?.last, p.data?.[0]?.last);
    if (basisPct == null) return null;
    return { coin: spot.replace("-USDT", ""), basisPct, spot: parseFloat(s.data[0].last), perp: parseFloat(p.data[0].last) };
  } catch { return null; }
}

// Network: live CVD from the last `windowMs` of taker trades (OKX returns ~recent).
export async function fetchCvd(coin, windowMs = 65 * 60 * 1000) {
  const spot = coinToSpot(coin);
  if (!spot) return null;
  try {
    const j = await okxJson(`${OKX_TRADES}?instId=${spot}-SWAP&limit=100`);
    if (j.code !== "0") return null;
    return { coin: spot.replace("-USDT", ""), ...aggregateCvd(j.data || [], Date.now() - windowMs) };
  } catch { return null; }
}

// Pure: order-book imbalance over the top levels = (bidNotional − askNotional) /
// (bid + ask), in [−1, 1]. Positive = bid-heavy (buyers stacked = support → LONG);
// negative = ask-heavy (sellers stacked = resistance → SHORT). OKX books rows are
// [price, size, _, orders]. Exported for tests.
export function computeImbalance(bids, asks) {
  const vol = (rows) => (rows || []).reduce((s, x) => s + (parseFloat(x[0]) || 0) * (parseFloat(x[1]) || 0), 0);
  const b = vol(bids), a = vol(asks);
  if (b + a <= 0) return null;
  return Math.round(((b - a) / (b + a)) * 1000) / 1000;
}

// Network: live order-book imbalance for one coin (OKX top-20). Microstructure only —
// too fast to snapshot hourly, so this is a LIVE decision-moment read, not accumulated.
export async function fetchOrderbook(coin) {
  const spot = coinToSpot(coin);
  if (!spot) return null;
  try {
    const j = await okxJson(`https://www.okx.com/api/v5/market/books?instId=${spot}-SWAP&sz=20`);
    if (j.code !== "0") return null;
    const bk = j.data?.[0];
    const imbalance = computeImbalance(bk?.bids, bk?.asks);
    return imbalance == null ? null : { coin: spot.replace("-USDT", ""), imbalance };
  } catch { return null; }
}

// Live imbalance → a directional support/resistance read, or null if too balanced.
export function classifyOrderbook(imbalance) {
  const SKEW = 0.35; // book noise floor — only a decisive lean counts
  if (imbalance == null || Math.abs(imbalance) < SKEW) return null;
  return { side: imbalance > 0 ? "LONG" : "SHORT", imbalance };
}

// Live basis → a directional QUALITY read for the fade, or null if too flat to matter.
// side = which fade direction the basis supports; |basis| must clear PREMIUM to count.
// ── CVD DIVERGENCE (aggressor flow vs price) ─────────────────────────────────
// The orthogonal flow read: a price PUSH on the WRONG aggressor flow is the tell.
// Price up but net CVD negative = the move is being SOLD into (distribution) → a
// SHORT-side fade; price down but CVD positive = being BOUGHT (accumulation) → LONG.
// We surface ONLY divergence — confirmation (price and flow agree) is trend, not an
// edge, so it stays silent. Pure; the endpoint supplies the price move + live CVD.
// cvd:hist is logging so this becomes backtestable as the series matures.
export const CVD_MIN_MOVE = 0.25; // % price move over the window to call a direction
export const CVD_MIN_TILT = 0.08; // |cvd|/(buy+sell) floor — a real aggressor tilt
export function classifyCvdDivergence(priceChangePct, cvdObj) {
  if (!cvdObj || !Number.isFinite(priceChangePct)) return null;
  const total = (Number(cvdObj.buy) || 0) + (Number(cvdObj.sell) || 0);
  if (total <= 0) return null;
  const tilt = (Number(cvdObj.cvd) || 0) / total; // -1..1 net aggressor lean
  if (Math.abs(priceChangePct) < CVD_MIN_MOVE || Math.abs(tilt) < CVD_MIN_TILT) return null;
  const priceUp = priceChangePct > 0, flowUp = tilt > 0;
  if (priceUp === flowUp) return null; // agreement = trend, not a fade tell
  return {
    side: priceUp ? "SHORT" : "LONG",
    kind: priceUp ? "distribution" : "accumulation",
    tilt: Math.round(tilt * 100) / 100,
    priceChangePct: Math.round(priceChangePct * 100) / 100,
  };
}

export function classifyBasis(basisPct) {
  const PREMIUM = 0.03; // % — below this the perp is priced with spot, no froth signal
  if (basisPct == null || Math.abs(basisPct) < PREMIUM) return null;
  return { side: basisPct > 0 ? "SHORT" : "LONG", basisPct };
}

// ── OPTIONS SKEW (Deribit) ───────────────────────────────────────────────────
// The options market's fear/greed — orthogonal to spot/perp entirely. SKEW = nearest-
// expiry ~10%-OTM put IV − call IV (a risk-reversal proxy). Puts richer (skew↑) = downside
// fear/hedging; calls richer (skew↓) = upside greed. Classified vs its OWN trailing history
// (crypto's baseline skew varies), so an EXTREME = a sentiment stretch: more fear than usual
// = capitulation → LONG (fade the fear); more greed than usual → SHORT. BTC/ETH/SOL only
// (the liquid Deribit options). Slow signal → fits hourly, accumulates in skew:hist.
const DERIBIT_CCYS = new Set(["BTC", "ETH", "SOL"]);
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// Pure: parse a Deribit option instrument, e.g. "BTC-25JUN27-150000-P".
export function parseDeribitInstrument(name) {
  const p = String(name || "").split("-");
  if (p.length < 4) return null;
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(p[1]);
  if (!m || !(m[2] in MON)) return null;
  return { expiry: Date.UTC(2000 + +m[3], MON[m[2]], +m[1], 8), strike: +p[2], type: p[3] };
}

// Pure: from parsed option rows [{expiry,strike,type,iv,underlying}] compute the nearest
// viable expiry's 10%-OTM put−call IV skew. Exported for tests.
export function computeSkew(rows, now = Date.now()) {
  const valid = (rows || []).filter((r) => r && r.iv > 0 && r.strike > 0 && r.underlying > 0 && r.expiry - now > 2 * 86400000);
  if (!valid.length) return null;
  const u = valid[0].underlying;
  const byExp = {};
  for (const r of valid) (byExp[r.expiry] = byExp[r.expiry] || []).push(r);
  for (const e of Object.keys(byExp).map(Number).sort((a, b) => a - b)) {
    const grp = byExp[e];
    const puts = grp.filter((r) => r.type === "P"), calls = grp.filter((r) => r.type === "C");
    if (puts.length < 3 || calls.length < 3) continue;
    const nearest = (arr, t) => arr.reduce((a, b) => (Math.abs(b.strike - t) < Math.abs(a.strike - t) ? b : a));
    const put = nearest(puts, u * 0.9), call = nearest(calls, u * 1.1);
    return { skew: Math.round((put.iv - call.iv) * 100) / 100, putIv: put.iv, callIv: call.iv, days: Math.round((e - now) / 86400000) };
  }
  return null;
}

// Pure: DVOL TERM STRUCTURE from the option chain — ATM implied vol of the nearest expiry
// vs a ~monthly expiry. Front > back (backwardation) = acute near-term stress/fear (event
// risk priced in) — the vol regime where mean-reversion fades work best; front < back
// (contango) = calm/complacent. Returns { frontIv, backIv, ratio, structure }. Exported for tests.
export function computeTermStructure(rows, now = Date.now()) {
  const valid = (rows || []).filter((r) => r && r.iv > 0 && r.strike > 0 && r.underlying > 0 && r.expiry - now > 1 * 86400000);
  if (valid.length < 6) return null;
  const u = valid[0].underlying;
  const byExp = {};
  for (const r of valid) (byExp[r.expiry] = byExp[r.expiry] || []).push(r);
  const exps = Object.keys(byExp).map(Number).sort((a, b) => a - b);
  if (exps.length < 2) return null;
  const atmIv = (grp) => grp.reduce((a, b) => (Math.abs(b.strike - u) < Math.abs(a.strike - u) ? b : a)).iv;
  const front = exps[0];
  // back = the expiry nearest ~30d out (else the furthest available)
  const back = exps.reduce((best, e) => (Math.abs((e - now) / 86400000 - 30) < Math.abs((best - now) / 86400000 - 30) ? e : best), exps[exps.length - 1]);
  if (back === front) return null;
  const frontIv = atmIv(byExp[front]), backIv = atmIv(byExp[back]);
  if (!(frontIv > 0) || !(backIv > 0)) return null;
  const ratio = Math.round((frontIv / backIv) * 1000) / 1000;
  const structure = ratio >= 1.05 ? "backwardation" : ratio <= 0.95 ? "contango" : "flat";
  return { frontIv: Math.round(frontIv * 10) / 10, backIv: Math.round(backIv * 10) / 10, ratio, structure, frontDays: Math.round((front - now) / 86400000), backDays: Math.round((back - now) / 86400000) };
}

// Network: live options skew for one coin (Deribit book summary). BTC/ETH/SOL only.
export async function fetchSkew(coin) {
  const c = String(coin || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
  if (!DERIBIT_CCYS.has(c)) return null;
  try {
    const result = await deribitResult(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${c}&kind=option`);
    const rows = result.map((x) => {
      const p = parseDeribitInstrument(x.instrument_name);
      return p ? { ...p, iv: parseFloat(x.mark_iv), underlying: parseFloat(x.underlying_price) } : null;
    });
    const s = computeSkew(rows);
    const term = computeTermStructure(rows);
    if (!s && !term) return null;
    return { coin: c, ...(s || {}), term: term || null };
  } catch { return null; }
}

// Live skew vs its OWN trailing history → a sentiment-extreme read, or null. More put-fear
// than usual → LONG (fade capitulation); more call-greed than usual → SHORT. Needs ≥12 pts.
export function classifySkew(hist, current) {
  const pts = (hist || []).map((p) => p.skew).filter(Number.isFinite);
  if (pts.length < 12 || current == null) return null;
  const sorted = [...pts].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const dev = current - med;
  if (Math.abs(dev) < 3) return null; // <3 IV pts from its norm = not a stretch
  return { side: dev > 0 ? "LONG" : "SHORT", skew: current, dev: Math.round(dev * 100) / 100 };
}

// Hourly cron: append {t, basisPct} to basis:hist and {t, cvd, buy, sell} to cvd:hist
// per coin (≥55-min guard → hourly; ~90d cap). Best-effort per coin.
export async function snapshotFlow(env, coins) {
  const KV = env.NEXUS_AGENT || env.LAB_STORE;
  let n = 0;
  for (const coin of coins) {
    const bare = String(coin).toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
    const now = Date.now();
    try {
      // NOTE: options skew/DVOL is fetched CLIENT-SIDE (Deribit hard-blocks CF egress — see
      // app/lib/deribit.mjs), so no server-side skew snapshot here (it always failed). OKX
      // basis + CVD work fine from the worker.
      const [basis, cvd] = await Promise.all([fetchBasis(coin), fetchCvd(coin)]);
      if (basis) await appendHist(KV, `basis:hist:${bare}`, { t: now, basisPct: basis.basisPct }, now);
      if (cvd) await appendHist(KV, `cvd:hist:${bare}`, { t: now, cvd: cvd.cvd, buy: cvd.buy, sell: cvd.sell }, now);
      if (basis || cvd) n++;
    } catch { /* per-coin best-effort */ }
  }
  return n;
}

async function appendHist(KV, key, point, now) {
  const raw = await KV.get(key);
  const hist = raw ? JSON.parse(raw) : [];
  const last = hist[hist.length - 1];
  if (last && now - last.t < 55 * 60 * 1000) return; // hourly
  hist.push(point);
  if (hist.length > 2200) hist.splice(0, hist.length - 2200);
  await KV.put(key, JSON.stringify(hist));
}
