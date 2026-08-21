// ═══════════════════════════════════════════════════════════════════════════
// LIVE-BOOK RISK — is what you're holding RIGHT NOW secretly one bet?
// ═══════════════════════════════════════════════════════════════════════════
// A different axis from the behavioral reads (which look at your history) and the
// graded record (which looks at your calls): this looks at your OPEN positions and
// asks whether a book that looks diversified — several tickers — is really one
// directional or one-sector bet at multiplied size. Concentration you didn't notice
// is a top cause of an account blowing up on a single move.
//
// Pure + dependency-free. Weights by `notional` when present (the copilot has it) and
// falls back to equal weight per position (the Briefing only has symbol+direction), so
// ONE function serves both surfaces. `node --test app/lib/bookRisk.test.mjs`.

// Compact crypto-sector taxonomy for correlation grouping. Deliberately self-contained
// (like behavioral.mjs) — concentration detection is robust to the exact buckets, and this
// avoids coupling the app bundle to the carry-engine worker. Majors/L1s move together, memes
// move together, etc. — that co-movement is the hidden risk.
const SECTORS = {
  L1: ["BTC", "ETH", "SOL", "BNB", "AVAX", "NEAR", "DOT", "ADA", "APT", "SUI", "SEI", "TRX", "TIA", "ATOM"],
  L2: ["ARB", "OP", "POL", "MATIC", "MNT", "MERL", "STRK", "ZK"],
  DEFI: ["AAVE", "UNI", "LINK", "INJ", "JUP", "ENA", "ONDO", "PENDLE", "CRV", "CAKE", "MORPHO", "ETHFI", "LDO"],
  AI: ["FET", "TAO", "WLD", "VIRTUAL", "RENDER", "AR", "AI16Z"],
  MEME: ["DOGE", "1000BONK", "BONK", "1000PEPE", "PEPE", "1000SHIB", "SHIB", "WIF", "FARTCOIN", "PENGU", "PUMP", "TRUMP", "SPX", "POPCAT", "FLOKI"],
  PAY: ["LTC", "XRP", "BCH", "HBAR", "ZEC", "XMR", "XLM"],
};
const SECTOR_OF = {};
for (const [s, arr] of Object.entries(SECTORS)) for (const t of arr) SECTOR_OF[t] = s;

export const bareTicker = (s) => String(s).replace("PERP_", "").replace("_USDC", "").replace("-USD", "").toUpperCase();
export const sectorOf = (symbol) => SECTOR_OF[bareTicker(symbol)] || "OTHER";

const sideOf = (p) => {
  if (typeof p.side === "number") return p.side >= 0 ? 1 : -1;
  const d = String(p.direction ?? p.side ?? "").toUpperCase();
  return d.includes("SHORT") || d === "SELL" || d === "-1" ? -1 : 1;
};

/**
 * bookConcentration(positions, opts) → the hidden-concentration read, or null.
 *   positions: [{ symbol, direction|side, notional? }]
 * Fires when EITHER one sector dominates the gross book one-directionally (correlated bet)
 * OR the whole book is lopsided one way (unhedged directional). Null on a small book (< 3)
 * or a genuinely mixed one — no false alarms on a balanced book.
 * @returns {{ positions, netPct, netSide, topSector:{name,pct,side,count}|null, kind:"sector"|"directional", weighted } | null}
 */
export function bookConcentration(positions, { minPositions = 3, sectorPct = 60, netPct = 70 } = {}) {
  const list = (positions || []).filter((p) => p && p.symbol);
  if (list.length < minPositions) return null;
  const legs = list.map((p) => ({
    symbol: bareTicker(p.symbol),
    sector: sectorOf(p.symbol),
    side: sideOf(p),
    weight: Number(p.notional) > 0 ? Number(p.notional) : 1,
  }));
  const gross = legs.reduce((a, l) => a + l.weight, 0) || 1;
  const net = legs.reduce((a, l) => a + l.side * l.weight, 0);
  const netPctVal = Math.round((Math.abs(net) / gross) * 100);

  const bySec = {};
  for (const l of legs) {
    const s = bySec[l.sector] || (bySec[l.sector] = { name: l.sector, long: 0, short: 0, count: 0 });
    if (l.side > 0) s.long += l.weight; else s.short += l.weight;
    s.count += 1;
  }
  let top = null;
  for (const s of Object.values(bySec)) {
    const sg = s.long + s.short;
    if (!top || sg > top.gross) {
      const dirNet = s.long - s.short;
      top = { name: s.name, pct: Math.round((sg / gross) * 100), side: dirNet >= 0 ? "LONG" : "SHORT", count: s.count, gross: sg, oneWay: Math.abs(dirNet) / sg >= 0.9 };
    }
  }
  const sectorConcentrated = !!top && top.name !== "OTHER" && top.count >= 2 && top.pct >= sectorPct && top.oneWay;
  const directional = netPctVal >= netPct;
  if (!sectorConcentrated && !directional) return null;

  return {
    positions: legs.length,
    netPct: netPctVal,
    netSide: net >= 0 ? "LONG" : "SHORT",
    topSector: top && top.name !== "OTHER" ? { name: top.name, pct: top.pct, side: top.side, count: top.count } : null,
    kind: sectorConcentrated ? "sector" : "directional",
    weighted: legs.some((l) => l.weight !== 1),
  };
}
