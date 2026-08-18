// ── nexus-carry-engine · LIVE DATA ADAPTER (pure) ─────────────────────────────
// Turns Orderly's public futures rows into the { funding, mark } snapshot the paper
// stepper (and later the live executor) consume. Pure so it's unit-tested; the actual
// fetch lives in index.js. Filters to the tagged universe and drops anything missing a
// usable mark or funding rate.
import { SECTORS, sectorMap, bareTicker } from "./carryBasket.mjs";

// snapshotFromFutures(rows) — rows = data.rows from GET /v1/public/futures
//   funding = last realized 8h rate (est_funding_rate fallback); mark = mark_price.
export function snapshotFromFutures(rows, sectors = SECTORS) {
  const sm = sectorMap(sectors);
  const funding = {}, mark = {};
  for (const r of rows || []) {
    const sym = r?.symbol || "";
    if (!sym.startsWith("PERP_") || !sym.endsWith("_USDC")) continue;
    const t = bareTicker(sym);
    if (!sm[t]) continue; // outside the tagged universe
    const m = Number(r.mark_price ?? r.index_price);
    const fRaw = r.last_funding_rate != null ? r.last_funding_rate
      : (r.est_funding_rate != null ? r.est_funding_rate : null);
    const f = fRaw != null ? Number(fRaw) : NaN;
    if (m > 0 && Number.isFinite(f)) { mark[t] = m; funding[t] = f; }
  }
  return { funding, mark };
}

// coverage(snapshot) — how many sectors have ≥2 names present (a book needs that to form).
export function coverage(snapshot, sectors = SECTORS) {
  const sm = sectorMap(sectors);
  const perSector = {};
  for (const t of Object.keys(snapshot.funding || {})) {
    const sec = sm[t];
    if (sec) perSector[sec] = (perSector[sec] || 0) + 1;
  }
  const tradableSectors = Object.values(perSector).filter((n) => n >= 2).length;
  return { names: Object.keys(snapshot.funding || {}).length, perSector, tradableSectors };
}
