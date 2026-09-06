// ⊕ LATEST TAKES — fresh bull/bear conviction from across every /token page, surfaced in the
// Feed so discussion on one token pulls traffic back into Spot. Reads GET /takes/hot (public,
// recency-ranked, firewalled from the graded boards). Fail-soft: renders nothing when empty, so
// it never shows an empty band at cold-start. Horizontal-scroll row → never clips on mobile.
// Each card deep-links to that token's Spot page (/token/:ca), where the full thread lives.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchCallerMerit, type CallerMerit } from "@/pages/token/data";

const API_BASE = "https://og.nexustradinglabs.com";
const green = "#3ecf8e";
const red = "#f7525f";
const mono = "var(--nx-font-mono)";

type HotTake = {
  id: string; wallet: string; direction: "BULL" | "BEAR"; text: string;
  target: number | null; sym?: string; pfp?: string | null; displayName?: string | null;
  createdAt: number; chain: string; ca: string; fire?: number;
};

const shortAddr = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const ago = (ms: number) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

export default function TakesStrip() {
  const [takes, setTakes] = useState<HotTake[] | null>(null);
  const [merit, setMerit] = useState<Record<string, CallerMerit>>({});
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await (await fetch(`${API_BASE}/takes/hot`)).json();
        if (alive) setTakes(Array.isArray(d?.takes) ? d.takes : []);
      } catch { if (alive) setTakes([]); }
    };
    load();
    // Author merit ranks (module-cached) → the differentiator on the discovery surface too.
    fetchCallerMerit().then((m) => { if (alive) setMerit(m); }).catch(() => { /* no badges */ });
    const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!takes || takes.length === 0) return null;

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontFamily: mono, fontSize: 11, fontWeight: "bold", color: "#ededf0", letterSpacing: "0.12em" }}>🔥 HOT TAKES</span>
        <span style={{ fontFamily: mono, fontSize: 9, color: "#52525b" }}>ungraded conviction on Spot tokens · tap to open</span>
      </div>

      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
        {takes.map((t) => {
          const bull = t.direction === "BULL";
          const m = merit[t.wallet.toLowerCase()];
          return (
            <div
              key={t.id}
              onClick={() => navigate(`/token/${t.ca}`)}
              style={{
                flex: "1 1 190px", minWidth: 190, maxWidth: 240, background: "#0a0a0b",
                border: `1px solid ${bull ? "#1c3a2e" : "#4a1e22"}`, borderRadius: 5,
                padding: "9px 11px", fontFamily: mono, cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                <span style={{ fontSize: 12, fontWeight: "bold", color: "#fff" }}>${t.sym || "—"}</span>
                <span style={{ fontSize: 8.5, fontWeight: "bold", letterSpacing: "0.04em", color: bull ? green : red }}>{t.direction}</span>
                <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                  {t.fire ? <span style={{ fontSize: 8.5, color: "#f7931a" }}>🔥 {t.fire}</span> : null}
                  <span style={{ fontSize: 8, color: "#52525b" }}>{ago(t.createdAt)}</span>
                </span>
              </div>
              <div style={{ fontSize: 11, color: "#d4d4d8", lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{t.text}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6, overflow: "hidden" }}>
                <span style={{ fontSize: 8, color: "#52525b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.displayName || shortAddr(t.wallet)}</span>
                {m && <span title={`${m.title} caller · ${m.hitRate}% hit`} style={{ flexShrink: 0, fontSize: 7.5, fontWeight: "bold", letterSpacing: "0.03em", color: green, border: `1px solid ${green}44`, borderRadius: 4, padding: "1px 4px" }}>{m.glyph} {m.hitRate}%</span>}
                {t.target ? <span style={{ flexShrink: 0, fontSize: 8, color: "#52525b" }}>🎯 {t.target}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
