// ⚔ CONTESTED — where credible callers are OPPOSED right now.
// Consensus is worthless; disagreement is the signal. Built from data we already
// publish (open positions + active public calls), weighted by each participant's
// EARNED merit tier so a sharp-vs-sharp standoff outranks anonymous noise. Ranked
// by tension = weight balance × total weight. Pure public read (GET /theses/
// contested), fail-soft, 30s poll. Clicking a side prefills a copy trade.
import { useEffect, useState } from "react";

const API_BASE = "https://og.nexustradinglabs.com";

type MeritRank = { tier: string; title: string; glyph: string } | null;
type Party = { wallet: string; displayName: string | null; pfp: string | null; meritRank: MeritRank; weight: number; sources: string[] };
type Row = {
  symbol: string;
  longs: Party[]; shorts: Party[];
  longCount: number; shortCount: number;
  longWeight: number; shortWeight: number;
  balance: number; tension: number;
};

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const name = (p: Party) => p.displayName || short(p.wallet);

function Camp({ side, parties, weight, count }: { side: "LONG" | "SHORT"; parties: Party[]; weight: number; count: number }) {
  const tone = side === "LONG" ? "#3ecf8e" : "#f7525f";
  return (
    <div style={{ flex: "1 1 0", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, fontWeight: 700, color: tone, letterSpacing: "0.08em" }}>{side}</span>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>{count} · wt {weight}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {parties.slice(0, 4).map((p) => (
          <div key={p.wallet} style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
            {p.meritRank && <span title={p.meritRank.title} style={{ fontSize: 9, color: "#ededf0", flexShrink: 0 }}>{p.meritRank.glyph}</span>}
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#a1a1aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name(p)}</span>
            {p.sources.includes("position") && <span title="holds an open position" style={{ fontSize: 8, color: "#3ecf8e", flexShrink: 0 }}>●</span>}
          </div>
        ))}
        {parties.length > 4 && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>+{parties.length - 4} more</span>}
      </div>
    </div>
  );
}

export default function Contested() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let cancel = false;
    const load = () => fetch(`${API_BASE}/theses/contested`)
      .then((r) => r.json())
      .then((d) => { if (!cancel) setRows(Array.isArray(d?.contested) ? d.contested : []); })
      .catch(() => { if (!cancel) setRows([]); }); // fail-soft
    load();
    const id = setInterval(load, 30000);
    return () => { cancel = true; clearInterval(id); };
  }, []);

  // Fail-soft + cold-start: render nothing until there's a real standoff (a
  // one-sided book has no disagreement to show — that's correct, not broken).
  if (!rows || rows.length === 0) return null;

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#ededf0", letterSpacing: "0.04em" }}>⚔ CONTESTED</span>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#52525b" }}>where the sharp callers disagree</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>
        {rows.map((row) => {
          // Split bar: how the weighted conviction divides. A dead-even bar is the
          // strongest signal — real, credible two-sided disagreement.
          const total = row.longWeight + row.shortWeight;
          const longPct = total > 0 ? (row.longWeight / total) * 100 : 50;
          return (
            <div key={row.symbol} style={{ background: "#0f0f11", border: "1px solid #232327", borderRadius: 6, padding: "12px 14px", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 14, fontWeight: 700, color: "#f4f4f5" }}>{row.symbol}</span>
                <span title="tension = how evenly credible weight is split × how much of it there is" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>
                  {Math.round(row.balance * 100)}% split
                </span>
              </div>

              {/* weighted split bar */}
              <div style={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden", marginBottom: 10, background: "#232327" }}>
                <div style={{ width: `${longPct}%`, background: "#3ecf8e" }} />
                <div style={{ width: `${100 - longPct}%`, background: "#f7525f" }} />
              </div>

              <div style={{ display: "flex", gap: 12 }}>
                <Camp side="LONG" parties={row.longs} weight={row.longWeight} count={row.longCount} />
                <div style={{ width: 1, background: "#232327", flexShrink: 0 }} />
                <Camp side="SHORT" parties={row.shorts} weight={row.shortWeight} count={row.shortCount} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
