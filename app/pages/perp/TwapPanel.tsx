import { useCallback, useEffect, useRef, useState } from "react";
import { getWalletAddress, getAgentSig } from "@/pages/lab/agentKeys";

// ── TWAP execution panel (our own, on-infra) ─────────────────────────────────
// The order-panel surface for native TWAP. Instead of sending a whole order at
// once, work it over a duration you choose — sliced into N market children fired
// by the exec cron via your order-only key (cannot withdraw). Build-vs-buy: this
// runs on Nexus infra, not a third-party hosted backend. The heavy validation +
// scheduling is server-side (POST /twap/:addr/start → twapSchedule); this panel
// configures, previews, launches, and tracks. Fail-soft, brand-consistent.

const AGENT_API = "https://og.nexustradinglabs.com";
const BONE = "#ededf0", DIM = "#71717a", FAINT = "#52525b";
const POS = "#3ecf8e", NEG = "#f7525f", WARN = "#fbbf24";
const CARD = "#141416", LINE = "rgba(255,255,255,0.07)";
const MIN_SLICE_USD = 10; // mirrors the server's effective slice floor (max(10, min_notional))

type Side = "BUY" | "SELL";
interface TwapSlice { seq: number; qty: number; notionalEst: number; offsetMs: number; done: boolean; orderId: string | null; error: string | null; firedAt?: number; filledNotional?: number }
interface TwapState {
  status: "ACTIVE" | "COMPLETE" | "CANCELLED";
  symbol: string; side: Side; leverage: number; totalNotional: number;
  startedAt: number; intervalMs: number; slices: TwapSlice[];
  progress: { total: number; filled: number; filledNotional: number; remaining: number };
}

const bare = (s: string) => s.replace(/^PERP_/, "").replace(/_USDC$/, "");
const fmtDur = (min: number) => (min >= 60 ? `${(min / 60).toFixed(min % 60 ? 1 : 0)}h` : `${min}m`);

export function TwapPanel({ symbol }: { symbol: string }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<Side>("BUY");
  const [notional, setNotional] = useState("500");
  const [duration, setDuration] = useState("30");
  const [slices, setSlices] = useState("6");
  const [leverage, setLeverage] = useState("2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [twap, setTwap] = useState<TwapState | null>(null);
  const wallet = typeof window !== "undefined" ? getWalletAddress() : null;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    try {
      const r = await fetch(`${AGENT_API}/twap/${wallet.toLowerCase()}`);
      const d = await r.json();
      setTwap(d?.twap ?? null);
    } catch { /* fail-soft */ }
  }, [wallet]);

  // Load current TWAP on mount + when the panel opens; poll while one is ACTIVE.
  useEffect(() => { if (open) refresh(); }, [open, refresh]);
  useEffect(() => {
    if (twap?.status === "ACTIVE") {
      pollRef.current = setInterval(refresh, 10_000);
      return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }
  }, [twap?.status, refresh]);

  // Client-side preview (the server is authoritative; this just guides the input).
  const nNum = Math.max(0, Number(notional) || 0);
  const sNum = Math.max(2, Math.min(50, Math.round(Number(slices) || 0)));
  const dNum = Math.max(1, Number(duration) || 0);
  const perSlice = nNum / sNum;
  const intervalMin = dNum / sNum;
  const previewOk = nNum > 0 && perSlice >= MIN_SLICE_USD;
  const maxSlicesForSize = Math.floor(nNum / MIN_SLICE_USD);

  const start = async () => {
    if (!wallet) { setError("Connect your wallet first."); return; }
    setError(null); setBusy(true);
    try {
      const walletSig = await getAgentSig(wallet);
      const r = await fetch(`${AGENT_API}/twap/${wallet.toLowerCase()}/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, side, totalNotional: nNum, durationMin: dNum, slices: sNum, leverage: Math.max(1, Math.min(50, Number(leverage) || 1)), walletSig }),
      });
      const d = await r.json();
      if (!r.ok || d?.error) { setError(d?.reason || d?.hint || d?.error || "Could not start TWAP."); }
      else { setTwap(d.twap); }
    } catch (e) { setError(e instanceof Error ? e.message : "Signing was rejected."); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      const walletSig = await getAgentSig(wallet);
      await fetch(`${AGENT_API}/twap/${wallet.toLowerCase()}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletSig }),
      });
      await refresh();
    } catch { /* fail-soft */ }
    finally { setBusy(false); }
  };

  const active = twap?.status === "ACTIVE";
  const pct = twap ? Math.round((twap.progress.filled / Math.max(1, twap.progress.total)) * 100) : 0;

  const inputStyle: React.CSSProperties = {
    width: "100%", background: "#0d0d0f", border: `1px solid ${LINE}`, borderRadius: 2,
    color: BONE, fontFamily: "var(--nx-font-mono)", fontSize: 13, padding: "7px 9px", outline: "none",
  };
  const labelStyle: React.CSSProperties = { color: FAINT, fontSize: 9, fontFamily: "var(--nx-font-mono)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4, display: "block" };

  return (
    <div style={{ maxWidth: 940, margin: "0 auto", padding: "0 12px 24px" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="nx-press"
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
          background: CARD, border: `1px solid ${LINE}`, borderRadius: 2, padding: "10px 14px",
          color: BONE, fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em",
        }}
      >
        <span style={{ color: active ? POS : BONE }}>⧗ TWAP EXECUTION</span>
        <span style={{ color: FAINT, fontWeight: 400, letterSpacing: 0, fontSize: 11 }}>
          {active ? `running · ${twap!.progress.filled}/${twap!.progress.total} slices` : `work a ${bare(symbol)} order over time`}
        </span>
        <span style={{ marginLeft: "auto", color: FAINT }}>{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div style={{ border: `1px solid ${LINE}`, borderTop: "none", borderRadius: "0 0 2px 2px", background: CARD, padding: 16 }}>
          {active ? (
            /* ── Live TWAP monitor ── */
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ color: twap!.side === "BUY" ? POS : NEG, fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 700 }}>{twap!.side} {bare(twap!.symbol)}</span>
                <span style={{ color: DIM, fontFamily: "var(--nx-font-mono)", fontSize: 11 }}>${twap!.totalNotional.toLocaleString()} · {twap!.leverage}x · {twap!.slices.length} slices</span>
                <span style={{ marginLeft: "auto", color: BONE, fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700 }}>{pct}%</span>
              </div>
              <div style={{ height: 6, background: "#0d0d0f", borderRadius: 3, overflow: "hidden", marginBottom: 12 }}>
                <div style={{ width: `${pct}%`, height: "100%", background: POS, transition: "width 0.4s" }} />
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12 }}>
                {twap!.slices.map((s) => (
                  <span key={s.seq} title={s.error || (s.done ? `filled ~$${s.filledNotional ?? s.notionalEst}` : "pending")} style={{
                    width: 22, height: 22, borderRadius: 2, display: "inline-flex", alignItems: "center", justifyContent: "center",
                    fontFamily: "var(--nx-font-mono)", fontSize: 9,
                    background: s.done ? "#0e2a1c" : s.error ? "#2a1408" : "#0d0d0f",
                    border: `1px solid ${s.done ? POS + "66" : s.error ? WARN + "66" : LINE}`,
                    color: s.done ? POS : s.error ? WARN : FAINT,
                  }}>{s.done ? "✓" : s.error ? "!" : s.seq + 1}</span>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button type="button" onClick={cancel} disabled={busy} className="nx-press" style={{
                  color: NEG, background: "transparent", border: `1px solid ${NEG}55`, borderRadius: 2,
                  padding: "6px 14px", fontFamily: "var(--nx-font-mono)", fontSize: 11, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
                }}>{busy ? "…" : "◼ CANCEL TWAP"}</button>
                <span style={{ color: FAINT, fontFamily: "var(--nx-font-mono)", fontSize: 10, lineHeight: 1.5 }}>
                  Filled slices remain your position. Cancel stops new slices only.
                </span>
              </div>
            </div>
          ) : (
            /* ── Configure + launch ── */
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                {(["BUY", "SELL"] as Side[]).map((s) => (
                  <button key={s} type="button" onClick={() => setSide(s)} className="nx-press" style={{
                    flex: 1, padding: "8px 0", borderRadius: 2, cursor: "pointer",
                    fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em",
                    background: side === s ? (s === "BUY" ? "#0e2a1c" : "#2a0e12") : "#0d0d0f",
                    border: `1px solid ${side === s ? (s === "BUY" ? POS : NEG) + "88" : LINE}`,
                    color: side === s ? (s === "BUY" ? POS : NEG) : DIM,
                  }}>{s === "BUY" ? "BUY / LONG" : "SELL / SHORT"}</button>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 14 }}>
                <div><label style={labelStyle}>Total size (USDC)</label><input inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value)} style={inputStyle} /></div>
                <div><label style={labelStyle}>Duration (min)</label><input inputMode="decimal" value={duration} onChange={(e) => setDuration(e.target.value)} style={inputStyle} /></div>
                <div><label style={labelStyle}>Slices</label><input inputMode="numeric" value={slices} onChange={(e) => setSlices(e.target.value)} style={inputStyle} /></div>
                <div><label style={labelStyle}>Leverage</label><input inputMode="numeric" value={leverage} onChange={(e) => setLeverage(e.target.value)} style={inputStyle} /></div>
              </div>

              <div style={{ background: "#0d0d0f", border: `1px solid ${LINE}`, borderRadius: 2, padding: "10px 12px", marginBottom: 14 }}>
                <div style={{ color: FAINT, fontSize: 9, fontFamily: "var(--nx-font-mono)", letterSpacing: "0.12em", marginBottom: 6 }}>PREVIEW</div>
                {previewOk ? (
                  <div style={{ color: "#c4c4cc", fontSize: 12, fontFamily: "var(--nx-font-mono)", lineHeight: 1.6 }}>
                    <b style={{ color: BONE }}>{sNum}</b> slices of ~<b style={{ color: BONE }}>${perSlice.toFixed(2)}</b> every{" "}
                    <b style={{ color: BONE }}>{intervalMin < 1 ? `${Math.round(intervalMin * 60)}s` : `${intervalMin.toFixed(1)}m`}</b> over{" "}
                    <b style={{ color: BONE }}>{fmtDur(dNum)}</b> · {side === "BUY" ? "building a long" : "building a short"} in {bare(symbol)}
                  </div>
                ) : (
                  <div style={{ color: WARN, fontSize: 12, fontFamily: "var(--nx-font-mono)", lineHeight: 1.5 }}>
                    Each slice must be ≥ ${MIN_SLICE_USD}. {nNum > 0 ? `At $${nNum}, use ≤ ${Math.max(1, maxSlicesForSize)} slices, or raise the total.` : "Enter a total size."}
                  </div>
                )}
              </div>

              {error && <div style={{ color: NEG, fontSize: 11, fontFamily: "var(--nx-font-mono)", marginBottom: 12, lineHeight: 1.5 }}>{error}</div>}

              <button type="button" onClick={start} disabled={busy || !previewOk || !wallet} className="nx-press" style={{
                width: "100%", padding: "11px 0", borderRadius: 2, cursor: (busy || !previewOk || !wallet) ? "default" : "pointer",
                fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 700, letterSpacing: "0.08em",
                background: (busy || !previewOk || !wallet) ? "#1a1a1e" : BONE,
                color: (busy || !previewOk || !wallet) ? FAINT : "#0a0a0b",
                border: "none",
              }}>{busy ? "SIGNING…" : !wallet ? "CONNECT WALLET TO RUN TWAP" : "▶ START TWAP"}</button>

              <div style={{ marginTop: 10, color: FAINT, fontSize: 9.5, fontFamily: "var(--nx-font-mono)", lineHeight: 1.6 }}>
                One signature authorizes an order-only key (can trade, never withdraw). Slices fire as MARKET orders on Nexus infra — no third-party backend. You keep whatever fills; cancel anytime.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TwapPanel;
