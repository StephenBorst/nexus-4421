// ── Creator earnings (#2 fee-share) — what you earned from being copied ────────
// Reads /creator/earnings/:wallet: the share of the broker fee from Nexus agent trades
// that copied YOUR graded calls (source_leader). Read-only MVP — a commission for being
// copied, not a P&L or revenue share. Teaches the mechanic even at $0. Fail-soft.
import { useEffect, useState } from "react";
import { C, MONO, UI, RADIUS } from "@/config/theme";
import { AGENT_API } from "./agentTypes";

type Earn = { available?: boolean; earnedUsd?: number; copiers?: number; volumeUsd?: number; trades?: number; sharePct?: number; minPayoutUsd?: number };
const fmt = (n: number | undefined) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function CreatorEarnings({ address }: { address?: string | null }) {
  const [e, setE] = useState<Earn | null>(null);
  useEffect(() => {
    if (!address) { setE(null); return; }
    let live = true;
    fetch(`${AGENT_API}/creator/earnings/${address.toLowerCase()}`).then((r) => r.json())
      .then((d) => { if (live) setE(d); }).catch(() => { if (live) setE(null); });
    return () => { live = false; };
  }, [address]);

  if (!address || !e || e.available === false) return null; // fail-soft / column not migrated
  const earned = e.earnedUsd || 0;
  return (
    <div style={{ border: `1px solid ${C.border}`, borderLeft: `2px solid ${C.accent}`, borderRadius: RADIUS.md, padding: "12px 14px", background: C.surfaceAlt }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: C.text.muted }}>◆ Creator earnings</span>
        <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 22, fontWeight: 700, color: earned > 0 ? C.pos : C.text.bright, fontVariantNumeric: "tabular-nums" }}>{fmt(earned)}</span>
      </div>
      {earned > 0 && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8, fontFamily: MONO, fontSize: 10, color: C.text.fog }}>
          <span><b style={{ color: C.text.bright }}>{e.copiers}</b> copier{e.copiers === 1 ? "" : "s"}</span>
          <span>{fmt(e.volumeUsd)} copied volume</span>
          <span>{e.trades} trades</span>
          <span style={{ color: C.text.faint }}>{e.sharePct}% fee share</span>
        </div>
      )}
      <div style={{ fontFamily: UI, fontSize: 11.5, lineHeight: 1.5, color: C.text.fog, marginTop: 8 }}>
        {earned > 0
          ? <>Pending — you earn a share of the broker fee whenever a trader copies one of your graded calls. Paid out once it clears {fmt(e.minPayoutUsd)}. A commission for being copied, not a P&amp;L share.</>
          : <>Post graded calls people copy, and you earn a share of the fee their trades pay — a commission for being right and copied. Nothing yet.</>}
      </div>
    </div>
  );
}

export default CreatorEarnings;
