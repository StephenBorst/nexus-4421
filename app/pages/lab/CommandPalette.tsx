// ⌘K command palette for The Lab — jump to any tab or global surface without
// hunting the tab bar. Opens on Cmd/Ctrl+K (or "/"), fuzzy-filters, arrow-key
// navigable, Enter to run. Pure client, no deps. The single biggest "premium
// terminal" signal — and it fits the keyboard-first identity.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TabId } from "./types";

export interface Command {
  id: string;
  label: string;
  hint?: string;      // right-aligned context (e.g. "tab", "page")
  keywords?: string;  // extra fuzzy-match terms
  run: () => void;
}

// Lightweight subsequence fuzzy match — every char of the query appears in order.
function fuzzy(query: string, text: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase(), t = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
  return i === q.length;
}

export function CommandPalette({ onSelectTab }: { onSelectTab: (t: TabId) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  const commands = useMemo<Command[]>(() => {
    const tab = (id: TabId, label: string, keywords?: string): Command => ({
      id: `tab:${id}`, label, hint: "tab", keywords, run: () => onSelectTab(id),
    });
    return [
      tab("intel", "Market Intel", "scan funding oi movers"),
      tab("thesis", "Nexus Thesis Engine", "plan position size r:r"),
      tab("agent", "Trading Agent", "autonomous bot automate"),
      tab("quicktrade", "Quick Trade", "buy sell perp order"),
      tab("copies", "Copy Trades", "follow mirror"),
      tab("tradelog", "Trading Log", "journal calendar history"),
      tab("holders", "Holders Room", "nexus token gated"),
      tab("analytics", "Analytics", "stats performance"),
      { id: "nav:feed", label: "Open Feed", hint: "page", keywords: "social calls callers", run: () => navigate("/feed") },
      { id: "nav:messages", label: "Open Messages", hint: "page", keywords: "dm xmtp inbox", run: () => navigate("/messages") },
      { id: "nav:portfolio", label: "Open Portfolio", hint: "page", keywords: "balance positions", run: () => navigate("/portfolio") },
      { id: "nav:markets", label: "Open Markets", hint: "page", keywords: "list all perps", run: () => navigate("/markets") },
    ];
  }, [navigate, onSelectTab]);

  const results = useMemo(
    () => commands.filter((c) => fuzzy(query, c.label) || (c.keywords ? fuzzy(query, c.keywords) : false)),
    [commands, query]
  );

  // Global hotkey: Cmd/Ctrl+K toggles. Ignore when typing in an input/textarea so
  // "/" doesn't hijack the thesis editor etc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "/" && !typing && !open) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Reset + focus on open.
  useEffect(() => {
    if (open) { setQuery(""); setActive(0); setTimeout(() => inputRef.current?.focus(), 20); }
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  if (!open) return null;

  const runAt = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    setOpen(false);
    cmd.run();
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); runAt(active); }
  };

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh",
      }}
    >
      <div
        className="nx-fade-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onListKey}
        style={{
          width: "min(560px, 92vw)", background: "#0f0f11",
          border: "1px solid #33333a", borderRadius: 8,
          boxShadow: "0 24px 60px rgba(0,0,0,0.6)", overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid #232327" }}>
          <span style={{ color: "#52525b", fontFamily: "var(--nx-font-mono)", fontSize: 13 }}>&#8250;</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to…"
            style={{
              flex: 1, background: "none", border: "none", outline: "none",
              color: "#f4f4f5", fontFamily: "var(--nx-font-mono)", fontSize: 14,
            }}
          />
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", border: "1px solid #232327", borderRadius: 3, padding: "2px 6px" }}>ESC</span>
        </div>
        <div style={{ maxHeight: 340, overflowY: "auto", padding: 6 }}>
          {results.length === 0 ? (
            <div style={{ padding: "18px 12px", textAlign: "center", color: "#52525b", fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>
              no matches
            </div>
          ) : (
            results.map((c, i) => (
              <div
                key={c.id}
                onMouseEnter={() => setActive(i)}
                onClick={() => runAt(i)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "9px 10px", borderRadius: 4, cursor: "pointer",
                  background: i === active ? "#1a1a1e" : "transparent",
                  border: `1px solid ${i === active ? "#33333a" : "transparent"}`,
                }}
              >
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: i === active ? "#f4f4f5" : "#a1a1aa" }}>{c.label}</span>
                {c.hint && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase" }}>{c.hint}</span>}
              </div>
            ))
          )}
        </div>
        <div style={{ display: "flex", gap: 12, padding: "8px 14px", borderTop: "1px solid #232327", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>
          <span>&#8593;&#8595; navigate</span>
          <span>&#8629; select</span>
          <span style={{ marginLeft: "auto" }}>&#8984;K / &nbsp;/&nbsp; toggle</span>
        </div>
      </div>
    </div>
  );
}
