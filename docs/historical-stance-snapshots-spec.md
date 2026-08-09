# Historical Stance Snapshots — build spec

**Status:** ✅ BUILT + shipped 2026-08-09 (commit f405803). This spec is the as-built
design; the deviation from the original scope is noted at the bottom. Pure-logic-first
with `node:test` (9 new tests).

## The gap this closes
The caller graph is **live-only**. `gatherStanceEntries(env)` computes the current
stance universe (open positions + active <14d public calls, merit-weighted);
`consensusBySymbol` and `contestedBoard` read it *right now*. We can grade an
individual call's OUTCOME (trustless first-touch vs public price) but we cannot answer
the highest-signal caller-graph question:

> **Who is right when they fade the crowd?**

A caller who's consistently profitable *against* the merit-weighted consensus is the
single most valuable signal in the system — and no self-reported-PnL competitor can
compute it. We can't today because we never persist **what the crowd's lean was at the
moment a call was posted**. Same wall the x-ray hit (live-only indexer) — solved there
by periodic snapshots + retro-join. Mirror that design here (congruent).

## Design (mirrors the Tracked Record x-ray)
Two pure pieces + one snapshot store + one grading join + surfaces.

### 1. Snapshot store — `stance:hist:{symbol}`
A rolling per-symbol time-series of the merit-weighted consensus lean:
```
{ t, side: "LONG"|"SHORT", longW, shortW, participants }   // one entry per snapshot
```
- Derived from the SAME `gatherStanceEntries` → `consensusBySymbol` the boards already
  use (so the history can never disagree with the live board).
- Only stored when a side has a real lean (≥2 merit-weighted participants and a
  dominant side) — thin/ambiguous ticks aren't recorded (they'd make everything
  "contrarian" against noise).
- Capped ~240 points, TTL ~400d, throttled ≥ ~50min between writes per symbol
  (constants mirror `XRAY_HIST_CAP` / `XRAY_SNAP_MIN_MS`).

### 2. Cron — piggyback the hourly grade pass
`workers/nexus-lab-api/index.js` already runs `gradePublicTheses` on `"17 * * * *"`.
Add a `snapshotStances(env)` step in the same `scheduled` block (in `grading.mjs`):
call `gatherStanceEntries` once, fold to per-symbol leans, append each to
`stance:hist:{symbol}`. One extra pass/hour, bounded by the symbol count.

### 3. Pure classifier — `logic.mjs` (tested)
```
// Is a call contrarian vs the crowd lean that preceded it? Needs a real lean.
stanceAtPost(history, createdAtMs, { minParticipants = 2 })
  → { side, participants } | null      // nearest snapshot with t <= createdAt

classifyContrarian(direction, leanSide) → "CONTRARIAN" | "WITH_CROWD" | null
```
`null` when there's no qualifying prior snapshot (cold-start / thin) — withheld, never
guessed. Same honesty discipline as `standoffVerdict` / regime attribution.

### 4. Grading join — extend `computeCallerStats`
For each graded call, read `stance:hist:{t.symbol}` (cached per-symbol across the pass,
like the OHLC `history` map already is), classify contrarian-ness against the snapshot
nearest-before `t.createdAt`, and accumulate a per-wallet sub-record:
```
contrarian: { calls, wins, rSum }   withCrowd: { calls, wins, rSum }
```
Derive `contrarianEdge = avgR(contrarian) − avgR(withCrowd)` and a shrunk
`contrarianScore` (reuse the `callerScore` shrink so 2 lucky fades can't mint it).
⚠️ **Invariant:** contrarian-ness is an ATTRIBUTE only — `gradeCall` stays untouched
(same rule as regime attribution). It never changes the trustless outcome or R.

### 5. Surfaces
- **VERIFIED CALLERS** (`/theses/leaderboard` + Feed): add a `⚡ contrarian` stat and a
  badge for callers net-positive fading the crowd (≥ min contrarian sample).
- **New `⚡ CONTRARIANS` mini-board** (`GET /theses/contrarians`): top callers by
  contrarian edge — the "right when everyone's wrong" board. Own Feed RANKS strip.
- **Contested board** (`/theses/contested`): each participant already carries `record`;
  add `contrarian` so a standoff shows who has a *fading-the-crowd* track record — the
  actionable read on "who's the smart contrarian in this fight."
- **Copilot:** extend `get_verified_callers` output (or add `get_contrarians`) with the
  contrarian edge so the AI can say "this caller is +0.8R when they fade consensus."

## Tests (node:test)
- `stanceAtPost`: nearest-prior selection; null when all snapshots post-date the call;
  null when participants < min.
- `classifyContrarian`: LONG vs SHORT lean → CONTRARIAN/WITH_CROWD; null lean → null.
- aggregation: a caller's contrarian vs with-crowd sub-records + edge; shrink guard so
  a 2-call fade streak can't top a long record.

## Cold-start (by design)
Nothing is contrarian-classified until `stance:hist` accrues (hours→days) AND a caller
has a minimum contrarian sample. Boards render the contrarian column blank until then —
same fail-soft as every other graded surface. Not a bug; the grade earns itself.

## As-built notes (deviations from the scope above)
- `contrarianEdgeScore(contrarian, withCrowd)` (logic.mjs) is the shrink helper, ranking by
  contrarian avg-R × `calls/(calls+4)`, ≥3-call gate; `edge` = contrarian avg-R − with-crowd
  avg-R. Board `/theses/contrarians` gates on `score > 0` (net-positive).
- The contrarian join in `computeCallerStats` is **opt-in** (`opts.contrarian`) — off by
  default so `gatherStanceEntries` (consensus poll path) pays nothing; the leaderboard and the
  contrarians board pass it, and `gatherStanceEntries(env,{contrarian:true})` threads it for the
  contested board only. Stance history keyed by BARE coin (`bareCoin`), joined per-call.
- Surfaces shipped: `/theses/contrarians` board + `Contrarians.tsx` (Feed, under CONTESTED);
  `contrarian` field on `/theses/leaderboard` rows and `/theses/contested` participants; copilot
  `get_verified_callers` description. A per-row leaderboard badge was left to a later polish pass.

## Why this is the right next TIER (not a polish tack-on)
It's the caller-graph's network-effect moat made measurable: the more callers post, the
richer the consensus history, the sharper every contrarian grade — a flywheel no
self-report product can copy. Ship AFTER the current surfaces have accrued real usage
(the snapshots need live stances to be meaningful).
