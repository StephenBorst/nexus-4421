// Market Intel tab (Intel + News sub-toggle). Extracted from index.tsx.
import { useState, useEffect } from "react";
import { navBtnStyle } from "./styles";
import { useIsMobile } from "./useIsMobile";
import IntelPage from "@/pages/intel";
// Pure + pinned by tests (app/lib/rssDate.test.mjs) — see that file for the "-333m" bug.
import { parseRssDate, timeAgo } from "@/lib/rssDate.mjs";

// ─── News helpers ─────────────────────────────────────────
// ⚠ rss2json MUST be called from the BROWSER, not a Worker: it blocks Cloudflare
// datacenter IPs (same class as the CoinGecko-from-Workers 403), so a server-side
// /intel/news route returns nothing. The bug that made news look "stale" was never
// the fetch — it was The Defiant stamping every item with one feed-BUILD timestamp,
// which floated its old stories to the top. We fix that here (de-rank a uniform-clock
// feed + cap per source) while keeping the fetch client-side where rss2json answers.
interface NewsItem { title: string; description: string; link: string; pubDate: string; source: string; category: string; }

// ⚠ THE DEFIANT IS DROPPED ON PURPOSE. Its feed re-stamps a cluster of MONTH-OLD
// stories (SummerFi wind-down, eToro/Extended, NEAR gas rebate…) with the current
// feed-BUILD time — all 6 shared one identical, always-freshest timestamp — so they
// pinned the top of the feed indefinitely. That is THE bug behind "same stories from a
// month ago." The remaining feeds date their articles honestly. (See the cluster guard
// in fetchFeed for the general defense against any other feed that tries this.)
const FEEDS = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", name: "COINDESK" },
  { url: "https://cointelegraph.com/rss",                   name: "COINTELEGRAPH" },
  { url: "https://decrypt.co/feed",                         name: "DECRYPT" },
  { url: "https://finance.yahoo.com/news/rssindex",         name: "YAHOO FINANCE" },
];

function categorizeNews(title: string, desc: string): string {
  const t = (title + " " + desc).toLowerCase();
  if (/\b(fed|fomc|powell|interest rate|inflation|gdp|recession|economy|treasury|cpi|monetary)\b/.test(t)) return "MACRO";
  if (/\b(defi|dex|perpetual|protocol|yield|aave|uniswap|orderly|gmx|liquidity|onchain)\b/.test(t)) return "DEFI";
  if (/\b(geopolit|war|sanction|iran|russia|china|tariff|trade war|conflict|military)\b/.test(t)) return "GEOPOLITICS";
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|blockchain|altcoin|token|nft|web3)\b/.test(t)) return "CRYPTO";
  if (/\b(stocks|equity|nasdaq|s&p|dow|earnings|ipo|nyse|market cap|share)\b/.test(t)) return "MARKETS";
  return "NEWS";
}

interface RawItem extends NewsItem { ts: number; reliableDate: boolean; }

async function fetchFeed(url: string, source: string): Promise<RawItem[]> {
  try {
    // rss2json's `count` needs a paid key (free tier 422s) — omit + slice instead.
    const d = await (await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`)).json();
    if (d?.status !== "ok" || !Array.isArray(d.items)) return [];
    const items: RawItem[] = d.items.slice(0, 12).map((it: { title?: string; description?: string; link?: string; pubDate?: string }) => {
      const title = (it.title ?? "").trim();
      const description = (it.description ?? "").replace(/<[^>]*>/g, "").slice(0, 240).trim();
      return { title, description, link: it.link ?? "", pubDate: it.pubDate ?? "",
               ts: parseRssDate(it.pubDate ?? "") || 0, source, category: categorizeNews(title, description), reliableDate: true };
    }).filter((i: RawItem) => i.title);
    // Broken-clock detection. A publisher that re-stamps stale stories gives a CLUSTER
    // of items the exact same (build-time) timestamp — not necessarily the whole feed
    // (The Defiant poisoned 6 of 10). So mark unreliable any item whose exact ts is
    // shared by ≥4 items in the feed — real articles almost never publish at the same
    // second, and this sinks the re-stamped block below honestly-dated stories.
    const counts = new Map<number, number>();
    for (const i of items) counts.set(i.ts, (counts.get(i.ts) || 0) + 1);
    for (const i of items) if ((counts.get(i.ts) || 0) >= 4) i.reliableDate = false;
    return items;
  } catch { return []; }
}

function NewsTab() {
  const [items,     setItems]     = useState<NewsItem[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [filter,    setFilter]    = useState("ALL");
  const [countdown, setCountdown] = useState(300);
  const isMob = useIsMobile();

  const TEAL   = "#ededf0";
  const DIM    = "rgba(255,255,255,0.35)", MUTED = "rgba(255,255,255,0.60)", BRIGHT = "rgba(255,255,255,0.87)";
  const CATS   = ["ALL", "CRYPTO", "MACRO", "DEFI", "MARKETS", "GEOPOLITICS"];
  // Category tags carry NO semantic weight — every one renders as the same bone-white
  // chip. Colour here would imply state (amber=caution, red=loss, green=profit) it doesn't have.
  const catClr = (_c: string) => TEAL;

  const load = async () => {
    setLoading(true);
    const results = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f.url, f.name)));
    let all: RawItem[] = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    // Dedup by title prefix.
    const seen = new Set<string>();
    all = all.filter((i) => { const k = i.title.slice(0, 50); if (seen.has(k)) return false; seen.add(k); return true; });
    // Reliably-dated newest-first; broken-clock feeds sink to the bottom.
    all.sort((a, b) => (Number(b.reliableDate) - Number(a.reliableDate)) || (b.ts - a.ts));
    // Cap per source so no single feed can dominate the top.
    const per: Record<string, number> = {};
    const capped = all.filter((i) => { per[i.source] = (per[i.source] || 0) + 1; return per[i.source] <= 12; });
    if (capped.length) setItems(capped.slice(0, 50).map(({ ts, reliableDate, ...rest }) => rest));
    setLoading(false);
    setCountdown(300);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { const iv = setInterval(load, 300_000); return () => clearInterval(iv); }, []);
  useEffect(() => { const t = setInterval(() => setCountdown(c => c > 0 ? c - 1 : 300), 1000); return () => clearInterval(t); }, []);

  const ago = (d: string) => timeAgo(d);
  const shown = filter === "ALL" ? items : items.filter(i => i.category === filter);

  return (
    <div style={{ fontFamily: "var(--nx-font-mono)", color: BRIGHT, fontSize: 13 }}>

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
          <span style={{ fontSize: 10, opacity: 0.5 }}>coindesk · cointelegraph · decrypt · yahoo finance</span>
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
        // COINDESK · COINTELEGRAPH · DECRYPT · YAHOO FINANCE · AUTO-REFRESH 5MIN
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
      {/* MarketTape moved to the DECISION tabs (thesis/agent) as a thin regime strip —
          IntelPage below already leads with sentiment, so a second score here was
          redundant. Signal belongs where the decision is. */}
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

