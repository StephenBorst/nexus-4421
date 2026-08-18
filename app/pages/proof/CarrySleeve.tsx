// ── HOUSE CARRY SLEEVE — our own strategy, proven in the open ─────────────────
// The transparency-as-product artifact: Nexus ran its OWN engine hunt in public,
// found one real edge (sector-neutral funding carry), and now runs it live in PAPER
// with the equity curve open for anyone to verify — losers included. Reads the
// nexus-carry-engine worker's /carry/record. Fail-soft: renders nothing if the
// endpoint is unreachable; honest "accruing" copy while the curve is still forming.
import { useEffect, useMemo, useState } from "react";

const CARRY_API = "https://nexus-carry-engine.stephenpatrick24.workers.dev";
const MONO = "var(--nx-font-mono)";
const UI = "var(--nx-font-ui, sans-serif)";
const BONE = "#ededf0", BRIGHT = "#f4f4f5", FOG = "#a1a1aa", MUTED = "#71717a", FAINT = "#52525b";
const POS = "#3ecf8e", NEG = "#f7525f", AMBER = "#e0a458";
const BORDER = "#232327", SURFACE_ALT = "#0f0f11", INSET = "#08080a";

type Point = { t: number; equity: number; funding: number; price: number };
type Summary = {
  equity: number; netPnl: number; cumFunding: number; cumPrice: number; cumFees: number;
  carrySharePct: number; rebalances: number; trades: number; legs: number; startedTs: number; points: number;
};
type Record = { mode?: string; summary?: Summary; equityCurve?: Point[] };

const usd = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
const daysSince = (ms?: number) => (ms ? Math.max(0, (Date.now() - ms) / 86400000) : 0);

// dependency-free equity sparkline; baseline = starting capital (1000)
function EquityCurve({ points, capital }: { points: Point[]; capital: number }) {
  const W = 640, H = 90, pad = 4;
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p.t);
    const eqs = points.map((p) => p.equity);
    const minT = Math.min(...xs), maxT = Math.max(...xs);
    const lo = Math.min(capital, ...eqs), hi = Math.max(capital, ...eqs);
    const spanT = maxT - minT || 1, spanE = hi - lo || 1;
    const X = (t: number) => pad + ((t - minT) / spanT) * (W - pad * 2);
    const Y = (e: number) => pad + (1 - (e - lo) / spanE) * (H - pad * 2);
    const line = points.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.equity).toFixed(1)}`).join(" ");
    return { line, baseY: Y(capital), up: eqs[eqs.length - 1] >= capital };
  }, [points, capital]);
  if (!path) return null;
  const tone = path.up ? POS : NEG;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 90, display: "block" }}>
      <line x1={0} y1={path.baseY} x2={W} y2={path.baseY} stroke={BORDER} strokeWidth={1} strokeDasharray="3 3" />
      <path d={`${path.line} L${W - pad},${H} L${pad},${H} Z`} fill={tone} opacity={0.08} />
      <path d={path.line} fill="none" stroke={tone} strokeWidth={1.6} />
    </svg>
  );
}

export default function CarrySleeve() {
  const [rec, setRec] = useState<Record | null>(null);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${CARRY_API}/carry/record`)
        .then((r) => r.json())
        .then((d) => { if (alive) setRec(d); })
        .catch(() => { if (alive) setDead(true); });
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (dead) return null; // fail-soft: endpoint unreachable
  const s = rec?.summary;
  const curve = rec?.equityCurve || [];
  const capital = 1000;
  const started = s?.startedTs;

  const net = s?.netPnl ?? 0;
  const netTone = net > 0 ? POS : net < 0 ? NEG : FOG;

  const stat = (label: string, value: React.ReactNode, tone: string = FOG) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.14em", textTransform: "uppercase", color: MUTED }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: tone }}>{value}</span>
    </div>
  );

  return (
    <div style={{ marginTop: 26, border: `1px solid ${BORDER}`, borderLeft: `2px solid ${BONE}`, borderRadius: 8, background: SURFACE_ALT, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", color: BONE }}>◈ HOUSE CARRY SLEEVE</span>
        <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.1em", color: AMBER, border: `1px solid ${AMBER}55`, borderRadius: 3, padding: "2px 6px" }}>
          {(rec?.mode || "paper").toUpperCase()}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT }}>sector-neutral funding carry</span>
        {started && s?.points ? (
          <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, color: FAINT }}>
            day {daysSince(started).toFixed(1)} · {s.rebalances} rebalances
          </span>
        ) : null}
      </div>

      <div style={{ fontFamily: UI, fontSize: 12.5, color: FOG, lineHeight: 1.6, maxWidth: 620, marginBottom: 14 }}>
        We hunted our own engine in public and found one real edge: long the most-negative-funding name and short the
        most-positive <i>within each sector</i>, so market moves cancel and the funding carry survives. It runs live in
        <b style={{ color: BRIGHT }}> paper</b> here — the equity curve is open, losers included, before a dollar of capital.
      </div>

      {curve.length >= 2 ? (
        <div style={{ background: INSET, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "10px 6px 4px", marginBottom: 14 }}>
          <EquityCurve points={curve} capital={capital} />
        </div>
      ) : (
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, background: INSET, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "14px 12px", marginBottom: 14 }}>
          ◷ Just launched — accruing. The equity curve forms as the hourly ticks and 24h rebalances land.
        </div>
      )}

      {s && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 12, marginBottom: 4 }}>
          {stat("Net P&L", usd(net), netTone)}
          {stat("Carry share", `${s.carrySharePct}%`, s.carrySharePct >= 55 ? POS : FOG)}
          {stat("Funding", usd(s.cumFunding), s.cumFunding >= 0 ? POS : NEG)}
          {stat("Price resid.", usd(s.cumPrice), Math.abs(s.cumPrice) < Math.abs(s.cumFunding) || s.cumPrice >= 0 ? FOG : NEG)}
          {stat("Legs", s.legs)}
        </div>
      )}

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: UI, fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
          Carry-driven when the <b style={{ color: FOG }}>carry share</b> is high — that's funding income, not price luck.
        </span>
        <a href={`${CARRY_API}/carry/record`} target="_blank" rel="noopener noreferrer"
          style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9.5, color: FOG, textDecoration: "none", border: `1px solid ${BORDER}`, borderRadius: 3, padding: "3px 8px", background: "#1a1a1e" }}>
          verify the record ↗
        </a>
      </div>
    </div>
  );
}
