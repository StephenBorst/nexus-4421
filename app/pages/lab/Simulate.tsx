// ── SIMULATION (Miroshark) — run a trade/scenario INLINE, poll to completion ──
// Shared across the Lab (THE READ, the Mispriced fade, the Conviction Scanner, any setup).
// Builds the scenario → on confirm runs the paid Miroshark sim via our x402 proxy
// (POST /wargame {run:true}) → the run is ASYNC, so we POLL /wargame/status and stream live
// progress (25 agents reacting over 10 rounds), then link the finished report. Synthetic — a
// thinking tool to pressure-test the trade, NEVER a signal. Two-step so a run is deliberate.
import { useState, useEffect } from "react";
import { C } from "@/config/theme";
import { AGENT_API } from "./agentTypes";

const MF = "var(--nx-font-mono)";
type SimResult = { scenario?: string; enabled?: boolean; ran?: unknown; error?: string; disclaimer?: string; job?: { status_url?: string; data?: { status_url?: string } } };
type Prog = { stage?: string; progress?: number; message?: string };

export function Simulate({ body, label = "◆ Simulate" }: { body: Record<string, unknown>; label?: string }) {
  const [state, setState] = useState<"idle" | "building" | "preview" | "running" | "done">("idle");
  const [res, setRes] = useState<SimResult | null>(null);
  const [statusUrl, setStatusUrl] = useState<string | null>(null);
  const [prog, setProg] = useState<Prog | null>(null);
  const [done, setDone] = useState<{ shareUrl?: string; message?: string; error?: string } | null>(null);

  const build = () => {
    setState("building");
    fetch(`${AGENT_API}/wargame`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json()).then((d: SimResult) => { setRes(d); setState("preview"); })
      .catch(() => { setRes({ error: "couldn't build the scenario" }); setState("preview"); });
  };
  const runPaid = () => {
    setState("running"); setProg(null); setDone(null);
    fetch(`${AGENT_API}/wargame`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, run: true }) })
      .then((r) => r.json()).then((d: SimResult) => {
        const su = d?.job?.status_url || d?.job?.data?.status_url;
        if (d?.ran === "queued" && su) { setStatusUrl(su); } // → polling effect
        else { setDone({ error: d?.error || "simulation didn't queue — try again" }); setState("done"); }
      })
      .catch(() => { setDone({ error: "simulation failed — try again" }); setState("done"); });
  };

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
        if (x.status === "completed" || x.completed_at) { setDone({ shareUrl: x.share_url, message: x.message }); setState("done"); return; }
        if (x.status === "failed" || x.error) { setDone({ error: x.error || "simulation failed" }); setState("done"); return; }
      } catch { /* transient — keep polling */ }
      if (++tries > 90) { setDone({ error: "simulation timed out — check back" }); setState("done"); return; } // ~7.5min
      if (!stop) setTimeout(tick, 5000);
    };
    tick();
    return () => { stop = true; };
  }, [statusUrl, state]);

  if (state === "idle") return (
    <button type="button" onClick={build} className="nx-press"
      style={{ color: C.text.fog, background: "transparent", border: `1px solid ${C.borderStrong}`, borderRadius: 3, padding: "3px 10px", fontFamily: MF, fontSize: 10, cursor: "pointer", whiteSpace: "nowrap" }}
      title="Pressure-test this trade — 25 AI agents react across markets and communities over 10 rounds">{label}</button>
  );

  return (
    <div style={{ width: "100%", marginTop: 8, border: `1px solid ${C.border}`, borderRadius: 6, background: C.inset, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ color: C.text.fog, fontFamily: MF, fontSize: 9, letterSpacing: "0.14em" }}>◆ SIMULATION</span>
        <button type="button" onClick={() => { setState("idle"); setStatusUrl(null); }} style={{ marginLeft: "auto", color: C.text.faint, background: "transparent", border: "none", fontFamily: MF, fontSize: 10, cursor: "pointer" }}>✕</button>
      </div>

      {state === "building" && <div style={{ color: C.text.faint, fontFamily: MF, fontSize: 10 }}>building scenario…</div>}

      {res?.scenario && state !== "building" && (
        <div style={{ color: C.text.bright, fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}>{res.scenario}</div>
      )}

      {state === "preview" && (res?.enabled
        ? <button type="button" onClick={runPaid} className="nx-press"
            style={{ color: C.text.bright, background: "transparent", border: `1px solid ${C.borderStrong}`, borderRadius: 3, padding: "4px 12px", fontFamily: MF, fontSize: 10.5, cursor: "pointer" }}>▶ Run simulation</button>
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
            {done?.shareUrl && (
              <a href={done.shareUrl} target="_blank" rel="noopener noreferrer"
                style={{ display: "inline-block", color: C.text.bright, background: "transparent", border: `1px solid ${C.borderStrong}`, borderRadius: 3, padding: "4px 12px", fontFamily: MF, fontSize: 10.5, textDecoration: "none" }}>
                View full report ↗
              </a>
            )}
          </div>
        ))}

      <div style={{ color: C.text.faint, fontFamily: MF, fontSize: 8.5, lineHeight: 1.5, marginTop: 8 }}>{res?.disclaimer || "Synthetic simulation — a thinking tool to pressure-test the trade, not a signal."}</div>
    </div>
  );
}
