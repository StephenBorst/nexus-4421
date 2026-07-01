// ── Nexus Lab design tokens ───────────────────────────────────────────────────
// The single source of truth for the Lab's look. Borrows Linear's DISCIPLINE
// (rationed accent, a real 4px spacing scale, a defined type scale, hierarchy by
// weight/tone not color) while keeping the ownable cypherpunk-terminal identity:
// monospace + terminal green. Full reference: app/pages/lab/DESIGN.md.
//
// THE RULES (why the Lab should feel calm + intuitive, not busy):
//  1. ONE accent. `C.accent` (green) is reserved for the primary CTA + genuinely
//     positive values. Structure/labels/secondary UI use the muted `text.*` tones.
//     If everything is green, nothing reads as important.
//  2. Hierarchy by TONE + WEIGHT, not more color. Primary values = `text.bright`,
//     secondary = `text.fog`, labels/hints = `text.muted` / `text.faint`.
//  3. Spacing comes from `S` (4px base). Type comes from `TYPE`. No magic numbers.
//  4. Elevation = hairline border (`C.border`) + surface tier, not heavy shadow.
import type { CSSProperties } from "react";

// ── Spacing — 4px base, compact density ──────────────────────────────────────
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, huge: 48 } as const;

export const RADIUS = { sm: 3, md: 6, lg: 8 } as const;

export const MONO = "monospace";

// ── Color — surfaces stratified by luminance, ONE rationed accent ────────────
export const C = {
  canvas: "#0a0e0a",
  surface: "#111318",
  surfaceAlt: "#0d120d",
  inset: "#080c08",
  border: "#1e2d1e",
  borderStrong: "#2a3a2a",
  borderAccent: "#00ff8850",
  text: {
    bright: "#e8f0ea", // primary values / headings
    fog: "#8aaa9a",    // secondary text
    muted: "#4a7a5a",  // labels
    faint: "#3a5a4a",  // hints / captions
  },
  accent: "#00ff88",
  pos: "#00ff88",
  neg: "#ff4444",
  warn: "#fbbf24",
  info: "#4a9fff",
} as const;

// ── Type scale — monospace, tuned for dense terminal UI ──────────────────────
// Role      | px | line | tracking            (labels get +tracking; big text tight)
// micro     |  9 | 1.4  | +0.12em   uppercase labels, hints
// caption   | 10 | 1.5  | +0.10em   secondary labels
// body      | 11 | 1.5  |  —        body copy
// bodyLg    | 13 | 1.5  |  —        inputs, dense values
// value     | 16 | 1.2  |  —        primary stat values (600)
// valueLg   | 20 | 1.2  | -0.01em   emphasis numbers (600)
// heading   | 28 | 1.2  | -0.02em   section headers (700)
// display   | 40 | 1.1  | -0.03em   hero moments (700)
export const TYPE = {
  micro:   { fontFamily: MONO, fontSize: 9,  lineHeight: 1.4, letterSpacing: "0.12em", textTransform: "uppercase" as const },
  caption: { fontFamily: MONO, fontSize: 10, lineHeight: 1.5, letterSpacing: "0.10em" },
  body:    { fontFamily: MONO, fontSize: 11, lineHeight: 1.5 },
  bodyLg:  { fontFamily: MONO, fontSize: 13, lineHeight: 1.5 },
  value:   { fontFamily: MONO, fontSize: 16, lineHeight: 1.2, fontWeight: 600 },
  valueLg: { fontFamily: MONO, fontSize: 20, lineHeight: 1.2, fontWeight: 600, letterSpacing: "-0.01em" },
  heading: { fontFamily: MONO, fontSize: 28, lineHeight: 1.2, fontWeight: 700, letterSpacing: "-0.02em" },
  display: { fontFamily: MONO, fontSize: 40, lineHeight: 1.1, fontWeight: 700, letterSpacing: "-0.03em" },
} as const;

// ── Text-role helpers — compose from TYPE + a tone. Use these over ad-hoc sizes.
export const label: CSSProperties = { ...TYPE.micro, letterSpacing: "0.12em", textTransform: "uppercase", color: C.text.muted };
export const value: CSSProperties = { ...TYPE.value, color: C.text.bright };
export const body: CSSProperties = { ...TYPE.body, color: C.text.fog };
export const hint: CSSProperties = { ...TYPE.micro, textTransform: "none", color: C.text.faint };
