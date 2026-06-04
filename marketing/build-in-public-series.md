# Build-in-Public Series — "What We Shipped"

> Founder-led, daily-cadence posts (@nexustradinglab voice: cypherpunk-terminal,
> confident, verify-don't-trust). Each is grounded in REAL shipped work this build.
> Goal: continuous founder reach to beat the cold-start / Feed-liveness risk.
> Cadence: 1/day. Each ends with a soft pull to trade.nexustradinglabs.com.
> Rule: every post teaches one real thing. No hype without a receipt.

---

## POST 1 — The Autonomous Agent (the flagship flex)

```
We shipped an autonomous trading agent that runs 24/7.

Most "trading bots" mean: hand a stranger your keys and pray.

Ours uses order-only keys. It can open and close positions — it physically CANNOT withdraw or move your funds. Enforced at the exchange, not promised in a ToS.

Non-custodial autonomy. That's the whole point.
```
*Reply 1:* `Paper mode by default — prove the strategy at zero risk before a dollar moves. Live → trade.nexustradinglabs.com/lab`

---

## POST 2 — Encrypted keys at rest (the security receipt)

```
Quiet ship today: every agent trading key is now encrypted at rest. AES-256-GCM.

A leak of our database alone is worthless — the keys aren't readable without a separate secret the database never sees.

And even decrypted, the key can only trade. Never withdraw.

Defense in depth, because it's your money.
```
*Reply 1:* `The honest limit: an offline-autonomous agent has to be able to sign while you sleep. So we minimize + bound + encrypt what we hold, instead of pretending we hold nothing. That's the real standard.`

---

## POST 3 — The trustless leaderboard (the moat)

```
Every "track record" in crypto is a number in someone's database. You're asked to trust it.

Ours:
→ human calls graded from PUBLIC price (TP or SL first = a fact, not a self-report)
→ agent trades carry Orderly order IDs, auditable against the exchange
→ the whole ledger hashed + anchored to Arbitrum hourly

We literally cannot fake a number.
```
*Reply 1:* `Recompute the hash yourself from public data. Check it against the contract. That's the difference between a screenshot and proof. → trade.nexustradinglabs.com/feed`

---

## POST 4 — The signal (why it doesn't trade garbage)

```
The agent doesn't trade on vibes.

It only fires when TWO independent reads agree:
→ a funding-rate extreme (the crowd is overpaying for one side)
→ an open-interest divergence (positioning is weakening)

One signal alone = no trade. Confluence or nothing.

Same data's in Market Intel so you can read the tape it trades.
```
*Reply 1:* `Funding-only bots overtrade and bleed. Requiring confluence cuts the noise — fewer trades, better ones. We ported the exact logic from a validated single-user run.`

---

## POST 5 — Paper mode (the on-ramp)

```
You shouldn't trust a trading bot you haven't watched.

So new agents start in PAPER mode: same strategy, same live prices, zero capital at risk.

Build a track record. Watch it take TP, eat an SL, time out a trade. THEN flip it live — when you're convinced, not when we tell you to.
```
*Reply 1:* `And when it goes live, every call posts to the public feed in real time. The bot doesn't get to hide its losers either. Nobody here does.`

---

## POST 6 — Self-healing / reconciliation (the craftsmanship post)

```
Edge case we fixed this week:

What if you close the agent's position manually, mid-trade?

Old way: the bot keeps "managing" a ghost it no longer has.

Now: before every cycle it reconciles against the live exchange. Position gone? It clears its own record and moves on. No ghost, no bogus trade.

Details matter when it's real money.
```
*Reply 1:* `This is the unglamorous 80% nobody tweets about. It's also the difference between a demo and something you'd actually run unattended.`

---

## POST 7 — The thesis / the "why" (the manifesto close)

```
Nobody needs another perp DEX. So we didn't build one.

The exchange is the rails. The Lab is the product:

plan a trade → automate it → prove it on a record nobody can fake → copy what works → talk to the people behind the calls.

The loop a real desk runs. In one non-custodial terminal.

Full breakdown 👇
```
*Reply 1:* `[link to the long-form Lab article]`
*Reply 2:* `And $NEXUS? Pure community token. No utility theater, no revenue-share wink. Holders get the Holders Room + a badge. Cosmetic, cultural, on purpose. The flag for people who showed up early.`

---

## Cadence & tactics
- 1 post/day, same time daily (build the habit + the algo's expectation).
- Lead each with the claim, not the setup. First line is the whole hook.
- Put links in REPLIES, not the main post (algo deprioritizes link-posts).
- Quote-tweet your own best performer 2–3 days later with a fresh angle.
- POST 3 (trustless leaderboard) and POST 1 (non-custodial agent) are the
  strongest standalone — lead the week with one of those, close with POST 7.
- Screenshot the actual UI (agent Status tab mid-trade, the feed leaderboard
  with the on-chain anchor badge) and attach — image posts outperform text.
- Every post is TRUE and has a receipt. That consistency IS the brand.
