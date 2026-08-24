/**
 * TradeChart — a rich, snappy candlestick grid chart for the Quick Trade ticket.
 *
 * Dependency-free (public Orderly /tv/history OHLC → SVG), in the terminal aesthetic.
 * Beyond a sparkline: grid + right price axis + time axis + volume strip + a hover
 * crosshair with an OHLC readout, plus two overlay layers that make it OURS —
 *   • GRADED CALL markers: every public thesis on this coin, plotted at its entry
 *     price and time with the caller's pfp + a LONG/SHORT ring (fomo shows self-
 *     reported buys; these are calls graded on-chain).
 *   • YOUR position: the open avg-entry as a dashed line + tag.
 * Fail-soft throughout; markers/positions are optional layers.
 */
import { useEffect, useMemo, useRef, useState } from "react";

const ORDERLY_API = "https://api-evm.orderly.org";
const AGENT_API = "https://og.nexustradinglabs.com";
const MONO = "var(--nx-font-mono)";
const POS = "#3ecf8e", NEG = "#f7525f", GRID = "#ffffff10", BORDER = "#232327", MUTED = "#71717a", FAINT = "#52525b", BONE = "#f4f4f5";

const bare = (s: string) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Call = { wallet: string; pfp: string | null; displayName: string | null; direction: "LONG" | "SHORT"; entry: number; t: number };
const TFS = [
  { k: "1D", res: "15", hours: 24 },
  { k: "3D", res: "60", hours: 72 },
  { k: "1W", res: "240", hours: 168 },
] as const;

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

export function TradeChart({ symbol, height = 240, positionEntry }: { symbol: string; height?: number; positionEntry?: { entry: number; side: "LONG" | "SHORT" } | null }) {
  const coin = bare(symbol);
  const [tf, setTf] = useState(1); // default 3D
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [allCalls, setAllCalls] = useState<Call[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(430);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 430));
    ro.observe(el);
    setWidth(el.clientWidth || 430);
    return () => ro.disconnect();
  }, []);

  // OHLC for the selected timeframe.
  useEffect(() => {
    let off = false;
    setCandles(null); setFailed(false); setHover(null);
    const now = Math.floor(Date.now() / 1000);
    const { res, hours } = TFS[tf];
    fetch(`${ORDERLY_API}/tv/history?symbol=${symbol}&resolution=${res}&from=${now - hours * 3600}&to=${now}`, { headers: { accept: "application/json" } })
      .then((r) => r.json())
      .then((j) => {
        if (off) return;
        if (j?.s === "ok" && Array.isArray(j.c) && j.c.length > 1) {
          setCandles(j.c.map((c: number, i: number) => ({ t: Number(j.t[i]) * 1000, o: Number(j.o[i]), h: Number(j.h[i]), l: Number(j.l[i]), c: Number(c), v: Number(j.v?.[i]) || 0 })));
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
          direction: t.direction === "SHORT" ? "SHORT" : "LONG",
          entry: Number(t.entryPrice ?? t.entry_price ?? 0),
          t: Number(t.createdAt ?? t.created_at ?? 0),
          _coin: bare(String(t.symbol || "")),
        } as Call & { _coin: string })).filter((c) => (c as Call & { _coin: string })._coin && c.entry > 0 && c.t > 0);
        setAllCalls(calls);
      })
      .catch(() => { if (!off) setAllCalls([]); });
    return () => { off = true; };
  }, []);

  // ── layout ───────────────────────────────────────────────────────────────
  const RPAD = 52, LPAD = 6, TOP = 8, TIMEH = 16, VOLH = 30, GAP = 6;
  const priceBottom = height - TIMEH - VOLH - GAP;
  const volTop = priceBottom + GAP, volBottom = height - TIMEH;
  const plotW = Math.max(60, width - LPAD - RPAD);

  const view = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    const n = candles.length;
    const min = Math.min(...candles.map((d) => d.l)), max = Math.max(...candles.map((d) => d.h));
    const range = max - min || 1;
    const maxVol = Math.max(...candles.map((d) => d.v), 1);
    const slot = plotW / n;
    const x = (i: number) => LPAD + i * slot + slot / 2;
    const y = (v: number) => TOP + (1 - (v - min) / range) * (priceBottom - TOP);
    const vy = (v: number) => volBottom - (v / maxVol) * (volBottom - volTop);
    const bodyW = Math.max(1.2, slot * 0.62);
    const t0 = candles[0].t, t1 = candles[n - 1].t, tspan = t1 - t0 || 1;
    const xOfTime = (ms: number) => LPAD + Math.max(0, Math.min(1, (ms - t0) / tspan)) * plotW;
    return { n, min, max, range, slot, x, y, vy, bodyW, t0, t1, tspan, xOfTime, last: candles[n - 1] };
  }, [candles, plotW, priceBottom, volTop, volBottom]);

  const calls = useMemo(() => {
    if (!view) return [] as Call[];
    return allCalls.filter((c) => (c as Call & { _coin: string })._coin === coin && c.t >= view.t0 - view.slot && c.t <= view.t1 + view.tspan * 0.02)
      .sort((a, b) => a.t - b.t).slice(0, 14);
  }, [allCalls, coin, view]);

  const box: React.CSSProperties = { width: "100%", height, background: "#0a0a0b", border: `1px solid ${BORDER}`, borderRadius: 6, position: "relative", overflow: "hidden" };
  if (failed) return <div style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 10, color: FAINT }}>chart unavailable</div>;
  if (!candles || !view) return <div style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 10, color: FAINT }}>loading chart…</div>;

  const { min, max, x, y, vy, bodyW, last } = view;
  const priceLevels = [0, 0.25, 0.5, 0.75, 1].map((f) => min + (max - min) * f);
  const lastUp = last.c >= last.o;
  const hc = hover != null ? candles[hover] : null;
  const posY = positionEntry && positionEntry.entry >= min && positionEntry.entry <= max ? y(positionEntry.entry) : null;

  // time labels (4)
  const timeLabels = [0, 0.34, 0.67, 1].map((f) => {
    const i = Math.round(f * (view.n - 1));
    const d = new Date(candles[i].t);
    const lab = TFS[tf].hours <= 24 ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : `${d.getMonth() + 1}/${d.getDate()}`;
    return { x: x(i), lab };
  });

  return (
    <div ref={wrapRef} style={box}>
      {/* timeframe toggle */}
      <div style={{ position: "absolute", top: 7, left: 8, zIndex: 3, display: "flex", gap: 4 }}>
        {TFS.map((t, i) => (
          <button key={t.k} onClick={() => setTf(i)} style={{
            background: tf === i ? "#ededf015" : "transparent", border: `1px solid ${tf === i ? "#ededf055" : BORDER}`, borderRadius: 3,
            padding: "2px 7px", cursor: "pointer", color: tf === i ? "#ededf0" : MUTED, fontFamily: MONO, fontSize: 9,
          }}>{t.k}</button>
        ))}
      </div>

      <svg width={width} height={height} style={{ display: "block", position: "absolute", inset: 0 }}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - rect.left;
          const i = Math.round((px - LPAD - view.slot / 2) / view.slot);
          setHover(Math.max(0, Math.min(view.n - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}>

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
            <text x={t.x} y={height - 4} fontFamily={MONO} fontSize={9} fill={FAINT} textAnchor="middle">{t.lab}</text>
          </g>
        ))}

        {/* candles */}
        {candles.map((d, i) => {
          const up = d.c >= d.o;
          const col = up ? POS : NEG;
          const cx = x(i);
          const yTop = Math.min(y(d.o), y(d.c));
          const bh = Math.max(0.8, Math.abs(y(d.c) - y(d.o)));
          return (
            <g key={i} opacity={hover != null && hover !== i ? 0.82 : 1}>
              <line x1={cx} x2={cx} y1={y(d.h)} y2={y(d.l)} stroke={col} strokeWidth={1} />
              <rect x={cx - bodyW / 2} y={yTop} width={bodyW} height={bh} fill={col} />
              <rect x={cx - bodyW / 2} y={vy(d.v)} width={bodyW} height={Math.max(0.5, volBottom - vy(d.v))} fill={col} opacity={0.3} />
            </g>
          );
        })}

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
        {hc && (
          <line x1={x(hover!)} x2={x(hover!)} y1={TOP} y2={volBottom} stroke="#ffffff" strokeWidth={0.6} strokeDasharray="2 3" opacity={0.35} />
        )}
      </svg>

      {/* call markers (HTML overlay so pfps get an <img> with monogram fallback) */}
      {calls.map((c, i) => {
        const cx = view.xOfTime(c.t);
        const cy = c.entry >= min && c.entry <= max ? y(c.entry) : (c.entry < min ? priceBottom - 8 : TOP + 8);
        return (
          <div key={`${c.wallet}-${i}`} title={`${c.displayName || `${c.wallet.slice(0, 6)}…`} · ${c.direction} @ ${fmtPx(c.entry)}`}
            style={{ position: "absolute", left: cx, top: cy, transform: "translate(-50%,-50%)", zIndex: 2, pointerEvents: "auto", cursor: "default" }}>
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

      {/* calls legend */}
      {calls.length > 0 && (
        <div style={{ position: "absolute", bottom: 2, right: 8, zIndex: 3, fontFamily: MONO, fontSize: 8, color: FAINT, letterSpacing: "0.04em" }}>
          {calls.length} graded call{calls.length === 1 ? "" : "s"} on {coin}
        </div>
      )}
    </div>
  );
}

export default TradeChart;
