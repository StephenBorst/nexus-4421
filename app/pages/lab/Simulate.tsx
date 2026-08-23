// ── SIMULATION (Miroshark) — pay-per-sim, polls to completion ─────────────────
// Shared across the Lab (THE READ, the Mispriced fade, the Conviction Scanner, any setup).
// Runs the paid Miroshark sim via our x402 proxy (POST /wargame {run:true, walletSig}). It's
// PAY-PER-SIM: 1 credit ($1) per run — the run is gated on the wallet's sim-credit balance,
// so it's self-funding (users buy credits in USDC/$NEXUS; the operator's wallet does the x402).
// The run is ASYNC → we poll /wargame/status, stream live progress, then link the report.
// Synthetic — a thinking tool to pressure-test the trade, NEVER a signal. Two-step + gated.
import { useState, useEffect } from "react";
import { C } from "@/config/theme";
import { AGENT_API } from "./agentTypes";
import { getAgentSig } from "./agentKeys";

const MF = "var(--nx-font-mono)";
const SIM_RECEIVER = "0x06cD9c281E6ab09906B46a10e059F2770EfdE49A"; // subs/AI/sim revenue receiver
type SimResult = { scenario?: string; enabled?: boolean; ran?: unknown; error?: string; disclaimer?: string; job?: { status_url?: string; data?: { status_url?: string } } };
type Prog = { stage?: string; progress?: number; message?: string };

export function Simulate({ body, label = "◆ Simulate", wallet }: { body: Record<string, unknown>; label?: string; wallet?: string | null }) {
  const [state, setState] = useState<"idle" | "building" | "preview" | "running" | "done">("idle");
  const [res, setRes] = useState<SimResult | null>(null);
  const [statusUrl, setStatusUrl] = useState<string | null>(null);
  const [prog, setProg] = useState<Prog | null>(null);
  const [done, setDone] = useState<{ shareUrl?: string; message?: string; error?: string } | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [price, setPrice] = useState(2);
  const [needBuy, setNeedBuy] = useState(false);
  const [buyChain, setBuyChain] = useState<"arbitrum" | "base">("arbitrum");
  const [buyTx, setBuyTx] = useState("");
  const [buyMsg, setBuyMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshCredits = () => { if (wallet) fetch(`${AGENT_API}/sim/credits/${wallet.toLowerCase()}`).then((r) => r.json()).then((d) => { setCredits(Number(d?.credits) || 0); if (d?.priceUsd) setPrice(Number(d.priceUsd)); }).catch(() => {}); };

  const build = () => {
    setState("building");
    fetch(`${AGENT_API}/wargame`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json()).then((d: SimResult) => { setRes(d); setState("preview"); refreshCredits(); })
      .catch(() => { setRes({ error: "couldn't build the scenario" }); setState("preview"); });
  };

  const runPaid = async () => {
    if (!wallet) { setNeedBuy(false); setDone({ error: "connect a wallet to run a simulation" }); setState("done"); return; }
    setState("running"); setProg(null); setDone(null); setNeedBuy(false);
    let walletSig = "";
    try { walletSig = await getAgentSig(wallet); } catch { setDone({ error: "signature needed to run" }); setState("done"); return; }
    fetch(`${AGENT_API}/wargame`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, run: true, walletSig }) })
      .then(async (r) => ({ status: r.status, d: (await r.json()) as SimResult & { credits?: number } }))
      .then(({ status, d }) => {
        const su = d?.job?.status_url || d?.job?.data?.status_url;
        if (d?.ran === "queued" && su) { setStatusUrl(su); return; } // → polling effect
        if (status === 402) { setCredits(0); setNeedBuy(true); setState("preview"); return; } // out of credits → buy
        setDone({ error: d?.error || "simulation didn't queue — try again" }); setState("done");
      })
      .catch(() => { setDone({ error: "simulation failed — try again" }); setState("done"); });
  };

  const verifyBuy = () => {
    const tx = buyTx.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) { setBuyMsg("Paste a valid transaction hash (0x…)."); return; }
    setBusy(true); setBuyMsg("Verifying payment on-chain…");
    fetch(`${AGENT_API}/sim/credits/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txHash: tx, chain: buyChain }) })
      .then((r) => r.json()).then((d) => {
        setBusy(false);
        if (d?.ok) { setCredits(Number(d.credits) || 0); setBuyMsg(`✓ Added ${d.added} credit${d.added === 1 ? "" : "s"} — ${d.credits} total. Run it.`); setNeedBuy(false); setBuyTx(""); }
        else setBuyMsg(d?.error || d?.hint || "verification failed");
      })
      .catch(() => { setBusy(false); setBuyMsg("verify failed — try again"); });
  };

  useEffect(() => { refreshCredits(); }, [wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the async run to completion, streaming live progress.
  useEffect(() => {
    if (!statusUrl || state !== "running") return;
    let stop = false, tries = 0;
    const tick = async () => {
      if (stop) return;
      try {
        const j = await fetch(`${AGENT_API}/wargame/status?url=${encodeURIComponent(statusUrl)}`).then((r) => r.json());
        const x = (j && j.data) || {};
        setProg({ stage: x.current_stage, progress: x.progress, message: x.message });
        if (x.status === "completed" || x.completed_at) { setDone({ shareUrl: x.share_url, message: x.message }); setState("done"); refreshCredits(); return; }
        if (x.status === "failed" || x.error) { setDone({ error: x.error || "simulation failed" }); setState("done"); return; }
      } catch { /* transient — keep polling */ }
      if (++tries > 90) { setDone({ error: "simulation timed out — check back" }); setState("done"); return; }
      if (!stop) setTimeout(tick, 5000);
    };
    tick();
    return () => { stop = true; };
  }, [statusUrl, state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === "idle") return (
    <button type="button" onClick={build} className="nx-press"
      style={{ color: C.text.fog, background: "transparent", border: `1px solid ${C.borderStrong}`, borderRadius: 3, padding: "3px 10px", fontFamily: MF, fontSize: 10, cursor: "pointer", whiteSpace: "nowrap" }}
      title="Pressure-test this trade — 25 AI agents react across markets and communities over 10 rounds (1 credit)">{label}</button>
  );

  const linkBtn = { color: C.text.bright, background: "transparent", border: `1px solid ${C.borderStrong}`, borderRadius: 3, padding: "4px 12px", fontFamily: MF, fontSize: 10.5, cursor: "pointer", textDecoration: "none", display: "inline-block" } as const;

  return (
    <div style={{ width: "100%", marginTop: 8, border: `1px solid ${C.border}`, borderRadius: 6, background: C.inset, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ color: C.text.fog, fontFamily: MF, fontSize: 9, letterSpacing: "0.14em" }}>◆ SIMULATION</span>
        {credits != null && <span style={{ color: C.text.faint, fontFamily: MF, fontSize: 9 }}>{credits} credit{credits === 1 ? "" : "s"}</span>}
        <button type="button" onClick={() => { setState("idle"); setStatusUrl(null); setNeedBuy(false); }} style={{ marginLeft: "auto", color: C.text.faint, background: "transparent", border: "none", fontFamily: MF, fontSize: 10, cursor: "pointer" }}>✕</button>
      </div>

      {state === "building" && <div style={{ color: C.text.faint, fontFamily: MF, fontSize: 10 }}>building scenario…</div>}

      {res?.scenario && state !== "building" && (
        <div style={{ color: C.text.bright, fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}>{res.scenario}</div>
      )}

      {/* Buy-credits panel — shown when out of credits (manual txHash verify, same rail as PRO). */}
      {needBuy && (
        <div style={{ border: `1px solid ${C.borderStrong}`, borderRadius: 5, padding: "9px 10px", marginBottom: 8 }}>
          <div style={{ color: C.text.bright, fontFamily: MF, fontSize: 10.5, fontWeight: 700, marginBottom: 5 }}>Out of sim credits — 1 credit (${price}) per run</div>
          <div style={{ color: C.text.fog, fontSize: 11, lineHeight: 1.5, marginBottom: 7 }}>
            Send {buyChain === "arbitrum" ? `≥ ${price} USDC on Arbitrum` : `≥ $${price} of $NEXUS on Base`} to <span style={{ color: C.text.bright, wordBreak: "break-all" }}>{SIM_RECEIVER}</span> (${price} = 1 credit, buy any amount), then paste the tx below.
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {(["arbitrum", "base"] as const).map((ch) => (
              <button key={ch} onClick={() => setBuyChain(ch)} style={{ ...linkBtn, fontSize: 9.5, padding: "3px 9px", color: buyChain === ch ? C.text.bright : C.text.faint, borderColor: buyChain === ch ? C.borderStrong : C.border, cursor: "pointer" }}>{ch === "arbitrum" ? "USDC · Arbitrum" : "$NEXUS · Base"}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input value={buyTx} onChange={(e) => setBuyTx(e.target.value)} placeholder="0x… transaction hash" spellCheck={false}
              style={{ flex: 1, minWidth: 160, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 3, padding: "5px 8px", color: C.text.bright, fontFamily: MF, fontSize: 10 }} />
            <button type="button" onClick={verifyBuy} disabled={busy} className="nx-press" style={{ ...linkBtn, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>Verify payment</button>
          </div>
          {buyMsg && <div style={{ color: buyMsg.startsWith("✓") ? C.pos : C.text.fog, fontFamily: MF, fontSize: 9.5, marginTop: 6, lineHeight: 1.4 }}>{buyMsg}</div>}
        </div>
      )}

      {state === "preview" && (res?.enabled
        ? <button type="button" onClick={runPaid} className="nx-press" style={{ ...linkBtn, cursor: "pointer" }}>▶ Run simulation{credits != null && credits > 0 ? " (1 credit)" : ""}</button>
        : <div style={{ color: C.text.faint, fontFamily: MF, fontSize: 9.5, lineHeight: 1.5 }}>Live simulation is switching on shortly — check back.</div>)}

      {state === "running" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span className="nx-live-dot" style={{ flexShrink: 0 }} />
            <span style={{ color: C.text.fog, fontFamily: MF, fontSize: 10 }}>{prog?.stage ? `${prog.stage}…` : "running simulation — 25 agents reacting hour by hour…"}</span>
            {typeof prog?.progress === "number" && <span style={{ marginLeft: "auto", color: C.text.bright, fontFamily: MF, fontSize: 10, fontWeight: 700 }}>{prog.progress}%</span>}
          </div>
          {typeof prog?.progress === "number" && (
            <div style={{ height: 3, background: C.border, borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
              <div style={{ height: "100%", width: `${Math.max(3, prog.progress)}%`, background: C.pos, transition: "width 0.5s ease" }} />
            </div>
          )}
          {prog?.message && <div style={{ color: C.text.faint, fontFamily: MF, fontSize: 9, lineHeight: 1.5 }}>{String(prog.message).slice(0, 140)}</div>}
        </div>
      )}

      {state === "done" && (done?.error
        ? <div style={{ color: C.neg, fontFamily: MF, fontSize: 10 }}>{done.error}</div>
        : (
          <div>
            <div style={{ color: C.pos, fontFamily: MF, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>✓ Simulation complete</div>
            {done?.message && done.message !== "completed" && <div style={{ color: C.text.bright, fontSize: 12, lineHeight: 1.55, marginBottom: 8 }}>{String(done.message)}</div>}
            {done?.shareUrl && <a href={done.shareUrl} target="_blank" rel="noopener noreferrer" style={linkBtn}>View full report ↗</a>}
          </div>
        ))}

      <div style={{ color: C.text.faint, fontFamily: MF, fontSize: 8.5, lineHeight: 1.5, marginTop: 8 }}>{res?.disclaimer || "Synthetic simulation — a thinking tool to pressure-test the trade, not a signal."}</div>
    </div>
  );
}
