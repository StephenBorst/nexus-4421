// Shared in-app share poster — one client-side renderer for BOTH a THESIS card
// (a call: setup, R:R, levels, author) and a TRADE card (a closed position:
// entry→exit, P&L, leverage). Rendered as a real 1200×630 SVG node, previewed in
// a modal, and exported to PNG entirely client-side (SVG → canvas → blob, no
// deps). Share buttons deep-link X / Farcaster. Brand register: terminal-black,
// monospace, rationed green, "verify — don't trust".
import { useRef, useState } from "react";

const GREEN = "#3ecf8e";
const RED = "#f7525f";
const BRIGHT = "#f4f4f5";
const MUTED = "#71717a";
const FAINT = "#52525b";
const BG = "#0a0a0b";
const PANEL = "#0f0f11";

export type PosterData =
  | {
      kind: "trade";
      symbol: string; direction: string;
      entry: number; exit: number;
      pnlPct?: number | null; pnlUsd?: number | null;
      leverage?: number | null; reason?: string | null; held?: string | null;
    }
  | {
      kind: "thesis";
      symbol: string; direction: string;
      entry?: number | null; stop?: number | null; target?: number | null;
      rr?: number | null; author?: string | null; meritGlyph?: string | null; note?: string | null;
    };

const asset = (s: string) => s.replace("PERP_", "").replace("_USDC", "");
const money = (v: number) => `${v >= 0 ? "" : "-"}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 100 ? 4 : 2 })}`;

// The 1200×630 card, as SVG JSX. Kept dimensionally identical across variants so
// the export path is uniform.
function PosterSVG({ data, svgRef }: { data: PosterData; svgRef: React.Ref<SVGSVGElement> }) {
  const W = 1200, H = 630;
  const dirColor = data.direction === "LONG" ? GREEN : RED;
  const isLong = data.direction === "LONG";

  const rows: { label: string; value: string; color?: string }[] = [];
  let headline = "", headlineColor = BRIGHT, subline = "";

  if (data.kind === "trade") {
    const pnl = data.pnlPct ?? 0;
    headline = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
    headlineColor = pnl >= 0 ? GREEN : RED;
    subline = data.pnlUsd != null ? `${data.pnlUsd >= 0 ? "+" : ""}${money(data.pnlUsd)} realized` : "realized";
    rows.push({ label: "ENTRY", value: `$${data.entry.toLocaleString()}` });
    rows.push({ label: "EXIT", value: `$${data.exit.toLocaleString()}` });
    if (data.leverage != null) rows.push({ label: "LEVERAGE", value: `${data.leverage}x` });
    if (data.reason) rows.push({ label: "EXIT REASON", value: data.reason });
    if (data.held) rows.push({ label: "HELD", value: data.held });
  } else {
    headline = data.direction;
    headlineColor = dirColor;
    subline = data.rr != null ? `${data.rr.toFixed(2)}R planned` : "trade thesis";
    if (data.entry != null) rows.push({ label: "ENTRY", value: `$${data.entry.toLocaleString()}` });
    if (data.stop != null) rows.push({ label: "STOP", value: `$${data.stop.toLocaleString()}`, color: RED });
    if (data.target != null) rows.push({ label: "TARGET", value: `$${data.target.toLocaleString()}`, color: GREEN });
    if (data.author) rows.push({ label: "CALLER", value: `${data.meritGlyph ? data.meritGlyph + " " : ""}${data.author}` });
  }

  const MONO = "'IBM Plex Mono', ui-monospace, monospace";
  return (
    <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg" style={{ display: "block", width: "100%", height: "auto", borderRadius: 8 }}>
      <rect width={W} height={H} fill={BG} />
      <rect x="1" y="1" width={W - 2} height={H - 2} fill="none" stroke="#232327" strokeWidth="2" rx="14" />
      {/* faint left accent bar in the direction color */}
      <rect x="0" y="0" width="6" height={H} fill={dirColor} opacity="0.5" />

      {/* Brand */}
      <text x="56" y="82" fill={BRIGHT} fontFamily={MONO} fontSize="26" fontWeight="700" letterSpacing="6">// NEXUS TRADING LABS</text>
      <text x="56" y="112" fill={FAINT} fontFamily={MONO} fontSize="16" letterSpacing="2">{data.kind === "trade" ? "AUTONOMOUS TRADE · verify — don't trust" : "TRADE THESIS · graded from public price"}</text>

      {/* Symbol + direction chip */}
      <text x="56" y="230" fill={BRIGHT} fontFamily={MONO} fontSize="92" fontWeight="700">{asset(data.symbol)}</text>
      <rect x="58" y="262" width={data.direction.length * 20 + 40} height="44" rx="6" fill={PANEL} stroke={dirColor} strokeWidth="1.5" />
      <text x="78" y="292" fill={dirColor} fontFamily={MONO} fontSize="24" fontWeight="700" letterSpacing="2">{isLong ? "▲ " : "▼ "}{data.direction}</text>

      {/* Headline metric (right) */}
      <text x={W - 56} y="210" fill={headlineColor} fontFamily={MONO} fontSize="108" fontWeight="700" textAnchor="end">{headline}</text>
      <text x={W - 56} y="252" fill={MUTED} fontFamily={MONO} fontSize="22" textAnchor="end">{subline}</text>

      {/* Detail rows */}
      {rows.slice(0, 4).map((r, i) => {
        const x = 56 + (i % 2) * 580;
        const y = 400 + Math.floor(i / 2) * 90;
        return (
          <g key={r.label}>
            <text x={x} y={y} fill={FAINT} fontFamily={MONO} fontSize="18" letterSpacing="2">{r.label}</text>
            <text x={x} y={y + 40} fill={r.color ?? BRIGHT} fontFamily={MONO} fontSize="40" fontWeight="700">{r.value}</text>
          </g>
        );
      })}

      {/* Footer */}
      <line x1="56" y1="560" x2={W - 56} y2="560" stroke="#1a1a1e" strokeWidth="1" />
      <text x="56" y="596" fill={FAINT} fontFamily={MONO} fontSize="18" letterSpacing="1">trade.nexustradinglabs.com</text>
      <text x={W - 56} y="596" fill={GREEN} fontFamily={MONO} fontSize="18" letterSpacing="1" textAnchor="end">◆ THE LAB</text>
    </svg>
  );
}

// Serialize the live SVG node → PNG blob at native 1200×630.
async function svgToPngBlob(svg: SVGSVGElement): Promise<Blob> {
  const xml = new XMLSerializer().serializeToString(svg);
  const svg64 = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("svg load failed"));
    img.src = svg64;
  });
  const canvas = document.createElement("canvas");
  canvas.width = 1200; canvas.height = 630;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas ctx");
  ctx.drawImage(img, 0, 0, 1200, 630);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
  );
}

export function SharePoster({ data, onClose }: { data: PosterData; onClose: () => void }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [busy, setBusy] = useState(false);

  const shareText = data.kind === "trade"
    ? `${asset(data.symbol)} ${data.direction} closed ${data.pnlPct != null ? `${data.pnlPct >= 0 ? "+" : ""}${data.pnlPct.toFixed(2)}%` : ""} — autonomous, on-chain-anchored. // Nexus Trading Labs`
    : `${asset(data.symbol)} ${data.direction} thesis${data.rr != null ? ` · ${data.rr.toFixed(2)}R` : ""} — graded from public price, verify don't trust. // Nexus Trading Labs`;
  const shareUrl = "https://trade.nexustradinglabs.com/lab";

  const download = async () => {
    if (!svgRef.current) return;
    setBusy(true);
    try {
      const blob = await svgToPngBlob(svgRef.current);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `nexus-${asset(data.symbol).toLowerCase()}-${data.kind}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch { /* fail-soft */ } finally { setBusy(false); }
  };

  const shareX = () => window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`, "_blank", "noopener");
  const shareFc = () => window.open(`https://warpcast.com/~/compose?text=${encodeURIComponent(shareText + " " + shareUrl)}`, "_blank", "noopener");

  const btn: React.CSSProperties = {
    fontFamily: "var(--nx-font-mono)", fontSize: 11, letterSpacing: "0.05em",
    padding: "8px 14px", borderRadius: 4, cursor: "pointer",
    background: "none", border: "1px solid #33333a", color: "#a1a1aa",
  };

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 9100, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div className="nx-fade-in" onClick={(e) => e.stopPropagation()} style={{ width: "min(720px, 96vw)", background: "#0f0f11", border: "1px solid #33333a", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: 16 }}>
          <PosterSVG data={data} svgRef={svgRef} />
        </div>
        <div style={{ display: "flex", gap: 8, padding: "0 16px 16px", flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={download} disabled={busy} style={{ ...btn, color: "#ededf0", borderColor: "#ededf0" }}>{busy ? "RENDERING…" : "↓ DOWNLOAD PNG"}</button>
          <button onClick={shareX} style={btn}>SHARE TO 𝕏</button>
          <button onClick={shareFc} style={btn}>SHARE TO FARCASTER</button>
          <button onClick={onClose} style={{ ...btn, marginLeft: "auto", color: "#71717a" }}>CLOSE</button>
        </div>
      </div>
    </div>
  );
}
