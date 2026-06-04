# Bankr Agent Control — Build Spec

> Level-up for the Bankr skill: let a Bankr/Farcaster user **deploy, fund, and
> control a non-custodial autonomous trading agent by chatting** — the agent can
> trade but never withdraw. Additive only; does not change existing skill routes.
> Status: SPEC (not yet built). API base: `https://og.nexustradinglabs.com`.

---

## 1. Why this works (the key insight)

The agent needs a delegated Orderly key stored server-side to trade while the user
is offline. The browser flow gets that key from localStorage — Bankr has no browser.
**But `bankr-register` already solves it:** it derives the ed25519 keypair from a
Bankr `personal_sign('nexus-trading-key-v1')`, registers it with Orderly
(`AddOrderlyKey`, scope `read,trading`, with expiration), and stores
`{ accountId, orderlyKey (public), seed (private) }` in KV.

So agent-via-Bankr = **reuse the registered wallet's `seed`**, encrypt it into the
agent key store, and the existing brain/exec run it. No new key ceremony.

**Key-format note for the builder:** exec's `orderlyRequest` does
`bs58.decode(keyData.tradingKey)` → 32-byte privkey. The registered `seed` is the
32-byte private seed (hex). So `agent:key.tradingKey = bs58.encode(seedBytes)`,
then encrypt with `AGENT_ENC_KEY` (AES-256-GCM, `v1:<iv>:<ct>`) → store at
`agent:key:{address}` in the `NEXUS_AGENT` namespace. Exactly the shape the browser
activation produces, just sourced from Bankr.

---

## 2. Auth & safety model

- **Activation / config writes** are authenticated by the **Bankr API key** (it
  proves the user controls the wallet — same trust basis as `bankr-register`/`/trade`).
- **Status reads** (`GET /agent/:address`) stay unauthenticated (already are; never
  returns the key — only config/state/trades).
- **Default mode = PAPER.** Activation never defaults to live.
- **Flip to AUTONOMOUS (live) requires explicit confirmation** — body `confirm: "GO LIVE"`.
  PAPER/ASSISTED flips are frictionless.
- **KILL always works**, no confirmation (it's the safety verb).
- Orderly delegated key is **order-only — cannot withdraw**. Every skill response
  that activates/funds should say this in plain language.

---

## 3. New endpoints (additive)

### `POST /agent/:address/bankr/activate`
Deploy (or re-arm) the agent for a Bankr-registered wallet.
```jsonc
// body
{
  "bankrApiKey": "…",            // auth + (if needed) auto-register
  "config": {                    // any omitted field → sensible default
    "symbols": ["PERP_BTC_USDC"],
    "leverage": 5,
    "capitalPerTrade": 30,
    "tpPercent": 1.5,
    "slPercent": 0.75,
    "maxHoldHours": 4,
    "maxTradesPerDay": 10,
    "maxDailyLossUsdc": 5,
    "fundingThreshold": 0.01
  },
  "mode": "PAPER",              // PAPER | ASSISTED | AUTONOMOUS (default PAPER)
  "confirm": "GO LIVE"          // REQUIRED only when mode === AUTONOMOUS
}
```
Server: ensure wallet registered (if `no_orderly_account` → run register with
`bankrApiKey` first) → read registered `seed`+`accountId` → bs58-encode + encrypt →
write `agent:config/key/state`, add to `agent:users`. Returns `{ ok, state, mode }`.
Rejects `mode:AUTONOMOUS` without `confirm:"GO LIVE"` → `409 { error:"confirm_required" }`.

### `POST /agent/:address/bankr/mode`
Change execution mode by chat. Gated for live.
```jsonc
{ "bankrApiKey": "…", "mode": "ASSISTED", "confirm": "GO LIVE" }
```
- `PAPER` / `ASSISTED` → apply immediately (ASSISTED = pause new entries, still
  manages an open position).
- `AUTONOMOUS` → requires `confirm:"GO LIVE"`.
Returns `{ ok, mode }`.

### `GET /agent/:address`  *(exists — no change)*
"How's my agent?" → `{ config, state, trades, pending }`. `state` has
`active`, `mode` (via config), `current_position`, `daily_pnl`, `trades_today`,
`last_signal`. Never includes the key. Skill formats this into a status line.

### `DELETE /agent/:address`  *(exists)*
"Stop my agent" → deactivate + delete key. ⚠️ leaves an open position unmanaged —
skill must warn and offer KILL instead if a position is open.

### `POST /agent/:address/kill`  *(exists)*
"Kill my agent / close everything" → closes position + deletes key + deactivates.
Always allowed.

### Fund flow — reuse `POST /deposit/prepare`  *(exists)*
"Fund my agent $50" → returns approve + `vault.deposit` txs; Bankr signs/submits.
**Add a capital guardrail** (the −1101 margin lesson): after deposit (or on
activate), if `capitalPerTrade > ~60% of free collateral`, the skill suggests a
lower `capitalPerTrade` so margin has a buffer. Rule of thumb:
`suggestedCapital = floor(freeCollateral * 0.6)` (margin = capitalPerTrade; notional
= capital × leverage). Never let a chat set capital that will margin-reject.

---

## 4. Intent → action mapping (for the Bankr skill)

| User says | Action |
|---|---|
| "Deploy my Nexus agent, paper, BTC+ETH, $30/trade 5x" | `POST /agent/:addr/bankr/activate` `{config, mode:PAPER}` |
| "Make my agent live / go autonomous" | `POST …/bankr/mode` `{mode:AUTONOMOUS, confirm:"GO LIVE"}` (skill asks user to confirm first) |
| "Pause my agent" | `POST …/bankr/mode` `{mode:ASSISTED}` |
| "Set my agent to $20/trade at 3x" | `POST …/bankr/activate` or `PUT /agent/:addr/config` `{config}` |
| "How's my agent doing?" | `GET /agent/:addr` → format status |
| "Fund my agent $50" | `POST /deposit/prepare` → sign+submit → suggest capital |
| "Stop my agent" | `DELETE /agent/:addr` (warn if position open) |
| "Kill it / close everything" | `POST /agent/:addr/kill` |
| "Top Nexus agents" | `GET /agents/leaderboard` (read) |
| "What's my agent's record" | `GET /agent/:addr` trades + `GET /agents/ledger` for proof |

---

## 5. Skill response copy (the voice the Bankr agent uses)

- **On activate (paper):** "✅ Agent deployed in PAPER mode on BTC, ETH — $30/trade,
  5x, TP +1.5% / SL −0.75%. Simulated, zero capital at risk. Say 'go live' when you
  want it trading real size."
- **On go-live confirm:** "⚠️ This will trade real funds within your limits. The key
  is order-only — it can never withdraw. Reply 'GO LIVE' to confirm." → then activate.
- **On status:** "🟢 AUTONOMOUS · watching BTC,ETH · 3 trades today · +$0.84 · flat
  right now (no confluence signal)."
- **On fund:** "Funding your Orderly account with $50 (2 txs to sign). This is *your*
  account — the agent trades it but can't withdraw. Suggested size: $30/trade so
  margin keeps a buffer."

---

## 6. Build checklist (phased)

**Phase A — activation (the headline):**
- [ ] `POST /agent/:address/bankr/activate` — register-if-needed, reuse seed,
      bs58-encode, AES-GCM encrypt → `agent:key`, write config/state/users.
- [ ] AUTONOMOUS confirmation gate.
- [ ] Default config + PAPER default.
- [ ] Return a clean status object the skill can read back.

**Phase B — control + status:**
- [ ] `POST /agent/:address/bankr/mode` (gated live flip).
- [ ] Wire `GET /agent/:address`, `DELETE`, `/kill` into the skill intents (no API
      change — skill-side mapping only).
- [ ] Status formatter (state → one-line summary).

**Phase C — fund + guardrail:**
- [ ] Capital-buffer suggestion from free collateral (avoid −1101).
- [ ] "Fund my agent" intent → `/deposit/prepare` + post-deposit capital nudge.

**Phase D — reads (cheap polish):**
- [ ] Leaderboard / ledger / rep-score intents (all existing read endpoints).

**Phase E — skill doc + ship:**
- [ ] Update the Bankr Skill Reference PDF/doc with the agent section.
- [ ] Re-fork/update on the Bankr site.
- [ ] tsc + deploy lab-api (`npx wrangler deploy`) — ⚠️ commit worker changes so CI
      doesn't overwrite (per CLAUDE.md).

---

## 7. Open decisions (for Stephen)

1. **Live-flip confirmation phrase** — `"GO LIVE"` ok, or something punchier?
2. **Should Bankr be allowed to flip AUTONOMOUS at all**, or cap chat-control at
   PAPER/ASSISTED and force the live flip in the web UI? (Safest = chat can arm
   paper + manage + kill; live flip only in-app. Most powerful = chat can do it all
   with confirmation. My lean: allow it with confirmation — that's the demo-able
   "deploy a live bot from a tweet reply" moment.)
3. **Multi-symbol via chat** — parse "BTC and ETH" → multiple symbols, or one at a time?
4. **Key expiration** — registered keys have an `expiration`; when it lapses the agent
   silently stops. Want the skill to proactively warn / offer re-arm? (Ties to the
   deferred Phase-1b short-lived-key work.)
