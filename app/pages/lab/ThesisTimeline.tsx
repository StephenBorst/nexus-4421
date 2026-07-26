// ── THESIS TIMELINE — the append-only story of a position ──
// Traders add, trim, move stops and flip; a frozen post can't say any of that, so
// the most useful commentary ("trimmed half here, and why") had nowhere to live.
//
// ⚠️ Updates are SELF-REPORTED NARRATIVE. Grading reads the ORIGINAL levels only
// (see app/lib/lifecycle.mjs), so nothing here can change a graded outcome — and the
// UI says so out loud, because the distinction is the whole product.
import { useState } from "react";
import type { ThesisTrade, ThesisUpdate } from "./types";
import { navBtnStyle, inputStyle } from "./styles";
import { UPDATE_KINDS, appendUpdate, lifecycleState, describeUpdate, updateKind, MAX_NOTE_LEN } from "@/lib/lifecycle.mjs";

const ago = (ms: number) => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function ThesisTimeline({ t, onUpdate, canEdit }: {
  t: ThesisTrade;
  onUpdate: (id: string, patch: Partial<ThesisTrade>) => void;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("TRIM");
  const [price, setPrice] = useState("");
  const [sizePct, setSizePct] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const state = lifecycleState(t);
  const spec = updateKind(kind);
  const needsPrice = !!spec?.needs?.includes("price");

  const submit = () => {
    const r = appendUpdate(t, { kind, price, sizePct, note });
    if (!r.ok) { setErr(r.error); return; }
    // appendUpdate is plain JS (JSDoc-typed), so narrow at the boundary. The kinds
    // it emits are enum-validated inside, hence the assertion rather than a check.
    onUpdate(t.id, { updates: r.updates as ThesisUpdate[] });
    setPrice(""); setSizePct(""); setNote(""); setErr(null); setOpen(false);
  };

  // Nothing to show and nothing to add → render nothing.
  if (!state.count && !canEdit) return null;

  return (
    <div style={{ borderTop: "1px solid #232327", paddingTop: 10, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: state.count ? 8 : 0 }}>
        <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em" }}>
          TIMELINE
          {state.count > 0 && <span style={{ color: "#33333a" }}> · {state.size}% still on{state.closed ? " · closed" : ""}</span>}
        </div>
        {canEdit && (
          <button onClick={() => { setOpen((o) => !o); setErr(null); }} style={{ ...navBtnStyle, fontSize: 9, minHeight: 26, padding: "3px 9px" }}>
            {open ? "CANCEL" : "+ UPDATE"}
          </button>
        )}
      </div>

      {/* Entries — oldest first, so it reads as a story. */}
      {state.count > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: open ? 10 : 0 }}>
          {state.timeline.map((u: { at: number; kind: string; note?: string }, i: number) => {
            const k = updateKind(u.kind);
            return (
              <div key={`${u.at}-${i}`} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span style={{ flexShrink: 0, width: 12, textAlign: "center", fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a" }}>{k?.glyph}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#d4d4d8" }}>{describeUpdate(u)}</span>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#33333a", marginLeft: 6 }}>{ago(u.at)}</span>
                  {u.note && <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 11, color: "#a1a1aa", lineHeight: 1.5, marginTop: 1 }}>{u.note}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Composer */}
      {open && canEdit && (
        <div style={{ background: "#08080a", border: "1px solid #232327", borderRadius: 3, padding: 10 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
            {UPDATE_KINDS.map((k: { key: string; label: string; glyph: string }) => (
              <button key={k.key} onClick={() => { setKind(k.key); setErr(null); }} style={{
                fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "4px 8px", cursor: "pointer",
                borderRadius: 3, minHeight: 26,
                border: `1px solid ${kind === k.key ? "#33333a" : "#232327"}`,
                background: kind === k.key ? "#1a1a1e" : "transparent",
                color: kind === k.key ? "#ededf0" : "#52525b",
              }}>{k.glyph} {k.label}</button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            <input
              style={{ ...inputStyle, fontSize: 11, padding: "6px 8px", flex: "1 1 110px", minWidth: 0 }}
              type="number" inputMode="decimal"
              placeholder={needsPrice ? "new level *" : "price (optional)"}
              value={price} onChange={(e) => setPrice(e.target.value)}
            />
            {(kind === "ADD" || kind === "TRIM") && (
              <input
                style={{ ...inputStyle, fontSize: 11, padding: "6px 8px", flex: "1 1 90px", minWidth: 0 }}
                type="number" inputMode="numeric" placeholder="size %"
                value={sizePct} onChange={(e) => setSizePct(e.target.value)}
              />
            )}
          </div>

          <input
            style={{ ...inputStyle, fontSize: 11, padding: "6px 8px", marginBottom: 6 }}
            placeholder={kind === "NOTE" ? "what changed? *" : "why? (optional)"}
            maxLength={MAX_NOTE_LEN}
            value={note} onChange={(e) => setNote(e.target.value)}
          />

          {err && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#fbbf24", marginBottom: 6 }}>{err}</div>}

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button onClick={submit} style={{ ...navBtnStyle, fontSize: 9, color: "#ededf0", borderColor: "#33333a", minHeight: 28, padding: "5px 12px" }}>APPEND</button>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#33333a", lineHeight: 1.5 }}>
              append-only · commentary, not evidence — your grade is still judged on the levels you originally posted
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
