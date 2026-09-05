// ── Nexus token terminal (/token) ────────────────────────────────────────────
// A Definitive-style spot terminal: search any token → identity + live stats header,
// a candlestick chart, the live trade tape, and a trade panel. Built on public data
// (DexScreener + GeckoTerminal, client-side) so it works for any token, and HONEST about
// execution — Nexus has no spot venue, so the CTA routes to where an order can actually
// fill: our own perp page when the token is a listed Orderly market, else a deep-link to
// the token's pool. No fake order tabs, no dead "Buy" button.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { generatePageTitle } from "@/utils/utils";
import { getPageMeta } from "@/utils/seo";
import { renderSEOTags } from "@/utils/seo-tags";
import { useAccount, useWalletConnector } from "@orderly.network/hooks";
import { useIsMobile } from "@/pages/lab/useIsMobile";
import { SectionHeader } from "@/pages/lab/components";
import { FADE_FUNDING_FLOOR_PCT_YR } from "@/pages/lab/briefing";
import {
  searchToken, poolCandles, poolTrades, orderlyPerpSet, nexusSignal, swapQuote,
  fmtUsd, fmtTapeUsd, fmtPrice, fmtAge, shortAddr,
  type TokenPair, type Candle, type Trade, type NexusSignal, type SwapQuote,
} from "./data";
import { fetchHoldings, addRecent, optimisticHolding, probeHeldToken, type Holding } from "./holdings";
import { planBuy, planSell, executeSwap, explorerTx, fmtTokenAmount, slippagePct, type SwapPlan, type Eip1193 } from "./swapExec";

// Fire the global copilot (mounted in App) with a token-context question. The same
// nexus:assistant-ask contract the Lab's "Ask Nexus" chips use.
function askNexus(prompt: string) {
  window.dispatchEvent(new CustomEvent("nexus:assistant-ask", { detail: { prompt } }));
}

// The graded funding verdict for a listed market, read EXACTLY as the Board reads it (the server
// verdict + the ONE shared economic floor) so the terminal can't disagree with the Lab.
function nexusReadLabel(sig: NexusSignal): { label: string; color: string; sub: string } {
  const dir = sig.fadeDir === "LONG" || sig.fadeDir === "SHORT" ? sig.fadeDir : null;
  const annual = sig.fundingAnnualPct ?? 0;
  const bigEnough = Math.abs(annual) >= FADE_FUNDING_FLOOR_PCT_YR;
  const isFade = sig.verdict === "FADE" && !!dir && bigEnough;
  const fundTxt = `funding ${annual >= 0 ? "+" : ""}${annual.toFixed(1)}%/yr`;
  if (isFade) return { label: `◆ FADE ${dir}`, color: "#3ecf8e", sub: `${fundTxt} — the crowd is stretched ${dir === "SHORT" ? "long" : "short"}, graded from the tape after.` };
  if (sig.verdict === "FADE" || sig.verdict === "WATCH") return { label: "◆ WATCHING", color: "#71717a", sub: `${fundTxt} — elevated but not stretched vs its own range. No fade edge yet.` };
  return { label: "BALANCED", color: "#71717a", sub: `${fundTxt} — no crowd extreme to fade right now.` };
}

const MONO = "var(--nx-font-mono)";
const UI = "var(--nx-font-ui, sans-serif)";
const BG = "#0a0a0b", CARD = "#0f0f11", BORD = "#232327", BORD2 = "#1a1a1e";
const BRIGHT = "#f4f4f5", FOG = "#a1a1aa", MUT = "#71717a", FAINT = "#52525b";
const POS = "#3ecf8e", NEG = "#f7525f";

// Uniswap `chain` param by DexScreener chainId — the honest spot deep-link for EVM tokens
// we don't list as a perp. Solana routes to Jupiter; anything else falls back to the pool page.
const UNISWAP_CHAIN: Record<string, string> = {
  ethereum: "mainnet", base: "base", arbitrum: "arbitrum", optimism: "optimism",
  polygon: "polygon", bsc: "bnb", avalanche: "avalanche", blast: "blast", zora: "zora", celo: "celo",
};
function tradeLink(pair: TokenPair, isPerp: boolean): { href: string; venue: string; internal: boolean } {
  if (isPerp) return { href: `/perp/PERP_${pair.baseSymbol}_USDC`, venue: "Nexus perp", internal: true };
  if (pair.chainId === "solana" && pair.baseAddress) return { href: `https://jup.ag/swap/SOL-${pair.baseAddress}`, venue: "Jupiter", internal: false };
  const uni = UNISWAP_CHAIN[pair.chainId];
  if (uni && pair.baseAddress) return { href: `https://app.uniswap.org/swap?chain=${uni}&outputCurrency=${pair.baseAddress}`, venue: "Uniswap", internal: false };
  return { href: pair.url || "#", venue: pair.dexId || "the pool", internal: false };
}

// ── candlestick chart (dependency-free SVG; the mini-app pattern, scaled up) ───
const TIMEFRAMES: { label: string; tf: string; agg: number }[] = [
  { label: "5m", tf: "minute", agg: 5 },
  { label: "1H", tf: "hour", agg: 1 },
  { label: "4H", tf: "hour", agg: 4 },
  { label: "1D", tf: "day", agg: 1 },
];
// Congruent with the Lab QuickTrade chart (TradeChart): grid + right price axis + time axis +
// volume strip + MA(20/50) + crosshair, dependency-free SVG, measured width (no stretch). Fed by
// the pool's OHLCV so it works for any spot token, listed or not.
const CH_MA = [{ p: 20, c: "#ededf0" }, { p: 50, c: "#9aa2b4" }] as const;
const chFmtPx = (v: number) => (v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toPrecision(4));
function Chart({ candles, loading, height }: { candles: Candle[]; loading: boolean; height: number }) {
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); if (r.width > 0) setWidth(r.width); };
    const ro = new ResizeObserver(measure); ro.observe(el); measure(); roRef.current = ro;
  }, []);
  const box: React.CSSProperties = { width: "100%", height, background: BG, border: `1px solid ${BORD}`, borderRadius: 8, position: "relative", overflow: "hidden" };
  if (!candles.length) return <div ref={measureRef} style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 11, color: FAINT }}>{loading ? "loading chart…" : "no chart data for this pair"}</div>;

  const RPAD = 52, LPAD = 6, TOP = 22, TIMEH = 16, VOLH = 28, GAP = 6;
  const priceBottom = height - TIMEH - VOLH - GAP;
  const volTop = priceBottom + GAP, volBottom = height - TIMEH;
  const plotW = Math.max(60, width - LPAD - RPAD);
  const n = candles.length;
  const min = Math.min(...candles.map((d) => d.l)), max = Math.max(...candles.map((d) => d.h)), range = max - min || 1;
  const maxVol = Math.max(...candles.map((d) => d.v), 1);
  const slot = plotW / n;
  const x = (i: number) => LPAD + i * slot + slot / 2;
  const y = (v: number) => TOP + (1 - (v - min) / range) * (priceBottom - TOP);
  const vy = (v: number) => volBottom - (v / maxVol) * (volBottom - volTop);
  const bodyW = Math.max(1, slot * 0.62);
  const last = candles[n - 1], lastUp = last.c >= last.o;
  const priceLevels = [0, 0.25, 0.5, 0.75, 1].map((f) => min + range * f);
  const span = candles[n - 1].t - candles[0].t;
  const timeLabels = [0, 0.34, 0.67, 1].map((f) => {
    const i = Math.round(f * (n - 1)); const d = new Date(candles[i].t * 1000);
    const lab = span <= 86400 ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : `${d.getMonth() + 1}/${d.getDate()}`;
    return { x: x(i), lab };
  });
  // SMA(close) polylines over the visible candles — a rolling sum, O(n).
  const maLines: { p: number; c: string; d: string; last: number | null }[] = [];
  for (const { p, c } of CH_MA) {
    if (n < p) continue;
    let sum = 0, d = "", started = false, lastV: number | null = null;
    for (let i = 0; i < n; i++) { sum += candles[i].c; if (i >= p) sum -= candles[i - p].c; if (i >= p - 1) { const v = sum / p; lastV = v; d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; started = true; } }
    if (d) maLines.push({ p, c, d, last: lastV });
  }
  const hc = hover != null && hover < n ? candles[hover] : null;

  return (
    <div ref={measureRef} style={box}>
      {maLines.length > 0 && (
        <div style={{ position: "absolute", top: 5, left: 8, zIndex: 2, display: "flex", gap: 10, fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.02em", pointerEvents: "none" }}>
          {maLines.map((m) => <span key={m.p} style={{ color: m.c }}>MA{m.p} {m.last != null ? `$${chFmtPx(m.last)}` : "—"}</span>)}
        </div>
      )}
      <svg width={width} height={height} style={{ display: "block", position: "absolute", top: 0, left: 0, cursor: "crosshair" }}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const i = Math.round((e.clientX - r.left - LPAD - slot / 2) / slot); setHover(Math.max(0, Math.min(n - 1, i))); }}
        onMouseLeave={() => setHover(null)}>
        <defs><clipPath id="spot-price-clip"><rect x={LPAD} y={TOP} width={plotW} height={Math.max(0, priceBottom - TOP)} /></clipPath></defs>
        {priceLevels.map((p, i) => (
          <g key={i}>
            <line x1={LPAD} x2={LPAD + plotW} y1={y(p)} y2={y(p)} stroke="#ffffff0d" strokeWidth={1} />
            <text x={width - RPAD + 6} y={y(p) + 3} fontFamily={MONO} fontSize={9} fill={FAINT} stroke={BG} strokeWidth={2.2} paintOrder="stroke" strokeLinejoin="round">{chFmtPx(p)}</text>
          </g>
        ))}
        {timeLabels.map((t, i) => (
          <g key={i}>
            <line x1={t.x} x2={t.x} y1={TOP} y2={priceBottom} stroke="#ffffff0d" strokeWidth={1} />
            <text x={t.x} y={height - 4} fontFamily={MONO} fontSize={9} fill={FAINT} textAnchor="middle">{t.lab}</text>
          </g>
        ))}
        {candles.map((d, i) => {
          const up = d.c >= d.o, col = up ? POS : NEG, cx = x(i);
          const yTop = Math.min(y(d.o), y(d.c)), bh = Math.max(0.8, Math.abs(y(d.c) - y(d.o)));
          return (
            <g key={i} opacity={hover != null && hover !== i ? 0.85 : 1}>
              <line x1={cx} x2={cx} y1={y(d.h)} y2={y(d.l)} stroke={col} strokeWidth={1} />
              <rect x={cx - bodyW / 2} y={yTop} width={bodyW} height={bh} fill={col} />
              <rect x={cx - bodyW / 2} y={vy(d.v)} width={bodyW} height={Math.max(0.5, volBottom - vy(d.v))} fill={col} opacity={0.3} />
            </g>
          );
        })}
        {maLines.length > 0 && <g clipPath="url(#spot-price-clip)">{maLines.map((m) => <path key={m.p} d={m.d} fill="none" stroke={m.c} strokeWidth={m.p === 20 ? 1.4 : 1.1} strokeLinejoin="round" strokeLinecap="round" opacity={0.95} />)}</g>}
        <line x1={LPAD} x2={LPAD + plotW} y1={y(last.c)} y2={y(last.c)} stroke={lastUp ? POS : NEG} strokeWidth={0.6} strokeDasharray="1 3" opacity={0.6} />
        <rect x={width - RPAD} y={y(last.c) - 8} width={RPAD} height={16} fill={lastUp ? POS : NEG} />
        <text x={width - RPAD + RPAD / 2} y={y(last.c) + 3.5} fontFamily={MONO} fontSize={9} fill="#0a0a0b" fontWeight={700} textAnchor="middle">{chFmtPx(last.c)}</text>
        {hc && hover != null && <line x1={x(hover)} x2={x(hover)} y1={TOP} y2={volBottom} stroke="#ffffff" strokeWidth={0.6} strokeDasharray="2 3" opacity={0.35} />}
      </svg>
      {hc && (
        <div style={{ position: "absolute", top: TOP + 4, left: 8, zIndex: 2, background: "#0f0f11ee", border: `1px solid ${BORD}`, borderRadius: 4, padding: "5px 8px", fontFamily: MONO, fontSize: 9.5, color: MUT, pointerEvents: "none", lineHeight: 1.5 }}>
          <span style={{ color: FAINT }}>{new Date(hc.t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><br />
          O <span style={{ color: BRIGHT }}>{chFmtPx(hc.o)}</span> H <span style={{ color: BRIGHT }}>{chFmtPx(hc.h)}</span> L <span style={{ color: BRIGHT }}>{chFmtPx(hc.l)}</span> C <span style={{ color: hc.c >= hc.o ? POS : NEG }}>{chFmtPx(hc.c)}</span>
        </div>
      )}
    </div>
  );
}

// ── YOUR WALLET strip — read-only spot holdings, a launcher + (later) MAX source ──
// Connected only; disconnected renders nothing. Each row opens that token on Spot.
function HoldingsStrip({ holdings, loading, onOpen }: { holdings: Holding[]; loading: boolean; onOpen: (h: Holding) => void }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.14em", color: FAINT, textTransform: "uppercase", marginBottom: 7 }}>Your wallet</div>
      {loading && holdings.length === 0 ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>reading balances…</div>
      ) : holdings.length === 0 ? (
        <div style={{ fontFamily: UI, fontSize: 12, color: MUT }}>No spot tokens in this wallet.</div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {holdings.map((h, i) => (
            <button key={`${h.chain}-${h.sym}-${i}`} onClick={() => onOpen(h)} className="nx-press"
              style={{ display: "flex", alignItems: "center", gap: 7, background: CARD, border: `1px solid ${BORD}`, borderRadius: 8, padding: "7px 11px", cursor: "pointer", fontFamily: MONO }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: BRIGHT }}>{h.sym}</span>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", color: MUT, border: `1px solid ${BORD}`, borderRadius: 3, padding: "0 4px", textTransform: "uppercase" }}>{h.chain}</span>
              <span style={{ fontSize: 11, color: FOG }}>{h.amountLabel}</span>
              <span style={{ fontSize: 11, color: MUT }}>· {h.usdLabel}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── one header stat cell ──────────────────────────────────────────────────────
function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: FAINT, textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: color || BRIGHT, whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

// One line item in the swap confirm modal — a label, a right-aligned value, and an optional
// sub-line. accent (green) for the enforced floor, danger (red) for a high price impact.
function ModalRow({ label, value, sub, accent, danger }: { label: string; value: string; sub?: string; accent?: boolean; danger?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "7px 0", borderBottom: `1px solid ${BORD2}` }}>
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: MUT, flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: "right", minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: MONO, fontSize: 12, fontWeight: 600, color: danger ? NEG : accent ? POS : BRIGHT, wordBreak: "break-word" }}>{value}</span>
        {sub && <span style={{ display: "block", fontFamily: MONO, fontSize: 8.5, color: FAINT, marginTop: 2 }}>{sub}</span>}
      </span>
    </div>
  );
}

export default function TokenTerminal() {
  const isMobile = useIsMobile();
  const { query } = useParams();
  const navigate = useNavigate();
  const [input, setInput] = useState(query || "");
  const [pair, setPair] = useState<TokenPair | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [tf, setTf] = useState(1); // index into TIMEFRAMES (1H default)
  const [trades, setTrades] = useState<Trade[]>([]);
  const [perpSet, setPerpSet] = useState<Set<string>>(new Set());
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  // Perp-listed tokens can trade EITHER our own book (perp) OR spot — this picks which panel.
  // A SPOT SELL is sized by a typed token amount (sellAmt) or MAX (sellMax = the whole balance).
  const [venue, setVenue] = useState<"perp" | "spot">("perp");
  const [sellAmt, setSellAmt] = useState("");
  const [sellMax, setSellMax] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(true); // collapse the buy/sell panel to give the chart room
  const [copied, setCopied] = useState(false);
  const [sig, setSig] = useState<NexusSignal | null>(null);

  // Connected wallet → read-only spot holdings (no txs). Disconnected → no strip.
  const { state: acct } = useAccount();
  const wallet = (acct as { address?: string })?.address ?? null;
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  useEffect(() => {
    if (!wallet) { setHoldings([]); setHoldingsLoading(false); return; }
    let alive = true;
    setHoldingsLoading(true);
    fetchHoldings(wallet)
      .then((h) => { if (alive) setHoldings(h); })
      .catch(() => { if (alive) setHoldings([]); })
      .finally(() => { if (alive) setHoldingsLoading(false); });
    return () => { alive = false; };
  }, [wallet]);

  useEffect(() => { orderlyPerpSet().then(setPerpSet).catch(() => { /* no perp routing */ }); }, []);
  useEffect(() => { setInput(query || ""); }, [query]);

  // ── resolve the searched token → the deepest pair ──
  useEffect(() => {
    if (!query) { setPair(null); setNotFound(false); return; }
    let alive = true;
    setLoading(true); setNotFound(false);
    // independent watchdog: never leave the terminal on a spinner if the fetch hangs
    const paint = setTimeout(() => { if (alive) setLoading(false); }, 6500);
    searchToken(query)
      .then(({ best }) => {
        if (!alive) return;
        setPair(best); setNotFound(!best);
      })
      .catch(() => { if (alive) { setPair(null); setNotFound(true); } })
      .finally(() => { if (alive) { setLoading(false); clearTimeout(paint); } });
    return () => { alive = false; clearTimeout(paint); };
  }, [query]);

  // ── chart for the resolved pair (+ on timeframe change) ──
  useEffect(() => {
    if (!pair) { setCandles([]); return; }
    let alive = true;
    setChartLoading(true);
    const { tf: gtf, agg } = TIMEFRAMES[tf];
    poolCandles(pair.chainId, pair.pairAddress, gtf, agg, 100)
      .then((c) => { if (alive) setCandles(c); })
      .catch(() => { if (alive) setCandles([]); })
      .finally(() => { if (alive) setChartLoading(false); });
    return () => { alive = false; };
  }, [pair, tf]);

  // ── live tape (polled) ──
  useEffect(() => {
    if (!pair) { setTrades([]); return; }
    let alive = true;
    const load = () => poolTrades(pair.chainId, pair.pairAddress).then((t) => { if (alive) setTrades(t); }).catch(() => { /* keep last */ });
    load();
    const id = setInterval(load, 20000);
    return () => { alive = false; clearInterval(id); };
  }, [pair]);

  // ── header stats refresh (price moves) ──
  useEffect(() => {
    if (!query || !pair) return;
    let alive = true;
    const id = setInterval(() => {
      searchToken(query).then(({ best }) => { if (alive && best) setPair(best); }).catch(() => { /* keep last */ });
    }, 25000);
    return () => { alive = false; clearInterval(id); };
  }, [query, pair]);

  // ── the Nexus edge on a listed market ──
  // Only for a symbol we actually list — we don't compute funding/OI on arbitrary memecoins,
  // and inventing a read for one would be the exact dishonesty the rest of this page avoids.
  useEffect(() => {
    const sym = pair?.baseSymbol;
    if (!sym || !perpSet.has(sym)) { setSig(null); return; }
    let alive = true;
    nexusSignal(sym).then((s) => { if (alive) setSig(s); }).catch(() => { if (alive) setSig(null); });
    return () => { alive = false; };
  }, [pair, perpSet]);

  const submit = useCallback((q: string) => {
    const v = q.trim();
    if (v) navigate(`/token/${encodeURIComponent(v)}`);
  }, [navigate]);

  const isPerp = !!pair && perpSet.has(pair.baseSymbol);
  const route = useMemo(() => (pair ? tradeLink(pair, isPerp) : null), [pair, isPerp]);
  // The SPOT route regardless of perp-listing — so a perp token can ALSO be spot-traded (the
  // Perp/Spot optionality). `route` above stays perp-aware for the Long/Short CTA.
  const spotRoute = useMemo(() => (pair ? tradeLink(pair, false) : null), [pair]);
  // Reset to the book (perp) view when the token changes — keyed on the CA so a 25s price poll
  // (which makes a new `pair` object) never flips the panel out from under the user.
  useEffect(() => { setVenue("perp"); }, [pair?.baseAddress]);

  // ── auto-hydrate recents (Order 0) ── When a connected wallet lands on a token's Spot page and
  // actually HOLDS it, remember it — so the chip self-heals across browsers/devices without a
  // re-buy (recents lives in this browser's localStorage; a share link opened in a fresh jar, or
  // a wallet's in-app browser vs Safari, would otherwise show nothing). Pure read, no signing.
  // Guarded to one probe per wallet+token per session so the 25s stats refresh can't re-run it.
  const hydratedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!wallet || !pair?.baseAddress || isPerp) return;
    const ca = pair.baseAddress;
    const key = `${wallet.toLowerCase()}:${pair.chainId}:${ca.toLowerCase()}`;
    if (hydratedRef.current.has(key)) return;
    hydratedRef.current.add(key);
    let alive = true;
    probeHeldToken(wallet, pair.chainId, ca).then((res) => {
      if (!alive || !res) return;
      addRecent(wallet, { ca, sym: pair.baseSymbol, chain: pair.chainId, decimals: res.decimals });
      fetchHoldings(wallet).then((h) => { if (alive) setHoldings(h); }).catch(() => { /* keep current */ });
    }).catch(() => { /* fail-soft */ });
    return () => { alive = false; };
  }, [pair, wallet, isPerp]);

  // ── swap QUOTE (non-perp only; preview, no signing) ──
  // Perp-listed names keep Long/Short on Nexus and are never probed — the venue is our own book.
  // The probe tracks the AMOUNT box (impact is size-dependent), debounced so a keystroke doesn't
  // spam the router; empty/zero falls back to a $100 reference probe. Capped for a sane request.
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const probeUsd = useMemo(() => {
    const a = parseFloat(amount);
    return Number.isFinite(a) && a > 0 ? Math.min(a, 100000) : 100;
  }, [amount]);
  useEffect(() => {
    // Probe the SPOT route for every token (perp included) so the Spot panel — and its in-app
    // buy/sell gate — is available even on a listed-perp name (the Perp/Spot optionality).
    if (!pair) { setQuote(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      swapQuote(pair, probeUsd).then((q) => { if (alive) setQuote(q); }).catch(() => { if (alive) setQuote(null); });
    }, 450);
    return () => { alive = false; clearTimeout(t); };
  }, [pair, probeUsd]);

  // The fill affordance, resolved once so the button and the honesty line agree:
  //  perp     → Long/Short on our book (unchanged).
  //  quote    → a real router quote (Jupiter) → "Swap via {router}" preview; still deep-links to
  //             the router to COMPLETE, since in-app signing is a later pass.
  //  deeplink → no quote but a named venue (Uniswap/Jupiter/pool) → honest named link. This is
  //             the $NEXUS / v4-gap case: aggregators miss it, Uniswap routes it, so Uniswap is
  //             the honest answer — not a dead button.
  //  noroute  → nothing to route to → disabled, says "no route". Never a fake Buy.
  // quoteRouter = who confirmed the route + impact (Jupiter / Fabric). completeVenue = where the
  // swap actually finishes until in-app signing lands (the deep-link). They're the same for
  // Jupiter (its own app completes it) and differ for Fabric-on-EVM (route via Fabric, complete
  // on Uniswap) — so the badge and the button name the truth for each, never a merged fiction.
  // The SPOT fill state (kind: quote | deeplink | noroute), computed for EVERY token — the perp
  // Long/Short CTA is now a SEPARATE surface (showPerp below), so a listed perp offers both.
  const swapState = useMemo(() => {
    if (quote && spotRoute) return { kind: "quote" as const, href: spotRoute.href, quoteRouter: quote.router, completeVenue: spotRoute.venue, impact: quote.priceImpactPct, probeUsd: quote.probeUsd };
    if (spotRoute && spotRoute.href && spotRoute.href !== "#") return { kind: "deeplink" as const, href: spotRoute.href, venue: spotRoute.venue };
    return { kind: "noroute" as const };
  }, [quote, spotRoute]);
  const estOut = useMemo(() => {
    const a = parseFloat(amount);
    if (!pair?.priceUsd || !Number.isFinite(a) || a <= 0) return null;
    return a / pair.priceUsd;
  }, [amount, pair]);

  // ── in-app SWAP (EVM · Fabric · BUY only) — gated, ADDITIVE to the deep-link ──
  // Offered only when a Fabric route confirmed (quote), the user is BUYING, and a wallet is
  // connected. Everything else (Solana/Jupiter, perp, no wallet) keeps the exact prior behavior.
  // The deep-link never goes away — this is the extra "don't leave to Uniswap" path, and any
  // failure falls back to it. planBuy validates hard before the modal; executeBuy signs only on
  // an explicit confirm.
  const { wallet: wc } = useWalletConnector();
  const provider = (wc?.provider as Eip1193 | undefined) || undefined;
  // Venue routing: a perp token can show BOTH — Long/Short on our book (showPerp) AND the spot
  // buy/sell panel (showSpot). A non-perp token is spot only. In-app fill is Fabric-on-EVM only.
  const showPerp = isPerp && venue === "perp";
  const showSpot = !isPerp || venue === "spot";
  const fabricEvm = swapState.kind === "quote" && quote?.router === "Fabric" && !!wallet && !!provider;
  const canInAppBuy = showSpot && side === "buy" && fabricEvm;
  // The wallet's on-chain holding of THIS token (from the balance strip) — a SELL needs it.
  const held = useMemo(() => {
    const ca = pair?.baseAddress?.toLowerCase();
    if (!ca || !pair) return undefined;
    return holdings.find((h) => (h.address || "").toLowerCase() === ca && h.chain === pair.chainId);
  }, [holdings, pair]);
  const holdsToken = !!held && held.amount > 0;
  const canInAppSell = showSpot && side === "sell" && fabricEvm && holdsToken;
  const isSpotSell = showSpot && side === "sell";
  const sellTokens = sellMax && held ? held.amount : (parseFloat(sellAmt) || 0);
  const sellUsdEst = held && pair?.priceUsd ? sellTokens * pair.priceUsd : null;
  const [plan, setPlan] = useState<SwapPlan | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [swapBusy, setSwapBusy] = useState(false);
  const [swapStep, setSwapStep] = useState("");
  const [swapErr, setSwapErr] = useState<string | null>(null);
  const [swapDone, setSwapDone] = useState<{ hash: string } | null>(null);

  // A changed token/side/amount invalidates a captured plan — close + clear so the modal can
  // never sign against a plan the numbers on screen no longer match.
  useEffect(() => { setModalOpen(false); setPlan(null); setSwapErr(null); setSwapDone(null); }, [pair?.baseAddress, side, amount, sellAmt, sellMax, venue]);

  const openSwap = useCallback(async () => {
    const usd = parseFloat(amount);
    setSwapErr(null); setSwapDone(null);
    if (!pair?.baseAddress || !wallet || !provider) return;
    if (!Number.isFinite(usd) || usd < 1) { setSwapErr("Enter at least $1 to swap in-app."); return; }
    setPlanning(true);
    try {
      const p = await planBuy(pair.chainId, pair.baseAddress, usd, wallet, provider);
      setPlan(p); setModalOpen(true);
    } catch (e) {
      setSwapErr((e as Error)?.message || "Couldn't build the swap — use the deep-link.");
    } finally { setPlanning(false); }
  }, [pair, wallet, provider, amount]);

  // SELL a % of the on-chain balance → USDC. planSell reads the balance + decimals FRESH and sizes
  // the exact base-units amount, so MAX sells the whole balance without a float that overshoots.
  const openSell = useCallback(async () => {
    setSwapErr(null); setSwapDone(null);
    if (!pair?.baseAddress || !wallet || !provider) return;
    if (!holdsToken) { setSwapErr("You don't hold this token to sell."); return; }
    if (!sellMax && !(parseFloat(sellAmt) > 0)) { setSwapErr("Enter an amount to sell."); return; }
    setPlanning(true);
    try {
      const p = await planSell(pair.chainId, pair.baseAddress, sellMax ? { pct: 100 } : { amountStr: sellAmt }, wallet, provider, pair.priceUsd ?? null);
      setPlan(p); setModalOpen(true);
    } catch (e) {
      setSwapErr((e as Error)?.message || "Couldn't build the sell — use the deep-link.");
    } finally { setPlanning(false); }
  }, [pair, wallet, provider, sellAmt, sellMax, holdsToken]);

  const confirmSwap = useCallback(async () => {
    if (!plan || !wallet || !provider) return;
    setSwapBusy(true); setSwapErr(null); setSwapStep("preparing…");
    try {
      const { swapHash, confirmed } = await executeSwap(provider, wallet, plan, setSwapStep);
      setSwapDone({ hash: swapHash });
      // Follow the fill on a CONFIRMED (status=1) swap. BUY: remember the bought token + show an
      // optimistic chip, then reconcile from chain. SELL: the balance just dropped (USDC rose) —
      // nothing to remember, just reconcile the strip. Either way, refetch from chain.
      if (confirmed && pair?.baseAddress) {
        if (plan.dir === "buy" && plan.decimalsOut != null) {
          addRecent(wallet, { ca: pair.baseAddress, sym: pair.baseSymbol, chain: pair.chainId, decimals: plan.decimalsOut });
          if (plan.outAmount != null) {
            const chip = optimisticHolding(pair.baseSymbol, pair.chainId, pair.baseAddress, plan.outAmount, plan.decimalsOut, pair.priceUsd ?? null);
            setHoldings((h) => [chip, ...h.filter((x) => !((x.address || "").toLowerCase() === pair.baseAddress.toLowerCase() && x.chain === pair.chainId))]);
          }
        }
        fetchHoldings(wallet).then(setHoldings).catch(() => { /* keep what's shown */ });
      }
    } catch (e) {
      const m = (e as Error)?.message || "swap failed";
      const lowBal = /insufficient|exceeds balance|transfer amount exceeds/i.test(m)
        ? (plan.dir === "sell" ? `Not enough ${pair?.baseSymbol ?? "token"} (+ a little ETH for gas) on this network.` : "Not enough USDC (+ a little ETH for gas) on this network.")
        : null;
      setSwapErr(lowBal ?? (/user rejected|user denied|rejected the request|4001/i.test(m) ? "Cancelled in your wallet." : m));
    } finally { setSwapBusy(false); setSwapStep(""); }
  }, [plan, wallet, provider, pair]);

  const [shareCopied, setShareCopied] = useState(false);
  const closeSwap = useCallback(() => {
    if (swapBusy) return; // never yank the modal out from under a pending signature
    setModalOpen(false); setPlan(null); setSwapErr(null); setSwapDone(null); setShareCopied(false);
  }, [swapBusy]);

  const copyCa = useCallback(() => {
    if (!pair?.baseAddress) return;
    try { navigator.clipboard.writeText(pair.baseAddress); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* ignore */ }
  }, [pair]);

  // Share-on-swap (Pass A): copy the token's Spot link to share the call. Verdict-only — the card
  // states the fact (you bought X of SYM on Nexus) + this link; no E[R], no conviction, no PnL.
  const copyShare = useCallback(() => {
    if (!pair?.baseAddress) return;
    const link = `${window.location.origin}/token/${pair.baseAddress}`;
    try { navigator.clipboard.writeText(link); setShareCopied(true); setTimeout(() => setShareCopied(false), 1600); } catch { /* clipboard blocked */ }
  }, [pair]);

  const pageMeta = getPageMeta();
  const pageTitle = generatePageTitle(pair ? `${pair.baseSymbol} · Spot` : "Spot");

  return (
    <>
      {renderSEOTags(pageMeta, pageTitle)}
      <div style={{ background: BG, minHeight: "100dvh" }}>
        {/* Capped + centered container with the shared SectionHeader, so Spot reads as one of the
            Nexus custom surfaces (X-Ray / Feed / Proof), not a bespoke page. */}
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: isMobile ? "20px 14px 96px" : "32px 24px 80px" }}>
        <SectionHeader eyebrow="SPOT" title="Trade any token." note="LIVE DATA · ANY CHAIN" />
        {wallet && <HoldingsStrip holdings={holdings} loading={holdingsLoading} onOpen={(h) => navigate(`/token/${encodeURIComponent(h.address || h.sym)}`)} />}
        {/* ── SEARCH ── Definitive's "Search CA or Token" */}
        <form onSubmit={(e) => { e.preventDefault(); submit(input); }} style={{ display: "flex", gap: 8, marginBottom: 16, maxWidth: 640 }}>
          {/* Relative wrapper so the one-tap clear (✕) sits inside the field — wiping a long
              pasted CA in a single tap instead of holding backspace. mouseDown-preventDefault
              keeps focus so the caret stays for a fresh type. */}
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <input
              value={input} onChange={(e) => setInput(e.target.value)}
              placeholder="Search any token — symbol, name, or contract address"
              spellCheck={false} autoCapitalize="off" autoCorrect="off"
              style={{ width: "100%", background: CARD, border: `1px solid ${BORD}`, borderRadius: 8, color: BRIGHT, fontFamily: MONO, fontSize: 13, padding: "11px 40px 11px 14px", outline: "none", boxSizing: "border-box" }}
            />
            {input && (
              <button type="button" aria-label="Clear search" title="Clear"
                onMouseDown={(e) => e.preventDefault()} onClick={() => setInput("")}
                style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: MUT, fontFamily: MONO, fontSize: 15, lineHeight: 1, cursor: "pointer", borderRadius: 6 }}>✕</button>
            )}
          </div>
          <button type="submit" style={{ flexShrink: 0, background: BRIGHT, color: "#0a0a0b", border: "none", borderRadius: 8, fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", padding: "0 18px", cursor: "pointer" }}>SEARCH</button>
        </form>

        {/* ── LANDING (no query) ── */}
        {!query && (
          <div style={{ maxWidth: 640 }}>
            <div style={{ fontFamily: UI, fontSize: 15, color: BRIGHT, fontWeight: 600, marginBottom: 6 }}>Look up any token.</div>
            <div style={{ fontFamily: UI, fontSize: 13, lineHeight: 1.6, color: MUT, marginBottom: 16 }}>
              Live price, chart, and the trade tape for any token across the majors and every memecoin — read the market, then trade it. When it’s a market Nexus lists, you trade it here; otherwise we route you to its pool.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["BTC", "ETH", "SOL", "HYPE", "NEXUS"].map((s) => (
                <button key={s} onClick={() => submit(s)} style={{ background: CARD, border: `1px solid ${BORD}`, borderRadius: 6, color: MUT, fontFamily: MONO, fontSize: 12, padding: "7px 12px", cursor: "pointer" }}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {/* ── NOT FOUND ── */}
        {query && notFound && !loading && (
          <div style={{ fontFamily: MONO, fontSize: 13, color: MUT, padding: "40px 0" }}>No token found for “{query}”. Try a symbol (SOL), a name, or paste the contract address.</div>
        )}

        {/* ── LOADING ── */}
        {query && loading && !pair && (
          <div style={{ fontFamily: MONO, fontSize: 12, color: FAINT, padding: "40px 0" }}>resolving {query}…</div>
        )}

        {/* ── THE TERMINAL ── */}
        {pair && (
          <>
            {/* header: identity + stats */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", padding: isMobile ? "12px" : "12px 16px", background: CARD, border: `1px solid ${BORD}`, borderRadius: 10, marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                {pair.imageUrl
                  ? <img src={pair.imageUrl} alt="" width={36} height={36} style={{ borderRadius: "50%", flexShrink: 0, background: BG }} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                  : <div style={{ width: 36, height: 36, borderRadius: "50%", background: BG, border: `1px solid ${BORD}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 14, color: MUT }}>{pair.baseSymbol.slice(0, 1)}</div>}
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, color: BRIGHT }}>{pair.baseSymbol}</span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>/{pair.quoteSymbol}</span>
                    {/* chain badge — a bare-ticker search picks the deepest pair across ALL chains, so
                        WETH can resolve to Solana when you meant Base; naming the chain here (+ the CA
                        below, + the switchable "Other pairs" chips) makes which token you're on unambiguous. */}
                    <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.08em", color: MUT, border: `1px solid ${BORD}`, borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" }}>{pair.chainId}</span>
                    {isPerp && <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.08em", color: POS, border: `1px solid ${POS}55`, borderRadius: 4, padding: "1px 5px" }}>NEXUS PERP</span>}
                  </div>
                  <div style={{ fontFamily: UI, fontSize: 11, color: MUT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }}>{pair.baseName}</div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600, color: BRIGHT, letterSpacing: "-0.01em" }}>{fmtPrice(pair.priceUsd)}</span>
                {pair.priceChange24h != null && <span style={{ fontFamily: MONO, fontSize: 13, color: pair.priceChange24h > 0 ? POS : pair.priceChange24h < 0 ? NEG : MUT }}>{pair.priceChange24h > 0 ? "+" : ""}{pair.priceChange24h.toFixed(2)}%</span>}
              </div>

              <div style={{ display: "flex", gap: isMobile ? 14 : 22, flexWrap: "wrap", marginLeft: isMobile ? 0 : "auto" }}>
                <Stat label="Mkt Cap" value={fmtUsd(pair.marketCap)} />
                <Stat label="FDV" value={fmtUsd(pair.fdv)} />
                <Stat label="24h Vol" value={fmtUsd(pair.volume24h)} />
                <Stat label="Liquidity" value={fmtUsd(pair.liquidityUsd)} />
                <Stat label="24h Buys" value={pair.buys24h != null ? pair.buys24h.toLocaleString() : "—"} color={POS} />
                <Stat label="24h Sells" value={pair.sells24h != null ? pair.sells24h.toLocaleString() : "—"} color={NEG} />
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                {pair.baseAddress && (
                  <button onClick={copyCa} title="Copy contract address" className="nx-press" style={{ display: "inline-flex", alignItems: "center", gap: 6, background: BG, border: `1px solid ${copied ? "#3ecf8e88" : BORD}`, borderRadius: 7, color: copied ? POS : MUT, fontFamily: MONO, fontSize: 10.5, padding: "6px 11px", cursor: "pointer", lineHeight: 1 }}>
                    <span>{copied ? "copied ✓" : shortAddr(pair.baseAddress)}</span>
                    {!copied && <span style={{ color: FAINT, fontSize: 11 }}>⧉</span>}
                  </button>
                )}
                {pair.websites[0] && <a href={pair.websites[0]} target="_blank" rel="noopener noreferrer" className="nx-press" style={{ display: "inline-flex", alignItems: "center", fontFamily: MONO, fontSize: 10.5, color: MUT, textDecoration: "none", border: `1px solid ${BORD}`, borderRadius: 7, padding: "6px 11px", lineHeight: 1 }}>web ↗</a>}
                {pair.socials.filter((s) => /twitter|x/i.test(s.type)).slice(0, 1).map((s) => <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="nx-press" style={{ display: "inline-flex", alignItems: "center", fontFamily: MONO, fontSize: 10.5, color: MUT, textDecoration: "none", border: `1px solid ${BORD}`, borderRadius: 7, padding: "6px 11px", lineHeight: 1 }}>𝕏 ↗</a>)}
              </div>
            </div>

            {/* body: chart + tape (left) · trade panel (right) */}
            <div style={{ display: isMobile ? "block" : "grid", gridTemplateColumns: "1fr 320px", gap: 12, alignItems: "start" }}>
              <div style={{ minWidth: 0 }}>
                {/* chart + timeframe */}
                <div style={{ background: CARD, border: `1px solid ${BORD}`, borderRadius: 10, padding: 10, marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 8 }}>
                    {TIMEFRAMES.map((t, i) => (
                      <button key={t.label} onClick={() => setTf(i)} style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: i === tf ? BRIGHT : FAINT, background: i === tf ? "#ededf012" : "none", border: `1px solid ${i === tf ? "#ededf033" : "transparent"}`, borderRadius: 6, padding: "5px 11px", cursor: "pointer" }}>{t.label}</button>
                    ))}
                    <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.04em", color: FAINT, alignSelf: "center", textTransform: "uppercase" }}>chart · GeckoTerminal</span>
                  </div>
                  <Chart candles={candles} loading={chartLoading} height={isMobile ? 300 : 460} />
                </div>

                {/* live tape */}
                <div style={{ background: CARD, border: `1px solid ${BORD}`, borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 64px", gap: 8, padding: "9px 12px", borderBottom: `1px solid ${BORD}`, fontFamily: MONO, fontSize: 9, letterSpacing: "0.08em", color: FAINT, textTransform: "uppercase" }}>
                    <span>Amount</span><span>Price</span><span>Wallet</span><span style={{ textAlign: "right" }}>Age</span>
                  </div>
                  <div style={{ maxHeight: 260, overflowY: "auto" }}>
                    {trades.length === 0
                      ? <div style={{ fontFamily: MONO, fontSize: 11, color: FAINT, padding: "18px 12px" }}>waiting for trades…</div>
                      : trades.map((t, i) => (
                        <div key={t.tx + i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 64px", gap: 8, padding: "6px 12px", borderTop: i === 0 ? "none" : `1px solid ${BORD2}`, fontFamily: MONO, fontSize: 11 }}>
                          <span style={{ color: t.kind === "buy" ? POS : NEG }}>{fmtTapeUsd(t.amountUsd)}</span>
                          <span style={{ color: MUT }}>{fmtPrice(t.priceUsd)}</span>
                          <span style={{ color: FAINT }}>{shortAddr(t.wallet)}</span>
                          <span style={{ color: FAINT, textAlign: "right" }}>{fmtAge(t.ts)}</span>
                        </div>
                      ))}
                  </div>
                </div>
              </div>

              {/* ── NEXUS — the read, and the agent you can ask ──────────────────
                  The differentiator vs every other token terminal: a swap page anyone can
                  clone, but not the graded funding verdict beside it, and not an analyst you
                  can interrogate about the thing you're looking at. */}
              <div style={{ background: CARD, border: `1px solid ${BORD}`, borderRadius: 10, padding: 14, marginTop: isMobile ? 12 : 0, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.14em", color: BRIGHT }}>◆ NEXUS</span>
                  {isPerp && <span style={{ fontFamily: MONO, fontSize: 8, letterSpacing: "0.08em", color: FAINT }}>· LISTED MARKET</span>}
                </div>

                {sig ? (() => {
                  const r = nexusReadLabel(sig);
                  return (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", color: r.color, marginBottom: 4 }}>{r.label}</div>
                      <div style={{ fontFamily: UI, fontSize: 11.5, lineHeight: 1.5, color: MUT }}>{r.sub}</div>
                    </div>
                  );
                })() : (
                  <div style={{ fontFamily: UI, fontSize: 11.5, lineHeight: 1.5, color: MUT, marginBottom: 12 }}>
                    {isPerp
                      ? "Reading the funding tape for this market…"
                      : <>Nexus grades funding and positioning on the markets it lists — {pair.baseSymbol} isn’t one, so there’s no graded read to show. Ask below for what can be seen from public data.</>}
                  </div>
                )}

                <button
                  onClick={() => askNexus(isPerp
                    ? `Give me your read on ${pair.baseSymbol} right now — funding, positioning, and whether there's a real edge here. Then the one thing to watch. Be honest if there isn't a setup.`
                    : `What can you tell me about the token ${pair.baseSymbol}${pair.baseAddress ? ` (${pair.baseAddress} on ${pair.chainId})` : ""}? It trades around ${fmtPrice(pair.priceUsd)} with ${fmtUsd(pair.liquidityUsd)} liquidity and ${fmtUsd(pair.volume24h)} 24h volume. Be explicit about what you can and can't verify.`)}
                  className="nx-card-interactive"
                  style={{ width: "100%", fontFamily: MONO, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.04em", color: BRIGHT, background: "none", border: `1px solid #ededf055`, borderRadius: 8, padding: "10px 0", cursor: "pointer" }}
                >Ask Nexus about {pair.baseSymbol} →</button>
              </div>

              {/* trade panel — honest routing, no fake fills */}
              <div style={{ background: CARD, border: `1px solid ${BORD}`, borderRadius: 10, padding: 14 }}>
                {/* collapse toggle — fold the buy/sell panel to give the chart + tape the room */}
                <button onClick={() => setTradeOpen((o) => !o)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", padding: 0, marginBottom: tradeOpen ? 12 : 0, cursor: "pointer" }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: BRIGHT, textTransform: "uppercase" }}>{showPerp ? "Trade · Perp" : "Trade · Spot"}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: MUT }}>{tradeOpen ? "collapse ▾" : "expand ▸"}</span>
                </button>
                {tradeOpen && (<>
                {/* Perp/Spot venue — a listed perp trades BOTH our book AND spot; the toggle picks
                    which. Non-perp tokens are spot only (no toggle). */}
                {isPerp && (
                  <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                    {(["perp", "spot"] as const).map((v) => (
                      <button key={v} onClick={() => setVenue(v)} style={{ flex: 1, fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: venue === v ? BRIGHT : MUT, background: venue === v ? "#ededf015" : "none", border: `1px solid ${venue === v ? "#ededf055" : BORD}`, borderRadius: 7, padding: "7px 0", cursor: "pointer" }}>
                        {v === "perp" ? "Perp · our book" : "Spot"}
                      </button>
                    ))}
                  </div>
                )}

                {/* side — Long/Short on the perp book, Buy/Sell on spot */}
                <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                  {(["buy", "sell"] as const).map((s) => (
                    <button key={s} onClick={() => setSide(s)} style={{ flex: 1, fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: side === s ? "#0a0a0b" : s === "buy" ? POS : NEG, background: side === s ? (s === "buy" ? POS : NEG) : "none", border: `1px solid ${s === "buy" ? POS : NEG}55`, borderRadius: 7, padding: "9px 0", cursor: "pointer" }}>{showPerp ? (s === "buy" ? "Long" : "Short") : s}</button>
                  ))}
                </div>

                {/* amount — USD for a buy / Long / Short; a typed token amount (any size, or MAX) for
                    a SPOT SELL, with 25/50/MAX quick-fills that populate the field. */}
                {isSpotSell ? (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: FAINT, textTransform: "uppercase", marginBottom: 5 }}>
                      <span>Sell amount ({pair.baseSymbol})</span>
                      {held ? <span style={{ color: MUT }}>bal {held.amountLabel}</span> : <span>no balance detected</span>}
                    </div>
                    <input value={sellAmt} onChange={(e) => { setSellAmt(e.target.value.replace(/[^0-9.]/g, "")); setSellMax(false); }} inputMode="decimal" placeholder="0.0"
                      style={{ width: "100%", background: BG, border: `1px solid ${BORD}`, borderRadius: 8, color: BRIGHT, fontFamily: MONO, fontSize: 18, fontWeight: 600, padding: "10px 12px", outline: "none", marginBottom: 8, boxSizing: "border-box" }} />
                    <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                      {[25, 50, 100].map((v) => {
                        const active = v === 100 && sellMax;
                        return (
                          <button key={v} disabled={!held} onClick={() => {
                            if (!held) return;
                            if (v >= 100) { setSellMax(true); setSellAmt(String(held.amount)); }
                            else { setSellMax(false); setSellAmt(String(Number((held.amount * v / 100).toFixed(6)))); }
                          }} style={{ flex: 1, fontFamily: MONO, fontSize: 11, fontWeight: 700, color: active ? "#0a0a0b" : held ? MUT : FAINT, background: active ? NEG : BG, border: `1px solid ${active ? NEG : BORD}`, borderRadius: 6, padding: "7px 0", cursor: held ? "pointer" : "not-allowed" }}>{v === 100 ? "MAX" : `${v}%`}</button>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: FAINT, textTransform: "uppercase", marginBottom: 5 }}>Amount (USD)</div>
                    <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0.00"
                      style={{ width: "100%", background: BG, border: `1px solid ${BORD}`, borderRadius: 8, color: BRIGHT, fontFamily: MONO, fontSize: 18, fontWeight: 600, padding: "10px 12px", outline: "none", marginBottom: 8, boxSizing: "border-box" }} />
                    <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                      {[50, 100, 250, 1000].map((v) => (
                        <button key={v} onClick={() => setAmount(String(v))} style={{ flex: 1, fontFamily: MONO, fontSize: 10, color: MUT, background: BG, border: `1px solid ${BORD}`, borderRadius: 5, padding: "5px 0", cursor: "pointer" }}>${v}</button>
                      ))}
                    </div>
                  </>
                )}

                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 11, color: MUT, marginBottom: 4 }}>
                  <span>Est. {isSpotSell || side === "sell" ? "value" : "output"}</span>
                  <span style={{ color: BRIGHT }}>{isSpotSell
                    ? (sellUsdEst != null ? `~$${sellUsdEst.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—")
                    : (estOut != null ? `${estOut.toLocaleString("en-US", { maximumFractionDigits: estOut >= 1 ? 2 : 6 })} ${pair.baseSymbol}` : "—")}</span>
                </div>

                {/* route-confirmed preview badge (spot only) — a real quote (Jupiter / Fabric) */}
                {showSpot && swapState.kind === "quote" && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, fontFamily: MONO, fontSize: 10.5, color: POS }}>
                    <span>✓ Route via {swapState.quoteRouter}</span>
                    {swapState.impact != null && <span style={{ color: swapState.impact >= 3 ? NEG : MUT }}>~{swapState.impact.toFixed(swapState.impact >= 1 ? 1 : 2)}% impact · ${Math.round(swapState.probeUsd).toLocaleString("en-US")}</span>}
                  </div>
                )}

                {/* ── PERP: Long/Short on our own book ── */}
                {showPerp && route && (
                  <a href={route.href}
                    style={{ display: "block", textAlign: "center", marginTop: 12, fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: "#0a0a0b", background: side === "buy" ? POS : NEG, borderRadius: 9, padding: "13px 0", textDecoration: "none" }}>
                    {side === "buy" ? "Long" : "Short"} {pair.baseSymbol} on Nexus →
                  </a>
                )}

                {/* ── SPOT: in-app buy/sell when we can sign it (Fabric · EVM · wallet), else the
                       honest deep-link. A SELL also needs a detected on-chain balance to size it. ── */}
                {showSpot && (
                  <>
                    {side === "buy" && swapState.kind === "quote" && canInAppBuy && (
                      <>
                        <button onClick={openSwap} disabled={planning}
                          style={{ display: "block", width: "100%", textAlign: "center", marginTop: 8, fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: "#0a0a0b", background: POS, border: "none", borderRadius: 9, padding: "13px 0", cursor: planning ? "wait" : "pointer", opacity: planning ? 0.7 : 1 }}>
                          {planning ? "Building route…" : `Buy ${pair.baseSymbol} in-app →`}
                        </button>
                        <a href={swapState.href} target="_blank" rel="noopener noreferrer"
                          style={{ display: "block", textAlign: "center", marginTop: 8, fontFamily: MONO, fontSize: 10.5, color: MUT, textDecoration: "none" }}>
                          or complete on {swapState.completeVenue} ↗
                        </a>
                      </>
                    )}
                    {side === "sell" && swapState.kind === "quote" && canInAppSell && (
                      <>
                        <button onClick={openSell} disabled={planning}
                          style={{ display: "block", width: "100%", textAlign: "center", marginTop: 8, fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: "#fff", background: NEG, border: "none", borderRadius: 9, padding: "13px 0", cursor: planning ? "wait" : "pointer", opacity: planning ? 0.7 : 1 }}>
                          {planning ? "Building route…" : `Sell ${pair.baseSymbol} in-app →`}
                        </button>
                        <a href={swapState.href} target="_blank" rel="noopener noreferrer"
                          style={{ display: "block", textAlign: "center", marginTop: 8, fontFamily: MONO, fontSize: 10.5, color: MUT, textDecoration: "none" }}>
                          or complete on {swapState.completeVenue} ↗
                        </a>
                      </>
                    )}
                    {/* quote route but no in-app fill (no wallet, non-Fabric, or — for a sell — no
                        detected balance) → the honest deep-link, which fills either direction. */}
                    {swapState.kind === "quote" && !(side === "buy" ? canInAppBuy : canInAppSell) && (
                      <a href={swapState.href} target="_blank" rel="noopener noreferrer"
                        style={{ display: "block", textAlign: "center", marginTop: 8, fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: "#0a0a0b", background: BRIGHT, borderRadius: 9, padding: "13px 0", textDecoration: "none" }}>
                        {side === "sell" ? "Sell" : "Buy"} {pair.baseSymbol} on {swapState.completeVenue} →
                      </a>
                    )}
                    {swapState.kind === "deeplink" && (
                      <a href={swapState.href} target="_blank" rel="noopener noreferrer"
                        style={{ display: "block", textAlign: "center", marginTop: 12, fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: "#0a0a0b", background: BRIGHT, borderRadius: 9, padding: "13px 0", textDecoration: "none" }}>
                        {side === "sell" ? "Sell" : "Swap"} {pair.baseSymbol} on {swapState.venue} →
                      </a>
                    )}
                    {swapState.kind === "noroute" && (
                      <div style={{ textAlign: "center", marginTop: 12, fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: "0.03em", color: FAINT, background: "none", border: `1px solid ${BORD}`, borderRadius: 9, padding: "12px 0", cursor: "not-allowed" }}>
                        No route
                      </div>
                    )}
                    {swapErr && !modalOpen && <div style={{ fontFamily: MONO, fontSize: 10.5, color: NEG, marginTop: 8, textAlign: "center" }}>{swapErr}</div>}
                  </>
                )}

                {/* honesty: where the order actually fills */}
                <div style={{ fontFamily: UI, fontSize: 10.5, lineHeight: 1.5, color: FAINT, marginTop: 10 }}>
                  {showPerp
                    ? <>Nexus lists {pair.baseSymbol} as a perp — trade it here on our book, graded like every Nexus position{isPerp ? <>, or switch to <b style={{ color: MUT }}>Spot</b> to buy/sell the token itself</> : null}.</>
                    : swapState.kind === "quote"
                    ? ((side === "buy" ? canInAppBuy : canInAppSell)
                      ? <>Route + price from <b style={{ color: MUT }}>{swapState.quoteRouter}</b> — you sign the swap in your own wallet (exact-amount approval, minimum-received enforced on-chain). Non-custodial. The read is ours.</>
                      : <>Route + price from <b style={{ color: MUT }}>{swapState.quoteRouter}</b>{side === "sell" && !holdsToken ? <> — connect the wallet holding {pair.baseSymbol} to sell in-app; meanwhile you complete on <b style={{ color: MUT }}>{swapState.completeVenue}</b></> : swapState.completeVenue !== swapState.quoteRouter ? <>; you complete on <b style={{ color: MUT }}>{swapState.completeVenue}</b></> : <> — preview only</>}. The read is ours.</>)
                    : swapState.kind === "deeplink"
                    ? <>Nexus doesn’t run a spot book for {pair.baseSymbol}, so we route you to <b style={{ color: MUT }}>{swapState.venue}</b> where it can fill. The read is ours; the swap is theirs.</>
                    : <>No router quotes {pair.baseSymbol} right now — no honest fill to offer, so we don’t fake it. The read above still stands.</>}
                </div>
                </>)}
              </div>
            </div>

            {/* provenance */}
            <div style={{ fontFamily: MONO, fontSize: 9, color: FAINT, marginTop: 14, letterSpacing: "0.04em" }}>
              Stats + tape from DexScreener &amp; GeckoTerminal · public data · not advice. {pair.url && <a href={pair.url} target="_blank" rel="noopener noreferrer" style={{ color: MUT }}>view pair ↗</a>}
            </div>
          </>
        )}
        </div>
      </div>

      {/* ── swap confirm modal (in-app EVM/Fabric buy) — nothing signs until "Confirm swap" ── */}
      {modalOpen && plan && pair && (
        <div onClick={closeSwap} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 384, background: CARD, border: `1px solid ${BORD}`, borderRadius: 12, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", color: BRIGHT }}>CONFIRM SWAP</span>
              <button onClick={closeSwap} disabled={swapBusy} style={{ background: "none", border: "none", color: swapBusy ? FAINT : MUT, fontSize: 16, cursor: swapBusy ? "default" : "pointer", lineHeight: 1 }}>✕</button>
            </div>

            {(() => {
              // Dir-aware display: BUY = USDC → token; SELL = token → USDC. The plan's guards are
              // identical either way; only the labels flip.
              const isSell = plan.dir === "sell";
              const usdStr = (plan.usd ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
              const payAmt = isSell ? (fmtTokenAmount(plan.amountIn, plan.decimalsIn) ?? "—") : `$${usdStr}`;
              const recvFmt = fmtTokenAmount(plan.outAmount, plan.decimalsOut);
              const recvVal = recvFmt ? (isSell ? `~$${recvFmt}` : `${recvFmt} ${pair.baseSymbol}`) : "—";
              const minFmt = fmtTokenAmount(plan.minOut, plan.decimalsOut);
              const minVal = minFmt ? (isSell ? `~$${minFmt}` : `${minFmt} ${pair.baseSymbol}`) : "—";
              const approveStr = isSell ? `${payAmt} ${pair.baseSymbol}` : `$${usdStr} of USDC`;
              return !swapDone ? (
              <>
                <ModalRow label={isSell ? "You sell" : "You pay"} value={isSell ? `${payAmt} ${pair.baseSymbol}` : payAmt} sub={isSell ? `on ${pair.chainId}` : `${usdStr} USDC · ${pair.chainId}`} />
                {plan.feeBps > 0 && <ModalRow label="Nexus fee" value={`${plan.feeBps} bps`} sub="included in the swap — not added on top" />}
                <ModalRow label="Receive (est.)" value={recvVal} />
                <ModalRow label="Minimum received" value={minVal} sub={slippagePct(plan.outAmount, plan.minOut) != null ? `reverts below this · ≤${slippagePct(plan.outAmount, plan.minOut)!.toFixed(2)}% slippage` : "on-chain slippage floor applies"} accent />
                <ModalRow label="Route" value={plan.router} />
                {plan.priceImpactPct != null && <ModalRow label="Price impact" value={`~${plan.priceImpactPct.toFixed(plan.priceImpactPct >= 1 ? 1 : 2)}%`} danger={plan.priceImpactPct >= 3} />}

                <div style={{ fontFamily: UI, fontSize: 10, lineHeight: 1.5, color: FAINT, margin: "12px 0 14px" }}>
                  You approve <b style={{ color: MUT }}>exactly {approveStr}</b> (never more), then sign the swap — both in your own wallet. Non-custodial: Nexus never holds your funds or keys.
                </div>

                {swapBusy && <div style={{ fontFamily: MONO, fontSize: 11, color: POS, marginBottom: 10, textAlign: "center" }}>{swapStep || "working…"}</div>}
                {swapErr && <div style={{ fontFamily: MONO, fontSize: 11, color: NEG, marginBottom: 10, textAlign: "center" }}>{swapErr}</div>}

                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={closeSwap} disabled={swapBusy} style={{ flex: 1, fontFamily: MONO, fontSize: 12, fontWeight: 700, color: MUT, background: "none", border: `1px solid ${BORD}`, borderRadius: 8, padding: "11px 0", cursor: swapBusy ? "default" : "pointer" }}>Cancel</button>
                  <button onClick={confirmSwap} disabled={swapBusy} style={{ flex: 2, fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: "0.03em", color: "#0a0a0b", background: POS, border: "none", borderRadius: 8, padding: "11px 0", cursor: swapBusy ? "wait" : "pointer", opacity: swapBusy ? 0.7 : 1 }}>{swapBusy ? "Confirming…" : "Confirm swap"}</button>
                </div>
              </>
              ) : (
              <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
                <div style={{ fontSize: 28, marginBottom: 8, color: POS }}>✓</div>
                <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: POS, marginBottom: 6 }}>Swap sent</div>
                <div style={{ fontFamily: UI, fontSize: 11, color: MUT, marginBottom: 14 }}>{isSell ? "Your USDC" : `Your ${pair.baseSymbol}`} lands once it confirms on-chain.</div>

                {/* share-on-swap card — the fact + a link to the token's Spot page. Verdict-only. */}
                <div style={{ background: BG, border: `1px solid ${BORD}`, borderRadius: 8, padding: "10px 12px", marginBottom: 14, textAlign: "left" }}>
                  <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.08em", color: FAINT, marginBottom: 3 }}>{pair.baseSymbol} · {isSell ? "SOLD" : "BOUGHT"} ON NEXUS</div>
                  <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: BRIGHT, marginBottom: 9 }}>{isSell ? `${payAmt} ${pair.baseSymbol} → ${recvVal}` : `${recvFmt ?? "—"} ${pair.baseSymbol}`}</div>
                  <button onClick={copyShare} style={{ width: "100%", fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: "0.03em", color: shareCopied ? POS : BRIGHT, background: "none", border: `1px solid ${shareCopied ? "#3ecf8e88" : BORD}`, borderRadius: 7, padding: "9px 0", cursor: "pointer" }}>
                    {shareCopied ? "✓ Link copied" : `Copy ${pair.baseSymbol} link ↗`}
                  </button>
                </div>

                {explorerTx(plan.chainId, swapDone.hash) && (
                  <a href={explorerTx(plan.chainId, swapDone.hash)!} target="_blank" rel="noopener noreferrer" style={{ fontFamily: MONO, fontSize: 11, color: BRIGHT, textDecoration: "none", display: "inline-block", marginBottom: 14 }}>view transaction ↗</a>
                )}
                <button onClick={closeSwap} style={{ display: "block", width: "100%", fontFamily: MONO, fontSize: 12, fontWeight: 700, color: "#0a0a0b", background: BRIGHT, border: "none", borderRadius: 8, padding: "11px 0", cursor: "pointer" }}>Done</button>
              </div>
              );
            })()}
          </div>
        </div>
      )}
    </>
  );
}
