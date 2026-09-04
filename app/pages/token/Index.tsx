// ── Nexus token terminal (/token) ────────────────────────────────────────────
// A Definitive-style spot terminal: search any token → identity + live stats header,
// a candlestick chart, the live trade tape, and a trade panel. Built on public data
// (DexScreener + GeckoTerminal, client-side) so it works for any token, and HONEST about
// execution — Nexus has no spot venue, so the CTA routes to where an order can actually
// fill: our own perp page when the token is a listed Orderly market, else a deep-link to
// the token's pool. No fake order tabs, no dead "Buy" button.
import { useCallback, useEffect, useMemo, useState } from "react";
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
  fmtUsd, fmtPrice, fmtAge, shortAddr,
  type TokenPair, type Candle, type Trade, type NexusSignal, type SwapQuote,
} from "./data";
import { fetchHoldings, type Holding } from "./holdings";
import { planBuy, executeBuy, explorerTx, fmtTokenAmount, slippagePct, type BuyPlan, type Eip1193 } from "./swapExec";

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
function Chart({ candles, loading, height }: { candles: Candle[]; loading: boolean; height: number }) {
  const box: React.CSSProperties = { width: "100%", height, background: BG, border: `1px solid ${BORD}`, borderRadius: 6 };
  if (!candles.length) {
    return <div style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 11, color: FAINT }}>{loading ? "loading chart…" : "no chart data for this pair"}</div>;
  }
  const W = 800, H = height, PL = 4, PR = 56, PT = 8, PB = 18;
  const plotW = W - PL - PR, plotH = H - PT - PB;
  const lo = Math.min(...candles.map((d) => d.l)), hi = Math.max(...candles.map((d) => d.h)), range = hi - lo || 1;
  const n = candles.length, slot = plotW / n;
  const x = (i: number) => PL + i * slot + slot / 2;
  const y = (v: number) => PT + (1 - (v - lo) / range) * plotH;
  const bodyW = Math.max(1, slot * 0.66);
  const last = candles[candles.length - 1].c;
  const gridVals = [hi, lo + range * 0.5, lo];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={box}>
      {gridVals.map((v, i) => (
        <g key={i}>
          <line x1={PL} x2={PL + plotW} y1={y(v)} y2={y(v)} stroke={BORD2} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
          <text x={PL + plotW + 4} y={y(v) + 3} fill={FAINT} fontSize={9} fontFamily={MONO}>{fmtPrice(v).replace("$", "")}</text>
        </g>
      ))}
      <line x1={PL} x2={PL + plotW} y1={y(last)} y2={y(last)} stroke={MUT} strokeWidth={0.5} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      {candles.map((d, i) => {
        const up = d.c >= d.o;
        const col = up ? POS : NEG;
        const cx = x(i);
        const yTop = Math.min(y(d.o), y(d.c));
        const bh = Math.max(0.8, Math.abs(y(d.c) - y(d.o)));
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={y(d.h)} y2={y(d.l)} stroke={col} strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
            <rect x={cx - bodyW / 2} y={yTop} width={bodyW} height={bh} fill={col} />
          </g>
        );
      })}
    </svg>
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
  const [alts, setAlts] = useState<TokenPair[]>([]);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [tf, setTf] = useState(1); // index into TIMEFRAMES (1H default)
  const [trades, setTrades] = useState<Trade[]>([]);
  const [perpSet, setPerpSet] = useState<Set<string>>(new Set());
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
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
    if (!query) { setPair(null); setAlts([]); setNotFound(false); return; }
    let alive = true;
    setLoading(true); setNotFound(false);
    // independent watchdog: never leave the terminal on a spinner if the fetch hangs
    const paint = setTimeout(() => { if (alive) setLoading(false); }, 6500);
    searchToken(query)
      .then(({ best, alts }) => {
        if (!alive) return;
        setPair(best); setAlts(alts); setNotFound(!best);
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
    if (!pair || isPerp) { setQuote(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      swapQuote(pair, probeUsd).then((q) => { if (alive) setQuote(q); }).catch(() => { if (alive) setQuote(null); });
    }, 450);
    return () => { alive = false; clearTimeout(t); };
  }, [pair, isPerp, probeUsd]);

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
  const swapState = useMemo(() => {
    if (isPerp) return { kind: "perp" as const };
    if (quote && route) return { kind: "quote" as const, href: route.href, quoteRouter: quote.router, completeVenue: route.venue, impact: quote.priceImpactPct, probeUsd: quote.probeUsd };
    if (route && route.href && route.href !== "#") return { kind: "deeplink" as const, href: route.href, venue: route.venue };
    return { kind: "noroute" as const };
  }, [isPerp, quote, route]);
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
  const canInApp = swapState.kind === "quote" && quote?.router === "Fabric" && side === "buy" && !!wallet && !!provider;
  const [plan, setPlan] = useState<BuyPlan | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [swapBusy, setSwapBusy] = useState(false);
  const [swapStep, setSwapStep] = useState("");
  const [swapErr, setSwapErr] = useState<string | null>(null);
  const [swapDone, setSwapDone] = useState<{ hash: string } | null>(null);

  // A changed token/side/amount invalidates a captured plan — close + clear so the modal can
  // never sign against a plan the numbers on screen no longer match.
  useEffect(() => { setModalOpen(false); setPlan(null); setSwapErr(null); setSwapDone(null); }, [pair, side, amount]);

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

  const confirmSwap = useCallback(async () => {
    if (!plan || !wallet || !provider) return;
    setSwapBusy(true); setSwapErr(null); setSwapStep("preparing…");
    try {
      const { swapHash } = await executeBuy(provider, wallet, plan, setSwapStep);
      setSwapDone({ hash: swapHash });
    } catch (e) {
      const m = (e as Error)?.message || "swap failed";
      setSwapErr(
        /insufficient|exceeds balance|transfer amount exceeds/i.test(m) ? "Not enough USDC (+ a little ETH for gas) on this network."
        : /user rejected|user denied|rejected the request|4001/i.test(m) ? "Cancelled in your wallet."
        : m);
    } finally { setSwapBusy(false); setSwapStep(""); }
  }, [plan, wallet, provider]);

  const closeSwap = useCallback(() => {
    if (swapBusy) return; // never yank the modal out from under a pending signature
    setModalOpen(false); setPlan(null); setSwapErr(null); setSwapDone(null);
  }, [swapBusy]);

  const copyCa = useCallback(() => {
    if (!pair?.baseAddress) return;
    try { navigator.clipboard.writeText(pair.baseAddress); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* ignore */ }
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
          <input
            value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="Search any token — symbol, name, or contract address"
            spellCheck={false} autoCapitalize="off" autoCorrect="off"
            style={{ flex: 1, minWidth: 0, background: CARD, border: `1px solid ${BORD}`, borderRadius: 8, color: BRIGHT, fontFamily: MONO, fontSize: 13, padding: "11px 14px", outline: "none" }}
          />
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

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {pair.baseAddress && (
                  <button onClick={copyCa} title="Copy contract address" style={{ display: "flex", alignItems: "center", gap: 5, background: BG, border: `1px solid ${BORD}`, borderRadius: 6, color: MUT, fontFamily: MONO, fontSize: 10, padding: "6px 9px", cursor: "pointer" }}>
                    <span>{copied ? "copied ✓" : shortAddr(pair.baseAddress)}</span>
                  </button>
                )}
                {pair.websites[0] && <a href={pair.websites[0]} target="_blank" rel="noopener noreferrer" style={{ fontFamily: MONO, fontSize: 11, color: MUT, textDecoration: "none", border: `1px solid ${BORD}`, borderRadius: 6, padding: "6px 9px" }}>web ↗</a>}
                {pair.socials.filter((s) => /twitter|x/i.test(s.type)).slice(0, 1).map((s) => <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: MONO, fontSize: 11, color: MUT, textDecoration: "none", border: `1px solid ${BORD}`, borderRadius: 6, padding: "6px 9px" }}>𝕏 ↗</a>)}
              </div>
            </div>

            {/* did-you-mean (ambiguous ticker) */}
            {alts.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, textTransform: "uppercase", letterSpacing: "0.08em" }}>Other pairs</span>
                {alts.map((a) => (
                  <button key={a.pairAddress} onClick={() => { setPair(a); setAlts((prev) => [pair, ...prev.filter((p) => p.pairAddress !== a.pairAddress)].slice(0, 4)); }}
                    style={{ fontFamily: MONO, fontSize: 10, color: MUT, background: CARD, border: `1px solid ${BORD}`, borderRadius: 6, padding: "5px 9px", cursor: "pointer" }}>
                    {a.baseSymbol}/{a.quoteSymbol} · {a.chainId} · {fmtUsd(a.liquidityUsd)}
                  </button>
                ))}
              </div>
            )}

            {/* body: chart + tape (left) · trade panel (right) */}
            <div style={{ display: isMobile ? "block" : "grid", gridTemplateColumns: "1fr 320px", gap: 12, alignItems: "start" }}>
              <div style={{ minWidth: 0 }}>
                {/* chart + timeframe */}
                <div style={{ background: CARD, border: `1px solid ${BORD}`, borderRadius: 10, padding: 10, marginBottom: 12 }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                    {TIMEFRAMES.map((t, i) => (
                      <button key={t.label} onClick={() => setTf(i)} style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", color: i === tf ? BRIGHT : FAINT, background: i === tf ? BG : "none", border: `1px solid ${i === tf ? BORD : "transparent"}`, borderRadius: 5, padding: "4px 9px", cursor: "pointer" }}>{t.label}</button>
                    ))}
                    <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, color: FAINT, alignSelf: "center" }}>chart · GeckoTerminal</span>
                  </div>
                  <Chart candles={candles} loading={chartLoading} height={isMobile ? 220 : 340} />
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
                          <span style={{ color: t.kind === "buy" ? POS : NEG }}>{fmtUsd(t.amountUsd)}</span>
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
                <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                  {(["buy", "sell"] as const).map((s) => (
                    <button key={s} onClick={() => setSide(s)} style={{ flex: 1, fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: side === s ? "#0a0a0b" : s === "buy" ? POS : NEG, background: side === s ? (s === "buy" ? POS : NEG) : "none", border: `1px solid ${s === "buy" ? POS : NEG}55`, borderRadius: 7, padding: "9px 0", cursor: "pointer" }}>{isPerp ? (s === "buy" ? "Long" : "Short") : s}</button>
                  ))}
                </div>

                <div style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: FAINT, textTransform: "uppercase", marginBottom: 5 }}>Amount (USD)</div>
                <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0.00"
                  style={{ width: "100%", background: BG, border: `1px solid ${BORD}`, borderRadius: 8, color: BRIGHT, fontFamily: MONO, fontSize: 18, fontWeight: 600, padding: "10px 12px", outline: "none", marginBottom: 8, boxSizing: "border-box" }} />
                <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                  {[50, 100, 250, 1000].map((v) => (
                    <button key={v} onClick={() => setAmount(String(v))} style={{ flex: 1, fontFamily: MONO, fontSize: 10, color: MUT, background: BG, border: `1px solid ${BORD}`, borderRadius: 5, padding: "5px 0", cursor: "pointer" }}>${v}</button>
                  ))}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 11, color: MUT, marginBottom: 4 }}>
                  <span>Est. {side === "buy" ? "output" : "value"}</span>
                  <span style={{ color: BRIGHT }}>{estOut != null ? `${estOut.toLocaleString("en-US", { maximumFractionDigits: estOut >= 1 ? 2 : 6 })} ${pair.baseSymbol}` : "—"}</span>
                </div>

                {/* route-confirmed preview badge — a real quote (Jupiter / Fabric), not price math */}
                {swapState.kind === "quote" && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, fontFamily: MONO, fontSize: 10.5, color: POS }}>
                    <span>✓ Route via {swapState.quoteRouter}</span>
                    {swapState.impact != null && <span style={{ color: swapState.impact >= 3 ? NEG : MUT }}>~{swapState.impact.toFixed(swapState.impact >= 1 ? 1 : 2)}% impact · ${Math.round(swapState.probeUsd).toLocaleString("en-US")}</span>}
                  </div>
                )}

                {swapState.kind === "perp" && route && (
                  <a href={route.href}
                    style={{ display: "block", textAlign: "center", marginTop: 12, fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: "#0a0a0b", background: side === "buy" ? POS : NEG, borderRadius: 9, padding: "13px 0", textDecoration: "none" }}>
                    {side === "buy" ? "Long" : "Short"} {pair.baseSymbol} on Nexus →
                  </a>
                )}
                {/* in-app swap when we can sign it (Fabric · buy · wallet); the deep-link stays,
                    demoted to a secondary line, so there's always the honest fallback. */}
                {swapState.kind === "quote" && canInApp && (
                  <>
                    <button onClick={openSwap} disabled={planning}
                      style={{ display: "block", width: "100%", textAlign: "center", marginTop: 8, fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: "#0a0a0b", background: POS, border: "none", borderRadius: 9, padding: "13px 0", cursor: planning ? "wait" : "pointer", opacity: planning ? 0.7 : 1 }}>
                      {planning ? "Building route…" : `Swap ${pair.baseSymbol} in-app →`}
                    </button>
                    <a href={swapState.href} target="_blank" rel="noopener noreferrer"
                      style={{ display: "block", textAlign: "center", marginTop: 8, fontFamily: MONO, fontSize: 10.5, color: MUT, textDecoration: "none" }}>
                      or complete on {swapState.completeVenue} ↗
                    </a>
                    {swapErr && !modalOpen && <div style={{ fontFamily: MONO, fontSize: 10.5, color: NEG, marginTop: 8, textAlign: "center" }}>{swapErr}</div>}
                  </>
                )}
                {swapState.kind === "quote" && !canInApp && (
                  <a href={swapState.href} target="_blank" rel="noopener noreferrer"
                    style={{ display: "block", textAlign: "center", marginTop: 8, fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: "#0a0a0b", background: BRIGHT, borderRadius: 9, padding: "13px 0", textDecoration: "none" }}>
                    Swap {pair.baseSymbol} on {swapState.completeVenue} →
                  </a>
                )}
                {swapState.kind === "deeplink" && (
                  <a href={swapState.href} target="_blank" rel="noopener noreferrer"
                    style={{ display: "block", textAlign: "center", marginTop: 12, fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: "#0a0a0b", background: BRIGHT, borderRadius: 9, padding: "13px 0", textDecoration: "none" }}>
                    Swap {pair.baseSymbol} on {swapState.venue} →
                  </a>
                )}
                {swapState.kind === "noroute" && (
                  <div style={{ textAlign: "center", marginTop: 12, fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: "0.03em", color: FAINT, background: "none", border: `1px solid ${BORD}`, borderRadius: 9, padding: "12px 0", cursor: "not-allowed" }}>
                    No route
                  </div>
                )}

                {/* honesty: where the order actually fills */}
                <div style={{ fontFamily: UI, fontSize: 10.5, lineHeight: 1.5, color: FAINT, marginTop: 10 }}>
                  {swapState.kind === "perp"
                    ? <>Nexus lists {pair.baseSymbol} as a perp — you trade it here, on our book, graded like every Nexus position.</>
                    : swapState.kind === "quote"
                    ? (canInApp
                      ? <>Route + price from <b style={{ color: MUT }}>{swapState.quoteRouter}</b> — you sign the swap in your own wallet (exact-amount approval, minimum-received enforced on-chain). Non-custodial. The read is ours.</>
                      : <>Route + price from <b style={{ color: MUT }}>{swapState.quoteRouter}</b>{swapState.completeVenue !== swapState.quoteRouter ? <>; you complete on <b style={{ color: MUT }}>{swapState.completeVenue}</b> until in-app swap lands</> : <> — preview only, in-app signing is coming</>}. The read is ours.</>)
                    : swapState.kind === "deeplink"
                    ? <>Nexus doesn’t run a spot book for {pair.baseSymbol}, so we route you to <b style={{ color: MUT }}>{swapState.venue}</b> where it can fill. The read is ours; the swap is theirs.</>
                    : <>No router quotes {pair.baseSymbol} right now — no honest fill to offer, so we don’t fake a Buy. The read above still stands.</>}
                </div>
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

            {!swapDone ? (
              <>
                <ModalRow label="You pay" value={`$${plan.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} sub={`${plan.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC · ${pair.chainId}`} />
                <ModalRow label="Receive (est.)" value={fmtTokenAmount(plan.outAmount, plan.decimals) ? `${fmtTokenAmount(plan.outAmount, plan.decimals)} ${pair.baseSymbol}` : "—"} />
                <ModalRow label="Minimum received" value={fmtTokenAmount(plan.minOut, plan.decimals) ? `${fmtTokenAmount(plan.minOut, plan.decimals)} ${pair.baseSymbol}` : "—"} sub={slippagePct(plan.outAmount, plan.minOut) != null ? `reverts below this · ≤${slippagePct(plan.outAmount, plan.minOut)!.toFixed(2)}% slippage` : "on-chain slippage floor applies"} accent />
                <ModalRow label="Route" value={plan.router} />
                {plan.priceImpactPct != null && <ModalRow label="Price impact" value={`~${plan.priceImpactPct.toFixed(plan.priceImpactPct >= 1 ? 1 : 2)}%`} danger={plan.priceImpactPct >= 3} />}

                <div style={{ fontFamily: UI, fontSize: 10, lineHeight: 1.5, color: FAINT, margin: "12px 0 14px" }}>
                  You approve <b style={{ color: MUT }}>exactly ${plan.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b> of USDC (never more), then sign the swap — both in your own wallet. Non-custodial: Nexus never holds your funds or keys.
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
                <div style={{ fontFamily: UI, fontSize: 11, color: MUT, marginBottom: 14 }}>Your {pair.baseSymbol} lands once it confirms on-chain.</div>
                {explorerTx(plan.chainId, swapDone.hash) && (
                  <a href={explorerTx(plan.chainId, swapDone.hash)!} target="_blank" rel="noopener noreferrer" style={{ fontFamily: MONO, fontSize: 11, color: BRIGHT, textDecoration: "none", display: "inline-block", marginBottom: 14 }}>view transaction ↗</a>
                )}
                <button onClick={closeSwap} style={{ display: "block", width: "100%", fontFamily: MONO, fontSize: 12, fontWeight: 700, color: "#0a0a0b", background: BRIGHT, border: "none", borderRadius: 8, padding: "11px 0", cursor: "pointer" }}>Done</button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
