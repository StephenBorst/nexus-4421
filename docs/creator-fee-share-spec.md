# Creator Fee-Share (per-thesis) — spec

The Nexus-native layer on top of the Orderly affiliate (#1). Where #1 pays you for
*referring a trader* (account-level, lifetime, already live on the Rewards tab), **#2
pays you when someone trades *your specific call*** — copy a caller's thesis/agent, and a
slice of the broker fee that trade generates routes back to the caller. It turns the
graded-caller graph into an economic flywheel, and it's the part fomo can't copy because
it rides our trustless call attribution.

**Status:** #1 (Orderly account-level affiliate) = LIVE. #2 = this spec, TO BUILD.

---

## 1. Why it's ours to win

- **Attribution already exists.** `agent_trades.source_leader` stamps the copied leader's
  address on every agent-copied trade (exec worker), and `GET /agents/copy-record/:leader`
  already aggregates "copies of 0x… returned Y." We built the linkage fomo had to invent.
- **The fee pool is ours.** Broker fees route to `borst.eth` (Orderly-registered broker).
  A per-call rebate is a payout *from that pool* to the caller — no new money source.
- **It compounds the moat.** Rewards for being *right and copied*, graded trustlessly.
  Copy-farming is self-limiting: junk calls don't get copied, and every copy is graded.

## 2. Relationship to #1 (don't conflate)

| | #1 Orderly affiliate (LIVE) | #2 Creator fee-share (this) |
|---|---|---|
| Trigger | You *referred* the account | Someone traded *your call* |
| Granularity | Per-account, lifetime | Per-trade, per-thesis |
| Source | Orderly referral fee-split | Nexus rebate from broker-fee pool |
| Rail | Native Orderly | Custom Nexus (off-chain calc → payout) |

They stack: a trader can be your referral *and* copy your calls. Different pools, no
double-count (the rebate is computed off the broker fee that remains after any Orderly
referral split — see §4).

## 3. Attribution — link a trade → a caller

Every fee-earning copy needs a `source_leader` (the caller who gets paid). Sources:

1. **Agent copies (DONE).** exec already stamps `source_leader` when a follower's agent
   opens a position from a copied directive (`deployDirectiveFromThesis({ source })`).
2. **Manual copies (ADD).** The feed `CopyModal` (copy a public thesis) and the Smart
   Money ⚡ copy must carry the leader through to the placed order. For a MANUAL market
   order there's no agent trade row — so we log a lightweight **`copy_fill`** record
   (`{copier, leader, thesisId, symbol, side, notional, txOrderId, ts}`) at the moment the
   copy order is placed via `/trade` / `/close-position`. Keyed so it can't be forged
   (copier = the walletSig signer).
3. **Guardrails on attribution (anti-abuse):**
   - A caller **cannot earn from their own trades** (copier ≠ leader).
   - The leader must have a **public, graded call** on that symbol/side that predates the
     copy (no retroactive credit; the call must exist first). Cheap check against
     `lab:{leader}` theses + `gradeCall` timing.
   - One leader credited per fill (the `source_leader`), never split across many.

## 4. Fee computation — what the caller earns

Per attributed fill:

```
brokerFee   = notionalUsd × feeBps(side)          // taker ~2.5bps, maker ~-0.1bps (Gold tier — read live)
netToBroker = brokerFee − orderlyReferralSplit    // whatever Orderly already rebated (avoid double-pay)
callerShare = max(0, netToBroker) × CREATOR_SHARE  // e.g. 20%
```

- `CREATOR_SHARE` config (start ~20%, env-tunable `CREATOR_FEE_SHARE`). Nexus keeps the
  rest (covers the payout rail + margin).
- Maker rebates (negative fee) earn nothing — no fee, no share (never pay out of pocket).
- All figures are **exchange-auditable**: fill notional + fee come from the Orderly order
  (`entry_order_id`/`close_order_id` already recorded on `agent_trades`), so the rebate is
  recomputable from public order data — same trustless standard as the grading.

## 5. Accrual + payout

- **Accrue (real-time, KV):** on each attributed fill, `INCR creator:earn:{leader}` (total
  accrued) + append a line to `creator:ledger:{leader}` (`{ts, copier, symbol, notional,
  fee, share}`) for a transparent, per-line breakdown the caller can audit.
- **Read:** `GET /creator/earnings/:leader` → `{ pending, paid, lifetime, lines[] }`.
  Surface it on the caller's profile + a "Creator earnings" card in the Lab (near PRO).
- **Payout (batched, cheap):** a periodic sweep (cron or manual) pays each leader's
  `pending` in **USDC on Arbitrum from the treasury/broker-fee pool** once it clears a
  `CREATOR_MIN_PAYOUT` floor (e.g. $5 — gas-efficient). Move `pending → paid`, stamp a
  `payout_tx`. No per-trade on-chain tx (would eat the rebate in gas).
  - Alt v0: **claimable** — accrue only, let the caller `claim` when they want (one tx they
    pay for), until volume justifies an automated sweep. Ship claimable first.
- **Optional $NEXUS boost (later):** pay in $NEXUS at a small premium, or a higher
  `CREATOR_SHARE` for holders — consumptive-use aligned, drives token demand. Off by
  default; a v2 lever, not the MVP.

## 6. Trustlessness (keep the standard)

- Each ledger line is recomputable from public Orderly order data (notional + fee) + the
  public graded call that authorized the credit. Publish the calc; anyone can verify a
  caller's earnings the way they verify a caller's record.
- Optionally fold `creator:ledger` into the existing on-chain ledger anchor (SHA-256 root
  hourly) so the earnings ledger is tamper-evident like the agent/caller ledgers.

## 7. Legal framing (the line that matters)

Frame everywhere as a **creator / referral commission** — you drove trading volume with a
call that got copied, you earn a cut. That's ordinary affiliate/creator-economy commerce
(work-for-pay), **not** a revenue share to passive holders. Keep it *behavioral*: you earn
by *posting calls people copy*, never by *holding $NEXUS*. That distinction is exactly why
this is clean while token-holder revenue share is the Howey line we don't cross. One line
to the lawyer during the treasury chat; low-stakes vs the buyback.

## 8. Phasing

- **MVP (ship first):** manual-copy `copy_fill` logging + agent `source_leader` → accrual
  in KV → `GET /creator/earnings/:leader` → a "Creator earnings" card (claimable). Anti-
  abuse guardrails (§3) on. `CREATOR_SHARE=20%`. No automated payout yet (claim button).
- **v1:** batched USDC/Arbitrum sweep from the pool above `CREATOR_MIN_PAYOUT`; earnings on
  the public caller profile (social proof: "earned $X from copiers").
- **v2:** on-chain anchored earnings ledger; optional $NEXUS payout/boost.

## 9. Edge cases / decisions

- **Losing copied trades still generate a fee** → the caller still earns the rebate (it's a
  fee-share, not a P&L-share — that's the honest, legal-clean design). Good: it rewards
  being *copied*, and the caller's *graded record* is the separate quality signal.
- **Copier closes at a loss they blame on the caller** → the rebate is on their fee, not
  their loss; framing must be clear ("creators earn a share of the trading fee, not your
  P&L"). Not advice; the call was graded publicly.
- **Wash/self-copy** → blocked by copier≠leader + the pre-existing-public-call gate + (v1)
  a per-copier daily notional cap per leader.
- **Multiple callers, same setup** → credit the ONE `source_leader` on the fill (the call
  the copier actually copied), never split — keeps it simple + un-gameable.
- **Orderly referral overlap** → subtract any Orderly rebate first (§4) so we never pay the
  same fee twice.

## 10. Concretely, what's left to build

1. exec + `/trade`/`/close-position`: log `copy_fill` for **manual** copies (agent copies
   already carry `source_leader`).
2. lab-api: `recordCreatorAccrual(env, fill)` (guardrails + fee calc + KV accrual) +
   `GET /creator/earnings/:leader` + `POST /creator/claim` (or the sweep cron).
3. Frontend: "Creator earnings" card (Lab, near PRO) + a line on the caller profile.
4. Config: `CREATOR_FEE_SHARE`, `CREATOR_MIN_PAYOUT` env vars.

~most of the trust + attribution rail is already in place — this is the metering + payout
on top of it.
