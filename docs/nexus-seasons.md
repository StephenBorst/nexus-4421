# Nexus Seasons — Points → Retroactive Rewards (draft v1)

A points + seasons program that rewards **real, verifiable contribution** — funded by the
treasury's accumulated $NEXUS, distributed retroactively. Built on Nexus's unfair advantage:
**we already grade outcomes trustlessly**, so points can be quality-weighted (reward being
*right*, not just loud) — which kills the wash-farming that plagues volume-only programs.

---

## The loop (how it self-funds)
```
DEX fees → treasury (USDC) → buy $NEXUS on the lows → accumulate a stack (HELD)
   → the stack funds retroactive SEASON drops to top verifiable contributors
   → recipients are engaged users who keep trading → more fees → bigger treasury
```
No burn, no automated buyback, no "trade-to-earn" promise. Discretionary accumulation +
merit-based retroactive rewards.

## Earn points from (the activity)
| Source | Points basis | Anti-game |
|---|---|---|
| **Trading volume** | per $ of *net* volume | min hold time; ignore self-trades / wash |
| **Graded theses** ⭐ | scales with **verified accuracy** (hit TP vs SL, graded on public price) | only *graded* outcomes count — can't farm by posting noise |
| **Agent activity** | real volume driven by your agent (bonus: autonomous net-new volume) | live/paper tracked separately |
| **Copy trades** | being copied (your calls have followers) + copying | caps |
| **Referrals** | users you bring | per-referrer cap, sybil resistance |

⭐ = unique to Nexus. Most programs can't reward *accuracy* because they can't trustlessly verify it. We can.

## Multipliers (where $NEXUS plugs in — aligned, not pay-to-win)
- **Hold $NEXUS → points multiplier** (e.g. 1.1x–1.5x by tier). Conviction is rewarded without *gating anyone out* — free users still earn, holders earn more.
- **Consistency / streak** — active days. Rewards retention over one-off farming (the lever $HYPE weighted heavily).

## Seasons
- **4–6 week seasons** → snapshot → **retroactive** $NEXUS drop from the treasury stack.
- **Tiered brackets** — top tier gets the biggest share; the long tail still gets something (drives breadth, not just whales).
- **Published & verifiable** — rankings computed from the same public/on-chain data, and can be **anchored on-chain** like our leaderboards. Out-transparency everyone.

## Why it stays clean
- **Retroactive** (rewards past activity, no upfront "do X to earn Y" promise)
- **Merit-based**, paid from a **treasury** (not the token contract / not a yield mechanism)
- Framed as *"thanks for building with us,"* not an investment return
- The grading moat **is** the anti-gaming system

## Open questions / to decide
- Point weights per source (volume vs accuracy vs agent) — what behavior do we most want to pull?
- Season length + reward-pool size per season (% of treasury stack)
- Bracket curve (how top-heavy vs long-tail)
- Whether agent-driven volume gets a premium (it's net-new volume into the book)

*Funded by the treasury Safe (`0x4Fe2…C733`). Status: structure drafted, not yet built. Pairs with the
treasury-accumulation counter (live) and the verifiable leaderboard infra (live).*
