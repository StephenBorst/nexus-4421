# Nexus — Design System (app-wide)

Cypherpunk-terminal identity (monospace + terminal green) with Linear's *discipline*.
Source of truth: **`app/config/theme.ts`** (promoted out of the Lab so Feed/Messages/mini/
components share ONE system). `app/pages/lab/tokens.ts` now just re-exports it.
Interaction states live in the **CSS layer** (`.nx-*` in `app/styles/index.css`).

## The 4 rules
1. **One accent.** `C.accent` (#00ff88) is reserved for the primary CTA + genuinely
   positive values. Everything else uses muted `text.*` tones. If everything is green,
   nothing reads as important.
2. **Hierarchy by tone + weight, not color.** Primary = `text.bright`, secondary =
   `text.fog`, labels = `text.muted`, hints = `text.faint`.
3. **No magic numbers.** Spacing from `S`, type from `TYPE`, radius from `RADIUS`.
4. **Elevation = hairline border + surface tier**, not heavy shadow.

## Color
| Token | Hex | Use |
|-------|-----|-----|
| `C.canvas` | `#0a0e0a` | page/inset background |
| `C.surface` | `#111811` | raised card (green-tinted, matches the palette) |
| `C.surfaceAlt` | `#0d120d` | secondary card |
| `C.border` | `#1e2d1e` | hairline (structural) |
| `C.text.bright` | `#e8f0ea` | primary values / headings |
| `C.text.fog` | `#8aaa9a` | secondary text |
| `C.text.muted` | `#4a7a5a` | labels |
| `C.text.faint` | `#3a5a4a` | hints / captions |
| `C.accent` / `C.pos` | `#00ff88` | ONE CTA per screen · positive |
| `C.neg` | `#ff4444` | negative / destructive |
| `C.warn` | `#fbbf24` | warning · PRO |
| `C.info` | `#4a9fff` | info · secondary badge |

## Type scale (`TYPE`, monospace)
| Role | px | line | tracking |
|------|----|------|----------|
| `micro` | 9 | 1.4 | +0.12em, uppercase |
| `caption` | 10 | 1.5 | +0.10em |
| `body` | 11 | 1.5 | — |
| `bodyLg` | 13 | 1.5 | — |
| `value` | 16 | 1.2 | 600 |
| `valueLg` | 20 | 1.2 | 600, -0.01em |
| `heading` | 28 | 1.2 | 700, -0.02em |
| `display` | 40 | 1.1 | 700, -0.03em |

Helpers compose type + tone: `label` (micro/muted), `value` (value/bright),
`body` (body/fog), `hint` (micro/faint).

## Spacing (`S`, 4px base, compact)
`xs 4 · sm 8 · md 12 · lg 16 · xl 24 · xxl 32 · huge 48`. Radius: `sm 3 · md 6 · lg 8`.

## Buttons
- **`btnPrimary`** — filled green, the ONE rationed CTA per card/screen.
- **`btnGhost`** / **`navBtnStyle`** — quiet default for everything else.
- **`agentBtnStyle(active)`** — toggle: active→primary, inactive→ghost.

## CSS interaction layer (`.nx-*` in `app/styles/index.css`)
Inline styles can't express `:hover`, `:focus-visible`, or transitions — the reason
the UI felt static. The `.nx-*` classes (driven by CSS vars that mirror the tokens)
add motion + a11y focus for free. Prefer these for interactive controls:
- `.nx-btn` / `.nx-btn-primary` — quiet default / the ONE rationed accent CTA (hover,
  active scale, focus ring, disabled).
- `.nx-card` (+ `.nx-card-interactive` for hover), `.nx-label`, `.nx-badge`, `.nx-input`
  (focus ring). All respect `prefers-reduced-motion`.
Keep the `:root` vars in `index.css` in sync with `C`/`RADIUS`/`MOTION` in `theme.ts`.

## Palette drift — collapse to canonical
Five near-identical muted greens existed. Canonical set is `text.faint`/`text.muted`/
`text.fog`; migrate drift via `DRIFT_TO_CANONICAL` in `theme.ts`
(`#3a6a4a→muted · #5a7a6a→fog · #5a8a6a→fog`).

## Adoption / migration
Foundation is app-wide (tokens + CSS layer). Audit (2026-07): only 1 file imported
tokens; ~416 raw `#00ff88` app-wide; the "one accent" rule was violated 216× in the
Lab alone. Migration is now **deliberate + batched, verified in preview** — NOT the old
"opportunistic" drift (which stalled at 1 file) and NOT a blind mass-repaint. Per file:
swap interactive controls to `.nx-*` classes; replace ad-hoc hex with `C`/drift map;
ration the accent (green only for the primary CTA + genuine positives); eyeball in preview.
