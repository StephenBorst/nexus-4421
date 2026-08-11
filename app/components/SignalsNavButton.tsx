// ◆ SIGNALS — the global "come back to the Lab" bell. Merges the public market +
// graded-crowd + tracked-wallet feeds (buildSignals) into a ranked list, badges only
// genuinely NEW signals (stable ids marked "seen" in localStorage), and drops the user
// straight into the relevant Lab tab. This is the retention layer: a live reason to
// return, not a stale dashboard. All sources are public + fail-soft; no wallet, no key.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { buildSignals, countUnseen } from "@/lib/signals.mjs";

const AGENT_API = "https://og.nexustradinglabs.com";
const SEEN_KEY = "nexus_signals_seen";
const PRUNE_MS = 14 * 86400 * 1000;

interface Signal { id: string; kind: string; priority: number; ts: number; tab: string; title: string; detail: string; }

const loadSeen = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch { return {}; } };
const saveSeen = (m: Record<string, number>) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch { /* private mode */ } };

const KIND_GLYPH: Record<string, string> = { FADE_ALIGN: "◆", DIVERGENCE: "⚔", MOMENTUM: "↗", FUNDING: "≈", TIER: "✦" };

export default function SignalsNavButton() {
  const [list, setList] = useState<Signal[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const [sg, cs, ev] = await Promise.all([
        fetch(`${AGENT_API}/signals`).then((r) => r.json()).catch(() => null),
        fetch(`${AGENT_API}/theses/consensus`).then((r) => r.json()).catch(() => null),
        fetch(`${AGENT_API}/smart/xray/events`).then((r) => r.json()).catch(() => null),
      ]);
      const built = buildSignals({
        signals: Array.isArray(sg?.signals) ? sg.signals : [],
        consensus: cs?.consensus ?? null,
        xrayEvents: Array.isArray(ev?.events) ? ev.events : [],
      }) as Signal[];
      setList(built);
      setUnseen(countUnseen(built, loadSeen()));
    } catch { /* fail-soft — keep the last list */ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 120_000); // gentle — public data, visibility-gated
    const onVis = () => refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh]);

  // Mark everything currently shown as seen (clears the badge). Pruned on write.
  const markAllSeen = useCallback(() => {
    const now = Date.now();
    const seen = loadSeen();
    for (const s of list) seen[s.id] = now;
    for (const k of Object.keys(seen)) if (now - seen[k] > PRUNE_MS) delete seen[k];
    saveSeen(seen);
    setUnseen(0);
  }, [list]);

  const toggle = () => setOpen((o) => { const n = !o; if (n) markAllSeen(); return n; });

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const go = (s: Signal) => {
    setOpen(false);
    try { window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: s.tab } })); } catch { /* ignore */ }
    navigate(`/lab?tab=${s.tab}`);
  };

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <button
        onClick={toggle}
        title={unseen > 0 ? `Signals, ${unseen} new` : "Signals"}
        aria-label={unseen > 0 ? `Signals, ${unseen} new` : "Signals"}
        style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, background: "none", border: "none", cursor: "pointer", color: "var(--oui-color-base-contrast-54, #d4d4d8)", padding: 0 }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unseen > 0 && (
          <span style={{ position: "absolute", top: -2, right: -2, minWidth: 15, height: 15, padding: "0 4px", borderRadius: 8, background: "#3ecf8e", boxShadow: "0 0 6px rgba(62,207,142,0.7)", color: "#0f0f11", fontFamily: "var(--nx-font-mono)", fontSize: 9, fontWeight: "bold", lineHeight: "15px", textAlign: "center", boxSizing: "border-box" }}>
            {unseen > 9 ? "9+" : unseen}
          </span>
        )}
      </button>

      {open && (
        // Anchored to the VIEWPORT (fixed), not the button — so the panel can never
        // overflow off-screen on mobile where the bell sits mid-nav.
        <div className="nx-fade-in" style={{ position: "fixed", top: 54, right: 8, zIndex: 9500, width: "min(360px, calc(100vw - 16px))", maxHeight: "72vh", overflowY: "auto", background: "#0f0f11", border: "1px solid #33333a", borderRadius: 10, boxShadow: "0 16px 50px rgba(0,0,0,0.6)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderBottom: "1px solid #232327", position: "sticky", top: 0, background: "#0f0f11" }}>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", color: "#ededf0" }}>◆ SIGNALS</span>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.05em" }}>live · public · graded</span>
          </div>
          {list.length === 0 ? (
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#71717a", padding: "18px 14px", textAlign: "center", lineHeight: 1.6 }}>
              Quiet tape. No stretched setups or tier moves right now — signals fire as the market and the graded crowd move.
            </div>
          ) : (
            list.map((s) => (
              <button key={s.id} onClick={() => go(s)} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid #1a1a1e", cursor: "pointer", padding: "11px 14px" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: s.kind === "DIVERGENCE" ? "#fbbf24" : "#3ecf8e", flexShrink: 0 }}>{KIND_GLYPH[s.kind] ?? "◆"}</span>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#f4f4f5", fontWeight: 600, lineHeight: 1.35 }}>{s.title}</span>
                </div>
                <div style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: 11.5, color: "#a1a1aa", lineHeight: 1.5, marginTop: 3, paddingLeft: 19 }}>{s.detail}</div>
              </button>
            ))
          )}
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", padding: "9px 14px", textAlign: "center" }}>synthesized from funding, the graded caller crowd, and tracked wallets</div>
        </div>
      )}
    </div>
  );
}
