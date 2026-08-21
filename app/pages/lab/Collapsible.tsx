import { useState } from "react";

// ── Collapsible — progressive disclosure for the Lab ─────────────────────────
// The engine surfaces the synthesized read up top; the raw/deep boards live behind
// a header the user opens on demand, so a tab is one screen by default, not twenty.
// Remembers its open/closed state per storageKey.

const MONO = "var(--nx-font-mono)";
const UI = "var(--nx-font-ui, sans-serif)";

export function Collapsible({ title, subtitle, defaultOpen = false, storageKey, children }: {
  title: string; subtitle?: string; defaultOpen?: boolean; storageKey?: string; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    if (storageKey) { try { const v = window.localStorage.getItem(storageKey); if (v != null) return v === "1"; } catch { /* private mode */ } }
    return defaultOpen;
  });
  const toggle = () => {
    const n = !open; setOpen(n);
    if (storageKey) { try { window.localStorage.setItem(storageKey, n ? "1" : "0"); } catch { /* ignore */ } }
  };
  return (
    <div style={{ marginTop: 18, borderTop: "1px solid #232327", paddingTop: 2 }}>
      <button type="button" onClick={toggle} className="nx-press" style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10, background: "none", border: "none",
        padding: "13px 2px", cursor: "pointer", textAlign: "left",
      }}>
        <span aria-hidden style={{ fontFamily: MONO, fontSize: 12, color: open ? "#ededf0" : "#71717a", width: 12, transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "none" }}>›</span>
        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color: "#ededf0" }}>{title}</span>
        {subtitle && <span style={{ fontFamily: UI, fontSize: 11, color: "#71717a" }}>{subtitle}</span>}
        <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 10, color: "#52525b" }}>{open ? "collapse" : "expand"}</span>
      </button>
      {open && <div className="nx-fade-in" style={{ paddingTop: 6 }}>{children}</div>}
    </div>
  );
}

export default Collapsible;
