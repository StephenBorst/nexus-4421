// Shared inline styles + status config for The Lab.
// Extracted from index.tsx (god-file split) — pure constants, no behavior change.
import type { CSSProperties } from "react";
import type { ThesisStatus } from "./types";

export const cardStyle: CSSProperties = {
  background: "#0d120d",
  border: "1px solid #1a2e1a",
  borderRadius: 4,
  padding: "12px 14px",
};

export const labelStyle: CSSProperties = {
  fontSize: 9,
  letterSpacing: "0.12em",
  color: "#3a5a4a",
  marginBottom: 6,
  fontFamily: "monospace",
};

export const navBtnStyle: CSSProperties = {
  background: "none",
  border: "1px solid #1a2e1a",
  color: "#4a7a5a",
  fontFamily: "monospace",
  fontSize: 11,
  padding: "5px 12px",
  cursor: "pointer",
  borderRadius: 3,
};

export const inputStyle: CSSProperties = {
  width: "100%",
  background: "#080c08",
  border: "1px solid #1a2e1a",
  borderRadius: 3,
  color: "#00ff88",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "8px 10px",
  outline: "none",
  boxSizing: "border-box",
};

export const fieldLabelStyle: CSSProperties = {
  fontSize: 9,
  color: "#3a5a4a",
  fontFamily: "monospace",
  letterSpacing: "0.1em",
  marginBottom: 4,
  display: "block",
};

export const STATUS_CONFIG: Record<ThesisStatus, { label: string; color: string; bg: string; border: string }> = {
  ACTIVE:      { label: "ACTIVE",      color: "#4a9fff", bg: "#0a1a2a", border: "#1a3a5a" },
  HIT_TP:      { label: "HIT TP",      color: "#00ff88", bg: "#0a2a0a", border: "#1a4a2a" },
  STOPPED_OUT: { label: "STOPPED OUT", color: "#ff4444", bg: "#2a0a0a", border: "#4a1a1a" },
  INVALIDATED: { label: "INVALIDATED", color: "#fbbf24", bg: "#2a1a00", border: "#4a3a00" },
};

export const CLOSED_STATUSES: ThesisStatus[] = ["HIT_TP", "STOPPED_OUT", "INVALIDATED"];

// ─── Agent (Trading Agent tab) styles — built from the design tokens ─────────
import { C, S, RADIUS, MONO } from "./tokens";

export const agentCardStyle: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: RADIUS.md,
  padding: S.lg,
  marginBottom: S.md,
};

export const agentLabelStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  color: C.text.muted,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  marginBottom: S.xs,
};

export const agentInputStyle: CSSProperties = {
  background: C.canvas,
  border: `1px solid ${C.border}`,
  borderRadius: RADIUS.sm,
  color: C.text.bright,
  fontFamily: MONO,
  fontSize: 13,
  padding: "6px 10px",
  width: "100%",
  outline: "none",
};

// The ONE rationed accent CTA — filled green. Use ≤1 per card/screen.
export const btnPrimary: CSSProperties = {
  background: "#00ff8818",
  border: `1px solid ${C.accent}`,
  borderRadius: RADIUS.sm,
  color: C.accent,
  fontFamily: MONO,
  fontSize: 11,
  padding: "8px 16px",
  cursor: "pointer",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  fontWeight: 600,
};

// Quiet default button — everything that isn't the primary action.
export const btnGhost: CSSProperties = {
  background: "none",
  border: `1px solid ${C.border}`,
  borderRadius: RADIUS.sm,
  color: C.text.muted,
  fontFamily: MONO,
  fontSize: 11,
  padding: "8px 16px",
  cursor: "pointer",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

// Toggle (active/inactive) — used for mode/selector buttons. Active = rationed
// accent; inactive = quiet. Keeps hierarchy by tone, not by adding new colors.
export const agentBtnStyle = (active: boolean): CSSProperties =>
  active ? { ...btnPrimary } : { ...btnGhost };
