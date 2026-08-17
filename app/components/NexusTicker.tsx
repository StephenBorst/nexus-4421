// ── NEXUS TICKER — the Wall-Street tape across the top of the Lab ─────────────
// A single thin scrolling band of the live market tape: top perps by volume with
// their 24h move, plus $NEXUS pinned as the house instrument. Mirrors the landing
// page's ticker (same orderly-proxy feed, same seamless doubled-track scroll) so
// the Lab and landing read as one system.
//
// Why a ticker (not the stacked $NEXUS card): the market/promo chrome was moved
// BELOW the fold on purpose (it used to eat ~43% of the fold as a 415px stack —
// see lab/index.tsx). A ticker brings market presence back to the TOP without
// re-breaking that — it's ONE ~30px line, ambient and glanceable, not a wall.
//
// Colors: 24h change uses pos/neg (green/red) — the ONE documented chroma exception
// for "today's price move" (same treatment as the sibling Mispriced/GAPS board).
// $NEXUS is bone/accent, pinned first. Pauses on hover; honors reduced-motion.
import { useEffect, useRef, useState } from "react";
import { C, MONO } from "@/config/theme";

const PROXY = "https://orderly-proxy.stephenpatrick24.workers.dev";
const NEXUS_TOKEN = "0x3D958634ab725B627919EF8F2Ed59227309fDba3";
const GT_API = `https://api.geckoterminal.com/api/v2/networks/base/tokens/${NEXUS_TOKEN}`;

interface Row {
  symbol: string;
  mark_price?: string | number;
  "24h_open"?: string | number;
  "24h_close"?: string | number;
  "24h_amount"?: string | number;
}

interface Item {
  key: string;
  sym: string;
  price: string;
  chg: number | null; // 24h % — null for $NEXUS (no per-8h source)
  house?: boolean;
}

function chgPct(open?: string | number, close?: string | number): number | null {
  const o = parseFloat(String(open ?? 0));
  const c = parseFloat(String(close ?? 0));
  if (!o || !c) return null;
  const p = ((c - o) / o) * 100;
  return Math.abs(p) > 60 ? null : p; // guard bad ticks
}

function fmtPrice(n: number): string {
  if (!isFinite(n) || n <= 0) return "—";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  // small price — ~3 significant figures, no scientific notation
  const decimals = Math.min(18, Math.max(2, 2 - Math.floor(Math.log10(n))));
  return `$${n.toFixed(decimals)}`;
}

function fmtChg(p: number): string {
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

export function NexusTicker() {
  const [items, setItems] = useState<Item[] | null>(null);
  const nexus = useRef<Item | null>(null);

  useEffect(() => {
    let alive = true;

    // $NEXUS price (client-side — GeckoTerminal 403s datacenter IPs; the browser's
    // real IP + CORS dodges both). Optional: the tape still renders without it.
    fetch(GT_API, { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((j) => {
        const p = Number(j?.data?.attributes?.price_usd);
        if (alive && isFinite(p) && p > 0) {
          nexus.current = { key: "NEXUS", sym: "$NEXUS", price: fmtPrice(p), chg: null, house: true };
        }
      })
      .catch(() => { /* fail soft */ });

    const load = async () => {
      try {
        const r = await fetch(PROXY);
        const j = await r.json();
        const rows: Row[] = j?.data?.rows ?? [];
        if (!alive || !rows.length) return;
        const market: Item[] = rows
          .filter((m) => typeof m.symbol === "string" && m.symbol.startsWith("PERP_"))
          .sort((a, b) => (parseFloat(String(b["24h_amount"] ?? 0)) || 0) - (parseFloat(String(a["24h_amount"] ?? 0)) || 0))
          .slice(0, 18)
          .map((m) => ({
            key: m.symbol,
            sym: m.symbol.replace("PERP_", "").replace("_USDC", ""),
            price: fmtPrice(parseFloat(String(m.mark_price ?? 0))),
            chg: chgPct(m["24h_open"], m["24h_close"]),
          }));
        // $NEXUS pinned first when available.
        setItems(nexus.current ? [nexus.current, ...market] : market);
      } catch { /* fail soft */ }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!items || !items.length) return null;

  // Doubled track → seamless -50% loop. Duration scales with item count so speed
  // stays constant regardless of how many markets are live.
  const durationSec = Math.max(40, items.length * 3.6);
  const track = [...items, ...items];

  const Cell = ({ it, i }: { it: Item; i: number }) => (
    <span
      key={`${it.key}-${i}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 7, padding: "0 16px",
        borderRight: `1px solid ${C.border}`, whiteSpace: "nowrap", fontFamily: MONO, fontSize: 11,
      }}
    >
      <span style={{ color: it.house ? C.accent : C.text.fog, fontWeight: it.house ? 700 : 600, letterSpacing: it.house ? "0.1em" : "0.02em" }}>{it.sym}</span>
      <span style={{ color: C.text.bright }}>{it.price}</span>
      {it.chg != null && (
        <span style={{ color: it.chg >= 0 ? C.pos : C.neg }}>{fmtChg(it.chg)}</span>
      )}
    </span>
  );

  return (
    <div
      className="nx-ticker"
      aria-label="Live market tape"
      style={{
        position: "relative", overflow: "hidden", height: 30, display: "flex", alignItems: "center",
        background: C.inset, borderBottom: `1px solid ${C.border}`,
      }}
    >
      <style>{`
        @keyframes nx-ticker-scroll { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        .nx-ticker-track { display: flex; align-items: center; white-space: nowrap; animation: nx-ticker-scroll ${durationSec}s linear infinite; will-change: transform; }
        .nx-ticker:hover .nx-ticker-track { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) { .nx-ticker-track { animation: none; } }
      `}</style>
      <div className="nx-ticker-track">
        {track.map((it, i) => <Cell key={`${it.key}-${i}`} it={it} i={i} />)}
      </div>
      {/* Edge fades so items enter/leave softly instead of hard-clipping. */}
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 40, background: `linear-gradient(90deg, ${C.inset}, transparent)`, pointerEvents: "none" }} />
      <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 40, background: `linear-gradient(270deg, ${C.inset}, transparent)`, pointerEvents: "none" }} />
    </div>
  );
}

export default NexusTicker;
