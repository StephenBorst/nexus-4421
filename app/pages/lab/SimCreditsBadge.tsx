// ── SIM CREDITS badge — discoverable balance + buy, in the Lab header ─────────
// Sims are pay-per-run (1 credit = $1). This surfaces the wallet's balance proactively (not
// just on a 402 in the Simulate panel) and lets users top up anytime. Buy = pay USDC/$NEXUS
// to the receiver, paste the tx → /sim/credits/verify (same rail as PRO). Renders nothing
// until a wallet is connected (no noise for logged-out visitors).
import { useEffect, useRef, useState } from "react";
import { useAccount } from "@orderly.network/hooks";
import { C } from "@/config/theme";
import { AGENT_API } from "./agentTypes";

const MF = "var(--nx-font-mono)";
const SIM_RECEIVER = "0x06cD9c281E6ab09906B46a10e059F2770EfdE49A";

export function SimCreditsBadge() {
  const { state: acct } = useAccount();
  const wallet = (acct as { address?: string })?.address?.toLowerCase() ?? null;
  const [credits, setCredits] = useState<number | null>(null);
  const [price, setPrice] = useState(1);
  const [open, setOpen] = useState(false);
  const [chain, setChain] = useState<"arbitrum" | "base">("arbitrum");
  const [tx, setTx] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = () => { if (wallet) fetch(`${AGENT_API}/sim/credits/${wallet}`).then((r) => r.json()).then((d) => { setCredits(Number(d?.credits) || 0); if (d?.priceUsd) setPrice(Number(d.priceUsd)); }).catch(() => {}); };
  useEffect(() => { refresh(); }, [wallet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const verify = () => {
    const t = tx.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(t)) { setMsg("Paste a valid transaction hash (0x…)."); return; }
    setBusy(true); setMsg("Verifying payment on-chain…");
    fetch(`${AGENT_API}/sim/credits/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txHash: t, chain }) })
      .then((r) => r.json()).then((d) => {
        setBusy(false);
        if (d?.ok) { setCredits(Number(d.credits) || 0); setMsg(`✓ +${d.added} credit${d.added === 1 ? "" : "s"} — ${d.credits} total.`); setTx(""); }
        else setMsg(d?.error || d?.hint || "verification failed");
      })
      .catch(() => { setBusy(false); setMsg("verify failed — try again"); });
  };

  if (!wallet) return null;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={() => setOpen((o) => !o)} title="Simulation credits — 1 per pressure-test"
        style={{ appearance: "none", WebkitAppearance: "none", display: "inline-flex", alignItems: "center", gap: 5, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 5, padding: "4px 9px", cursor: "pointer", fontFamily: MF, fontSize: 10, color: C.text.fog }}>
        <span style={{ color: (credits ?? 0) > 0 ? C.pos : C.text.faint }}>◆</span>
        <span style={{ color: C.text.bright, fontWeight: 700 }}>{credits ?? "—"}</span>
        <span style={{ color: C.text.faint }}>sim{credits === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <div className="nx-fade-in" style={{ position: "absolute", top: 32, right: 0, zIndex: 9000, width: "min(320px, calc(100vw - 24px))", background: C.surfaceAlt, border: `1px solid ${C.borderStrong}`, borderRadius: 8, boxShadow: "0 16px 50px rgba(0,0,0,0.6)", padding: "12px 13px" }}>
          <div style={{ fontFamily: MF, fontSize: 11, fontWeight: 700, color: C.text.bright, marginBottom: 4 }}>Simulation credits · {credits ?? 0}</div>
          <div style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: 11.5, color: C.text.fog, lineHeight: 1.5, marginBottom: 9 }}>
            Each ◆ Pressure-test spends 1 credit (${price}). Top up: send {chain === "arbitrum" ? `≥ ${price} USDC on Arbitrum` : `≥ $${price} of $NEXUS on Base`} to <span style={{ color: C.text.bright, wordBreak: "break-all" }}>{SIM_RECEIVER}</span> (${price} = 1 credit), then paste the tx.
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {(["arbitrum", "base"] as const).map((ch) => (
              <button key={ch} onClick={() => setChain(ch)} style={{ appearance: "none", WebkitAppearance: "none", fontFamily: MF, fontSize: 9.5, padding: "3px 9px", borderRadius: 3, cursor: "pointer", background: "transparent", border: `1px solid ${chain === ch ? C.borderStrong : C.border}`, color: chain === ch ? C.text.bright : C.text.faint }}>{ch === "arbitrum" ? "USDC · Arbitrum" : "$NEXUS · Base"}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input value={tx} onChange={(e) => setTx(e.target.value)} placeholder="0x… transaction hash" spellCheck={false}
              style={{ flex: 1, minWidth: 150, background: C.inset, border: `1px solid ${C.border}`, borderRadius: 3, padding: "5px 8px", color: C.text.bright, fontFamily: MF, fontSize: 10 }} />
            <button type="button" onClick={verify} disabled={busy} style={{ appearance: "none", WebkitAppearance: "none", fontFamily: MF, fontSize: 10.5, padding: "4px 12px", borderRadius: 3, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1, background: "transparent", border: `1px solid ${C.borderStrong}`, color: C.text.bright }}>Verify</button>
          </div>
          {msg && <div style={{ fontFamily: MF, fontSize: 9.5, marginTop: 6, lineHeight: 1.4, color: msg.startsWith("✓") ? C.pos : C.text.fog }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

export default SimCreditsBadge;
