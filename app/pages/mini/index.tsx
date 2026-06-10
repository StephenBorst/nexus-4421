/**
 * /mini — Nexus Farcaster Mini App (v2 — in-frame trading).
 *
 * v1 (zero-auth): identity + LIVE CALLS feed + native Buy $NEXUS + share + Add App.
 * v2 (this): one-tap perps IN the frame. Flow reuses the proven lab-api /trade:
 *   frame wallet → personal_sign('nexus-trading-key-v1') → POST /trade
 *   (server derives the Orderly key from the sig, places the order via Orderly REST).
 * Works for a wallet already registered + funded on Nexus; a fresh wallet gets
 * `wallet_not_registered` → we surface an "enable on the full terminal" CTA
 * (onboarding/deposit is the next phase).
 *
 * ⚠️ REAL money. Order summary + confirm-tap before send. NOT wrapped in the
 * heavy OrderlyProvider — frames stay light; we hit /trade over REST directly.
 */

import { useEffect, useState } from "react";
import sdk from "@farcaster/miniapp-sdk";

const bg = "#0a0e0a";
const green = "#00ff88";
const red = "#ff4444";
const mono = "monospace";
const APP = "https://trade.nexustradinglabs.com";
const API = "https://og.nexustradinglabs.com";
const NEXUS = "0x3D958634ab725B627919EF8F2Ed59227309fDba3";
const NEXUS_CAIP19 = `eip155:8453/erc20:${NEXUS}`;
const ADDED_KEY = "nexus_mini_added";
const MARKETS = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE"];

type FUser = { fid?: number; username?: string; displayName?: string; pfpUrl?: string };
type Thesis = {
  id: string; symbol: string; direction: "LONG" | "SHORT"; riskReward: number;
  status: string; wallet: string; displayName: string | null; agent?: boolean;
};
type TradeMsg = { ok: boolean; text: string; cta?: boolean } | null;

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "#4a9fff", HIT_TP: "#00ff88", STOPPED_OUT: "#ff4444", INVALIDATED: "#fbbf24", CLOSED: "#8aaa9a",
};
const tk = (s: string) => s.replace("PERP_", "").replace("_USDC", "");
const shortAddr = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;

export default function MiniApp() {
  const [booted, setBooted] = useState(false);
  const [inFrame, setInFrame] = useState<boolean | null>(null);
  const [user, setUser] = useState<FUser | null>(null);
  const [feed, setFeed] = useState<Thesis[] | null>(null);
  const [buying, setBuying] = useState(false);
  const [added, setAdded] = useState(false);

  // Trade sheet
  const [tradeOpen, setTradeOpen] = useState(false);
  const [sym, setSym] = useState("BTC");
  const [notional, setNotional] = useState(25);
  const [lev, setLev] = useState(5);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [confirmSide, setConfirmSide] = useState<null | "LONG" | "SHORT">(null);
  const [tradeMsg, setTradeMsg] = useState<TradeMsg>(null);

  useEffect(() => {
    (async () => {
      try {
        const isMini = await sdk.isInMiniApp();
        setInFrame(isMini);
        if (isMini) {
          const ctx = await sdk.context;
          setUser((ctx?.user as FUser) ?? null);
          await sdk.actions.ready();
          if (typeof window !== "undefined" && !window.localStorage.getItem(ADDED_KEY)) {
            window.localStorage.setItem(ADDED_KEY, "1");
            try { await sdk.actions.addMiniApp(); setAdded(true); } catch { /* dismissed */ }
          }
        }
      } catch { /* ignore */ }
      finally { setBooted(true); }
    })();
  }, []);

  useEffect(() => {
    fetch(`${API}/feed`).then((r) => r.json())
      .then((d: { feed?: Thesis[] }) => setFeed((d.feed ?? []).slice(0, 12)))
      .catch(() => setFeed([]));
  }, []);

  async function buyNexus() {
    if (buying) return;
    setBuying(true);
    try { await sdk.actions.viewToken({ token: NEXUS_CAIP19 }); }
    catch { try { await sdk.actions.swapToken({ buyToken: NEXUS_CAIP19 }); } catch { /* ignore */ } }
    finally { setBuying(false); }
  }
  async function saveApp() { try { await sdk.actions.addMiniApp(); setAdded(true); } catch { /* ignore */ } }
  async function shareApp() {
    try { await sdk.actions.composeCast({ text: "trading on Nexus 🟢 verifiable track records, autonomous agents & one-tap perps — the terminal that makes you better.", embeds: [`${APP}/mini`] }); } catch { /* ignore */ }
  }
  async function shareThesis(t: Thesis) {
    try { await sdk.actions.composeCast({ text: `${tk(t.symbol)} ${t.direction} — ${t.displayName || shortAddr(t.wallet)}'s call on Nexus. graded on-chain, not vibes 🟢`, embeds: [`${APP}/feed/thesis/${t.wallet}/${t.id}`] }); } catch { /* ignore */ }
  }

  // ── In-frame trade: sign → POST /trade ──
  async function placeTrade(side: "LONG" | "SHORT") {
    if (tradeBusy) return;
    if (confirmSide !== side) { // fat-finger guard on real money
      setConfirmSide(side); setTradeMsg(null);
      setTimeout(() => setConfirmSide((c) => (c === side ? null : c)), 3000);
      return;
    }
    setConfirmSide(null); setTradeBusy(true); setTradeMsg(null);
    try {
      const provider = await sdk.wallet.getEthereumProvider();
      if (!provider) throw new Error("no wallet");
      const accts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const addr = accts?.[0];
      if (!addr) throw new Error("connect a wallet");
      // Deterministic EIP-191 sig → server derives the Orderly key (same as registration).
      // Hex-encode the message (standard personal_sign; wallet decodes to the same UTF-8 bytes).
      const msgHex = ("0x" + Array.from(new TextEncoder().encode("nexus-trading-key-v1")).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
      const walletSig = (await provider.request({ method: "personal_sign", params: [msgHex, addr as `0x${string}`] })) as string;
      const r = await fetch(`${API}/trade`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym, side: side === "LONG" ? "BUY" : "SELL", notional, leverage: lev, walletSig, walletAddress: addr }),
      });
      const d = await r.json();
      if (r.ok && !d.error) setTradeMsg({ ok: true, text: `✓ ${side} ${sym} placed — $${notional} @ ${lev}x` });
      else if (d.error === "wallet_not_registered") setTradeMsg({ ok: false, text: "This wallet isn't enabled for trading yet.", cta: true });
      else setTradeMsg({ ok: false, text: d.message || d.error || "trade failed" });
    } catch (e) {
      setTradeMsg({ ok: false, text: (e as Error)?.message || "error" });
    } finally {
      setTradeBusy(false);
    }
  }

  const shell: React.CSSProperties = { background: bg, color: "#e5e7eb", minHeight: "100dvh", fontFamily: mono, padding: 14, display: "flex", flexDirection: "column", gap: 11 };
  const card: React.CSSProperties = { background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 6, padding: 12 };
  const liveCount = feed?.filter((t) => t.status === "ACTIVE").length ?? 0;
  const margin = notional / (lev || 1);

  return (
    <div style={shell}>
      {/* Header */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: green, fontWeight: "bold", letterSpacing: "0.25em" }}>//</span>
          <span style={{ color: "#fff", fontWeight: "bold", letterSpacing: "0.2em" }}>NEXUS</span>
          <button onClick={saveApp} style={{ marginLeft: "auto", background: added ? "#0a2a0a" : "none", border: `1px solid ${added ? "#1a4a2a" : "#1a2e1a"}`, borderRadius: 3, color: added ? green : "#5a8a6a", fontFamily: mono, fontSize: 9, padding: "3px 9px", cursor: "pointer", letterSpacing: "0.06em" }}>{added ? "★ SAVED" : "★ SAVE"}</button>
        </div>
        <div style={{ fontSize: 9, color: "#3a6a4a", marginTop: 4, letterSpacing: "0.05em" }}>the terminal that makes you a better trader</div>
      </div>

      {!booted && <div style={{ ...card, color: "#3a6a4a", fontSize: 12 }}>loading…</div>}

      {booted && inFrame === false && (
        <div style={{ ...card, fontSize: 12, color: "#8aaa9a", lineHeight: 1.6 }}>
          Open this inside <b style={{ color: green }}>Warpcast</b> to use it.
          <div style={{ marginTop: 8 }}><a href={APP} style={{ color: green, textDecoration: "none" }}>→ open the full terminal</a></div>
        </div>
      )}

      {/* Identity */}
      {booted && inFrame && user && (
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 10, padding: "9px 12px" }}>
          {user.pfpUrl && <img src={user.pfpUrl} alt="" style={{ width: 28, height: 28, borderRadius: "50%", border: "1px solid #1a3a1a" }} />}
          <div style={{ fontSize: 12, color: "#fff", fontWeight: "bold" }}>{user.displayName || user.username || "you"}</div>
          <span style={{ marginLeft: "auto", fontSize: 9, color: green }}>● live</span>
        </div>
      )}

      {/* TRADE (hero) */}
      <button onClick={() => { setTradeOpen((o) => !o); setTradeMsg(null); }} style={{ background: tradeOpen ? "#0a1a0a" : green, color: tradeOpen ? green : "#04130c", border: `1px solid ${green}`, borderRadius: 5, padding: "12px 0", fontFamily: mono, fontSize: 13, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.06em" }}>
        ⚡ {tradeOpen ? "CLOSE TRADE" : "TRADE PERPS"}
      </button>

      {tradeOpen && (
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Market */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {MARKETS.map((m) => (
              <button key={m} onClick={() => { setSym(m); setTradeMsg(null); }} style={{ background: m === sym ? "#00ff8815" : "#0a0e0a", border: `1px solid ${m === sym ? "#00ff8860" : "#1e2d1e"}`, borderRadius: 3, padding: "4px 11px", cursor: "pointer", color: m === sym ? green : "#4a7a5a", fontFamily: mono, fontSize: 12 }}>{m}</button>
            ))}
          </div>
          {/* Size + leverage */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontSize: 8, color: "#3a6a4a", letterSpacing: "0.1em" }}>SIZE (USDC)</div>
              <input type="number" inputMode="decimal" min={1} value={notional} onChange={(e) => setNotional(Math.max(0, parseFloat(e.target.value) || 0))} style={{ width: "100%", boxSizing: "border-box", marginTop: 4, background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 4, color: "#e5e7eb", fontFamily: mono, fontSize: 13, padding: "7px 9px" }} />
            </div>
            <div>
              <div style={{ fontSize: 8, color: "#3a6a4a", letterSpacing: "0.1em" }}>LEVERAGE — {lev}x</div>
              <input type="range" min={1} max={20} step={1} value={lev} onChange={(e) => setLev(parseInt(e.target.value, 10))} style={{ width: "100%", marginTop: 12 }} />
            </div>
          </div>
          <div style={{ fontSize: 9, color: "#5a8a6a" }}>notional <b style={{ color: "#fff" }}>${notional.toFixed(0)}</b> · margin <b style={{ color: "#fff" }}>${margin.toFixed(2)}</b></div>
          {/* Long / Short */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={() => placeTrade("LONG")} disabled={tradeBusy || notional <= 0} style={{ background: green, color: "#04130c", border: `1px solid ${green}`, borderRadius: 4, padding: "12px 0", fontFamily: mono, fontSize: 13, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.06em", opacity: tradeBusy && confirmSide !== "LONG" ? 0.4 : 1 }}>{tradeBusy ? "…" : confirmSide === "LONG" ? "TAP TO CONFIRM ✓" : "↑ LONG"}</button>
            <button onClick={() => placeTrade("SHORT")} disabled={tradeBusy || notional <= 0} style={{ background: red, color: "#fff", border: `1px solid ${red}`, borderRadius: 4, padding: "12px 0", fontFamily: mono, fontSize: 13, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.06em", opacity: tradeBusy && confirmSide !== "SHORT" ? 0.4 : 1 }}>{tradeBusy ? "…" : confirmSide === "SHORT" ? "TAP TO CONFIRM ✓" : "↓ SHORT"}</button>
          </div>
          {tradeMsg && (
            <div style={{ fontSize: 10, color: tradeMsg.ok ? green : "#fbbf24", lineHeight: 1.5 }}>
              {tradeMsg.text}
              {tradeMsg.cta && <> <a href={APP} style={{ color: green, textDecoration: "none" }}>enable on the full terminal ↗</a></>}
            </div>
          )}
          <div style={{ fontSize: 8, color: "#2a4a3a" }}>real market order on Orderly · signs once to authorize</div>
        </div>
      )}

      {/* Buy / Share */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button onClick={buyNexus} disabled={buying} style={{ background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 5, padding: "10px 0", fontFamily: mono, fontSize: 11, fontWeight: "bold", cursor: buying ? "wait" : "pointer", letterSpacing: "0.04em", opacity: buying ? 0.6 : 1 }}>{buying ? "OPENING…" : "🪙 BUY $NEXUS"}</button>
        <button onClick={shareApp} style={{ background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 5, padding: "10px 0", fontFamily: mono, fontSize: 11, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.04em" }}>↗ SHARE</button>
      </div>

      {/* Live calls feed */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
        <span style={{ fontSize: 9, color: "#3a6a4a", letterSpacing: "0.12em" }}>📡 LIVE CALLS</span>
        {liveCount > 0 && <span style={{ fontSize: 9, color: green }}>{liveCount} active</span>}
      </div>
      {feed === null && <div style={{ ...card, color: "#3a6a4a", fontSize: 11 }}>loading feed…</div>}
      {feed && feed.length === 0 && <div style={{ ...card, color: "#3a6a4a", fontSize: 11 }}>no calls yet — be the first 🟢</div>}
      {feed && feed.map((t) => {
        const sc = STATUS_COLOR[t.status] ?? "#8aaa9a";
        return (
          <div key={t.id} style={{ ...card, display: "flex", flexDirection: "column", gap: 7, padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "#8aaa9a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{t.agent ? "Nexus Agent" : (t.displayName || shortAddr(t.wallet))}</span>
              {t.agent && <span style={{ flexShrink: 0, fontSize: 8, color: "#4a9fff", border: "1px solid #1a3a5a", borderRadius: 3, padding: "0 4px" }}>🤖</span>}
              <span style={{ flexShrink: 0, fontSize: 8, color: sc, border: `1px solid ${sc}33`, borderRadius: 3, padding: "1px 6px", marginLeft: "auto" }}>{t.status}</span>
              <button onClick={() => shareThesis(t)} title="Share to cast" style={{ flexShrink: 0, background: "none", border: "1px solid #1a2e1a", borderRadius: 3, color: "#5a8a6a", fontFamily: mono, fontSize: 10, padding: "2px 7px", cursor: "pointer" }}>↗</button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 15, fontWeight: "bold", color: "#fff" }}>{tk(t.symbol)}</span>
              <span style={{ fontSize: 10, color: t.direction === "LONG" ? green : red }}>{t.direction === "LONG" ? "↑" : "↓"} {t.direction}</span>
              <span style={{ fontSize: 10, color: t.riskReward >= 2 ? green : "#fbbf24" }}>R:R 1:{t.riskReward?.toFixed?.(2) ?? "—"}</span>
            </div>
          </div>
        );
      })}

      <div style={{ fontSize: 8, color: "#2a4a3a", textAlign: "center", marginTop: 4, lineHeight: 1.5 }}>
        verify, don&apos;t trust
        <br />
        <a href={APP} style={{ color: "#3a6a4a", textDecoration: "none" }}>full terminal ↗</a>
      </div>
    </div>
  );
}
