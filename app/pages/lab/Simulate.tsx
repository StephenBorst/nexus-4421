// ── SIMULATION (Miroshark) — run a trade/scenario INLINE, no hand-off ─────────
// Shared across the Lab (Macro events, the Mispriced fade, any tradeable setup).
// Builds the scenario, then on confirm runs the paid Miroshark simulation through our
// backend x402 proxy (POST /wargame {run:true}) and renders the result right here.
// Synthetic — a thinking tool to pressure-test the trade, NEVER a signal. Two-step so a
// run is always a deliberate action.
import { useState } from "react";
import { C } from "@/config/theme";
import { AGENT_API } from "./agentTypes";

const MF = "var(--nx-font-mono)";
type SimResult = { scenario?: string; enabled?: boolean; ran?: boolean; result?: unknown; error?: string; disclaimer?: string };

export function Simulate({ body, label = "◆ Simulate" }: { body: Record<string, unknown>; label?: string }) {
  const [state, setState] = useState<"idle" | "building" | "preview" | "running" | "done">("idle");
  const [res, setRes] = useState<SimResult | null>(null);

  const build = () => {
    setState("building");
    fetch(`${AGENT_API}/wargame`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json()).then((d: SimResult) => { setRes(d); setState("preview"); })
      .catch(() => { setRes({ error: "couldn't build the scenario" }); setState("preview"); });
  };
  const runPaid = () => {
    setState("running");
    fetch(`${AGENT_API}/wargame`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, run: true }) })
      .then((r) => r.json()).then((d: SimResult) => { setRes(d); setState("done"); })
      .catch(() => { setRes((p) => ({ ...(p || {}), error: "simulation failed — try again" })); setState("done"); });
  };

  if (state === "idle") return (
    <button type="button" onClick={build} className="nx-press"
      style={{ color: C.text.fog, background: "transparent", border: `1px solid ${C.borderStrong}`, borderRadius: 3, padding: "3px 10px", fontFamily: MF, fontSize: 10, cursor: "pointer", whiteSpace: "nowrap" }}
      title="Simulate how this plays out — hundreds of agents react across markets and communities">{label}</button>
  );

  return (
    <div style={{ width: "100%", marginTop: 8, border: `1px solid ${C.border}`, borderRadius: 6, background: C.inset, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ color: C.text.fog, fontFamily: MF, fontSize: 9, letterSpacing: "0.14em" }}>◆ SIMULATION</span>
        <button type="button" onClick={() => setState("idle")} style={{ marginLeft: "auto", color: C.text.faint, background: "transparent", border: "none", fontFamily: MF, fontSize: 10, cursor: "pointer" }}>✕</button>
      </div>

      {state === "building" && <div style={{ color: C.text.faint, fontFamily: MF, fontSize: 10 }}>building scenario…</div>}

      {res?.scenario && state !== "building" && (
        <div style={{ color: C.text.bright, fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}>{res.scenario}</div>
      )}

      {state === "preview" && (res?.enabled
        ? <button type="button" onClick={runPaid} className="nx-press"
            style={{ color: C.text.bright, background: "transparent", border: `1px solid ${C.borderStrong}`, borderRadius: 3, padding: "4px 12px", fontFamily: MF, fontSize: 10.5, cursor: "pointer" }}>▶ Run simulation</button>
        : <div style={{ color: C.text.faint, fontFamily: MF, fontSize: 9.5, lineHeight: 1.5 }}>Live simulation is switching on shortly — check back.</div>)}

      {state === "running" && <div style={{ color: C.text.faint, fontFamily: MF, fontSize: 10 }}>running simulation — hundreds of agents reacting hour by hour…</div>}

      {state === "done" && (res?.ran && res.result != null
        ? <SimOutput result={res.result} />
        : <div style={{ color: C.neg, fontFamily: MF, fontSize: 10 }}>{res?.error || "no result — try again"}</div>)}

      <div style={{ color: C.text.faint, fontFamily: MF, fontSize: 8.5, lineHeight: 1.5, marginTop: 8 }}>{res?.disclaimer || "Synthetic simulation — a thinking tool to pressure-test the trade, not a signal."}</div>
    </div>
  );
}

// Render Miroshark's result flexibly — human-readable summary if present, else a
// readable dump (the exact shape is finalized after the first live run).
function SimOutput({ result }: { result: unknown }) {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const text = typeof result === "string" ? result : (r.summary || r.report || r.text || r.answer) as string | undefined;
  if (text) return <div style={{ color: C.text.bright, fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{String(text)}</div>;
  return <pre style={{ color: C.text.fog, fontFamily: MF, fontSize: 10, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, maxHeight: 320, overflow: "auto" }}>{JSON.stringify(result, null, 2)}</pre>;
}
