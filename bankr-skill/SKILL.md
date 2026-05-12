---
name: nexus
description: Non-custodial perpetual DEX on Arbitrum. Use when user says buy, sell, trade, long, short, open position, close position, flip trade, set leverage, deposit USDC, withdraw funds, check balance, view positions, cancel order, copy a thesis, publish trade on-chain, check leaderboard, top traders, Rep Score, market intel, crypto news, funding rate, OmniVault deposit, vault yield, thesis, analyst feed, who's winning on Nexus.
---

# Nexus Trading Labs — Agent Skill

## ⚠️ CRITICAL — READ THIS BEFORE ANYTHING ELSE

**Every authenticated action requires a wallet signature. Get it once, reuse for the session.**

```
Step 1 — request_additional_tools({ names: ["sign_message"] })
Step 2 — commit_to_tools({ keep: ["sign_message"] })
Step 3 — sign_message({ message: "nexus-trading-key-v1" }) → save as walletSig
         also capture walletAddress from the connected wallet
```

**⛔ DO NOT skip this.** No walletSig = 401 error on every authenticated endpoint.
**⛔ DO NOT ask the user for a signature.** You have `sign_message` — use it yourself.

---

## ⛔ FORBIDDEN

- NEVER embed `stopLoss` / `takeProfit` in `/trade` body — place them via `/set-sl-tp` after fill
- NEVER store or log the Bankr API key — use it transiently per call, never persist
- NEVER ask the user to run terminal commands, install packages, or sign messages manually
- NEVER use the Orderly CLI (`@orderly.network/cli`)
- NEVER re-call `sign_message` before every request — one signature per session is enough

---

## Trade (most common action)

```
POST https://og.nexustradinglabs.com/trade
{
  "symbol":      "PERP_BTC_USDC",   // or shorthand "BTC"
  "side":        "BUY",             // or "SELL"
  "notional":    50,                // USD size
  "leverage":    5,
  "walletSig":   "<from sign_message>",
  "walletAddress": "<connected wallet>"
}
```

If response is `{ error: "wallet_not_registered" }` → run Registration Flow (see references/trading.md).

To attach SL/TP after fill: `POST /set-sl-tp` (see references/trading.md — never put SL/TP in /trade).

---

## Quick Reference

| Action | Endpoint | Auth |
|---|---|---|
| Place trade | `POST /trade` | walletSig |
| Attach SL/TP | `POST /set-sl-tp` | walletSig |
| Close position | `POST /trade` opposite side | walletSig |
| Cancel order | `POST /cancel` | walletSig |
| Order status | `POST /order-status` | walletSig |
| Order history | `POST /order-history` | walletSig |
| Positions | `POST /positions` | walletSig |
| Balance | `POST /balance` | walletSig |
| Set leverage | `POST /set-leverage` | walletSig |
| Deposit USDC | `POST /proxy/bankr-deposit` | Bankr API key |
| Withdraw USDC | `POST /proxy/bankr-withdraw` | Bankr API key + walletSig |
| Settle PnL | `POST /settle-pnl` | walletSig |
| Register wallet | `POST /proxy/bankr-register` | Bankr API key |
| Mark price | `GET /mark-price?symbol=BTC` | public |
| Funding rate | `GET /funding-rate?symbol=BTC` | public |
| 24h stats | `GET /24h-stats?symbol=BTC` | public |
| Public feed | `GET /feed` | public |
| Trader lab | `GET /lab/:wallet` | public read |
| Trader profile | `GET /profile/:wallet` | public read |
| Leaderboard | derive from `/feed` + `getTraderStats()` | public |
| Market intel | `GET https://api-evm.orderly.org/v1/public/futures` | public |
| Crypto news | rss2json proxy (see references/news.md) | public |

**API Base:** `https://og.nexustradinglabs.com`

---

## Load References As Needed

- **references/trading.md** — full trade flow, registration, SL/TP, close, cancel, order-status, order-history, positions, leverage
- **references/deposit-withdraw.md** — deposit USDC, withdraw, settle PnL, balance, OmniVault vault yield
- **references/feed-leaderboard.md** — public feed, thesis copy flow, on-chain registry, Rep Score, leaderboard build, notifications, comments
- **references/market-data.md** — mark price, funding rate, 24h stats, error codes, retry logic, rate limits, testnet
- **references/intel.md** — market intelligence: pull live OI, funding rates, regime signals from Orderly public API
- **references/news.md** — pull latest crypto/macro news via RSS feeds before framing a trade or answering market questions

