// ── Strategy validation + OI-history loading ──
// Shared infrastructure (migration rules in shared.mjs): loadOiHistForBacktest feeds
// the backtest/sweep routes still in index.js, and revalidateStrategy is driven both
// by the publish toggle there and by the self-heal pass in routes-agents.mjs. Neither
// belongs to a single route family, so it lives here rather than being duplicated.
//
// ⚠️ Pure move — logic byte-identical to what shipped.
import { walkForwardValidate, oiSeriesInfo } from "./backtest.mjs";

// ── OI-history loader for backtests ───────────────────────────────────────────
// CONFLUENCE / OI_ONLY need the brain's recorded oi:hist:{symbol} series (Orderly
// has no OI history endpoint). This reads it for the given symbols and reports
// whether coverage is deep enough to trust an OI backtest. Shared by the single
// backtest + the sweep so the maturity gate can't drift. Until mature it no-ops
// (oiMature:false) and callers stay honestly "untestable".
export const OI_BACKTEST_MIN_DAYS = 14, OI_BACKTEST_MIN_SAMPLES = 200;
export async function loadOiHistForBacktest(symbols, env) {
  const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
  const oiHistBySymbol = {};
  const infos = [];
  for (const s of symbols) {
    let rows = [];
    try { const raw = await AGENT_KV.get(`oi:hist:${s}`); rows = raw ? JSON.parse(raw) : []; } catch { /* absent → thin */ }
    oiHistBySymbol[s] = rows;
    infos.push({ symbol: s, ...oiSeriesInfo(rows) });
  }
  const minDays = infos.length ? Math.min(...infos.map((i) => i.days)) : 0;
  const minSamples = infos.length ? Math.min(...infos.map((i) => i.samples)) : 0;
  const oiMature = minDays >= OI_BACKTEST_MIN_DAYS && minSamples >= OI_BACKTEST_MIN_SAMPLES;
  return { oiHistBySymbol, oiMature, gate: { minDays, minSamples, perSymbol: infos } };
}

// Walk-forward validate a PUBLISHED strategy and stamp the verdict onto its record —
// the community board's trust badge. Run in the background (ctx.waitUntil) at publish
// so the toggle stays snappy. Server-computed (never client-supplied) since it's a
// trust signal. CONFLUENCE/OI_ONLY stay "pending_oi" until recorded OI matures.
export const VALIDATE_UNIVERSE = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_BNB_USDC", "PERP_XRP_USDC", "PERP_LINK_USDC"];
export async function revalidateStrategy(address, stratId, config, env) {
  const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
  let validation;
  try {
    const needsOi = ["CONFLUENCE", "OI_ONLY"].includes(config.signalMode);
    const oi = needsOi ? await loadOiHistForBacktest(VALIDATE_UNIVERSE, env) : null;
    if (needsOi && !oi.oiMature) {
      validation = { status: "pending_oi", note: `awaiting OI history (${oi.gate.minDays}/${OI_BACKTEST_MIN_DAYS}d)`, checkedAt: Date.now() };
    } else {
      const r = await walkForwardValidate(config, { symbols: VALIDATE_UNIVERSE, days: 60, folds: 4 }, oi?.oiMature ? oi.oiHistBySymbol : {});
      validation = { status: "done", verdict: r.verdict, posSymbols: r.posSymbols, totalSymbols: r.totalSymbols, foldConsistency: r.foldConsistency, totalNet: r.totalNet, validatedAt: Date.now() };
    }
  } catch { validation = { status: "error", checkedAt: Date.now() }; }
  // Re-read latest before patching so a concurrent save/publish isn't clobbered.
  const key = `agent:strategies:${address}`;
  const raw = await AGENT_KV.get(key);
  if (!raw) return;
  let list; try { list = JSON.parse(raw); } catch { return; }
  const s = list.find((x) => x.id === stratId);
  if (!s) return;
  s.validation = validation;
  await AGENT_KV.put(key, JSON.stringify(list));
}
