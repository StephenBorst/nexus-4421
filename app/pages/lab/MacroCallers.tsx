import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

// ── Macro Callers board — the trustless macro/event track record ─────────────
// The thing that doesn't exist anywhere else: traders ranked on their graded record
// over EVENT-DRIVEN calls only (macro catalysts), scored from public price like any
// call. Social proof for the Macro & Events corner and the strongest thing to show a
// macro-intelligence partner. Reads /theses/macro-leaderboard. Fail-soft + sparse at
// cold-start by design (needs 3+ resolved event-driven calls to rank).

const AGENT_API = "https://og.nexustradinglabs.com";
const MONO = "var(--nx-font-mono)";
const BONE = "#ededf0", FOG = "#a1a1aa", MUTED = "#71717a", FAINT = "#52525b";
const POS = "#3ecf8e", BORDER = "#232327", INSET = "#08080a";

type MacroCaller = {
  rank?: number; wallet: string; displayName?: string | null; pfp?: string | null;
  calls: number; hitRate: number; avgR: number; totalR: number; score?: number;
  categories?: string[]; callsToQualify?: number; meritRank?: { glyph: string; title: string } | null;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const catLabel = (c: string) => (c === "GEOPOLITICS" ? "GEO" : c === "CRYPTO_POLICY" ? "POLICY" : c);

export function MacroCallers() {
  const [ranked, setRanked] = useState<MacroCaller[] | null>(null);
  const [emerging, setEmerging] = useState<MacroCaller[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    fetch(`${AGENT_API}/theses/macro-leaderboard`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setRanked(Array.isArray(d?.leaderboard) ? d.leaderboard : []); setEmerging(Array.isArray(d?.emerging) ? d.emerging : []); } })
      .catch(() => { if (!cancelled) setRanked([]); });
    return () => { cancelled = true; };
  }, []);

  const row = (c: MacroCaller, emergingRow: boolean) => (
    <div key={c.wallet} onClick={() => navigate(`/feed/trader/${c.wallet}`)} style={{
      display: "flex", alignItems: "center", gap: 10, background: INSET, border: `1px solid ${BORDER}`,
      borderRadius: 5, padding: "8px 10px", cursor: "pointer", overflowX: "auto",
    }}>
      <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT, flexShrink: 0, width: 22 }}>{emergingRow ? "·" : c.rank}</span>
      {c.pfp ? <img src={c.pfp} alt="" style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
        : <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#1a1a1e", border: `1px solid ${BORDER}`, flexShrink: 0 }} />}
      <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: "#fff", flexShrink: 0, whiteSpace: "nowrap" }}>{c.displayName || short(c.wallet)}</span>
      {c.meritRank?.glyph && <span title={c.meritRank.title} style={{ fontFamily: MONO, fontSize: 10, color: BONE, flexShrink: 0 }}>{c.meritRank.glyph}</span>}
      <span style={{ fontFamily: MONO, fontSize: 9.5, color: FOG, flexShrink: 0 }}>
        {c.calls} macro · {c.hitRate}% · {c.avgR >= 0 ? "+" : ""}{c.avgR}R{emergingRow && c.callsToQualify ? ` · ${c.callsToQualify} to rank` : ""}
      </span>
      {c.categories && c.categories.length > 0 && (
        <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {c.categories.slice(0, 3).map((cat) => (
            <span key={cat} style={{ fontFamily: MONO, fontSize: 8, color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 3, padding: "1px 5px" }}>{catLabel(cat)}</span>
          ))}
        </span>
      )}
      {!emergingRow && <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 13, fontWeight: 700, color: (c.score ?? 0) > 0 ? BONE : FAINT, flexShrink: 0 }}>{c.score || "—"}</span>}
    </div>
  );

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: FAINT, fontFamily: MONO, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 5 }}>Graded, not claimed</div>
        <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: 19, fontWeight: 700, color: BONE, lineHeight: 1.1, letterSpacing: "-0.01em" }}>Macro Callers</div>
      </div>

      {ranked === null ? (
        <div style={{ color: FAINT, fontSize: 11, fontFamily: MONO }}>Reading the record…</div>
      ) : ranked.length === 0 && emerging.length === 0 ? (
        <div style={{ color: MUTED, fontSize: 11, fontFamily: MONO, lineHeight: 1.6, background: INSET, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "12px 14px" }}>
          No ranked macro callers yet — 3+ resolved event-driven calls to rank. Draft one from an event above; it grades from public price like any call. A verifiable macro track record, sparse at cold-start by design.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(ranked || []).slice(0, 12).map((c) => row(c, false))}
          {emerging.length > 0 && (
            <>
              <div style={{ fontFamily: MONO, fontSize: 9, color: FAINT, letterSpacing: "0.14em", marginTop: 6 }}>EMERGING · building a macro record</div>
              {emerging.slice(0, 6).map((c) => row(c, true))}
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: 12, color: FAINT, fontSize: 9, fontFamily: MONO, lineHeight: 1.6 }}>
        Ranked on event-driven calls only, graded from public price (first-touch target vs stop) — nobody types in whether they were right about the Fed.
      </div>
    </div>
  );
}

export default MacroCallers;
