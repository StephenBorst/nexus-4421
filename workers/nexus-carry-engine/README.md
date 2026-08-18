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

## Phase 3b — live maker executor (money-path) — BUILT, deployed DISARMED
Fully wired and deployed, dormant until armed. Modules:
- `carryExec.mjs` (10 tests) — `planOrders`: diff → **POST_ONLY** maker specs (BUY rests on the
  bid / SELL on the ask so it never crosses to taker; `snapQty` clears base_min + min_notional;
  FLIP is one order through zero). `planIsBalanced` aborts on a skewed (directional) book.
- `carrySign.mjs` — Orderly ed25519 signing + order/position/orderbook calls, **ported verbatim**
  from the validated `nexus-agent-exec` (do not reinvent). Order-only key (cannot withdraw).
- `carryLiveExec.mjs` (6 tests) — `runLive`: reconcile positions → cancel outstanding → target
  book → `planIsBalanced` abort → plan + place POST_ONLY. Reconcile-and-requote: each tick cancels
  and re-posts from ACTUAL fills, so partial fills shrink next tick and unfilled legs re-quote.

**Guardrails (all verified disarmed):** `CARRY_LIVE!=="true"` → no-op · no key → no-op · KV
`carry:kill` → no-op · `planIsBalanced` abort · per-order notional cap · order-only key.
`GET /carry/live/status` reports `{armed, hasKey, killed, lastLive}` (currently all false/null).

### ⚠️ ARMING RUNBOOK (owner-only — moves real money; do NOT arm casually)
Claude built + deployed this DISARMED and will not arm it (can't produce your wallet signature,
and won't move funds). To go live yourself, with a TINY starting capital, watched:
1. **Dedicated Orderly account** (a fresh wallet = clean isolation, or a sub-account). Fund it
   small — enough that `CARRY_LIVE_CAPITAL / 12 legs` clears each market's min_notional (≈$10),
   so **≥ ~$150–200 notional**; at `CARRY_LEVERAGE=3` that's ~$50–70 margin.
2. **Provision an ORDER-ONLY Orderly key** for that account (your wallet signs `AddOrderlyKey`).
3. Set secrets: `wrangler secret put CARRY_TRADING_KEY` (bs58 ed25519 seed) and
   `wrangler secret put CARRY_ACCOUNT_ID`. Set `CARRY_LIVE_CAPITAL` (e.g. "150") + `CARRY_LEVERAGE`.
4. **Dry-run first:** `POST /carry/live/tick` (x-carry-token header) once and read the result +
   `/carry/live/status` — confirm the orders look right BEFORE flipping the cron on.
5. Arm: set `CARRY_LIVE=true` (wrangler.toml var or `wrangler deploy`). The hourly cron now trades.
6. **Kill anytime:** `POST /carry/kill` (stops new orders instantly). `POST /carry/unkill` resumes.
7. Watch the first 24h rebalance closely — maker fill quality is the one thing paper can't prove.
