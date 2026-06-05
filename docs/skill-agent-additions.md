# SKILL.md — Agent Control Additions (apply to BankrBot/skills/nexus-trading-labs)

> Three edits to add autonomous-agent control to the live Bankr skill. Matches the
> existing SKILL.md format exactly. Endpoints are LIVE on og.nexustradinglabs.com.

---

## EDIT 1 — add to the `## ⛔ FORBIDDEN` list

```
- NEVER send agent mode `"AUTONOMOUS"` without an explicit user "go live" confirmation — it trades real funds
- NEVER default an agent deploy to a live mode — default to PAPER unless the user clearly asks for live
```

---

## EDIT 2 — add this section right after the `## Trade (most common action)` section

```markdown
## Autonomous Agent

Deploy a bot that trades a funding + OI-divergence confluence signal 24/7 within the
user's risk limits. The key is **order-only — it can trade but NEVER withdraw.**
Default to **PAPER** (simulated, zero risk). Going **AUTONOMOUS** (live) ALWAYS needs
explicit user confirmation.

```
POST https://og.nexustradinglabs.com/agent/<walletAddress>/bankr/activate
{
  "mode": "PAPER",                 // PAPER | ASSISTED | AUTONOMOUS  (default PAPER)
  "config": { "symbols": ["PERP_BTC_USDC"], "capitalPerTrade": 30, "leverage": 5,
              "tpPercent": 1.5, "slPercent": 0.75, "maxHoldHours": 4,
              "maxTradesPerDay": 10, "maxDailyLossUsdc": 5, "fundingThreshold": 0.01 },
  "walletSig": "<required for ASSISTED/AUTONOMOUS>",
  "confirm": "GO LIVE"             // REQUIRED only when mode is AUTONOMOUS
}
```

- **PAPER** needs no walletSig (simulated). **ASSISTED/AUTONOMOUS** derive the
  order-only key from `walletSig` — pass the session signature.
- AUTONOMOUS without `confirm:"GO LIVE"` → `409 confirm_required`. Confirm with the
  user first, THEN send `confirm:"GO LIVE"`.
- Change mode later: `POST /agent/<wallet>/bankr/mode { "mode", "walletSig"?, "confirm"? }`
- Pause new entries: mode → `ASSISTED`. Back to sim: mode → `PAPER`.
- **Capital guardrail:** keep `capitalPerTrade` ≤ ~60% of free collateral, or live
  entries margin-reject (Orderly -1101). Read balance first; suggest a safe size.

See references/agent.md for the full intent map, status formatting, and safety rules.
```

---

## EDIT 3 — add these rows to the `## Quick Reference` table

```
| Deploy/arm agent | `POST https://og.nexustradinglabs.com/agent/:wallet/bankr/activate` | walletSig (live modes) |
| Change agent mode | `POST https://og.nexustradinglabs.com/agent/:wallet/bankr/mode` | walletSig (live flip) |
| Agent status | `GET https://og.nexustradinglabs.com/agent/:wallet` | public read |
| Pause agent (assisted) | `POST https://og.nexustradinglabs.com/agent/:wallet/bankr/mode` | — |
| Deactivate agent | `DELETE https://og.nexustradinglabs.com/agent/:wallet` | — |
| Kill agent (close+stop) | `POST https://og.nexustradinglabs.com/agent/:wallet/kill` | — |
| Top agents | `GET https://og.nexustradinglabs.com/agents/leaderboard` | public |
| Agent ledger (proof) | `GET https://og.nexustradinglabs.com/agents/ledger` | public |
```

And add to the `## Load References As Needed` list:
```
- **references/agent.md** — deploy/arm/fund/kill the autonomous agent, mode flips, status formatting, safety gates
```

---

## EDIT 4 — add the file `nexus-trading-labs/references/agent.md`

Use the contents of `docs/bankr-skill-agent-module.md` from this repo (intents → calls,
auth model, capital guardrail, status formatter, response copy, safety rules).

---

## How to apply (to the BankrBot/skills repo)

The skill lives in **github.com/BankrBot/skills** at `nexus-trading-labs/`. Since Nexus
publishes it, update via your fork → PR (or direct if you have commit access):

1. Edit `nexus-trading-labs/SKILL.md` — apply EDITS 1–3 above.
2. Add `nexus-trading-labs/references/agent.md` (EDIT 4 content).
3. Commit → open a PR to `BankrBot/skills` (or push if you maintain it directly).
4. Once merged, re-install/refresh the skill in Bankr and the agent intents are live.
