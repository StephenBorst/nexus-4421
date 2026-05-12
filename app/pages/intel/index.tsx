import { useState, useEffect, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────
const REFRESH_INTERVAL = 60; // seconds
const TEAL   = "#38d2c7";
const GREEN  = "#29e9a9";
const RED    = "#f5618b";
const YELLOW = "#ffd146";
const DIM    = "rgba(255,255,255,0.38)";
const MUTED  = "rgba(255,255,255,0.60)";
const BRIGHT = "rgba(255,255,255,0.87)";

// ─── Types ────────────────────────────────────────────────────
interface FearGreedData  { value: number; label: string }
interface GlobalData     { btcDom: number; ethDom: number; mcapChange24h: number; totalMcap: number }
interface Mover          { symbol: string; change24h: number }

interface HLAsset {
  name: string;
  funding: number;  // 8-hour % already
  oi: number;       // USD
  volume: number;   // 24 h USD
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
    fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=8&page=1&sparkline=false"),
    fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_asc&per_page=8&page=1&sparkline=false"),
  ]);
  const [gData, lData] = await Promise.all([gRes.json(), lRes.json()]);
  const toMover = (c: any): Mover => ({ symbol: c.symbol.toUpperCase(), change24h: c.price_change_percentage_24h ?? 0 });
  return {
    gainers: gData.filter((c: any) => c.price_change_percentage_24h > 0).slice(0, 6).map(toMover),
    losers:  lData.filter((c: any) => c.price_change_percentage_24h < 0).slice(0, 6).map(toMover),
  };
}

async function fetchHyperliquid(): Promise<HLAsset[]> {
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  const [meta, ctxs] = await r.json();

  return (meta.universe as any[])
    .map((asset: any, i: number) => {
      const ctx    = ctxs[i];
      const markPx = parseFloat(ctx.markPx || ctx.midPx || "0");
      const oi     = parseFloat(ctx.openInterest || "0") * markPx;
      const volume = parseFloat(ctx.dayNtlVlm   || "0");
      // HL `funding` is predicted hourly rate as fraction → convert to 8 h %
      const funding = parseFloat(ctx.funding || "0") * 8 * 100;

      const oiVol = volume > 0 ? oi / volume : 0;
      let signal = "NEUTRAL", confidence = 50;

      if (funding > 0.08) {
        signal = "CROWDED LONGS";
        confidence = Math.min(95, 72 + Math.floor(funding * 40));
      } else if (funding < -0.03) {
        signal = "CROWDED SHORTS";
        confidence = Math.min(95, 72 + Math.floor(Math.abs(funding) * 80));
      } else if (oiVol > 3) {
        signal = "HIGH CONCENTRATION";
        confidence = 78;
      } else if (oiVol > 2) {
        signal = "ELEVATED OI";
        confidence = 65;
      }

      return { name: asset.name, funding, oi, volume, markPx, signal, confidence };
    })
    .filter((a: HLAsset) => a.oi > 500_000)
    .sort((a: HLAsset, b: HLAsset) => b.oi - a.oi)
    .slice(0, 30);
}

async function fetchBinanceDeriv(sym: string): Promise<DerivAsset | null> {
  try {
    const [fRes, oiRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}USDT`),
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}USDT`),
    ]);
    if (!fRes.ok || !oiRes.ok) return null;
    const [fd, oid] = await Promise.all([fRes.json(), oiRes.json()]);
    const mark = parseFloat(fd.markPrice);
    return {
      funding: parseFloat(fd.lastFundingRate) * 100, // 8 h %
      oi:      parseFloat(oid.openInterest)   * mark,
    };
  } catch { return null; }
}

async function fetchBinanceLS(sym: string): Promise<number | null> {
  try {
    const r = await fetch(
      `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}USDT&period=5m&limit=1`
    );
    if (!r.ok) return null;
    const d = await r.json();
    return parseFloat(d[0]?.longShortRatio);
  } catch { return null; }
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
  if (score >= 46) return { score, label: "NEUTRAL",          color: YELLOW, description: "Mixed signals — no clear directional edge. Size down and wait for clarity." };
  if (score >= 32) return { score, label: "SLIGHTLY BEARISH", color: YELLOW, description: "Mild bearish lean — defensive positioning warranted." };
  return              { score, label: "BEARISH",           color: RED,    description: "Risk-off — longs crowded or sentiment deteriorating sharply." };
}

// ─── Formatters ───────────────────────────────────────────────
const fmtFunding = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(4)}%`;
const fmtOI      = (v: number) => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(0)}M` : `$${v.toFixed(0)}`;
const fmtPct     = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

const lsLabel = (ls: number | null) =>
  ls === null ? "—" : ls > 1.35 ? "LONGS DOM" : ls < 0.75 ? "SHORTS DOM" : "BALANCED";
const lsColor = (ls: number | null) =>
  ls === null ? DIM : ls > 1.35 ? GREEN : ls < 0.75 ? RED : MUTED;

const signalColor = (sig: string) =>
  sig.includes("LONGS") ? GREEN : sig.includes("SHORTS") ? RED : sig.includes("CONCENTRATION") || sig.includes("ELEVATED") ? YELLOW : MUTED;

function assetSignalLabel(a: HLAsset): string {
  if (a.signal === "CROWDED LONGS")      return `${a.name} Crowded Longs`;
  if (a.signal === "CROWDED SHORTS")     return `${a.name} Crowded Shorts`;
  if (a.signal === "HIGH CONCENTRATION") return `${a.name} High OI Concentration`;
  if (a.signal === "ELEVATED OI")        return `${a.name} Elevated OI/Vol Ratio`;
  return `${a.name} Neutral`;
}

function assetDescription(a: HLAsset): string {
  const ratio = a.volume > 0 ? (a.oi / a.volume).toFixed(1) : "N/A";
  if (a.signal === "CROWDED LONGS")      return `Extreme long crowding — high squeeze risk if price reverses`;
  if (a.signal === "CROWDED SHORTS")     return `Heavy short bias — watch for short squeeze on any rally`;
  if (a.signal === "HIGH CONCENTRATION") return `${ratio}x OI/vol ratio — low liquidity relative to positions`;
  if (a.signal === "ELEVATED OI")        return `${ratio}x OI/vol ratio — positions building vs volume`;
  return `Neutral positioning at ${fmtOI(a.oi)} OI`;
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
    <div style={{
      background: "#0c1014",
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
    <div style={{ color: TEAL, fontSize: "10px", letterSpacing: "0.12em", marginBottom: "12px", opacity: 0.9 }}>
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

// ─── Main component ───────────────────────────────────────────
export default function IntelPage({ embedded = false }: { embedded?: boolean }) {
  const isMobile = useIsMobile();

  const [fearGreed,  setFearGreed]  = useState<FearGreedData | null>(null);
  const [globalData, setGlobalData] = useState<GlobalData    | null>(null);
  const [movers,     setMovers]     = useState<{ gainers: Mover[]; losers: Mover[] } | null>(null);
  const [hlAssets,   setHlAssets]   = useState<HLAsset[]     | null>(null);
  const [binance,    setBinance]    = useState<Record<string, DerivAsset>>({});
  const [lsRatios,   setLsRatios]   = useState<Record<string, number | null>>({});
  const [loading,    setLoading]    = useState(true);
  const [countdown,  setCountdown]  = useState(REFRESH_INTERVAL);
  const [timestamp,  setTimestamp]  = useState("");

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

      // Binance (may fail due to CORS – graceful fallback to HL data)
      const [btcD, ethD, solD, btcLS, ethLS, solLS] = await Promise.allSettled([
        fetchBinanceDeriv("BTC"),
        fetchBinanceDeriv("ETH"),
        fetchBinanceDeriv("SOL"),
        fetchBinanceLS("BTC"),
        fetchBinanceLS("ETH"),
        fetchBinanceLS("SOL"),
      ]);
      const bd: Record<string, DerivAsset> = {};
      if (btcD.status === "fulfilled" && btcD.value) bd["BTC"] = btcD.value;
      if (ethD.status === "fulfilled" && ethD.value) bd["ETH"] = ethD.value;
      if (solD.status === "fulfilled" && solD.value) bd["SOL"] = solD.value;
      setBinance(bd);

      const ls: Record<string, number | null> = {};
      ls["BTC"] = btcLS.status === "fulfilled" ? btcLS.value : null;
      ls["ETH"] = ethLS.status === "fulfilled" ? ethLS.value : null;
      ls["SOL"] = solLS.status === "fulfilled" ? solLS.value : null;
      setLsRatios(ls);

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
    if (binance[sym]) return binance[sym];
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
    background: embedded ? "transparent" : "#080b0d",
    minHeight: embedded ? undefined : "100vh",
    padding: embedded ? (isMobile ? "8px 0" : "4px 0") : (isMobile ? "12px" : "16px 20px"),
    fontFamily: "'Courier New', Courier, monospace",
    color: BRIGHT,
    fontSize: "13px",
    boxSizing: "border-box",
  };

  const grid3: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: isMobile ? "1fr" : "1.3fr 0.85fr 0.85fr",
    gap: "10px",
    marginBottom: "10px",
  };

  // ── Render helpers ───────────────────────────────────────────
  const renderDeriv = (sym: string, data: DerivAsset | null, ls: number | null) => {
    const fc = !data ? DIM : data.funding > 0.02 ? GREEN : data.funding < 0 ? RED : MUTED;
    const sig = !data ? "—" : data.funding > 0.06 ? "[LONGS]" : data.funding < -0.02 ? "[SHORTS]" : "[NEUTRAL]";
    const sigC = !data ? DIM : data.funding > 0.06 ? GREEN : data.funding < -0.02 ? RED : YELLOW;
    return (
      <div key={sym} style={{ marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
          <span style={{ color: BRIGHT, fontWeight: 700, width: "40px" }}>{sym}</span>
          <span style={{ color: sigC, fontSize: "11px" }}>{sig}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", rowGap: "2px", fontSize: "12px" }}>
          <div><span style={{ color: DIM }}>FUNDING 8H  </span><span style={{ color: fc }}>{data ? fmtFunding(data.funding) : "—"}</span></div>
          <div><span style={{ color: DIM }}>OI  </span><span style={{ color: MUTED }}>{data ? fmtOI(data.oi) : "—"}</span></div>
          <div><span style={{ color: DIM }}>L/S  </span><span style={{ color: lsColor(ls) }}>{ls !== null ? ls.toFixed(2) : "—"}</span></div>
          <div><span style={{ color: lsColor(ls), fontSize: "11px" }}>{lsLabel(ls)}</span></div>
        </div>
      </div>
    );
  };

  // ── JSX ─────────────────────────────────────────────────────
  return (
    <div style={page}>

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

      {/* ── Market Regime ───────────────────────────────────── */}
      <Card style={{ marginBottom: "10px" }}>
        <SectionTitle>// MARKET REGIME — TERMINAL</SectionTitle>

        <div style={{ marginBottom: "6px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
            <span style={{ color: DIM, fontSize: "12px" }}>← BEARISH</span>
            <span style={{ color: regime.color, fontWeight: 700, fontSize: "22px", letterSpacing: "0.04em" }}>
              {regime.label}
            </span>
            <span style={{ color: DIM, fontSize: "11px" }}>[{regime.score}]</span>
            <span style={{ color: DIM, fontSize: "12px" }}>BULLISH →</span>
          </div>
          <div style={{ marginBottom: "4px" }}>
            <BarBlock value={regime.score} total={100} color={regime.color} len={28} />
          </div>
          <div style={{ color: DIM, fontSize: "12px" }}>{regime.description}</div>
        </div>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "10px" }}>
          <div style={{ color: DIM, fontSize: "10px", letterSpacing: "0.1em", marginBottom: "8px" }}>// FACTOR BREAKDOWN</div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3, 1fr)", gap: "12px" }}>

            {/* Fear / Greed */}
            <div>
              <div style={{ color: DIM, fontSize: "10px", marginBottom: "3px" }}>FEAR / GREED</div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ color: fearGreed ? fearGreed.value > 60 ? GREEN : fearGreed.value < 40 ? RED : YELLOW : DIM, fontWeight: 600, fontSize: "13px" }}>
                  {fearGreed ? fearGreed.label.toUpperCase() : "—"}
                </span>
                {fearGreed && <span style={{ color: DIM, fontSize: "11px" }}>[{fearGreed.value}]</span>}
              </div>
              {fearGreed && (
                <div style={{ marginTop: "3px" }}>
                  <BarBlock value={fearGreed.value} total={100} color={fearGreed.value > 60 ? GREEN : fearGreed.value < 40 ? RED : YELLOW} len={14} />
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
                  <span style={{ color: globalData.btcDom > 60 ? RED : globalData.btcDom < 50 ? GREEN : YELLOW, fontSize: "10px" }}>
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

      {/* ── Main 3-col grid ─────────────────────────────────── */}
      <div style={grid3}>

        {/* ── Derivatives Intelligence ──────────────────────── */}
        <Card>
          <SectionTitle>// DERIVATIVES INTELLIGENCE — COINALYZE</SectionTitle>

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
            // VIA BINANCE FUTURES · HYPERLIQUID
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
                <span style={{ color: MUTED, fontSize: "12px" }}>{g.symbol}</span>
                <span style={{ color: GREEN, fontSize: "12px", fontWeight: 600 }}>+{g.change24h.toFixed(1)}%</span>
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
                <span style={{ color: MUTED, fontSize: "12px" }}>{l.symbol}</span>
                <span style={{ color: RED, fontSize: "12px", fontWeight: 600 }}>{l.change24h.toFixed(1)}%</span>
              </a>
            )) ?? <div style={{ color: DIM, fontSize: "12px" }}>Loading…</div>}
          </div>

          <div style={{ color: DIM, fontSize: "10px", marginTop: "12px", letterSpacing: "0.05em" }}>
            // VIA COINGECKO
          </div>
        </Card>

        {/* ── Live Signals ──────────────────────────────────── */}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <SectionTitle style={{ marginBottom: 0 }}>// LIVE SIGNALS</SectionTitle>
            {signals.length > 0 && (
              <span style={{ color: DIM, fontSize: "11px" }}>{signals.length} active</span>
            )}
          </div>

          {loading && signals.length === 0 && (
            <div style={{ color: DIM, fontSize: "12px" }}>Scanning positions…</div>
          )}
          {!loading && signals.length === 0 && (
            <div style={{ color: DIM, fontSize: "12px" }}>
              No extreme signals detected.<br />
              Market positioning is balanced.
            </div>
          )}

          {signals.map(s => {
            const sc = signalColor(s.signal);
            const filled = Math.round((s.confidence / 100) * 16);
            return (
              <div
                key={s.name}
                style={{
                  marginBottom: "7px",
                  padding: "7px 8px",
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                  <span style={{ color: sc, fontSize: "10px", letterSpacing: "0.04em" }}>[{s.signal}]</span>
                  <span style={{ color: BRIGHT, fontWeight: 700, fontSize: "12px" }}>{s.name}</span>
                </div>
                <div style={{ marginBottom: "2px" }}>
                  <span style={{ color: sc }}>{"▓".repeat(filled)}</span>
                  <span style={{ color: "rgba(255,255,255,0.12)" }}>{"░".repeat(16 - filled)}</span>
                  <span style={{ color: DIM, fontSize: "10px", marginLeft: "5px" }}>{s.confidence}%</span>
                </div>
                <div style={{ color: MUTED, fontSize: "11px" }}>{assetSignalLabel(s)}</div>
              </div>
            );
          })}

          <div style={{ color: DIM, fontSize: "10px", marginTop: "8px", letterSpacing: "0.05em" }}>
            // VIA HYPERLIQUID
          </div>
        </Card>

      </div>

      {/* ── Liquidations 24H ─────────────────────── */}
      <Card style={{ marginBottom: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <SectionTitle style={{ marginBottom: 0 }}>// LIQUIDATIONS 24H</SectionTitle>
          <span style={{ color: DIM, fontSize: "10px" }}>VIA BINANCE FUTURES</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: "10px" }}>
          {(["BTC", "ETH", "SOL"] as const).map(sym => {
            const ls = lsRatios[sym] ?? null;
            const status = ls === null ? "—" : ls > 1.35 ? "LONG FLUSH" : ls < 0.75 ? "SHORT SQUEEZE" : "BALANCED";
            const sc = ls === null ? DIM : ls > 1.35 ? RED : ls < 0.75 ? GREEN : YELLOW;
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
                    <span style={{ color: status === "LONG FLUSH" ? RED : MUTED }}>{oi > 0 ? fmtLiq(longLiq) : "—"}</span>
                  </div>
                  <div style={{ height: "3px", background: "rgba(255,255,255,0.06)", borderRadius: "1px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round(longPct * 100)}%`, background: status === "LONG FLUSH" ? RED : GREEN, opacity: 0.8 }} />
                  </div>
                </div>
                <div style={{ marginBottom: "6px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "2px" }}>
                    <span style={{ color: DIM }}>SHORTS</span>
                    <span style={{ color: status === "SHORT SQUEEZE" ? GREEN : MUTED }}>{oi > 0 ? fmtLiq(shortLiq) : "—"}</span>
                  </div>
                  <div style={{ height: "3px", background: "rgba(255,255,255,0.06)", borderRadius: "1px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round(shortPct * 100)}%`, background: status === "SHORT SQUEEZE" ? GREEN : RED, opacity: 0.8 }} />
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
          // EST. = ESTIMATED FROM OI × TYPICAL DAILY LIQ RATE · L/S FROM BINANCE FUTURES GLOBAL RATIO
        </div>
      </Card>

            {/* ── Liquidations 24H ──────────────────────────────────── */}
      <Card style={{ marginBottom: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <SectionTitle style={{ marginBottom: 0 }}>// LIQUIDATIONS 24H</SectionTitle>
          <span style={{ color: DIM, fontSize: "10px" }}>VIA BINANCE FUTURES</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: "10px" }}>
          {(["BTC", "ETH", "SOL"] as const).map(sym => {
            const ls = lsRatios[sym] ?? null;
            const status = ls === null ? "—" : ls > 1.35 ? "LONG FLUSH" : ls < 0.75 ? "SHORT SQUEEZE" : "BALANCED";
            const sc = ls === null ? DIM : ls > 1.35 ? RED : ls < 0.75 ? GREEN : YELLOW;
            const d = getDerivData(sym);
            const oi = d?.oi ?? 0;
            const longPct  = ls !== null ? Math.min(0.9, ls / (ls + 1)) : 0.5;
            const shortPct = 1 - longPct;
            const liqRate  = status === "LONG FLUSH" ? 0.018 : status === "SHORT SQUEEZE" ? 0.016 : 0.006;
            const totalLiq = oi * liqRate;
            const longLiq  = totalLiq * (status === "LONG FLUSH" ? 0.75 : status === "SHORT SQUEEZE" ? 0.25 : 0.5);
            const shortLiq = totalLiq - longLiq;
            const fmtLiq   = (v: number) => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(0)}M` : `$${v.toFixed(0)}`;
            return (
              <div key={sym} style={{ padding: "10px 12px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <span style={{ color: BRIGHT, fontWeight: 700, fontSize: "13px" }}>{sym}</span>
                  <span style={{ color: sc, fontSize: "10px", letterSpacing: "0.06em" }}>{status}</span>
                </div>
                <div style={{ marginBottom: "5px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "2px" }}>
                    <span style={{ color: DIM }}>LONGS</span>
                    <span style={{ color: status === "LONG FLUSH" ? RED : MUTED }}>{oi > 0 ? fmtLiq(longLiq) : "—"}</span>
                  </div>
                  <div style={{ height: "3px", background: "rgba(255,255,255,0.06)", borderRadius: "1px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round(longPct * 100)}%`, background: status === "LONG FLUSH" ? RED : GREEN, opacity: 0.8 }} />
                  </div>
                </div>
                <div style={{ marginBottom: "6px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "2px" }}>
                    <span style={{ color: DIM }}>SHORTS</span>
                    <span style={{ color: status === "SHORT SQUEEZE" ? GREEN : MUTED }}>{oi > 0 ? fmtLiq(shortLiq) : "—"}</span>
                  </div>
                  <div style={{ height: "3px", background: "rgba(255,255,255,0.06)", borderRadius: "1px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round(shortPct * 100)}%`, background: status === "SHORT SQUEEZE" ? GREEN : RED, opacity: 0.8 }} />
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
          // EST. FROM OI × TYPICAL DAILY LIQ RATE · L/S FROM BINANCE FUTURES GLOBAL RATIO
        </div>
      </Card>

            {/* ── Position Intelligence ───────────────────────────── */}
      <Card style={{ marginBottom: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px", flexWrap: "wrap", gap: "4px" }}>
          <SectionTitle style={{ marginBottom: 0 }}>// POSITION INTELLIGENCE</SectionTitle>
          <span style={{ color: DIM, fontSize: "10px" }}>HYPERLIQUID · {timestamp || "—"}</span>
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
              <div style={{ color: netLongPct > 60 ? GREEN : netLongPct < 40 ? RED : YELLOW, fontWeight: 700, fontSize: "18px" }}>
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
              <BarBlock value={Math.abs(netLongPct - 50)} total={50} color={netLongPct > 60 ? GREEN : netLongPct < 40 ? RED : YELLOW} len={14} />
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
        <div>// DATA: COINGECKO · BINANCE FUTURES · HYPERLIQUID · ALTERNATIVE.ME</div>
        <div>AUTO-REFRESH: {REFRESH_INTERVAL}s · {countdown}s AGO</div>
      </div>

    </div>
  );
}
