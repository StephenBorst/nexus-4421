# Nexus Trading Labs

**The trading terminal that makes you a better trader.**

A non-custodial perpetuals trading terminal built on [Orderly Network](https://orderly.network), customized far beyond a stock DEX into a full **plan → automate → prove** workflow. The order book is the commodity; the edge on top is the product.

🔗 **Live:** [trade.nexustradinglabs.com](https://trade.nexustradinglabs.com) · [landing](https://nexustradinglabs.com) · [𝕏 @nexustradinglab](https://x.com/nexustradinglab)

---

## What it is

Most apps just let you trade. Nexus turns every position into a process:

- **🧪 The Lab** — the flagship. Market intel, an on-chain thesis engine, an autonomous agent, copy trades, an analytics + trade journal, and a holders room, in one terminal.
- **◎ Thesis Engine** — size every trade like a desk (position sizing, R:R, funding cost, live P&L) and publish it as a timestamped, on-chain call.
- **⬡ Autonomous Agent** — a funding-edge trading bot that runs 24/7 within hard guardrails. Risk-free **PAPER** mode → **ASSISTED** signals → **AUTONOMOUS** execution. Order-only keys that **cannot withdraw**, daily-loss cap, max-trades/day, one-tap kill switch, keys encrypted at rest.
- **◆ // NEXUS AI** — a copilot wired into the live terminal (market regime, your positions, your track record, the leaderboards). Free with your own key (client-side, never touches our servers) or hosted for PRO with selectable model tiers.
- **⛓ Trustless track records** — human "calls" are graded against **public price** (first-touch TP vs SL), agent trades against settled exchange orders. The full ledger hashes to a root that's **anchored on-chain hourly** and recomputable by anyone. Don't trust the leaderboard — verify it.
- **✉ Social** — a live feed of real on-chain calls, one-click copy trades, and encrypted wallet-to-wallet DMs (XMTP).
- **🏦 Transparent treasury** — a public multisig you can watch on-chain; fees accumulate into a held $NEXUS war chest that funds retroactive, merit-graded Seasons.

**Nexus PRO** is a plain software subscription (USDC, or $NEXUS at a discount, or unlocked by holding) — no yield, no revenue share. **$NEXUS** is a community token: cosmetic perks and access only. Nothing in the app is financial advice.

---

## Architecture

```
React + Vite + TypeScript (Cloudflare Pages)
        │  Orderly SDK · wagmi · XMTP
        ▼
Cloudflare Workers
  ├─ nexus-lab-api      lab storage, agent control, payments, trustless ledger
  ├─ nexus-agent-brain  funding + OI confluence signals (cron)
  ├─ nexus-agent-exec   non-custodial position execution + monitoring (cron)
  ├─ nexus-lab-alerts   alerts
  └─ nexus-ledger-anchor hourly Merkle-root anchor + ops monitoring
        │
        ▼
NexusLedgerAnchor.sol (Arbitrum) — append-only on-chain ledger anchor
```

- **Frontend:** React + react-router, TypeScript, [Orderly SDK](https://github.com/OrderlyNetwork/js-sdk), wagmi, `@xmtp/browser-sdk`. Deployed to Cloudflare Pages via GitHub Actions (wrangler direct-upload).
- **Backend:** five Cloudflare Workers (KV-backed), pure money/trust logic extracted into tested `logic.mjs` modules (`node:test`).
- **On-chain:** a Solidity ledger-anchor contract on Arbitrum; the agent signs Orderly orders with ed25519 order-only keys.

~27K lines across 128 source files.

---

## Development

```sh
yarn install      # ⚠️ Yarn 4 — never npm install
yarn dev          # frontend dev server
node --test workers/<worker>/logic.test.mjs   # money/trust-path tests
```

Workers deploy with `npx wrangler deploy` in each worker directory.

---

## Stack

`TypeScript` · `React` · `Vite` · `Orderly Network SDK` · `wagmi` / `viem` · `XMTP` · `Cloudflare Workers + KV + Pages` · `Solidity` (Arbitrum) · `Supabase`

---

Built on [Orderly Network](https://orderly.network). © Nexus Trading Labs LLC.
