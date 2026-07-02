/**
 * QuickTrade — one-tap MARKET order ticket (Lab tab).
 *
 * A minimal, fast trade ticket on top of Orderly's SDK (useOrderEntry). Pick a
 * market, size (USDC notional), leverage, and tap LONG / SHORT → a real market
 * order. The full pro UI stays on the perp page; this is the Rainbow/Volt-style
 * instant ticket. Numbers (notional / margin) are shown BEFORE the tap — real
 * funds, not paper, so no blind-fire.
 */

import { useMemo, useState } from "react";
import { useOrderEntry, useLeverage, useCollateral, useAccount, usePositionStream, usePositionClose } from "@orderly.network/hooks";
import { OrderSide, OrderType } from "@orderly.network/types";
import { MiniPriceChart } from "@/components/MiniPriceChart";

/**
 * One open position + a one-tap CLOSE (market, full size). Rendered only when a
 * position exists, so usePositionClose always has a valid position object.
 */
function PositionRow({ position }: { position: Record<string, unknown> }) {
  const qty = Number(position.position_qty) || 0;
  const isLong = qty > 0;
  const entry = Number(position.average_open_price) || 0;
  const uPnl = Number(position.unrealized_pnl) || 0;
  const sym = String(position.symbol || "");
  const ticker = sym.replace("PERP_", "").replace("_USDC", "");
  const { submit, isMutating } = usePositionClose({
    position: position as never,
    order: { type: OrderType.MARKET, quantity: String(Math.abs(qty)), price: "" },
  });
  const [err, setErr] = useState<string | null>(null);

  async function close() {
    setErr(null);
    try { await submit(); } catch (e) { setErr((e as Error)?.message || "close failed"); }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "#0a0e0a", border: "1px solid #1a2e1a", borderRadius: 4, flexWrap: "wrap" }}>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: "bold", color: "#fff", minWidth: 56 }}>{ticker}</span>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: isLong ? "#00ff88" : "#ff4444" }}>{isLong ? "↑ LONG" : "↓ SHORT"}</span>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#8aaa9a" }}>{Math.abs(qty)} @ ${entry.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold", color: uPnl >= 0 ? "#00ff88" : "#ff4444" }}>{uPnl >= 0 ? "+" : ""}${uPnl.toFixed(2)}</span>
      <button onClick={close} disabled={isMutating} style={{
        marginLeft: "auto", background: "#1a0a0a", color: "#ff7a7a", border: "1px solid #4a1a1a", borderRadius: 3,
        padding: "5px 12px", cursor: isMutating ? "wait" : "pointer", fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold", letterSpacing: "0.06em",
      }}>{isMutating ? "CLOSING…" : "CLOSE"}</button>
      {err && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#ff4444", width: "100%" }}>{err}</span>}
    </div>
  );
}

const SYMBOLS = [
  "PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC",
  "PERP_HYPE_USDC", "PERP_XRP_USDC", "PERP_DOGE_USDC",
];
const tk = (s: string) => s.replace("PERP_", "").replace("_USDC", "");

// Snap base qty to the symbol's step size (mirrors the agent's snapQty guard).
function snapQty(raw: number, baseTick: number, baseMin: number): number {
  if (!baseTick || raw <= 0) return 0;
  const decimals = Math.max(0, Math.round(-Math.log10(baseTick)));
  const steps = Math.floor(raw / baseTick);
  let q = parseFloat((steps * baseTick).toFixed(decimals));
  if (baseMin && q < baseMin) q = 0;
  return q;
}

const card: React.CSSProperties = { background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 6, padding: 16 };
const label: React.CSSProperties = { fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#4a7a5a" };
const input: React.CSSProperties = { background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 4, color: "#e8f0ea", fontFamily: "var(--nx-font-mono)", fontSize: 14, padding: "8px 10px", width: "100%", boxSizing: "border-box" };

export function QuickTrade() {
  const { state: accountState } = useAccount();
  const connected = !!(accountState as { address?: string })?.address;

  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [notional, setNotional] = useState(100);
  const { curLeverage, maxLeverage, update: updateLeverage } = useLeverage();
  const [lev, setLev] = useState<number>(5);
  const { availableBalance } = useCollateral();
  const [busy, setBusy] = useState<null | "BUY" | "SELL">(null);
  const [confirmSide, setConfirmSide] = useState<null | "BUY" | "SELL">(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const CONFIRM_OVER = 100; // orders above this $ notional require a confirm tap

  // Small orders fire instantly; larger ones arm a confirm first (fat-finger guard).
  function tap(side: "BUY" | "SELL") {
    if (notional > CONFIRM_OVER && confirmSide !== side) {
      setConfirmSide(side);
      setTimeout(() => setConfirmSide((c) => (c === side ? null : c)), 3000);
      return;
    }
    setConfirmSide(null);
    place(side);
  }

  const { submit, setValues, markPrice, symbolInfo, isMutating } = useOrderEntry(symbol, {});
  const [{ rows: positionRows }] = usePositionStream();
  const openPositions = (positionRows ?? []).filter((p) => Number((p as { position_qty?: number }).position_qty) !== 0);

  const cap = Math.max(1, Math.min(maxLeverage || 20, 50));
  const levClamped = Math.min(lev, cap);
  const margin = notional / (levClamped || 1);

  const qty = useMemo(() => {
    if (!markPrice || !symbolInfo) return 0;
    const baseTick = Number((symbolInfo as { base_tick?: number }).base_tick) || 0;
    const baseMin = Number((symbolInfo as { base_min?: number }).base_min) || 0;
    return snapQty(notional / markPrice, baseTick, baseMin);
  }, [notional, markPrice, symbolInfo]);

  const minNotional = Number((symbolInfo as { min_notional?: number } | undefined)?.min_notional) || 0;
  const tooSmall = qty <= 0 || (minNotional > 0 && notional < minNotional);

  async function place(side: "BUY" | "SELL") {
    if (!connected || tooSmall || busy) return;
    setBusy(side);
    setMsg(null);
    try {
      if (levClamped && levClamped !== curLeverage) {
        try { await updateLeverage({ leverage: levClamped }); } catch { /* keep going at current lev */ }
      }
      setValues({ order_type: OrderType.MARKET, side: side === "BUY" ? OrderSide.BUY : OrderSide.SELL, order_quantity: String(qty) });
      await submit();
      setMsg({ ok: true, text: `${side === "BUY" ? "LONG" : "SHORT"} ${qty} ${tk(symbol)} — order placed ✓` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || "order failed" });
    } finally {
      setBusy(null);
    }
  }

  if (!connected) {
    return <div style={{ textAlign: "center", padding: "48px 20px", fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#4a7a5a" }}>Connect a wallet to place quick trades.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 460, margin: "0 auto" }}>
      <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#8aaa9a" }}>
        <span style={{ color: "#00ff88" }}>//</span> QUICK TRADE <span style={{ color: "#4a7a5a", fontSize: 9 }}>· one-tap market order</span>
      </div>

      {/* Market selector */}
      <div style={card}>
        <div style={label}>MARKET</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {SYMBOLS.map((s) => {
            const sel = s === symbol;
            return (
              <button key={s} onClick={() => { setSymbol(s); setMsg(null); }} style={{
                background: sel ? "#00ff8815" : "#0a0e0a", border: `1px solid ${sel ? "#00ff8860" : "#1e2d1e"}`,
                borderRadius: 3, padding: "5px 12px", cursor: "pointer", color: sel ? "#00ff88" : "#4a7a5a",
                fontFamily: "var(--nx-font-mono)", fontSize: 12,
              }}>{tk(s)}</button>
            );
          })}
        </div>
        <div style={{ ...label, marginTop: 10, color: "#8aaa9a" }}>
          MARK: {markPrice ? `$${Number(markPrice).toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "—"}
          {availableBalance != null && <span style={{ marginLeft: 14 }} title="Free collateral — USDC available to open positions (not locked as margin)">FREE: ${Number(availableBalance).toFixed(2)}</span>}
        </div>
        <div style={{ marginTop: 10 }}>
          <MiniPriceChart symbol={symbol} />
        </div>
      </div>

      {/* Size + leverage */}
      <div style={card}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={label}>SIZE (USDC NOTIONAL)</div>
            <input style={{ ...input, marginTop: 6 }} type="number" min={0} step={10} value={notional}
              onChange={(e) => setNotional(Math.max(0, parseFloat(e.target.value) || 0))} />
          </div>
          <div>
            <div style={label}>LEVERAGE — {levClamped}x <span style={{ color: "#4a7a5a" }}>(max {cap}x)</span></div>
            <input style={{ marginTop: 14, width: "100%" }} type="range" min={1} max={cap} step={1} value={levClamped}
              onChange={(e) => setLev(parseInt(e.target.value, 10))} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap" }}>
          {[
            { l: "NOTIONAL", v: `$${notional.toFixed(0)}` },
            { l: "MARGIN", v: `$${margin.toFixed(2)}` },
            { l: "EST. QTY", v: qty > 0 ? `${qty} ${tk(symbol)}` : "—" },
          ].map(({ l, v }) => (
            <div key={l}><div style={label}>{l}</div><div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 14, color: "#e8f0ea", fontWeight: 600 }}>{v}</div></div>
          ))}
        </div>
        {tooSmall && notional > 0 && (
          <div style={{ ...label, color: "#fbbf24", marginTop: 8 }}>
            Below this market's minimum size{minNotional ? ` ($${minNotional} notional)` : ""}.
          </div>
        )}
      </div>

      {/* One-tap LONG / SHORT */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <button onClick={() => tap("BUY")} disabled={tooSmall || !!busy || isMutating} style={{
          background: tooSmall ? "#0a1a0a" : "#00ff88", color: tooSmall ? "#4a7a5a" : "#04130c", border: "1px solid #00ff88",
          borderRadius: 4, padding: "14px 0", cursor: tooSmall ? "not-allowed" : "pointer", fontFamily: "var(--nx-font-mono)",
          fontSize: 14, fontWeight: "bold", letterSpacing: "0.08em", opacity: busy === "SELL" ? 0.4 : 1,
        }}>{busy === "BUY" ? "PLACING…" : confirmSide === "BUY" ? "TAP TO CONFIRM ✓" : "↑ LONG"}</button>
        <button onClick={() => tap("SELL")} disabled={tooSmall || !!busy || isMutating} style={{
          background: tooSmall ? "#1a0a0a" : "#ff4444", color: tooSmall ? "#6a3a3a" : "#fff", border: "1px solid #ff4444",
          borderRadius: 4, padding: "14px 0", cursor: tooSmall ? "not-allowed" : "pointer", fontFamily: "var(--nx-font-mono)",
          fontSize: 14, fontWeight: "bold", letterSpacing: "0.08em", opacity: busy === "BUY" ? 0.4 : 1,
        }}>{busy === "SELL" ? "PLACING…" : confirmSide === "SELL" ? "TAP TO CONFIRM ✓" : "↓ SHORT"}</button>
      </div>

      {msg && (
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: msg.ok ? "#00ff88" : "#ff4444", textAlign: "center" }}>{msg.text}</div>
      )}

      {/* Open positions — close any without leaving the tab (full loop) */}
      {openPositions.length > 0 && (
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={label}>OPEN POSITIONS</div>
          {openPositions.map((p, i) => (
            <PositionRow key={String((p as { symbol?: string }).symbol) || i} position={p as unknown as Record<string, unknown>} />
          ))}
        </div>
      )}

      <div style={{ ...label, textAlign: "center", color: "#2a4a3a" }}>
        Real market order on Orderly · for limit / TP-SL use the full trade page
      </div>
    </div>
  );
}
