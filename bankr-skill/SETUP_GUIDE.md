# Getting Started with Nexus on Bankr

A step-by-step walkthrough for new traders — from zero to your first on-chain perp position with $20 USDC.

---

## Step 1 — Install the Nexus skill

In Bankr, paste this:

```
install the nexus skill from https://github.com/StephenBorst/nexus-4421/tree/main/bankr-skill
```

---

## Step 2 — Deposit collateral ($20 USDC)

Nexus routes execution through **Orderly Network** — a non-custodial orderbook. Your funds never leave your wallet until you open a position.

**Paste this prompt into Bankr:**

```
I want to start trading on Nexus with $20 USDC. Walk me through:
1. Depositing $20 USDC as collateral on Orderly Network (Arbitrum)
2. Registering my trading account
3. Confirming my available balance before I trade
```

**What happens:**
- Bankr will guide you to bridge/send USDC to Arbitrum if needed
- You'll approve a deposit transaction to the Orderly vault contract
- Your $20 becomes available as margin — fully non-custodial, withdraw anytime

> ⚡ You need a small amount of ETH on Arbitrum for gas (~$0.10–0.50 worth). Bridge at bridge.arbitrum.io if needed.

---

## Step 3 — Check the leaderboard before you trade

See who's actually winning before you copy anyone:

```
Show me the top 5 traders on Nexus by Rep Score
```

Bankr will return a ranked table with each trader's:
- Rep Score (0–100, on-chain verified)
- Win rate
- W/L record
- Avg R:R
- Active trade count

Traders with ⛓ are verified — their track record is provably immutable on Arbitrum.

---

## Step 4 — Copy a verified thesis

Once you've found a trader you trust:

```
Copy the top Nexus trader's latest active thesis using 2% of my $20 account
```

Bankr will:
1. Pull their active thesis (entry, SL, TP levels)
2. Calculate your position size: `$20 × 2% = $0.40 risk`
3. Size the trade so your max loss = $0.40
4. Save the copy to your Nexus LAB with attribution
5. Ask if you want to publish it publicly or keep it private

---

## Step 5 — Place the trade

After copying a thesis, execute it:

```
Open a long on BTC/USDC perp on Nexus at market price, sized for 2% risk on my $20 account with SL at [price] and TP at [price]
```

Bankr will:
1. Calculate the exact position size and leverage
2. Submit the order through Orderly Network
3. Confirm fill price and order ID
4. Link the open position to your thesis in the LAB

---

## Step 6 — Publish your thesis on-chain (optional)

If you want your trade on the leaderboard and verifiable forever:

```
Publish my BTC long thesis on-chain to Nexus
```

This triggers a MetaMask transaction calling `registerThesis()` on the ThesisRegistry contract (Arbitrum). Costs ~$0.02 in gas. Your thesis gets a permanent on-chain ID and shows on the Nexus feed with the ⛓ badge.

---

## Quick reference prompts

| What you want | Prompt |
|---|---|
| See leaderboard | `Show me the top traders on Nexus by Rep Score` |
| Find active BTC trades | `Show me active BTC theses on Nexus` |
| Copy best trader | `Copy the #1 Nexus trader's latest thesis with 2% risk` |
| Check your stats | `What's my Nexus Rep Score and track record?` |
| Publish a thesis | `Publish my ETH short: entry 3200, SL 3350, TP 2800` |
| Check P&L | `What's my unrealized P&L on my open Nexus positions?` |
| See trending theses | `Show me the most copied theses on Nexus right now` |
| Check a wallet | `What's the track record of wallet 0x...?` |

---

## Key facts

- **Minimum deposit:** No minimum — $20 is plenty to start
- **Leverage:** Up to 20x on major pairs (BTC, ETH, SOL)
- **Fees:** 0.05% maker / 0.06% taker (Orderly standard)
- **Withdrawals:** Anytime, non-custodial, your keys your funds
- **Chain:** Arbitrum One — fast and cheap (~$0.01–0.05 per tx)
- **No KYC, no account, no email** — wallet is your identity

---

Built by [@borstxbt](https://x.com/borstxbt) · [nexustradinglabs.com](https://nexustradinglabs.com) · [trade.nexustradinglabs.com](https://trade.nexustradinglabs.com)
