---
name: nexus
description: Non-custodial perpetuals DEX on Arbitrum. Use when user wants to deposit USDC collateral, query top traders by Rep Score, copy verified theses, publish trading theses on-chain, check the leaderboard, or execute perps on Nexus.
---

# nexus

## ⚠️ CRITICAL — READ BEFORE DOING ANYTHING

**ALL perp trades go through ONE endpoint. The full sequence is NON-NEGOTIABLE — skipping any step will fail:**

### Step 1 — Request and commit `sign_message` tool
```
request_additional_tools({ names: ["sign_message"] })
commit_to_tools({ keep: ["sign_message"] })
```

### Step 2 — Get wallet signature (REQUIRED EVERY TRADE — no exceptions)

Call your OWN `sign_message` tool. Do NOT ask the user for a signature. Do NOT ask an external party. You have this tool — use it.

```
sign_message({ message: "nexus-trading-key-v1" })
```
This returns a `signature` hex string. Save it as `walletSig`.
Also capture the connected wallet address as `walletAddress`.

**⛔ DO NOT skip this step.** The server uses `walletSig` to derive the user's private signing key on the fly. Sending `walletAddress` alone returns a `walletSig_required` 401 error. `walletSig` is not optional — call `sign_message` yourself before every trade.

### Step 3 — POST to /trade with BOTH walletSig AND walletAddress
```
POST https://og.nexustradinglabs.com/trade
Body: {
  "symbol": "PERP_BTC_USDC",
  "side": "BUY",
  "notional": 50,
  "leverage": 5,
  "walletSig": "<signature from step 2>",
  "walletAddress": "<connected wallet address>",
  "stopLoss": 60000,      // optional — SL trigger price (closes entire position)
  "takeProfit": 75000     // optional — TP trigger price (closes entire position)
}
```

`stopLoss` and `takeProfit` are optional. If provided, the server places a single `POSITIONAL_TP_SL` algo order on Orderly immediately after the entry fill — closes the full position automatically at those prices. No extra calls needed from the skill.

The server derives the user's ed25519 trading key from `walletSig` (sha256 → PKCS8 → Ed25519). No private keys ever leave the user's wallet. Non-custodial by design.

**If the server returns `{ error: "wallet_not_registered" }` (HTTP 401):**

Trigger the one-time registration flow — fully automated, no browser needed:

### Registration Flow (runs once per wallet)

**Step R1 — Ask for Bankr API key**

Tell the user:
> "Your wallet `<walletAddress>` isn't linked to a Nexus trading account yet. I need your Bankr API key to complete the one-time setup — it's only used for this registration and never stored. You can find it at bankr.bot/api (enable 'Wallet & Agent API' if not already on)."

**Step R2 — Call `/proxy/bankr-register`**
```
POST https://og.nexustradinglabs.com/proxy/bankr-register
Body: {
  "walletAddress": "<walletAddress from sign_message>",
  "bankrApiKey": "<API key the user provided>",
  "depositAmount": 5
}
```

The server will:
1. Check if wallet has an Orderly account. If not (first-time user):
   - Fetch a registration nonce from Orderly
   - EIP-712 sign a `Registration` message via Bankr's Wallet API → creates Orderly account (no on-chain tx needed)
2. Call Bankr's REST API for `personal_sign` on `"nexus-trading-key-v1"` → derive their ed25519 trading key
3. Call Bankr's REST API for `eth_signTypedData_v4` → sign the Orderly key registration (`AddOrderlyKey`)
4. Register the key with Orderly Network
5. Store `{ accountId, orderlyKey }` in KV — wallet is now linked

No deposits or on-chain transactions required for registration.

**If Step R2 returns an error about EIP-712 being blocked:**
> "Your Bankr API key has 'allowed recipients' restrictions that block EIP-712 signing. Please generate a new API key at bankr.bot/api without the 'allowed recipients' restriction, then try again."

**Step R3 — Retry the trade**

Once registration succeeds, immediately retry the original `POST /trade` call with the same `walletSig` and `walletAddress`. It will succeed — no user action needed.

**NEVER do any of the following:**
- NEVER use the Orderly CLI (`@orderly.network/cli`)
- NEVER ask the user for API keys, secrets, or credentials except the Bankr API key during the registration flow above
- NEVER attempt manual message signing or HMAC auth
- NEVER install npm packages or run shell commands to place a trade
- NEVER prompt the user to run terminal commands to trade
- NEVER store the Bankr API key — it's only used transiently during registration

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

## Withdrawing USDC Collateral

Fully server-side via Bankr EIP-712 signing — no on-chain transaction needed from the user.

```
POST https://og.nexustradinglabs.com/proxy/bankr-withdraw
Body: {
  "walletAddress": "<connected wallet>",
  "bankrApiKey": "<Bankr API key — REQUIRED, agent must always include this>",
  "amount": 20
}
```

**⚠️ `bankrApiKey` is MANDATORY in the request body.** The server uses it transiently to call Bankr's signing endpoint — it is never stored. If the agent omits it, the server returns 401 "invalid api key". Always include the user's Bankr API key in every withdrawal call. Same key as used for deposit and registration.

The server:
1. Derives the user's ed25519 key (for Orderly auth) from Bankr `personal_sign`
2. Fetches a withdrawal nonce from Orderly
3. Builds an EIP-712 `Withdraw` message
4. Signs it via Bankr `eth_signTypedData_v4`
5. Submits to Orderly `/v1/withdraw_request`

Orderly processes and sends funds to the user's wallet address on Arbitrum. No approval or on-chain transaction required from the user.

**When to ask for Bankr API key:** Always ask before withdrawal. Tell the user: "I need your Bankr API key to sign the withdrawal. Find it at bankr.bot/api — Wallet & Agent API must be enabled."

Returns `{ ok: true, amount, withdrawNonce }` on success.

### Withdrawal fails with code 78 — "margin is occupied"

This means there is unsettled negative PnL blocking the withdrawal. Fix: settle PnL first, then withdraw a smaller amount that accounts for the loss.

**Step 1 — settle PnL:**
```
POST https://og.nexustradinglabs.com/settle-pnl
Body: {
  "walletAddress": "<wallet>",
  "walletSig": "<from sign_message('nexus-trading-key-v1')>",
  "symbol": "SOL"   // optional — omit to settle all positions
}
```

Returns `{ ok: true, hint: "Wait ~5s then retry withdrawal with free_collateral amount." }`

**Step 2 — check free collateral:**
```
POST https://og.nexustradinglabs.com/balance
Body: { "walletAddress": "<wallet>", "walletSig": "<sig>" }
```

Look for `free_collateral` in the response. Withdraw that amount (not total balance).

**Step 3 — withdraw free_collateral amount:**
```
POST https://og.nexustradinglabs.com/proxy/bankr-withdraw
Body: { "walletAddress": "...", "bankrApiKey": "...", "amount": <free_collateral> }
```

**Full automated flow for withdrawal with unsettled PnL:**
1. `sign_message({ message: "nexus-trading-key-v1" })` → walletSig
2. `POST /settle-pnl` with walletSig
3. Wait 5 seconds
4. `POST /balance` → get free_collateral
5. `POST /proxy/bankr-withdraw` with free_collateral amount and bankrApiKey

---

## Depositing USDC Collateral

All collateral lives in the **Orderly Network vault** on Arbitrum — non-custodial, withdraw anytime.

### Agent path — fully automated via Bankr /wallet/submit (recommended)

```
POST https://og.nexustradinglabs.com/proxy/bankr-deposit
Body: {
  "walletAddress": "<connected wallet>",
  "bankrApiKey": "<user's Bankr API key>",
  "amount": 20
}
```

The server:
1. Fetches accountId from Orderly automatically
2. Builds USDC `approve` calldata
3. Submits approve tx via `POST https://api.bankr.bot/wallet/submit` — signs + broadcasts in one step
4. Waits for on-chain confirmation
5. Builds `vault.deposit()` calldata
6. Submits deposit tx via `/wallet/submit`

Returns `{ ok: true, amount, accountId, approveTxHash, depositTxHash }` on success. Funds live in Nexus within ~2 Arbitrum blocks (~4s).

**Requires:** Wallet & Agent API enabled on bankrApiKey, wallet has USDC on Arbitrum, wallet has ~0.00001 ETH for LayerZero fee.

**⚠️ allowedRecipients blocker:** If the Bankr API key has `allowedRecipients` configured, `/wallet/submit` blocks all raw tx submission. The server returns a `403` with a clear hint. Fix: go to `bankr.bot/api`, clear the `allowedRecipients` list, retry. Or use the manual path below.

**When to ask for Bankr API key:** Tell the user: "I need your Bankr API key to submit the deposit. Find it at bankr.bot/api — same key used for trading."

---

### Prepare-only path — returns calldata for manual signing

```
POST https://og.nexustradinglabs.com/deposit/prepare
Body: { "wallet": "0x...", "amount": 20 }
```

**accountId is fetched automatically** — never pass it in the body. The server calls `https://api.orderly.org/v1/client/account?address={wallet}&broker_id=nexus_trading` to get it.

Returns two ready-to-sign transactions in order:

```json
{
  "chainId": 42161,
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
      "value": "0x2386F26FC10000",
      "note": "Requires ~0.00001 ETH for LayerZero fee"
    }
  ]
}
```

Sign and submit step 1, wait for confirmation, then sign and submit step 2.

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

Always follow the 3-step sequence at the top of this skill (sign_message → derive key → POST /trade).

```
POST https://og.nexustradinglabs.com/trade
Body: {
  "symbol": "PERP_HYPE_USDC",
  "side": "SELL",
  "notional": 20,
  "leverage": 20,
  "walletSig": "<from sign_message('nexus-trading-key-v1')>",
  "walletAddress": "<user's connected wallet address>"
}
```

The endpoint:
1. Derives user's ed25519 key from `walletSig` (sha256 → PKCS8 → Ed25519 — fully server-side)
2. Looks up user's Orderly accountId from KV (set during one-time registration)
3. Fetches mark price and computes position size
4. Sets leverage, fires market order via Orderly REST API
5. Returns fill confirmation

**Natural language → trade mapping:**
- "Short HYPE $20 at 20x" → `{ symbol: "PERP_HYPE_USDC", side: "SELL", notional: 20, leverage: 20 }`
- "Long BTC with $50 at 5x" → `{ symbol: "PERP_BTC_USDC", side: "BUY", notional: 50, leverage: 5 }`
- "Short SOL $15 at 5x, SL 100, TP 80" → trade first, then call `/set-sl-tp` (see below)

**Supported symbols:** `PERP_BTC_USDC`, `PERP_ETH_USDC`, `PERP_SOL_USDC`, `PERP_HYPE_USDC`, `PERP_ARB_USDC`, `PERP_XMR_USDC`, and more. The Worker auto-normalizes shorthand — "BTC", "ETH", "SOL", "XMR" all work.

### Attach SL/TP to an open position (ALWAYS a separate step after trade confirmation)

**⛔ DO NOT embed stopLoss/takeProfit in the /trade call.** Always call `/set-sl-tp` as a distinct step AFTER the trade fills.

```
POST https://og.nexustradinglabs.com/set-sl-tp
Body: {
  "symbol": "PERP_SOL_USDC",
  "stopLoss": 100,        // optional
  "takeProfit": 80,       // optional
  "walletSig": "<from sign_message('nexus-trading-key-v1')>",
  "walletAddress": "<connected wallet>"
}
```

The server fetches the current position size from Orderly, then places a `POSITIONAL_TP_SL` algo order that closes the entire position when either price is hit. Returns `{ ok: true, quantity, stopLoss, takeProfit }` on success.

**Full SL/TP flow:**
1. `sign_message({ message: "nexus-trading-key-v1" })` — get walletSig (once per session)
2. `POST /trade` — open position, wait for fill confirmation
3. `POST /set-sl-tp` — attach SL/TP using same walletSig

---

### Close a position

To close an open position, place the opposite side trade with `reduce_only: true` and no `notional` — use the exact quantity from the open position:

```
POST https://og.nexustradinglabs.com/trade
Body: {
  "symbol": "PERP_SOL_USDC",
  "side": "BUY",           // opposite of the open position
  "notional": 15,          // match original notional — server will compute qty and close
  "leverage": 5,
  "walletSig": "<from sign_message>",
  "walletAddress": "<wallet>"
}
```

Or simply instruct Bankr: "close my SOL short" — it will execute the opposite side automatically.

### Check positions / balance

Requires walletSig (call sign_message first, same as trading). **Use POST — more reliable than GET with long hex params:**

```
POST https://og.nexustradinglabs.com/positions
Body: { "walletAddress": "<wallet>", "walletSig": "<sig from sign_message>" }

POST https://og.nexustradinglabs.com/balance
Body: { "walletAddress": "<wallet>", "walletSig": "<sig from sign_message>" }
```

GET with query params also accepted: `?wallet={address}&sig={walletSig}`

**Always check /positions before opening a trade** — overlapping positions consume all available margin. If `position_qty > 0`, close or account for it before opening a new position on the same symbol.

---

## Example Agent Prompts

```
Show me the top 5 traders on Nexus by Rep Score
```
→ `GET /feed` → group theses by wallet → for each wallet compute `wins` (HIT_TP), `losses` (STOPPED_OUT), `avgRR` (mean of `(tp1-entry)/(entry-sl)` on wins) → apply repScore formula → sort desc → return top 5 with wallet, repScore, winRate, W/L, avgRR, active count

```
Who has the highest win rate on Nexus with at least 5 closed trades?
```
→ `GET /feed` → filter wallets where `(HIT_TP + STOPPED_OUT) >= 5` → sort by `wins/(wins+losses)` desc → return top result

```
What's my Rep Score?
```
→ `GET /feed` → filter by user's `walletAddress` → compute repScore using formula in Rep Score section → return score, win rate, W/L, avg R:R, active trades, sample penalty if < 5 closed

```
Copy the #1 Nexus trader's latest active BTC thesis with 2% of my stack
```
→ Build leaderboard (above) → get top wallet → find their active `PERP_BTC_USDC` thesis from `/feed` → compute size: `(accountSize * 0.02) / (entry - sl)` → `GET /lab/:userWallet` → append copied thesis with `copiedFromWallet`, `copiedThesisId`, `isPublic: false` → `PUT /lab/:userWallet`

```
Publish my ETH short thesis: entry 3200, SL 3350, TP 2800
```
→ `GET /lab/:userWallet` → find or create thesis object: `{ symbol: "PERP_ETH_USDC", direction: "SHORT", entryPrice: 3200, stopLoss: 3350, takeProfit1: 2800, status: "ACTIVE", isPublic: false }` → call `registerThesis("PERP_ETH_USDC", "SHORT", 320000000000, 335000000000, 280000000000)` on ThesisRegistry → parse `ThesisRegistered` event for `thesisId` → update thesis with `onChainId`, `onChainTxHash`, `isPublic: true` → `PUT /lab/:userWallet`

```
Show me all active theses on Nexus right now
```
→ `GET /feed` → filter `status === "ACTIVE"` → sort by `timestamp` desc → return symbol, direction, entry/SL/TP, trader wallet, copyCount

```
---

### Get mark price (current price before trading)

No auth required — public endpoint.

```
GET https://og.nexustradinglabs.com/mark-price?symbol=BTC
```

Returns `{ symbol, markPrice, indexPrice, lastPrice, openInterest, volume24h }`.

Use this before placing a trade when the user asks "what's BTC at?" or to size a position. Supports shorthand: `BTC`, `ETH`, `SOL`, `ARB`, `LINK`, `WIF` — or full `PERP_BTC_USDC` form.

---

### Cancel an open (unfilled) order

Use when a limit order hasn't filled and the user wants to cancel it. Requires the `order_id` from the original `/trade` response (`raw.data.order_id`).

```
POST https://og.nexustradinglabs.com/cancel
Body: {
  "walletAddress": "<wallet>",
  "walletSig": "<from sign_message('nexus-trading-key-v1')>",
  "orderId": 123456789,
  "symbol": "BTC"    // optional but recommended for speed
}
```

Returns `{ ok: true, orderId }` on success.

---

### Check order fill status

Poll to confirm a trade filled before attaching SL/TP. Use the `order_id` from `/trade` response.

```
POST https://og.nexustradinglabs.com/order-status
Body: {
  "walletAddress": "<wallet>",
  "walletSig": "<from sign_message('nexus-trading-key-v1')>",
  "orderId": 123456789
}
```

Returns `{ orderId, symbol, status, filled, executedQty, avgPrice }`.

`status` values: `NEW` (pending), `PARTIAL_FILLED`, `FILLED`, `CANCELLED`, `REJECTED`.

Market orders fill instantly — only poll for limit orders before calling `/set-sl-tp`.
