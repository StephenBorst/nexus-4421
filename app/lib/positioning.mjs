// ═══════════════════════════════════════════════════════════════════════════
// POSITIONING FUSION — the crowd (funding) vs the smart money (wallets)
// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 of the OBSERVE re-slice. The Mispriced board says where the CROWD is
// over-extended (funding) and which way to fade it; Smart Money says where the SHARP
// wallets are positioned. Fusing them per coin turns two boards into one read:
//   • CONFLUENCE — the funding-fade and the smart money point the SAME way (high conviction)
//   • SPLIT      — the smart money is WITH the crowd, against the fade (the debate)
//   • CROWD/SMART — only one side has a signal (context)
// Pure + dependency-free so the Positioning board and any test read the same truth.
// `node --test app/lib/positioning.test.mjs`.

const bare = (s) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");

// smartLeanByCoin(board, opts) → Map coin → { side, traders, longUsd, shortUsd, netUsd }
// The dominant side per coin among the tracked sharp wallets: the side with more distinct
// traders (dollars break a trader tie). Requires a real cluster (>= minTraders on the
// leading side); a dead tie yields no lean. Mirrors SmartMoneyView's consensus intent.
export function smartLeanByCoin(board, { minTraders = 2 } = {}) {
  const agg = new Map();
  for (const t of board || []) {
    const addr = t && t.address;
    for (const p of (t && t.positions) || []) {
      const c = bare(p && (p.coin || p.sym));
      const usd = Number(p && p.szUsd) || 0;
      if (!c || (p.side !== "LONG" && p.side !== "SHORT") || usd <= 0) continue;
      const e = agg.get(c) || { longUsd: 0, shortUsd: 0, longT: new Set(), shortT: new Set() };
      if (p.side === "LONG") { e.longUsd += usd; if (addr) e.longT.add(addr); }
      else { e.shortUsd += usd; if (addr) e.shortT.add(addr); }
      agg.set(c, e);
    }
  }
  const out = new Map();
  for (const [c, e] of agg) {
    const lT = e.longT.size, sT = e.shortT.size;
    if (Math.max(lT, sT) < minTraders) continue;              // no real cluster
    if (lT === sT && e.longUsd === e.shortUsd) continue;      // dead tie → no lean
    const side = (lT > sT) || (lT === sT && e.longUsd > e.shortUsd) ? "LONG" : "SHORT";
    out.set(c, { side, traders: lT + sT, longUsd: Math.round(e.longUsd), shortUsd: Math.round(e.shortUsd), netUsd: Math.round(Math.abs(e.longUsd - e.shortUsd)) });
  }
  return out;
}

// fusePositioning(mispricedMarkets, board, opts) → ranked fused rows.
//   mispricedMarkets: [{ coin|symbol, direction:"LONG"|"SHORT"|"NONE", status, fundingAnnualPct, edge }]
//   board:            [{ address, positions:[{ coin|sym, side, szUsd }] }]
// direction on a MISPRICED market IS the fade side (crowd over-short → fade LONG, etc.).
export function fusePositioning(mispricedMarkets, board, opts = {}) {
  const smart = smartLeanByCoin(board, opts);
  const crowd = new Map();
  for (const m of mispricedMarkets || []) {
    const c = bare(m && (m.coin || m.symbol));
    if (!c) continue;
    const fade = (m.status === "MISPRICED" && (m.direction === "LONG" || m.direction === "SHORT")) ? m.direction : null;
    crowd.set(c, { fade, funding: Number(m.fundingAnnualPct), edge: Number(m.edge) || 0 });
  }
  const rows = [];
  for (const c of new Set([...crowd.keys(), ...smart.keys()])) {
    const cr = crowd.get(c) || null;
    const sm = smart.get(c) || null;
    const fade = cr && cr.fade;         // crowd fade direction, or null (fair/none)
    const smartSide = sm && sm.side;    // smart lean, or null (no cluster)
    let verdict, rank;
    if (fade && smartSide) { verdict = fade === smartSide ? "CONFLUENCE" : "SPLIT"; rank = fade === smartSide ? 3 : 2; }
    else if (fade) { verdict = "CROWD"; rank = 1; }
    else if (smartSide) { verdict = "SMART"; rank = 1; }
    else continue;                       // neither a fade nor a lean → nothing to say
    rows.push({
      coin: c, verdict, rank,
      crowdFade: fade || null,
      smartSide: smartSide || null,
      fundingAnnualPct: cr && Number.isFinite(cr.funding) ? cr.funding : null,
      edge: cr ? cr.edge : 0,
      smartTraders: sm ? sm.traders : 0,
      smartNetUsd: sm ? sm.netUsd : 0,
    });
  }
  rows.sort((a, b) =>
    b.rank - a.rank ||
    Math.abs(b.fundingAnnualPct || 0) - Math.abs(a.fundingAnnualPct || 0) ||
    b.smartTraders - a.smartTraders);
  return rows;
}

// A one-line read for a fused row — the same wording the UI uses, kept here so it can't drift.
export function positioningRead(row) {
  const fadeWord = row.crowdFade === "LONG" ? "over-short → fade long" : row.crowdFade === "SHORT" ? "over-long → fade short" : null;
  const smWord = row.smartSide ? `${row.smartTraders} sharp ${row.smartSide.toLowerCase()}` : null;
  if (row.verdict === "CONFLUENCE") return `Crowd ${fadeWord}, and the smart money agrees (${smWord}) — both point ${row.crowdFade.toLowerCase()}.`;
  if (row.verdict === "SPLIT") return `Crowd ${fadeWord}, but the smart money is with them (${smWord}) — the fade is contested.`;
  if (row.verdict === "CROWD") return `Crowd ${fadeWord}. The sharp wallets haven't taken a side yet.`;
  return `${smWord} — no funding extreme to fade, just where the sharp money sits.`;
}
