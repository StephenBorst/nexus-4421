// ── Creator earnings (#2 fee-share) — what you earned from being copied ────────
// Reads /creator/earnings/:wallet: the share of the broker fee from Nexus agent trades
// that copied YOUR graded calls (source_leader). Read-only MVP — a commission for being
// copied, not a P&L or revenue share. Teaches the mechanic even at $0. Fail-soft.
import { useEffect, useState } from "react";
import { C, MONO, UI, RADIUS } from "@/config/theme";
import { AGENT_API } from "./agentTypes";

type Earn = { available?: boolean; earnedUsd?: number; pendingUsd?: number; paidUsd?: number; claimable?: boolean; copiers?: number; volumeUsd?: number; trades?: number; sharePct?: number; minPayoutUsd?: number };
const fmt = (n: number | undefined) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function CreatorEarnings({ address }: { address?: string | null }) {
  const [e, setE] = useState<Earn | null>(null);
  const [claim, setClaim] = useState<"idle" | "claiming" | "done" | "err">("idle");
  const [claimMsg, setClaimMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!address) { setE(null); return; }
    let live = true;
    fetch(`${AGENT_API}/creator/earnings/${address.toLowerCase()}`).then((r) => r.json())
      .then((d) => { if (live) setE(d); }).catch(() => { if (live) setE(null); });
    return () => { live = false; };
  }, [address]);

  if (!address || !e || e.available === false) return null; // fail-soft / column not migrated
  const earned = e.earnedUsd || 0;
  const pending = e.pendingUsd ?? earned;
  // The claim reuses the cached trading-key signature (from agent/trade use) — no extra prompt.
  const sig = (() => { try { return sessionStorage.getItem(`nexus_agent_sig_${address.toLowerCase()}`); } catch { return null; } })();
  const doClaim = () => {
    if (!sig) { setClaim("err"); setClaimMsg("Use the Agent or place a trade once to enable claims (it caches your signature)."); return; }
    setClaim("claiming"); setClaimMsg(null);
    fetch(`${AGENT_API}/creator/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletSig: sig }) })
      .then((r) => r.json())
      .then((d) => { if (d.ok) { setClaim("done"); setClaimMsg(d.note || "Claim submitted."); } else { setClaim("err"); setClaimMsg(d.error === "below_min" ? `Need ${fmt(d.minPayoutUsd)} to claim.` : "Claim failed — try again."); } })
      .catch(() => { setClaim("err"); setClaimMsg("Claim failed — try again."); });
  };
  return (
    <div style={{ border: `1px solid ${C.border}`, borderLeft: `2px solid ${C.accent}`, borderRadius: RADIUS.md, padding: "12px 14px", background: C.surfaceAlt }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: C.text.muted }}>◆ Creator earnings</span>
        <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 22, fontWeight: 700, color: pending > 0 ? C.pos : C.text.bright, fontVariantNumeric: "tabular-nums" }}>{fmt(pending)}</span>
        {earned > 0 && <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.text.faint }}>pending{(e.paidUsd || 0) > 0 ? ` · ${fmt(e.paidUsd)} paid` : ""}</span>}
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
          ? <>You earn a share of the broker fee whenever a trader copies one of your graded calls — paid to your wallet in USDC once it clears {fmt(e.minPayoutUsd)}. A commission for being copied, not a P&amp;L share.</>
          : <>Post graded calls people copy, and you earn a share of the fee their trades pay — a commission for being right and copied. Nothing yet.</>}
      </div>
      {(e.claimable || claim === "done") && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <button type="button" onClick={doClaim} disabled={claim === "claiming" || claim === "done"} className="nx-press"
            style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", color: claim === "done" ? C.text.faint : C.accent, background: "none", border: `1px solid ${C.borderStrong}`, borderRadius: RADIUS.md, padding: "8px 15px", cursor: claim === "done" ? "default" : "pointer" }}>
            {claim === "claiming" ? "claiming…" : claim === "done" ? "✓ claim submitted" : `◆ Claim ${fmt(pending)}`}
          </button>
          {claimMsg && <span style={{ fontFamily: MONO, fontSize: 9, color: claim === "err" ? C.warn : C.text.faint, lineHeight: 1.4 }}>{claimMsg}</span>}
        </div>
      )}
    </div>
  );
}

export default CreatorEarnings;
