# Nexus × Bankr x402 — paid data APIs, priced in $NEXUS

Nexus's **unfakeable** trading data, sold pay-per-call to agents/apps via Bankr's
x402 cloud — priced in **$NEXUS**. Bankr hosts the endpoint + the entire payment
layer (402 → wallet signs → verify → settle); we just supply the handler + config.

**Why this matters:** gives $NEXUS its first **consumptive utility** (pay-to-use,
Howey-safe — demand from usage, not speculation) and is the deepest "build on
Bankr" integration. We sell the one thing no competitor can: data graded from
public price + anchored on-chain.

## Endpoints (tiered — premium = the alpha)

| Service | Data | Price | Why |
|---|---|---|---|
| `nexus-callers` | Verified-caller leaderboard (graded, anchored) | 10,000 $NEXUS | Provably-real track records |
| `nexus-agents-live` | LIVE NOW open positions, uPnL from public price | 10,000 $NEXUS | Real-time, verifiable |
| **`nexus-signals`** | **Funding + OI-divergence reads (the agent's edge)** | **50,000 $NEXUS** | **The alpha, as data** |

Prices are in TOKEN units, not USD (Bankr resolves symbol/decimals from the
`tokenAddress` at deploy). ~$0.005 / $0.025 at current $NEXUS price — **tune them.**
$NEXUS = `0x3D958634ab725B627919EF8F2Ed59227309fDba3` (Base).

## Files
- `bankr.x402.json` — all three services (custom-token config).
- `nexus-callers.ts` · `nexus-agents-live.ts` · `nexus-signals.ts` — handlers.
  Each is a plain `Request → Response` that, after Bankr settles payment, fetches
  the corresponding `og.nexustradinglabs.com` endpoint and returns it.

## Deploy — two paths

**A) CLI (uses these files):**
```bash
npm i -g @bankr/cli
bankr login
bankr x402 deploy nexus-callers
bankr x402 deploy nexus-signals
bankr x402 deploy nexus-agents-live
```
→ live at `https://x402.bankr.bot/<your-wallet>/<service>`. Settlement books to the
wallet in the URL — **point it at the treasury Safe** (`0x4Fe2…C733`).

**B) Chat-deploy (Bankr writes the handler):**
> "Deploy an x402 endpoint `nexus-signals` that fetches
> `https://og.nexustradinglabs.com/signals` and returns the JSON, priced at
> 50000 $NEXUS (`0x3D958634ab725B627919EF8F2Ed59227309fDba3`) per request on Base."

## Backing endpoints (live on lab-api)
- `GET /theses/leaderboard` — verified callers + merit ranks + `meritRank`.
- `GET /agents/live` — open positions, uPnL from public mark.
- `GET /signals` — funding + OI-divergence + confluence, **same `confluenceSignal()`
  engine as the autonomous agent** (tested in `workers/nexus-lab-api/logic.test.mjs`).

## Notes
- **Fees:** free tier 1,000 req/mo (0%), Pro 5%. Pilot fits free.
- **Free web vs paid API:** the web surfaces stay free for humans; x402 is the
  machine-consumable, pay-per-call rail for agents (and where you can later gate
  real-time/depth as the premium tier).
- **Handler signature** follows the docs' "plain Request → Response (+ ctx)" model;
  chat-deploy (B) sidesteps any CLI shape mismatch — keep these `.ts` as the spec.
