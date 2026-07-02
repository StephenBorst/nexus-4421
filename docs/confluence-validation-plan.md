# CONFLUENCE validation plan (mid-July 2026)

The flagship signal — funding-extreme **AND** OI-divergence must agree — is the one
strategy we've never been able to backtest, because Orderly exposes no OI history. The
brain now records it (`oi:hist:{symbol}`), and the whole validation path is already wired
to switch on automatically the moment the data is deep enough. This doc is the plan for
when it does.

## Trigger — when to run
Run when recorded OI covers **≥14 days AND ≥200 hourly samples** across the 6-symbol
universe (BTC/ETH/SOL/BNB/XRP/LINK). That's the gate in `loadOiHistForBacktest`
(`OI_BACKTEST_MIN_DAYS` / `OI_BACKTEST_MIN_SAMPLES`).

- Recording (re)started clean **2026-07-01 ~04:45Z** at ~1 sample/hour (after the
  `record core OI before the no-users early return` fix, commit 56e38c6). ⇒ the gate
  clears **~2026-07-15**.
- **How to check:** `node tools/backtest/validate.mjs` prints each symbol's `OI Ns/Md`
  and either "OI mature → CONFLUENCE validated" or "OI still maturing". Or hit
  `GET /agent/oi-history/PERP_BTC_USDC` and count `points`.

## What happens automatically (no action needed)
- **`POST /agent/validate`** and **`POST /agent/backtest`** auto-include CONFLUENCE/OI_ONLY
  once mature (they gate on `loadOiHistForBacktest`).
- **Community board badges:** any published CONFLUENCE strategy sitting at `⏳ OI PENDING`
  auto-flips to a real ✅/🟨/❌ verdict via the lazy revalidation in
  `GET /agents/strategies/public` (bounded, self-healing, no re-publish needed).

## What to run manually — the definitive read
`node tools/backtest/validate.mjs` — the walk-forward harness now sweeps a **CONFLUENCE
parameter grid** (added below) across 8 symbols × 4 time folds, fees on. This is the
cross-market + cross-time answer on the flagship, not a single-window number.

Grid: `fundingThreshold ∈ {0.005, 0.01, 0.02}` × `oiChangeThreshold ∈ {0, 0.5, 1.0}` ×
exits `{fixed tp1.5/sl0.75, + breakeven1.0}`. Plus a couple of `OI_ONLY` variants as a
control (does OI-divergence carry any edge on its own?).

## Success criteria — the bar, set in advance (no goalpost-moving)
A CONFLUENCE config **earns the flagship slot** only if it is **✅ ROBUST**:
net-positive on **≥ half the symbols (≥4/8 in the dev harness / ≥3/6 in-app)** AND
**≥ 55% of time folds** positive (`robustnessVerdict`).

- **If ✅ ROBUST:** it becomes the honestly-earned flagship — rename a preset to carry a
  ⭐ / "VALIDATED" tag (the FIRST thing to ever earn it), set it as the recommended
  default, and make it the headline of a build-in-public post: *"We said nothing wears
  'proven' until it passes walk-forward. This just did. Here's the receipt."* Still
  paper-test first (see caveat).
- **If 🟨 FRAGILE (works on majors only):** keep it BTC/ETH-scoped, labeled honestly, no
  ⭐. A real but narrow edge is still worth offering — just don't overclaim breadth.
- **If ❌ NOT ROBUST:** CONFLUENCE also isn't a generalizable edge. That's a legitimate,
  publishable finding (it's what the validator is FOR). Move to the next hypotheses ↓.

## If CONFLUENCE fails — next hypotheses (in rough priority)
1. **Funding-settlement timing** — enter only in the window right around the 8h funding
   settlement (when the fade is actually paid), not any hour. Needs a settlement-time
   feature in the engine.
2. **Regime-conditioned entries** — only fade when the tape isn't strongly trending
   (`respectRegime` exists live but isn't backtestable — needs a historical breadth proxy).
3. **Longer holds / mean-reversion horizon** — the fade may need days, not the 4h cap;
   sweep `maxHoldHours`.
4. **OI-divergence magnitude tiers** — only the LARGEST OI divergences may carry signal;
   sweep `oiChangeThreshold` higher (2–5%).
5. **Cross-asset funding spread** — fade the OUTLIER vs the basket, not each symbol's own
   extreme.

## ⚠️ Honesty caveat on any CONFLUENCE ✅
The recorded OI series is **hourly**; the live brain computes OI deltas on its ~5-min
tick. So the backtest OI is a *proxy* for what the live agent sees — a ✅ means
"promising enough to forward-test in PAPER," NOT "deploy real money." The house paper
agent on the winning config is the real proof. Standard for this project: validated →
paper-forward → then live.
