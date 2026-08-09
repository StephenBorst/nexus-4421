# Nexus Trading Labs — Project Memory

## What this is
An **Orderly Network white-label perp DEX** (`dex-creator-template`) heavily customized into
**Nexus Trading Labs**. The base DEX (markets, swap, vaults, portfolio, leaderboard, points,
rewards) comes from the Orderly SDK — that's the commodity layer. The **product / differentiation**
is everything built on top:

- **The Lab** (`app/pages/lab/index.tsx`) — the flagship. Tabs (7): Market Intel, Nexus Thesis Engine,
  Agent, Copy Trades, Trade Log, Holders Room, Analytics. Header brand: `// THE LAB`.
- **Nexus Thesis Engine** — position sizing, R:R, funding cost, live P&L, on-chain thesis registry.
- **Agent** — autonomous funding-edge trading bot. Modes: PAPER (simulated, default), ASSISTED
  (signals only), AUTONOMOUS (real orders). Guardrails: daily-loss cap, max trades/day, kill switch,
  order-only keys (cannot withdraw).
- **Social** — Feed, Trader profiles, Copy Trades, XMTP wallet-to-wallet DMs (`app/pages/messages`).
- **Messages** — global top-right envelope icon w/ live unread badge (`app/components/MessagesNavButton.tsx`),
  real-time via XMTP `streamAllMessages`. Deep-linked from Feed/Trader as `/messages?dm=0x…`.

## ✅ Revenue + AI + Treasury (LIVE — 2026-06-06; full detail in memory `revenue-ai-treasury-2026-06-06`)
- **Money map:** broker fees → `borst.eth` (Orderly-registered, don't churn) · subs/AI revenue → EOA
  `0x06cD9c281E6ab09906B46a10e059F2770EfdE49A` (`SUBSCRIPTION_RECEIVER`) · **treasury Safe**
  `0x4Fe2c01bbeFaFFa35706C994646a3F8493B1C733` (1/1, Arbitrum+Base, signer `0x53Ce…9D33`). Sweep the
  receivers → the Safe on a cadence. Safe is set as `NEXUS_TREASURY_ADDRESS` → public treasury banner live.
- **⚠️ x402 data revenue (LIVE 2026-06-15) → 3rd sweep source.** Three Bankr x402 cloud endpoints sell Nexus
  data priced in **$NEXUS** on Base (`x402.bankr.bot/<deployerWallet>/<name>`): `nexus-signals` (50k $NEXUS/req,
  the agent's funding+OI edge via `/signals`), `nexus-callers` (10k, `/theses/leaderboard`), `nexus-agents-live`
  (10k, `/agents/live`). Bankr hosts + wraps payment; we just supply handler+config (`bankr-x402/`). **Payout =
  the DEPLOYER wallet** (currently the Bankr wallet `0xd9f7…b449`), **95% after Bankr's 5% fee**, accrues as the
  $NEXUS ERC-20 (no withdraw step). To route to treasury: **sweep `0xd9f7…b449` → the Safe on the same cadence**
  (do NOT redeploy from the Safe — a multisig can't be the Bankr deployer; or ask Bankr support to migrate
  `payTo`). Narrative: treasury accumulates $NEXUS from EARNED, recurring revenue (stronger than "buy the lows");
  agents needing $NEXUS to pay = token demand from usage. x402 challenge verified live (402 + correct amounts).
- **PRO payment rail LIVE** (`PAYMENTS_LIVE=true`): `POST /sub/verify {txHash,chain}` verifies ONE tx receipt
  → grants 30d PRO to the tx's `from` (spoof-proof, replay-guarded). USDC/Arbitrum $20 · $NEXUS/Base $15
  (DexScreener-priced, 12% tolerance, fails closed). `walletIsPro` reads `sub:{addr}`. Logic+tests in lab-api `logic.mjs`.
- **Hosted AI inference LIVE** (PRO benefit): `POST /ai/chat` = authed (wallet-signed) PRO-gated proxy to Anthropic
  with our key + prompt caching + **per-MODEL daily cap**. PRO user PICKS the tier (UI ⚙): **Haiku 4.5
  100/day · Sonnet 4.6 40/day (default) · Opus 4.8 20/day** — stronger model = lower cap (spend scales with
  cost). `resolveHostedModel`/`hostedCaps` in lab-api `logic.mjs` whitelist the requested id (unknown/injected
  → default Sonnet tier) + return its cap; usage counter is keyed PER MODEL (`ai:usage:{addr}:{model}:{date}`).
  Tiers mirrored client-side in `config/assistant.ts` (`HOSTED_TIERS`). Env-tunable caps `HOSTED_CAP_HAIKU/
  SONNET/OPUS` + default tier `HOSTED_AI_DEFAULT_MODEL` (legacy `HOSTED_AI_MODEL` honored as default source);
  needs `ANTHROPIC_API_KEY` secret (set). Free users keep BYOK.
- **⚠️ Hosted-AI SPEND PATH = Bankr LLM Gateway (LIVE 2026-06-14), not direct Anthropic.** `/ai/chat` upstream is
  pluggable via `resolveAiUpstream`/`bankrGatewayModel` in `logic.mjs`: with worker var `AI_GATEWAY=bankr` (set in
  wrangler.toml `[vars]`) + secret `BANKR_LLM_KEY` (set), it proxies to `https://llm.bankr.bot/v1/messages`
  (Anthropic-compatible, header `x-api-key`) instead of Anthropic — funded by Bankr's **$100k inference grant**
  ($1112 credited; "$100k Inference Program"). Gateway uses dot-notation ids (`claude-opus-4.8`/`-sonnet-4.6`/
  `-haiku-4.5`, verified via `GET /v1/models`, caching supported) vs our hyphen ids — `bankrGatewayModel` maps
  each tier (env-overridable `BANKR_MODEL_HAIKU/SONNET/OPUS`). Per-model daily caps + cache_control breakpoints
  still apply. Falls back to direct Anthropic if `BANKR_LLM_KEY` is absent. Manage credits/usage at bankr.bot/llm
  (Bankr wallet `0xd9f7…b449`). Revert = remove the `AI_GATEWAY` var. Verified live: credit balance ticked down on
  a real PRO call.
- **`/analyze`** public Hyperliquid wallet x-ray (HL public API → Lab AnalyticsView; in nav). **Strategy presets**
  (`config/strategyPresets.ts`) load in PAPER/ASSISTED/AUTONOMOUS (no longer force PAPER). **Agent regime filter**
  `respectRegime` (opt-in; brain `computeRegime` gates trend-fighting entries). Bankr skill updated for both.

## Stack
- React + Vite + react-router-dom, TypeScript. Orderly SDK (`@orderly.network/*`), `@xmtp/browser-sdk` v7, wagmi.
- Nav config + global chrome: `app/utils/config.tsx` (top-nav order is hardcoded by href in `NAV_HREF_ORDER`).
- Lab storage (theses/notes): `app/hooks/useLabStorage.ts` (Cloudflare KV via nexus-lab-api).
- XMTP: `app/hooks/useXMTP.ts` (env: `production`). Unread tracking: `app/utils/xmtpUnread.ts`.

## ⚠️ DEPLOYMENT — read before touching CI/CD
- **⚠️ REPO TOPOLOGY (single source of truth = `StephenBorst/nexus-4421`).** Fork chain:
  `OrderlyNetworkDexCreator/dex-creator-template` (upstream template) → `OrderlyNetworkDexCreator/nexus-4421`
  (Orderly DEX Creator's managed fork → deploys to **GitHub Pages**, NOT prod; we don't control it — it's in
  Orderly's org) → **`StephenBorst/nexus-4421`** (OUR repo → Cloudflare → `trade.nexustradinglabs.com`, all
  custom product work). **The `dex.orderly.network/en/dex/config` UI writes to the Orderly FORK, not prod** —
  so changes made there (broker name, theme, menus, PnL posters, etc.) DO NOT reach the live site. **Rule: make
  ALL config + code changes in `StephenBorst` (edit `public/config.js` directly); do NOT use the Orderly config
  UI** (or if you must, mirror the change into `public/config.js`). The two have diverged far past meaningful
  merge — don't try to sync repos; just keep prod authoritative. (2026-06-15 reconcile: pulled 4 drifted config
  values fork→prod — APP/SEO description, theme `#000000`, menus incl. Campaigns.)
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
- **⚠️ Agent mutation auth (DONE 2026-06-11 — Bankr PR #451 security review):** EVERY agent control op
  (`PUT /agent`, `PUT /agent/config`, `DELETE /agent`, `POST /agent/:a/kill`, `bankr/activate`+`bankr/mode`
  incl. PAPER, `pending/:id/deploy|dismiss`, `paper/reset`, `test-signal`) requires `walletSig` =
  `sign_message('nexus-trading-key-v1')` in the JSON body. lab-api `ownsAgent`/`requireOwner` ecrecover it
  (`recoverEthAddress`) and 401 unless it resolves to `:address`. ONLY `GET /agent/:a` is public. Was a real
  hole: previously zero auth → anyone knowing a wallet could `kill` (force-close positions) or rewrite config.
  Web AgentView signs once (viem, cached in `sessionStorage` key `nexus_agent_sig_{addr}`) + sends walletSig on
  all 7 mutation calls; the Bankr skill must too. Don't add a new agent mutation without the `requireOwner` gate.
  NEVER accept the sig via query string (replayable/leaks to logs) — body only.
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
- **Deploy:** frontend → push `main` (CI → Cloudflare Pages). ⚠️ CI's deploy.yml now redeploys **nexus-lab-api,
  nexus-agent-exec, AND nexus-agent-brain** from committed source on every push to main — so COMMIT worker changes
  or CI overwrites manual deploys (secrets persist; wrangler deploy only pushes code). The other workers
  (nexus-ledger-anchor, nexus-lab-alerts) are still manual `npx wrangler deploy` per dir. Worker observability
  logs enabled in each wrangler.toml (`[observability.logs] enabled=true`).

## Bankr agent control (chat-deploy the agent — Phase A+B SHIPPED, 2026-06-02)
Bankr/Farcaster users can deploy/control the autonomous agent by chat. Two additive lab-api routes
(spec: `docs/bankr-agent-spec.md`; skill drop-in: `docs/bankr-skill-agent-module.md`):
- **`POST /agent/:address/bankr/activate`** `{mode, config?, walletSig?, confirm?}` — PAPER needs no key;
  ASSISTED/AUTONOMOUS derive the order-only key from `walletSig` (sign_message('nexus-trading-key-v1'),
  same auth as `/trade`) + the registered `accountId` (from `user:{addr}` in LAB_STORE), encrypt at rest,
  store `agent:key`. **AUTONOMOUS requires `confirm:"GO LIVE"`** (else 409). Clears stale `agent:kill` on activate.
- **`POST /agent/:address/bankr/mode`** `{mode, walletSig?, confirm?}` — flip mode; provisions the key on
  the first live flip; AUTONOMOUS gated by confirm.
- **Key derivation (ground truth):** `seed = SHA-256(walletSigBytes)` (32-byte ed25519 seed) → `bs58Encode(seed)`
  = the secret the exec's `bs58.decode`+noble signer expects. Helpers `bs58Encode` + `agentSecretFromWalletSig`
  in lab-api (verified round-trip with the `bs58` pkg). Auth = possession of a valid walletSig (only the wallet
  owner can produce it via Bankr) — NEVER address-only (would let anyone arm someone else's agent).
- Status/fund/kill reuse existing routes (`GET /agent/:addr`, `/deposit/prepare`, `DELETE`, `/kill`). Capital
  guardrail (avoid -1101): suggest `capitalPerTrade ≈ floor(freeCollateral*0.6)`.
- **✅ Bankr deposit flow LIVE-VERIFIED (2026-06-10):** ran a real end-to-end deposit through
  `/proxy/bankr-deposit` on a funded Bankr wallet → both Arbitrum txs confirmed `status:0x1` (approve
  `0xbcea3e25…721f18bc` to USDC; deposit `0x81033f70…d25eed1a2` to Orderly Vault `0x816f72…67e9`). The
  skill deposits ONLY to the **trading balance** (perp collateral, withdraw anytime, no lockup) — it
  CANNOT use **OmniVault** (`0x70fe7d65…`, Orderly's managed-fund product, 48h redemption window).
  ⚠️ Orderly Dev-Rel (Wuzhong) confirmed external brokers can't `allowBroker` into OmniVault "at this
  stage" — so the earlier OmniVault listing ask was a phantom requirement; the standard broker vault
  was always the right path and works out of the box. Don't re-chase OmniVault.

## Agent signal modes + config control surface (`brain/logic.mjs` `deriveSignal`)
- **`signalMode`** (user-picked): `CONFLUENCE` (default, conf 80 — funding extreme AND OI-divergence must agree),
  `FUNDING_ONLY` (65), `OI_ONLY` (65) = FREE; `MOMENTUM` (60, trade WITH a price move > threshold) and
  `MEAN_REVERSION` (60, FADE the move) = **PRO** (`PRO_AGENT_STRATEGIES` in `app/config/subscription.ts`).
- **Thresholds (per user):** `fundingThreshold` (%, def 0.01), `oiChangeThreshold` (%, def 0), `priceChangeThreshold`
  (%, def 0.5 — for momentum/mean-rev). Plus risk/exec: `symbols`, `leverage`, `capitalPerTrade`, `tpPercent`,
  `slPercent`, `maxHoldHours`, `maxTradesPerDay`, `maxDailyLossUsdc`. ALL user-set, read LIVE each cycle (changes
  apply to next signal + to managing an open position). Brain is per-symbol RAW deltas; `deriveSignal(raw,config)`
  applies each user's mode/thresholds.

## 3Commas-informed agent adaptations (SHIPPED 2026-06-30) — spec `docs/3commas-adaptations-spec.md`
Studied 3Commas; took only the mechanics that fit the funding-edge + trustless-grading identity. All on `main`,
pure-logic-first with `node:test`. Positioning: "3Commas automation without the trust problem."
- **Multi-TP scale-out + trailing stops (FREE):** `evaluateExit(pos,pnlPct,holdMs,config)` in exec `logic.mjs`
  supersedes `exitReason` — returns `FULL_CLOSE`/`PARTIAL_TP`/`TRAIL_UPDATE`/null (hard-stop priority SL→TIMEOUT→trail
  over TP). Config `takeProfits:[{pct,sizePct}]` + `trailingStopPct`. `partialClose()` sends reduce-only slices, logs
  per-slice `agent_trades` rows (`parent_id`/`exit_seq` cols — migrated). `normTakeProfits` keeps legacy single-TP
  behavior. Backtest finding: **trailing HURTS in chop, scale-out mildly helps.**
- **Signal webhook / TradingView (PRO):** per-user secret token in URL = auth (order-only scope, rotatable).
  `POST /agent/hook/:token {action:BUY|SELL|CLOSE,symbol,passphrase}` → `parseWebhookAlert` (lab-api logic.mjs) →
  writes `agent:webhook_signal:{addr}` (600s TTL); exec consumes it before the holding check (CLOSE flattens even
  while holding; OPEN bypasses cooldown, no stacking). Owner-authed PRO `/agent/:a/webhook/(enable|rotate|disable)`.
- **DCA / safety orders (PRO):** whole ladder fits inside `capitalPerTrade` (base = capitalPerTrade/Σvs^i), reuses the
  balance guardrail. `config.dcaEnabled`+`config.dca{maxSafetyOrders,safetyOrderStepPct,safetyOrderStepScale,
  safetyOrderVolumeScale}`. exec has a SEPARATE monitor path: P&L off blended `avg_entry`, TP off avg, `addSafetyOrder`
  averages in via `nextSafetyOrder`/`blendAvg`, slPercent stop only fires once the ladder is spent. Daily-loss cap +
  kill switch stay absolute. Server-enforced 402 `pro_dca_locked`.

## Strategy workbench (SHIPPED 2026-06-30/07-01) — full detail in memory `strategy-workbench-and-followups`
The moat-aligned answer to "let users build/validate strategies." Loop: pick STYLE → compose (Config tab) → Test →
Sweep → Save → Publish → Community board → COPY → activate → graded.
- **Backtest engine** `workers/nexus-lab-api/backtest.mjs` — imports the REAL deployed `deriveSignal` (brain) +
  `evaluateExit`/`computePnl` (exec) so results reflect live behavior (wrangler bundles the cross-dir imports; ONE
  engine, `tools/backtest` runner imports it too). `POST /agent/backtest` (single) + `/agent/backtest/sweep` (ranked
  ~27-config grid), both **PRO** (walletSig→ecrecover→walletIsPro). Config-tab BACKTEST card (Test/Sweep buttons).
- **⚠️ Data reality:** Orderly has price OHLC + funding-rate history but **NO OI history** → CONFLUENCE/OI_ONLY are
  NOT backtestable (flagged `untestable` to UI). Only MOMENTUM/MEAN_REVERSION/FUNDING_ONLY + exits are. First 60d
  sweep: EVERYTHING net-negative, least-bad = FUNDING_ONLY extreme threshold → drove selective house defaults
  (`DEFAULT_CONFIG` fundingThreshold 0.02, maxTradesPerDay 4). **Agent net-negative = the #1 real constraint.**
- **OI history logging:** brain records hourly `{t,price,oi,funding}` into `oi:hist:{symbol}` (core BTC/ETH/SOL +
  watchlists, independent of position state — bug fixed where it only ran for flat users). `GET /agent/oi-history/
  :symbol`. **⏳ Once ~2-3 wks mature (≈mid-July 2026) → wire OI into backtest so CONFLUENCE (flagship) is testable.**
- **Strategy library + sharing:** `/agent/:addr/strategies` CRUD (save/delete owner-authed, list public) + `/publish`
  toggle; `GET /agents/strategies/public?style=` ranks public strategies by the **author's GRADED record** (not
  backtest — keeps discovery on-moat), optional style filter. Config-tab STRATEGY LIBRARY + COMMUNITY STRATEGIES cards.
- **Trading STYLE** (`app/config/agentStyles.ts`): Day/Swing presets + `deriveStyle` (by maxHoldHours). Scalping
  (sub-minute) + position (buy-and-hold) intentionally ABSENT — don't fit a 1-min-cron funding-edge agent on hourly
  data. `maxHoldHours` UI cap lifted 48→336h for swing. Active strategy shown on AGENT STATUS + agent feed entries.
- **⏳ Multi-strategy concurrency (deferred):** the RIGHT path is one **Orderly sub-account per strategy** (NOT separate
  wallets = bad UX, NOT multi-position-one-account = perps net per symbol/account). Sequence AFTER a proven edge
  (concurrency multiplies edge). Bonus: sub-accounts → per-STRATEGY graded records → stronger marketplace ranking.

## Bankr SKILL + marketing assets (where things live)
- **Bankr skill** = `github.com/BankrBot/skills` → `nexus-trading-labs/SKILL.md` + `references/*.md` (markdown skill,
  YAML frontmatter `name: nexus` + trigger `description`). Published/maintained by Nexus. Update = edit SKILL.md/refs,
  PR to BankrBot/skills. Our fork = **`StephenBorst/skills`**, branch **`add-autonomous-agent`** (agent control +
  full config surface) — PR pending at `github.com/StephenBorst/skills/pull/new/add-autonomous-agent` → base
  `BankrBot/skills:main`. Local staging clone: `C:\Users\steph\bankr-skills-stage`.
- **Repo source-of-truth copies:** `docs/SKILL.md` (full updated skill), `docs/bankr-skill-agent-module.md` (=
  `references/agent.md`), `docs/bankr-agent-spec.md` (build spec), `docs/skill-agent-additions.md` (apply guide).
- **Marketing:** `marketing/lab-article.md` (flagship X long-form article + 3 hook tweets + pull-quotes),
  `marketing/build-in-public-series.md` (7 daily founder posts grounded in shipped work). Voice = landing/brand
  register (cypherpunk-terminal, "verify don't trust"). $NEXUS framed cosmetic-only (Howey).
- **⚠️ Bankr "signer rejected it" = Bankr-side wallet signing failure, NOT our skill/code.** Even a plain native
  `sign hello` fails → it's the Bankr agent wallet (needs funding/init) or a Bankr outage, OR the API key lacks
  Wallet+Agent API / has an allowed-recipients restriction. Our endpoints never get hit if the sig fails. Don't
  reinstall the skill for this. Isolation test: ask Bankr to sign a trivial message; if that fails too → 100% Bankr.
- **Agent→public-feed bridge (exec):** `PUBLISH_AGENT_FEED=true` writes the bot's REAL autonomous entries/closes to
  `agent:feed:{addr}` (lab-api /feed merges them) so the agent has a live heartbeat (cold-start fix). PAPER trades
  excluded (`PUBLISH_PAPER_TO_FEED=false`) to keep the feed = "real calls only."
- **Landing fix (this session):** removed a hardcoded fabricated `TVL $18.3M` (no live source) → hero now 3 live
  stats (Volume/OI/Markets); standardized "93+"→"90+" markets. Deployed + pushed to `StephenBorst/nexus-landing`.

## Leaderboard integrity (cypherpunk hardening — tiers 1-3)
The public agents leaderboard ranks on a risk-adjusted score from live `agent_trades`
(Supabase). Trust hardening, all on `main`:
- **Tier 1 — write-path (✅ DONE + VERIFIED 2026-06-09):** exec logs with `SUPABASE_SERVICE_KEY`
  (secret SET on nexus-agent-exec; falls back to anon only if unset). RLS is ENABLED on `agent_trades`
  with a single `SELECT`-only policy for `anon`/`authenticated` — a pre-existing `allow all` (FOR ALL TO
  public) policy was the real hole and has been DROPPED. Verified with the public anon key: SELECT→200,
  INSERT→401 (`42501` RLS violation), DELETE→0 rows (count unchanged 68→68). `service_role` bypasses RLS,
  so exec writes are unaffected. ⚠️ Since anon writes are now blocked, `service_role` is the ONLY writer —
  if agent trades stop appearing in History/leaderboard, the `SUPABASE_SERVICE_KEY` secret is wrong; re-set
  it (canary: `supabase log failed` in exec logs). ⚠️ Lesson: in Supabase, `CREATE POLICY` does NOT enable
  RLS, and policies are OR'd — a leftover `allow all` silently negates restrictive ones. Verify, don't assume.
- **Tier 2 — exchange-auditable:** every closed trade now records Orderly `entry_order_id` +
  `close_order_id` so records are independently verifiable against the exchange. Insert is resilient
  (retries core row if order_id columns aren't migrated). ⚠️ TODO (dashboard): `ALTER TABLE agent_trades
  ADD COLUMN entry_order_id text, ADD COLUMN close_order_id text;` (else those fields just get dropped via fallback).
  ⚠️ ALSO NEEDED (copy-loop grading, 2026-08-09): `ALTER TABLE agent_trades ADD COLUMN source_leader text;`
  — exec stamps the copied leader's 0x addr; `GET /agents/copy-record/:leader` aggregates it into the
  TraderDetail "COPIED ON NEXUS" block. Until run, logTrade drops it via the core fallback + the endpoint
  returns `{available:false}` (UI hides) — graceful, but the feature stays dormant.
- **Tier 3 — verifiable ledger (DONE, live):** `GET /agents/ledger` → canonical records + SHA-256
  `ledgerHash` anyone can recompute (verified: Python recompute == server hash). Each read checkpoints
  an append-only prev-linked hash chain (`GET /agents/ledger/chain`). Frontend TOP AGENTS shows the hash
  + "verify ↗".
- **Tier 3+ — on-chain anchor (code DONE; needs deploy+fund):** `contracts/NexusLedgerAnchor.sol`
  (Arbitrum, append-only `anchor(bytes32 root, uint256 count)`, owner-only, emits `Anchored`). New worker
  `workers/nexus-ledger-anchor` (hourly cron, viem) reads /agents/ledger, dedupes vs on-chain `latestRoot`,
  and commits the root when changed; writes proof to KV `agent:ledger:onchain`. lab-api `/agents/ledger`
  merges that as `onChain {root,txHash,verified,explorer}`; frontend shows "⛓ ANCHORED ON-CHAIN ↗" when
  verified. ⚠️ HANDOFF: (1) deploy the contract on Arbitrum from a DEDICATED hot wallet (Remix), (2) fund
  that wallet w/ ~$2 ETH on Arbitrum, (3) set `LEDGER_ANCHOR_CONTRACT` var + `ANCHOR_PRIVATE_KEY` secret on
  nexus-ledger-anchor, (4) `npm i` + `npx wrangler deploy` the worker. Until then it no-ops safely.
- **✅ DEPLOYED + LIVE (Session 2026-06-02):** contract `0x57a698df84a44F3dA3dac3E08CA455a55A4eff84`
  (Arbitrum), signer = a dedicated fresh hot wallet (~$3 gas, key in `ANCHOR_PRIVATE_KEY` secret). Both
  the AGENT ledger (`0x1fa8…`) and human CALL ledger are anchored + `verified:true`.

## Human call leaderboard (trustless — same standard as agents)
- A human thesis = a **call**. Outcomes are graded OBJECTIVELY from PUBLIC price (Orderly `GET /tv/history`,
  1h OHLC, first-touch TP1-vs-SL; same-candle = LOSS conservative) — NOT self-reported. So `actualPnl`/status
  the user types is ignored for ranking.
- `GET /theses/leaderboard`: ranks public-thesis authors by hit-rate + avg-R over ≥5 resolved calls
  (net-positive-R gate, sample-confidence shrink). `GET /theses/ledger`: canonical SHA-256 of the public
  call set (proof-of-call fields + createdAt), recomputable, prev-linked chain (`/theses/ledger/chain`),
  `onChain` proof merge. anchor worker `anchorOne()` anchors agents + theses each run (separate roots/events,
  KV-deduped). Frontend: **VERIFIED CALLERS** board atop Feed RANKS (`app/pages/feed/index.tsx`).
- ⚠️ Honest ceiling: the Orderly *trading API* (`/v1/position_history`, `/v1/positions`) is private-auth (own account
  only) — that's why we grade the CALL vs public price for the caller leaderboard. **BUT that is NOT the only Orderly
  data source** (corrected 2026-07-17): the **public dashboard indexer** `orderly-dashboard-query-service.orderly.network`
  exposes per-account rankings + positions + realized/unrealized PnL across the whole broker network with NO auth
  (`/ranking/realized_pnl`, `/ranking/positions`, `/trades`, `/get_account_volume_statistic`; limit max 200). Smart
  Money uses it as the PRIMARY source (see below). Don't repeat "Orderly per-address is fully private" — the trading
  API is; the settlement indexer isn't.

## Engagement layer — competitor-informed, on the trustless core (2026-06-15) ⭐
Studied FOMO (fomo.family) + Legend (app.legend.trade) — both win on live-positions feeds + clans/arena +
frictionless onboarding, but rank on SELF-REPORTED PnL. Built their engagement surfaces on our verifiable
grading (the moat they can't copy). 5 shipped this session (#3 Arena/Seasons deferred):
- **#1 LIVE NOW feed** — `GET /agents/live` aggregates currently-OPEN positions (agents from
  `agent:state.current_position` non-paper + opted-in humans), uPnL **recomputed from PUBLIC mark price**
  (never client-claimed). Frontend `app/pages/feed/LiveNow.tsx` (top of feed view, 25s poll, fail-soft).
  **Human opt-in (Phase 2):** `POST /live/publish {walletAddress, walletSig, positions, displayName?, pfpUrl?}`
  — can't read others' positions server-side (private key), so the CLIENT publishes a snapshot stored with a
  ~6-min TTL (`live:human:{addr}`, self-expiring = nothing retained). ecrecover-authed. Mini app has a 📡
  Broadcast toggle (publishes on each status refresh w/ Farcaster name/pfp; off = clears).
- **#2 Desks** (clans) — `app/pages/feed/Desks.tsx` in Feed RANKS. `/desks` create/join/leave (walletSig
  ecrecover, ONE desk per wallet via `desk:mem:{addr}`, `desk:rec:{id}`; auto-disband empty + owner transfer),
  `GET /desks` ranked board, `GET /desks/:id` detail. **Desk score = AGGREGATE of members' graded calls** via
  the shared `computeCallerStats(env)` (extracted from /theses/leaderboard so the two never drift).
- **#4 Real-time alerts** — `app/components/LiveAlerts.tsx` (GLOBAL, mounted in `App.tsx`). Polls /agents/live,
  diffs new opens (skips backlog on first load), bottom-left toasts + opt-in OS `Notification`. No push infra.
- **#5 Watch-only** — `app/pages/feed/WatchOnlyBanner.tsx` (disconnected visitors only). Frames the already-
  public surfaces as explore-before-connect. Dismissible.
- **#6 Merit ranks (identity ladder)** — `rankCaller(stats)` in lab-api `logic.mjs` (+tests). Earned from
  graded record, NOT bought (distinct from $NEXUS holder tiers): ▪ Signal (5+ calls, net+R) → ◆ Sharp (15+,
  ≥50%, ≥0.5R) → ✦ Apex (30+, ≥55%, ≥1R). Attached to /theses/leaderboard entries (`meritRank`) + green badge
  on VERIFIED CALLERS board.
- ⚠️ All of the above only POPULATE with real usage (open positions / 5+ graded calls / formed desks) — sparse
  at cold-start BY DESIGN (fail-soft renders nothing), not broken. KV keys live in LAB_STORE.

## $NEXUS token & holder perks (pure-meme + flywheel UI)
$NEXUS = pure community meme token on **Base** (`0x3D958634ab725B627919EF8F2Ed59227309fDba3`, 100B supply,
18 decimals). **Zero built-in utility / revenue share** — perks are cosmetic/access only; the framing is
baked into the code comments. Keep it that way (Howey). The real lawyer-gate is the first buyback→burn.
- **Tier hook** (`app/hooks/useNexusTier.ts`): reads $NEXUS balance on Base via viem with a CORS-friendly
  RPC `fallback()` (llamarpc/publicnode/drpc — the default `mainnet.base.org` 403s/CORS-blocks the browser,
  which silently hid badges). Module-cached, fail-soft. **Tiers (low→high): ▪ OPERATOR 50M / ◇ ARCHITECT 100M
  / ◆ ORACLE 250M** (`TIER_THRESHOLDS`). Non-hook `fetchNexusTier` + `fetchBurnStats` for list/widget use.
- **Badge** (`app/components/NexusTierBadge.tsx`): terminal-green chip, renders null for non-holders. On
  Trader profiles + Feed (trader rows + thesis cards).
- **Holders Room** (Lab tab, `app/components/HoldersRoom.tsx`): gated by connected wallet's tier. Thesis
  visibility is a **3-state cycle PRIVATE → PUBLIC → ◆ HOLDERS** (`holdersOnly` flag in ThesisTrade); holders-only
  theses are EXCLUDED from public `/feed` and shown only here. Server-gated endpoint **`GET /feed/holders?
  address=&ts=&sig=`** in lab-api: verifies an EIP-191 signed+timestamped challenge via **secp256k1 ecrecover
  (`@noble/curves`)** (recovered addr must match, ts fresh ≤10min) THEN on-chain balanceOf ≥ `OPERATOR_MIN`.
  ⚠️ **`OPERATOR_MIN` in lab-api MUST match the frontend OPERATOR threshold** (currently 50M) or badges/gate drift.
  Frontend caches the signature per-session (8min) to avoid re-prompting.
- **Public flywheel strip** (Feed header + Lab header + landing): `NexusMarket` (live price/MC/vol/liq from
  GeckoTerminal, **client-side fetch** — GeckoTerminal/CoinGecko 403 datacenter IPs; carries the GT link-back) +
  `NexusTreasury` (USDC balance of the Safe on Arbitrum; renders NOTHING until `NEXUS_TREASURY_ADDRESS` is set —
  one-line activation when the Safe exists) + `NexusBurnCounter` (on-chain $NEXUS at dead address as % of supply;
  honest at 0 until first burn). All fail-soft.
- **Landing** (`nexus-landing` repo, static `index.html`, `wrangler deploy` — no CI): has its own $NEXUS market
  strip (inline GeckoTerminal fetch). ⚠️ `.assetsignore` excludes `.git` (the assets dir is repo root — was
  publicly serving `.git/`). Announcement-tweet arc drafted: GeckoTerminal verified → Treasury Safe live → flywheel.

## Buy $NEXUS / swap (investigated in depth — don't re-derive)
- **v1 SHIPPED:** `BuyNexusButton` deeplinks to Uniswap on Base (`app.uniswap.org/swap?chain=base&inputCurrency=ETH&
  outputCurrency=<NEXUS>`), lives in `NexusMarket` so it shows on Feed + Lab + landing. This is the ONLY reliable
  $NEXUS buy path today (Uniswap natively handles the pool's hook + dynamic fee).
- **The pool (Uniswap v4 on Base):** poolId `0xdc5be7…2009`. PoolKey = currency0 **$NEXUS** / currency1 **WETH**
  (`0x4200…0006`), **dynamic fee** (`0x800000`), tickSpacing 200, **custom hook `0xbb7784a4d481184283ed89619a3e3ed143e1adc0`**
  (launchpad/Clanker-style). PoolManager `0x498581ff…2652b2b`, V4Quoter `0x0d5e0F97…532048D`. Only ~$63K liq.
- **Hook vetting (DONE, swap-friendly):** flags = beforeInitialize/add-liq/remove-liq + **beforeSwap/afterSwap**,
  **NO returnsDelta** (doesn't skim swaps). `V4Quoter.quoteExactInputSingle` returns clean numbers through it with
  empty `hookData` (verified: 0.01 WETH → ~25.2M NEXUS). So an **embedded in-app swap is GO-able + low-risk** (~1wk):
  Universal Router `V4_SWAP` w/ the full PoolKey, `zeroForOne:false` for WETH→NEXUS, `WRAP_ETH` for native ETH in.
- **⚠️ NO aggregator routes $NEXUS yet:** LiFi AND Fabric (`route.withfabric.xyz/v1/quote`, header `X-App-Id`) both
  return **"No route found"** for WETH→NEXUS while routing majors (WETH→USDC) fine. It's the **v4-hook indexing gap**,
  NOT pool-specific — they'll auto-route NEXUS once they index v4 hooks OR the pool deepens. So embedded $NEXUS swap =
  hand-build (vetted) OR wait. Real lever = **liquidity depth** (treasury buyback / LP seeding).
- **Spandex/Fabric:** `spanDEX/spandex` = cloned `github.com/withfabricxyz/spandex` (Fabric's OSS aggregator).
  `app/components/SpanDEX/*` + `useSpanDEX.ts` = a SCAFFOLD (placeholder `api.fabric.com/quote` URL, never wired).
  Reviving it would upgrade GENERAL swaps over the WooFi widget (majors/cross-chain) but does **NOT** solve buying
  $NEXUS (can't route the v4 pool). That mismatch is likely why it never shipped.

## Nexus PRO — subscriptions / revenue (freemium model)
The business-model layer. **PRO is a SOFTWARE subscription** (ordinary commerce, real USDC revenue) — NOT a
token-value scheme. $NEXUS only adds **consumptive use** (pay-in-$NEXUS discount) + **access** (hold-to-unlock).
⚠️ NO revenue-share / yield / dividends to holders — that's the security-maker line; do NOT add.
- **Built + LIVE (frontend):** `config/subscription.ts` (single source of truth — prices, benefits, `PAYMENTS_LIVE`
  flag, `PRO_AGENT_STRATEGIES`), `useSubscription` hook (resolves PRO via holder-unlock today OR paid record later;
  fail-soft → FREE), `NexusPro` card (active-state for PRO / upsell for free; shown in Lab under the market strip).
- **Tune (locked, all in subscription.ts):** `$20/mo` USDC · `25%` off paying in $NEXUS (→ `$15`) · hold **ARCHITECT (100M)**
  → PRO free (dollar cost of unlock rises with token price — cheap now to drive buying, real commitment later).
- **First gate LIVE + SERVER-ENFORCED:** advanced agent strategies (**MOMENTUM + MEAN_REVERSION**) are PRO; 3 core
  modes (CONFLUENCE/FUNDING/OI) stay free. UI gates it (`isProStrategy` + `useSubscription` in AgentView) AND lab-api
  now ENFORCES it server-side: every config-write site (`PUT /agent/:addr`, `PUT /agent/:addr/config`, `POST
  /agent/:addr/bankr/activate`) rejects a PRO `signalMode` from a non-PRO wallet with **402 `pro_strategy_locked`**.
  PRO resolved by `walletIsPro(address, env)`: paid `sub:{addr}` (future) OR holder-unlock = $NEXUS `balanceOf` ≥
  ARCHITECT (100M) on Base via `eth_call` (reuses the `/feed/holders` RPC pattern; fails CLOSED if RPC unreachable).
  Gate only fires for PRO strategies — free modes skip the RPC. So the paywall is real on web AND Bankr chat now.
- **⚠️ PAYMENT RAIL — SCOPED, shovel-ready, BLOCKED on the treasury Safe (the receiver address):**
  - Insight: NO indexer/processor needed. A sub payment = an ERC-20 transfer to the treasury. Worker verifies via ONE
    `eth_getTransactionReceipt` (read the `Transfer` log). **Grant PRO to the tx's `from` address** → spoofing
    impossible, no signature dance.
  - Worker `POST /sub/verify {txHash,chain}`: verify success + correct token (USDC/$NEXUS) + `to`===treasury +
    amount≥price + **txHash not already redeemed** (replay guard) → write `sub:{from}`={expiresAt:now+30d, extend if
    active} + mark hash used. `GET /sub/:address`→{expiresAt,active} (already read by useSubscription; flip PAYMENTS_LIVE).
  - Phases: **3a** USDC/Arbitrum (core, ~80%) → **3c** server-side enforcement (brain checks sub before PRO strategy;
    makes gates real) → **3b** pay-in-$NEXUS/Base (live USD→$NEXUS quote w/ tolerance band; drives token demand).
  - Effort ~3–4 days, ~$0 infra (public RPC + existing KV). No recurring billing (crypto = manual 30-day renewal).
  - Legal: USDC-for-software = plain commerce (not Howey); pay-in-$NEXUS = consumptive use. Low-stakes vs the buyback;
    one-line mention to the lawyer during the treasury chat.
- **⚠️ The Safe unblocks THREE things at once:** buyback flywheel + public treasury banner (`NEXUS_TREASURY_ADDRESS`)
  + PRO revenue (`SUBSCRIPTION_RECEIVER`). Standing up the Safe (app.safe.global, ~10 min) is the highest-leverage move.

## Tokenomics direction — Bankr-informed pivot (2026-06-08) ⭐ CURRENT
The Safe is **LIVE** (`0x4Fe2…C733`, 1/1 Arbitrum+Base) and the PRO USDC payment rail is **wired**
(`/sub/verify` + `NexusPro` subscribe flow). After pitching $HYPE-style mechanics to the Bankr team, **Danny B
(Bankr) reshaped the token strategy — adopt this, it's both more holder-aligned AND legally cooler:**
- **❌ DROP automated buyback + burn.** Automated buybacks reward short-term traders, not holders; burning at this
  stage signals "we don't believe it goes higher." Also: an automated/marketed fee→buyback→burn machine is the
  CLOSEST thing to a Howey investment-contract — exactly the lawyer-gate we wanted to avoid.
- **✅ DISCRETIONARY "buy the lows" accumulation into the treasury.** The multisig opportunistically buys $NEXUS when
  cheap and **HOLDS** (conviction, war chest). Just a company accumulating an asset → far more defensible + what
  aligned holders actually want. Less to build too (no cron worker).
- **✅ Don't FULLY token-gate features** — keep a strong free tier so user-growth numbers stay real (needed for
  narrative/partnerships). PRO = additive premium (we only gate the 2 advanced agent strategies; core stays free).
- **✅ Points → Seasons** (Danny loved it; wants the structure — see `docs/nexus-seasons.md`). The treasury stack
  (from buying lows) FUNDS retroactive Season drops to top **verifiable** contributors. Quality-weighted via our
  trustless grading (reward being RIGHT, not loud) = built-in anti-wash-farming. Hold $NEXUS = points multiplier
  (aligned, not pay-to-win). Retroactive + merit-based + from a treasury = clean.
- **Narrative pivot:** burn counter → **treasury-accumulation counter** ("treasury holds X $NEXUS" = conviction,
  not "X burned" = scarcity). Transparency pillar makes the stacking a feature.
- **Relationship:** Bankr connecting borst to their devs (facu & edit) + dev-console access → path to deeper
  integration + a Farcaster mini-app distribution play.

## Farcaster Mini App (distribution play — 2026-06-08) ⭐ CURRENT
The cold-start/distribution weapon: a slim Nexus surface native to Warpcast, where Bankr's users are.
- **LIVE:** `/mini` route (`app/pages/mini/index.tsx`) — STANDALONE, OUTSIDE `<App>`/OrderlyProvider (frames must
  stay light). Manifest at `public/.well-known/farcaster.json` is **SIGNED** (accountAssociation, FID 389456,
  domain trade.nexustradinglabs.com verified) → Warpcast recognizes it as an official Mini App. Uses
  `@farcaster/miniapp-sdk` v0.3: `isInMiniApp`, `context` (identity, free), `actions.ready`, `wallet.getEthereum
  Provider` (connect CONFIRMED working in Warpcast preview).
- **v1 (zero-auth, shipped):** identity + LIVE CALLS feed (read-only `/feed`) + Buy $NEXUS (`actions.swapToken`
  → `actions.viewToken` fallback, 100% native, no Uniswap redirect) + share-to-cast (`actions.composeCast` —
  the viral loop: each thesis embeds `/feed/thesis/:wallet/:id`).
- **⚠️ Native swap can't route $NEXUS (same v4-hook gap):** Warpcast's swap uses an aggregator; aggregators
  don't route the v4 NEXUS pool (see swap section). So the native sheet may show "no route" until liquidity
  deepens / aggregators index v4. UX is native now; actual fill depends on routing. Real fix = depth.
- **⚠️ Frame wallet is FRESH/separate** from the user's main wallet (no Orderly acct, no funds, no $NEXUS). Can
  read verified wallets from `context.user.verifications`. Shapes the build order (zero-auth first).
- **✅ TRADING PHASE — BUILT + LIVE-VERIFIED in-frame (2026-06-11; full real-money loop works).** Flow:
  connect → ENABLE (registers Orderly acct + order-key, no funds move) → DEPOSIT (real Arbitrum USDC txs) →
  TRADE (`POST /trade {symbol, side, notional, leverage, walletSig, walletAddress}`, auth =
  `sign_message('nexus-trading-key-v1')`, places MARKET via Orderly `/v1/order`). The frame wallet signs once;
  `ensureSig()` caches the sig per session so reads don't re-prompt. **Account read-back** (`POST /positions`
  → free_collateral + total_collateral_value + rows; `POST /balance` = `/v1/client/holding`) renders collateral
  + open positions with live uPnL + a real per-position **CLOSE** (`POST /close-position {symbol, walletSig,
  walletAddress}`). Verified live: $10 BTC short filled, position shown, closed; HYPE closed.
- **⚠️ /trade money-path gotchas (all bit us, all fixed — don't regress):** (1) **min_notional + base_tick
  live on `/v1/public/info/{symbol}`, NOT `/v1/public/futures/`** (futures returns null for both → silently
  defaulted minNotional to 1 → sub-min orders slipped through). (2) **/trade MUST check `orderResult.success`** —
  Orderly returns `{success:false, code, message}` on reject; the old code wrapped it as `ok:true` → trades
  "placed" with no position. (3) **Floor-snapping qty to base_tick can dip the VALUE under min_notional** (e.g.
  $10 HYPE → 0.17 → $9.95 → "order value should be ≥ 10"); ceil up one step to clear it. (4) **Orderly position
  rows have NO flat `unrealized_pnl` field** — compute uPnL = `(mark - entry) * signed_qty` (NaN-safe). HYPE/most
  perps min_notional = $10, so with a small balance use leverage so margin fits (e.g. $10 @ 2x = $5 margin).
- **⚠️ Frame wallet ≠ Bankr/main wallet:** the mini frame wallet is its OWN Orderly account, separate from the
  Bankr wallet used by the skill `/proxy/bankr-deposit`. Funds/positions deposited via one are invisible to the
  other — a common "where are my funds?" confusion. Each account is keyed by its own address.
- **⚠️ This repo is YARN 4** — use `yarn add`, NEVER `npm install` (npm writes a conflicting root
  `package-lock.json` + desyncs `yarn.lock` → CI `yarn install` fails → deploy skipped). Bit us once on the
  miniapp-sdk add.

### ✅ PUBLISHED + INSTALLABLE (2026-06-15) — full money loop + the manifest gotchas that blocked publishing
- **Money loop COMPLETE:** added **in-frame WITHDRAWAL** (deposit/trade/close already shipped). Frame EOA signs
  the Orderly `Withdraw` EIP-712 CLIENT-side (non-custodial); two lab-api routes: `POST /withdraw/prepare`
  (derives ed25519 from walletSig, gets withdraw_nonce, returns typedData; `settle:true` settles PnL first +
  recomputes safe amount from free_collateral) + `POST /withdraw/submit` (relays `{message,signature}` to
  `/v1/withdraw_request`; returns `needsSettle` on Orderly **code 78** → client re-signs with settle:true).
  Receiver is server-guarded to == caller's wallet. Ported from `/proxy/bankr-withdraw` (which signs server-side
  via Bankr). Withdraw `verifyingContract` = `0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203` **passed in the POST body**.
- **⚠️ Orderly OFF-CHAIN EIP-712 verifyingContract = the all-C sentinel `0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC`**
  for **registration/AddOrderlyKey** (Orderly reconstructs the hash with THIS + ecrecovers). The miniapp had copied
  the wrong `0x6F7a338F…` from the Bankr path → **"address and signature do not match"** on every enable/trade.
  Fixed. (The Bankr/withdraw flows use `0x6F7a338F…` but ONLY because they pass `verifyingContract` in the body.)
  Match the web ENABLE flow / Orderly docs: registration→all-C; withdraw→0x6F7a338F-in-body.
- **Trading slickness pass:** live price + 24h change + **funding** header + **candlestick chart** (dependency-free
  SVG from public `GET /tv/history` OHLC) + 24h vol / OI / funding-countdown — all public client fetches, 25s poll,
  fail-soft. **ALL ~106 markets** via a search picker (full list from `/v1/public/info`; popular quick-chips +
  search) replacing the hardcoded 6. **Per-asset max leverage = 1/base_imr** (BTC 100x, small-caps 20x) drives
  slider max + dynamic preset chips + clamps on symbol switch. **Accuracy line:** position-size estimate + est.
  liquidation price (mark ± maint-margin). **Progressive disclosure** (Fund/Withdraw behind a ⚙ MANAGE FUNDS
  toggle). **Copy-trade loop:** ⚡ TRADE on a feed call prefills the panel (symbol+direction, highlights the side).
  **Share PnL to cast** (↗ on each open position → composeCast w/ entry→mark + uPnL, embeds /mini).
- **⚠️ PUBLISHING/MANIFEST — the gotchas that blocked "Add" (all fixed; see memory `farcaster-miniapp-publish-gotchas`):**
  (1) A Mini App is public the moment its **signed manifest** is valid — no app-store approval. (2) You CANNOT open
  it by visiting the URL in a browser — only in-frame (cast embed Launch button / dev tool / search). (3) Manifest
  `iconUrl` **must be 1024×1024 PNG, no alpha** — a `.webp` or 512px fails validation → can't add. (4) Top-level key
  must be **`miniapp`** (current spec); `frame` is legacy alias — include both. (5) **Field length limits are
  enforced and reject the WHOLE manifest** — `subtitle` ≤30 (a 34-char value gave `addMiniApp()` "Invalid domain
  manifest"), name ≤32, description ≤170. (6) For casts to render a **Launch button**, add `fc:miniapp` (+`fc:frame`
  alias) embed meta to `index.html` (crawler reads STATIC html, so per-route JS-injected tags don't count). (7)
  Diagnostic that cracked it: **surface the `addMiniApp()` error** instead of swallowing it. (8) `accountAssociation`
  verified: sig recovers to FID 389456's on-chain custody (IdRegistry `custodyOf` on Optimism). Manifest served as
  `application/json`, no BOM.
- **PnL share posters:** custom posters live in `public/pnl/poster_bg_{1..4}.png` (+ `.webp`), gated by
  `VITE_USE_CUSTOM_PNL_POSTERS=true` / `VITE_CUSTOM_PNL_POSTER_COUNT`. ⚠️ Orderly overlays its OWN text (title, %,
  stats, **QR bottom-left**) on the **LEFT** — so the poster bg must keep the **left dark/empty** and put branding
  on the RIGHT, else it doubles/garbles (bit us). Built one from the real brand banner (`nexustradinglabs.com/preview.png`).

### Trading page (perp) customization
- **Collapsible order book** (`app/pages/perp/Symbol.tsx`): desktop ⊟/⊞ toggle hides the order book via
  `<TradingPage disableFeatures={["orderBook"]}>` → chart reflows wider; persisted (`nexus_ob_collapsed`).
  ⚠️ `TradingFeatures` enum is NOT exported — pass the string literal, typed via the prop's own type; and **`key`
  the TradingPage** on the toggle so the SDK re-applies disableFeatures (it reads them at mount).
- **⚠️ `<MarketsHomePage>` / `<TradingPage>` are black-box SDK widgets** — only the props they expose are
  customizable (`disableFeatures`/`overrideFeatures` on TradingPage; `comparisonProps`/`onSymbolChange` on Markets).
  The markets overview "New listings/gainers/losers" cards render a FIXED preview (no scroll prop) — making them
  scrollable needs a rebuild from granular widgets (`NewListingListWidget`, `MarketsListWidget`, etc.), not a tweak.

## Testing (money-path + trust-path)
- Pure logic is extracted into `logic.mjs` next to each worker's `index.js` (which imports it, so
  tests cover the REAL deployed code, not a copy). Tests = zero-dep `node:test` in `logic.test.mjs`.
  Run: `node --test workers/<worker>/logic.test.mjs` (or `npm test` in the worker dir).
- **nexus-agent-exec/logic.mjs** (12 tests): `snapQty` (-1104 step-size float-artifact guard +
  base_min/min_notional), `shouldResetDaily`, `dailyCapBlocked` (never blocks a win), `computePnl`
  (long/short), `exitReason` (TP→SL→timeout priority).
- **nexus-lab-api/logic.mjs** (9 tests): `gradeCall` — trustless first-touch TP-vs-SL grading
  (same-candle=loss, short inversion, pre-call candles ignored). Ledger hashing left inline (anchored
  on-chain — don't risk it).
- **Monitoring (DONE):** `nexus-ledger-anchor` runs an hourly `runMonitor` (after `runAnchor`) → Telegram
  ops alerts for ⛽ anchor-signer gas low (<0.0004 ETH), ⚓ ledger drifted from on-chain anchor >6h,
  🧠 brain down (via `ops:brain:heartbeat` KV the brain stamps every run; >15min = down). 3h per-issue
  debounce + daily ✅ heartbeat. Secrets: `TELEGRAM_TOKEN` (same bot as lab-alerts) + `OPS_TELEGRAM_CHAT_ID`
  var (6927717434). Test: `GET /monitor-now`. Verified live → `{"issues":[]}`.
- **Refactor (LAB DONE):** `app/pages/lab/index.tsx` split 3775 → **190-line orchestrator** + modules:
  `styles.ts`, `helpers.ts`, `types.ts` (+ all view/agent types + DEFAULT_CONFIG), `useIsMobile.ts`,
  `components.tsx` (EmptyState/PnlChart), `AnalyticsView.tsx`, `TradeLog.tsx` (Calendar+TradeLog),
  `ThesisView.tsx` (+ThesisAnalyticsView), `AgentView.tsx` (+AGENT_API/key readers), `CopiesView.tsx`,
  `MarketIntel.tsx` (+NewsTab), `Onboarding.tsx` (LabWelcome+OnboardingChecklist). tsc clean + `vite build`
  verified green. Pattern: extract → import → tsc → small commit.
- **Refactor (worker — OPTIONAL/deferred):** `nexus-lab-api` (3.2k) is still one big fetch handler, but its
  risky logic (gradeCall) is already extracted to logic.mjs + tested, and it's uniform route blocks (lower
  maintainability pain than the Lab was). Split routes/agent|theses|feed only if it starts hurting.

## Conventions
- **⚠️ After creating new files, `git add` them + verify `git status` is clean BEFORE trusting a build.**
  A local `vite build`/`tsc` passes with untracked files (they exist in the working tree), but CI builds
  from a clean checkout and fails to resolve them (Build step → Pages deploy skipped). The CI result is the
  only one that counts. (Bit us once: `components.tsx` was created in the refactor but never committed →
  6 red deploys until `git add`ed.) To get CI step status without admin: `GET api.github.com/repos/<repo>/
  actions/runs` then `/jobs` (public, unauthenticated; logs need admin though).
- **Mobile/responsive:** the app uses inline styles, so CSS media queries can't override them. Pattern:
  stat-card grids use `repeat(auto-fit, minmax(NNpx,1fr))` (fluid, desktop unchanged since auto-fit never
  exceeds item count); dense row tables get `overflowX:auto` + `minWidth`; layout-level changes use the
  `useIsMobile()` hook (768px). Lab/Feed/Messages done; Intel partial; SDK pages are Orderly-managed.
- **⚠️ Restyling an Orderly SDK layout region (e.g. portfolio side-nav):** the scaffold widgets accept
  `classNames={{ leftSidebar | content | topNavbar | card: "your-class" }}` → that class lands on the region's
  wrapper div (`@orderly.network/ui-scaffold` does `className: cn(classNames?.leftSidebar)`). Pass a custom class
  there, then target it in `app/styles/index.css` with `!important` + a descendant `*` to beat the oui- utility
  classes. Did this for the portfolio side-nav (`.nexus-portfolio-side`) which was chopping labels mid-word
  ("Overvi/ew") — fix = `word-break:keep-all` + `overflow-wrap:normal` (break only at spaces) + desktop nowrap.
  ⚠️ /portfolio needs a CONNECTED WALLET to render the rail, so it can't be visually verified in preview unauthed.
- **⚠️ Mobile overflow playbook (Session 2026-06-02 sweep — the recurring bug class):** fixed-PIXEL
  `gridTemplateColumns` (e.g. `"180px 1fr repeat(4,90px) 28px"`, `"280px 1fr"`, `"1fr 54px 40px 54px"`)
  are THE recurring mobile-clip culprit — they overflow/clip off the right edge on phones. Fixes by case:
  (1) two-column "chart + panel" blocks (e.g. TRADING SCORE radar+composite) → `gridTemplateColumns: isMobile
  ? "1fr" : "<desktop>"` to STACK; (2) cards holding sub-tables (best/worst markets) → make the CARD grid
  single-col on mobile so the inner table gets full width; (3) genuinely dense rows that can't shrink (trade
  log day rows, agent history/leaderboard) → wrap in `overflowX:auto` + put `minWidth:<sumpx>` on the row so
  it SCROLLS instead of clipping; (4) flex rows with `flex:1`/`minWidth:0` children that collide → set
  `flexShrink:0` on every column + a fixed identity width (feed VERIFIED CALLERS rows); (5) badges/labels in a
  `nowrap`+`overflow:hidden` line get clipped → move them to their own wrap-capable line. Fractional (`1fr`/
  `0.6fr`) grids are SAFE (they shrink). ⚠️ **`useIsMobile()` is per-COMPONENT** — each refactored module
  (`ThesisView` vs `ThesisAnalyticsView`, `CalendarView` vs `TradeLogAllView`) needs its OWN
  `const isMobile = useIsMobile()` call; referencing `isMobile` without it = `ReferenceError` that white-screens
  the whole tab (bit us twice). Feed reuses the Lab hook: `import { useIsMobile } from "@/pages/lab/useIsMobile"`.
- **Calendar cells:** use a FIXED `height` (not `minHeight`) so data-days don't grow taller than empty days
  ("weekdays huge, weekends small"); 60px mobile / 80px desktop + condensed content + `overflow:hidden`.
- **Lab tab row mobile:** tabs are equal-width `flex:1` with `short` labels; Holders short = `ROOM` (was a
  cryptic `◆`); the sync/operational status dot is hidden on mobile to reclaim space. Feed nav mirrors this
  (equal `flex:1` tabs, glyphs+divider dropped, "N theses" count hidden on mobile — no awkward gap).
- Aesthetic: monospace terminal / green (#00ff88). Keep it — it's an ownable brand, don't "SaaS-ify".
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Commit/push when asked.
- Env is **Windows PowerShell** — no `&&` chaining; use `;`. `gh` CLI is NOT installed.
- Pre-existing `tsc --noEmit` baseline ≈ 18 error lines in OTHER files (walletConnector, useNav,
  useSpanDEX, intel) — not from our work. Verify our files add 0 new errors.

## // NEXUS AI — floating AI copilot (Session 2026-06-05, on main)
Terminal-wide floating ◆ assistant; flagship "make-you-a-better-trader" feature. **BYOK, client-side
only** (user's Anthropic/OpenAI key in localStorage; browser calls provider REST directly via `fetch`,
no SDK — key never hits a Nexus server). Files: `app/components/NexusAssistant.tsx` (mounted in
`App.tsx` inside `<OrderlyProvider>`), `app/config/assistant.ts` (`runChat`/`runChatStream`+`readSSE`,
`SYSTEM_PROMPT` w/ advice-line guardrail, `listModels`, per-provider `LS_MODEL(p)`/`LS_KEY(p)`),
`app/config/assistantTools.ts` (12 tools, `ToolCtx`). **Streaming** (SSE) keeps the full bounded
tool-loop (max 5) for both providers; non-streaming `runChat` is the fallback. **Models fetched live
from the key's `/v1/models`** (stale `*-latest` ids 404 — `loadModel()` migrates them + rejects
cross-provider ids; Anthropic browser calls need header `anthropic-dangerous-direct-browser-access`).
**12 tools**: read (market, regime, open positions, my performance, agent status, get_trader, top
agents, verified callers) + action/no-execution (open_symbol/trader/leaderboard, draft_thesis →
localStorage `nexus_thesis_draft` + `/lab?tab=thesis`; Lab reads `?tab=`, ThesisView consumes draft).
Persists chat (`nexus_ai_chat`), markdown render (incl. tables), discovery nudge (`nexus_ai_seen`),
local personal-insight teaser. ⚠️ Thesis form symbol = BARE ticker ("BTC"), not PERP_. Next: **hosted
inference** (pay-in-$NEXUS/USDC worker proxy) — the BYOK-wall unlock, BLOCKED on the treasury Safe; fold
into PRO rail. Open call: free-forever BYOK vs gate behind PRO.

## Agent ops + feed liveness (Session 2026-06-05, on main)
- ⚠️ **"Agents down" is usually a false alarm.** Before declaring an exec outage, check Cloudflare dash →
  Workers → nexus-agent-exec → Triggers → **View events** (per-minute Success log). Agents sit idle BY
  DESIGN when the brain emits `direction:NONE` (no funding+OI confluence). **CF "CPU time" ≠ wall time**
  (awaiting I/O is free) so ~2ms ticks are normal early-returns, not crashes.
- exec now stamps `ops:exec:heartbeat` every tick + has `GET /health` ({ok,users,lastTickAgeSec}); the
  hourly `nexus-ledger-anchor` monitor alerts "⚙️ Exec down" if >10min stale. Fixed a daily-reset
  persistence bug (state only saved on a trade → stale trades_today). 2 agent wallets: `0x325da3…95de`,
  `0x9a3012…cb28` (AUTONOMOUS, BTC).
- **Feed cold-start liveness** (`app/pages/feed/index.tsx` + lab-api `/theses/leaderboard`): emerging
  callers tier (1-4 graded calls + `callsToQualify`), FeedPulse strip, AgentTrackRecord social-proof
  card, ContributePrompt (feed<12), and **outbound 𝕏/Farcaster share** on theses (Lab ThesisView +
  thesis detail page) → links unfurl via existing `/og/thesis/:wallet/:id(.png)` cards. The
  create→distribute→recruit loop = the real fix for thin supply (rest is go-to-market).

## Strategic framing (for partner/Orderly convos)
The DEX is a commodity (anyone can clone the Orderly template). The moat is the Lab + social graph:
plan→automate→grade retention loop, autonomous agent driving net-new volume into Orderly's book, and
network effects from the social layer. Biggest risk = cold-start / Feed liveness (user is recruiting
seed users). Positioning: "The trading terminal that makes you a better trader."
