// ── OPERATOR PROFILE — the Lab's one point of view about you ──
// The Lab computes eight separate reads of a trader. Eight cards isn't depth, it's
// eight dashboards and a request that the user be their own analyst. This is the
// synthesis: an archetype, three numbers, and one paragraph that leads with whatever
// is costing the most money.
//
// All composition — every input is already computed and rendered elsewhere, so this
// can never disagree with the cards below it. At cold start it says what it does NOT
// know and the specific next action that would change that (`unlocks`), because
// "we don't know you yet" is a real product state here, not an error.
import { useEffect, useMemo, useState } from "react";
import type { ProcessedTrade, ThesisTrade } from "./types";
import { cardStyle, labelStyle } from "./styles";
import { C, MONO, RADIUS } from "@/config/theme";
import { computeEdge } from "@/config/edge";
import { adherenceReport } from "@/lib/adherence.mjs";
import { leakProfile } from "@/lib/postmortem.mjs";
import { buildOperatorProfile, profileNarrative } from "@/lib/operatorProfile.mjs";
import { openIdentityShare } from "@/utils/shareIdentity";

const AGENT_API = "https://og.nexustradinglabs.com";

type Headline = { key: string; label: string; value: string | null; tone: string | null; sub: string };
type Read = { kind: string; provenance: string; text: string };
type Unlock = { need: number | null; text: string };
type Profile = {
  tier: "UNKNOWN" | "FORMING" | "ESTABLISHED";
  dataScore: number;
  gradedCalls: number;
  closedTrades: number;
  archetype: { label: string; why: string[] } | null;
  headline: Headline[];
  reads: Read[];
  unlocks: Unlock[];
  meritRank: { glyph: string; title: string } | null;
};

const TIER_COPY: Record<string, string> = {
  UNKNOWN: "Not enough record yet",
  FORMING: "Forming — leaning, not settled",
  ESTABLISHED: "Established record",
};

const toneColor = (t: string | null) => (t === "pos" ? C.pos : t === "neg" ? C.neg : C.text.bright);

export function OperatorProfileCard({ wallet, theses, orders }: {
  wallet: string | null;
  theses: ThesisTrade[];
  orders: ProcessedTrade[];
}) {
  const [process, setProcess] = useState<Record<string, unknown> | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!wallet) { setLoaded(true); return; }
    let cancel = false;
    fetch(`${AGENT_API}/theses/process/${wallet}`)
      .then((r) => r.json())
      .then((d) => { if (!cancel) { setProcess(d); setLoaded(true); } })
      .catch(() => { if (!cancel) setLoaded(true); }); // fail-soft: profile still builds from private data
    return () => { cancel = true; };
  }, [wallet]);

  const profile: Profile | null = useMemo(() => {
    if (!loaded) return null;
    return buildOperatorProfile({
      process,
      edge: computeEdge((orders || []).map((o) => ({ symbol: o.symbol, pnl: o.pnl, side: o.side || o.direction }))),
      adherence: adherenceReport(theses || [], orders || []),
      leaks: leakProfile(theses || []),
      trades: orders || [],
    }) as Profile;
  }, [loaded, process, theses, orders]);

  if (!profile) return null;
  // Nothing at all to say and nothing to ask for → don't render an empty shell.
  if (profile.tier === "UNKNOWN" && !profile.unlocks.length) return null;

  const narrative = profileNarrative(profile);

  return (
    <div style={{ ...cardStyle, marginBottom: 8, padding: "16px 18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={labelStyle}>&#9632; OPERATOR PROFILE</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {profile.meritRank && (
            <span style={{ fontFamily: MONO, fontSize: 9, color: C.text.bright, border: `1px solid ${C.borderStrong}`, borderRadius: 2, padding: "1px 5px" }}>
              {profile.meritRank.glyph} {profile.meritRank.title.toUpperCase()}
            </span>
          )}
          {/* Confidence, stated. A profile drawn from 6 calls should not look like one
              drawn from 60 — the meter is the honesty signal. */}
          <span title={`${profile.gradedCalls} graded calls · ${profile.closedTrades} closed trades`} style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint }}>
            {TIER_COPY[profile.tier]}
          </span>
          <span style={{ display: "inline-block", width: 44, height: 4, background: C.border, borderRadius: 2, overflow: "hidden" }}>
            <span style={{ display: "block", width: `${profile.dataScore}%`, height: "100%", background: C.text.muted }} />
          </span>
        </div>
      </div>

      {/* Archetype — who you are, in the words a trader would use. */}
      {profile.archetype && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: "clamp(19px, 2.6vw, 25px)", color: C.text.bright, lineHeight: 1.15, letterSpacing: "-0.01em" }}>
            {profile.archetype.label}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint, marginTop: 4 }}>
            {profile.archetype.why.join(" · ")}
          </div>
        </div>
      )}

      {/* The paragraph — severity-ordered, so it opens on the expensive thing. */}
      <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 14, color: C.text.fog, lineHeight: 1.6, marginTop: 12 }}>
        {narrative}
      </div>

      {/* Three numbers. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))", gap: 14, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
        {profile.headline.map((h) => (
          <div key={h.key}>
            <div style={{ fontSize: 9, letterSpacing: "0.12em", color: C.text.faint, fontFamily: MONO, textTransform: "uppercase" }}>{h.label}</div>
            <div style={{ fontFamily: MONO, fontSize: 19, fontWeight: 700, color: toneColor(h.tone), fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
              {h.value ?? "—"}
            </div>
            <div style={{ fontSize: 9, color: C.text.faint, fontFamily: MONO, marginTop: 1 }}>{h.sub}</div>
          </div>
        ))}
      </div>

      {/* SHARE — the viral loop. Posting this card is an ad that says "my record is
          provable, is yours?" — a claim only a graded record can make. Works at cold
          start too: the card pivots to a "building in public" hook. */}
      {wallet && (
        <button
          type="button"
          onClick={() => openIdentityShare(wallet, { established: profile.tier !== "UNKNOWN", archetypeLabel: profile.archetype?.label })}
          style={{ marginTop: 12, width: "100%", background: "none", border: `1px solid ${C.borderStrong}`, borderRadius: RADIUS.sm, color: C.text.fog, fontFamily: MONO, fontSize: 11, letterSpacing: "0.06em", padding: "9px 14px", cursor: "pointer", textTransform: "uppercase" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = C.text.bright; e.currentTarget.style.borderColor = C.text.muted; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = C.text.fog; e.currentTarget.style.borderColor = C.borderStrong; }}
        >↗ Share your trading identity</button>
      )}

      {/* What would earn the next claim. The cold-start product, not an error state. */}
      {profile.unlocks.length > 0 && (
        <div style={{ marginTop: 12, padding: "10px 12px", background: C.inset, border: `1px solid ${C.border}`, borderRadius: RADIUS.sm }}>
          <div style={{ fontSize: 9, letterSpacing: "0.12em", color: C.text.faint, fontFamily: MONO, textTransform: "uppercase", marginBottom: 6 }}>
            To sharpen this
          </div>
          {profile.unlocks.map((u, i) => (
            <div key={i} style={{ display: "flex", gap: 7, alignItems: "flex-start", marginBottom: 3 }}>
              <span style={{ flexShrink: 0, color: C.text.muted, fontFamily: MONO, fontSize: 10 }}>→</span>
              <span style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12, color: C.text.fog, lineHeight: 1.5 }}>{u.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
