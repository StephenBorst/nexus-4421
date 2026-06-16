# Nexus × Bankr x402 — pilot endpoint

First paid endpoint: **`nexus-callers`** — sells the trustless verified-caller
leaderboard (graded from public price, anchored on-chain) as a machine-readable
API, **priced in $NEXUS**. Bankr hosts the endpoint + the whole payment layer
(402 → wallet signs → verify → settle); we just supply the handler + config.

This gives $NEXUS its first **consumptive utility** (pay-to-use, Howey-safe) and
is the deepest "build on Bankr" integration.

## Files
- `bankr.x402.json` — service config. Priced in $NEXUS (`tokenAddress`
  `0x3D958634ab725B627919EF8F2Ed59227309fDba3`, Base). `price` is in TOKEN units,
  not USD — `"10000"` = 10,000 $NEXUS/request (~$0.005 at current price; **tune it**).
  Bankr resolves symbol/decimals from the address at deploy.
- `nexus-callers.ts` — the handler. Plain `Request → Response`; after Bankr settles
  payment it fetches `og.nexustradinglabs.com/theses/leaderboard` and returns it
  (with a `verify` link to the ledger). The data is already public + unfakeable.

## Deploy — two paths

**A) CLI (uses these files):**
```bash
npm i -g @bankr/cli
bankr login
bankr x402 deploy nexus-callers
```
→ live at `https://x402.bankr.bot/<your-wallet>/nexus-callers`. Settlement books to
the wallet in the URL — use the **treasury Safe** or the subs receiver.

**B) Chat-deploy (Bankr writes the handler):**
> "Deploy an x402 endpoint called `nexus-callers` that fetches
> `https://og.nexustradinglabs.com/theses/leaderboard` and returns the JSON,
> priced at 10000 $NEXUS (`0x3D958634ab725B627919EF8F2Ed59227309fDba3`) per
> request on Base."

## Notes / confirm with Bankr
- **Handler signature** (`export default (req, ctx) => Response`) follows the docs'
  "plain Request → Response (+ ctx)" model — if the CLI rejects it, chat-deploy (B)
  and Bankr writes the exact shape; keep `nexus-callers.ts` as the spec.
- **Fees:** free tier 1,000 req/mo (0%), Pro 5%. Pilot fits free.
- **Settlement wallet** = the `<wallet>` in the deployed URL — point it at treasury.

## Next endpoints (after the pilot proves the rail)
- `nexus-agents-live` → `/agents/live` (open positions w/ verifiable uPnL)
- `nexus-signals` → agent funding/OI signals (the real edge, machine-readable)
- `nexus-ai` → hosted inference, per-call in $NEXUS
