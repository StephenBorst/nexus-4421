# nexus-carry-engine

Sector-neutral funding-carry basket — the one +EV structure the engine arc produced.
Long the most-negative-funding name and short the most-positive **within each sector**,
so sector co-movement (the "alt dispersion" that swamped every prior RV attempt) cancels
and the funding carry survives.

## The finding (RV-v4, `tools/backtest/relvalue4.mjs`)
- Sector neutralization at **perSide=1** collapses the price residual (−$3.95/$1000/60d),
  carry share **85%**, OOS-positive, Sharpe ~0.9 — the first config that is net+ AND
  oos+ AND carry-dominant at once. perSide 2/3 dilute the funding and let dispersion back.
- The blocker is **fees, not signal**: 24h taker ≈ breakeven; **24h maker nets ~+$19/$1000/60d
  (~12%/yr, 85% carry)**. Maker (post-only) execution is mandatory — taker is not deployable.

## Modules (one engine, shared with the backtest)
- `carryBasket.mjs` — pure construction: `buildTargetBook` / `diffBook` / funding+price PnL /
  neutrality guard. `relvalue4.mjs` imports it → research == deployed behavior (13 tests).
- `carryPaper.mjs` — `stepPaper` paper-execution stepper (funding accrual, scheduled
  rebalance, maker fills, MTM) + `summarize` (equity, carry-share attribution) (9 tests).
- `carryLive.mjs` — `snapshotFromFutures` adapter for `GET /v1/public/futures` (4 tests).
- `index.js` — cron + read-only HTTP shell. **PAPER only, no keys, no orders.**

Run tests: `node --test workers/nexus-carry-engine/carryBasket.test.mjs` (and `carryPaper`, `carryLive`).

## Endpoints
- `GET /carry/health` — `{ ok, mode, legs, rebalances, lastTickAgeSec }`
- `GET /carry/status` — current book (12 legs), config, coverage, summary
- `GET /carry/record` — summary + equity curve (for the public track-record UI)
- `POST /carry/tick` / `POST /carry/reset` — ops, gated by `x-carry-token` header

## Deploy handoff (needs CF auth)
1. `npx wrangler kv namespace create CARRY` → paste the id into `wrangler.toml`.
2. `npx wrangler secret put CARRY_ADMIN_TOKEN` (gates the POST ops routes).
3. `npx wrangler deploy` from this dir.
4. (Optional) add it to `.github/workflows/deploy.yml` so CI redeploys it from source, and
   point a route/custom domain at it for the frontend to read `/carry/record`.

Hourly cron; rebalances only when `CARRY_REBAL_H` (24h) has elapsed. Tunables in
`wrangler.toml [vars]`: capital, perSide, rebalance hours, maker bps, min funding spread.

## Phase 3b — live maker executor (money-path)
The **provably-correct core is built + tested** (`carryExec.mjs`, 10 tests): `planOrders`
turns a `diffBook` diff into concrete **POST_ONLY** (maker) specs — correct side, price that
rests on the book (BUY→bid, SELL→ask, so it never crosses and pays taker), `snapQty`
step-snapped to clear base_min + min_notional, FLIP as a single order through zero.
`planIsBalanced` is an abort guard: if a data glitch skews the target book directional, don't
send. NO signing / NO network / NO order placement in this module.

⚠️ **NOT ARMED — deliberate.** The remaining wiring is the money-path switch and needs an
explicit go + a tiny-capital validation before it touches real funds:
1. Orderly ed25519 signing (port the validated helper from `nexus-agent-exec`), order-only key.
2. One dedicated **Orderly sub-account** for isolation (the sub-account-per-strategy pattern).
3. The live loop: place the `planOrders` specs, monitor fills, **re-quote unfilled legs** (the
   one piece the paper sim can't prove — maker fills aren't guaranteed), reconcile vs exchange.
4. Hard gate `CARRY_LIVE=true` + funded sub-account + a small starting capital; flip on ONLY
   after the paper record holds. Never a silent default.
