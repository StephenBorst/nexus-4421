/**
 * MarketStatStrip — a compact live header for the chart: mark price, 24h change,
 * funding rate, and open interest. Public Orderly futures endpoint, 20s poll,
 * fail-soft (renders a thin skeleton until it loads). Velo-style, on-brand.
 */
import { useEffect, useState } from "react";

const ORDERLY_API = "https://api-evm.orderly.org";
const MONO = "var(--nx-font-mono)";
const POS = "#3ecf8e", NEG = "#f7525f", BONE = "#f4f4f5", FOG = "#a1a1aa", MUTED = "#71717a", FAINT = "#52525b", BORDER = "#232327";

const bare = (s: string) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
const fmtPx = (v: number) => (v >= 1000 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(4)}`);
const abbrevUsd = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);

type Fut = { mark: number; changePct: number; funding: number; oiUsd: number };

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <span style={{ fontFamily: MONO, fontSize: 7.5, letterSpacing: "0.12em", color: MUTED, textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: BONE, whiteSpace: "nowrap" }}>{children}</span>
    </div>
  );
}

export function MarketStatStrip({ symbol }: { symbol: string }) {
  const coin = bare(symbol);
  const [d, setD] = useState<Fut | null>(null);

  useEffect(() => {
    let off = false;
    const load = () => {
      fetch(`${ORDERLY_API}/v1/public/futures/PERP_${coin}_USDC`).then((r) => r.json())
        .then((j) => {
          if (off) return;
          const x = j?.data;
          if (!x || !(Number(x.mark_price) > 0)) { setD(null); return; }
          const mark = Number(x.mark_price);
          const open = Number(x["24h_open"]) || mark;
          setD({
            mark,
            changePct: open > 0 ? ((mark - open) / open) * 100 : 0,
            funding: Number(x.last_funding_rate) || 0,
            oiUsd: (Number(x.open_interest) || 0) * mark,
          });
        }).catch(() => { if (!off) setD(null); });
    };
    load();
    const iv = setInterval(load, 20000);
    return () => { off = true; clearInterval(iv); };
  }, [coin]);

  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", padding: "9px 12px", background: "#0c0c0e", border: `1px solid ${BORDER}`, borderRadius: 5, marginBottom: 10 };
  if (!d) return <div style={{ ...row, color: FAINT, fontFamily: MONO, fontSize: 10 }}>loading {coin}…</div>;

  const up = d.changePct >= 0;
  // Funding: positive = longs pay shorts (crowd leaning long). Shown per-8h + annualized.
  const fundPct = d.funding * 100;
  const fundAnnual = d.funding * 3 * 365 * 100;
  return (
    <div style={row}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: BONE }}>{coin}</span>
        <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: up ? POS : NEG }}>{fmtPx(d.mark)}</span>
      </div>
      <Stat label="24h"><span style={{ color: up ? POS : NEG }}>{up ? "+" : ""}{d.changePct.toFixed(2)}%</span></Stat>
      <Stat label="Funding · 8h">
        <span style={{ color: d.funding > 0 ? "#e0a458" : d.funding < 0 ? POS : FOG }} title={`≈ ${fundAnnual >= 0 ? "+" : ""}${fundAnnual.toFixed(1)}%/yr`}>
          {fundPct >= 0 ? "+" : ""}{fundPct.toFixed(4)}%
        </span>
      </Stat>
      <Stat label="Open Interest">{abbrevUsd(d.oiUsd)}</Stat>
    </div>
  );
}

export default MarketStatStrip;
