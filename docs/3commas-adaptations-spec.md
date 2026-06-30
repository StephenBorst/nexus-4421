# 3Commas-Informed Agent Adaptations — Build Spec

Studied 3Commas (DCA bots, grid bots, signal/TradingView bots, smart-trade multi-exit,
backtesting, paper trading). We already match/beat them on the trust layer (non-custodial
order-only keys, PAPER mode, guardrails, and the thing they lack entirely: **publicly,
independently graded performance** — 3Commas is self-reported and was breached in 2022).
So we take only the mechanics that fit the funding-edge + trustless-grading identity.

Positioning wedge: **"3Commas automation without the trust problem"** — multi-strategy bots
where every result is publicly graded and keys can never withdraw.

Each feature reuses the existing pipeline:
`nexus-agent-exec` cron → `processUser → enterPosition → monitorPosition → closePosition →
Supabase agent_trades grading → leaderboard`. New money-path logic lands in the relevant
`logic.mjs` with `node:test` coverage (repo convention).

Build order: **#2 first** (smallest, helps live PnL, builds partial-close infra) → **#1**
(distribution, largely parallel) → **#3** (most complex, reuses #2, PRO-gated).

---

## #2 — Multi-level Take-Profit + Trailing Stops  (FIRST)

**Today:** `exitReason(pnlPct, holdMs, {tpPercent, slPercent, maxHoldHours})` returns one of
`TP|SL|TIMEOUT`; `closePosition` closes the **whole** position.

**Change — generalize the exit decision into an action:**
- New pure `evaluateExit(pos, pnlPct, holdMs, config)` in `nexus-agent-exec/logic.mjs`
  returning:
  - `{ type: "PARTIAL_TP", level, sizePct }`
  - `{ type: "FULL_CLOSE", reason }`  (reason ∈ TP|SL|TIMEOUT|TRAIL)
  - `{ type: "TRAIL_UPDATE", trailStop }`
  - `null`
- Config additions:
  - `takeProfits: [{ pct, sizePct }]` e.g. `[{pct:1,sizePct:50},{pct:2.5,sizePct:50}]`
  - `trailingStopPct` (0 = off) with activation: only trail once `pnlPct ≥ trailActivatePct`
    (default = first TP level) so it locks gains rather than noise-stopping early.
- Position state additions: `remaining_qty`, `tp_hits: number[]`, `peak_pnl_pct`, `trail_stop`.
- `closePosition` gains a **partial path**: reduce-only order for `sizePct` of `qty`,
  decrement `remaining_qty`, log each slice as its own `agent_trades` row with shared
  `parent_id` + `exit_seq` (per-slice honesty; same resilient-insert fallback as the existing
  `entry_order_id`/`close_order_id` optional columns).
- **Backward compat:** positions without the new fields fall back to single-TP/SL `exitReason`
  (same pattern as `pos.tpPercent ?? config.tpPercent`).

**Gating:** FREE. It's risk management, not a strategy edge; directly attacks the net-negative
profitability gate; strong free tier matters for the growth narrative.

**Supabase (optional, fallback-safe):**
`ALTER TABLE agent_trades ADD COLUMN parent_id text, ADD COLUMN exit_seq int;`

**Files:** exec `logic.mjs` (`evaluateExit` + tests) · exec `index.js`
(`monitorPosition` uses it; `closePosition` partial path; entry seeds new state) ·
AgentView Config (TP1/TP2 + trailing inputs).

---

## #1 — Signal Webhook Ingestion (TradingView / bring-your-own-signal)

**Auth:** TradingView/external signals can't wallet-sign, so auth = a per-user **secret token
in the webhook URL** (3Commas/TV pattern). Safe: the token only authorizes order placement on
the user's **order-only key** (can't withdraw) and is rotatable. Optional `passphrase` in body
reduces URL-leak risk.

**Execution — reuse the cron, no inline order:** the handler validates + writes a signal to KV;
`nexus-agent-exec` picks it up next tick through the untouched pipeline → inherits every
guardrail (daily-loss cap, max trades, cooldown, kill switch) for free.
- Tradeoff: ~≤60s latency (1-min cron). Fine for swing/funding alerts. v2 = shorter cron or
  inline execution via a shared module.

**KV (`NEXUS_AGENT`):**
- `agent:webhook:{token}` → `{ address, passphrase, enabled, createdAt }` (token = 32-byte URL-safe)
- `agent:webhook_signal:{address}` → normalized signal, short TTL; exec checks this **before**
  the brain's `agent:signal:{address}` (user signal wins).

**Endpoints (lab-api):**
- `POST /agent/:address/webhook/enable` — walletSig `requireOwner`; mints token+passphrase,
  returns full URL. **PRO-gated.**
- `POST /agent/:address/webhook/rotate` · `/disable` — walletSig `requireOwner`.
- `POST /agent/hook/:token` — the webhook. Token-authed (no walletSig). Body
  `{ symbol, action: BUY|SELL|CLOSE, passphrase, size?, id? }`. Validate passphrase + enabled →
  normalize → KV write. Respond <3s (TV timeout).
- `GET /agent/:address` **never returns the token** (secret returned only on enable/rotate).

**Pure/tested (`logic.mjs`):** `parseWebhookAlert(body, config)` →
`{ symbol, direction, action, sizeOverride }` with symbol allowlist validation
(`config.symbols` / Orderly `/v1/public/info`), action mapping, replay/staleness guard
(require `id` or timestamp).

**Mode semantics:** respects the agent's existing mode — AUTONOMOUS executes, ASSISTED queues a
pending thesis, PAPER simulates. Tag `source:"WEBHOOK"` so feed/leaderboard can label "external
signal" and (later) keep a separate track record from the Nexus brain.

**Frontend (AgentView Config):** "Signal Webhook" panel — enable, copy URL, passphrase,
rotate/disable, copy-paste TradingView alert JSON template.

---

## #3 — DCA / Safety Orders  (PRO mode, ship last)

**Concept:** scale into a position — base order, then add on adverse moves (average down),
recompute TP off the new average. 3Commas' signature bot.

**Guardrails are the whole game** (averaging down fights cut-losses discipline):
- Config (PRO-gated): `baseOrderSize`, `safetyOrderSize`, `maxSafetyOrders`, `safetyOrderStepPct`,
  `safetyOrderVolumeScale` (martingale), `safetyOrderStepScale`, `dcaTakeProfitPct` (off avg).
- **`maxDailyLossUsdc` + kill switch stay absolute overrides** — they force-close regardless of
  averaging. No "just one more safety order" past the loss cap.
- **Capital pre-check at config-save:** total committed (base + scaled safety orders) must fit
  `freeCollateral` with buffer → reject up front (avoids -1101 margin error).
- Position state: `avg_entry`, `filled_safety_orders`, `total_qty`, `next_safety_price`.
- Pure/tested: `nextSafetyOrder(pos, price, dcaConfig)` →
  `{ shouldAdd, size, newAvg, newQty, nextTrigger }` and `dcaTakeProfitPrice(avg, pct, dir)`.
- Grading: one position, first entry → final close, blended avg entry, single honest row.
- **Server-enforced PRO gate** like MOMENTUM/MEAN_REVERSION (402 `pro_strategy_locked` via
  `walletIsPro`; add to `PRO_AGENT_STRATEGIES`).

---

## Cross-cutting
- All money-path functions → `logic.mjs` + `node:test` (covers the REAL deployed code).
- All three flow through existing trustless grading → results stay publicly verifiable.
- Deploy: workers via `npx wrangler deploy` (commit so CI's deploy.yml doesn't overwrite);
  frontend via push to `main`.
