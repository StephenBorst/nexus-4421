// ── Nexus design tokens — the ONE source of truth, app-wide ───────────────────
// Promoted out of app/pages/lab/tokens.ts so every surface (Lab, Feed, Messages,
// mini app, components) draws from the same system instead of 400+ hardcoded hexes.
// Borrows Linear's DISCIPLINE (rationed accent, 4px spacing scale, defined type
// scale, hierarchy by weight/tone not color). Identity (2026-07): MONOCHROME editorial
// neutral black + bone/white accent; green reserved for profit only. Full reference:
// app/DESIGN.md.
//
// THE RULES (why it should feel calm + intuitive, not busy):
//  1. ONE accent. `C.accent` (green) is reserved for the primary CTA + genuinely
//     positive values. Structure/labels/secondary UI use the muted `text.*` tones.
//     If everything is green, nothing reads as important.
//  2. Hierarchy by TONE + WEIGHT, not more color.
//  3. Spacing from `S` (4px base). Type from `TYPE`. Radius from `RADIUS`. No magic numbers.
//  4. Elevation = hairline border (`C.border`) + surface tier, not heavy shadow.
//  5. Interaction (hover/focus/transition) lives in the CSS layer (nx-* classes in
//     app/styles/index.css, driven by these same tokens) — inline styles can't do it.
import type { CSSProperties } from "react";

// ── Spacing — 4px base, compact density ──────────────────────────────────────
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, huge: 48 } as const;

export const RADIUS = { sm: 3, md: 6, lg: 8 } as const;

export const MONO = "var(--nx-font-mono)";

// ── Responsive — single breakpoint (matches useIsMobile) ─────────────────────
export const BP = { mobile: 768 } as const;

// ── Motion — subtle, terminal-appropriate (no bounce) ────────────────────────
export const MOTION = {
  fast: "110ms",
  base: "170ms",
  slow: "260ms",
  ease: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

// ── Color — surfaces stratified by luminance, ONE rationed accent ────────────
// Editorial-black direction (2026-07): MONOCHROME — neutral near-black canvas +
// bone/white as the only "accent" (CTA + interaction), no chromatic brand color.
// Green is DEMOTED to a data role — profit only (`pos`) — so up/down P&L is the
// ONLY chroma on a given screen. Red = loss. Keeps a subtle terminal register.
export const C = {
  canvas: "#0a0a0b",
  surface: "#141416",
  surfaceAlt: "#0f0f11",
  inset: "#08080a",
  border: "#232327",
  borderStrong: "#33333a",
  borderAccent: "#5a5a6355",
  text: {
    bright: "#f4f4f5", // primary values / headings (bone)
    fog: "#a1a1aa",    // secondary text
    muted: "#71717a",  // labels
    faint: "#52525b",  // hints / captions
  },
  accent: "#ededf0", // bone/white — CTA + interaction, NOT P&L
  pos: "#3ecf8e",    // profit / up / live
  neg: "#f7525f",    // loss / down
  warn: "#fbbf24",
  info: "#d4d4d8",   // neutral status (active/closed) — stays monochrome
} as const;

// Status tints (thesis/agent states) — surface + border + text, from the palette.
export const STATUS_TINT = {
  active:  { color: C.info, bg: "#1a1a1e", border: "#33333a" },
  pos:     { color: C.pos, bg: "#1a1a1e", border: "#33333a" },
  neg:     { color: C.neg, bg: "#241012", border: "#4a1e22" },
  warn:    { color: C.warn, bg: "#2a1a00", border: "#4a3a00" },
} as const;

// Drift map — legacy near-duplicate greens → canonical tone. Referenced when
// migrating raw hex so the collapse is deliberate, not guesswork.
//   #71717a → text.muted · #a1a1aa → text.fog · #a1a1aa → text.fog
export const DRIFT_TO_CANONICAL: Record<string, string> = {
  "#71717a": C.text.muted,
  "#a1a1aa": C.text.fog,
  "#a1a1aa": C.text.fog,
};

// ── Type scale — monospace, tuned for dense terminal UI ──────────────────────
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
