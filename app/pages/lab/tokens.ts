// ── Nexus Lab design tokens ───────────────────────────────────────────────────
// The single source of truth for the Lab's look. Borrows Linear's DISCIPLINE
// (rationed accent, real spacing scale, hierarchy by weight/tone not color) while
// keeping the ownable cypherpunk-terminal identity: monospace + terminal green.
//
// THE RULES (why the Lab should feel calm + intuitive, not busy):
//  1. ONE accent. `C.accent` (green) is reserved for the primary CTA + genuinely
//     positive values. Structure/labels/secondary UI use the muted `text.*` tones.
//     If everything is green, nothing reads as important.
//  2. Hierarchy by TONE + WEIGHT, not more color. Primary values = `text.bright`,
//     secondary = `text.fog`, labels/hints = `text.muted` / `text.faint`.
//  3. Spacing comes from `S` (4px base). No ad-hoc pixel gaps.
//  4. Elevation = hairline border (`C.border`) + surface tier, not heavy shadow.
import type { CSSProperties } from "react";

// 4px spacing scale.
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const RADIUS = { sm: 3, md: 6 } as const;

export const C = {
  // Surfaces (canvas → raised), stratified by luminance not hue.
  canvas: "#0a0e0a",
  surface: "#111318",
  surfaceAlt: "#0d120d",
  inset: "#080c08",
  // Borders — hairlines do the structural work.
  border: "#1e2d1e",
  borderStrong: "#2a3a2a",
  borderAccent: "#00ff8850",
  // Text tiers (hierarchy lives here).
  text: {
    bright: "#e8f0ea", // primary values / headings
    fog: "#8aaa9a",    // secondary text
    muted: "#4a7a5a",  // labels
    faint: "#3a5a4a",  // hints / captions
  },
  // The ONE accent + semantics (green doubles as "positive").
  accent: "#00ff88",
  pos: "#00ff88",
  neg: "#ff4444",
  warn: "#fbbf24",
  info: "#4a9fff",
} as const;

export const MONO = "monospace";

// Text helpers — use these instead of hand-picking sizes/weights/colors.
export const label: CSSProperties = { fontFamily: MONO, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: C.text.muted };
export const value: CSSProperties = { fontFamily: MONO, fontSize: 16, fontWeight: 600, color: C.text.bright };
export const body: CSSProperties = { fontFamily: MONO, fontSize: 11, lineHeight: 1.5, color: C.text.fog };
export const hint: CSSProperties = { fontFamily: MONO, fontSize: 9, lineHeight: 1.5, color: C.text.faint };
