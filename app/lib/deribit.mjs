// ── Deribit options — CLIENT-SIDE (Deribit hard-blocks Cloudflare Worker egress) ──
// Same pattern as the client-side GeckoTerminal fetch: Deribit's public API 403s/empties
// from datacenter IPs (the worker), but works from the browser's residential IP. So the
// vol-regime (DVOL term structure) is fetched here, in THE READ, not server-side. Pure
// helpers mirror the worker's flow.mjs (kept app-local to avoid a cross-dir Vite import).

const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const CCYS = new Set(["BTC", "ETH", "SOL"]);

export function parseDeribitInstrument(name) {
  const p = String(name || "").split("-");
  if (p.length < 4) return null;
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(p[1]);
  if (!m || !(m[2] in MON)) return null;
  return { expiry: Date.UTC(2000 + +m[3], MON[m[2]], +m[1], 8), strike: +p[2], type: p[3] };
}

// DVOL term structure: nearest-expiry ATM IV vs ~monthly. Backwardation (front>back) =
// acute near-term stress (fades favored); contango = calm (trend regime).
export function computeTermStructure(rows, now = Date.now()) {
  const valid = (rows || []).filter((r) => r && r.iv > 0 && r.strike > 0 && r.underlying > 0 && r.expiry - now > 86400000);
  if (valid.length < 6) return null;
  const u = valid[0].underlying;
  const byExp = {};
  for (const r of valid) (byExp[r.expiry] = byExp[r.expiry] || []).push(r);
  const exps = Object.keys(byExp).map(Number).sort((a, b) => a - b);
  if (exps.length < 2) return null;
  const atmIv = (grp) => grp.reduce((a, b) => (Math.abs(b.strike - u) < Math.abs(a.strike - u) ? b : a)).iv;
  const front = exps[0];
  const back = exps.reduce((best, e) => (Math.abs((e - now) / 86400000 - 30) < Math.abs((best - now) / 86400000 - 30) ? e : best), exps[exps.length - 1]);
  if (back === front) return null;
  const frontIv = atmIv(byExp[front]), backIv = atmIv(byExp[back]);
  if (!(frontIv > 0) || !(backIv > 0)) return null;
  const ratio = Math.round((frontIv / backIv) * 1000) / 1000;
  const structure = ratio >= 1.05 ? "backwardation" : ratio <= 0.95 ? "contango" : "flat";
  return { frontIv: Math.round(frontIv * 10) / 10, backIv: Math.round(backIv * 10) / 10, ratio, structure };
}

// Client fetch: the DVOL term structure for a coin (BTC/ETH/SOL). Fail-soft → null.
export async function fetchDeribitTerm(coin) {
  const c = String(coin || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
  if (!CCYS.has(c)) return null;
  try {
    const r = await fetch(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${c}&kind=option`);
    const j = await r.json();
    const rows = (j.result || []).map((x) => {
      const p = parseDeribitInstrument(x.instrument_name);
      return p ? { ...p, iv: parseFloat(x.mark_iv), underlying: parseFloat(x.underlying_price) } : null;
    });
    return computeTermStructure(rows);
  } catch { return null; }
}
