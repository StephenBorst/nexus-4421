// ⚡ CONTRARIANS — who's right when they FADE the crowd.
// The caller-graph's sharpest signal: callers whose calls made AGAINST the merit-
// weighted consensus lean (at the moment they posted) actually paid. Graded from
// persisted stance snapshots joined to the same trustless first-touch outcome —
// gradeCall is never touched, this is attribution. Pure public read
// (GET /theses/contrarians), fail-soft, sparse until stance history accrues.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const API_BASE = "https://og.nexustradinglabs.com";

type MeritRank = { tier: string; title: string; glyph: string } | null;
type Row = {
  rank: number; wallet: string; displayName: string | null; meritRank: MeritRank;
  contrarianCalls: number; contrarianAvgR: number; contrarianWinRate: number | null;
  edge: number; score: number; withCrowdAvgR: number | null; withCrowdCalls: number;
};

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const rStr = (n: number) => `${n >= 0 ? "+" : ""}${n}R`;

export default function Contrarians() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancel = false;
    const load = () => fetch(`${API_BASE}/theses/contrarians`)
      .then((r) => r.json())
      .then((d) => { if (!cancel) setRows(Array.isArray(d?.contrarians) ? d.contrarians : []); })
      .catch(() => { if (!cancel) setRows([]); }); // fail-soft
    load();
    const id = setInterval(load, 60000);
    return () => { cancel = true; clearInterval(id); };
  }, []);

  // Cold-start: nothing until stance history has accrued AND someone clears the
  // contrarian sample gate. An empty board is correct, not broken.
  if (!rows || rows.length === 0) return null;

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#ededf0", letterSpacing: "0.04em" }}>&#9889; CONTRARIANS</span>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#52525b" }}>right when they fade the crowd</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r) => (
          <div key={r.wallet} onClick={() => navigate(`/feed/trader/${r.wallet}`)} title="Open this caller's profile"
            style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", cursor: "pointer", background: "#0f0f11", border: "1px solid #232327", borderRadius: 6, padding: "9px 12px" }}>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#52525b", width: 20, flexShrink: 0 }}>#{r.rank}</span>
            {r.meritRank && <span title={r.meritRank.title} style={{ fontSize: 10, color: "#ededf0", flexShrink: 0 }}>{r.meritRank.glyph}</span>}
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "underline", textDecorationColor: "#33333a" }}>{r.displayName || short(r.wallet)}</span>
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "baseline", gap: 12, flexShrink: 0 }}>
              <span title="record on contrarian calls" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: r.contrarianAvgR >= 0 ? "#3ecf8e" : "#f7525f" }}>
                {rStr(r.contrarianAvgR)} <span style={{ color: "#52525b" }}>· {r.contrarianCalls} fades{r.contrarianWinRate != null ? ` · ${r.contrarianWinRate}%` : ""}</span>
              </span>
              <span title="how much better they do fading vs following the crowd" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: r.edge >= 0 ? "#3ecf8e" : "#71717a" }}>
                edge {rStr(r.edge)}
              </span>
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 8, lineHeight: 1.5 }}>
        A call is contrarian if it opposed the merit-weighted consensus lean that preceded it. Ranked by contrarian avg-R, shrunk by sample and gated net-positive. Same trustless grade — this only asks whether fading the crowd paid.
      </div>
    </div>
  );
}
