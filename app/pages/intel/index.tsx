import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { usePrivateQuery, useAccount } from "@orderly.network/hooks";
import { deployToAgent } from "@/utils/agentPrefill";
import { Sparkline } from "@/pages/lab/components";
import { C } from "@/config/theme";

// ─── Constants ────────────────────────────────────────────────
// Palette is DERIVED from the shared design tokens, never re-typed as hex — that's
// how "#f7525f instead of #f7525f" drift got in here before. Change a colour in
// app/config/theme.ts and this follows automatically.
const REFRESH_INTERVAL = 60; // seconds
// `: string` matters — C is `as const`, so its members are NON-widening literal
// types; without the annotation `let x = YELLOW` locks to "#fbbf24" and any
// reassignment fails to compile.
const TEAL:   string = C.accent; // neutral accent (headers, slight-bullish, bars)
const GREEN:  string = C.pos;    // genuine UP/positive: gainers, +change, bullish, greed
const RED:    string = C.neg;    // loss / down
const YELLOW: string = C.warn;   // CAUTION ONLY — crowding, tension, squeeze risk
// Regime scale reads by TONE, not hue: the label already says bullish/bearish, so only
// the extremes take colour (GREEN/RED) and the middle stays neutral. No blue — that is
// reserved for teaching copy (Coachmark/Telegram) and nothing else.
const DIM:    string = C.text.muted;
const MUTED:  string = C.text.fog;
const BRIGHT: string = C.text.bright;

// ─── Types ────────────────────────────────────────────────────
interface FearGreedData  { value: number; label: string }
interface GlobalData     { btcDom: number; ethDom: number; mcapChange24h: number; totalMcap: number }
interface Mover          { symbol: string; change24h: number; spark: number[] }

interface HLAsset {
  name: string;      // symbol shorthand e.g. "BTC"
  symbol: string;    // full e.g. "PERP_BTC_USDC"
  funding: number;   // 8-hour % already
  oi: number;        // USD
  volume: number;    // 24 h USD
  markPx: number;
  signal: string;
  confidence: number;
}

interface DerivAsset { funding: number; oi: number } // 8-hour %, USD

// ─── API helpers ──────────────────────────────────────────────
async function fetchFearGreed(): Promise<FearGreedData> {
  const r = await fetch("https://api.alternative.me/fng/?limit=1");
  const d = await r.json();
  return { value: parseInt(d.data[0].value), label: d.data[0].value_classification };
}

async function fetchGlobal(): Promise<GlobalData> {
  const r = await fetch("https://api.coingecko.com/api/v3/global");
  const d = await r.json();
  return {
    btcDom:       d.data.market_cap_percentage.btc,
    ethDom:       d.data.market_cap_percentage.eth,
    mcapChange24h: d.data.market_cap_change_percentage_24h_usd,
    totalMcap:    d.data.total_market_cap.usd,
  };
}

async function fetchMovers(): Promise<{ gainers: Mover[]; losers: Mover[] }> {
  const [gRes, lRes] = await Promise.all([
    fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=8&page=1&sparkline=true"),
    fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_asc&per_page=8&page=1&sparkline=true"),
  ]);
  const [gData, lData] = await Promise.all([gRes.json(), lRes.json()]);
  // Stablecoins peg to $1 — they're noise in a movers list ("USDC -0.0%"), so drop them.
  const STABLES = new Set(["USDT", "USDC", "DAI", "USDE", "FDUSD", "TUSD", "BUSD", "USDS", "PYUSD", "USDD", "GUSD", "FRAX", "LUSD"]);
  // CoinGecko's 7d sparkline is hourly (~168 pts); downsample to ~24 for a crisp
  // small line. Fails soft to [] if the field is absent.
  const toSpark = (c: any): number[] => {
    const arr: number[] = Array.isArray(c?.sparkline_in_7d?.price) ? c.sparkline_in_7d.price : [];
    if (arr.length <= 24) return arr;
    const step = Math.ceil(arr.length / 24);
    return arr.filter((_, i) => i % step === 0);
  };
  const toMover = (c: any): Mover => ({ symbol: c.symbol.toUpperCase(), change24h: c.price_change_percentage_24h ?? 0, spark: toSpark(c) });
  const notStable = (c: any) => !STABLES.has(String(c.symbol || "").toUpperCase());
  return {
    gainers: gData.filter((c: any) => c.price_change_percentage_24h > 0 && notStable(c)).slice(0, 6).map(toMover),
    losers:  lData.filter((c: any) => c.price_change_percentage_24h < 0 && notStable(c)).slice(0, 6).map(toMover),
  };
}

async function fetchHyperliquid(): Promise<HLAsset[]> {
  // Uses Orderly Network public futures API — our own liquidity stack
  const r = await fetch("https://api-evm.orderly.org/v1/public/futures");
  const d = await r.json();
  if (!d.success || !d.data?.rows) return [];

  // Pass 1 — raw USD metrics per symbol.
  // 24h_amount is USD notional; 24h_volume is BASE units. The old code divided USD OI
  // by BASE volume → ratio ~markPx too big → EVERY symbol tripped HIGH CONCENTRATION.
  const raw = (d.data.rows as any[]).map((row: any) => {
    const sym     = row.symbol as string;
    const name    = sym.replace("PERP_", "").replace("_USDC", "");
    const markPx  = parseFloat(row.mark_price  || row.index_price || "0");
    const oi      = parseFloat(row.open_interest || "0") * markPx;
    const volBase = parseFloat(row["24h_volume"] || "0");
    const vol24h  = parseFloat(row["24h_amount"] || "0") || volBase * markPx; // USD
    const funding = parseFloat(row.last_funding_rate || row.estimated_funding_rate || "0") * 100;
    const oiVol   = vol24h > 0 ? oi / vol24h : 0; // OI as a multiple of daily USD turnover
    return { name, symbol: sym, funding, oi, volume: vol24h, markPx, oiVol };
  });

  // A concentration signal is only meaningful on a LIVE market — thin/dead symbols
  // (near-zero volume) produce absurd oiVol (100×–900×) that would dominate as junk.
  const MIN_SIGNAL_VOL = 100_000;
  // Confidence = PERCENTILE of oiVol within its signal band, so it spreads across the
  // range instead of every top symbol pinning a single cap value (a flat linear map
  // saturated → looked like a fixed % on every symbol).
  const concVols = raw.filter((a) => a.oiVol > 1.5 && a.volume > MIN_SIGNAL_VOL).map((a) => a.oiVol).sort((x, y) => x - y);
  const elevVols = raw.filter((a) => a.oiVol > 0.9 && a.oiVol <= 1.5 && a.volume > MIN_SIGNAL_VOL).map((a) => a.oiVol).sort((x, y) => x - y);
  const pctRank = (arr: number[], v: number) => arr.length < 2 ? 0.5 : arr.filter((x) => x < v).length / (arr.length - 1);

  return raw
    .map((a) => {
      let signal = "NEUTRAL", confidence = 50;
      if (a.funding > 0.08) {
        signal = "CROWDED LONGS";
        confidence = Math.min(95, 72 + Math.floor(a.funding * 40));
      } else if (a.funding < -0.03) {
        signal = "CROWDED SHORTS";
        confidence = Math.min(95, 72 + Math.floor(Math.abs(a.funding) * 80));
      } else if (a.oiVol > 1.5 && a.volume > MIN_SIGNAL_VOL) {
        signal = "HIGH CONCENTRATION";
        confidence = 64 + Math.round(pctRank(concVols, a.oiVol) * 28); // 64–92, spread
      } else if (a.oiVol > 0.9 && a.volume > MIN_SIGNAL_VOL) {
        signal = "ELEVATED OI";
        confidence = 54 + Math.round(pctRank(elevVols, a.oiVol) * 18); // 54–72, spread
      }
      return { name: a.name, symbol: a.symbol, funding: a.funding, oi: a.oi, volume: a.volume, markPx: a.markPx, signal, confidence };
    })
    .filter((a: HLAsset) => a.oi > 10_000)  // Orderly OI is smaller than HL — lower threshold
    .sort((a: HLAsset, b: HLAsset) => b.oi - a.oi)
    .slice(0, 30);
}

// ─── Regime score ─────────────────────────────────────────────
function computeRegime(
  fg: FearGreedData | null,
  gd: GlobalData | null,
  hl: HLAsset[] | null
): { score: number; label: string; color: string; description: string } {
  const scores: number[] = [], weights: number[] = [];

  if (fg) { scores.push(fg.value);                                                            weights.push(0.35); }
  if (gd) {
    const domScore = gd.btcDom < 45 ? 72 : gd.btcDom < 55 ? 50 : gd.btcDom < 65 ? 35 : 20;
    scores.push(domScore);                                                                     weights.push(0.25);
    const mcScore = Math.min(90, Math.max(10, 50 + gd.mcapChange24h * 3));
    scores.push(mcScore);                                                                      weights.push(0.15);
  }
  if (hl && hl.length > 0) {
    const top = hl.slice(0, 10);
    const avg = top.reduce((s, a) => s + a.funding, 0) / top.length;
    const fScore = avg > 0.08 ? 82 : avg > 0.02 ? 63 : avg > 0 ? 50 : avg > -0.02 ? 36 : 20;
    scores.push(fScore);                                                                       weights.push(0.25);
  }

  if (!scores.length) return { score: 50, label: "LOADING", color: DIM, description: "Fetching live market data…" };

  const tw    = weights.reduce((a, b) => a + b, 0);
  const score = Math.round(scores.reduce((s, v, i) => s + v * weights[i], 0) / tw);

  if (score >= 68) return { score, label: "BULLISH",          color: GREEN,  description: "Risk-on conditions — momentum favors longs. Stay cautious near extremes." };
  if (score >= 54) return { score, label: "SLIGHTLY BULLISH", color: TEAL,   description: "Mild bullish lean — upside bias with limited conviction." };
  if (score >= 46) return { score, label: "NEUTRAL",          color: MUTED,  description: "Mixed signals — no clear directional edge. Size down and wait for clarity." };
  if (score >= 32) return { score, label: "SLIGHTLY BEARISH", color: TEAL,   description: "Mild bearish lean — defensive positioning warranted." };
  return              { score, label: "BEARISH",           color: RED,    description: "Risk-off — longs crowded or sentiment deteriorating sharply." };
}

// ─── Formatters ───────────────────────────────────────────────
const fmtFunding = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(4)}%`;
const fmtOI      = (v: number) => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(0)}M` : `$${v.toFixed(0)}`;
const fmtPct     = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

const lsLabel = (ls: number | null) =>
  ls === null ? "—" : ls > 1.35 ? "LONGS DOM" : ls < 0.75 ? "SHORTS DOM" : "BALANCED";
// Crowding/dominance are DESCRIPTIVE readings, not warnings — the number and the
// label already say what they say. Amber here just made the whole panel shout, so
// these render bone-white (emphasis by TONE) and amber is left for real caution.
const lsColor = (ls: number | null) =>
  ls === null ? DIM : (ls > 1.35 || ls < 0.75) ? TEAL : MUTED;

const signalColor = (sig: string) =>
  sig.includes("LONGS") || sig.includes("SHORTS") || sig.includes("CONCENTRATION") || sig.includes("ELEVATED") ? TEAL : MUTED;

function assetDescription(a: HLAsset): string {
  const ratio = a.volume > 0 ? (a.oi / a.volume).toFixed(1) : "N/A";
  if (a.signal === "CROWDED LONGS")      return `Extreme long crowding — high squeeze risk if price reverses`;
  if (a.signal === "CROWDED SHORTS")     return `Heavy short bias — watch for short squeeze on any rally`;
  if (a.signal === "HIGH CONCENTRATION") return `${ratio}x OI/vol ratio — low liquidity relative to positions`;
  if (a.signal === "ELEVATED OI")        return `${ratio}x OI/vol ratio — positions building vs volume`;
  return `Neutral positioning at ${fmtOI(a.oi)} OI`;
}

// ─── Alert Signal-Card helpers (the deeper pass) ──────────────
// Turn each crowding/OI signal into a graspable card: a severity, a hero metric, and
// a plain-English "what it means + what to do" — congruent with the Mispriced Board.
function alertKind(signal: string): string {
  return signal === "CROWDED LONGS" ? "Crowded longs"
    : signal === "CROWDED SHORTS" ? "Crowded shorts"
    : signal === "HIGH CONCENTRATION" ? "High OI concentration"
    : signal === "ELEVATED OI" ? "Elevated OI vs volume" : "Signal";
}
function alertSeverity(signal: string): { text: string; hot: boolean } {
  if (signal === "CROWDED LONGS" || signal === "CROWDED SHORTS") return { text: "SQUEEZE RISK", hot: true };
  if (signal === "HIGH CONCENTRATION") return { text: "THIN LIQUIDITY", hot: true };
  if (signal === "ELEVATED OI") return { text: "BUILDING", hot: false };
  return { text: "WATCH", hot: false };
}
function alertMetric(a: HLAsset): { n: string; label: string } {
  const ratio = a.volume > 0 ? `${(a.oi / a.volume).toFixed(1)}×` : "—";
  if (a.signal === "CROWDED LONGS" || a.signal === "CROWDED SHORTS") return { n: fmtFunding(a.funding), label: "Funding 8h" };
  return { n: ratio, label: "OI ÷ 24h volume" };
}
function alertRead(a: HLAsset): string {
  const ratio = a.volume > 0 ? (a.oi / a.volume).toFixed(1) : "—";
  if (a.signal === "CROWDED LONGS")      return `Almost everyone is long ${a.name}. If price turns, those longs get forced out fast — a sharp drop. Trail your stops if you're long, or watch for the flush.`;
  if (a.signal === "CROWDED SHORTS")     return `The crowd is short ${a.name}. Any rally can force those shorts to buy back — fuel for a squeeze up. Careful pressing shorts here.`;
  if (a.signal === "HIGH CONCENTRATION") return `Big positions, little trading (${ratio}× open interest vs 24h volume). Moves here can be violent and gappy — size down.`;
  if (a.signal === "ELEVATED OI")        return `Positions are building faster than volume (${ratio}× OI vs 24h volume) — watch for a resolution.`;
  return assetDescription(a);
}

// ─── Sub-components ───────────────────────────────────────────
function BarBlock({ value, total = 100, color = TEAL, len = 18 }: { value: number; total?: number; color?: string; len?: number }) {
  const filled = Math.round(Math.min(1, Math.max(0, value / total)) * len);
  return (
    <span style={{ letterSpacing: "1px" }}>
      <span style={{ color }}     >{"▓".repeat(filled)}</span>
      <span style={{ color: "rgba(255,255,255,0.12)" }}>{"░".repeat(len - filled)}</span>
    </span>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="nx-spotlight" style={{
      background: "#141416",
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: "2px",
      padding: "14px 16px",
      ...style,
    }}>
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: DIM, fontSize: "10px", letterSpacing: "0.12em", marginBottom: "12px", opacity: 0.9 }}>
      {children}
    </div>
  );
}

// ─── Responsive hook ──────────────────────────────────────────
function useIsMobile(bp = 768) {
  const [mob, setMob] = useState(() => typeof window !== "undefined" ? window.innerWidth < bp : false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp - 1}px)`);
    setMob(mq.matches);
    const h = (e: MediaQueryListEvent) => setMob(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [bp]);
  return mob;
}

// A "why?" chip on a mover — opens the Nexus AI copilot and asks it to explain
// the move (explain_move tool → live move + cited headlines). Lives inside the
// mover <a>, so it must swallow the click to avoid also opening the chart link.
function WhyChip({ ticker }: { ticker: string }) {
  return (
    <button
      type="button"
      title={`Ask Nexus AI why ${ticker} is moving`}
      onClick={(e) => {
        e.preventDefault(); e.stopPropagation();
        window.dispatchEvent(new CustomEvent("nexus:assistant-ask", {
          detail: { prompt: `Why is ${ticker} moving right now? Use explain_move and cite the headlines.` },
        }));
      }}
      style={{
        flexShrink: 0, background: "transparent", border: "1px solid rgba(255,255,255,0.14)",
        color: MUTED, fontSize: "9px", letterSpacing: "0.05em", padding: "1px 5px",
        borderRadius: 4, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.4,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "#ededf0"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.35)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = MUTED; e.currentTarget.style.borderColor = "rgba(255,255,255,0.14)"; }}
    >
      why?
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────
export default function IntelPage({ embedded = false }: { embedded?: boolean }) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  const [fearGreed,  setFearGreed]  = useState<FearGreedData | null>(null);
  const [globalData, setGlobalData] = useState<GlobalData    | null>(null);
  const [movers,     setMovers]     = useState<{ gainers: Mover[]; losers: Mover[] } | null>(null);
  const [hlAssets,   setHlAssets]   = useState<HLAsset[]     | null>(null);
  const [lsRatios,   setLsRatios]   = useState<Record<string, number | null>>({});
  const [loading,    setLoading]    = useState(true);
  const [countdown,  setCountdown]  = useState(REFRESH_INTERVAL);
  const [timestamp,  setTimestamp]  = useState("");
  const [contexts,   setContexts]   = useState<Record<string, any>>({});

  // Funding/OI percentile-vs-history (Brighter-Data-style context) for the majors.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, any> = {};
      await Promise.all(["BTC", "ETH", "SOL"].map(async (sym) => {
        try {
          const r = await fetch(`https://og.nexustradinglabs.com/signals/context/PERP_${sym}_USDC`);
          if (r.ok) out[sym] = await r.json();
        } catch { /* fail-soft */ }
      }));
      if (!cancelled) setContexts(out);
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Live positions from Orderly (wallet must be connected) ──
  const { state: accountState } = useAccount();
  const { data: posData } = usePrivateQuery("/v1/positions", { revalidateOnFocus: false }) as { data: { rows?: any[] } | null };
  const openPositions: any[] = (posData as any)?.rows ?? [];

  const longNotional  = openPositions.filter(p => p.position_qty > 0).reduce((s: number, p: any) => s + Math.abs(p.position_value ?? p.position_qty * (p.mark_price ?? 0)), 0);
  const shortNotional = openPositions.filter(p => p.position_qty < 0).reduce((s: number, p: any) => s + Math.abs(p.position_value ?? p.position_qty * (p.mark_price ?? 0)), 0);
  const totalNotional = longNotional + shortNotional;
  const portfolioLongPct: number | null = totalNotional > 0 ? Math.round((longNotional / totalNotional) * 100) : null;

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [fg, gd, mv, hl] = await Promise.allSettled([
        fetchFearGreed(),
        fetchGlobal(),
        fetchMovers(),
        fetchHyperliquid(),
      ]);
      if (fg.status === "fulfilled") setFearGreed(fg.value);
      if (gd.status === "fulfilled") setGlobalData(gd.value);
      if (mv.status === "fulfilled") setMovers(mv.value);
      if (hl.status === "fulfilled") setHlAssets(hl.value);

      // Real long/short ACCOUNT ratio via our OKX proxy (Binance 451s from most
      // regions incl. the US; OKX is open + not geo-fenced). Funding/OI already come
      // from Orderly (getDerivData), so we no longer need Binance for those either.
      try {
        const r = await fetch("https://og.nexustradinglabs.com/proxy/ls?symbols=BTC,ETH,SOL");
        if (r.ok) {
          const d = await r.json();
          setLsRatios(d?.ls ?? {});
        }
      } catch { /* fail-soft — L/S renders "—" */ }

      setTimestamp(new Date().toLocaleTimeString());
      setCountdown(REFRESH_INTERVAL);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    const iv = setInterval(fetchAll, REFRESH_INTERVAL * 1000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  useEffect(() => {
    const t = setInterval(() => setCountdown(p => (p > 0 ? p - 1 : REFRESH_INTERVAL)), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Derived data ────────────────────────────────────────────
  const regime = computeRegime(fearGreed, globalData, hlAssets);

  const getDerivData = (sym: string): DerivAsset | null => {
    const a = hlAssets?.find(h => h.name === sym);
    return a ? { funding: a.funding, oi: a.oi } : null;
  };

  const btcD = getDerivData("BTC"), ethD = getDerivData("ETH"), solD = getDerivData("SOL");

  const signals = (hlAssets ?? [])
    .filter(a => a.signal !== "NEUTRAL")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);

  const topPositions = (hlAssets ?? []).slice(0, 12);

  const longBiased = (hlAssets ?? []).filter(a => a.funding > 0);
  const netLongPct = hlAssets?.length
    ? Math.round((longBiased.length / hlAssets.length) * 100)
    : null;

  const avgFunding10 = hlAssets?.length
    ? hlAssets.slice(0, 10).reduce((s, a) => s + a.funding, 0) / 10
    : null;

  const alsoActive = (hlAssets ?? [])
    .filter(a => !["BTC","ETH","SOL"].includes(a.name) && Math.abs(a.funding) > 0.015)
    .sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))
    .slice(0, 5);

  // ── Styles ──────────────────────────────────────────────────
  const page: React.CSSProperties = {
    background: embedded ? "transparent" : "#0f0f11",
    minHeight: embedded ? undefined : "100svh",
    padding: embedded ? (isMobile ? "8px 0" : "4px 0") : (isMobile ? "12px" : "16px 20px"),
    fontFamily: "'Courier New', Courier, monospace",
    color: BRIGHT,
    fontSize: "13px",
    boxSizing: "border-box",
  };

  const grid3: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: isMobile ? "1fr" : "1.1fr 0.9fr",
    gap: "10px",
    marginBottom: "10px",
  };

  // ── Render helpers ───────────────────────────────────────────
  const renderDeriv = (sym: string, data: DerivAsset | null, ls: number | null) => {
    const fc = !data ? DIM : data.funding > 0.02 ? GREEN : data.funding < 0 ? RED : MUTED;
    const sig = !data ? "—" : data.funding > 0.06 ? "[LONGS]" : data.funding < -0.02 ? "[SHORTS]" : "[NEUTRAL]";
    const sigC = !data ? DIM : data.funding > 0.06 ? GREEN : data.funding < -0.02 ? RED : MUTED;
    return (
      <div key={sym} style={{ marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
          <span style={{ color: BRIGHT, fontWeight: 700, width: "40px" }}>{sym}</span>
          <span style={{ color: sigC, fontSize: "11px" }}>{sig}</span>
          <button onClick={() => deployToAgent({ symbols: [`PERP_${sym}_USDC`] }, `the ${sym} funding read`, undefined, navigate)}
            title={`Set the trading agent to watch ${sym} — the same funding/OI edge it trades on`}
            style={{ marginLeft: "auto", background: "none", border: "1px solid #33333a", color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: "9px", letterSpacing: "0.05em", padding: "3px 8px", borderRadius: "3px", cursor: "pointer" }}>
            ⚡ AGENT
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", rowGap: "2px", columnGap: "8px", fontSize: "12px" }}>
          <div>
            <span style={{ color: DIM }}>FUNDING 8H  </span><span style={{ color: fc }}>{data ? fmtFunding(data.funding) : "—"}</span>
            {/* Funding percentile-vs-history lives in the "FUNDING vs ITS OWN HISTORY"
                gauges above — de-duped from this dense row. */}
          </div>
          <div><span style={{ color: DIM }}>OI  </span><span style={{ color: MUTED }}>{data ? fmtOI(data.oi) : "—"}</span></div>
          <div><span style={{ color: DIM }}>L/S  </span><span style={{ color: lsColor(ls) }}>{ls !== null ? ls.toFixed(2) : "—"}</span></div>
          <div><span style={{ color: lsColor(ls), fontSize: "11px" }}>{lsLabel(ls)}</span></div>
        </div>
      </div>
    );
  };

  // ── JSX ─────────────────────────────────────────────────────
  return (
    <div className="nx-stagger" style={page}>

      {/* ── Header ─────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px", flexWrap: "wrap", gap: "6px" }}>
        <div>
          <span style={{ color: TEAL }}>// </span>
          <span style={{ color: BRIGHT, fontWeight: 700, letterSpacing: "0.08em", fontSize: "13px" }}>
            NEXUS INTEL — MARKET TERMINAL
          </span>
        </div>
        <div style={{ color: DIM, fontSize: "11px", display: "flex", alignItems: "center", gap: "8px" }}>
          {timestamp && <span>LAST: {timestamp}</span>}
          <span>AUTO-REFRESH: {REFRESH_INTERVAL}s</span>
          {loading
            ? <span style={{ color: TEAL }}>⟳ UPDATING</span>
            : <span style={{ color: DIM }}>{countdown}s</span>
          }
        </div>
      </div>

      {/* ── How to read this — plain-language, once, for everyone ──────────── */}
      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", marginBottom: "10px", padding: "10px 12px", border: "1px solid rgba(255,255,255,0.06)", borderLeft: `2px solid ${MUTED}`, borderRadius: "6px", background: "rgba(255,255,255,0.02)" }}>
        <span style={{ color: MUTED, fontSize: "12px", flexShrink: 0 }}>?</span>
        <span style={{ color: DIM, fontSize: "12px", lineHeight: 1.5, fontFamily: "var(--nx-font-ui, sans-serif)" }}>
          <b style={{ color: BRIGHT }}>How to read this:</b> the read up top says whether the whole market is leaning risk-on or
          risk-off, and why. Below it, the alerts worth acting on — where the crowd is stretched or positions are concentrated.
          Green/red is direction, not a buy/sell.
        </span>
      </div>

      {/* ── The Market Read (regime) ─────────────────────────── */}
      <Card style={{ marginBottom: "10px" }}>
        <SectionTitle>// THE MARKET READ</SectionTitle>

        <div style={{ marginBottom: "6px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
            <span style={{ color: DIM, fontSize: "12px" }}>← BEARISH</span>
            <span style={{ color: regime.color, fontWeight: 700, fontSize: "22px", letterSpacing: "0.04em" }}>
              {regime.label}
            </span>
            <span style={{ color: DIM, fontSize: "11px" }}>[{regime.score}]</span>
            <span style={{ color: DIM, fontSize: "12px" }}>BULLISH →</span>
          </div>
          <div style={{ marginBottom: "6px" }}>
            <BarBlock value={regime.score} total={100} color={regime.color} len={28} />
          </div>
          {/* Plain translation — what the tape means for the trade you're about to take. */}
          <div style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: "13px", lineHeight: 1.55, color: DIM, padding: "9px 11px", background: "rgba(237,237,240,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "6px" }}>
            <b style={{ color: BRIGHT }}>{regime.score >= 54 ? "Risk-on tape — the wind is behind longs." : regime.score <= 46 ? "Risk-off tape — longs are swimming upstream." : "Mixed tape — no clear edge either way."}</b>{" "}
            {regime.description}
          </div>
        </div>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "10px" }}>
          <div style={{ color: DIM, fontSize: "10px", letterSpacing: "0.1em", marginBottom: "8px" }}>// FACTOR BREAKDOWN</div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3, 1fr)", gap: "12px" }}>

            {/* Fear / Greed */}
            <div>
              <div style={{ color: DIM, fontSize: "10px", marginBottom: "3px" }}>FEAR / GREED</div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ color: fearGreed ? fearGreed.value > 60 ? GREEN : fearGreed.value < 40 ? RED : MUTED : DIM, fontWeight: 600, fontSize: "13px" }}>
                  {fearGreed ? fearGreed.label.toUpperCase() : "—"}
                </span>
                {fearGreed && <span style={{ color: DIM, fontSize: "11px" }}>[{fearGreed.value}]</span>}
              </div>
              {fearGreed && (
                <div style={{ marginTop: "3px" }}>
                  <BarBlock value={fearGreed.value} total={100} color={fearGreed.value > 60 ? GREEN : fearGreed.value < 40 ? RED : MUTED} len={14} />
                </div>
              )}
            </div>

            {/* BTC Dom */}
            <div>
              <div style={{ color: DIM, fontSize: "10px", marginBottom: "3px" }}>BTC DOM</div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ color: BRIGHT, fontWeight: 600, fontSize: "13px" }}>
                  {globalData ? `${globalData.btcDom.toFixed(1)}%` : "—"}
                </span>
                {globalData && (
                  <span style={{ color: globalData.btcDom > 60 ? RED : globalData.btcDom < 50 ? GREEN : MUTED, fontSize: "10px" }}>
                    {globalData.btcDom > 60 ? "↑ MAJOR DOM" : globalData.btcDom < 50 ? "↓ ALTSEASON" : "MODERATE"}
                  </span>
                )}
              </div>
              {globalData && (
                <div style={{ marginTop: "3px" }}>
                  <BarBlock value={globalData.btcDom} total={100} color={TEAL} len={14} />
                </div>
              )}
            </div>

            {/* Market Cap */}
            <div>
              <div style={{ color: DIM, fontSize: "10px", marginBottom: "3px" }}>TOTAL MCAP 24H</div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ color: globalData ? globalData.mcapChange24h > 0 ? GREEN : globalData.mcapChange24h < 0 ? RED : MUTED : DIM, fontWeight: 600, fontSize: "13px" }}>
                  {globalData ? fmtPct(globalData.mcapChange24h) : "—"}
                </span>
              </div>
              <div style={{ color: DIM, fontSize: "11px", marginTop: "2px" }}>
                {globalData ? `$${(globalData.totalMcap / 1e12).toFixed(2)}T total` : "—"}
              </div>
            </div>

          </div>
        </div>
      </Card>

      {/* ── ALERTS — the crowding/OI signals as Signal Cards ──────────────── */}
      {signals.length > 0 && (
        <div style={{ marginBottom: "10px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px", margin: "2px 0 10px" }}>
            <span style={{ color: BRIGHT, fontFamily: "var(--nx-font-mono)", fontSize: "12px", fontWeight: 700, letterSpacing: "0.12em" }}>◆ ALERTS — WORTH A LOOK</span>
            <span style={{ color: DIM, fontFamily: "var(--nx-font-mono)", fontSize: "10px" }}>{signals.length}</span>
            <span style={{ flex: 1, height: 1, background: C.border }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)", gap: "12px" }}>
            {signals.map(a => {
              const sev = alertMetric(a), sv = alertSeverity(a.signal);
              return (
                <div key={a.name} className="nx-card-interactive" onClick={() => navigate(`/perp/${a.symbol}`)} title={`Open ${a.name}`}
                  style={{ position: "relative", border: `1px solid ${C.border}`, borderLeft: `2px solid ${sv.hot ? YELLOW : C.borderStrong}`, borderRadius: "8px", padding: "14px", background: `linear-gradient(180deg, ${C.surface}, ${C.surfaceAlt})`, cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                    <span style={{ color: BRIGHT, fontFamily: "var(--nx-font-mono)", fontWeight: 700, fontSize: "14px" }}>{a.name}</span>
                    <span style={{ color: DIM, fontFamily: "var(--nx-font-mono)", fontSize: "8.5px", letterSpacing: "0.08em", textTransform: "uppercase" }}>{alertKind(a.signal)}</span>
                    <span style={{ marginLeft: "auto", color: sv.hot ? YELLOW : DIM, fontFamily: "var(--nx-font-mono)", fontSize: "8.5px", fontWeight: 700, letterSpacing: "0.08em" }}>{sv.text}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: "8px" }}>
                    <div>
                      <div style={{ color: DIM, fontFamily: "var(--nx-font-mono)", fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: "3px" }}>{sev.label}</div>
                      <div style={{ color: BRIGHT, fontFamily: "var(--nx-font-mono)", fontSize: "26px", fontWeight: 600, lineHeight: 0.9 }}>{sev.n}</div>
                    </div>
                    <span style={{ marginLeft: "auto", color: DIM, fontFamily: "var(--nx-font-mono)", fontSize: "10px" }}>OI {fmtOI(a.oi)}</span>
                  </div>
                  <p style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: "12.5px", lineHeight: 1.5, color: MUTED, margin: "12px 0 0", padding: "9px 11px", background: "rgba(237,237,240,0.03)", border: `1px solid ${C.border}`, borderRadius: "6px" }}>
                    {alertRead(a)}
                  </p>
                  <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                    <button onClick={(e) => { e.stopPropagation(); navigate(`/perp/${a.symbol}`); }}
                      style={{ flex: 1, background: "none", border: `1px solid ${C.borderStrong}`, color: C.accent, fontFamily: "var(--nx-font-mono)", fontSize: "9.5px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "8px", borderRadius: "6px", cursor: "pointer" }}>→ Open {a.name}</button>
                    <button onClick={(e) => { e.stopPropagation(); deployToAgent({ symbols: [a.symbol] }, `the ${a.name} ${alertKind(a.signal).toLowerCase()} alert`, undefined, navigate); }}
                      title={`Set the agent to watch ${a.name}`}
                      style={{ background: "none", border: `1px solid ${C.border}`, color: MUTED, fontFamily: "var(--nx-font-mono)", fontSize: "9.5px", letterSpacing: "0.05em", padding: "8px 10px", borderRadius: "6px", cursor: "pointer" }}>⚡ Agent</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Funding vs its own history — percentile gauges for the majors ──── */}
      {(() => {
        const majors = (["BTC", "ETH", "SOL"] as const)
          .map((sym) => ({ sym, f: contexts[sym]?.funding, data: getDerivData(sym) }))
          .filter((m) => m.f && m.f.pct != null);
        if (!majors.length) return null;
        return (
          <div style={{ marginBottom: "10px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "10px", margin: "2px 0 10px" }}>
              <span style={{ color: DIM, fontFamily: "var(--nx-font-mono)", fontSize: "11px", fontWeight: 700, letterSpacing: "0.12em" }}>FUNDING vs ITS OWN HISTORY</span>
              <span style={{ color: C.text.faint, fontFamily: "var(--nx-font-mono)", fontSize: "10px" }}>the majors</span>
              <span style={{ flex: 1, height: 1, background: C.border }} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: "12px" }}>
              {majors.map(({ sym, f, data }) => {
                const pct = Math.max(0, Math.min(100, f.pct));
                const stretched = f.pct >= 85 || f.pct <= 15;
                const cap = f.pct >= 85 ? "unusually high — the crowd is stretched long"
                  : f.pct <= 15 ? "unusually low — stretched short"
                  : "normal — nothing stretched here";
                return (
                  <div key={sym} style={{ border: `1px solid ${C.border}`, borderRadius: "10px", padding: "14px", background: C.surfaceAlt }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ color: BRIGHT, fontFamily: "var(--nx-font-mono)", fontSize: "13px", fontWeight: 700 }}>{sym}</span>
                      <span style={{ color: MUTED, fontFamily: "var(--nx-font-mono)", fontSize: "10px" }}>{data ? `${fmtFunding(data.funding)}/8h` : "—"}</span>
                    </div>
                    <div style={{ position: "relative", height: "6px", borderRadius: "4px", background: C.inset, border: `1px solid ${C.border}`, margin: "11px 0 8px" }}>
                      <div style={{ position: "absolute", top: "-1px", bottom: "-1px", width: "2px", background: stretched ? YELLOW : C.accent, left: `${pct}%` }} />
                    </div>
                    <div style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: "11.5px", lineHeight: 1.45, color: MUTED }}>
                      <b style={{ color: stretched ? YELLOW : BRIGHT }}>{f.pct}th percentile</b> — {cap}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Portfolio Context ──────────────────────────────────── */}
      {portfolioLongPct !== null && accountState?.status === "SignedIn" && (() => {
        const netLong   = portfolioLongPct;
        const netShort  = 100 - netLong;
        const regScore  = regime.score;
        // Tension: regime direction vs your net exposure
        const regimeBullish = regScore >= 54;
        const regimeBearish = regScore <= 46;
        const youLong  = netLong >= 60;
        const youShort = netLong <= 40;
        const crowdedLong  = signals.some(s => s.signal === "CROWDED LONGS");
        const crowdedShort = signals.some(s => s.signal === "CROWDED SHORTS");

        let tensionColor = YELLOW;
        let tensionLabel = "ALIGNED";
        let tensionMsg   = "Your exposure aligns with the current market regime. Stay disciplined.";

        if (regimeBearish && youLong) {
          tensionColor = RED;
          tensionLabel = "RISK — TAPE BEARISH, YOU ARE LONG";
          tensionMsg   = `Regime score ${regScore} signals bearish conditions. Your portfolio is ${netLong}% long. Tighten stops or reduce exposure.`;
        } else if (regimeBullish && youShort) {
          tensionColor = RED;
          tensionLabel = "RISK — TAPE BULLISH, YOU ARE SHORT";
          tensionMsg   = `Regime score ${regScore} signals bullish conditions. Your portfolio is ${netShort}% short. Watch for forced unwind.`;
        } else if (crowdedLong && youLong && netLong >= 65) {
          tensionColor = YELLOW;
          tensionLabel = "CAUTION — CROWDED SIDE";
          tensionMsg   = `You are ${netLong}% long and the market signal shows crowded longs. Squeeze risk elevated if price reverses.`;
        } else if (crowdedShort && youShort && netLong <= 35) {
          tensionColor = YELLOW;
          tensionLabel = "CAUTION — CROWDED SIDE";
          tensionMsg   = `You are ${netShort}% short and the market signal shows crowded shorts. Upside unwind risk if price rips.`;
        } else if (regimeBullish && youLong) {
          tensionColor = GREEN;
          tensionLabel = "ALIGNED — TAPE CONFIRMS LONG BIAS";
          tensionMsg   = `Regime score ${regScore} supports bullish positioning. Your ${netLong}% long exposure is with the trend.`;
        } else if (regimeBearish && youShort) {
          tensionColor = GREEN;
          tensionLabel = "ALIGNED — TAPE CONFIRMS SHORT BIAS";
          tensionMsg   = `Regime score ${regScore} supports bearish positioning. Your ${netShort}% short exposure is with the trend.`;
        }

        const longBarPct = Math.round(netLong);
        return (
          <Card style={{ marginBottom: "10px", border: `1px solid ${tensionColor === RED ? "rgba(247,82,95,0.25)" : tensionColor === GREEN ? "rgba(62,207,142,0.18)" : "rgba(251,191,36,0.15)"}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <SectionTitle style={{ marginBottom: 0 }}>// YOUR POSITION CONTEXT</SectionTitle>
              <span style={{ color: tensionColor, fontSize: "10px", letterSpacing: "0.07em", fontWeight: 700 }}>{tensionLabel}</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "16px", marginBottom: "12px" }}>
              {/* Net exposure bar */}
              <div>
                <div style={{ color: DIM, fontSize: "10px", marginBottom: "4px", letterSpacing: "0.06em" }}>NET EXPOSURE</div>
                <div style={{ display: "flex", height: "8px", borderRadius: "2px", overflow: "hidden", gap: "1px", marginBottom: "4px" }}>
                  <div style={{ flex: longBarPct, background: GREEN, opacity: 0.8 }} />
                  <div style={{ flex: 100 - longBarPct, background: RED, opacity: 0.8 }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                  <span style={{ color: GREEN }}>LONG {netLong}%</span>
                  <span style={{ color: RED }}>SHORT {netShort}%</span>
                </div>
              </div>

              {/* Position summary */}
              <div>
                <div style={{ color: DIM, fontSize: "10px", marginBottom: "4px", letterSpacing: "0.06em" }}>OPEN POSITIONS ({openPositions.length})</div>
                <div style={{ fontSize: "12px", color: MUTED, lineHeight: 1.6 }}>
                  {openPositions.length === 0
                    ? <span style={{ color: DIM }}>No open positions</span>
                    : openPositions.slice(0, 4).map((p: any) => {
                        const sym  = (p.symbol as string).replace("PERP_","").replace("_USDC","");
                        const dir  = p.position_qty > 0 ? "LONG" : "SHORT";
                        const pnl  = p.unsettled_pnl ?? 0;
                        const pnlC = pnl >= 0 ? GREEN : RED;
                        return (
                          <div key={p.symbol} style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                            <span style={{ color: BRIGHT }}>{sym}</span>
                            <span style={{ color: dir === "LONG" ? GREEN : RED, fontSize: "10px" }}>{dir}</span>
                            <span style={{ color: pnlC, marginLeft: "auto" }}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} USDC</span>
                          </div>
                        );
                      })
                  }
                </div>
              </div>
            </div>

            {/* Tension message */}
            <div style={{ padding: "8px 10px", background: "rgba(255,255,255,0.02)", borderLeft: `2px solid ${tensionColor}`, fontSize: "12px", color: MUTED, lineHeight: 1.5 }}>
              {tensionMsg}
            </div>
          </Card>
        );
      })()}

            {/* ── Main 3-col grid ─────────────────────────────────── */}
      <div style={grid3}>

        {/* ── Derivatives Intelligence ──────────────────────── */}
        <Card>
          <SectionTitle>// DERIVATIVES INTELLIGENCE — ORDERLY NETWORK</SectionTitle>

          {renderDeriv("BTC", btcD, lsRatios["BTC"] ?? null)}
          {renderDeriv("ETH", ethD, lsRatios["ETH"] ?? null)}
          {renderDeriv("SOL", solD, lsRatios["SOL"] ?? null)}

          {alsoActive.length > 0 && (
            <div style={{ marginTop: "6px" }}>
              <div style={{ color: DIM, fontSize: "10px", letterSpacing: "0.1em", marginBottom: "6px" }}>// ALSO ACTIVE (HL)</div>
              {alsoActive.map(a => (
                <div key={a.name} style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px", fontSize: "12px" }}>
                  <span style={{ color: MUTED }}>{a.name}</span>
                  <span style={{ color: a.funding >= 0 ? GREEN : RED }}>{fmtFunding(a.funding)}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ color: DIM, fontSize: "10px", marginTop: "12px", letterSpacing: "0.05em" }}>
            // VIA OKX · ORDERLY NETWORK
          </div>
        </Card>

        {/* ── Movers 24H ────────────────────────────────────── */}
        <Card>
          <SectionTitle>// MOVERS 24H</SectionTitle>

          <div style={{ marginBottom: "12px" }}>
            <div style={{ color: GREEN, fontSize: "10px", letterSpacing: "0.08em", marginBottom: "6px" }}>▲ GAINERS</div>
            {movers?.gainers.map(g => (
              <a
                key={g.symbol}
                href={`https://www.tradingview.com/chart/?symbol=${g.symbol}USDT`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "flex", justifyContent: "space-between", padding: "2px 4px", textDecoration: "none", cursor: "pointer" }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ color: MUTED, fontSize: "12px", flexShrink: 0 }}>{g.symbol}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <WhyChip ticker={g.symbol} />
                  <Sparkline points={g.spark} color="#3ecf8e" />
                  <span style={{ color: GREEN, fontSize: "12px", fontWeight: 600, width: 52, textAlign: "right" }}>+{g.change24h.toFixed(1)}%</span>
                </span>
              </a>
            )) ?? <div style={{ color: DIM, fontSize: "12px" }}>Loading…</div>}
          </div>

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "10px" }}>
            <div style={{ color: RED, fontSize: "10px", letterSpacing: "0.08em", marginBottom: "6px" }}>▼ LOSERS</div>
            {movers?.losers.map(l => (
              <a
                key={l.symbol}
                href={`https://www.tradingview.com/chart/?symbol=${l.symbol}USDT`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "flex", justifyContent: "space-between", padding: "2px 4px", textDecoration: "none", cursor: "pointer" }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ color: MUTED, fontSize: "12px", flexShrink: 0 }}>{l.symbol}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <WhyChip ticker={l.symbol} />
                  <Sparkline points={l.spark} color="#f7525f" />
                  <span style={{ color: RED, fontSize: "12px", fontWeight: 600, width: 52, textAlign: "right" }}>{l.change24h.toFixed(1)}%</span>
                </span>
              </a>
            )) ?? <div style={{ color: DIM, fontSize: "12px" }}>Loading…</div>}
          </div>

          <div style={{ color: DIM, fontSize: "10px", marginTop: "12px", letterSpacing: "0.05em" }}>
            // VIA COINGECKO
          </div>
        </Card>

        {/* Live Signals were promoted to the full-width ◆ ALERTS cards above. */}

      </div>

      {/* ── Liquidations 24H ─────────────────────── */}
      <Card style={{ marginBottom: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <SectionTitle style={{ marginBottom: 0 }}>// LIQUIDATIONS 24H</SectionTitle>
          <span style={{ color: DIM, fontSize: "10px" }}>VIA OKX + ORDERLY OI</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: "10px" }}>
          {(["BTC", "ETH", "SOL"] as const).map(sym => {
            const ls = lsRatios[sym] ?? null;
            const status = ls === null ? "—" : ls > 1.35 ? "LONG FLUSH" : ls < 0.75 ? "SHORT SQUEEZE" : "BALANCED";
            const sc = lsColor(ls); // shared helper — was an inline copy that drifted
            const d = getDerivData(sym);
            const oi = d?.oi ?? 0;
            // Estimate liq exposure from OI × typical daily liq rate
            const longPct  = ls !== null ? Math.min(0.9, ls / (ls + 1)) : 0.5;
            const shortPct = 1 - longPct;
            const liqRate  = status === "LONG FLUSH" ? 0.018 : status === "SHORT SQUEEZE" ? 0.016 : 0.006;
            const totalLiq = oi * liqRate;
            const longLiq  = totalLiq * (status === "LONG FLUSH" ? 0.75 : status === "SHORT SQUEEZE" ? 0.25 : 0.5);
            const shortLiq = totalLiq - longLiq;
            const fmtLiq   = (v: number) => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(0)}M` : `$${v.toFixed(0)}`;
            const lsBar = ls !== null ? Math.round(Math.min(longPct, 0.9) * 14) : 7;
            return (
              <div key={sym} style={{ padding: "10px 12px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <span style={{ color: BRIGHT, fontWeight: 700, fontSize: "13px" }}>{sym}</span>
                  <span style={{ color: sc, fontSize: "10px", letterSpacing: "0.06em" }}>{status}</span>
                </div>
                <div style={{ marginBottom: "5px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "2px" }}>
                    <span style={{ color: DIM }}>LONGS</span>
                    <span style={{ color: BRIGHT }}>{oi > 0 ? fmtLiq(longLiq) : "—"}</span>
                  </div>
                  <div style={{ height: "3px", background: "rgba(255,255,255,0.06)", borderRadius: "1px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round(longPct * 100)}%`, background: MUTED, opacity: 0.8 }} />
                  </div>
                </div>
                <div style={{ marginBottom: "6px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "2px" }}>
                    <span style={{ color: DIM }}>SHORTS</span>
                    <span style={{ color: BRIGHT }}>{oi > 0 ? fmtLiq(shortLiq) : "—"}</span>
                  </div>
                  <div style={{ height: "3px", background: "rgba(255,255,255,0.06)", borderRadius: "1px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round(shortPct * 100)}%`, background: MUTED, opacity: 0.8 }} />
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: DIM, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: "5px" }}>
                  <span>L/S {ls !== null ? ls.toFixed(2) : "—"}</span>
                  <span style={{ color: MUTED }}>EST. {oi > 0 ? fmtLiq(totalLiq) : "—"} LIQ</span>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ color: DIM, fontSize: "10px", marginTop: "8px", letterSpacing: "0.05em" }}>
          // EST. = ESTIMATED FROM OI × TYPICAL DAILY LIQ RATE · L/S FROM OKX ACCOUNT RATIO
        </div>
      </Card>

            {/* ── Long/Short Positioning ──────────────────────────────── */}
      <Card style={{ marginBottom: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <SectionTitle style={{ marginBottom: 0 }}>// LONG / SHORT POSITIONING</SectionTitle>
          <span style={{ color: DIM, fontSize: "10px" }}>VIA OKX ACCOUNT RATIO</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: "10px" }}>
          {(["BTC", "ETH", "SOL"] as const).map(sym => {
            const ls = lsRatios[sym] ?? null;
            const status = ls === null ? "LOADING" : ls > 1.35 ? "LONG FLUSH" : ls < 0.75 ? "SHORT SQUEEZE" : "BALANCED";
            const sc = lsColor(ls); // shared helper — was an inline copy that drifted
            const longPct  = ls !== null ? Math.min(0.92, ls / (ls + 1)) : 0.5;
            const shortPct = 1 - longPct;
            const desc =
              status === "LONG FLUSH"    ? "Longs dominant — elevated squeeze risk on reversal" :
              status === "SHORT SQUEEZE" ? "Shorts dominant — watch for violent upside unwind"  :
              status === "BALANCED"      ? "Positioning balanced — no clear crowding signal"    : "Fetching ratio…";
            return (
              <div key={sym} style={{ padding: "10px 12px", background: "rgba(255,255,255,0.02)", border: `1px solid ${ls === null ? "rgba(255,255,255,0.05)" : (ls > 1.35 || ls < 0.75) ? "rgba(251,191,36,0.18)" : "rgba(255,255,255,0.06)"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                  <span style={{ color: BRIGHT, fontWeight: 700, fontSize: "14px" }}>{sym}</span>
                  <span style={{ color: sc, fontSize: "10px", letterSpacing: "0.07em", fontWeight: 700 }}>{status}</span>
                </div>

                {/* L/S bar */}
                <div style={{ marginBottom: "8px" }}>
                  <div style={{ display: "flex", height: "6px", borderRadius: "2px", overflow: "hidden", gap: "1px" }}>
                    <div style={{ flex: longPct, background: "#d4d4d8", opacity: ls !== null ? 0.7 : 0.2 }} />
                    <div style={{ flex: shortPct, background: "#52525b", opacity: ls !== null ? 0.9 : 0.2 }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "3px", fontSize: "10px" }}>
                    <span style={{ color: "#d4d4d8" }}>L {Math.round(longPct * 100)}%</span>
                    <span style={{ color: "#71717a" }}>S {Math.round(shortPct * 100)}%</span>
                  </div>
                </div>

                <div style={{ fontSize: "11px", color: DIM, lineHeight: 1.4 }}>{desc}</div>
                <div style={{ marginTop: "6px", fontSize: "10px", color: MUTED }}>
                  L/S RATIO: <span style={{ color: sc }}>{ls !== null ? ls.toFixed(3) : "—"}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ color: DIM, fontSize: "10px", marginTop: "8px" }}>
          // LONG FLUSH = longs crowded, squeeze risk. SHORT SQUEEZE = shorts crowded, unwind risk. BALANCED = no dominant bias.
        </div>
      </Card>

            {/* ── Position Intelligence ───────────────────────────── */}
      <Card style={{ marginBottom: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px", flexWrap: "wrap", gap: "4px" }}>
          <SectionTitle style={{ marginBottom: 0 }}>// POSITION INTELLIGENCE</SectionTitle>
          <span style={{ color: DIM, fontSize: "10px" }}>ORDERLY NETWORK · {timestamp || "—"}</span>
        </div>

        {/* Summary bar */}
        {netLongPct !== null && (
          <div style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "24px",
            marginBottom: "12px",
            padding: "8px 12px",
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.06)",
          }}>
            <div>
              <div style={{ color: DIM, fontSize: "10px", marginBottom: "2px" }}>MARKET</div>
              <div style={{ color: DIM, fontSize: "10px", marginBottom: "2px" }}>NET POSITIONING</div>
              <div style={{ color: netLongPct > 60 ? GREEN : netLongPct < 40 ? RED : MUTED, fontWeight: 700, fontSize: "18px" }}>
                {netLongPct}% LONG
              </div>
              <div style={{ color: DIM, fontSize: "11px" }}>
                {netLongPct > 60 ? "Market net long" : netLongPct < 40 ? "Market net short" : "Market balanced"} with {netLongPct}% of OI in long-biased assets
              </div>
            </div>
            <div>
              <div style={{ color: DIM, fontSize: "10px", marginBottom: "2px" }}>CONFIDENCE</div>
              <div style={{ color: MUTED, fontWeight: 700, fontSize: "18px" }}>
                {Math.abs(netLongPct - 50) > 20 ? "HIGH" : Math.abs(netLongPct - 50) > 10 ? "MODERATE" : "LOW"}
              </div>
              <BarBlock value={Math.abs(netLongPct - 50)} total={50} color={netLongPct > 60 ? GREEN : netLongPct < 40 ? RED : MUTED} len={14} />
            </div>
            {avgFunding10 !== null && (
              <div>
                <div style={{ color: DIM, fontSize: "10px", marginBottom: "2px" }}>AVG FUNDING (TOP 10)</div>
                <div style={{
                  color: avgFunding10 > 0.05 ? GREEN : avgFunding10 < 0 ? RED : MUTED,
                  fontWeight: 700,
                  fontSize: "18px",
                }}>
                  {fmtFunding(avgFunding10)} <span style={{ fontSize: "11px", fontWeight: 400, color: DIM }}>8H</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Asset table header */}
        {!isMobile && (
          <div style={{ display: "grid", gridTemplateColumns: "70px 130px 80px 70px 1fr 60px", gap: "4px", marginBottom: "4px" }}>
            {["MARKET","SIGNAL","FUNDING","OI","DESCRIPTION","CONF"].map(h => (
              <div key={h} style={{ color: DIM, fontSize: "10px", letterSpacing: "0.08em", paddingBottom: "4px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                {h}
              </div>
            ))}
          </div>
        )}

        {topPositions.map(asset => {
          const sc = signalColor(asset.signal);
          const filled = Math.round((asset.confidence / 100) * 8);
          return (
            <div
              key={asset.name}
              style={isMobile ? {
                padding: "8px 0",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                fontSize: "12px",
              } : {
                display: "grid",
                gridTemplateColumns: "70px 130px 80px 70px 1fr 60px",
                gap: "4px",
                padding: "5px 0",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                fontSize: "12px",
                alignItems: "center",
              }}
            >
              {isMobile ? (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                    <span style={{ color: BRIGHT, fontWeight: 700 }}>{asset.name}</span>
                    <span style={{ color: sc, fontSize: "10px" }}>{asset.signal}</span>
                  </div>
                  <div style={{ display: "flex", gap: "12px", color: DIM, fontSize: "11px" }}>
                    <span>FUND: <span style={{ color: asset.funding >= 0 ? GREEN : RED }}>{fmtFunding(asset.funding)}</span></span>
                    <span>OI: <span style={{ color: MUTED }}>{fmtOI(asset.oi)}</span></span>
                    <span>CONF: <span style={{ color: MUTED }}>{asset.confidence}%</span></span>
                  </div>
                  <div style={{ color: DIM, fontSize: "11px", marginTop: "2px" }}>{assetDescription(asset)}</div>
                </div>
              ) : (
                <>
                  <div style={{ color: BRIGHT, fontWeight: 700 }}>{asset.name}</div>
                  <div style={{ color: sc, fontSize: "10px" }}>{asset.signal}</div>
                  <div style={{ color: asset.funding >= 0 ? (asset.funding > 0.02 ? GREEN : MUTED) : RED }}>
                    {fmtFunding(asset.funding)}
                  </div>
                  <div style={{ color: MUTED }}>{fmtOI(asset.oi)}</div>
                  <div style={{ color: DIM, fontSize: "11px" }}>{assetDescription(asset)}</div>
                  <div>
                    <div>
                      <span style={{ color: TEAL }}>{"▓".repeat(filled)}</span>
                      <span style={{ color: "rgba(255,255,255,0.10)" }}>{"░".repeat(8 - filled)}</span>
                    </div>
                    <div style={{ color: DIM, fontSize: "10px" }}>{asset.confidence}%</div>
                  </div>
                </>
              )}
            </div>
          );
        })}

        {topPositions.length === 0 && (
          <div style={{ color: DIM, padding: "20px 0", textAlign: "center", fontSize: "12px" }}>
            {loading ? "INITIALIZING POSITION DATA…" : "No position data available"}
          </div>
        )}
      </Card>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "4px", color: DIM, fontSize: "10px", letterSpacing: "0.05em", marginTop: "4px" }}>
        <div>// DATA: COINGECKO · OKX · ORDERLY NETWORK · ALTERNATIVE.ME</div>
        <div>AUTO-REFRESH: {REFRESH_INTERVAL}s · {countdown}s AGO</div>
      </div>

    </div>
  );
}
