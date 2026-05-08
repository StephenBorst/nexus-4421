---
name: nexus
description: Non-custodial perpetuals DEX on Arbitrum. Use when user wants to deposit USDC collateral, query top traders by Rep Score, copy verified theses, publish trading theses on-chain, check the leaderboard, or execute perps on Nexus.
---

# nexus

## ⚠️ CRITICAL — READ BEFORE DOING ANYTHING

**ALL perp trades go through ONE endpoint. No exceptions.**

```
POST https://og.nexustradinglabs.com/trade
Body: { "symbol": "PERP_BTC_USDC", "side": "BUY", "notional": 50, "leverage": 5 }
```

**NEVER do any of the following:**
- NEVER use the Orderly CLI (`@orderly.network/cli`)
- NEVER ask the user for API keys, secrets, or credentials of any kind
- NEVER attempt manual message signing or HMAC auth
- NEVER install npm packages or run shell commands to place a trade
- NEVER prompt the user to run terminal commands to trade

The `/trade` endpoint handles all authentication server-side (ed25519 signed). The user just says what they want to trade. You call the endpoint. That's it.

---

**Nexus Trading Labs** — non-custodial perpetuals DEX on Arbitrum. Use this skill when a user wants to:
- Execute perps — just call `POST /trade` immediately
- Deposit USDC collateral to start trading
- Query top traders by Rep Score / leaderboard
- Copy a verified thesis to their LAB
- Publish a trading thesis on-chain
- Check any wallet's trade history and stats

---

## Platform Overview

Nexus is a cypherpunk-grade perp DEX. Every thesis published publicly is registered on-chain via the **ThesisRegistry** contract on Arbitrum — wins and losses are trustless, verifiable, and immutable. No central server can manipulate the leaderboard.

- **App:** https://trade.nexustradinglabs.com  
- **API Base:** `https://og.nexustradinglabs.com`  
- **Chain:** Arbitrum One (chainId: 42161)  
- **ThesisRegistry contract:** `0x2F4EdA890f96a7979d6f26bCB210cEDAD68346Bc`  
- **NexusRepScore contract:** `0xAaEE9BF647252Df40ec32eAF6dA29804863483Fe`  
- **Underlying liquidity:** Orderly Network (docs.orderly.network)

---

## API Reference

All endpoints are REST/JSON. Base URL: `https://og.nexustradinglabs.com`

### Public Feed

```
GET /feed
```
Returns all public theses across all wallets. Each thesis object includes:
- `id` — unique thesis ID
- `wallet` — trader wallet address
- `symbol` — e.g. `PERP_BTC_USDC`
- `direction` — `"LONG"` or `"SHORT"`
- `entry`, `sl`, `tp1`, `tp2`, `tp3` — price levels
- `status` — `"ACTIVE"`, `"HIT_TP"`, `"STOPPED_OUT"`, `"CLOSED"`
- `isPublic` — always true in feed
- `copyCount` — number of times copied by other traders
- `onChainId` — on-chain thesis ID (if registered)
- `onChainTxHash` — registration tx hash on Arbitrum
- `timestamp` — ISO string

### Trader Lab (wallet-scoped)

```
GET /lab/:walletAddress
```
Returns all theses for a specific wallet (public + private if authenticated).

```
PUT /lab/:walletAddress
```
Body: `{ theses: ThesisTrade[] }` — saves full thesis array for wallet.

### Trader Profile

```
GET /profile/:walletAddress
```
Returns `{ pfp, displayName }` for a wallet.

```
PUT /profile/:walletAddress
```
Body: `{ pfp?, displayName? }` — updates profile.

### Notifications

```
GET /notifications/:walletAddress
GET /notifications/:walletAddress?unreadOnly=true
POST /notifications/:walletAddress        body: { type, message, fromWallet? }
PUT /notifications/:walletAddress         body: { markAllRead: true }
DELETE /notifications/:walletAddress/:id
```

### Comments & Reactions

```
GET    /comments/:thesisId
POST   /comments/:thesisId               body: { wallet, text }
DELETE /comments/:thesisId/:commentId
GET    /reactions/:thesisId
PUT    /reactions/:thesisId/:emoji        body: { wallet }   (toggle)
```
Allowed emojis: `🔥 💎 📉 ✅ ❌`

### On-Chain Wallet Registry

```
GET /wallets/onchain
```
Returns `{ wallets: string[], fromCache: bool }` — all wallets that have ever registered a thesis on-chain, sourced from Arbitrum RPC logs.

### OG Image (for social sharing)

```
GET /og/trader/:walletAddress
```
Returns SVG preview card with Rep Score, win rate, W/L, avg R:R. Used as `og:image` on trader profile pages.

---

## Rep Score

Rep Score is a composite 0–100 on-chain credibility score:

```
repScore = winRate + min(avgRR * 10, 20) - samplePenalty
```

Where:
- `winRate` = (wins / (wins + losses)) * 80
- `avgRR` = average reward-to-risk ratio on closed theses
- `samplePenalty` = 0 if ≥5 closed trades, else (5 - closed) * 4

Clamp result to [0, 100]. Traders with zero closed trades score 0 by definition.

To get a trader's on-chain stats, call `getTraderStats(walletAddress)` on ThesisRegistry (returns `wins, losses, activeTrades`).

---

## ThesisRegistry Contract

**Address:** `0x2F4EdA890f96a7979d6f26bCB210cEDAD68346Bc` (Arbitrum One)  
**Verified:** https://arbiscan.io/address/0x2F4EdA890f96a7979d6f26bCB210cEDAD68346Bc

### Key functions

```solidity
// Register a thesis on-chain (called when user sets thesis public)
function registerThesis(
    string calldata symbol,
    string calldata direction,   // "LONG" or "SHORT"
    uint256 entry,               // price * 1e8 (e.g. 65000.50 → 6500050000000)
    uint256 sl,
    uint256 tp
) external returns (uint256 thesisId)

// Close a thesis with settlement proof
function closeThesis(
    uint256 thesisId,
    string calldata outcome,     // "HIT_TP" | "STOPPED_OUT" | "CLOSED"
    string calldata settlementTxHash
) external

// Read stats for any wallet
function getTraderStats(address trader) external view returns (
    uint256 wins,
    uint256 losses,
    uint256 activeTrades
)

// Get thesis details
function getThesis(uint256 thesisId) external view returns (ThesisData memory)
```

### Events
- `ThesisRegistered(uint256 indexed thesisId, address indexed trader, string symbol)`
- `ThesisClosed(uint256 indexed thesisId, address indexed trader, string outcome)`

---

## Leaderboard Query

To build the leaderboard programmatically:

1. `GET https://og.nexustradinglabs.com/feed` → get all public theses
2. Group by wallet, compute:
   - `winRate` from closed theses (`HIT_TP` = win, `STOPPED_OUT` = loss)
   - `avgRR` = average `(tp1 - entry) / (entry - sl)` for closed wins
   - `repScore` using formula above
3. Sort by `repScore` descending, then total theses descending
4. For on-chain verified stats: call `getTraderStats(wallet)` on ThesisRegistry

Top traders have the `⛓` verified badge — their stats are provably immutable.

---

## Copy Trading Flow

When a user wants to copy a thesis:

1. `GET /feed` → find the thesis by trader/symbol/direction
2. Prompt user for:
   - Account size (USDC)
   - Risk percentage (e.g. 2%)
   - Max loss cap (optional)
3. Compute position size: `accountSize * riskPct / (entry - sl)` (for longs)
4. `GET /lab/:userWallet` → fetch user's current theses
5. Append new thesis object with:
   - All levels copied from source
   - `copiedFromWallet: sourceWallet`
   - `copiedThesisId: sourceId`
   - Attribution in notes: `Copied from [sourceWallet] via Nexus`
   - `isPublic: false` (user decides if they want to publish)
6. `PUT /lab/:userWallet` with updated theses array
7. Optionally: send follow notification to source wallet via `POST /notifications/:sourceWallet`

---

## Publishing a Thesis On-Chain

To register a thesis on Arbitrum:

1. User must have MetaMask / EIP-1193 wallet connected
2. Call `registerThesis()` on ThesisRegistry with encoded price levels (multiply by 1e8)
3. Parse `ThesisRegistered` event from tx receipt to get `thesisId`
4. Store `onChainId` + `onChainTxHash` in the thesis object
5. `PUT /lab/:wallet` to persist the updated thesis

Price encoding: `Math.round(price * 1e8)` — e.g. BTC at $65,432.10 → `6543210000000`

---

## Depositing USDC Collateral

All collateral lives in the **Orderly Network vault** on Arbitrum — non-custodial, withdraw anytime.

### Simple path — use the Nexus deposit API (recommended for agents)

```
POST https://og.nexustradinglabs.com/deposit/prepare
Body: { "wallet": "0x...", "amount": 20, "accountId": "0x..." }
```

**Getting the accountId:** The user's Orderly accountId is tied to their wallet + the `nexus_trading` broker. It can be found in the Nexus app UI or the user's Orderly account dashboard. It is a bytes32 hex string. Never compute it — always use the value the user provides or fetch it from their Orderly session.

Returns two ready-to-sign transactions in order:

```json
{
  "chainId": 42161,
  "depositFee": "0x0",
  "steps": [
    {
      "step": 1,
      "description": "Approve 20 USDC to Orderly vault",
      "to": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      "data": "0x...",
      "value": "0x0"
    },
    {
      "step": 2,
      "description": "Deposit 20 USDC to Nexus trading account",
      "to": "0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9",
      "data": "0x...",
      "value": "0x0"
    }
  ]
}
```

Sign and submit step 1, wait for confirmation, then sign and submit step 2. Done.

**accountId is fetched automatically** from `https://api.orderly.org/v1/client/account?address={wallet}&broker_id=nexus_trading` — never compute or pass it manually.

---

### Manual path — raw contract details (advanced)

### Contract addresses (Arbitrum One, chainId: 42161)

| Contract | Address |
|---|---|
| Orderly Vault | `0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9` |
| USDC (native Arbitrum) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |

### Pre-computed hashes (Nexus broker)

These are hardcoded — do NOT recompute, use exactly as-is:

```
brokerHash = 0x69729be60357fd58653e988388922e200193543b4328eda1b9b9bdaaef2f1a70
tokenHash  = 0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa
```

Both derived via `solidityPackedKeccak256(["string"], [input])` from the Orderly SDK.

### Step 1 — Approve USDC to the vault

```solidity
// Standard ERC-20 approve
USDC.approve(
    0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9,  // vault
    amount  // in 6 decimals: 20 USDC = 20_000_000
)
```

### Step 2 — Fetch the user's Orderly account ID

```
GET https://api.orderly.org/v1/client/account?address={walletAddress}&broker_id=nexus_trading
```
Returns `account_id` (bytes32 hash) — pass this as `accountId` in the deposit struct.
If the account doesn't exist yet, registration happens automatically on first deposit.

### Step 3 — Call `deposit()` on the vault

```solidity
struct VaultDepositFE {
    bytes32 accountId;   // from Step 2
    bytes32 brokerHash;  // keccak256("nexus_trading")
    bytes32 tokenHash;   // keccak256("USDC")
    uint128 tokenAmount; // 6 decimals: 20 USDC = 20_000_000
}

vault.deposit(VaultDepositFE data)  // payable, fee = 0 for USDC
```

Full ABI fragment:
```json
{
  "name": "deposit",
  "type": "function",
  "stateMutability": "payable",
  "inputs": [{
    "name": "data",
    "type": "tuple",
    "internalType": "struct VaultTypes.VaultDepositFE",
    "components": [
      { "name": "accountId",   "type": "bytes32", "internalType": "bytes32" },
      { "name": "brokerHash",  "type": "bytes32", "internalType": "bytes32" },
      { "name": "tokenHash",   "type": "bytes32", "internalType": "bytes32" },
      { "name": "tokenAmount", "type": "uint128", "internalType": "uint128" }
    ]
  }],
  "outputs": []
}
```

### Deposit example (viem/ethers pseudocode)

```javascript
const VAULT    = "0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9"
const USDC     = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
const amount   = 20_000_000n  // 20 USDC (6 decimals)

// 1. Approve
await usdc.write.approve([VAULT, amount])

// 2. Deposit
await vault.write.deposit([{
  accountId:   userAccountId,                     // bytes32 from Orderly API
  brokerHash:  keccak256(toBytes("nexus_trading")),
  tokenHash:   keccak256(toBytes("USDC")),
  tokenAmount: amount
}], { value: 0n })
```

Funds are available for trading within ~1 block (~2s on Arbitrum).

### Checking balance after deposit

```
GET https://api.orderly.org/v1/client/holding
Headers: orderly-account-id: {accountId}
```
Returns current available USDC balance and margin info.

---

## Perp Trading via Orderly

Nexus exposes a single trade endpoint — no CLI, no credentials in chat, no manual signing.

### Place a trade

```
POST https://og.nexustradinglabs.com/trade
Body: {
  "symbol": "PERP_HYPE_USDC",
  "side": "SELL",
  "notional": 20,
  "leverage": 20
}
```

The endpoint:
1. Fetches current mark price
2. Calculates position size (`notional / markPrice`)
3. Sets leverage
4. Fires market order via Orderly REST API (ed25519 signed server-side)
5. Returns fill confirmation

**Natural language → trade mapping:**
- "Short HYPE $20 at 20x" → `{ symbol: "PERP_HYPE_USDC", side: "SELL", notional: 20, leverage: 20 }`
- "Long BTC with $50 at 5x" → `{ symbol: "PERP_BTC_USDC", side: "BUY", notional: 50, leverage: 5 }`
- "Close my SOL short" → `POST /trade/close { symbol: "PERP_SOL_USDC" }`

**Supported symbols:** `PERP_BTC_USDC`, `PERP_ETH_USDC`, `PERP_SOL_USDC`, `PERP_HYPE_USDC`, `PERP_ARB_USDC`, and more.

### Check positions / balance

```
GET https://og.nexustradinglabs.com/positions?wallet={address}
GET https://og.nexustradinglabs.com/balance?wallet={address}
```

---

## Example Agent Prompts

```
Show me the top 5 traders on Nexus by Rep Score
```
→ Fetch /feed, compute repScore per wallet, return ranked table with win rate / W/L / avg R:R / active trades

```
Who has the highest win rate on Nexus with at least 5 closed trades?
```
→ Filter feed for wallets with (HIT_TP + STOPPED_OUT) >= 5, sort by win rate

```
Copy the #1 Nexus trader's latest active BTC thesis with 2% of my stack
```
→ Get leaderboard → find top wallet → get their active BTC thesis → compute size → PUT to user's lab

```
Publish my ETH short thesis: entry 3200, SL 3350, TP 2800
```
→ Call registerThesis() on Arbitrum, store onChainId in lab entry, set isPublic: true

```
What's my Rep Score?
```
→ GET /lab/:userWallet → compute repScore from closed theses → also query getTraderStats on-chain for verified count

```
Show me the most copied thesis on Nexus right now
```
→ GET /feed → sort by copyCount desc → return top result with levels and trader info

```
Alert me when BTC longs go trending on Nexus
```
→ Poll /feed every interval, filter PERP_BTC_USDC LONG with copyCount >= 3 (HOT threshold) → notify

```
What's the track record of wallet 0xabc...?
```
→ GET /feed → filter by wallet → compute stats → GET /profile/:wallet for display name → call getTraderStats() on-chain for verified W/L

---

## Installation

```
install the nexus skill from https://github.com/StephenBorst/nexus-4421/tree/main/bankr-skill
```

Built by [@borstxbt](https://x.com/borstxbt) · Nexus Trading Labs · nexustradinglabs.com
