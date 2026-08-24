/**
 * QuickTrade — one-tap MARKET order ticket (Lab tab).
 *
 * A minimal, fast trade ticket on top of Orderly's SDK (useOrderEntry). Pick a
 * market, size (USDC notional), leverage, and tap LONG / SHORT → a real market
 * order. The full pro UI stays on the perp page; this is the Rainbow/Volt-style
 * instant ticket. Numbers (notional / margin / est. liq) are shown BEFORE the tap
 * — real funds, not paper, so no blind-fire.
 *
 * "A few taps" polish: per-SYMBOL max leverage (BTC 100x, small-caps 20x — not a
 * flat cap), typeable leverage + preset chips, one-tap size chips (incl. MAX off
 * free collateral × leverage), the DEX's OWN favorites (same store as the trading
 * page — star here, it shows there), and a featured Miroshark sim to pressure-
 * test the exact trade before you fire.
 */

import { useEffect, useMemo, useState } from "react";
import { ThesisAdvisor } from "./ThesisAdvisor";
import { useOrderEntry, useLeverage, useMaxLeverage, useCollateral, useAccount, usePositionStream, usePositionClose, useMarkets, MarketsType } from "@orderly.network/hooks";
import { OrderSide, OrderType } from "@orderly.network/types";
import { TradeChart } from "@/components/TradeChart";
import { SimComposer } from "./SimComposer";

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
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 4, flexWrap: "wrap" }}>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: "bold", color: "#fff", minWidth: 56 }}>{ticker}</span>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: isLong ? "#3ecf8e" : "#f7525f" }}>{isLong ? "↑ LONG" : "↓ SHORT"}</span>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#a1a1aa" }}>{Math.abs(qty)} @ ${entry.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold", color: uPnl >= 0 ? "#3ecf8e" : "#f7525f" }}>{uPnl >= 0 ? "+" : ""}${uPnl.toFixed(2)}</span>
      <button onClick={close} disabled={isMutating} style={{
        marginLeft: "auto", background: "#241012", color: "#f7525f", border: "1px solid #4a1e22", borderRadius: 3,
        padding: "5px 12px", cursor: isMutating ? "wait" : "pointer", fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold", letterSpacing: "0.06em",
      }}>{isMutating ? "CLOSING…" : "CLOSE"}</button>
      {err && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#f7525f", width: "100%" }}>{err}</span>}
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

const card: React.CSSProperties = { background: "#141416", border: "1px solid #232327", borderRadius: 6, padding: 16 };
const label: React.CSSProperties = { fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#71717a" };
const input: React.CSSProperties = { background: "#0a0a0b", border: "1px solid #232327", borderRadius: 4, color: "#f4f4f5", fontFamily: "var(--nx-font-mono)", fontSize: 14, padding: "8px 10px", width: "100%", boxSizing: "border-box" };

// A market chip (used for popular / favorites / search). Star-toggle is optional.
function MktChip({ s, sel, onPick }: { s: string; sel: boolean; onPick: () => void }) {
  return (
    <button onClick={onPick} style={{
      background: sel ? "#ededf015" : "#0a0a0b", border: `1px solid ${sel ? "#ededf060" : "#232327"}`,
      borderRadius: 3, padding: "5px 12px", cursor: "pointer", color: sel ? "#ededf0" : "#71717a",
      fontFamily: "var(--nx-font-mono)", fontSize: 12,
    }}>{tk(s)}</button>
  );
}

export function QuickTrade() {
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const connected = !!walletAddress;

  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [notional, setNotional] = useState(100);
  // Full tradable market list (all 130+ Orderly perps) for the search picker —
  // same source as the Farcaster mini app. Fetched once, fail-soft.
  const [allMarkets, setAllMarkets] = useState<string[]>([]);
  const [mktSearch, setMktSearch] = useState("");
  useEffect(() => {
    fetch("https://api-evm.orderly.org/v1/public/info")
      .then((r) => r.json())
      .then((d) => {
        const rows = (d?.data?.rows ?? []).filter((m: { status?: string }) => m.status === "ACTIVE");
        setAllMarkets(rows.map((m: { symbol: string }) => m.symbol).sort((a: string, b: string) => tk(a).localeCompare(tk(b))));
      })
      .catch(() => setAllMarkets([]));
  }, []);

  // The DEX's OWN favorites (same store the trading page writes) — reading and
  // toggling here keeps them in perfect sync with the rest of the app.
  const [allMktItems, marketsStore] = useMarkets(MarketsType.ALL);
  const favSymbols = useMemo(
    () => (allMktItems || []).filter((m) => (m as { isFavorite?: boolean }).isFavorite).map((m) => (m as { symbol: string }).symbol),
    [allMktItems],
  );
  const curFav = favSymbols.includes(symbol);
  const favTab = (marketsStore?.selectedFavoriteTab || marketsStore?.favoriteTabs?.[0] || { name: "Favorites", id: 1 }) as never;
  function toggleFav(sym: string) {
    const item = (allMktItems || []).find((m) => (m as { symbol: string }).symbol === sym);
    if (!item || !marketsStore?.updateSymbolFavoriteState) return;
    marketsStore.updateSymbolFavoriteState(item as never, favTab, !!(item as { isFavorite?: boolean }).isFavorite);
  }

  const { curLeverage, maxLeverage, update: updateLeverage } = useLeverage();
  // Per-SYMBOL max leverage (respects each market's base_imr) — BTC 100x, alts 20x.
  const symbolMaxLev = useMaxLeverage(symbol);
  const [lev, setLev] = useState<number>(5);
  const { totalCollateral, freeCollateral } = useCollateral();
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

  // Per-symbol cap (fall back to the account max, then a safe 20x). No flat 50x tax.
  const cap = Math.max(1, Math.round(symbolMaxLev || maxLeverage || 20));
  const levClamped = Math.min(Math.max(1, lev || 1), cap);
  // If the symbol's cap dropped below the current lev (switching BTC→alt), pull it in.
  useEffect(() => { setLev((l) => Math.min(Math.max(1, l), cap)); }, [cap]);
  const margin = notional / (levClamped || 1);

  // Curated leverage presets for this market + always the max.
  const levPresets = useMemo(() => {
    const set = Array.from(new Set([2, 5, 10, 20, 50, cap].filter((v) => v >= 1 && v <= cap)));
    return set.sort((a, b) => a - b);
  }, [cap]);

  const minNotional = Number((symbolInfo as { min_notional?: number } | undefined)?.min_notional) || 0;
  const mmr = Number((symbolInfo as { base_mmr?: number } | undefined)?.base_mmr) || 0.005;
  const mark = Number(markPrice) || 0;
  // Approx. isolated-style liquidation: entry ∓ (1/lev − maint-margin). An estimate —
  // cross-margin & fees shift it — but a useful pre-tap "how much room" gauge.
  const liqDistPct = Math.max(0, 1 / levClamped - mmr);
  const liqLong = mark > 0 ? mark * (1 - liqDistPct) : 0;
  const liqShort = mark > 0 ? mark * (1 + liqDistPct) : 0;

  // MAX notional this account can open on the current leverage (free collateral × lev).
  const maxNotional = Math.max(0, Math.floor((Number(freeCollateral) || 0) * levClamped));

  const qty = useMemo(() => {
    if (!markPrice || !symbolInfo) return 0;
    const baseTick = Number((symbolInfo as { base_tick?: number }).base_tick) || 0;
    const baseMin = Number((symbolInfo as { base_min?: number }).base_min) || 0;
    let q = snapQty(notional / markPrice, baseTick, baseMin);
    // Floor-snapping to base_tick can dip the order VALUE under min_notional (e.g. $10
    // HYPE → 0.17 → $9.95 → Orderly "order value ≥ 10"). When the user's notional is
    // itself ≥ min_notional, ceil the qty up to the smallest step that clears it (matches
    // the mini app + agent snapQty). If the user asked for LESS than min_notional it's
    // genuinely too small — left to the tooSmall gate, not silently upsized.
    if (q > 0 && minNotional > 0 && baseTick > 0 && notional >= minNotional && q * markPrice < minNotional) {
      const decimals = Math.max(0, Math.round(-Math.log10(baseTick)));
      const stepsUp = Math.ceil((minNotional / markPrice) / baseTick);
      q = parseFloat((stepsUp * baseTick).toFixed(decimals));
    }
    return q;
  }, [notional, markPrice, symbolInfo, minNotional]);

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
    return <div style={{ textAlign: "center", padding: "48px 20px", fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#71717a" }}>Connect a wallet to place quick trades.</div>;
  }

  const px = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toLocaleString(undefined, { maximumFractionDigits: 4 }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 460, margin: "0 auto" }}>
      <div>
        <div style={{ fontSize: 9, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 5 }}>Trade</div>
        <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: 24, fontWeight: 700, color: "#f4f4f5", lineHeight: 1.1, letterSpacing: "-0.01em" }}>Quick Trade <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, fontWeight: 400, color: "#52525b" }}>· one-tap market order</span></div>
      </div>

      {/* Market selector */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={label}>MARKET</div>
          <button onClick={() => toggleFav(symbol)} title={curFav ? "Remove from your DEX favorites" : "Add to your DEX favorites"} style={{
            marginLeft: "auto", background: "transparent", border: "none", cursor: "pointer", padding: 0,
            fontFamily: "var(--nx-font-mono)", fontSize: 13, color: curFav ? "#e0a458" : "#52525b", lineHeight: 1,
          }}>{curFav ? "★" : "☆"} <span style={{ fontSize: 9, letterSpacing: "0.08em" }}>{curFav ? "FAVORITED" : "FAVORITE"}</span></button>
        </div>

        {/* Your DEX favorites — the same starred markets as the trading page */}
        {favSymbols.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ ...label, color: "#e0a458", marginBottom: 5 }}>★ FAVORITES</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {favSymbols.map((s) => <MktChip key={s} s={s} sel={s === symbol} onPick={() => { setSymbol(s); setMsg(null); }} />)}
            </div>
          </div>
        )}

        <div style={{ ...label, marginTop: favSymbols.length > 0 ? 10 : 8, marginBottom: 5, color: "#52525b" }}>POPULAR</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {/* Popular quick-chips + the active market if it's outside the popular set */}
          {(SYMBOLS.includes(symbol) ? SYMBOLS : [symbol, ...SYMBOLS]).map((s) => (
            <MktChip key={s} s={s} sel={s === symbol} onPick={() => { setSymbol(s); setMsg(null); }} />
          ))}
        </div>
        {/* Search across ALL markets (mirrors the mini app picker) */}
        <input
          value={mktSearch}
          onChange={(e) => setMktSearch(e.target.value.toUpperCase())}
          placeholder={allMarkets.length ? `🔍 search ${allMarkets.length} markets…` : "loading markets…"}
          style={{ ...input, marginTop: 8, fontSize: 12 }}
        />
        {mktSearch && allMarkets.length > 0 && (() => {
          const hits = allMarkets.filter((s) => tk(s).includes(mktSearch));
          return (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, maxHeight: 128, overflowY: "auto" }}>
              {hits.slice(0, 48).map((s) => (
                <MktChip key={s} s={s} sel={s === symbol} onPick={() => { setSymbol(s); setMktSearch(""); setMsg(null); }} />
              ))}
              {hits.length === 0 && <span style={{ ...label, color: "#71717a" }}>no market matches &ldquo;{mktSearch}&rdquo;</span>}
            </div>
          );
        })()}
        <div style={{ ...label, marginTop: 10, color: "#a1a1aa" }}>
          MARK: {markPrice ? `$${px(mark)}` : "—"}
          {totalCollateral != null && <span style={{ marginLeft: 14 }} title="Total account value — all collateral marked to USDC (matches the DEX header)">TOTAL VALUE: ${Number(totalCollateral).toFixed(2)}</span>}
        </div>
        <div style={{ marginTop: 10 }}>
          <TradeChart symbol={symbol} height={232} positionEntry={(() => {
            const p = openPositions.find((x) => String((x as { symbol?: string }).symbol) === symbol);
            if (!p) return null;
            const q = Number((p as { position_qty?: number }).position_qty) || 0;
            const e = Number((p as { average_open_price?: number }).average_open_price) || 0;
            return e > 0 ? { entry: e, side: (q >= 0 ? "LONG" : "SHORT") as "LONG" | "SHORT" } : null;
          })()} />
        </div>
        <div style={{ marginTop: 8, textAlign: "right" }}>
          <a href={`/perp/${symbol}`} style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "#71717a", textDecoration: "none" }}>
            Open full chart →
          </a>
        </div>
      </div>

      {/* Size + leverage */}
      <div style={card}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={label}>SIZE (USDC NOTIONAL)</div>
            <input style={{ ...input, marginTop: 6 }} type="number" min={0} step={10} value={notional}
              onChange={(e) => setNotional(Math.max(0, parseFloat(e.target.value) || 0))} />
            {/* One-tap size chips */}
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              {[25, 100, 500].map((v) => (
                <button key={v} onClick={() => setNotional(v)} style={{
                  background: notional === v ? "#ededf015" : "transparent", border: `1px solid ${notional === v ? "#ededf060" : "#232327"}`,
                  borderRadius: 3, padding: "3px 9px", cursor: "pointer", color: notional === v ? "#ededf0" : "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10,
                }}>${v}</button>
              ))}
              <button onClick={() => maxNotional > 0 && setNotional(maxNotional)} disabled={maxNotional <= 0} title={`Max on ${levClamped}x from free collateral`} style={{
                background: "transparent", border: `1px solid ${maxNotional > 0 ? "#3a3320" : "#232327"}`, borderRadius: 3,
                padding: "3px 9px", cursor: maxNotional > 0 ? "pointer" : "not-allowed", color: maxNotional > 0 ? "#e0a458" : "#3f3f46", fontFamily: "var(--nx-font-mono)", fontSize: 10,
              }}>MAX</button>
            </div>
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <div style={label}>LEVERAGE</div>
              <input type="number" min={1} max={cap} value={lev}
                onChange={(e) => { const v = parseInt(e.target.value, 10); setLev(Number.isFinite(v) ? Math.min(Math.max(1, v), cap) : 1); }}
                style={{ width: 52, background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3, color: "#f4f4f5", fontFamily: "var(--nx-font-mono)", fontSize: 12, padding: "2px 6px", textAlign: "center" }} />
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#f4f4f5", fontWeight: 700 }}>{levClamped}x</span>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", marginLeft: "auto" }}>max {cap}x</span>
            </div>
            <input style={{ marginTop: 10, width: "100%" }} type="range" min={1} max={cap} step={1} value={levClamped}
              onChange={(e) => setLev(parseInt(e.target.value, 10))} />
            <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
              {levPresets.map((v) => (
                <button key={v} onClick={() => setLev(v)} style={{
                  background: levClamped === v ? "#ededf015" : "transparent", border: `1px solid ${levClamped === v ? "#ededf060" : "#232327"}`,
                  borderRadius: 3, padding: "2px 8px", cursor: "pointer", color: levClamped === v ? "#ededf0" : "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 9.5,
                }}>{v === cap ? "MAX" : `${v}x`}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap" }}>
          {[
            { l: "NOTIONAL", v: `$${notional.toFixed(0)}` },
            { l: "MARGIN", v: `$${margin.toFixed(2)}` },
            { l: "EST. QTY", v: qty > 0 ? `${qty} ${tk(symbol)}` : "—" },
          ].map(({ l, v }) => (
            <div key={l}><div style={label}>{l}</div><div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 14, color: "#f4f4f5", fontWeight: 600 }}>{v}</div></div>
          ))}
        </div>
        {/* Est. liquidation gauge — approximate, both directions (no side chosen yet). */}
        {mark > 0 && qty > 0 && (
          <div style={{ ...label, marginTop: 10, color: "#71717a", display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>EST. LIQ · <span style={{ color: "#3ecf8e" }}>LONG ${px(liqLong)}</span></span>
            <span><span style={{ color: "#f7525f" }}>SHORT ${px(liqShort)}</span></span>
            <span style={{ color: "#3f3f46" }}>≈{(liqDistPct * 100).toFixed(1)}% away</span>
          </div>
        )}
        {tooSmall && notional > 0 && (
          <div style={{ ...label, color: "#fbbf24", marginTop: 8 }}>
            Below this market's minimum size{minNotional ? ` ($${minNotional} notional)` : ""}.
          </div>
        )}
      </div>

      {/* Context before a one-tap market order. Quick Trade is where the impulsive
          decisions happen, so it's where the record is most worth seeing — direction
          is deliberately not passed (no side chosen yet, so no alignment claim). */}
      <ThesisAdvisor symbol={symbol} wallet={walletAddress} compact />

      {/* Featured premium: set up ANY trade or scenario and simulate it (seeded from the
          current market for convenience, fully editable — sim whatever you want). */}
      <SimComposer wallet={walletAddress} seed={{ coin: tk(symbol) }} />

      {/* One-tap LONG / SHORT */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <button onClick={() => tap("BUY")} disabled={tooSmall || !!busy || isMutating} style={{
          background: tooSmall ? "#1a1a1e" : "#ededf0", color: tooSmall ? "#71717a" : "#141416", border: "1px solid #ededf0",
          borderRadius: 4, padding: "14px 0", cursor: tooSmall ? "not-allowed" : "pointer", fontFamily: "var(--nx-font-mono)",
          fontSize: 14, fontWeight: "bold", letterSpacing: "0.08em", opacity: busy === "SELL" ? 0.4 : 1,
        }}>{busy === "BUY" ? "PLACING…" : confirmSide === "BUY" ? "TAP TO CONFIRM ✓" : "↑ LONG"}</button>
        <button onClick={() => tap("SELL")} disabled={tooSmall || !!busy || isMutating} style={{
          background: tooSmall ? "#241012" : "#f7525f", color: tooSmall ? "#52525b" : "#fff", border: "1px solid #f7525f",
          borderRadius: 4, padding: "14px 0", cursor: tooSmall ? "not-allowed" : "pointer", fontFamily: "var(--nx-font-mono)",
          fontSize: 14, fontWeight: "bold", letterSpacing: "0.08em", opacity: busy === "BUY" ? 0.4 : 1,
        }}>{busy === "SELL" ? "PLACING…" : confirmSide === "SELL" ? "TAP TO CONFIRM ✓" : "↓ SHORT"}</button>
      </div>

      {msg && (
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: msg.ok ? "#3ecf8e" : "#f7525f", textAlign: "center" }}>{msg.text}</div>
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

      <div style={{ ...label, textAlign: "center", color: "#33333a" }}>
        Real market order on Orderly · for limit / TP-SL use the full trade page
      </div>
    </div>
  );
}
