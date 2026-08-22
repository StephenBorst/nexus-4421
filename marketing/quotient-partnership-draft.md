# Quotient × Nexus — partnership draft

Prep for outreach to the Quotient team (signal.quotient.social). Quotient produces
forecasting intelligence — price outlooks, probability distributions, a directional
Signal (e.g. "Short silver," the Hawk–Dove Index) — and today routes execution to
**Hyperliquid**. Nexus is a trading terminal + perp DEX on **Orderly** with a
**trustless, on-chain grading layer**. The fit: their intelligence, our execution +
proof. This isn't "send us your users" — it's "let's close the loop neither of us
closes alone."

---

## The one-liner

> Quotient forecasts the move. Nexus lets traders take it — and grades whether the
> forecast actually paid, trustlessly and on-chain. A forecast with a verifiable
> track record beats a forecast with a nice chart.

---

## Why us, specifically (the wedge)

Every forecasting product hits the same wall: **"prove your signal actually works."**
Screenshots and backtests don't count; a live, independently-graded record does. That's
the exact thing Nexus is built to do.

1. **Execution, natively.** Quotient's "Trade on Hyperliquid" becomes "Trade on Nexus" —
   deep Orderly liquidity, 130+ perps, one-click from the forecast. No reason to send
   flow to a competitor's book when a white-label venue can carry it.
2. **A track record nobody can fake.** Nexus already grades calls **objectively from
   public price** (first-touch TP vs SL, anchored on-chain — anyone can recompute the
   hash). Point Quotient's signals at it and every forecast gets a public, verifiable
   hit-rate + expectancy. That's a moat for Quotient, not just a feature.
3. **The seam is already built.** Nexus ships a **Forecast Divergence** corner — it reads
   the forecasting crowd (Polymarket today) against leveraged positioning and flags where
   they disagree, then lets a user stake a *graded* thesis on the gap. Quotient is a
   higher-quality forecast feed slotting straight into that surface: a premium lens where
   there's a generic one now.
4. **Distribution beyond the site.** The Lab's intelligence surfaces, an AI copilot with
   37 tools, a Farcaster mini-app, and a Bankr chat-agent integration — Quotient's signals
   reach traders where they already are, not just on quotient.social.

## Why them (what Nexus gets)

- A **best-in-class forecasting feed** to power the Macro / Forecast intelligence corners —
  the differentiated "why" behind a trade, upgraded from prediction-market probabilities to
  real modeled forecasts.
- A credible **intelligence partner** for the narrative: Nexus is the execution + grading
  layer; Quotient is the forecast layer. Clean division, no overlap.

## The complete loop (the pitch in one picture)

```
Quotient forecast  →  trader executes on Nexus  →  Nexus grades the real outcome
      ↑                                                        │
      └──────  verifiable, on-chain track record of the signal  ┘
```

Neither side closes this alone: Quotient forecasts but can't prove it on-chain; Nexus
grades + executes but doesn't forecast. Together it's a forecast → trade → proof loop.

## The ask (small first step)

A 20-minute call to explore two concrete, low-lift integrations:

1. **Route execution to Nexus** — a "Trade on Nexus" path from a Quotient signal (deep-link
   with symbol + direction prefilled; we already do this from our own boards).
2. **Grade the signal feed** — Quotient hands us a lightweight signal stream (symbol,
   direction, entry/target/invalidation, timestamp); Nexus grades each one trustlessly and
   returns a public, on-chain-anchored track record Quotient can display as its own proof.

Start with (2) even without (1) — a graded, verifiable record of Quotient's signals is
valuable to them regardless of where the trade lands. It's also the cheapest thing to pilot.

---

## Outreach message (drop-in, ~DM length)

> Hey — building Nexus Trading Labs (trade.nexustradinglabs.com), a trading terminal +
> perp DEX on Orderly with a trustless, on-chain grading layer. Been following Quotient's
> work — the forecasting + Hawk–Dove read is sharp.
>
> One idea worth 20 min: we grade trading calls objectively from public price and anchor
> the record on-chain — anyone can recompute it. Point Quotient's signals at that and you
> get a public, un-fakeable track record of your forecasts (the thing every forecasting
> product struggles to prove). We can also carry execution natively (Orderly liquidity), so
> a Quotient signal → trade → graded outcome becomes one loop instead of a hand-off to HL.
>
> We already ship a "Forecast Divergence" surface built for exactly this seam — happy to
> show it. Open to a quick call?

---

## Notes for the call (don't lead with these, but have them ready)

- **Keep it complementary, not competitive.** We forecast NOTHING; they execute/grade
  nothing. Say it plainly — it disarms the "are you trying to replace us" reflex.
- **Lead with the track-record value, not "send us flow."** The grading is the gift; the
  execution routing is the follow-on.
- **We're Orderly-native**, so liquidity + settlement are handled — we're not asking them
  to trust a thin book.
- **Legal-clean framing:** graded track record = objective measurement from public data,
  not investment advice; execution = ordinary DEX trading. No revenue-share/security angle
  in the first conversation.
- If they ask "why not just stay on Hyperliquid?" → they can keep HL; this is additive
  (a second venue + a proof layer HL doesn't give them).
