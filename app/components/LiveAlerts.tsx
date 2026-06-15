// 🔔 Live Alerts — "X just opened LONG BTC" when a tracked trader/agent opens a
// position. Polls the public LIVE NOW feed (/agents/live), diffs against what
// we've already seen, and surfaces genuinely-new opens as in-app toasts +
// (opt-in) OS notifications. Reuses existing data — no new backend, no push infra.
// Mounted globally so alerts fire wherever you are in the app.
import { useEffect, useRef, useState } from "react";

const API_BASE = "https://og.nexustradinglabs.com";
const green = "#00ff88";
const red = "#ff4444";
const NOTIF_KEY = "nexus_live_notif"; // "on" once the user enables OS notifications

type LivePos = {
  wallet: string; agent: boolean; displayName: string | null;
  symbol: string; direction: "LONG" | "SHORT"; opened_at: number | null;
};
type Toast = { id: string; who: string; symbol: string; direction: "LONG" | "SHORT" };

const tk = (s: string) => s.replace("PERP_", "").replace("_USDC", "");
const shortAddr = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const keyOf = (p: LivePos) => `${p.wallet}|${p.symbol}|${p.opened_at ?? ""}`;

export default function LiveAlerts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [notif, setNotif] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(NOTIF_KEY) === "on");
  const [showEnable, setShowEnable] = useState(false);
  const seen = useRef<Set<string> | null>(null); // null until first load (don't alert the existing backlog)

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const d = await (await fetch(`${API_BASE}/agents/live`)).json();
        const positions: LivePos[] = Array.isArray(d?.positions) ? d.positions : [];
        if (!alive) return;
        const keys = positions.map(keyOf);
        if (seen.current === null) { seen.current = new Set(keys); return; } // prime, no alerts
        const fresh = positions.filter((p) => !seen.current!.has(keyOf(p)));
        for (const k of keys) seen.current.add(k);
        if (!fresh.length) return;
        if (!window.localStorage.getItem(NOTIF_KEY)) setShowEnable(true); // nudge once there's activity
        for (const p of fresh.slice(0, 3)) {
          const who = p.agent ? "Nexus Agent" : (p.displayName || shortAddr(p.wallet));
          const id = `${keyOf(p)}-${Date.now()}`;
          setToasts((t) => [{ id, who, symbol: p.symbol, direction: p.direction }, ...t].slice(0, 4));
          setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 9000);
          if (notif && typeof Notification !== "undefined" && Notification.permission === "granted") {
            try { new Notification(`${who} opened ${p.direction} ${tk(p.symbol)}`, { body: "Tap to view on Nexus", icon: "/icon-1024.png" }); } catch { /* ignore */ }
          }
        }
      } catch { /* fail-soft */ }
    };
    poll();
    const id = setInterval(poll, 20000);
    return () => { alive = false; clearInterval(id); };
  }, [notif]);

  async function enableNotif() {
    setShowEnable(false);
    try {
      if (typeof Notification === "undefined") return;
      const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (perm === "granted") { window.localStorage.setItem(NOTIF_KEY, "on"); setNotif(true); }
    } catch { /* ignore */ }
  }

  if (!toasts.length && !showEnable) return null;

  return (
    <div style={{ position: "fixed", left: 16, bottom: 16, zIndex: 9000, display: "flex", flexDirection: "column", gap: 8, maxWidth: 280 }}>
      {showEnable && (
        <div style={{ background: "#0d120d", border: "1px solid #1a3a1a", borderRadius: 6, padding: "8px 10px", fontFamily: "monospace", fontSize: 10, color: "#8aaa9a", display: "flex", alignItems: "center", gap: 8 }}>
          <span>🔔 Get pinged when traders open positions</span>
          <button onClick={enableNotif} style={{ marginLeft: "auto", flexShrink: 0, background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 3, padding: "3px 8px", fontFamily: "monospace", fontSize: 9, fontWeight: "bold", cursor: "pointer" }}>ON</button>
          <button onClick={() => { setShowEnable(false); window.localStorage.setItem(NOTIF_KEY, "off"); }} style={{ flexShrink: 0, background: "none", border: "none", color: "#3a5a4a", cursor: "pointer", fontSize: 12 }}>✕</button>
        </div>
      )}
      {toasts.map((t) => (
        <a
          key={t.id}
          href={`/perp/${t.symbol.startsWith("PERP_") ? t.symbol : `PERP_${t.symbol}_USDC`}`}
          style={{ textDecoration: "none", background: "#0d120d", border: `1px solid ${t.direction === "LONG" ? "#1a4a2a" : "#4a1a1a"}`, borderRadius: 6, padding: "9px 11px", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.5)" }}
        >
          <span style={{ fontSize: 13 }}>🔔</span>
          <span style={{ fontSize: 11, color: "#e5e7eb" }}>
            <b style={{ color: "#fff" }}>{t.who}</b> opened{" "}
            <b style={{ color: t.direction === "LONG" ? green : red }}>{t.direction === "LONG" ? "↑" : "↓"} {t.direction} {tk(t.symbol)}</b>
          </span>
        </a>
      ))}
    </div>
  );
}
