import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SectionHeader } from "./components";
import { THESIS_DRAFT_KEY } from "@/config/assistantTools";
import { fusePositioning, positioningRead } from "@/lib/positioning.mjs";
import { C } from "@/config/theme";

// ── POSITIONING — the crowd (funding) fused with the smart money (wallets) ────
// Phase 2 of the OBSERVE re-slice. Leads the Smart Money tab: one read per coin that
// joins where the CROWD is over-extended (funding-fade, from /intel/mispriced) with where
// the SHARP wallets are positioned (/smart/board). CONFLUENCE = both point the same way
// (high conviction); SPLIT = the smart money is with the crowd (the debate). The deep
// boards (Smart Money, the funding board) sit below. Fail-soft + sparse at cold-start.

const AGENT_API = "https://og.nexustradinglabs.com";
const MONO = "var(--nx-font-mono)";
const UI = "var(--nx-font-ui, sans-serif)";
const BONE = "#ededf0", FOG = "#a1a1aa", MUTED = "#71717a", FAINT = "#52525b";
const POS = "#3ecf8e", NEG = "#f7525f", WARN = "#e0a458", BORDER = "#232327", INSET = "#08080a";

type MispricedMkt = { coin?: string; symbol?: string; direction: "LONG" | "SHORT" | "NONE"; status: string; fundingAnnualPct: number; edge: number };
type SmTrader = { address: string; positions: { coin?: string; sym?: string | null; side: "LONG" | "SHORT"; szUsd: number }[] };
type Fused = {
  coin: string; verdict: "CONFLUENCE" | "SPLIT" | "CROWD" | "SMART"; crowdFade: "LONG" | "SHORT" | null;
  smartSide: "LONG" | "SHORT" | null; fundingAnnualPct: number | null; edge: number; smartTraders: number; smartNetUsd: number;
};

const dirColor = (d: string | null) => (d === "LONG" ? POS : d === "SHORT" ? NEG : MUTED);
const verdictStyle: Record<string, { label: string; color: string; bg: string }> = {
  CONFLUENCE: { label: "◆ CONFLUENCE", color: BONE, bg: "#1a1a1e" },
  SPLIT: { label: "⚡ SPLIT", color: WARN, bg: "#1c1608" },
  CROWD: { label: "CROWD", color: FOG, bg: "#141416" },
  SMART: { label: "SMART", color: FOG, bg: "#141416" },
};

export function PositioningBoard() {
  const [mispriced, setMispriced] = useState<MispricedMkt[] | null>(null);
  const [board, setBoard] = useState<SmTrader[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let off = false;
    const load = () => {
      fetch(`${AGENT_API}/intel/mispriced`).then((r) => r.json()).then((d) => { if (!off) setMispriced(Array.isArray(d?.markets) ? d.markets : []); }).catch(() => { if (!off) setMispriced([]); });
      fetch(`${AGENT_API}/smart/board`).then((r) => r.json()).then((d) => { if (!off) setBoard(Array.isArray(d?.traders) ? d.traders : []); }).catch(() => { if (!off) setBoard([]); });
    };
    load();
    const iv = setInterval(load, 60_000);
    return () => { off = true; clearInterval(iv); };
  }, []);

  const rows = useMemo<Fused[]>(
    () => (mispriced && board ? (fusePositioning(mispriced, board) as Fused[]) : []),
    [mispriced, board],
  );
  const loading = mispriced === null || board === null;
  // Lead with the reads that combine both signals; keep a few singles for context.
  const shown = useMemo(() => {
    const both = rows.filter((r) => r.verdict === "CONFLUENCE" || r.verdict === "SPLIT");
    const singles = rows.filter((r) => r.verdict === "CROWD" || r.verdict === "SMART");
    return [...both, ...singles.slice(0, Math.max(0, 8 - both.length))].slice(0, 8);
  }, [rows]);

  const draftFade = (r: Fused) => {
    if (!r.crowdFade) return;
    const draft = {
      symbol: r.coin, direction: r.crowdFade, entryPrice: "", stopLoss: "", takeProfit1: "",
      notes: r.verdict === "CONFLUENCE"
        ? `Positioning confluence — the funding-fade and the smart money both point ${r.crowdFade} on ${r.coin} (${r.smartTraders} sharp wallets ${r.smartSide?.toLowerCase()}${r.fundingAnnualPct != null ? `, funding ${r.fundingAnnualPct}%/yr` : ""}). High-conviction lean.`
        : `Crowd fade — funding says fade ${r.crowdFade} on ${r.coin}${r.fundingAnnualPct != null ? ` (${r.fundingAnnualPct}%/yr)` : ""}. The sharp wallets haven't taken a side yet.`,
      catalyst: r.verdict === "CONFLUENCE" ? "crowd + smart money confluence" : "funding-crowd fade",
      targetWindow: undefined,
    };
    try { window.localStorage.setItem(THESIS_DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
    navigate(`/lab?tab=thesis`);
    try { window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "thesis" } })); window.dispatchEvent(new CustomEvent("nexus:thesis-draft")); } catch { /* SSR */ }
  };

  const confluence = shown.filter((r) => r.verdict === "CONFLUENCE").length;

  return (
    <div style={{ marginBottom: 8 }}>
      <SectionHeader
        eyebrow="// POSITIONING"
        title="Crowd vs. smart money"
        note={confluence > 0 ? `${confluence} CONFLUENCE` : "FADE VS FOLLOW"}
      />
      <div style={{ fontFamily: UI, fontSize: 13.5, color: FOG, lineHeight: 1.6, maxWidth: 640, marginBottom: 14 }}>
        Two boards, one read. The funding board says where the <b style={{ color: BONE }}>crowd</b> is over-extended and which way to fade it;
        the sharp wallets say where the <b style={{ color: BONE }}>smart money</b> sits. When they agree it's <b style={{ color: BONE }}>confluence</b>;
        when the smart money is with the crowd, the fade is <span style={{ color: WARN }}>contested</span>. The deep boards are below.
      </div>

      {loading ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>Fusing the two boards…</div>
      ) : shown.length === 0 ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: MUTED, lineHeight: 1.6, background: INSET, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "12px 14px" }}>
          No clear positioning reads right now — no market is both crowd-stretched and clustered by the sharp wallets. Sparse by design; the deep boards below still have the raw reads.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {shown.map((r) => {
            const v = verdictStyle[r.verdict];
            const actionable = r.verdict === "CONFLUENCE" || r.verdict === "CROWD";
            return (
              <div key={r.coin} style={{ border: `1px solid ${r.verdict === "CONFLUENCE" ? "#33333a" : BORDER}`, background: "#101012", borderRadius: 8, padding: "11px 13px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.1em", color: v.color, background: v.bg, border: `1px solid ${v.color}44`, borderRadius: 3, padding: "2px 7px" }}>{v.label}</span>
                  <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: "#fff" }}>{r.coin}</span>
                  {r.crowdFade && (
                    <span style={{ fontFamily: MONO, fontSize: 9.5, color: FOG }}>crowd → fade <b style={{ color: dirColor(r.crowdFade) }}>{r.crowdFade}</b>{r.fundingAnnualPct != null ? ` · ${r.fundingAnnualPct}%/yr` : ""}</span>
                  )}
                  {r.smartSide && (
                    <span style={{ fontFamily: MONO, fontSize: 9.5, color: FOG }}>smart → <b style={{ color: dirColor(r.smartSide) }}>{r.smartSide}</b> · {r.smartTraders} sharp</span>
                  )}
                  {actionable && (
                    <button type="button" onClick={() => draftFade(r)} className="nx-press"
                      style={{ marginLeft: "auto", color: BONE, background: "transparent", border: "1px solid #33333a", borderRadius: 4, padding: "3px 10px", fontFamily: MONO, fontSize: 10, cursor: "pointer" }}>◆ draft</button>
                  )}
                </div>
                <div style={{ fontFamily: UI, fontSize: 12, color: r.verdict === "SPLIT" ? WARN : FOG, lineHeight: 1.5, marginTop: 7 }}>{positioningRead(r)}</div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 12, color: FAINT, fontSize: 9, fontFamily: MONO, lineHeight: 1.6 }}>
        Crowd lean = annualized funding (fade the one-sided side). Smart lean = the dominant side among tracked sharp wallets (≥2). A read on positioning, not advice — confluence tightens the odds, it doesn't guarantee them.
      </div>
      <div style={{ height: 1, background: BORDER, marginTop: 20 }} />
    </div>
  );
}

export default PositioningBoard;
