# Smart Money — on-chain trader indexing + signal discovery (spec)

Status: PROPOSED (not built). Author handoff spec.

## One-liner
Index the best on-chain perp traders, grade them with the SAME trustless engine
that grades Nexus users, stream their moves, and let a user turn any move into a
**risk-managed, on-chain-graded directive** in one click. Not "whale watching" —
**graded smart money → managed copy → trustless proof.**

## Why this is on-strategy (read before scoping)
- **It fixes cold-start.** The native feed/boards only populate when *our* users
  act (thin by design). On-chain order flow is already full of real activity —
  so this surface is **live and valuable from day one**, and funnels those users
  into our graded ecosystem.
- **It's mostly assembly of what we already own** (see "Reuse map"). The only
  genuinely new infra is the Phase 2 real-time stream.
- **The wedge vs Nansen/GMGN/Hyperdash/Arkham:** everyone shows "big wallet." We
  show **graded wallet** (risk-adjusted, sample-gated — the `/analyze` engine),
  and the "copy" isn't a dumb mirror — it arms a **directive** the agent manages
  to an exit and grades on-chain. Nobody else closes that loop.

## ⚠️ Data reality (the constraint that shapes everything)
- **Orderly (our own DEX) CANNOT be indexed this way.** Per-address position
  history is private-auth; there is no public per-wallet endpoint. (This is why
  we grade CALLS vs public price, not personal trades — see CLAUDE.md.)
- **Hyperliquid IS the source.** HL exposes public per-wallet positions + fills +
  a public leaderboard + a websocket. We already tap HL for the `/analyze` wallet
  x-ray, so the ingestion + grading path exists.
- **Copy is cross-venue + directional, not a mirror.** Signal is observed on HL;
  execution happens on Nexus/Orderly. Prices/liquidity differ → we copy
  *symbol + side + (optional) levels*, NOT identical fills. Our directive engine
  already does exactly this. **Frame it as "trade the same thesis," never
  "mirror the whale."**
- **Latency edge decays.** Whales are faster than index→stream→user-reaction.
  Position this as **discovery + context** ("who is moving, and the setup"), NOT
  "front-run smart money." Overpromising here burns the "verify, don't trust"
  trust that is the whole brand.

## Reuse map (what already exists)
| Need | Existing piece |
|---|---|
| Ingest + grade a HL wallet | `/analyze` wallet x-ray engine (HL public API → composite score, Sharpe/Sortino gated by sample size) |
| "Copy" a signal | Feed copy + **directive engine** (`agent:directive:{addr}`, `POST /agent/:a/directive`, thesis `▶ TRADE`) → managed exit + on-chain grade |
| Real-time-ish polling + toasts | LiveNow (`/agents/live`) + `LiveAlerts.tsx` global toasts + opt-in OS Notification |
| Spike detection inputs | brain already logs `oi:hist:{symbol}` + `market:prev:{symbol}` (price/OI deltas) |
| Worker + KV pattern | lab-api + `NEXUS_AGENT` / `LAB_STORE` KV, cron workers |

---

## Hyperliquid API reference (verify exact shapes at build time)
- **Leaderboard (address discovery):** `GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard`
  → public JSON of top traders by PnL / ROI / volume over windows. Seed the
  tracked set from here + a curated smart-money watchlist.
- **Per-wallet state:** `POST https://api.hyperliquid.xyz/info`
  - `{ "type": "clearinghouseState", "user": "0x…" }` → open positions, margin.
  - `{ "type": "userFills", "user": "0x…" }` → recent fills (entries/exits).
- **Market data:** `{ "type": "metaAndAssetCtxs" }` → mark, funding, OI, volume per
  asset (for spike detection + context).
- **Websocket (Phase 2):** `wss://api.hyperliquid.xyz/ws`
  - subscribe `{ "method":"subscribe","subscription":{"type":"userFills","user":"0x…"} }`
    → per-wallet fills the instant they land.
  - `{"type":"trades","coin":"BTC"}` / `activeAssetCtx` for market-wide flow.

---

## PHASE 1 — Smart Money board (ships on existing infra, ~$0)
**Goal:** a populated, valuable discovery surface with one-click copy, no new
streaming infra. "Near real-time" = 1-min cron (Cloudflare cron floor).

### Data model (KV in `LAB_STORE`, or a dedicated namespace)
- `sm:watch` → JSON array of tracked HL addresses (leaderboard top-N ∪ curated).
- `sm:trader:{addr}` → `{ address, grade, score, winRate, avgR, sampleN,
  pnl30d, lastSeen, displayName? }` — the x-ray grade snapshot (refreshed on a
  slow cron, e.g. hourly).
- `sm:pos:{addr}` → last-seen open positions snapshot `[{coin,side,szUsd,entry,
  lev,openedAt}]` (used to diff for NEW opens).
- `sm:events` → capped ring buffer of recent signal events (newest first):
  `{ id, ts, type: "OPEN"|"CLOSE"|"ADD"|"SPIKE", addr, grade, coin, side,
     szUsd, price, note }`.
- `sm:spike:{coin}` → last spike state (dedupe).

### Workers
1. **sm-indexer (new cron worker, every 1 min)**
   - Load `sm:watch`. Bounded-concurrency batches (reuse exec's `BATCH_SIZE`
     pattern) — POST `clearinghouseState` + `userFills` per address.
   - Diff vs `sm:pos:{addr}` → emit `OPEN` / `ADD` / `CLOSE` events into
     `sm:events` (only for **graded** traders above a grade floor — this is the
     filter that makes it "smart money," not noise).
   - Pull `metaAndAssetCtxs`; run **spike detection** off `oi:hist`/`market:prev`
     (volume spike = 24h vol z-score over rolling; OI spike = Δ%). Emit `SPIKE`
     events, deduped via `sm:spike:{coin}`.
   - ⚠️ Subrequest budget: cap tracked set (e.g. top 50–100) so per-tick
     subrequests stay within Worker limits (same ceiling story as exec).
2. **sm-grader (new cron, hourly)** — refresh `sm:trader:{addr}` grades via the
   x-ray engine so ranking stays current without hammering per-minute.
3. **lab-api routes (add):**
   - `GET /smart/board` → ranked traders (by grade) + their open positions.
   - `GET /smart/events?since=` → recent signal feed (OPEN/CLOSE/SPIKE).
   - `GET /smart/trader/:addr` → full x-ray (reuse `/analyze`) + live positions.

### Frontend (new Lab tab, e.g. `[ SMART MONEY ]`, id `smart`)
- **Signal feed** (top): live-ish stream of graded opens/closes/spikes, 30–60s
  poll (reuse LiveNow/LiveAlerts pattern), fail-soft. Each row shows trader
  glyph+grade, coin, side, size, and **⚡ TRADE THIS**.
- **Smart Money board** (below): traders ranked by *graded* record, each
  expandable to their live positions + x-ray link.
- **⚡ TRADE THIS** → prefill the **directive** panel (symbol + side + optional
  levels from the observed trade) → PAPER-first → agent manages exit → graded
  on-chain. (Reuses `deployDirectiveFromThesis` plumbing.)
- Global **LiveAlerts** already exists → extend it to surface `SPIKE` / high-grade
  `OPEN` events as opt-in toasts.

**Phase 1 cost: ~$0.** Existing cron Workers + KV. HL data is free/public.

---

## PHASE 2 — real-time stream (the one infra bet; costs money)
**Goal:** sub-second "fired the second it happens," not 1-min polling.

### Mechanism
- A **Durable Object** (`SmartStream`) holds a persistent HL **websocket**
  (`wss://api.hyperliquid.xyz/ws`), subscribes `userFills` for the tracked set
  (+ market `trades`/`activeAssetCtx` for spikes).
- On each fill: grade-filter → write event to `sm:events` → **fan out** to
  connected browser clients (WS/SSE) and to LiveAlerts. Enable **WebSocket
  Hibernation** so the DO only bills when messages arrive.
- Alternative if DO cost/complexity bites: a **$5/mo tiny VPS** (Fly/Hetzner)
  holds the HL socket and POSTs events to a lab-api ingest route. Often cheaper
  and simpler for a single persistent connection.

### 💰 Cost
- **Data:** free (HL public). No provider fee.
- **Compute:** an always-on connection = continuous-ish billing. Cloudflare
  Workers Paid = **$5/mo base**; the streaming DO adds an estimated **~$5–30/mo**
  depending on message volume + fan-out (hibernation cuts idle cost).
- **Verdict:** low-tens-of-dollars/month. **Defer until revenue supports it**
  (same posture as the parked Coinglass sub). Phase 1 delivers most of the value
  for free; Phase 2 is a polish/latency upgrade, not a prerequisite.

---

## Positioning / copy (keep it honest)
- ✅ "Graded smart money — proven by the same trustless engine that grades you."
- ✅ "Discovery + context. See who's moving and the setup."
- ✅ "Turn any move into a risk-managed, on-chain-graded trade."
- ❌ Never: "front-run whales," "mirror exactly," or any implied guaranteed return.

## Open questions / risks
- **Grade floor for "smart":** what score/sample gate qualifies a wallet? (Start
  strict — a small set of genuinely-graded traders beats a noisy top-100.)
- **Address discovery beyond the leaderboard:** curate a watchlist; consider
  letting PRO users add addresses to track (ties into Emerald).
- **Cross-venue expectation-setting** in the UI (HL signal → Orderly execution).
- **Subrequest ceiling** on the indexer as the tracked set grows (time-shard or
  Queues past ~100 addresses).
- **Multi-chain later?** Same model could extend to other public-flow venues, but
  each needs its own indexer — do HL well first.
