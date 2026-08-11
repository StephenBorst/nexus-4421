// YOUR GRADED RECORD — the Lab's ambient proof strip.
//
// The product's core claim is "we prove who's actually right", but the graded record
// was buried two levels deep (TOP AGENTS inside the Agent tab, VERIFIED CALLERS inside
// Feed→RANKS). This lifts it to the top of every Lab tab.
//
// Deliberately PERSONAL rather than a leaderboard embed: the public board currently has
// zero qualified callers (needs 5+ graded calls), so surfacing the board itself would
// make emptiness the first thing you see and undercut the very claim it's meant to
// support. Your own standing is meaningful at every stage — including zero, where it
// becomes the invitation.
//
// Fail-soft: renders nothing while loading or if the API is unreachable. Never blocks.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const AGENT_API = "https://og.nexustradinglabs.com";
const MIN_CALLS = 5; // Verified Caller threshold (mirrors lab-api MIN_CALLS)

// The connected wallet's OWN graded CALLER record (published theses, first-touch graded
// vs public price) — distinct from the trade record in Analytics. Read from the per-wallet
// /theses/process endpoint so EVERY state is handled directly from the true count + avg-R,
// not inferred from which board list a wallet happens to land in (the old two-list lookup
// silently dropped net-negative callers with 5+ calls into a wrong "no record" state).
type Process = {
  calls: number; hitRate: number; avgR: number;
  meritRank?: { glyph: string; title: string } | null;
};

export function LabStanding({ address }: { address?: string | null }) {
  const [rec, setRec] = useState<Process | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!address) { setLoaded(false); return; }
    let alive = true;
    (async () => {
      try {
        const d = await (await fetch(`${AGENT_API}/theses/process/${String(address).toLowerCase()}`)).json();
        if (!alive) return;
        setRec(d && typeof d.calls === "number" ? { calls: d.calls, hitRate: d.hitRate ?? 0, avgR: d.avgR ?? 0, meritRank: d.meritRank ?? null } : null);
        setLoaded(true);
      } catch { /* fail soft — strip just doesn't render */ }
    })();
    return () => { alive = false; };
  }, [address]);

  if (!address || !loaded) return null;
  const minCalls = MIN_CALLS;
  // Derive the state directly from the record: ranked (earned merit) → emerging (<5) →
  // qualified-by-count-but-net-negative (5+, unranked) → nothing yet.
  const ranked = rec && rec.meritRank ? rec : null;
  const emerging = rec && !rec.meritRank && rec.calls > 0 && rec.calls < minCalls
    ? { calls: rec.calls, callsToQualify: minCalls - rec.calls } : null;
  const unranked = rec && !rec.meritRank && rec.calls >= minCalls ? rec : null;

  const label = { fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.12em" };
  const val = { fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", fontWeight: 600 } as const;

  // States, one line: ranked → emerging (<5) → net-negative-but-5+ → no record yet.
  let body: React.ReactNode;
  if (ranked) {
    const r = ranked;
    body = (
      <>
        {r.meritRank && (
          <span style={{ ...val, border: "1px solid #33333a", borderRadius: 3, padding: "2px 8px" }}>
            {r.meritRank.glyph} {r.meritRank.title.toUpperCase()}
          </span>
        )}
        <span style={val}>{r.calls} graded</span>
        <span style={val}>{r.hitRate.toFixed(0)}% hit</span>
        <span style={{ ...val, color: r.avgR >= 0 ? "#3ecf8e" : "#f7525f" }}>
          {r.avgR >= 0 ? "+" : ""}{r.avgR.toFixed(2)}R avg
        </span>
      </>
    );
  } else if (unranked) {
    // 5+ resolved calls but net-negative by R — met the count, not the bar. Shown
    // honestly rather than dropped into a wrong "no record yet" state.
    const u = unranked;
    body = (
      <>
        <span style={val}>{u.calls} graded</span>
        <span style={val}>{u.hitRate.toFixed(0)}% hit</span>
        <span style={{ ...val, color: "#f7525f" }}>{u.avgR.toFixed(2)}R avg</span>
        <span style={{ ...label, letterSpacing: 0, fontSize: 11 }}>net-negative — not yet ranked</span>
      </>
    );
  } else if (emerging) {
    const e = emerging;
    const done = Math.max(0, minCalls - e.callsToQualify);
    body = (
      <>
        <span style={val}>{e.calls} graded call{e.calls === 1 ? "" : "s"}</span>
        <span style={{ ...label, letterSpacing: 0, fontSize: 11 }}>
          {e.callsToQualify} more to qualify as a Verified Caller
        </span>
        {/* progress: earned vs the public bar, so the goal is concrete */}
        <span style={{ display: "flex", gap: 2, alignItems: "center" }}>
          {Array.from({ length: minCalls }).map((_, i) => (
            <span key={i} style={{ width: 12, height: 4, borderRadius: 1, background: i < done ? "#ededf0" : "#232327" }} />
          ))}
        </span>
      </>
    );
  } else {
    body = (
      <span style={{ ...label, letterSpacing: 0, fontSize: 11, color: "#71717a" }}>
        No graded calls yet — publish a thesis and it grades itself from public price. Nothing self-reported.
      </span>
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
      padding: "10px 16px", background: "#0f0f11", border: "1px solid #232327",
      borderRadius: 4, marginBottom: 12,
    }}>
      <span style={label} title="Your published-thesis (CALL) record, graded first-touch vs public price — separate from your trade record in Analytics.">YOUR CALLER RECORD</span>
      {body}
      <Link
        to="/feed?view=ranks"
        style={{
          marginLeft: "auto", flexShrink: 0, fontFamily: "var(--nx-font-mono)", fontSize: 10,
          color: "#ededf0", textDecoration: "none", border: "1px solid #33333a",
          borderRadius: 3, padding: "4px 10px", whiteSpace: "nowrap",
        }}
      >
        THE BOARD ↗
      </Link>
    </div>
  );
}
