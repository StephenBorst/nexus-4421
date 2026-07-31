// Market Intel tab (Intel + News sub-toggle). Extracted from index.tsx.
import { useState, useEffect } from "react";
import { navBtnStyle } from "./styles";
import { useIsMobile } from "./useIsMobile";
import IntelPage from "@/pages/intel";
import { MarketTape } from "./MarketTape";
import { AGENT_API } from "./agentTypes";
// Pure + pinned by tests (app/lib/rssDate.test.mjs) — see that file for the "-333m" bug.
import { timeAgo } from "@/lib/rssDate.mjs";

// ─── News helpers ─────────────────────────────────────────
interface NewsItem { title: string; description: string; link: string; pubDate: string; source: string; category: string; }

function NewsTab() {
  const [items,     setItems]     = useState<NewsItem[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [filter,    setFilter]    = useState("ALL");
  const [countdown, setCountdown] = useState(300);
  const isMob = useIsMobile();

  const TEAL   = "#ededf0", GREEN = "#a1a1aa";
  const DIM    = "rgba(255,255,255,0.35)", MUTED = "rgba(255,255,255,0.60)", BRIGHT = "rgba(255,255,255,0.87)";
  const CATS   = ["ALL", "CRYPTO", "MACRO", "DEFI", "MARKETS", "GEOPOLITICS"];
  // Category tags carry NO semantic weight — every one renders as the same bone-white
  // chip. Colour here would imply state (amber=caution, red=loss, green=profit) it doesn't have.
  const catClr = (_c: string) => TEAL;

  // Aggregation now happens SERVER-SIDE (/intel/news): one request instead of 5
  // concurrent rss2json calls (which the free tier throttled → only 1 feed survived,
  // usually The Defiant, whose uniform feed-build timestamps pinned stale stories to
  // the top). The worker fetches sequentially, de-ranks broken-clock feeds, caps per
  // source and edge-caches 300s. Fail-soft: an error just leaves the list untouched.
  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${AGENT_API}/intel/news`);
      const d = await r.json();
      if (Array.isArray(d?.items)) setItems(d.items as NewsItem[]);
    } catch { /* keep whatever we had */ }
    setLoading(false);
    setCountdown(300);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { const iv = setInterval(load, 300_000); return () => clearInterval(iv); }, []);
  useEffect(() => { const t = setInterval(() => setCountdown(c => c > 0 ? c - 1 : 300), 1000); return () => clearInterval(t); }, []);

  const ago = (d: string) => timeAgo(d);
  const shown = filter === "ALL" ? items : items.filter(i => i.category === filter);

  return (
    <div style={{ fontFamily: "'Courier New', Courier, monospace", color: BRIGHT, fontSize: 13 }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
        <span style={{ color: TEAL, fontSize: 10, letterSpacing: "0.12em" }}>// MARKET INTELLIGENCE FEED</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {loading
            ? <span style={{ color: TEAL, fontSize: 10 }}>⟳ CONNECTING</span>
            : <span style={{ color: DIM, fontSize: 10 }}>REFRESH {countdown}s</span>}
          <button onClick={load} style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", color: MUTED, fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "2px 8px", cursor: "pointer" }}>↻</button>
        </div>
      </div>

      {/* Category filter */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        {CATS.map(c => (
          <button key={c} onClick={() => setFilter(c)} style={{
            background: filter === c ? "rgba(237,237,240,0.08)" : "none",
            border: `1px solid ${filter === c ? TEAL : "rgba(255,255,255,0.08)"}`,
            color: filter === c ? TEAL : DIM,
            fontFamily: "var(--nx-font-mono)", fontSize: 10,
            padding: "3px 9px", cursor: "pointer", letterSpacing: "0.06em",
          }}>{c}</button>
        ))}
        <span style={{ color: DIM, fontSize: 10, marginLeft: "auto", alignSelf: "center" }}>{shown.length} stories</span>
      </div>

      {/* Loading state */}
      {loading && items.length === 0 && (
        <div style={{ color: DIM, padding: "40px 0", textAlign: "center", fontSize: 12 }}>
          CONNECTING TO FEEDS…<br />
          <span style={{ fontSize: 10, opacity: 0.5 }}>coindesk · cointelegraph · decrypt · the defiant · yahoo finance</span>
        </div>
      )}

      {/* Feed cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {shown.map((item, i) => (
          <a key={i} href={item.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", display: "block" }}>
            <div
              style={{ padding: "10px 12px", background: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer" }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(237,237,240,0.28)")}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)")}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, gap: 8 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ color: catClr(item.category), fontSize: 9, letterSpacing: "0.1em", border: "1px solid currentColor", padding: "1px 5px" }}>{item.category}</span>
                  <span style={{ color: DIM, fontSize: 10 }}>{item.source}</span>
                </div>
                <span style={{ color: DIM, fontSize: 10, flexShrink: 0 }}>{ago(item.pubDate)}</span>
              </div>
              <div style={{ color: BRIGHT, fontWeight: 600, fontSize: isMob ? 12 : 13, lineHeight: 1.4, marginBottom: item.description ? 4 : 0 }}>{item.title}</div>
              {item.description && (
                <div style={{ color: MUTED, fontSize: 11, lineHeight: 1.5 }}>{item.description.slice(0, 180)}{item.description.length > 180 ? "…" : ""}</div>
              )}
            </div>
          </a>
        ))}
      </div>

      {!loading && shown.length === 0 && (
        <div style={{ color: DIM, padding: "20px 0", textAlign: "center", fontSize: 12 }}>No {filter} stories found in current feed.</div>
      )}

      <div style={{ color: DIM, fontSize: 10, marginTop: 12, letterSpacing: "0.05em" }}>
        // COINDESK · COINTELEGRAPH · DECRYPT · THE DEFIANT · YAHOO FINANCE · AUTO-REFRESH 5MIN
      </div>
    </div>
  );
}

// ─── AgentView ───────────────────────────────────────────
import { AgentView } from "./AgentView";

// ─── Main Page ───────────────────────────────────────────
// ─── Market Intel (Intel + News merged) ──────────────────
export function MarketIntelView() {
  const [sub, setSub] = useState<"intel" | "news">("intel");
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 9, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 5 }}>Scout</div>
        <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: 24, fontWeight: 700, color: "#f4f4f5", lineHeight: 1.1, letterSpacing: "-0.01em" }}>The Market Terminal</div>
      </div>
      <MarketTape />
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {([
          { id: "intel" as const, label: "INTEL" },
          { id: "news" as const, label: "NEWS" },
        ]).map(({ id, label }) => (
          <button key={id} onClick={() => setSub(id)} style={{
            ...navBtnStyle, fontSize: 10, padding: "5px 16px",
            color: sub === id ? "#ededf0" : "#52525b",
            borderColor: sub === id ? "#33333a" : "#232327",
            background: sub === id ? "#1a1a1e" : "transparent",
          }}>{label}</button>
        ))}
      </div>
      {sub === "intel" ? <IntelPage embedded /> : <NewsTab />}
    </div>
  );
}

