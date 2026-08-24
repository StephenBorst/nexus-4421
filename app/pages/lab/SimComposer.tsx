// ── SIM COMPOSER — set up ANY trade or scenario, then simulate it ─────────────
// The featured premium surface for the Miroshark sim. Unlike a fixed "test THIS
// coin" button, this lets a trader compose whatever they want to pressure-test: a
// structured trade setup (coin / direction / entry / target / notes) OR a totally
// free-form scenario ("BTC reclaims 80k and ETH ETF inflows spike"). It builds the
// scenario body the /wargame endpoint understands and hands it to <Simulate> (the
// credits-gated, poll-to-completion runner). Synthetic red-team — never a signal.
// Placed in the highest-leverage decision spots: Quick Trade + the Thesis Engine.
import { useState } from "react";
import { C } from "@/config/theme";
import { Simulate } from "./Simulate";

const MF = "var(--nx-font-mono)";
const UI = "var(--nx-font-ui, sans-serif)";
const ACCENT = "#8b7fd4";

export type SimSeed = { coin?: string; direction?: "LONG" | "SHORT"; entry?: string; target?: string; notes?: string };

const cleanTicker = (s: string) => s.trim().toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");

const fieldStyle: React.CSSProperties = {
  background: C.inset, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text.bright,
  fontFamily: MF, fontSize: 12, padding: "7px 9px", width: "100%", boxSizing: "border-box",
};
const miniLabel: React.CSSProperties = { fontFamily: MF, fontSize: 8.5, letterSpacing: "0.1em", color: C.text.faint, marginBottom: 4 };

/**
 * @param wallet   connected address (for the credits-gated run)
 * @param seed     optional prefill for the TRADE SETUP mode
 * @param compact  slightly denser framing when embedded under an existing panel
 */
export function SimComposer({ wallet, seed, compact = false }: { wallet: string | null; seed?: SimSeed; compact?: boolean }) {
  const [mode, setMode] = useState<"trade" | "free">("trade");
  const [coin, setCoin] = useState(seed?.coin ? cleanTicker(seed.coin) : "BTC");
  const [direction, setDirection] = useState<"LONG" | "SHORT">(seed?.direction || "LONG");
  const [entry, setEntry] = useState(seed?.entry || "");
  const [target, setTarget] = useState(seed?.target || "");
  const [notes, setNotes] = useState(seed?.notes || "");
  const [query, setQuery] = useState("");

  const c = cleanTicker(coin);
  const body: Record<string, unknown> = mode === "trade"
    ? { kind: "thesis", coin: c || "the asset", direction, entry: entry.trim() || undefined, target: target.trim() || undefined, notes: notes.trim() || undefined }
    : { query: query.trim() };
  const canRun = mode === "trade" ? !!c : query.trim().length >= 8;

  return (
    <div style={{ border: `1px solid #2b2740`, borderLeft: `2px solid ${ACCENT}`, borderRadius: 8, background: "linear-gradient(180deg,#15131c,#111015)", padding: compact ? "12px 14px" : "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MF, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", color: "#c7bdf0" }}>◆ SIM</span>
        <span style={{ fontFamily: MF, fontSize: 8, letterSpacing: "0.14em", color: ACCENT, border: `1px solid #3a3358`, borderRadius: 3, padding: "1px 6px" }}>PREMIUM</span>
        <span style={{ marginLeft: "auto", fontFamily: MF, fontSize: 8.5, color: "#6f6a86" }}>powered by Miroshark</span>
      </div>
      <div style={{ fontFamily: UI, fontSize: 12, color: "#b8b2cc", lineHeight: 1.55, marginBottom: 11 }}>
        Set up <b style={{ color: "#ded8f0" }}>any trade or scenario</b> and pressure-test it — a crowd of grounded AI agents debates and trades it across 10 rounds, surfacing the bull case, the bear case, the invalidation, and where consensus lands. <span style={{ color: "#8b8299" }}>A thinking tool, never a signal.</span>
      </div>

      {/* Mode toggle: structured trade vs free-form scenario */}
      <div style={{ display: "inline-flex", gap: 0, marginBottom: 11, border: `1px solid #3a3358`, borderRadius: 4, overflow: "hidden" }}>
        {([["trade", "TRADE SETUP"], ["free", "FREE SCENARIO"]] as const).map(([m, lbl]) => {
          const on = mode === m;
          return (
            <button key={m} onClick={() => setMode(m)} style={{
              background: on ? `${ACCENT}22` : "transparent", border: "none", cursor: "pointer",
              color: on ? "#ded8f0" : "#8b8299", fontFamily: MF, fontSize: 9.5, fontWeight: on ? 700 : 400,
              letterSpacing: "0.08em", padding: "5px 12px",
            }}>{lbl}</button>
          );
        })}
      </div>

      {mode === "trade" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 11 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 9 }}>
            <div>
              <div style={miniLabel}>ASSET</div>
              <input value={coin} onChange={(e) => setCoin(e.target.value.toUpperCase())} placeholder="BTC" spellCheck={false} style={fieldStyle} />
            </div>
            <div>
              <div style={miniLabel}>DIRECTION</div>
              <div style={{ display: "flex", gap: 6 }}>
                {(["LONG", "SHORT"] as const).map((d) => {
                  const on = direction === d;
                  const col = d === "LONG" ? C.pos : C.neg;
                  return (
                    <button key={d} onClick={() => setDirection(d)} style={{
                      flex: 1, background: on ? `${col}1e` : "transparent", border: `1px solid ${on ? col : "#3a3358"}`,
                      borderRadius: 4, cursor: "pointer", color: on ? col : "#8b8299", fontFamily: MF, fontSize: 10.5, fontWeight: on ? 700 : 400, padding: "7px 0",
                    }}>{d === "LONG" ? "↑ LONG" : "↓ SHORT"}</button>
                  );
                })}
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
            <div>
              <div style={miniLabel}>ENTRY <span style={{ color: "#4a4658" }}>(optional)</span></div>
              <input value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="e.g. 77,000" spellCheck={false} style={fieldStyle} />
            </div>
            <div>
              <div style={miniLabel}>TARGET <span style={{ color: "#4a4658" }}>(optional)</span></div>
              <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. 84,000" spellCheck={false} style={fieldStyle} />
            </div>
          </div>
          <div>
            <div style={miniLabel}>THESIS / CONTEXT <span style={{ color: "#4a4658" }}>(optional — sharpens the sim)</span></div>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 400))} rows={2} placeholder="why this trade — catalyst, level, timeframe…"
              style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.4 }} />
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 11 }}>
          <div style={miniLabel}>SCENARIO</div>
          <textarea value={query} onChange={(e) => setQuery(e.target.value.slice(0, 500))} rows={3} spellCheck={false}
            placeholder="Describe anything to simulate — e.g. “BTC reclaims 80k on ETF inflows while funding stays negative — do alts follow or does BTC dominance rip?”"
            style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.45 }} />
        </div>
      )}

      {canRun ? (
        <Simulate key={`${mode}:${mode === "trade" ? `${c}:${direction}` : "free"}`}
          label="◆ Run the sim →" wallet={wallet} body={body} />
      ) : (
        <div style={{ fontFamily: MF, fontSize: 9.5, color: C.text.faint, lineHeight: 1.5 }}>
          {mode === "trade" ? "Enter an asset to run the simulation." : "Describe the scenario (a sentence or two) to run the simulation."}
        </div>
      )}
    </div>
  );
}

export default SimComposer;
