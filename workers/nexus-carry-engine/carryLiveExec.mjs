// ── nexus-carry-engine · LIVE MAKER EXECUTOR (money-path, gated) ──────────────
// Runs the SAME engine as paper against a real order-only Orderly key. DISARMED by
// default: no-ops unless env.CARRY_LIVE === "true" AND a key is present AND no kill
// flag is set. Reconcile-and-requote design: each tick cancels outstanding orders,
// reads ACTUAL filled positions, and posts POST_ONLY orders for the remaining diff —
// so partial fills just shrink next tick's work and unfilled legs re-quote naturally.
//
// Guardrails (belt and suspenders): CARRY_LIVE gate · KV kill switch · planIsBalanced
// abort (never send a directional book) · per-order notional cap · order-only key
// (cannot withdraw). First live run MUST be tiny capital, watched.
import { buildTargetBook, diffBook, sectorMap } from "./carryBasket.mjs";
import { planOrders, planIsBalanced } from "./carryExec.mjs";
import { getPositions, getOpenOrders, cancelOrder, setLeverage, placePostOnly, publicInfo, bookTop } from "./carrySign.mjs";

const bare = (s) => String(s).replace("PERP_", "").replace("_USDC", "");

// positionsToLegs — parse Orderly /v1/positions rows → current legs [{symbol,side,notional}].
// Only non-trivial positions; notional = |qty| * mark. PURE, tested.
export function positionsToLegs(rows, dust = 1) {
  const legs = [];
  for (const r of rows || []) {
    const qty = Number(r.position_qty);
    const mark = Number(r.mark_price || r.average_open_price);
    if (!qty || !(mark > 0)) continue;
    const notional = Math.abs(qty) * mark;
    if (notional < dust) continue;
    legs.push({ symbol: bare(r.symbol), side: qty > 0 ? 1 : -1, notional });
  }
  return legs;
}

// openOrderIds — [{symbol, orderId}] to cancel. PURE, tested.
export function openOrderIds(rows) {
  return (rows || [])
    .filter((o) => o && o.order_id != null && o.symbol)
    .map((o) => ({ symbol: o.symbol, orderId: o.order_id }));
}

function liveConfig(env) {
  return {
    capital: env.CARRY_LIVE_CAPITAL != null ? Number(env.CARRY_LIVE_CAPITAL) : Number(env.CARRY_CAPITAL || 1000),
    perSide: Number(env.CARRY_PERSIDE || 1),
    leverage: Number(env.CARRY_LEVERAGE || 3),
    minFundingSpread: env.CARRY_MIN_SPREAD != null ? Number(env.CARRY_MIN_SPREAD) : 0,
  };
}

// runLive(env, snapshot) — one live rebalance tick. snapshot = { funding, mark } (same
// object the paper tick uses, so live and paper trade off identical data).
export async function runLive(env, snapshot) {
  if (env.CARRY_LIVE !== "true") return { skipped: "disarmed" };
  const keyData = { tradingKey: env.CARRY_TRADING_KEY, accountId: env.CARRY_ACCOUNT_ID };
  if (!keyData.tradingKey || !keyData.accountId) return { skipped: "no_key" };
  if (await env.CARRY.get("carry:kill")) return { skipped: "killed" };

  const cfg = liveConfig(env);

  // 1) reconcile actual positions
  let currentLegs = [];
  try { currentLegs = positionsToLegs(await getPositions(keyData)); }
  catch (e) { return { aborted: "positions_read_failed", error: String(e && e.message || e) }; }

  // 2) cancel outstanding orders (fresh re-quote each tick)
  try { for (const o of openOrderIds(await getOpenOrders(keyData))) { try { await cancelOrder(keyData, o.symbol, o.orderId); } catch { /* best effort */ } } }
  catch { /* non-fatal */ }

  // 3) target book — re-RANK only every CARRY_REBAL_H (matches paper); between rebalances
  //    hold the SAME target and re-QUOTE toward it (chase fills). This is what lets the
  //    */5 cron pick up maker fills without churning the book every 5 minutes.
  const rebalMs = (Number(env.CARRY_REBAL_H) || 24) * 3600000;
  let targetLegs, rebalanced = false;
  const savedT = await env.CARRY.get("carry:live:target").then((r) => (r ? JSON.parse(r) : null)).catch(() => null);
  if (!savedT || !savedT.legs?.length || (Date.now() - (savedT.ts || 0)) >= rebalMs) {
    const built = buildTargetBook(snapshot.funding, sectorMap(), { capital: cfg.capital, perSide: cfg.perSide, minFundingSpread: cfg.minFundingSpread });
    if (!built.legs.length) return { aborted: "empty_target" };
    targetLegs = built.legs;
    rebalanced = true;
  } else {
    targetLegs = savedT.legs;
  }

  // 4) HARD SAFETY: never send a directional (unbalanced) book
  const bal = planIsBalanced(targetLegs);
  if (!bal.balanced) return { aborted: "unbalanced_book", net: bal.net };
  // persist a freshly-ranked target so the 24h clock is anchored to the decision
  if (rebalanced) { try { await env.CARRY.put("carry:live:target", JSON.stringify({ ts: Date.now(), legs: targetLegs })); } catch { /* non-fatal */ } }

  // 5) what needs to change
  const orders = diffBook(currentLegs, targetLegs);
  if (!orders.length) return { ok: true, placed: 0, note: "already aligned", legs: currentLegs.length, rebalanced };

  // 6) market info (step size on /info; best bid/ask from the book)
  const marketInfo = {};
  await Promise.all(orders.map(async (o) => {
    const full = `PERP_${o.symbol}_USDC`;
    try {
      const [info, top] = await Promise.all([publicInfo(full), bookTop(keyData, full)]);
      if (info && top && top.bestBid > 0 && top.bestAsk > 0) marketInfo[o.symbol] = { ...info, bestBid: top.bestBid, bestAsk: top.bestAsk };
    } catch { /* leg skipped in planOrders (no_market_data) */ }
  }));

  // 7) neutral book → low leverage still lets margin fit; set once
  try { await setLeverage(keyData, cfg.leverage); } catch { /* leverage call best-effort */ }

  // 8) plan POST_ONLY + place, with a per-order notional cap (no single order > the book)
  const specs = planOrders(orders, currentLegs, targetLegs, marketInfo);
  const results = [];
  let placed = 0;
  for (const s of specs) {
    if (s.skip) { results.push(s); continue; }
    if (s.qty * s.price > cfg.capital) { results.push({ symbol: s.symbol, skip: "over_notional_cap", notional: s.qty * s.price }); continue; }
    const r = await placePostOnly(keyData, s);
    if (r.ok) placed++;
    results.push(r.ok ? { symbol: s.symbol, side: s.side, qty: s.qty, price: s.price, orderId: r.orderId } : { symbol: s.symbol, side: s.side, error: r.message, code: r.code });
  }

  const liveState = { ts: Date.now(), currentLegs, targetLegs, planned: orders.length, placed, rebalanced, results };
  try { await env.CARRY.put("carry:live:state", JSON.stringify(liveState)); } catch { /* non-fatal */ }
  return { ok: true, placed, planned: orders.length, rebalanced, results };
}
