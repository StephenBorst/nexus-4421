# Landing Refresh + "Emerald" Brand Placement

> Two things: (1) paste-ready copy to refresh the `nexus-landing` hero/sections with
> what we've shipped (directional agent, trustless grading, Telegram, guided thesis);
> (2) where the "Emerald" name fits WITHOUT the compliance exposure of "Profit".
> Landing lives in the separate `StephenBorst/nexus-landing` repo (static index.html,
> `wrangler deploy`, no CI). These are drop-in blocks — paste + deploy.

---

## PART 1 — LANDING REFRESH (paste-ready copy)

### Hero headline (swap the current one)
Primary:
```
The trading terminal that makes you a better trader.
Plan it. Automate it. Prove it on a record nobody can fake.
```
Alt (bolder, moat-forward):
```
Every track record in crypto asks you to trust it.
Ours is graded from public price and anchored on-chain.
```

Sub-hero line:
```
A non-custodial perp terminal on @OrderlyNetwork. The exchange is the rails —
The Lab is the product: a thesis engine, an autonomous agent you keep the keys to,
and a leaderboard we literally cannot fake.
```

Primary CTA button: `Launch The Lab →`  ·  Secondary: `See the proof →` (→ /feed)

### "What's new" strip (add above or below the live-stats row)
```
JUST SHIPPED
→ Directional Agent — hand it your exact thesis; it enters your direction and
  manages the exit (scale-outs, trailing, breakeven). MARKET or resting LIMIT.
→ Telegram Alerts — your agent DMs you on every open + close. Non-custodial.
→ Guided Thesis — anchor entry to live price, snap stop + target in two taps.
→ Trustless Grading — human calls graded from public price, agent trades carry
  Orderly order IDs, the whole ledger anchored to Arbitrum hourly.
```

### Three-pillar section (if the landing has a features grid, use these)
```
PLAN IT
Build the trade before you take it — size, R:R, funding cost, live P&L. Publish it
on-chain, timestamped, un-backdateable.

AUTOMATE IT
An autonomous agent with order-only keys that physically can't touch your funds.
Hard risk caps, one-tap kill, paper mode. Or hand it YOUR exact directional trade.

PROVE IT
No self-reported P&L. Calls graded from public price, trades auditable against
Orderly, the ledger anchored to Arbitrum. Recompute it yourself.
```

### Keep as-is (already live + correct)
- 3 live stats (Volume / OI / 90+ Markets), $NEXUS market strip, treasury banner,
  treasury-accumulation counter. Don't re-add the old fabricated TVL number.

---

## PART 2 — WHERE "EMERALD" FITS  (⚠️ drop "Profit")

**The compliance line first (non-negotiable):** for a leveraged-trading product, a
public name containing **"Profit"** reads as a performance/return promise — the exact
Howey-adjacent signal we've kept out of $NEXUS and everything else. So "Emerald Profit
Strategies" as a public brand is a liability. Keep the *Emerald*, lose the *Profit*.

**Recommended placement — Emerald as the premium sub-brand, not a rename.**
Nexus Trading Labs stays the parent (the trust brand). "Emerald" becomes the name of the
PRO/premium layer — aesthetic, aspirational, and it maps perfectly to the terminal-green
identity. Concrete uses, best → optional:

1. **Emerald (the PRO tier).** Rename "Nexus PRO" → **Emerald** (or "Emerald tier").
   "Hold ARCHITECT $NEXUS or subscribe to unlock Emerald." The green gem already IS the
   $NEXUS/PRO motif — the name writes itself. Cleanest, highest-value home for it.
   - Badge: ◆ EMERALD next to PRO users. Ties to the existing tier-badge system.
2. **Emerald Strategies (the curated strategy suite).** The house/curated configs in the
   Strategy Library become the **Emerald Strategies** — vetted, backtested, published
   presets. "Copy an Emerald Strategy." Gives the strategy marketplace a marquee shelf.
3. **Emerald Desk (a clan/desk).** If you want it social, the flagship Desk (clan) is
   **Emerald Desk** — the inner circle of top-graded callers.

**My call:** ship #1 (PRO → Emerald) — it's a rename of an existing surface
(`config/subscription.ts` + the NexusPro card + tier badge), low effort, and it gives the
name a permanent, on-brand home. Layer #2 in later as the strategy marketplace matures.

Framing line for the tier:
```
Emerald — the operator tier of Nexus Trading Labs.
Advanced agent strategies, hosted AI, backtesting + walk-forward validation, priority.
Unlock by holding $NEXUS or subscribing. (A premium software tier — not a return.)
```

---

## SUGGESTED SEQUENCE
1. Paste the landing hero + "What's new" strip → `wrangler deploy` nexus-landing. (~30 min)
2. Rename PRO → Emerald in `config/subscription.ts` + NexusPro card + badge. (~half day,
   in THIS repo, ships via CI.)
3. Run the per-tab post tour (`marketing/lab-tab-posts.md`), leading with the Agent post.
