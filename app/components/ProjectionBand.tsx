/**
 * ProjectionBand — the "space of opportunity" chart (Quotient-inspired, on-brand).
 *
 * Recent price → a vertical NOW line → a shaded EXPECTED-MOVE box out to a settle date.
 * Honest by construction: the box is a volatility cone (realized σ from public candles),
 * NOT a fabricated target — the median sits at the current price and the box spans the
 * interquartile range, widening with √time. The read's DIRECTIONAL target (nearest liq
 * magnet on the fade side) is drawn as a separate colored line inside/through the band,
 * and the outlook line names the lean. Dependency-free SVG, terminal aesthetic, fail-soft.
 * Reusable: drop it under any chart with a symbol.
 */
import { useEffect, useMemo, useRef, useState } from "react";

const ORDERLY_API = "https://api-evm.orderly.org";
const AGENT_API = "https://og.nexustradinglabs.com";
const MONO = "var(--nx-font-mono)";
const UI = "var(--nx-font-ui, sans-serif)";
const POS = "#3ecf8e", NEG = "#f7525f", BONE = "#ededf0", BRIGHT = "#f4f4f5", FOG = "#a1a1aa", MUTED = "#71717a", FAINT = "#52525b", BORDER = "#232327";

const bare = (s: string) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
const fmtPx = (v: number) => (v >= 1000 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(4)}`);
const HZ = [{ k: "3D", h: 72 }, { k: "7D", h: 168 }, { k: "14D", h: 336 }] as const;
const Z25 = 0.6745, Z80 = 1.2816; // interquartile / 10th–90th z-scores (normal)

type Lean = { dir: "LONG" | "SHORT"; fundingAnnualPct: number | null } | null;

export function ProjectionBand({ symbol, height = 216, horizonHours, fill }: { symbol: string; height?: number; horizonHours?: number; fill?: boolean }) {
  const coin = bare(symbol);
  // Controlled horizon (Quick Trade syncs it to the chart's timeframe) or self-managed chips.
  const controlledHz = typeof horizonHours === "number";
  const [hIdx, setHIdx] = useState(1); // 7D default (uncontrolled)
  const [closes, setCloses] = useState<number[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [lean, setLean] = useState<Lean>(null);
  const [liq, setLiq] = useState<{ below: { price: number; mag?: number }[]; above: { price: number; mag?: number }[]; currentPrice: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(440);
  const [vh, setVh] = useState(height); // measured container height → fills its column (no dead space)

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); if (r.width > 0) setWidth(r.width); if (r.height > 40) setVh(r.height); };
    const ro = new ResizeObserver(measure);
    ro.observe(el); measure();
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  // ~30d of hourly closes → realized vol + the price line.
  useEffect(() => {
    let off = false; setCloses(null); setFailed(false);
    const now = Math.floor(Date.now() / 1000);
    fetch(`${ORDERLY_API}/tv/history?symbol=PERP_${coin}_USDC&resolution=60&from=${now - 30 * 24 * 3600}&to=${now}`, { headers: { accept: "application/json" } })
      .then((r) => r.json())
      .then((j) => { if (off) return; (j?.s === "ok" && Array.isArray(j.c) && j.c.length > 24) ? setCloses(j.c.map(Number)) : setFailed(true); })
      .catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [symbol]);

  // The read's lean (fade side) from the mispriced board + the liq-magnet heatmap.
  useEffect(() => {
    let off = false; setLean(null); setLiq(null);
    fetch(`${AGENT_API}/intel/mispriced`).then((r) => r.json())
      .then((d) => { if (off) return; const m = (d?.markets || []).find((x: { coin?: string }) => String(x.coin).toUpperCase() === coin); if (m && (m.direction === "LONG" || m.direction === "SHORT")) setLean({ dir: m.direction, fundingAnnualPct: Number(m.fundingAnnualPct) ?? null }); })
      .catch(() => {});
    fetch(`${AGENT_API}/intel/liqmap/${coin}`).then((r) => r.json())
      .then((d) => { if (!off && d?.available && d.currentPrice > 0) setLiq({ below: d.below || [], above: d.above || [], currentPrice: d.currentPrice }); })
      .catch(() => {});
    return () => { off = true; };
  }, [coin]);

  // Directional target = the strongest liq magnet on the fade side (strength ÷ distance).
  const target = useMemo(() => {
    if (!liq || !lean) return null;
    const arr = lean.dir === "SHORT" ? liq.below : liq.above, px = liq.currentPrice;
    const sc = (m: { price: number; mag?: number }) => { const dist = Math.abs(m.price - px) / px; return dist > 0.0005 ? (Number(m.mag) || 1) / dist : 0; };
    const best = (arr || []).reduce((b: { price: number; mag?: number } | null, x) => (sc(x) > (b ? sc(b) : 0) ? x : b), null);
    return best ? best.price : null;
  }, [liq, lean]);

  // Forward horizon in hours — controlled by the chart's timeframe, else the local chips.
  const H = controlledHz ? Math.max(1, horizonHours as number) : HZ[hIdx].h;
  const hLabel = controlledHz ? (H >= 24 ? `${Math.round(H / 24)}D` : `${H}h`) : HZ[hIdx].k;
  const view = useMemo(() => {
    if (!closes || closes.length < 24) return null;
    const price = closes[closes.length - 1];
    // realized hourly vol from log returns
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
    const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
    const varr = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length || 1);
    const sigmaH = Math.sqrt(varr);
    let sigmaT = sigmaH * Math.sqrt(H);
    sigmaT = Math.min(sigmaT, 0.6); // cap the cone so a vol spike can't blow up the scale
    const band = (z: number) => ({ lo: price * Math.exp(-z * sigmaT), hi: price * Math.exp(z * sigmaT) });
    const iqr = band(Z25), wide = band(Z80);
    const tgt = target != null && Number.isFinite(target) ? target : null;
    return { price, sigmaT, iqr, wide, tgt, settle: Date.now() + H * 3600 * 1000 };
  }, [closes, H, target]);

  // fill = grow to the parent flex column's height (flex:1 resolves where height:100% doesn't);
  // else a fixed pixel height. Either way the SVG is drawn at the MEASURED height (vh).
  const box: React.CSSProperties = { width: "100%", background: "#0a0a0b", border: `1px solid ${BORDER}`, borderRadius: 6, position: "relative", overflow: "hidden", ...(fill ? { flex: 1, minHeight: height } : { height }) };
  if (failed) return <div style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 10, color: FAINT }}>projection unavailable</div>;
  if (!closes || !view) return <div style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 10, color: FAINT }}>modeling projection…</div>;

  const { price, iqr, wide, tgt, settle } = view;
  // layout — reserve a header row, an axis row, and a bottom OUTLOOK bar (no overlap).
  const TOP = 28, OUTLOOK_H = 40, AXIS_H = 15, LPAD = 6, RPAD = 52;
  const plotBottom = vh - OUTLOOK_H - AXIS_H;
  const nowXFrac = 0.6; // price line occupies left 60%, projection zone the right 40%
  const nowX = LPAD + (width - LPAD - RPAD) * nowXFrac;
  const settleX = width - RPAD;
  // y-scale spans the price history AND the projection cone
  const lo = Math.min(Math.min(...closes), wide.lo, tgt ?? Infinity);
  const hi = Math.max(Math.max(...closes), wide.hi, tgt ?? -Infinity);
  const pad = (hi - lo) * 0.08 || 1;
  const yMin = lo - pad, yMax = hi + pad, span = yMax - yMin || 1;
  const y = (v: number) => TOP + (1 - (v - yMin) / span) * (plotBottom - TOP);
  // price line (downsampled to ~90 pts across the left zone)
  const step = Math.max(1, Math.floor(closes.length / 90));
  const pts = closes.filter((_, i) => i % step === 0);
  const lineW = nowX - LPAD;
  const path = pts.map((c, i) => `${i === 0 ? "M" : "L"}${(LPAD + (i / (pts.length - 1)) * lineW).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
  const dir = lean?.dir;
  const tgtColor = dir === "LONG" ? POS : dir === "SHORT" ? NEG : BONE;
  const settleStr = new Date(settle).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const pct = (v: number) => `${v >= price ? "+" : ""}${(((v - price) / price) * 100).toFixed(1)}%`;

  return (
    <div ref={wrapRef} style={box}>
      {/* header: eyebrow + horizon chips */}
      <div style={{ position: "absolute", top: 7, left: 9, zIndex: 3, fontFamily: MONO, fontSize: 9, letterSpacing: "0.14em", color: MUTED }}>◆ PROJECTION · expected move</div>
      <div style={{ position: "absolute", top: 6, right: 9, zIndex: 3, display: "flex", gap: 4, alignItems: "center" }}>
        {controlledHz
          ? <span style={{ fontFamily: MONO, fontSize: 9, color: MUTED, letterSpacing: "0.06em" }}>{hLabel} forward</span>
          : HZ.map((z, i) => (
            <button key={z.k} onClick={() => setHIdx(i)} style={{
              background: hIdx === i ? "#ededf015" : "transparent", border: `1px solid ${hIdx === i ? "#ededf055" : BORDER}`, borderRadius: 3,
              padding: "2px 7px", cursor: "pointer", color: hIdx === i ? BONE : MUTED, fontFamily: MONO, fontSize: 9,
            }}>{z.k}</button>
          ))}
      </div>

      <svg width={width} height={vh} style={{ display: "block", position: "absolute", top: 0, left: 0 }}>
        {/* projection zone bg */}
        <rect x={nowX} y={TOP} width={settleX - nowX} height={plotBottom - TOP} fill="#ededf006" />
        {/* 10th–90th faint band */}
        <rect x={nowX} y={y(wide.hi)} width={settleX - nowX} height={Math.max(1, y(wide.lo) - y(wide.hi))} fill="#ededf008" />
        {/* interquartile box — the "space of opportunity" */}
        <rect x={nowX} y={y(iqr.hi)} width={settleX - nowX} height={Math.max(1, y(iqr.lo) - y(iqr.hi))}
          fill="#ededf012" stroke="#ededf033" strokeWidth={1} strokeDasharray="3 3" />
        {/* median (= current price) dashed across the cone */}
        <line x1={LPAD} x2={settleX} y1={y(price)} y2={y(price)} stroke={BONE} strokeWidth={1} strokeDasharray="5 4" opacity={0.5} />
        {/* target line (directional), if the read has a lean + magnet */}
        {tgt != null && (
          <>
            <line x1={nowX} x2={settleX} y1={y(tgt)} y2={y(tgt)} stroke={tgtColor} strokeWidth={1.3} strokeDasharray="4 3" />
            <rect x={settleX} y={y(tgt) - 8} width={RPAD} height={16} fill={tgtColor} />
            <text x={settleX + RPAD / 2} y={y(tgt) + 3.5} fontFamily={MONO} fontSize={8.5} fontWeight={700} fill="#0a0a0b" textAnchor="middle">TGT {fmtPx(tgt)}</text>
          </>
        )}
        {/* price history line */}
        <path d={path} fill="none" stroke={BRIGHT} strokeWidth={1.6} strokeLinejoin="round" />
        {/* NOW marker */}
        <circle cx={nowX} cy={y(price)} r={3.5} fill={BONE} />
        <line x1={nowX} x2={nowX} y1={TOP} y2={plotBottom} stroke="#ffffff" strokeWidth={0.6} strokeDasharray="2 3" opacity={0.25} />
        {/* current price tag */}
        <rect x={settleX} y={y(price) - 8} width={RPAD} height={16} fill={BONE} />
        <text x={settleX + RPAD / 2} y={y(price) + 3.5} fontFamily={MONO} fontSize={9} fontWeight={700} fill="#0a0a0b" textAnchor="middle">{fmtPx(price)}</text>
        {/* iqr edge labels */}
        <text x={settleX - 4} y={y(iqr.hi) - 3} fontFamily={MONO} fontSize={8} fill={FAINT} textAnchor="end">75th {fmtPx(iqr.hi)}</text>
        <text x={settleX - 4} y={y(iqr.lo) + 9} fontFamily={MONO} fontSize={8} fill={FAINT} textAnchor="end">25th {fmtPx(iqr.lo)}</text>
        {/* axis labels (own row, above the outlook bar) */}
        <text x={nowX + (settleX - nowX) / 2} y={plotBottom + AXIS_H - 3} fontFamily={MONO} fontSize={8.5} fill={MUTED} textAnchor="middle">{settleStr} settle</text>
        <text x={LPAD} y={plotBottom + AXIS_H - 3} fontFamily={MONO} fontSize={8.5} fill={FAINT}>30d</text>
      </svg>

      {/* outlook summary — two lines so nothing clips at narrow widths */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: OUTLOOK_H, zIndex: 3, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, padding: "0 10px", borderTop: `1px solid ${BORDER}`, background: "#0c0c0e", boxSizing: "border-box", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontFamily: UI, fontSize: 11, color: FOG, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: MUTED, flexShrink: 0 }}>OUTLOOK</span>
          {dir
            ? <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}><b style={{ color: tgtColor }}>{dir === "SHORT" ? "▼ fade short" : "▲ fade long"}</b>{tgt != null ? <> → <b style={{ color: tgtColor }}>{fmtPx(tgt)}</b> <span style={{ color: FAINT }}>({pct(tgt)})</span></> : ""}</span>
            : <span style={{ color: MUTED }}>no funding lean</span>}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 8.5, color: FAINT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hLabel} expected range {fmtPx(wide.lo)}–{fmtPx(wide.hi)}</div>
      </div>
    </div>
  );
}

export default ProjectionBand;
