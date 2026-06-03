# Nexus Trading Labs — Project Memory

## What this is
An **Orderly Network white-label perp DEX** (`dex-creator-template`) heavily customized into
**Nexus Trading Labs**. The base DEX (markets, swap, vaults, portfolio, leaderboard, points,
rewards) comes from the Orderly SDK — that's the commodity layer. The **product / differentiation**
is everything built on top:

- **The Lab** (`app/pages/lab/index.tsx`) — the flagship. Tabs (6): Analytics, Agent, Thesis Engine,
  Market Intel, Copy Trades, Trade Log. Header brand: `// THE LAB`.
- **Thesis Engine** — position sizing, R:R, funding cost, live P&L, on-chain thesis registry.
- **Agent** — autonomous funding-edge trading bot. Modes: PAPER (simulated, default), ASSISTED
  (signals only), AUTONOMOUS (real orders). Guardrails: daily-loss cap, max trades/day, kill switch,
  order-only keys (cannot withdraw).
- **Social** — Feed, Trader profiles, Copy Trades, XMTP wallet-to-wallet DMs (`app/pages/messages`).
- **Messages** — global top-right envelope icon w/ live unread badge (`app/components/MessagesNavButton.tsx`),
  real-time via XMTP `streamAllMessages`. Deep-linked from Feed/Trader as `/messages?dm=0x…`.

## Stack
- React + Vite + react-router-dom, TypeScript. Orderly SDK (`@orderly.network/*`), `@xmtp/browser-sdk` v7, wagmi.
- Nav config + global chrome: `app/utils/config.tsx` (top-nav order is hardcoded by href in `NAV_HREF_ORDER`).
- Lab storage (theses/notes): `app/hooks/useLabStorage.ts` (Cloudflare KV via nexus-lab-api).
- XMTP: `app/hooks/useXMTP.ts` (env: `production`). Unread tracking: `app/utils/xmtpUnread.ts`.

## ⚠️ DEPLOYMENT — read before touching CI/CD
- **Live app** = Cloudflare **Pages** project **`nexus-trading-lab`** → domains `trade.nexustradinglabs.com`
  + `nexus-trading-lab.pages.dev`. **It has NO Git connection** — deployed ONLY by the custom GitHub
  Action `.github/workflows/deploy.yml` (wrangler direct-upload). Do NOT expect Git auto-builds here.
- `deploy.yml` (on push to main) builds the app, `wrangler pages deploy build/client`, AND deploys the
  **nexus-lab-api** worker. Install step retries 3x to survive registry flakes.
- **Redundant builds:** the "pages build and deployment" runs in the repo's GitHub Actions are **GitHub
  Pages** (GitHub's own built-in workflow), NOT Cloudflare. There is NO Cloudflare zombie project —
  `nexus-trading-lab` has no Git connection and is the only app Pages project. Fix = repo **Settings →
  Pages → Source: None** to stop them. Zero impact on Cloudflare/prod/code. (Cloudflare account has 7
  apps total: nexus-lab-api, nexus-trading-lab, nexus-agent-exec, nexus-agent-brain, nexus-landing,
  nexus-lab-alerts, orderly-proxy — all legit, none Git-connected to nexus-4421.)
- A "Build & Deploy" Action run failing fast (~21s) is almost always a transient `yarn install` flake,
  not a real break — the next push's superset deploy covers it.

## Cloudflare Workers (deploy with `npx wrangler deploy` in each dir; needs CF auth)
- **nexus-lab-api** (`workers/nexus-lab-api`) → `og.nexustradinglabs.com`. This is the `AGENT_API`
  (`https://og.nexustradinglabs.com`) the frontend calls. Serves `/agent/:address` (config/state/trades/
  pending), lab KV storage. Returns the full `state` object wholesale (so extra state fields ride along).
- **nexus-agent-exec** (`workers/nexus-agent-exec`) → cron every 1 min. Executes/monitors agent positions.
  PAPER mode simulates fills (no key, no real order) and records to `state.paper_trades` (separate from
  the live Supabase `agent_trades` table). KV namespace `NEXUS_AGENT` = c3c0582ec71c4d049d0795872f39f033.
- **nexus-agent-brain** → cron, generates funding/OI signals into `agent:signal:<addr>`.
- **nexus-lab-alerts** → alerts worker.
- **nexus-landing** (Pages) → `landing.nexustradinglabs.com`, separate repo `StephenBorst/nexus-landing`.

## Agent paper mode details
- Frontend default mode = PAPER (new users start risk-free). PAPER needs no trading key.
- Track records are kept strictly separate: LIVE (Supabase) vs PAPER (`state.paper_trades`, capped 50).
- API endpoints: `POST /agent/:address/paper/reset` (clear paper ledger), `POST /agent/:address/test-signal`
  (DEV-only force a paper signal; hard-refuses unless mode===PAPER). Force button is gated to
  `import.meta.env.DEV`.

## Agent multi-user build (Session 013 — 2026-05-30/31)
Migrated the single-user bot → full multi-user, non-custodial, autonomous agent. All committed to `main`.
- **Architecture:** `nexus-agent-brain` (5-min cron) iterates `agent:users`, evaluates **funding + OI-divergence
  confluence** per symbol (BOTH rules must agree — ported from the validated single-user `.bak`; the first
  multi-user brain had a stubbed `oi>0` check that fired on funding alone — fixed). Stores `market:prev:{symbol}`
  for price/OI deltas; evaluates each symbol ONCE per tick (no per-user race). `nexus-agent-exec` (1-min cron)
  reads `agent:signal:{address}`, enters/monitors/closes per user. AgentView in `app/pages/lab/index.tsx`.
- **⚠️ KV namespace gotcha (cost us hours):** brain/exec use binding `NEXUS_AGENT` = `c3c0582ec71c4d049d0795872f39f033`.
  The lab-api agent routes MUST use the SAME namespace — lab-api binds it as `NEXUS_AGENT` (also has `LAB_STORE`
  =`12c4fcbc...` for lab data). Agent keys: `agent:users`, `agent:config:{addr}`, `agent:key:{addr}`,
  `agent:state:{addr}`, `agent:signal:{addr}`, `agent:pending:{addr}`.
- **⚠️ AGENT_API URL:** frontend hits lab-api via custom domain **`https://og.nexustradinglabs.com`** (the
  `*.workers.dev` subdomain is NOT routed → 404/CF-1042). Same base as all other app API calls.
- **Orderly signing (ground truth, Handoff 012):** use `@noble/ed25519 signAsync()` + `bs58` (NOT `crypto.subtle`,
  which can't sign Orderly ed25519 seeds). Signature = **base64URL** (`+`→`-`, `/`→`_`, strip `=`). `orderly-key`
  header = the DERIVED public key (`ed25519:` + bs58(getPublicKeyAsync)), NOT a slice of the secret. GET requests
  need `Content-Type: application/x-www-form-urlencoded`; POST = `application/json`. Must POST `/v1/client/leverage`
  before each order (defaults to 1x). Market data: `GET /v1/public/futures/{symbol}` (mark_price, last_funding_rate,
  open_interest); step size from `GET /v1/public/info/{symbol}` (`base_tick`, `base_min`, `min_notional`).
- **⚠️ Order qty MUST snap cleanly to base_tick:** `Math.floor(q/tick)*tick` produces float artifacts
  (e.g. `0.0034000000000000007`) → Orderly **-1104 "does not match step size"** (intermittent, price-dependent).
  Fix: `parseFloat((steps*baseTick).toFixed(decimals))` where `decimals = -log10(baseTick)`. Also guard base_min/min_notional.
- **-1101 "margin insufficient"** = capitalPerTrade margin too close to account balance. Keep a buffer
  (balance ≈ $52 couldn't run $50 margin; dropped to $30/trade).
- **Key security (#1, Phase 1a DONE):** trading keys encrypted at rest with **AES-256-GCM** (Web Crypto, zero-cost)
  under Worker secret `AGENT_ENC_KEY` (set on BOTH lab-api + exec, same value). KV stores `v1:<b64iv>:<b64ct>`;
  exec decrypts only at signing time. Legacy plaintext passes through (re-activate to migrate). Orderly keys
  CANNOT withdraw — blast radius is trading only. Phase 1b (dedicated short-lived scoped keys via `AddOrderlyKey`
  w/ `scope`+`expiration`, default 30d) = DEFERRED/optional; 1a agreed as legit stopping point.
- **Exec scaling (#2 DONE):** per-symbol promise-cached `getMarkPrice` (public price fetched once/tick, not per-user)
  + bounded-concurrency batches (`BATCH_SIZE=10`, `Promise.all`). Remaining ceiling = total subrequests/invocation
  (per-user authed position reconcile is irreducible); time-sharding/Queues is the next lever at hundreds of users.
- **Reconciliation / self-heal:** before monitoring, exec fetches live Orderly position; if exchange is flat
  (manual close) it clears the stale KV record + resumes — no ghost position, no bogus trade. Fail-safe: on a
  reconcile error it manages on cached data rather than wrongly clearing.
- **⚠️ SINGLE-WRITER state ownership (race fix):** `agent:state:{addr}` is written ONLY by exec (risk counters,
  daily reset, position). The brain writes ONLY `agent:signal:{addr}` — it must NEVER write agent:state (it used to,
  to stamp `last_signal`, which raced with exec every 5 min and clobbered trades_today/daily reset → cap undercount).
  lab-api GET merges `agent:signal` into the state response (read-only) so the UI still shows last_signal. **Kill** is
  a DEDICATED key `agent:kill:{addr}` (lab-api sets "1", exec consumes+deletes) so an emergency stop can't be lost to
  a state-write race; legacy `state.kill_requested` still honored. Deactivate stays safe via key deletion regardless
  of the active flag. Verified live: 10 real autonomous trades logged, +$ net, counters intact post-fix.
- **Onboarding (#3 DONE):** Config tab has how-it-works panel, live key-status indicator (detected/encrypted vs
  missing — must place ONE manual trade first to generate the Orderly key), and a security disclaimer on activate.
- **ASSISTED vs AUTONOMOUS:** ASSISTED writes a thesis to `agent:pending` (deduped per cooldown) surfaced in the
  Status tab for manual review — never executes. AUTONOMOUS enters/manages real orders within risk params.
- **Controls:** Flip ASSISTED = pause new entries (still manages open position). DEACTIVATE = stop + delete key
  but LEAVES position open/unmanaged. KILL = close position + delete key + deactivate (full stop, must re-activate).
  Rule: agent must be FLAT before you trade manually on the same account (positions net together; agent tracks KV).
- **Verified live:** TP/SL/TIMEOUT closes, signing, reconcile self-heal, encrypted-key round-trip, Supabase logging
  + History read (lab-api also needs `SUPABASE_URL`/`SUPABASE_ANON_KEY` secrets — was missing, caused empty History).
- **Deploy:** frontend → push `main` (CI → Cloudflare Pages). Workers → `npx wrangler deploy` per dir. ⚠️ CI's
  deploy.yml redeploys nexus-lab-api from committed source — so COMMIT worker changes or CI overwrites manual deploys.
  Worker observability logs enabled in each wrangler.toml (`[observability.logs] enabled=true`).

## Leaderboard integrity (cypherpunk hardening — tiers 1-3)
The public agents leaderboard ranks on a risk-adjusted score from live `agent_trades`
(Supabase). Trust hardening, all on `main`:
- **Tier 1 — write-path:** exec logs with `SUPABASE_SERVICE_KEY` (falls back to anon until set).
  ⚠️ TODO (user/dashboard): set `SUPABASE_SERVICE_KEY` secret on nexus-agent-exec + add RLS policy
  blocking anon INSERT on `agent_trades` (anon stays SELECT-only for reads). Then the public read key
  can't forge rows.
- **Tier 2 — exchange-auditable:** every closed trade now records Orderly `entry_order_id` +
  `close_order_id` so records are independently verifiable against the exchange. Insert is resilient
  (retries core row if order_id columns aren't migrated). ⚠️ TODO (dashboard): `ALTER TABLE agent_trades
  ADD COLUMN entry_order_id text, ADD COLUMN close_order_id text;` (else those fields just get dropped via fallback).
- **Tier 3 — verifiable ledger (DONE, live):** `GET /agents/ledger` → canonical records + SHA-256
  `ledgerHash` anyone can recompute (verified: Python recompute == server hash). Each read checkpoints
  an append-only prev-linked hash chain (`GET /agents/ledger/chain`). Frontend TOP AGENTS shows the hash
  + "verify ↗". ⚠️ Final trustless step (needs funded signer + tiny storage contract on Arbitrum):
  anchor the latest `ledgerHash` on-chain so the DB becomes provably tamper-evident.

## Conventions
- Aesthetic: monospace terminal / green (#00ff88). Keep it — it's an ownable brand, don't "SaaS-ify".
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Commit/push when asked.
- Env is **Windows PowerShell** — no `&&` chaining; use `;`. `gh` CLI is NOT installed.
- Pre-existing `tsc --noEmit` baseline ≈ 18 error lines in OTHER files (walletConnector, useNav,
  useSpanDEX, intel) — not from our work. Verify our files add 0 new errors.

## Strategic framing (for partner/Orderly convos)
The DEX is a commodity (anyone can clone the Orderly template). The moat is the Lab + social graph:
plan→automate→grade retention loop, autonomous agent driving net-new volume into Orderly's book, and
network effects from the social layer. Biggest risk = cold-start / Feed liveness (user is recruiting
seed users). Positioning: "The trading terminal that makes you a better trader."
