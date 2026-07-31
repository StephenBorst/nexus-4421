// ── The public read of a trader ──
// Three things a stranger deciding whether to copy someone actually needs, which the
// profile previously did not answer:
//
//  1. WHO THEY ARE — the same Operator Profile synthesis the trader sees in their own
//     Lab, provenance-filtered. `profileNarrative({ publicOnly: true })` was built and
//     tested for exactly this and had never been rendered anywhere. Private reads
//     (realized fills, self-tagged leaks) are dropped by PUBLIC_READS, so nothing here
//     can leak the half only the owner can see.
//  2. WHAT'S IN FLIGHT — open calls used to be dead air between "posted" and "graded".
//     Live R against the same public price the grader will use.
//  3. WHAT THE VENUE SAYS — the graded-call record and the on-chain trading record are
//     independent evidence. Showing them side by side is the point: agreement is
//     corroboration, disagreement is the most interesting thing on the page.
import { useEffect, useMemo, useState } from "react";
import { C, MONO, RADIUS } from "@/config/theme";
import { buildOperatorProfile, profileNarrative } from "@/lib/operatorProfile.mjs";
import { callProgress, openCallsSummary, PROGRESS_LABEL } from "@/lib/callProgress.mjs";
import { openIdentityShare } from "@/utils/shareIdentity";

const API_BASE = "https://og.nexustradinglabs.com";

const card: React.CSSProperties = {
  background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: RADIUS.sm,
  padding: "14px 16px", marginBottom: 10, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
};
const eyebrow: React.CSSProperties = {
  fontSize: 9, letterSpacing: "0.12em", color: C.text.faint, fontFamily: MONO, textTransform: "uppercase",
};

type OpenCall = { symbol: string; direction: "LONG" | "SHORT"; entryPrice: number; stopLoss: number; takeProfit1: number };

// ── 1. WHO THEY ARE ──────────────────────────────────────────────────
export function PublicOperatorProfile({ wallet, isOwn = false }: { wallet: string | null; isOwn?: boolean }) {
  const [process, setProcess] = useState<Record<string, unknown> | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!wallet) return;
    let cancel = false;
    fetch(`${API_BASE}/theses/process/${wallet}`)
      .then((r) => r.json())
      .then((d) => { if (!cancel) { setProcess(d); setLoaded(true); } })
      .catch(() => { if (!cancel) setLoaded(true); });
    return () => { cancel = true; };
  }, [wallet]);

  // Only the graded half is available for someone else's wallet — their fills and
  // self-tagged leaks are private by construction, so the profile degrades naturally.
  const profile = useMemo(
    () => (loaded ? buildOperatorProfile({ process }) : null),
    [loaded, process],
  );

  if (!profile || !profile.gradedCalls) return null;
  const narrative = profileNarrative(profile, { publicOnly: true, voice: "third" });

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span style={eyebrow}>■ Read</span>
        <span style={{ ...eyebrow, letterSpacing: "0.06em" }}>
          from {profile.gradedCalls} graded call{profile.gradedCalls === 1 ? "" : "s"} · public price only
        </span>
      </div>
      {profile.archetype && (
        <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: "clamp(18px, 2.4vw, 23px)", color: C.text.bright, lineHeight: 1.15, marginTop: 8 }}>
          {profile.archetype.label}
        </div>
      )}
      <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 13.5, color: C.text.fog, lineHeight: 1.6, marginTop: 8 }}>
        {narrative}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 12, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
        {profile.headline
          .filter((h: { key: string }) => h.key !== "leak") // priced from private fills — never public
          .map((h: { key: string; label: string; value: string | null; tone: string | null; sub: string }) => (
            <div key={h.key}>
              <div style={eyebrow}>{h.label}</div>
              <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, fontVariantNumeric: "tabular-nums", marginTop: 2, color: h.tone === "pos" ? C.pos : h.tone === "neg" ? C.neg : C.text.bright }}>
                {h.value ?? "—"}
              </div>
              <div style={{ ...eyebrow, letterSpacing: 0, textTransform: "none", marginTop: 1 }}>{h.sub}</div>
            </div>
          ))}
      </div>

      {/* Share — only the owner posts their OWN card. A visitor sees the record; the
          identity poster is the trader's to broadcast (and the tweet copy says "my"). */}
      {isOwn && wallet && (
        <button
          type="button"
          onClick={() => openIdentityShare(wallet, { established: profile.tier !== "UNKNOWN", archetypeLabel: profile.archetype?.label })}
          style={{ marginTop: 12, width: "100%", background: "none", border: `1px solid ${C.borderStrong}`, borderRadius: RADIUS.sm, color: C.text.fog, fontFamily: MONO, fontSize: 11, letterSpacing: "0.06em", padding: "9px 14px", cursor: "pointer", textTransform: "uppercase" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = C.text.bright; e.currentTarget.style.borderColor = C.text.muted; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = C.text.fog; e.currentTarget.style.borderColor = C.borderStrong; }}
        >↗ Share your trading identity</button>
      )}
    </div>
  );
}

// ── 2. WHAT'S IN FLIGHT ──────────────────────────────────────────────
export function InFlightCalls({ calls, prices }: { calls: OpenCall[]; prices: Record<string, number | null> }) {
  type Row = { t: OpenCall; progress: NonNullable<ReturnType<typeof callProgress>> };
  const rows = useMemo<Row[]>(
    () => (calls || [])
      .map((t) => ({ t, progress: callProgress(t, prices[t.symbol] ?? NaN) }))
      // Predicate (not a bare filter) so `progress` narrows to non-null downstream.
      .filter((r): r is Row => r.progress != null),
    [calls, prices],
  );
  const summary = useMemo(() => openCallsSummary(rows), [rows]);
  if (!rows.length || !summary) return null;

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span style={eyebrow}>■ In flight</span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.text.faint }}>
          {summary.winning}/{summary.open} working ·{" "}
          <span style={{ color: summary.rSum >= 0 ? C.pos : C.neg }}>{summary.rSum >= 0 ? "+" : ""}{summary.rSum}R</span> unresolved
        </span>
      </div>

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 9 }}>
        {rows.map(({ t, progress: p }, i) => {
          const tone = p.r > 0 ? C.pos : p.r < 0 ? C.neg : C.text.fog;
          return (
            <div key={`${t.symbol}-${i}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.text.fog, minWidth: 0 }}>
                  <strong style={{ color: C.text.bright }}>{t.symbol.replace("PERP_", "").replace("_USDC", "")}</strong>{" "}
                  <span style={{ color: C.text.faint }}>{t.direction}</span>
                </span>
                <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 11, color: tone, fontVariantNumeric: "tabular-nums" }}>
                  {p.r > 0 ? "+" : ""}{p.r}R <span style={{ color: C.text.faint }}>{PROGRESS_LABEL[p.state as keyof typeof PROGRESS_LABEL]}</span>
                </span>
              </div>
              {/* stop ──────●────── target */}
              <div style={{ position: "relative", height: 4, background: C.border, borderRadius: 2 }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${p.barPos * 100}%`, background: tone, opacity: 0.55, borderRadius: 2 }} />
                <div style={{ position: "absolute", left: `calc(${p.barPos * 100}% - 2px)`, top: -2, width: 4, height: 8, background: tone, borderRadius: 1 }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                <span style={{ fontSize: 8, color: C.text.faint, fontFamily: MONO }}>stop {p.toSlPct}%</span>
                <span style={{ fontSize: 8, color: C.text.faint, fontFamily: MONO }}>{p.toTpPct}% target</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* The distinction that keeps this honest. */}
      <div style={{ fontSize: 9, color: C.text.faint, fontFamily: MONO, marginTop: 10, lineHeight: 1.5 }}>
        unresolved — live mark vs the posted levels. only first touch of TP or SL grades a call.
      </div>
    </div>
  );
}

// ── 3. WHAT THE VENUE SAYS ───────────────────────────────────────────
// Shape verified against the live endpoint — positions live inside venues[].bySymbol,
// each already carrying a resolved `side`, and there is no `found` flag (an unknown
// wallet simply returns venues: []).
type XraySymbol = { symbol: string; side: "LONG" | "SHORT" | null; open: boolean; szUsd: number };
type XrayVenue = { brokerId: string; isNexus: boolean; realized: number; markets: number; openPositions: number; bySymbol: XraySymbol[] };
type Xray = { venues?: XrayVenue[]; totalRealized?: number; markets?: number };

export function VenueEvidence({ wallet, openCalls }: { wallet: string | null; openCalls: OpenCall[] }) {
  const [xray, setXray] = useState<Xray | null>(null);

  useEffect(() => {
    if (!wallet) return;
    let cancel = false;
    fetch(`${API_BASE}/smart/xray?address=${wallet}`)
      .then((r) => r.json())
      .then((d) => { if (!cancel) setXray(d); })
      .catch(() => { /* fail-soft: the profile stands without it */ });
    return () => { cancel = true; };
  }, [wallet]);

  // ⭐ The says-vs-holds check. A public call is a claim; an on-chain position is
  // behaviour. Only a product holding both can compare them, and the disagreement is
  // more informative than either alone. Stated as an observation, never an accusation —
  // hedges, sub-accounts and other venues are all legitimate explanations.
  const conflicts = useMemo(() => {
    const held = new Map<string, "LONG" | "SHORT">();
    for (const v of xray?.venues || []) {
      for (const p of v.bySymbol || []) {
        if (!p.open || !p.side) continue;
        held.set(String(p.symbol).replace("PERP_", "").replace("_USDC", "").toUpperCase(), p.side);
      }
    }
    return (openCalls || []).flatMap((c) => {
      const bare = c.symbol.replace("PERP_", "").replace("_USDC", "").toUpperCase();
      const holds = held.get(bare);
      if (!holds) return [];
      return holds === c.direction ? [] : [{ symbol: bare, says: c.direction, holds }];
    });
  }, [xray, openCalls]);


  const hasVenue = !!xray?.venues?.length;
  if (!hasVenue && !conflicts.length) return null;

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span style={eyebrow}>■ Venue record</span>
        <span style={{ ...eyebrow, letterSpacing: "0.06em" }}>independent of the calls above</span>
      </div>

      {hasVenue && (
        <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12.5, color: C.text.fog, lineHeight: 1.55, marginTop: 8 }}>
          On-chain settlement shows{" "}
          <strong style={{ color: (xray.totalRealized ?? 0) >= 0 ? C.pos : C.neg }}>
            {(xray.totalRealized ?? 0) >= 0 ? "+" : "−"}${Math.abs(Math.round(xray.totalRealized ?? 0)).toLocaleString()}
          </strong>{" "}
          realized across {xray.markets ?? 0} market{(xray.markets ?? 0) === 1 ? "" : "s"} on {xray.venues!.length} venue{xray.venues!.length === 1 ? "" : "s"}.
        </div>
      )}

      {conflicts.length > 0 && (
        <div style={{ marginTop: 10, padding: "9px 11px", background: C.inset, border: "1px solid #4a3a00", borderRadius: RADIUS.sm }}>
          {conflicts.map((c) => (
            <div key={c.symbol} style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12.5, color: C.text.fog, lineHeight: 1.55 }}>
              <span style={{ color: C.warn, fontFamily: MONO }}>⚠</span>{" "}
              Called <strong style={{ color: C.text.bright }}>{c.says}</strong> on {c.symbol}, currently holds{" "}
              <strong style={{ color: C.text.bright }}>{c.holds}</strong>.
            </div>
          ))}
          <div style={{ fontSize: 9, color: C.text.faint, fontFamily: MONO, marginTop: 6, lineHeight: 1.5 }}>
            not necessarily bad faith — hedges, sub-accounts and other venues all look like this. shown so you can ask.
          </div>
        </div>
      )}
    </div>
  );
}
