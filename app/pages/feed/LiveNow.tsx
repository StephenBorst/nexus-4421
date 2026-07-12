// ◆ LIVE NOW — currently-open autonomous agent positions, with live uPnL.
// The "watch the desk trade live" surface (Legend-style live positions, but
// every row is a real, on-chain-graded autonomous position — verifiable, not
// self-reported flexing). Reads GET /agents/live (no auth, public). Fail-soft:
// renders nothing when there are no open positions, so it never shows an empty
// band. Polls so PnL ticks. Horizontal-scroll row → never clips on mobile.
import { useEffect, useState } from "react";

const API_BASE = "https://og.nexustradinglabs.com";
const green = "#ededf0";
const red = "#f7525f";

type LivePos = {
  wallet: string;
  agent: boolean;
  displayName: string | null;
  pfpUrl: string | null;
  symbol: string;
  direction: "LONG" | "SHORT";
  entry_price: number;
  mark_price: number | null;
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
  opened_at: number | null;
};

const tk = (s: string) => s.replace("PERP_", "").replace("_USDC", "");
const shortAddr = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const ago = (ms: number | null) => {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

export default function LiveNow() {
  const [positions, setPositions] = useState<LivePos[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await (await fetch(`${API_BASE}/agents/live`)).json();
        if (alive) setPositions(Array.isArray(d?.positions) ? d.positions : []);
      } catch { if (alive) setPositions([]); }
    };
    load();
    const id = setInterval(load, 25000); // ticking PnL
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Fail-soft: nothing to show → render nothing (no empty band).
  if (!positions || positions.length === 0) return null;

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold", color: green, letterSpacing: "0.12em" }}>
          ◆ LIVE NOW
        </span>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>
          {positions.length} position{positions.length !== 1 ? "s" : ""} open · live PnL from public price
        </span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: green, boxShadow: `0 0 6px ${green}` }} />
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#52525b" }}>live</span>
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
        {positions.map((p, i) => {
          const long = p.direction === "LONG";
          const pct = p.unrealized_pnl_pct;
          const up = pct != null && pct >= 0;
          const pnlColor = pct == null ? "#a1a1aa" : up ? green : red;
          return (
            <div
              key={`${p.wallet}-${p.symbol}-${i}`}
              style={{
                flexShrink: 0, minWidth: 132, background: "#0a0a0b",
                border: `1px solid ${pct == null ? "#232327" : up ? "#33333a" : "#4a1a1a"}`,
                borderRadius: 5, padding: "8px 10px", fontFamily: "var(--nx-font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: "bold", color: "#fff" }}>{tk(p.symbol)}</span>
                <span style={{ fontSize: 9, color: long ? green : red }}>{long ? "↑ LONG" : "↓ SHORT"}</span>
                <span style={{ marginLeft: "auto", fontSize: 8, color: p.agent ? "#d4d4d8" : "#ededf0", border: `1px solid ${p.agent ? "#1a3a5a" : "#33333a"}`, borderRadius: 3, padding: "0 4px" }}>{p.agent ? "🤖" : "👤"}</span>
              </div>
              <div style={{ fontSize: 15, fontWeight: "bold", color: pnlColor, marginTop: 5 }}>
                {pct == null ? "—" : `${up ? "+" : ""}${pct.toFixed(2)}%`}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 3, gap: 4 }}>
                <span style={{ fontSize: 8, color: "#52525b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.agent ? "Nexus Agent" : (p.displayName || shortAddr(p.wallet))}
                </span>
                <span style={{ fontSize: 8, color: "#52525b", flexShrink: 0 }}>{ago(p.opened_at)} ago</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
