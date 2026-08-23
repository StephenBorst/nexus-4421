import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { C } from "@/config/theme";

// ── CONVICTION SCANNER — the engine, market-wide ─────────────────────────────
// THE READ synthesizes ~12 orthogonal axes for ONE symbol you're drafting. This is
// the triage view over the whole board: for every funding-stretched market it tallies
// how many INDEPENDENT reads (funding fade + on-chain smart money + the graded caller
// crowd) point the SAME way, and ranks by agreement. The fade is only worth your
// attention where uncorrelated sources CONFIRM it — this surfaces those at a glance.
// Cheap by design: three cached batch endpoints, no per-coin fan-out. Click a row to
// draft the fade → THE READ shows the full multi-axis conviction for that symbol.

const AGENT_API = "https://og.nexustradinglabs.com";
const MONO = "var(--nx-font-mono)";

type Read = { label: string; ok: boolean; had: boolean };
type Row = { coin: string; direction: "LONG" | "SHORT"; fundingAnnualPct: number; extra: number; against: number; reads: Read[] };

const bare = (s: string) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");

export function ConvictionScanner() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let off = false;
    const load = () => {
      Promise.all([
        fetch(`${AGENT_API}/intel/mispriced`).then((r) => r.json()).catch(() => null),
        fetch(`${AGENT_API}/smart/consensus`).then((r) => r.json()).catch(() => null),
        fetch(`${AGENT_API}/theses/consensus`).then((r) => r.json()).catch(() => null),
      ]).then(([mp, sm, cons]) => {
        if (off) return;
        const smMap: Record<string, { side?: string; count?: number }> = sm?.consensus || {};
        const cMap: Record<string, { side?: string; participants?: number }> = cons?.consensus || {};
        const markets = (mp?.markets || []).filter((m: { direction?: string }) => m.direction === "LONG" || m.direction === "SHORT");
        const out: Row[] = markets.map((m: { coin: string; direction: "LONG" | "SHORT"; fundingAnnualPct: number }) => {
          const coin = bare(m.coin);
          const dir = m.direction;
          const reads: Read[] = [{ label: "funding", ok: true, had: true }];
          const s = smMap[coin];
          if (s?.side === "LONG" || s?.side === "SHORT") reads.push({ label: "smart", ok: s.side === dir, had: true });
          const c = cMap[coin];
          if ((c?.side === "LONG" || c?.side === "SHORT")) reads.push({ label: "callers", ok: c.side === dir, had: true });
          const extra = reads.filter((r) => r.label !== "funding" && r.ok).length; // confirmations beyond funding
          const against = reads.filter((r) => !r.ok).length;
          return { coin, direction: dir, fundingAnnualPct: m.fundingAnnualPct, extra, against, reads };
        });
        // Rank: net confirmation (extra − against) first, then bigger funding edge.
        out.sort((a, b) => (b.extra - b.against) - (a.extra - a.against) || Math.abs(b.fundingAnnualPct) - Math.abs(a.fundingAnnualPct));
        setRows(out.slice(0, 8));
      }).catch(() => { if (!off) setRows([]); });
    };
    load();
    const id = setInterval(load, 60000);
    return () => { off = true; clearInterval(id); };
  }, []);

  const draft = (r: Row) => {
    const crowd = r.direction === "SHORT" ? "long" : "short";
    const d = {
      symbol: r.coin, direction: r.direction,
      catalyst: `Funding fade · ${r.fundingAnnualPct >= 0 ? "+" : ""}${r.fundingAnnualPct}%/yr, crowd offside ${crowd}`,
      notes: `Multi-axis conviction scan flagged this fade. Open THE READ for the full breakdown; set your own entry, stop and target.`,
    };
    try { window.localStorage.setItem("nexus_thesis_draft", JSON.stringify(d)); } catch { /* private mode */ }
    try { window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "thesis" } })); window.dispatchEvent(new CustomEvent("nexus:thesis-draft")); } catch { /* ignore */ }
    navigate(`/lab?tab=thesis`);
  };

  if (rows === null) return <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.text.faint, padding: "8px 0" }}>Scanning the board…</div>;
  if (!rows.length) return null;

  const convOf = (r: Row) => {
    const net = r.extra - r.against;
    if (net >= 2) return { word: "HIGH", color: C.pos };
    if (net === 1) return { word: "MODERATE", color: "#8fdcb8" };
    if (r.against > r.extra) return { word: "CONFLICTED", color: C.warn };
    return { word: "FUNDING-ONLY", color: C.text.muted };
  };

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: C.text.bright }}>◆ CONVICTION SCANNER</span>
        <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.text.faint, letterSpacing: "0.05em" }}>the engine, market-wide · funding × smart money × graded callers</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {rows.map((r) => {
          const conv = convOf(r);
          const dc = r.direction === "LONG" ? C.pos : C.neg;
          return (
            <button key={r.coin} onClick={() => draft(r)} style={{ appearance: "none", WebkitAppearance: "none", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", width: "100%", textAlign: "left", cursor: "pointer", background: C.surfaceAlt, border: `1px solid ${C.border}`, borderLeft: `2px solid ${conv.color}`, borderRadius: 6, padding: "9px 12px" }}>
              <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.text.bright, minWidth: 52 }}>{r.coin}</span>
              <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: dc, minWidth: 54 }}>{r.direction === "LONG" ? "↑ LONG" : "↓ SHORT"}</span>
              <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: conv.color, minWidth: 92 }}>◆ {conv.word}</span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
                {r.reads.map((rd) => (
                  <span key={rd.label} style={{ fontFamily: MONO, fontSize: 8.5, color: rd.ok ? C.pos : C.neg, border: `1px solid ${rd.ok ? "#2a3a30" : "#3a2530"}`, borderRadius: 3, padding: "1px 5px" }}>{rd.ok ? "✓" : "✗"} {rd.label}</span>
                ))}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.text.fog }}>{r.fundingAnnualPct >= 0 ? "+" : ""}{r.fundingAnnualPct}%/yr</span>
              <span style={{ fontFamily: MONO, fontSize: 9, color: C.accent }}>⚡ READ →</span>
            </button>
          );
        })}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 8, color: C.text.faint, marginTop: 7, lineHeight: 1.5 }}>Ranked by how many independent reads confirm the fade — open THE READ for the full ~12-axis breakdown. Not advice.</div>
    </div>
  );
}

export default ConvictionScanner;
