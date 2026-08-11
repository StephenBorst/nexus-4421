// Shared in-app share poster — one client-side renderer for BOTH a THESIS card
// (a call: setup, R:R, levels, author) and a TRADE card (a closed position:
// entry→exit, P&L, leverage). Rendered as a real 1200×630 SVG node, previewed in
// a modal, and exported to PNG entirely client-side (SVG → canvas → blob, no
// deps). Share buttons deep-link X / Farcaster. Brand register: terminal-black,
// monospace, rationed green, "verify — don't trust".
import { useRef, useState } from "react";

const GREEN = "#3ecf8e";   // profit ONLY (realized) — never decoration or a planned metric
const ACCENT = "#ededf0";  // bone/white — the brand accent (labels, brand column, plan metrics)
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
    }
  | {
      kind: "smart";
      symbol: string; direction: string;
      szUsd?: number | null; trader?: string | null; roi?: number | null;
      consensus?: number | null; // # of tracked smart-money traders agreeing (consensus card)
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
  } else if (data.kind === "smart") {
    headline = data.direction;
    headlineColor = dirColor;
    subline = data.consensus && data.consensus > 1
      ? `${data.consensus} smart-money traders agree`
      : "smart money · Hyperliquid";
    if (data.szUsd != null && data.szUsd > 0) rows.push({ label: "SIZE", value: money(data.szUsd) });
    if (data.consensus && data.consensus > 1) rows.push({ label: "CONSENSUS", value: `${data.consensus} traders`, color: ACCENT });
    if (data.trader) rows.push({ label: "TRADER", value: data.trader });
    if (data.roi != null) rows.push({ label: "30D ROI", value: `${(data.roi * 100).toFixed(0)}%`, color: GREEN });
  } else {
    headline = data.rr != null ? `${data.rr.toFixed(2)}R` : "THESIS";
    headlineColor = ACCENT; // R:R is PLANNED, not realized profit → bone, not green
    subline = data.rr != null ? "R:R planned · trustless grade" : "trade thesis";
    if (data.entry != null) rows.push({ label: "ENTRY", value: `$${data.entry.toLocaleString()}` });
    if (data.stop != null) rows.push({ label: "STOP", value: `$${data.stop.toLocaleString()}`, color: RED });
    if (data.target != null) rows.push({ label: "TARGET", value: `$${data.target.toLocaleString()}`, color: ACCENT });
    if (data.author) rows.push({ label: "CALLER", value: `${data.meritGlyph ? data.meritGlyph + " " : ""}${data.author}` });
  }

  const MONO = "'IBM Plex Mono', ui-monospace, monospace";
  const SANS = "Manrope, Arial, sans-serif";
  const kindLabel = data.kind === "trade" ? "// AUTONOMOUS TRADE" : data.kind === "smart" ? "// SMART MONEY SIGNAL" : "// TRADE THESIS";
  // Trade outcome bar: zero-centered, length ∝ |P&L%| (capped), win right / loss left.
  const pnlPct = data.kind === "trade" ? (data.pnlPct ?? 0) : null;
  const barMag = pnlPct != null ? Math.min(1, Math.abs(pnlPct) / 6) : 0;
  const RX = 1140; // right brand-column anchor — mirrors the SDK PnL poster
  return (
    <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg" style={{ display: "block", width: "100%", height: "auto", borderRadius: 8 }}>
      <rect width={W} height={H} fill={BG} />
      <rect x="1" y="1" width={W - 2} height={H - 2} fill="none" stroke="#232327" strokeWidth="2" rx="14" />

      {/* ── LEFT: content zone ─────────────────────────────── */}
      <text x="60" y="80" fill={ACCENT} fontFamily={MONO} fontSize="17" letterSpacing="5" fillOpacity="0.9">{kindLabel}</text>

      {/* Symbol + direction chip */}
      <text x="60" y="164" fill={BRIGHT} fontFamily={MONO} fontSize="72" fontWeight="700">{asset(data.symbol)}</text>
      <rect x="62" y="192" width={data.direction.length * 18 + 44} height="42" rx="6" fill={PANEL} stroke={dirColor} strokeWidth="1.5" />
      <text x="82" y="221" fill={dirColor} fontFamily={MONO} fontSize="22" fontWeight="700" letterSpacing="2">{isLong ? "▲ " : "▼ "}{data.direction}</text>

      {/* Hero metric */}
      <text x="60" y="330" fill={headlineColor} fontFamily={MONO} fontSize="96" fontWeight="700">{headline}</text>
      <text x="60" y="372" fill={MUTED} fontFamily={MONO} fontSize="20" letterSpacing="1">{subline}</text>

      {/* Trade outcome bar */}
      {pnlPct != null && (
        <g>
          <rect x="60" y="398" width="470" height="8" rx="4" fill="#141416" />
          <rect x="294" y="393" width="2" height="18" fill="#33333a" />
          {pnlPct >= 0
            ? <rect x="295" y="398" width={barMag * 235} height="8" rx="4" fill={GREEN} />
            : <rect x={295 - barMag * 235} y="398" width={barMag * 235} height="8" rx="4" fill={RED} />}
        </g>
      )}

      {/* Detail rows (2×2 in the left zone) */}
      {rows.slice(0, 4).map((r, i) => {
        const x = 60 + (i % 2) * 250;
        const y = 448 + Math.floor(i / 2) * 64;
        return (
          <g key={r.label}>
            <text x={x} y={y} fill={FAINT} fontFamily={MONO} fontSize="16" letterSpacing="2">{r.label}</text>
            <text x={x} y={y + 34} fill={r.color ?? BRIGHT} fontFamily={MONO} fontSize="32" fontWeight="700">{r.value}</text>
          </g>
        );
      })}

      {/* ── RIGHT: brand column (mirrors the SDK PnL poster) ── */}
      <line x1="830" y1="150" x2="830" y2="470" stroke={ACCENT} strokeOpacity="0.25" strokeWidth="2" />
      <text x={RX} y="228" textAnchor="end" fontFamily={MONO} fontSize="15" letterSpacing="5" fill={ACCENT} fillOpacity="0.85">// OMNICHAIN TRADING</text>
      <text x={RX} y="300" textAnchor="end" fontFamily={SANS} fontSize="56" fontWeight="700" fill={BRIGHT}>Nexus</text>
      <text x={RX} y="358" textAnchor="end" fontFamily={SANS} fontSize="56" fontWeight="700" fill="#71717a">Trading</text>
      <text x={RX} y="416" textAnchor="end" fontFamily={SANS} fontSize="56" fontWeight="700" fill={BRIGHT}>Labs</text>
      <text x={RX} y="458" textAnchor="end" fontFamily={MONO} fontSize="16" fill="#a1a1aa">Perp DEX · Arbitrum · Orderly</text>

      {/* Footer */}
      <line x1="60" y1="560" x2={W - 60} y2="560" stroke="#1a1a1e" strokeWidth="1" />
      <text x="60" y="596" fill={ACCENT} fontFamily={MONO} fontSize="15" letterSpacing="1" fillOpacity="0.7">◆ VERIFY, DON'T TRUST</text>
      <text x={RX} y="596" fill={FAINT} fontFamily={MONO} fontSize="15" letterSpacing="1" textAnchor="end">nexustradinglabs.com</text>
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
  const [copied, setCopied] = useState(false);

  const shareText = data.kind === "trade"
    ? `${asset(data.symbol)} ${data.direction} closed ${data.pnlPct != null ? `${data.pnlPct >= 0 ? "+" : ""}${data.pnlPct.toFixed(2)}%` : ""} — autonomous, on-chain-anchored. // Nexus Trading Labs`
    : data.kind === "smart"
    ? `${data.consensus && data.consensus > 1 ? `${data.consensus} smart-money traders are` : "Smart money is"} ${data.direction} ${asset(data.symbol)} — track it + copy to a graded agent on Nexus. // verify, don't trust`
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

  // Copy the PNG to the clipboard so it can be pasted straight into the X /
  // Farcaster composer — closes the "download then re-attach" gap. Falls back to
  // a plain download where the async Clipboard image API isn't available.
  const copyImage = async () => {
    if (!svgRef.current) return;
    setBusy(true);
    try {
      const blob = await svgToPngBlob(svgRef.current);
      const CI = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (CI && navigator.clipboard && "write" in navigator.clipboard) {
        await navigator.clipboard.write([new CI({ "image/png": blob })]);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `nexus-${asset(data.symbol).toLowerCase()}-${data.kind}.png`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }
    } catch { /* fail-soft */ } finally { setBusy(false); }
  };

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
          <button onClick={copyImage} disabled={busy} style={btn}>{copied ? "✓ COPIED" : "⧉ COPY IMAGE"}</button>
          <button onClick={shareX} style={btn}>SHARE TO 𝕏</button>
          <button onClick={shareFc} style={btn}>SHARE TO FARCASTER</button>
          <button onClick={onClose} style={{ ...btn, marginLeft: "auto", color: "#71717a" }}>CLOSE</button>
        </div>
      </div>
    </div>
  );
}
