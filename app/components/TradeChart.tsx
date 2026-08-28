/**
 * TradeChart — a rich, snappy candlestick grid chart for the Quick Trade ticket.
 *
 * Dependency-free (public Orderly /tv/history OHLC → SVG), in the terminal aesthetic.
 * Beyond a sparkline: grid + right price axis + time axis + volume strip + a hover
 * crosshair with an OHLC readout, plus DRAG-to-pan / WHEEL-to-zoom / ± buttons over a
 * visible window (like the full terminal chart), plus two overlay layers that make it
 * ours —
 *   • GRADED CALL markers: every public thesis on this coin, plotted at its entry
 *     price and time with the caller's pfp + a LONG/SHORT ring (verifiable calls,
 *     not self-reported buys).
 *   • YOUR position: the open avg-entry as a dashed line + tag.
 * Fail-soft throughout; markers/positions are optional layers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const ORDERLY_API = "https://api-evm.orderly.org";
const AGENT_API = "https://og.nexustradinglabs.com";
const MONO = "var(--nx-font-mono)";
const POS = "#3ecf8e", NEG = "#f7525f", GRID = "#ffffff10", BORDER = "#232327", MUTED = "#71717a", FAINT = "#52525b", BONE = "#f4f4f5";

const bare = (s: string) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Call = { wallet: string; pfp: string | null; displayName: string | null; direction: "LONG" | "SHORT"; entry: number; t: number; _coin: string };
// Estimated pending-liquidation cluster: price level, weighted magnitude, dominant side.
type LiqCluster = { price: number; mag: number; side: string };
// Orderly's /tv/history supports resolutions 1, 5, 15, 30, 60, D (NOT 240 → no_data).
// Shared with the ProjectionBand so a timeframe click drives BOTH: `hours` = the chart
// lookback window, `projH` = the projection's forward settle horizon.
export const CHART_TFS = [
  { k: "5m",  res: "5",  hours: 12,  projH: 6 },
  { k: "30m", res: "30", hours: 48,  projH: 18 },
  { k: "1H",  res: "60", hours: 120, projH: 36 },
  { k: "1D",  res: "15", hours: 24,  projH: 24 },
  { k: "3D",  res: "60", hours: 72,  projH: 72 },
  { k: "1W",  res: "60", hours: 168, projH: 168 },
] as const;
const TFS = CHART_TFS;
const MIN_CANDLES = 12;

// Moving-average overlays (SMA of close). Neutral analytical tints only — brightness =
// speed (fast MA brightest); never the reserved green/red/amber semantics. 150 is the
// longest, so we fetch that many warmup bars BEFORE the display window (see the fetch).
const MA_DEFS = [
  { p: 20, c: "#ededf0" },
  { p: 50, c: "#9aa2b4" },
  { p: 150, c: "#646b7d" },
] as const;
const MA_MAX = 150;

const fmtPx = (v: number) => (v >= 1000 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(4)}`);

// Small avatar with monogram fallback (mirrors the Feed avatar; no external dep).
function CallAvatar({ pfp, name, ring, size = 20 }: { pfp: string | null; name: string | null; ring: string; size?: number }) {
  const [err, setErr] = useState(false);
  const initial = (name || "◆").slice(0, 1).toUpperCase();
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", border: `1.5px solid ${ring}`, background: "#141416", boxShadow: `0 0 0 2px #0a0a0b`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {pfp && !err
        ? <img src={pfp} alt="" referrerPolicy="no-referrer" onError={() => setErr(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        : <span style={{ fontFamily: MONO, fontSize: size * 0.5, color: ring, fontWeight: 700 }}>{initial}</span>}
    </div>
  );
}

export function TradeChart({ symbol, height = 240, positionEntry, tfIndex, onTf, fill }: { symbol: string; height?: number; positionEntry?: { entry: number; side: "LONG" | "SHORT" } | null; tfIndex?: number; onTf?: (i: number) => void; fill?: boolean }) {
  const coin = bare(symbol);
  const [vh, setVh] = useState(height); // measured height when fill=true (fills its flex column)
  // Controlled (Quick Trade drives it to sync the projection) or self-managed.
  const controlled = typeof tfIndex === "number";
  const [tfState, setTfState] = useState(2); // default 1H
  const tf = controlled ? (tfIndex as number) : tfState;
  const setTf = (i: number) => { if (onTf) onTf(i); if (!controlled) setTfState(i); };
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [allCalls, setAllCalls] = useState<Call[]>([]);
  const [liq, setLiq] = useState<{ below: LiqCluster[]; above: LiqCluster[]; currentPrice: number } | null>(null);
  const [showLiq, setShowLiq] = useState(true);
  const [showMA, setShowMA] = useState(true);
  const [hover, setHover] = useState<number | null>(null); // index into VISIBLE slice
  const [vp, setVp] = useState<{ lo: number; hi: number } | null>(null); // visible window into candles; null = all
  const svgRef = useRef<SVGSVGElement>(null);
  const vpRef = useRef<{ lo: number; hi: number } | null>(null);
  const dragRef = useRef<{ startX: number; lo: number; hi: number; moved: boolean } | null>(null);
  const [width, setWidth] = useState(430);
  useEffect(() => { vpRef.current = vp; }, [vp]);

  // ⚠️ CALLBACK ref (not an effect+useRef) so the ResizeObserver attaches to whichever div
  // is actually mounted — the loading/failed placeholders OR the real chart. The old effect
  // ran once at mount while the "loading chart…" placeholder (which had NO ref) was showing,
  // so wrapRef was null, the observer bailed, and width stayed frozen at its 430 default →
  // the SVG rendered ~430px wide in a much wider card = a big black void on the right (the
  // dead space). A callback ref fires on every mount/unmount, so measurement can never be
  // stranded on a placeholder again. Same failure class as ProjectionBand's frozen height.
  const roRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); if (r.width > 0) setWidth(r.width); if (r.height > 80) setVh(r.height); };
    const ro = new ResizeObserver(measure);
    ro.observe(el); measure();
    roRef.current = ro;
  }, []);

  // OHLC for the selected timeframe. Resets zoom/pan on any reload.
  useEffect(() => {
    let off = false;
    setCandles(null); setFailed(false); setHover(null); setVp(null);
    const now = Math.floor(Date.now() / 1000);
    const { res, hours } = TFS[tf];
    // Fetch MA_MAX extra bars of WARMUP before the display window so the long MAs (up to
    // 150) are defined across the whole visible range; we still DEFAULT the view to the
    // intended recent `hours`. Warmup hours = MA_MAX × the bar size, capped so we never
    // over-fetch a fast timeframe.
    const resHours = Number(res) / 60;
    const warmupHours = Math.min(360, Math.round(MA_MAX * resHours));
    const displayBars = Math.max(MIN_CANDLES, Math.round(hours / resHours));
    fetch(`${ORDERLY_API}/tv/history?symbol=${symbol}&resolution=${res}&from=${now - (hours + warmupHours) * 3600}&to=${now}`, { headers: { accept: "application/json" } })
      .then((r) => r.json())
      .then((j) => {
        if (off) return;
        if (j?.s === "ok" && Array.isArray(j.c) && j.c.length > 1) {
          const arr = j.c.map((c: number, i: number) => ({ t: Number(j.t[i]) * 1000, o: Number(j.o[i]), h: Number(j.h[i]), l: Number(j.l[i]), c: Number(c), v: Number(j.v?.[i]) || 0 }));
          setCandles(arr);
          // Default the viewport to the recent display window; the warmup bars sit off to the
          // left to DRAG back to (TradingView-style). ⤢ reset shows everything incl. warmup.
          const nn = arr.length, vis = Math.min(nn, displayBars);
          setVp(nn > vis + 2 ? { lo: nn - vis, hi: nn - 1 } : null);
        } else setFailed(true);
      })
      .catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [symbol, tf]);

  // Public graded calls (fetched once) → filtered to this coin + window below.
  useEffect(() => {
    let off = false;
    fetch(`${AGENT_API}/feed`).then((r) => r.json())
      .then((d) => {
        if (off) return;
        const rows = (Array.isArray(d) ? d : d?.feed ?? d?.items ?? []) as Record<string, unknown>[];
        const calls: Call[] = rows.map((t) => ({
          wallet: String(t.wallet || ""), pfp: (t.pfp as string) ?? null, displayName: (t.displayName as string) ?? null,
          direction: (t.direction === "SHORT" ? "SHORT" : "LONG") as "LONG" | "SHORT",
          entry: Number(t.entryPrice ?? t.entry_price ?? 0),
          t: Number(t.createdAt ?? t.created_at ?? 0),
          _coin: bare(String(t.symbol || "")),
        })).filter((c) => c._coin && c.entry > 0 && c.t > 0);
        setAllCalls(calls);
      })
      .catch(() => { if (!off) setAllCalls([]); });
    return () => { off = true; };
  }, []);

  // Estimated pending-liquidation clusters (same source as THE READ's liq-magnet-pull axis).
  useEffect(() => {
    let off = false; setLiq(null);
    fetch(`${AGENT_API}/intel/liqmap/${coin}`).then((r) => r.json())
      .then((d) => { if (!off && d?.available && d.currentPrice > 0) setLiq({ below: d.below || [], above: d.above || [], currentPrice: Number(d.currentPrice) }); })
      .catch(() => { if (!off) setLiq(null); });
    return () => { off = true; };
  }, [coin]);

  // ── layout ───────────────────────────────────────────────────────────────
  const chartH = fill ? vh : height; // draw at the measured height when filling a flex column
  const RPAD = 52, LPAD = 6, TOP = 8, TIMEH = 16, VOLH = 30, GAP = 6;
  const priceBottom = chartH - TIMEH - VOLH - GAP;
  const volTop = priceBottom + GAP, volBottom = chartH - TIMEH;
  const plotW = Math.max(60, width - LPAD - RPAD);

  const n = candles?.length ?? 0;
  const lo = vp ? vp.lo : 0;
  const hi = vp ? vp.hi : Math.max(0, n - 1);
  const visible = useMemo(() => (candles ? candles.slice(lo, hi + 1) : []), [candles, lo, hi]);

  // Wheel-to-zoom (native, non-passive so we can preventDefault). Anchors at the cursor.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !candles) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const nn = candles.length;
      const cur = vpRef.current;
      const curLo = cur ? cur.lo : 0, curHi = cur ? cur.hi : nn - 1;
      const count = curHi - curLo + 1;
      const rect = svg.getBoundingClientRect();
      const slot = plotW / count;
      const idx = curLo + Math.max(0, Math.min(count - 1, Math.round((e.clientX - rect.left - LPAD) / slot)));
      let newCount = Math.round(count * (e.deltaY > 0 ? 1.22 : 0.82));
      newCount = Math.max(MIN_CANDLES, Math.min(nn, newCount));
      if (newCount >= nn) { setVp(null); return; }
      const rel = count > 1 ? (idx - curLo) / (count - 1) : 0.5;
      let newLo = Math.round(idx - rel * (newCount - 1));
      newLo = Math.max(0, Math.min(nn - newCount, newLo));
      setVp({ lo: newLo, hi: newLo + newCount - 1 });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [candles, plotW]);

  const view = useMemo(() => {
    if (!visible || visible.length < 2) return null;
    const m = visible.length;
    const min = Math.min(...visible.map((d) => d.l)), max = Math.max(...visible.map((d) => d.h));
    const range = max - min || 1;
    const maxVol = Math.max(...visible.map((d) => d.v), 1);
    const slot = plotW / m;
    const x = (i: number) => LPAD + i * slot + slot / 2;
    const y = (v: number) => TOP + (1 - (v - min) / range) * (priceBottom - TOP);
    const vy = (v: number) => volBottom - (v / maxVol) * (volBottom - volTop);
    const bodyW = Math.max(1.2, slot * 0.62);
    const t0 = visible[0].t, t1 = visible[m - 1].t, tspan = t1 - t0 || 1;
    const xOfTime = (ms: number) => LPAD + ((ms - t0) / tspan) * plotW;
    return { m, min, max, range, slot, x, y, vy, bodyW, t0, t1, tspan, xOfTime, last: visible[m - 1] };
  }, [visible, plotW, priceBottom, volTop, volBottom]);

  const calls = useMemo(() => {
    if (!view) return [] as Call[];
    return allCalls.filter((c) => c._coin === coin && c.t >= view.t0 && c.t <= view.t1)
      .sort((a, b) => a.t - b.t).slice(0, 16);
  }, [allCalls, coin, view]);

  // SMA(close) per MA period, aligned to the FULL candle array (warmup included) so each
  // MA is defined from its period onward — a rolling sum, O(n). null before enough bars.
  const maFull = useMemo(() => {
    if (!candles) return null;
    const out: Record<number, (number | null)[]> = {};
    for (const { p } of MA_DEFS) {
      const arr: (number | null)[] = new Array(candles.length).fill(null);
      let sum = 0;
      for (let i = 0; i < candles.length; i++) {
        sum += candles[i].c;
        if (i >= p) sum -= candles[i - p].c;
        if (i >= p - 1) arr[i] = sum / p;
      }
      out[p] = arr;
    }
    return out;
  }, [candles]);

  const box: React.CSSProperties = { width: "100%", background: "#0a0a0b", border: `1px solid ${BORDER}`, borderRadius: 6, position: "relative", overflow: "hidden", userSelect: "none", ...(fill ? { flex: 1, minHeight: height } : { height }) };
  // ⚠️ ref={measureRef} on the placeholders TOO — so the width/height observer attaches
  // immediately and the SVG is sized to the real card from the very first paint (no 430px
  // default leaking through as right-side dead space).
  if (failed) return <div ref={measureRef} style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 10, color: FAINT }}>chart unavailable</div>;
  if (!candles || !view) return <div ref={measureRef} style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 10, color: FAINT }}>loading chart…</div>;

  const { min, max, x, y, vy, bodyW, last } = view;
  const priceLevels = [0, 0.25, 0.5, 0.75, 1].map((f) => min + (max - min) * f);
  const lastUp = last.c >= last.o;
  const hc = hover != null && hover < visible.length ? visible[hover] : null;
  const posY = positionEntry && positionEntry.entry >= min && positionEntry.entry <= max ? y(positionEntry.entry) : null;

  // Moving-average polylines over the visible slice (value at visible i = maFull[p][lo+i]).
  // Clipped to the price plot area so a long MA that dips below the window doesn't bleed
  // into the volume strip. `last` = the current MA value for the legend readout.
  const maLines = (showMA && maFull) ? MA_DEFS.map(({ p, c }) => {
    let d = "", started = false;
    for (let i = 0; i < visible.length; i++) {
      const v = maFull[p][lo + i];
      if (v == null) continue;
      d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      started = true;
    }
    return { p, c, d, last: maFull[p][hi] };
  }).filter((m) => m.d) : [];

  // Liquidation clusters within the visible price range → magnitude bars from the right axis.
  // long-liq clusters sit BELOW price (downside magnet, red); short-liq ABOVE (upside, green).
  const liqBands = (showLiq && liq ? [
    ...(liq.below || []).map((c) => ({ ...c, dir: "long" as const })),
    ...(liq.above || []).map((c) => ({ ...c, dir: "short" as const })),
  ].filter((c) => Number.isFinite(c.price) && c.price >= min && c.price <= max && (Number(c.mag) || 0) > 0) : []);
  const maxLiqMag = Math.max(...liqBands.map((c) => Number(c.mag) || 0), 1);
  const liqRects = liqBands.map((c) => ({ dir: c.dir, price: c.price, yy: y(c.price), w: Math.max(10, (Number(c.mag) / maxLiqMag) * plotW * 0.42) }));
  const topLong = liqRects.filter((b) => b.dir === "long").sort((a, b) => b.w - a.w)[0];
  const topShort = liqRects.filter((b) => b.dir === "short").sort((a, b) => b.w - a.w)[0];

  const timeLabels = [0, 0.34, 0.67, 1].map((f) => {
    const i = Math.round(f * (view.m - 1));
    const d = new Date(visible[i].t);
    const lab = TFS[tf].hours <= 24 ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : `${d.getMonth() + 1}/${d.getDate()}`;
    return { x: x(i), lab };
  });

  // zoom helpers (buttons)
  const applyZoom = (factor: number) => {
    const curLo = vp ? vp.lo : 0, curHi = vp ? vp.hi : n - 1;
    const count = curHi - curLo + 1;
    let newCount = Math.max(MIN_CANDLES, Math.min(n, Math.round(count * factor)));
    if (newCount >= n) { setVp(null); return; }
    const center = (curLo + curHi) / 2;
    let newLo = Math.round(center - newCount / 2);
    newLo = Math.max(0, Math.min(n - newCount, newLo));
    setVp({ lo: newLo, hi: newLo + newCount - 1 });
  };

  const btn: React.CSSProperties = { width: 20, height: 18, display: "flex", alignItems: "center", justifyContent: "center", background: "#0f0f11cc", border: `1px solid ${BORDER}`, borderRadius: 3, cursor: "pointer", color: MUTED, fontFamily: MONO, fontSize: 12, lineHeight: 1 };

  return (
    <div ref={measureRef} style={box}>
      {/* timeframe toggle */}
      <div style={{ position: "absolute", top: 7, left: 8, zIndex: 3, display: "flex", gap: 4 }}>
        {TFS.map((t, i) => (
          <button key={t.k} onClick={() => setTf(i)} style={{
            background: tf === i ? "#ededf015" : "transparent", border: `1px solid ${tf === i ? "#ededf055" : BORDER}`, borderRadius: 3,
            padding: "2px 7px", cursor: "pointer", color: tf === i ? "#ededf0" : MUTED, fontFamily: MONO, fontSize: 9,
          }}>{t.k}</button>
        ))}
      </div>

      {/* zoom controls */}
      <div style={{ position: "absolute", top: 7, right: 8, zIndex: 3, display: "flex", gap: 4 }}>
        <button title="Toggle moving averages (20 / 50 / 150)" onClick={() => setShowMA((s) => !s)} style={{ ...btn, width: "auto", padding: "0 6px", fontSize: 9, color: showMA ? BONE : MUTED, borderColor: showMA ? "#ededf055" : BORDER }}>MA</button>
        <button title="Toggle estimated liquidation clusters" onClick={() => setShowLiq((s) => !s)} style={{ ...btn, width: "auto", padding: "0 6px", color: showLiq ? "#e0a458" : MUTED, borderColor: showLiq ? "#3a3320" : BORDER }}>⚡</button>
        <button title="Zoom in" onClick={() => applyZoom(0.7)} style={btn}>+</button>
        <button title="Zoom out" onClick={() => applyZoom(1.4)} style={btn}>−</button>
        <button title="Reset" onClick={() => setVp(null)} style={{ ...btn, fontSize: 10, opacity: vp ? 1 : 0.5 }}>⤢</button>
      </div>

      {/* MA legend — current values (top-left, below the timeframe row). */}
      {maLines.length > 0 && (
        <div style={{ position: "absolute", top: 26, left: 8, zIndex: 3, display: "flex", gap: 10, fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.02em", pointerEvents: "none" }}>
          {maLines.map((m) => (
            <span key={m.p} style={{ color: m.c }}>MA{m.p} {m.last != null ? fmtPx(m.last) : "—"}</span>
          ))}
        </div>
      )}

      <svg ref={svgRef} width={width} height={chartH} style={{ display: "block", position: "absolute", top: 0, left: 0, cursor: dragRef.current ? "grabbing" : "crosshair" }}
        onMouseDown={(e) => { dragRef.current = { startX: e.clientX, lo, hi, moved: false }; }}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const d = dragRef.current;
          if (d) {
            const dxCandles = Math.round((e.clientX - d.startX) / view.slot);
            if (dxCandles !== 0) {
              d.moved = true;
              const count = d.hi - d.lo + 1;
              let newLo = d.lo - dxCandles;
              newLo = Math.max(0, Math.min(n - count, newLo));
              if (newLo !== lo) setVp({ lo: newLo, hi: newLo + count - 1 });
            }
            setHover(null);
          } else {
            const i = Math.round((e.clientX - rect.left - LPAD - view.slot / 2) / view.slot);
            setHover(Math.max(0, Math.min(view.m - 1, i)));
          }
        }}
        onMouseUp={() => { dragRef.current = null; }}
        onMouseLeave={() => { dragRef.current = null; setHover(null); }}>

        <defs>
          <clipPath id={`price-clip-${coin}`}>
            <rect x={LPAD} y={TOP} width={plotW} height={Math.max(0, priceBottom - TOP)} />
          </clipPath>
        </defs>

        {/* horizontal grid + price axis labels */}
        {priceLevels.map((p, i) => (
          <g key={i}>
            <line x1={LPAD} x2={LPAD + plotW} y1={y(p)} y2={y(p)} stroke={GRID} strokeWidth={1} />
            <text x={width - RPAD + 6} y={y(p) + 3} fontFamily={MONO} fontSize={9} fill={FAINT}>{fmtPx(p)}</text>
          </g>
        ))}
        {/* vertical gridlines at time labels */}
        {timeLabels.map((t, i) => (
          <g key={i}>
            <line x1={t.x} x2={t.x} y1={TOP} y2={priceBottom} stroke={GRID} strokeWidth={1} />
            <text x={t.x} y={chartH - 4} fontFamily={MONO} fontSize={9} fill={FAINT} textAnchor="middle">{t.lab}</text>
          </g>
        ))}

        {/* candles + volume */}
        {visible.map((d, i) => {
          const up = d.c >= d.o;
          const col = up ? POS : NEG;
          const cx = x(i);
          const yTop = Math.min(y(d.o), y(d.c));
          const bh = Math.max(0.8, Math.abs(y(d.c) - y(d.o)));
          return (
            <g key={i} opacity={hover != null && hover !== i ? 0.85 : 1}>
              <line x1={cx} x2={cx} y1={y(d.h)} y2={y(d.l)} stroke={col} strokeWidth={1} />
              <rect x={cx - bodyW / 2} y={yTop} width={bodyW} height={bh} fill={col} />
              <rect x={cx - bodyW / 2} y={vy(d.v)} width={bodyW} height={Math.max(0.5, volBottom - vy(d.v))} fill={col} opacity={0.3} />
            </g>
          );
        })}

        {/* moving averages — over the candles, clipped to the price plot area */}
        {maLines.length > 0 && (
          <g clipPath={`url(#price-clip-${coin})`}>
            {maLines.map((m) => (
              <path key={m.p} d={m.d} fill="none" stroke={m.c} strokeWidth={m.p === 20 ? 1.4 : 1.1} strokeLinejoin="round" strokeLinecap="round" opacity={0.95} />
            ))}
          </g>
        )}

        {/* liquidation clusters — magnitude bars anchored at the right axis + a level line */}
        {liqRects.map((b, i) => {
          const col = b.dir === "long" ? NEG : POS;
          const xRight = LPAD + plotW;
          return (
            <g key={`liq-${i}`}>
              <rect x={xRight - b.w} y={b.yy - 4} width={b.w} height={8} fill={col} opacity={0.13} />
              <line x1={LPAD} x2={xRight} y1={b.yy} y2={b.yy} stroke={col} strokeWidth={0.8} strokeDasharray="2 5" opacity={0.4} />
            </g>
          );
        })}
        {topLong && <text x={LPAD + plotW - topLong.w - 5} y={topLong.yy - 4} fontFamily={MONO} fontSize={8} fill={NEG} textAnchor="end" opacity={0.85}>long-liq ▼ {fmtPx(topLong.price)}</text>}
        {topShort && <text x={LPAD + plotW - topShort.w - 5} y={topShort.yy + 9} fontFamily={MONO} fontSize={8} fill={POS} textAnchor="end" opacity={0.85}>short-liq ▲ {fmtPx(topShort.price)}</text>}

        {/* your position avg-entry */}
        {posY != null && positionEntry && (
          <g>
            <line x1={LPAD} x2={LPAD + plotW} y1={posY} y2={posY} stroke={positionEntry.side === "LONG" ? POS : NEG} strokeWidth={1} strokeDasharray="4 3" opacity={0.8} />
            <rect x={width - RPAD} y={posY - 7} width={RPAD} height={14} fill={positionEntry.side === "LONG" ? POS : NEG} opacity={0.9} />
            <text x={width - RPAD + RPAD / 2} y={posY + 3} fontFamily={MONO} fontSize={8.5} fill="#0a0a0b" fontWeight={700} textAnchor="middle">YOU {fmtPx(positionEntry.entry)}</text>
          </g>
        )}

        {/* last price tag */}
        <line x1={LPAD} x2={LPAD + plotW} y1={y(last.c)} y2={y(last.c)} stroke={lastUp ? POS : NEG} strokeWidth={0.6} strokeDasharray="1 3" opacity={0.6} />
        <rect x={width - RPAD} y={y(last.c) - 8} width={RPAD} height={16} fill={lastUp ? POS : NEG} />
        <text x={width - RPAD + RPAD / 2} y={y(last.c) + 3.5} fontFamily={MONO} fontSize={9} fill="#0a0a0b" fontWeight={700} textAnchor="middle">{fmtPx(last.c)}</text>

        {/* crosshair */}
        {hc && hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={TOP} y2={volBottom} stroke="#ffffff" strokeWidth={0.6} strokeDasharray="2 3" opacity={0.35} />
        )}
      </svg>

      {/* call markers (HTML overlay so pfps get an <img> with monogram fallback) */}
      {calls.map((c, i) => {
        const cx = view.xOfTime(c.t);
        if (cx < LPAD - 2 || cx > LPAD + plotW + 2) return null;
        const cy = c.entry >= min && c.entry <= max ? y(c.entry) : (c.entry < min ? priceBottom - 8 : TOP + 8);
        return (
          <div key={`${c.wallet}-${i}`} title={`${c.displayName || `${c.wallet.slice(0, 6)}…`} · ${c.direction} @ ${fmtPx(c.entry)}`}
            style={{ position: "absolute", left: cx, top: cy, transform: "translate(-50%,-50%)", zIndex: 2, pointerEvents: "none" }}>
            <CallAvatar pfp={c.pfp} name={c.displayName} ring={c.direction === "LONG" ? POS : NEG} />
          </div>
        );
      })}

      {/* hover OHLC readout */}
      {hc && (
        <div style={{ position: "absolute", top: 30, left: 8, zIndex: 3, background: "#0f0f11ee", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "5px 8px", fontFamily: MONO, fontSize: 9.5, color: MUTED, pointerEvents: "none", lineHeight: 1.5 }}>
          <span style={{ color: FAINT }}>{new Date(hc.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><br />
          O <span style={{ color: BONE }}>{fmtPx(hc.o)}</span> H <span style={{ color: BONE }}>{fmtPx(hc.h)}</span> L <span style={{ color: BONE }}>{fmtPx(hc.l)}</span> C <span style={{ color: hc.c >= hc.o ? POS : NEG }}>{fmtPx(hc.c)}</span>
        </div>
      )}

      {/* legend — graded calls + estimated liquidation clusters */}
      {(calls.length > 0 || (showLiq && liqRects.length > 0)) && (
        <div style={{ position: "absolute", bottom: 2, right: 8, zIndex: 3, fontFamily: MONO, fontSize: 8, color: FAINT, letterSpacing: "0.04em", display: "flex", gap: 10 }}>
          {showLiq && liqRects.length > 0 && <span>⚡ est. liq · <span style={{ color: NEG }}>long▼</span> <span style={{ color: POS }}>short▲</span></span>}
          {calls.length > 0 && <span>{calls.length} graded call{calls.length === 1 ? "" : "s"}</span>}
        </div>
      )}
    </div>
  );
}

export default TradeChart;
