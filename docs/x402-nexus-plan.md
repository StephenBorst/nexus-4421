# Nexus × Bankr x402 — integration plan

> Lean-into-Bankr play: expose Nexus's valuable, **unfakeable** data behind x402
> paywalls priced in **$NEXUS**, so other agents/apps pay-per-call. Gives $NEXUS
> real **consumptive utility** (pay-to-use, Howey-safe — NOT an investment claim)
> and deepens us into Bankr's payment stack. Blocked only on Bankr's x402-cloud API.

## Why this is the right Bankr bet
- **$NEXUS consumptive utility, finally.** Pricing endpoints in $NEXUS = pay-to-use.
  That's the cleanest possible token utility on the right side of the Howey line —
  demand from *usage*, not speculation. Bankr's "any coin" layer auto-swaps so
  callers don't even need to hold $NEXUS; it still settles to us.
- **We sell the one thing nobody else can: provably-real data.** Our leaderboards
  and ledgers are graded from public price + anchored on-chain. An agent buying
  trading-signal data from us is buying *unfakeable* track records.
- **Deepens the relationship.** We're not just consuming Bankr's LLM gateway — we
  build our token into their x402 rail. Good story for facu/edit + dev-console.

## Pilot scope (one endpoint first)
Monetize the **verified-caller / leaderboard data** (`GET /theses/leaderboard`,
`/agents/ledger`, `/agents/live`) via an x402 paywall priced in $NEXUS. Smallest
surface, highest "only Nexus has this" value. Expand later to market intel
(`/analyze`, regime), agent signals, and hosted AI.

## How x402 works (open standard)
1. Client requests the resource with no payment → server returns **HTTP 402** with
   an `accepts` array: `{scheme, network, maxAmountRequired, asset (token), payTo,
   resource, maxTimeoutSeconds, …}`.
2. Client pays and retries with an **`X-PAYMENT`** header (signed payment payload).
3. Server verifies + settles via a **facilitator**, returns the resource +
   `X-PAYMENT-RESPONSE`.

Bankr's **x402 cloud = the facilitator + "any coin" auto-swap layer.** We own the
402 challenge + gated data; Bankr verifies/settles.

## What we build on our side (lab-api, ready once unblocked)
- A paywalled route variant: if no valid `X-PAYMENT`, return `402` with our
  payment requirements (asset = $NEXUS on Base, `payTo` = treasury Safe
  `0x4Fe2…C733`, price set per endpoint).
- On `X-PAYMENT`: verify via Bankr facilitator → serve the data.
- Config: `X402_FACILITATOR` (Bankr's verify/settle URL) + the `bk_` key, as worker
  secrets (same pattern as `BANKR_LLM_KEY`).

## ⚠️ UNBLOCK — what we need from Bankr (bankr.bot/x402 + their docs)
1. **Facilitator API:** the verify/settle endpoint URL(s) + request/response shape
   (or an SDK). This is the part we can't infer.
2. **Registration model:** do we run our own endpoint pointing at their facilitator,
   or register the endpoint *on* their x402 cloud dashboard? Which?
3. **Pricing in $NEXUS:** how to denominate the price in $NEXUS (contract
   `0x3D958634ab725B627919EF8F2Ed59227309fDba3`, Base) + confirm any-coin auto-swap
   settles to our `payTo`.
4. **Auth:** does it reuse the existing `bk_` LLM-gateway key, or a separate x402 key
   (bankr.bot/api-keys)?
5. **Networks/tokens supported** for `payTo` settlement (Base USDC vs $NEXUS direct).

Once 1–5 are answered, the lab-api side is ~1 day.
