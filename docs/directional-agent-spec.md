# Directional Agent Mode ("Trade My Exact Thesis") — Build Spec

Status: **PROPOSED** (design only — no code yet)
Author: co-CEO / tech-lead pass, 2026-07-07
Related: `agentPrefill.ts` honesty fix (commit `735f98f`), `docs/3commas-adaptations-spec.md`,
`docs/bankr-agent-spec.md`, exec `agent:webhook_signal` path.

---

## 1. Why this exists

Today the agent is **signal-driven**: the brain (`deriveSignal`) decides direction from
funding/OI, and the user only tunes the *strategy* and *risk seatbelts*. When a user pushes a
thesis to the agent (the `⚡ AUTOMATE` button), the agent watches that **symbol** and may enter
**either direction** — it does **not** place the user's directional call. We just shipped the
honesty banner (commit `735f98f`) so users aren't surprised by that. This spec closes the gap the
banner apologizes for.

**Directional mode** lets a user hand the agent a *specific directional trade* — "LONG BTC, entry
95,000, stop 93,000, TP 98,000" — and have the agent **execute that exact trade** and then apply
its full exit engine to manage it. It is a **one-shot managed order**, not a strategy.

### Why not just use the Thesis Engine's existing "DEPLOY (LIVE)"?
The Thesis Engine already places a LIMIT entry + a static Orderly `POSITIONAL_TP_SL` bracket
([ThesisView.tsx](../app/pages/lab/ThesisView.tsx) `deployLive`). Directional mode is **strictly
more**: the agent *manages* the position instead of leaving a fixed bracket on the exchange —

| | Thesis "DEPLOY (LIVE)" | Directional Agent Mode |
|---|---|---|
| Entry | Limit order | Market-now **or** triggered limit |
| Exit | Static TP/SL bracket | `evaluateExit`: multi-TP scale-out, trailing stop, breakeven, timeout |
| Seatbelts | None (raw order) | Daily-loss cap, max-hold, kill switch, reconcile/self-heal |
| Track record | Not graded | Logged to `agent_trades` → graded leaderboard + verifiable ledger |
| Lifecycle | Fire-and-forget | Continuously managed, then stops |

So directional mode = **the user's conviction + the agent's operational rigor.** That combination
is the actual "plan → automate → grade" loop the product is sold on.

---

## 2. Core model: a **Directive** (not a signalMode)

A directional trade is **not** a new `signalMode` — signal modes are ways the brain *derives*
direction. A directive **bypasses derivation entirely**. Model it as a first-class **intent**,
architecturally identical to the existing webhook one-shot, with richer fields.

### 2.1 Intent shape — `agent:directive:{address}` (KV, single active directive)

```jsonc
{
  "id": "dir_1720370000000",
  "symbol": "PERP_BTC_USDC",
  "direction": "LONG",              // HONORED verbatim — the whole point
  "source": "THESIS",              // THESIS | MANUAL | BANKR (audit/label)
  "thesisId": "1720360000000",     // optional back-link to the source thesis

  // Entry
  "entryType": "MARKET",           // MARKET = fill next tick at mark; LIMIT = wait for trigger
  "entryPrice": 95000,             // required for LIMIT; informational for MARKET
  "entryTolerancePct": 0.15,       // LIMIT: fill when mark is within/through this band
  "maxChasePct": 1.0,              // LIMIT: refuse to fill if mark is already this far through

  // Exit (absolute prices from the thesis; exec converts to % off the FILL price)
  "stopLoss": 93000,
  "takeProfit1": 98000,
  "takeProfit2": 102000,           // optional → becomes the runner leg of the TP ladder
  "tp1SizePct": 50,                // scale out this % at TP1, run the rest to TP2/trail

  // Sizing (per-directive override of standing config; falls back to config)
  "leverage": 5,
  "capitalPerTrade": 30,           // margin; UI suggests floor(freeCollateral*0.6)

  // Lifecycle
  "status": "ARMED",               // ARMED → LIVE → DONE (see §2.2)
  "validUntil": 1720456400000,     // ARMED expiry — never fire a stale directive
  "createdAt": 1720370000000
}
```

`capitalPerTrade` on the directive is opt-in and defaults to the user's standing
`config.capitalPerTrade`. We do **not** silently derive it from the thesis's notional (thesis
account size ≠ agent balance → Orderly `-1101 margin insufficient`; see the honesty fix's comment).
The UI surfaces the `floor(freeCollateral*0.6)` guardrail the same way the config tab does.

### 2.2 Lifecycle

```
        create (POST /agent/:a/directive)
                    │
                    ▼
      ┌──────────  ARMED  ──────────┐
      │  MARKET: fill next tick     │  cancel / expire (validUntil) → deleted
      │  LIMIT: fill when mark       │
      │  crosses entryPrice          │
      └────────────┬────────────────┘
                   ▼ (enterPosition, direction honored)
                 LIVE  ── managed by evaluateExit (TP ladder / trail / BE / SL / TIMEOUT)
                   │      reconcile + daily-loss cap + kill switch all apply
                   ▼ (closePosition)
                 DONE  ── logged to agent_trades, feed thesis resolved, directive cleared
                   │
                   ▼
     one-shot: agent returns to idle (or deactivates if it was a pure directive session).
     Never re-enters. A signal-mode agent resumes signal scanning on the next tick.
```

---

## 3. Execution engine changes (`nexus-agent-exec`)

The directive slots into `processUser` in the **same slot as the webhook intent** (before the
brain-signal read), because the machinery is the same: user-authored, priority over the brain,
one-shot, flows through the normal mode logic + guardrails.

### 3.1 `processUser` — new block, placed right after the webhook-intent block

```
// ── DIRECTIVE (user's exact directional trade) ────────────
const dirRaw = await env.NEXUS_AGENT.get(`agent:directive:${address}`);
if (dirRaw) {
  const dir = JSON.parse(dirRaw);

  // Expired ARMED directive → drop it (never fill stale).
  if (dir.status === "ARMED" && now > dir.validUntil) {
    await env.NEXUS_AGENT.delete(`agent:directive:${address}`);
  } else if (dir.status === "ARMED" && !state.current_position) {
    // Entry gate (pure — testable in logic.mjs; see §6).
    const mark = await getMarkPrice(dir.symbol, env, cache);
    if (directiveShouldFill(dir, mark)) {
      // Build a webhook-style signal so it inherits mode + guardrails, PLUS an
      // override bundle so enterPosition sizes/levels from the directive not config.
      directiveSignal = {
        symbol: dir.symbol, direction: dir.direction, confidence: 100,
        source: "DIRECTIVE", timestamp: now, directive: dir,
      };
    }
    // else: still ARMED, waiting for the trigger — persist next_check for UI and return.
  }
  // A LIVE directive is just a normal open position — monitorPosition handles it.
}
```

`directiveSignal`, if set, is used exactly where `whSignal` is used today: it **suppresses the
brain read**, **bypasses the cooldown** (`source !== "WEBHOOK"` guard becomes `source is user-
authored`), and dispatches through the existing **mode switch** (PAPER simulates, ASSISTED writes a
pending thesis, AUTONOMOUS executes). AUTONOMOUS still requires the trading key exactly as now.

### 3.2 `enterPosition` — accept per-entry overrides

`enterPosition` currently reads `config.leverage`, `config.capitalPerTrade`, `config.tpPercent`,
`config.slPercent`. Add an optional `overrides` derived from `signal.directive`:

- **leverage / capitalPerTrade**: `overrides.leverage ?? config.leverage`, same for capital.
- **TP/SL**: convert the directive's **absolute prices** to % **off the actual fill (`markPrice`)**,
  not off the thesis's planned entry — a market fill can differ from the plan:
  - `slPercent = |markPrice − stopLoss| / markPrice * 100`
  - `tpPercent = |takeProfit1 − markPrice| / markPrice * 100`
- **TP ladder**: if `takeProfit2` present, build
  `takeProfits = [{pct: tp1%, sizePct: tp1SizePct}, {pct: tp2%, sizePct: 100}]`; else single TP.
  This reuses `normTakeProfits` + the existing multi-TP monitor unchanged.
- **Direction sign check**: guard that `stopLoss`/`takeProfit1` are on the correct sides for the
  direction (LONG: stop < entry < tp). If inverted, refuse the entry and mark the directive
  `DONE` with an error reason (surfaced in the UI) rather than entering a nonsensical trade.

Because the monitor already resolves exits **per-position** (`pos.tpPercent`, `pos.takeProfits`
were stamped at entry — see [index.js](../workers/nexus-agent-exec/index.js) `monitorPosition`),
**no monitor changes are required.** Only entry sizing/level-resolution needs the override.

### 3.3 One-shot semantics on close

In `closePosition`, if the closed position originated from a directive
(`pos.directive_id`), after logging: delete `agent:directive:{address}` (or mark `DONE` with a
short TTL for UI display). If the agent has no standing signal config active (a "pure directive
session"), also flip `state.active = false` so it doesn't start signal-scanning. If signalMode was
already running, leave `active` true and let the brain resume. Store `pos.directive_id` at entry.

### 3.4 Coexistence rules (explicit)

- **One position at a time** stays invariant. A directive only fills when `!state.current_position`
  (same as webhook OPEN — no stacking).
- A LIVE directive **takes over** the position slot; the brain signal is ignored until DONE.
- **Kill switch** cancels an ARMED directive and closes a LIVE one (extend the kill block to
  `delete agent:directive` too).
- **Daily-loss cap** blocks a new directive fill just like any entry.

---

## 4. Brain (`nexus-agent-brain`) — **no change**

The brain never sees directives. It keeps writing `agent:signal` for signal-mode users. Directives
live entirely in the exec + lab-api. This keeps the single-writer discipline intact (brain owns
`agent:signal`, exec owns `agent:state`, lab-api owns `agent:directive`).

---

## 5. API (`nexus-lab-api`) — new owner-authed routes

All mutations require `walletSig = sign_message('nexus-trading-key-v1')` in the JSON body →
`requireOwner` ecrecover → 401 unless it resolves to `:address` (identical to every other agent
mutation — never accept the sig via query string).

- **`POST /agent/:address/directive`** `{ directive, walletSig, confirm? }`
  Validates the directive (symbol exists via `/v1/public/info`, direction ∈ {LONG,SHORT}, price
  sides correct, `validUntil` within a max horizon e.g. 7d). Writes `agent:directive:{address}`.
  **AUTONOMOUS directives require `confirm: "GO LIVE"`** (mirrors `bankr/activate`) — a real-money
  one-shot must be explicit. PAPER/ASSISTED need no confirm. Clears any stale `agent:kill`.
  Rejects if a directive is already ARMED/LIVE (one active directive; must cancel first).
- **`DELETE /agent/:address/directive`** `{ walletSig }` — cancel an ARMED directive (no-op on
  LIVE; to stop a LIVE one use the existing `/kill`, which now also clears the directive).
- **`GET /agent/:address`** — extend the existing public read to merge the current directive
  (read-only) into the response so the UI can render it, same as it merges `agent:signal`.

Bankr parity: add a `directive` action to the skill (`docs/bankr-skill-agent-module.md`) so a
Farcaster user can say "long BTC entry 95k stop 93k tp 98k, managed" — same auth (walletSig),
same `GO LIVE` gate.

---

## 6. Testing (pure-logic-first, `node:test` — repo convention)

Extract the decision points into `logic.mjs` so tests cover the real deployed code:

- **`directiveShouldFill(directive, markPrice)`** (exec logic.mjs):
  - MARKET → always true (fills next tick).
  - LIMIT LONG → true when `mark <= entryPrice*(1+tol)` **and** `mark >= entryPrice*(1-maxChase)`.
  - LIMIT SHORT → mirror. Never fills past `maxChase` (don't chase a runaway).
- **`directiveLevels(directive, fillPrice)`** → `{ tpPercent, slPercent, takeProfits }` with the
  price→% conversion and the direction-side sanity guard (returns `{ error }` if inverted).
- **`directiveExpired(directive, now)`**.
- Extend existing exit tests: a directive position exits via the **same** `evaluateExit` path, so
  add one integration-style test asserting a LONG directive with TP1/TP2 scales out then runs.

Guardrail tests (daily cap, kill, one-position) already exist — assert they also gate directives.

---

## 7. UI

### 7.1 Thesis card — a second, clearly-distinct action
Today's card has one agent action: **`⚡ AUTOMATE`** (watch this symbol on signals — the honest
label we just shipped). Add a second:

- **`▶ TRADE (managed)`** → creates a **directive** from the thesis's exact direction/entry/stop/
  TP1/TP2 and jumps to the Agent tab's new Directive panel for review + confirm.

Two buttons, two honest promises: *automate the symbol* vs *execute this exact call*. This is the
payoff of the honesty work — the button that means "trade my thesis" now actually does.

### 7.2 AgentView — a **DIRECTIVE** panel (new)
- Shows the ARMED/LIVE directive: symbol, direction (color-coded), entry type + trigger price,
  TP ladder, stop, leverage, capital, and `validUntil` countdown.
- ARMED → **CANCEL** button (`DELETE /agent/:a/directive`).
- LIVE → shows the managed position (reuse the existing position card) + the standard KILL.
- Reuse the `⚠` expectation-banner component from the honesty fix, inverted: for a directive it
  **confirms** "this will enter LONG as written and manage to your TP/SL" — the reassurance the
  signal path can't give.
- Mode selector still applies: PAPER directive (simulate the managed trade — great for validating
  the entry/exit before real money), ASSISTED (queue as a pending thesis), AUTONOMOUS (real, gated
  by `GO LIVE`).

### 7.3 `agentPrefill.ts`
Add `deployDirectiveFromThesis(thesis)` alongside `thesisToAgentConfig`, writing a directive-prefill
key the Agent tab consumes into the Directive panel (parallel to the existing config-prefill bridge).

---

## 8. Edge cases & decisions

- **Fill slippage**: MARKET entry fills at mark, which may differ from the thesis entry. We convert
  TP/SL to % **off the fill** so R:R geometry is preserved relative to the actual entry, not the
  plan. UI should show "filled at X (planned Y)".
- **ARMED never triggers**: `validUntil` (default e.g. 24h, max 7d) expires it. Surfaced as
  `DONE: expired` in the UI.
- **Symbol already has a signal-mode position open**: directive waits (ARMED) until flat, or the
  user cancels. No stacking, ever.
- **Direction inverts the levels** (stop above entry on a LONG): rejected at both API validation
  and entry-time (`directiveLevels` error) — never enter a self-contradicting trade.
- **PAPER first**: default the thesis `▶ TRADE (managed)` to PAPER unless the agent is already
  AUTONOMOUS, so users can watch the managed lifecycle risk-free before committing (matches the
  product's "start risk-free" default).

---

## 9. Rollout phases

- **Phase 1 — MARKET directives, PAPER+AUTONOMOUS** (core, ~3–4d): intent model, `POST/DELETE
  /directive` (owner-authed + `GO LIVE`), exec directive block + `enterPosition` overrides +
  one-shot close, `directiveShouldFill`/`directiveLevels` + tests, AgentView Directive panel,
  thesis `▶ TRADE (managed)` button. Ships the whole promise for market entries.
- **Phase 2 — LIMIT/triggered entries** (~2d): `entryType: LIMIT`, per-tick trigger check,
  `maxChase` guard, ARMED countdown UI. This is what makes "entry 95,000" literal.
- **Phase 3 — Bankr parity** (~1d): `directive` skill action + refs, same auth + `GO LIVE`.
- **Phase 4 — multi-directive / sub-accounts** (deferred): concurrent directives need one Orderly
  sub-account per position — sequence this **after** the single-directive path is proven, same
  reasoning as multi-strategy concurrency in `strategy-workbench-and-followups`.

---

## 10. What this deliberately does NOT do

- Does not touch the brain, `deriveSignal`, or any signal-mode behavior.
- Does not remove or weaken any guardrail — directives ride the same seatbelts.
- Does not let a directive bypass ownership auth or the AUTONOMOUS `GO LIVE` gate.
- Does not auto-size from the thesis notional (the `-1101` trap).
- Does not add a new `signalMode` — a directive is an execution path, not a strategy.
```
