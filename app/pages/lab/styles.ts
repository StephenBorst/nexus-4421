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

// ─── Agent (Trading Agent tab) styles ────────────────────
export const agentCardStyle: CSSProperties = {
  background: "#111318",
  border: "1px solid #1a2a1a",
  borderRadius: 6,
  padding: 16,
  marginBottom: 12,
};

export const agentLabelStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 10,
  color: "#4a7a5a",
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  marginBottom: 4,
};

export const agentInputStyle: CSSProperties = {
  background: "#0a0e0a",
  border: "1px solid #1e2d1e",
  borderRadius: 3,
  color: "#c0c0c0",
  fontFamily: "monospace",
  fontSize: 13,
  padding: "6px 10px",
  width: "100%",
  outline: "none",
};

export const agentBtnStyle = (active: boolean): CSSProperties => ({
  background: active ? "#00ff8820" : "#1a1a2e",
  border: `1px solid ${active ? "#00ff88" : "#2a2a3e"}`,
  borderRadius: 4,
  color: active ? "#00ff88" : "#6a6a8a",
  fontFamily: "monospace",
  fontSize: 11,
  padding: "8px 16px",
  cursor: "pointer",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
});
