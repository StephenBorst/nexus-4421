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
import { STRATEGY_PRESETS } from "@/config/strategyPresets";

// The flagship "Proven Edge" preset — single source of truth with the Lab, so the
// mini-app one-tap deploy can never drift from the web preset.
const PROVEN_EDGE = STRATEGY_PRESETS.find((p) => p.id === "proven-edge")?.config ?? {};

const bg = "#0a0e0a";
const green = "#00ff88";
const red = "#ff4444";
const mono = "var(--nx-font-mono)";
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
type Mkt = { price: number; change: number; funding: number; high: number; low: number; vol: number; oi: number; nextFunding: number };
type Candle = { o: number; h: number; l: number; c: number };
type PosRow = { symbol: string; position_qty: number; average_open_price: number; mark_price: number; unrealized_pnl: number };
type Acct = { free: number; total: number };
type PaperTrade = { pnl?: number };
type AgentStatus = {
  config?: { mode?: string; signalMode?: string; symbols?: string[] } | null;
  state?: { active?: boolean; current_position?: unknown; paper_trades?: PaperTrade[] } | null;
} | null;

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "#4a9fff", HIT_TP: "#00ff88", STOPPED_OUT: "#ff4444", INVALIDATED: "#fbbf24", CLOSED: "#8aaa9a",
};
const tk = (s: string) => s.replace("PERP_", "").replace("_USDC", "");
const shortAddr = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const fmtPrice = (n: number) =>
  n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
  : n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : n < 100 ? 4 : 2 });

// Compact USD (e.g. $35.9M, $1.2B) for volume / open interest.
const fmtUsd = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;

// "3h 12m" until the next funding timestamp (ms).
const fundingIn = (ts: number) => {
  const ms = ts - Date.now();
  if (ms <= 0) return "soon";
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

// Dependency-free candlestick chart (TradingView UDF OHLC → SVG). Keeps the frame
// light; mirrors the Lab's terminal aesthetic (mono + #00ff88 / #ff4444).
function AssetChart({ data }: { data: Candle[] | null }) {
  const box: React.CSSProperties = { width: "100%", height: 88, background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 4 };
  if (!data || data.length < 2) {
    return <div style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#2a4a3a" }}>{data ? "no chart data" : "loading chart…"}</div>;
  }
  const W = 320, H = 88, P = 4;
  const min = Math.min(...data.map((d) => d.l)), max = Math.max(...data.map((d) => d.h)), range = max - min || 1;
  const n = data.length;
  const slot = (W - 2 * P) / n;
  const x = (i: number) => P + i * slot + slot / 2;
  const y = (v: number) => P + (1 - (v - min) / range) * (H - 2 * P);
  const bodyW = Math.max(1, slot * 0.62);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={box}>
      {data.map((d, i) => {
        const up = d.c >= d.o;
        const col = up ? "#00ff88" : "#ff4444";
        const cx = x(i);
        const yTop = Math.min(y(d.o), y(d.c));
        const bh = Math.max(0.8, Math.abs(y(d.c) - y(d.o)));
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={y(d.h)} y2={y(d.l)} stroke={col} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
            <rect x={cx - bodyW / 2} y={yTop} width={bodyW} height={bh} fill={col} />
          </g>
        );
      })}
    </svg>
  );
}
const toMsgHex = (s: string) => ("0x" + Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;

// Orderly AddOrderlyKey registration constants (mirror lab-api).
const BROKER = "nexus_trading";
const CHAIN = 42161; // Arbitrum One
// Orderly's OFF-CHAIN EIP-712 domain verifyingContract (the canonical all-C sentinel).
// Orderly reconstructs the registration/AddOrderlyKey hash with THIS address and ecrecovers
// the signer; signing with any other value → recovered addr ≠ userAddress → Orderly's
// "address and signature do not match". Must match the web ENABLE flow + Orderly docs.
const VC = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";

export default function MiniApp() {
  const [booted, setBooted] = useState(false);
  const [inFrame, setInFrame] = useState<boolean | null>(null);
  const [user, setUser] = useState<FUser | null>(null);
  const [feed, setFeed] = useState<Thesis[] | null>(null);
  const [buying, setBuying] = useState(false);
  const [added, setAdded] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);

  // Trade sheet
  const [tradeOpen, setTradeOpen] = useState(false);
  const [sym, setSym] = useState("BTC");
  const [notional, setNotional] = useState(25);
  const [lev, setLev] = useState(5);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [confirmSide, setConfirmSide] = useState<null | "LONG" | "SHORT">(null);
  const [tradeMsg, setTradeMsg] = useState<TradeMsg>(null);
  const [enabling, setEnabling] = useState(false);
  const [depositAmt, setDepositAmt] = useState(20);
  const [depositing, setDepositing] = useState(false);
  const [depositMsg, setDepositMsg] = useState<TradeMsg>(null);
  const [connectedAddr, setConnectedAddr] = useState<string | null>(null);
  // Session sig (deterministic personal_sign of the key message) cached so reads
  // don't re-prompt; reused for /positions + /close-position.
  const [sessionSig, setSessionSig] = useState<{ addr: string; sig: string } | null>(null);
  const [acct, setAcct] = useState<Acct | null>(null);
  const [positions, setPositions] = useState<PosRow[] | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [closingSym, setClosingSym] = useState<string | null>(null);
  const [minNotional, setMinNotional] = useState<number | null>(null);
  // Opt-in: broadcast my open positions to the public LIVE NOW feed (ephemeral,
  // server keeps a ~6-min snapshot only). Identity = my Farcaster name/pfp.
  const [broadcast, setBroadcast] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("nexus_broadcast") === "1");
  const [withdrawAmt, setWithdrawAmt] = useState(20);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawMsg, setWithdrawMsg] = useState<TradeMsg>(null);
  const [mkt, setMkt] = useState<Mkt | null>(null);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [fundsOpen, setFundsOpen] = useState(false);
  const [prefillSide, setPrefillSide] = useState<"LONG" | "SHORT" | null>(null);
  const [markets, setMarkets] = useState<string[] | null>(null);
  const [mktSearch, setMktSearch] = useState("");
  const [maxLev, setMaxLev] = useState(50);
  const [mmr, setMmr] = useState(0);
  // Slim agent surface: view status + one-tap deploy the Proven Edge preset in PAPER
  // (no funds, no key — reuses the same bankr/activate route the skill uses).
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMsg, setAgentMsg] = useState<TradeMsg>(null);

  // A smart-contract wallet (code at the address) can't be registered with Orderly
  // via ECDSA ecrecover → "address and signature do not match". Detect on Base+Arbitrum.
  async function isSmartWallet(addr: string): Promise<boolean> {
    const rpcs = ["https://mainnet.base.org", "https://arb1.arbitrum.io/rpc"];
    for (const rpc of rpcs) {
      try {
        const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [addr, "latest"] }) }).then((x) => x.json());
        if (r?.result && r.result !== "0x" && r.result.length > 2) return true;
      } catch { /* try next */ }
    }
    return false;
  }

  async function connectWallet() {
    try {
      const provider = await sdk.wallet.getEthereumProvider();
      const accts = (await provider?.request({ method: "eth_requestAccounts" })) as string[];
      setConnectedAddr(accts?.[0] ?? null);
    } catch { /* ignore */ }
  }

  // Pull the agent's status whenever a wallet address is known (public read, no sig).
  useEffect(() => { if (connectedAddr) loadAgent(connectedAddr); }, [connectedAddr]);

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

  // Per-market minimum order size (notional) — so we can warn BEFORE a signature
  // instead of after the exchange rejects. Lives on Orderly's public /info.
  useEffect(() => {
    let cancelled = false;
    setMinNotional(null);
    fetch(`https://api-evm.orderly.org/v1/public/info/PERP_${sym}_USDC`).then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const info = d?.data ?? {};
        setMinNotional(Number(info.min_notional) || null);
        const ml = info.base_imr ? Math.max(1, Math.round(1 / Number(info.base_imr))) : 50; // max leverage = 1/IMR
        setMaxLev(ml);
        setMmr(Number(info.base_mmr) || 0);
        setLev((l) => Math.min(l, ml)); // clamp to this market's real max
      })
      .catch(() => { /* leave — backend still guards */ });
    return () => { cancelled = true; };
  }, [sym]);

  // Full tradable market list (all 100+ Orderly perps) for the search picker. Once on mount.
  useEffect(() => {
    fetch("https://api-evm.orderly.org/v1/public/info").then((r) => r.json())
      .then((d) => {
        const rows = (d?.data?.rows ?? []).filter((m: { status?: string }) => m.status === "ACTIVE");
        const list = rows.map((m: { display_symbol_name?: string; symbol: string }) => m.display_symbol_name || tk(m.symbol))
          .sort((a: string, b: string) => a.localeCompare(b));
        setMarkets(list);
      })
      .catch(() => setMarkets([]));
  }, []);

  // Live price + 24h change + funding (polled) and 72×1h closes for the chart.
  // Public Orderly endpoints, fetched client-side (CORS-OK), fail-soft.
  useEffect(() => {
    let cancelled = false;
    const full = `PERP_${sym}_USDC`;
    setMkt(null); setCandles(null);
    (async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const d = await fetch(`https://api-evm.orderly.org/tv/history?symbol=${full}&resolution=60&from=${now - 72 * 3600}&to=${now}`).then((r) => r.json());
        if (!cancelled && d?.s === "ok" && Array.isArray(d.c)) {
          setCandles(d.c.map((c: number, i: number) => ({ o: Number(d.o[i]), h: Number(d.h[i]), l: Number(d.l[i]), c: Number(c) })));
        } else if (!cancelled) setCandles([]);
      } catch { if (!cancelled) setCandles([]); }
    })();
    const loadStats = async () => {
      try {
        const d = await fetch(`https://api-evm.orderly.org/v1/public/futures/${full}`).then((r) => r.json());
        const f = d?.data ?? {};
        const price = Number(f.mark_price ?? f.index_price ?? 0);
        const open = Number(f["24h_open"] ?? 0);
        if (!cancelled) setMkt({
          price,
          change: open ? ((price - open) / open) * 100 : 0,
          funding: Number(f.last_funding_rate ?? 0),
          high: Number(f["24h_high"] ?? 0),
          low: Number(f["24h_low"] ?? 0),
          vol: Number(f["24h_amount"] ?? 0),                       // 24h volume in USD
          oi: Number(f.open_interest ?? 0) * price,                // open interest in USD
          nextFunding: Number(f.next_funding_time ?? 0),
        });
      } catch { /* leave prior */ }
    };
    loadStats();
    const iv = setInterval(loadStats, 25000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [sym]);

  // Copy-trade loop: tap a feed call → open the trade panel pre-set to that asset +
  // direction. The matching LONG/SHORT button is highlighted; user sets size & confirms.
  function tradeThis(t: Thesis) {
    setSym(tk(t.symbol));
    setTradeOpen(true);
    setPrefillSide(t.direction);
    setTradeMsg({ ok: true, text: `${tk(t.symbol)} ${t.direction} staged — set size, then tap ${t.direction}.` });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => setPrefillSide((s) => (s === t.direction ? null : s)), 6000);
  }

  async function buyNexus() {
    if (buying) return;
    setBuying(true);
    try { await sdk.actions.viewToken({ token: NEXUS_CAIP19 }); }
    catch { try { await sdk.actions.swapToken({ buyToken: NEXUS_CAIP19 }); } catch { /* ignore */ } }
    finally { setBuying(false); }
  }
  async function saveApp() {
    setAddErr(null);
    try { await sdk.actions.addMiniApp(); setAdded(true); }
    catch (e) {
      const msg = (e as { message?: string; name?: string })?.message || (e as { name?: string })?.name || String(e);
      setAddErr(msg); // surface the real reason so we can diagnose (e.g. manifest not indexed)
    }
  }
  async function shareApp() {
    try { await sdk.actions.composeCast({ text: "trading on Nexus 🟢 verifiable track records, autonomous agents & one-tap perps — the terminal that makes you better.", embeds: [`${APP}/mini`] }); } catch { /* ignore */ }
  }
  // Share the autonomous agent — honestly labeled PAPER (forward-test), on-brand.
  async function shareAgent() {
    const paper = agentStatus?.state?.paper_trades ?? [];
    const net = paper.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const strat = agentStatus?.config?.signalMode ?? "funding-fade";
    const text = paper.length > 0
      ? `My Nexus agent is forward-testing a ${strat} strategy — ${net >= 0 ? "+" : ""}$${net.toFixed(2)} over ${paper.length} PAPER trade${paper.length === 1 ? "" : "s"} 🧪. Verifiable track record before a cent of real capital. verify, don't trust 🟢`
      : `Deployed an autonomous ${strat} agent on Nexus — forward-testing in PAPER before real capital 🧪. Verifiable track records, not vibes 🟢`;
    try { await sdk.actions.composeCast({ text, embeds: [`${APP}/mini`] }); } catch { /* ignore */ }
  }
  async function shareThesis(t: Thesis) {
    try { await sdk.actions.composeCast({ text: `${tk(t.symbol)} ${t.direction} — ${t.displayName || shortAddr(t.wallet)}'s call on Nexus. graded on-chain, not vibes 🟢`, embeds: [`${APP}/feed/thesis/${t.wallet}/${t.id}`] }); } catch { /* ignore */ }
  }
  // Share an open position to a cast — the PnL flex viral loop. Each cast embeds /mini
  // so readers can one-tap into the same trade panel.
  async function sharePosition(p: PosRow) {
    const qty = Number(p.position_qty);
    const entry = Number(p.average_open_price);
    const mark = Number(p.mark_price);
    const long = qty > 0;
    const pnl = mark && entry ? (mark - entry) * qty : Number(p.unrealized_pnl);
    const pct = entry > 0 && mark ? ((mark - entry) / entry) * 100 * (long ? 1 : -1) : 0;
    const win = Number.isFinite(pnl) && pnl >= 0;
    const move = `entry $${fmtPrice(entry)} → $${fmtPrice(mark)}`;
    const pnlTxt = Number.isFinite(pnl) ? `${win ? "+" : ""}$${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)` : "";
    const text = `${win ? "🟢" : "🔴"} ${tk(p.symbol)} ${long ? "LONG" : "SHORT"} ${pnlTxt} on Nexus\n\n${move}\n\nperps in-frame — verify, don't trust 👇`;
    try { await sdk.actions.composeCast({ text, embeds: [`${APP}/mini`] }); } catch { /* ignore */ }
  }

  // Deterministic EIP-191 sig → server derives the Orderly key. Cached per session
  // so balance/position reads + closes don't re-prompt a signature each time.
  async function ensureSig(): Promise<{ addr: string; sig: string }> {
    if (sessionSig) return sessionSig;
    const provider = await sdk.wallet.getEthereumProvider();
    if (!provider) throw new Error("no wallet");
    const accts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const addr = accts?.[0];
    if (!addr) throw new Error("connect a wallet");
    const sig = (await provider.request({ method: "personal_sign", params: [toMsgHex("nexus-trading-key-v1"), addr as `0x${string}`] })) as string;
    const s = { addr, sig };
    setSessionSig(s); setConnectedAddr(addr);
    return s;
  }

  // ── Read account state: free collateral + open positions (one /positions call). ──
  async function refreshStatus(over?: { addr: string; sig: string }) {
    if (statusBusy) return;
    setStatusBusy(true);
    try {
      const s = over || await ensureSig();
      const r = await fetch(`${API}/positions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: s.addr, walletSig: s.sig }),
      });
      const d = await r.json();
      if (d?.error === "wallet_not_registered") { setTradeMsg({ ok: false, text: "This wallet isn't enabled for trading yet.", cta: true }); return; }
      const data = d?.data ?? {};
      setAcct({ free: Number(data.free_collateral ?? 0), total: Number(data.total_collateral_value ?? 0) });
      const rows = (Array.isArray(data.rows) ? data.rows : []).filter((p: PosRow) => Math.abs(Number(p.position_qty)) > 0);
      setPositions(rows);
      if (broadcast) publishLive(rows, s); // keep the LIVE NOW snapshot fresh
    } catch (e) {
      setTradeMsg({ ok: false, text: (e as Error)?.message || "couldn't load account" });
    } finally {
      setStatusBusy(false);
    }
  }

  // ── Agent: read status (public GET) + one-tap deploy Proven Edge in PAPER ──
  async function loadAgent(addr: string) {
    try {
      const r = await fetch(`${API}/agent/${addr.toLowerCase()}`);
      const d = await r.json();
      setAgentStatus(d && (d.config || d.state) ? d : null);
    } catch { /* fail-soft — card just shows the deploy CTA */ }
  }

  // Deploy the flagship preset risk-free (PAPER = simulated, no funds/key move).
  // Reuses the exact route the Bankr skill uses; walletSig proves ownership.
  async function deployPaperAgent() {
    if (agentBusy) return;
    setAgentBusy(true); setAgentMsg(null);
    try {
      const s = await ensureSig();
      const r = await fetch(`${API}/agent/${s.addr.toLowerCase()}/bankr/activate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "PAPER", config: PROVEN_EDGE, walletSig: s.sig }),
      });
      const d = await r.json();
      if (r.ok && d.ok) {
        setAgentMsg({ ok: true, text: "✓ Deployed in PAPER — it now trades a simulated BTC funding-fade. Track it in the full terminal." });
        await loadAgent(s.addr);
      } else {
        setAgentMsg({ ok: false, text: d.hint || d.error || "deploy failed" });
      }
    } catch (e) {
      setAgentMsg({ ok: false, text: (e as Error)?.message || "deploy failed" });
    } finally {
      setAgentBusy(false);
    }
  }

  // Publish (or clear) my open positions to the public LIVE NOW feed. Fail-soft.
  async function publishLive(rows: PosRow[], s: { addr: string; sig: string }) {
    try {
      await fetch(`${API}/live/publish`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: s.addr, walletSig: s.sig,
          positions: rows.map((p) => ({ symbol: p.symbol, direction: Number(p.position_qty) > 0 ? "LONG" : "SHORT", entry_price: p.average_open_price, qty: Math.abs(Number(p.position_qty)) })),
          displayName: user?.displayName || user?.username || null,
          pfpUrl: user?.pfpUrl || null,
        }),
      });
    } catch { /* fail-soft */ }
  }

  async function toggleBroadcast() {
    const next = !broadcast;
    setBroadcast(next);
    try { window.localStorage.setItem("nexus_broadcast", next ? "1" : "0"); } catch { /* ignore */ }
    const s = sessionSig || await ensureSig().catch(() => null);
    if (!s) return;
    if (next) publishLive(positions ?? [], s);                  // start broadcasting
    else await publishLive([], s);                              // opt-out → clears the snapshot
  }

  async function closePosition(symbol: string) {
    if (closingSym) return;
    setClosingSym(symbol); setTradeMsg(null);
    try {
      const s = await ensureSig();
      const r = await fetch(`${API}/close-position`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, walletSig: s.sig, walletAddress: s.addr }),
      });
      const d = await r.json();
      if (r.ok && !d.error) { setTradeMsg({ ok: true, text: `✓ closed ${tk(symbol)}` }); await refreshStatus(s); }
      else setTradeMsg({ ok: false, text: d.message || d.error || "close failed" });
    } catch (e) {
      setTradeMsg({ ok: false, text: (e as Error)?.message || "error" });
    } finally {
      setClosingSym(null);
    }
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
      const s = await ensureSig();
      const r = await fetch(`${API}/trade`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym, side: side === "LONG" ? "BUY" : "SELL", notional, leverage: lev, walletSig: s.sig, walletAddress: s.addr }),
      });
      const d = await r.json();
      if (r.ok && !d.error) { setTradeMsg({ ok: true, text: `✓ ${side} ${sym} placed — $${notional} @ ${lev}x` }); await refreshStatus(s); }
      else if (d.error === "wallet_not_registered") setTradeMsg({ ok: false, text: "This wallet isn't enabled for trading yet.", cta: true });
      else setTradeMsg({ ok: false, text: d.message || d.error || "trade failed" });
    } catch (e) {
      setTradeMsg({ ok: false, text: (e as Error)?.message || "error" });
    } finally {
      setTradeBusy(false);
    }
  }

  // ── Enable trading: register an Orderly order-key for this wallet (NO funds move).
  // sign → /derive-key → EIP-712 AddOrderlyKey → /proxy/register-key (writes user:{addr}).
  async function enableTrading() {
    if (enabling) return;
    setEnabling(true); setTradeMsg({ ok: true, text: "enabling — approve the signature prompts…" });
    try {
      const provider = await sdk.wallet.getEthereumProvider();
      if (!provider) throw new Error("no wallet");
      const accts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const addr = accts?.[0];
      if (!addr) throw new Error("connect a wallet");
      setConnectedAddr(addr);
      if (await isSmartWallet(addr)) {
        setTradeMsg({ ok: false, text: "This is a smart-contract wallet, which Orderly can't register yet. Connect an external EOA wallet (Warpcast → wallet settings → connect) and retry." });
        return;
      }
      const walletSig = (await provider.request({ method: "personal_sign", params: [toMsgHex("nexus-trading-key-v1"), addr as `0x${string}`] })) as string;
      setSessionSig({ addr, sig: walletSig }); // cache for balance/position reads

      // 0) Ensure the wallet has an Orderly account (else key registration → "Account not found").
      let accountId: string | undefined;
      try {
        const acct = await fetch(`https://api-evm.orderly.org/v1/get_account?address=${addr.toLowerCase()}&broker_id=${BROKER}`).then((r) => r.json());
        accountId = acct?.data?.account_id;
      } catch { /* fall through to register */ }
      if (!accountId) {
        const nonceData = await fetch(`${API}/proxy/registration-nonce`).then((r) => r.json());
        const registrationNonce = nonceData?.data?.registration_nonce;
        if (!registrationNonce) throw new Error("couldn't get registration nonce");
        const regMsg = { brokerId: BROKER, chainId: CHAIN, timestamp: Date.now(), registrationNonce: String(registrationNonce) };
        const regTyped = {
          domain: { name: "Orderly", version: "1", chainId: CHAIN, verifyingContract: VC },
          types: {
            EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
            Registration: [{ name: "brokerId", type: "string" }, { name: "chainId", type: "uint256" }, { name: "timestamp", type: "uint64" }, { name: "registrationNonce", type: "uint256" }],
          },
          primaryType: "Registration",
          message: regMsg,
        };
        const regSig = (await provider.request({ method: "eth_signTypedData_v4", params: [addr as `0x${string}`, JSON.stringify(regTyped)] })) as string;
        const acctRes = await fetch(`${API}/proxy/register-account`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: regMsg, signature: regSig, userAddress: addr.toLowerCase() }) }).then((r) => r.json());
        accountId = acctRes?.data?.account_id;
        if (!accountId) throw new Error(acctRes?.message || acctRes?.error || "account registration failed");
      }

      const dk = await fetch(`${API}/derive-key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletSig }) }).then((r) => r.json());
      if (!dk.orderlyKey) throw new Error(dk.error || "derive failed");
      const ts = Date.now(), exp = ts + 365 * 24 * 3600 * 1000;
      const message = { brokerId: BROKER, chainId: CHAIN, orderlyKey: dk.orderlyKey, scope: "read,trading", timestamp: ts, expiration: exp };
      const typedData = {
        domain: { name: "Orderly", version: "1", chainId: CHAIN, verifyingContract: VC },
        types: {
          EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
          AddOrderlyKey: [{ name: "brokerId", type: "string" }, { name: "chainId", type: "uint256" }, { name: "orderlyKey", type: "string" }, { name: "scope", type: "string" }, { name: "timestamp", type: "uint64" }, { name: "expiration", type: "uint64" }],
        },
        primaryType: "AddOrderlyKey",
        message,
      };
      const signature = (await provider.request({ method: "eth_signTypedData_v4", params: [addr as `0x${string}`, JSON.stringify(typedData)] })) as string;
      const reg = await fetch(`${API}/proxy/register-key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, signature, userAddress: addr.toLowerCase(), orderlyKey: dk.orderlyKey }) }).then((r) => r.json());
      if (reg.success || reg.data || reg.accountId) { setTradeMsg({ ok: true, text: "✓ Trading enabled — place your trade now." }); refreshStatus({ addr, sig: walletSig }); }
      else setTradeMsg({ ok: false, text: reg.message || reg.error || "couldn't enable — this wallet may need an Orderly account + USDC deposit first" });
    } catch (e) {
      setTradeMsg({ ok: false, text: (e as Error)?.message || "enable error" });
    } finally {
      setEnabling(false);
    }
  }

  // ── Fund: deposit USDC into the Orderly account (real on-chain txs on Arbitrum).
  // /deposit/prepare → switch to Arbitrum → approve USDC → (wait) → deposit.
  // Requires the wallet to be enabled (account exists) + hold USDC + a little ETH (gas) on Arbitrum.
  async function deposit() {
    if (depositing || depositAmt <= 0) return;
    setDepositing(true); setDepositMsg({ ok: true, text: "preparing deposit…" });
    try {
      const provider = await sdk.wallet.getEthereumProvider();
      if (!provider) throw new Error("no wallet");
      const accts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const addr = accts?.[0];
      if (!addr) throw new Error("connect a wallet");
      try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa4b1" }] }); } catch { /* may already be on Arbitrum */ }

      const prep = await fetch(`${API}/deposit/prepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: addr, amount: depositAmt }) }).then((r) => r.json());
      if (prep.error === "no_orderly_account") { setDepositMsg({ ok: false, text: "enable trading first (creates your account)." }); return; }
      if (!prep.steps?.length) throw new Error(prep.hint || prep.error || "couldn't prepare deposit");

      setDepositMsg({ ok: true, text: "approve USDC in your wallet…" });
      const tx = (s: { to: string; data: string; value: string }) => ({ from: addr as `0x${string}`, to: s.to as `0x${string}`, data: s.data as `0x${string}`, value: s.value as `0x${string}` });
      const approveHash = (await provider.request({ method: "eth_sendTransaction", params: [tx(prep.steps[0])] })) as string;
      await waitForReceipt(provider, approveHash);

      setDepositMsg({ ok: true, text: "confirm the deposit…" });
      await provider.request({ method: "eth_sendTransaction", params: [tx(prep.steps[1])] });
      setDepositMsg({ ok: true, text: `✓ Depositing $${depositAmt} — lands in ~30s, then you can trade.` });
    } catch (e) {
      const m = (e as Error)?.message || "deposit error";
      setDepositMsg({ ok: false, text: /insufficient|exceeds balance/i.test(m) ? "Not enough USDC (+ a little ETH for gas) on Arbitrum in this wallet — fund it first." : m });
    } finally {
      setDepositing(false);
    }
  }

  // ── Withdraw: pull USDC collateral back to the frame wallet (Arbitrum). ──
  // prepare (server builds the Withdraw EIP-712) → frame signs it → submit (server relays
  // to Orderly with our derived key). On code 78 (unsettled PnL), retry once with settle:true.
  async function withdraw() {
    if (withdrawing || withdrawAmt <= 0) return;
    setWithdrawing(true); setWithdrawMsg({ ok: true, text: "preparing withdrawal…" });
    try {
      const provider = await sdk.wallet.getEthereumProvider();
      if (!provider) throw new Error("no wallet");
      const s = await ensureSig();

      const submitOnce = async (settle: boolean) => {
        const prep = await fetch(`${API}/withdraw/prepare`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletSig: s.sig, walletAddress: s.addr, amount: withdrawAmt, settle }),
        }).then((r) => r.json());
        if (prep.error === "wallet_not_registered") { setWithdrawMsg({ ok: false, text: "Enable trading first." }); return null; }
        if (prep.error === "insufficient_free_collateral") { setWithdrawMsg({ ok: false, text: `Free collateral too low ($${Number(prep.freeCollateral ?? 0).toFixed(2)}) — close positions first.` }); return null; }
        if (!prep.typedData) throw new Error(prep.hint || prep.error || "couldn't prepare withdrawal");
        setWithdrawMsg({ ok: true, text: "approve the withdrawal in your wallet…" });
        const signature = (await provider.request({ method: "eth_signTypedData_v4", params: [s.addr as `0x${string}`, JSON.stringify(prep.typedData)] })) as string;
        const res = await fetch(`${API}/withdraw/submit`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletSig: s.sig, walletAddress: s.addr, message: prep.message, signature }),
        }).then((r) => r.json());
        return { res, sentAmount: prep.amount as number };
      };

      let out = await submitOnce(false);
      if (out && out.res?.needsSettle) { setWithdrawMsg({ ok: true, text: "settling PnL — re-sign when prompted…" }); out = await submitOnce(true); }
      if (!out) return;
      if (out.res?.ok) {
        setWithdrawMsg({ ok: true, text: `✓ Withdrawing $${out.sentAmount.toFixed(2)} USDC to your wallet — lands in ~1–3 min.` });
        await refreshStatus(s);
      } else {
        setWithdrawMsg({ ok: false, text: out.res?.raw?.message || out.res?.hint || out.res?.error || "withdrawal failed" });
      }
    } catch (e) {
      setWithdrawMsg({ ok: false, text: (e as Error)?.message || "withdraw error" });
    } finally {
      setWithdrawing(false);
    }
  }

  async function waitForReceipt(provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }, hash: string) {
    for (let i = 0; i < 40; i++) {
      try {
        const rcpt = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
        if (rcpt) return;
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const shell: React.CSSProperties = { background: bg, color: "#e8f0ea", minHeight: "100svh", fontFamily: mono, padding: 14, display: "flex", flexDirection: "column", gap: 11 };
  const card: React.CSSProperties = { background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 6, padding: 12 };
  const mktChip = (active: boolean): React.CSSProperties => ({ background: active ? "#00ff8815" : "#0a0e0a", border: `1px solid ${active ? "#00ff8860" : "#1e2d1e"}`, borderRadius: 3, padding: "4px 11px", cursor: "pointer", color: active ? green : "#4a7a5a", fontFamily: mono, fontSize: 12 });
  const levPresets = [2, 5, 10, 25, 50, 100].filter((p) => p < maxLev).concat(maxLev); // per-market, incl. real MAX
  const liveCount = feed?.filter((t) => t.status === "ACTIVE").length ?? 0;
  const margin = notional / (lev || 1);
  const belowMin = minNotional != null && notional < minNotional;

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
        {addErr && <div style={{ fontSize: 9, color: "#fbbf24", marginTop: 6, lineHeight: 1.5, wordBreak: "break-word" }}>add failed: {addErr}</div>}
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
        ⚡ {tradeOpen ? "✕ HIDE PANEL" : "TRADE PERPS"}
      </button>

      {tradeOpen && (
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Step 1+2 — connect → enable (one-time) */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {connectedAddr
              ? <span style={{ fontSize: 10, color: green }}>● {shortAddr(connectedAddr)}</span>
              : <button onClick={connectWallet} style={{ background: "#0a1a0a", color: green, border: `1px solid ${green}`, borderRadius: 4, padding: "7px 14px", fontFamily: mono, fontSize: 11, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.05em" }}>CONNECT WALLET</button>}
            <button onClick={enableTrading} disabled={enabling} style={{ marginLeft: "auto", background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 4, padding: "7px 12px", fontFamily: mono, fontSize: 11, fontWeight: "bold", cursor: enabling ? "wait" : "pointer", letterSpacing: "0.05em", opacity: enabling ? 0.6 : 1 }}>{enabling ? "ENABLING…" : "◆ ENABLE TRADING"}</button>
          </div>
          <div style={{ fontSize: 8, color: "#2a4a3a", marginTop: -4 }}>1. connect · 2. enable (one-time) · 3. fund · 4. trade</div>

          {/* Account status + open positions (read-back) */}
          <div style={{ borderTop: "1px solid #1a2e1a", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 8, color: "#3a6a4a", letterSpacing: "0.1em" }}>📊 ACCOUNT</span>
              {acct && <span style={{ fontSize: 10, color: "#5a8a6a" }}>free <b style={{ color: "#fff" }}>${acct.free.toFixed(2)}</b> · value <b style={{ color: "#fff" }}>${acct.total.toFixed(2)}</b></span>}
              <button onClick={() => refreshStatus()} disabled={statusBusy} style={{ marginLeft: "auto", background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 4, padding: "5px 11px", fontFamily: mono, fontSize: 10, fontWeight: "bold", cursor: statusBusy ? "wait" : "pointer", letterSpacing: "0.05em", opacity: statusBusy ? 0.6 : 1 }}>{statusBusy ? "…" : acct ? "↻ REFRESH" : "↻ LOAD"}</button>
            </div>
            <button onClick={toggleBroadcast} style={{ display: "flex", alignItems: "center", gap: 6, background: broadcast ? "#0a2a0a" : "#0a0e0a", border: `1px solid ${broadcast ? "#1a4a2a" : "#1e2d1e"}`, borderRadius: 4, padding: "6px 9px", fontFamily: mono, fontSize: 9, cursor: "pointer", color: broadcast ? green : "#5a8a6a", textAlign: "left" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: broadcast ? green : "#2a4a3a", boxShadow: broadcast ? `0 0 6px ${green}` : "none", flexShrink: 0 }} />
              📡 {broadcast ? "BROADCASTING to LIVE NOW — your open positions are public" : "Broadcast my positions to the public LIVE NOW feed"}
            </button>
            {positions && positions.length === 0 && <div style={{ fontSize: 10, color: "#3a6a4a" }}>no open positions.</div>}
            {positions && positions.map((p) => {
              const qty = Number(p.position_qty);
              const long = qty > 0;
              const entry = Number(p.average_open_price);
              const mark = Number(p.mark_price);
              // Orderly /v1/positions has no flat unrealized_pnl field — compute it
              // (signed qty handles long/short). NaN-safe so a missing mark shows "—".
              const pnl = mark && entry ? (mark - entry) * qty : Number(p.unrealized_pnl);
              const hasPnl = Number.isFinite(pnl);
              return (
                <div key={p.symbol} style={{ display: "flex", alignItems: "center", gap: 8, background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 4, padding: "7px 9px" }}>
                  <span style={{ fontSize: 12, fontWeight: "bold", color: "#fff", flexShrink: 0 }}>{tk(p.symbol)}</span>
                  <span style={{ fontSize: 9, color: long ? green : red, flexShrink: 0 }}>{long ? "↑ LONG" : "↓ SHORT"} {Math.abs(qty)}</span>
                  {mark > 0 && <span style={{ fontSize: 8, color: "#5a8a6a", flexShrink: 0 }}>@ {entry.toFixed(entry < 10 ? 4 : 2)}→{mark.toFixed(mark < 10 ? 4 : 2)}</span>}
                  <span style={{ fontSize: 9, color: !hasPnl ? "#5a8a6a" : pnl >= 0 ? green : red, marginLeft: "auto", flexShrink: 0 }}>{hasPnl ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "—"}</span>
                  <button onClick={() => sharePosition(p)} title="Share to cast" style={{ flexShrink: 0, background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 4, padding: "5px 9px", fontFamily: mono, fontSize: 10, fontWeight: "bold", cursor: "pointer" }}>↗</button>
                  <button onClick={() => closePosition(p.symbol)} disabled={closingSym === p.symbol} style={{ flexShrink: 0, background: "#1a0a0a", color: red, border: `1px solid ${red}55`, borderRadius: 4, padding: "5px 10px", fontFamily: mono, fontSize: 10, fontWeight: "bold", cursor: closingSym === p.symbol ? "wait" : "pointer", letterSpacing: "0.05em", opacity: closingSym === p.symbol ? 0.6 : 1 }}>{closingSym === p.symbol ? "…" : "CLOSE"}</button>
                </div>
              );
            })}
          </div>

          {/* Asset price + chart (glance value) */}
          <div style={{ borderTop: "1px solid #1a2e1a", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: "bold", color: "#fff" }}>{sym}</span>
              <span style={{ fontSize: 14, color: "#fff" }}>{mkt ? `$${fmtPrice(mkt.price)}` : "—"}</span>
              {mkt && <span style={{ fontSize: 11, color: mkt.change >= 0 ? green : red }}>{mkt.change >= 0 ? "▲" : "▼"} {Math.abs(mkt.change).toFixed(2)}%</span>}
              {mkt && <span style={{ marginLeft: "auto", fontSize: 9, color: "#5a8a6a" }}>funding <b style={{ color: mkt.funding >= 0 ? green : red }}>{(mkt.funding * 100).toFixed(4)}%</b></span>}
            </div>
            <AssetChart data={candles} />
            {mkt && (mkt.high > 0 || mkt.low > 0) && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: "#3a6a4a" }}>
                <span>24h L ${fmtPrice(mkt.low)}</span>
                <span>H ${fmtPrice(mkt.high)}</span>
              </div>
            )}
            {mkt && (mkt.vol > 0 || mkt.oi > 0) && (
              <div style={{ display: "flex", gap: 10, fontSize: 8, color: "#3a6a4a", flexWrap: "wrap" }}>
                <span>24h vol <b style={{ color: "#5a8a6a" }}>{fmtUsd(mkt.vol)}</b></span>
                <span>OI <b style={{ color: "#5a8a6a" }}>{fmtUsd(mkt.oi)}</b></span>
                {mkt.nextFunding > 0 && <span style={{ marginLeft: "auto" }}>next funding <b style={{ color: "#5a8a6a" }}>{fundingIn(mkt.nextFunding)}</b></span>}
              </div>
            )}
          </div>

          {/* Market — popular quick-chips + search across all markets */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {MARKETS.map((m) => (
                <button key={m} onClick={() => { setSym(m); setTradeMsg(null); }} style={mktChip(m === sym)}>{m}</button>
              ))}
              {!MARKETS.includes(sym) && <button style={mktChip(true)}>{sym}</button>}
            </div>
            <input value={mktSearch} onChange={(e) => setMktSearch(e.target.value.toUpperCase())} placeholder={markets ? `🔍 search ${markets.length} markets…` : "loading markets…"} style={{ width: "100%", boxSizing: "border-box", background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 4, color: "#e8f0ea", fontFamily: mono, fontSize: 11, padding: "6px 9px" }} />
            {mktSearch && markets && (() => {
              const hits = markets.filter((m) => m.includes(mktSearch));
              return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, maxHeight: 116, overflowY: "auto" }}>
                  {hits.slice(0, 36).map((m) => (
                    <button key={m} onClick={() => { setSym(m); setMktSearch(""); setTradeMsg(null); }} style={mktChip(m === sym)}>{m}</button>
                  ))}
                  {hits.length === 0 && <span style={{ fontSize: 9, color: "#3a6a4a" }}>no market matches “{mktSearch}”</span>}
                </div>
              );
            })()}
          </div>
          {/* Size + leverage */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontSize: 8, color: "#3a6a4a", letterSpacing: "0.1em" }}>SIZE (USDC)</div>
              <input type="number" inputMode="decimal" min={1} value={notional} onChange={(e) => setNotional(Math.max(0, parseFloat(e.target.value) || 0))} style={{ width: "100%", boxSizing: "border-box", marginTop: 4, background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 4, color: "#e8f0ea", fontFamily: mono, fontSize: 13, padding: "7px 9px" }} />
            </div>
            <div>
              <div style={{ fontSize: 8, color: "#3a6a4a", letterSpacing: "0.1em" }}>LEVERAGE — {lev}x <span style={{ color: "#2a4a3a" }}>· max {maxLev}x</span></div>
              <input type="range" min={1} max={maxLev} step={1} value={lev} onChange={(e) => setLev(parseInt(e.target.value, 10))} style={{ width: "100%", marginTop: 12 }} />
              <div style={{ display: "flex", gap: 5, marginTop: 6 }}>
                {levPresets.map((p, i) => (
                  <button key={p} onClick={() => setLev(p)} style={{ flex: 1, background: lev === p ? "#00ff8815" : "#0a0e0a", border: `1px solid ${lev === p ? "#00ff8860" : "#1e2d1e"}`, borderRadius: 3, padding: "4px 0", cursor: "pointer", color: lev === p ? green : "#4a7a5a", fontFamily: mono, fontSize: 10, fontWeight: "bold" }}>{i === levPresets.length - 1 ? "MAX" : `${p}x`}</button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 9, color: "#5a8a6a" }}>notional <b style={{ color: "#fff" }}>${notional.toFixed(0)}</b> · margin <b style={{ color: "#fff" }}>${margin.toFixed(2)}</b>{minNotional ? <> · min <b style={{ color: "#fff" }}>${minNotional}</b></> : null}</div>
          {mkt && mkt.price > 0 && notional > 0 && (
            <div style={{ fontSize: 9, color: "#5a8a6a" }}>
              ≈ <b style={{ color: "#fff" }}>{(notional / mkt.price).toLocaleString("en-US", { maximumFractionDigits: 4 })} {sym}</b>
              <span style={{ color: "#3a6a4a" }}> · est. liq </span>
              <span style={{ color: red }}>L ${fmtPrice(Math.max(0, mkt.price * (1 - 1 / lev + mmr)))}</span>
              <span style={{ color: "#3a6a4a" }}> / </span>
              <span style={{ color: red }}>S ${fmtPrice(mkt.price * (1 + 1 / lev - mmr))}</span>
            </div>
          )}
          {belowMin && <div style={{ fontSize: 9, color: "#fbbf24", lineHeight: 1.5 }}>↑ {sym} needs ≥ ${minNotional} notional. Raise SIZE to ${minNotional} (bump leverage if the margin doesn&apos;t fit your balance).</div>}
          {/* Long / Short */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={() => placeTrade("LONG")} disabled={tradeBusy || notional <= 0 || belowMin} style={{ background: green, color: "#04130c", border: `1px solid ${green}`, borderRadius: 4, padding: "12px 0", fontFamily: mono, fontSize: 13, fontWeight: "bold", cursor: belowMin ? "not-allowed" : "pointer", letterSpacing: "0.06em", opacity: belowMin ? 0.4 : tradeBusy && confirmSide !== "LONG" ? 0.4 : 1, boxShadow: prefillSide === "LONG" ? `0 0 0 2px ${green}` : "none" }}>{tradeBusy ? "…" : confirmSide === "LONG" ? "TAP TO CONFIRM ✓" : "↑ LONG"}</button>
            <button onClick={() => placeTrade("SHORT")} disabled={tradeBusy || notional <= 0 || belowMin} style={{ background: red, color: "#fff", border: `1px solid ${red}`, borderRadius: 4, padding: "12px 0", fontFamily: mono, fontSize: 13, fontWeight: "bold", cursor: belowMin ? "not-allowed" : "pointer", letterSpacing: "0.06em", opacity: belowMin ? 0.4 : tradeBusy && confirmSide !== "SHORT" ? 0.4 : 1, boxShadow: prefillSide === "SHORT" ? `0 0 0 2px ${red}` : "none" }}>{tradeBusy ? "…" : confirmSide === "SHORT" ? "TAP TO CONFIRM ✓" : "↓ SHORT"}</button>
          </div>
          {tradeMsg && (
            <div style={{ fontSize: 10, color: tradeMsg.ok ? green : "#fbbf24", lineHeight: 1.5 }}>
              {tradeMsg.text}{tradeMsg.cta ? " — use ◆ ENABLE TRADING above (1-time)." : ""}
            </div>
          )}

          {/* Manage funds (progressive disclosure — keeps the default view chart + trade) */}
          <button onClick={() => setFundsOpen((o) => !o)} style={{ borderTop: "1px solid #1a2e1a", paddingTop: 10, background: "none", border: "none", borderRadius: 0, color: "#5a8a6a", fontFamily: mono, fontSize: 9, fontWeight: "bold", letterSpacing: "0.1em", cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}>
            <span>⚙ MANAGE FUNDS</span>
            {acct && <span style={{ color: "#3a6a4a", fontWeight: "normal" }}>· free ${acct.free.toFixed(2)}</span>}
            <span style={{ marginLeft: "auto", color: "#3a6a4a" }}>{fundsOpen ? "▲" : "▼ deposit · withdraw"}</span>
          </button>

          {fundsOpen && (<>
          {/* Fund / deposit */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 8, color: "#3a6a4a", letterSpacing: "0.1em" }}>💰 FUND ACCOUNT (USDC · Arbitrum)</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="number" inputMode="decimal" min={1} value={depositAmt} onChange={(e) => setDepositAmt(Math.max(0, parseFloat(e.target.value) || 0))} style={{ flex: 1, minWidth: 0, background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 4, color: "#e8f0ea", fontFamily: mono, fontSize: 13, padding: "8px 9px" }} />
              <button onClick={deposit} disabled={depositing || depositAmt <= 0} style={{ flexShrink: 0, background: "#0a1a2a", color: "#4a9fff", border: "1px solid #1a3a5a", borderRadius: 4, padding: "8px 16px", fontFamily: mono, fontSize: 12, fontWeight: "bold", cursor: depositing ? "wait" : "pointer", letterSpacing: "0.05em", opacity: depositing ? 0.6 : 1 }}>{depositing ? "…" : "DEPOSIT"}</button>
            </div>
            {depositMsg && <div style={{ fontSize: 10, color: depositMsg.ok ? green : "#fbbf24", lineHeight: 1.5 }}>{depositMsg.text}</div>}
          </div>

          {/* Withdraw */}
          <div style={{ borderTop: "1px solid #1a2e1a", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 8, color: "#3a6a4a", letterSpacing: "0.1em" }}>🏧 WITHDRAW (USDC · to your wallet)</span>
              {acct && <button onClick={() => setWithdrawAmt(Math.max(0, Math.floor(acct.free * 100) / 100))} style={{ marginLeft: "auto", background: "none", border: "1px solid #1a2e1a", borderRadius: 3, color: "#5a8a6a", fontFamily: mono, fontSize: 9, padding: "2px 7px", cursor: "pointer" }}>MAX ${acct.free.toFixed(2)}</button>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="number" inputMode="decimal" min={1} value={withdrawAmt} onChange={(e) => setWithdrawAmt(Math.max(0, parseFloat(e.target.value) || 0))} style={{ flex: 1, minWidth: 0, background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 4, color: "#e8f0ea", fontFamily: mono, fontSize: 13, padding: "8px 9px" }} />
              <button onClick={withdraw} disabled={withdrawing || withdrawAmt <= 0} style={{ flexShrink: 0, background: "#1a140a", color: "#fbbf24", border: "1px solid #4a3a1a", borderRadius: 4, padding: "8px 16px", fontFamily: mono, fontSize: 12, fontWeight: "bold", cursor: withdrawing ? "wait" : "pointer", letterSpacing: "0.05em", opacity: withdrawing ? 0.6 : 1 }}>{withdrawing ? "…" : "WITHDRAW"}</button>
            </div>
            {withdrawMsg && <div style={{ fontSize: 10, color: withdrawMsg.ok ? green : "#fbbf24", lineHeight: 1.5 }}>{withdrawMsg.text}</div>}
          </div>
          </>)}

          <div style={{ fontSize: 8, color: "#2a4a3a" }}>real orders on Orderly · signs to authorize · non-custodial</div>
        </div>
      )}

      {/* Buy / Share */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button onClick={buyNexus} disabled={buying} style={{ background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 5, padding: "10px 0", fontFamily: mono, fontSize: 11, fontWeight: "bold", cursor: buying ? "wait" : "pointer", letterSpacing: "0.04em", opacity: buying ? 0.6 : 1 }}>{buying ? "OPENING…" : "🪙 BUY $NEXUS"}</button>
        <button onClick={shareApp} style={{ background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 5, padding: "10px 0", fontFamily: mono, fontSize: 11, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.04em" }}>↗ SHARE</button>
      </div>

      {/* Autonomous agent — view status + one-tap deploy Proven Edge in PAPER */}
      {connectedAddr && (() => {
        const active = !!agentStatus?.state?.active;
        const paper = agentStatus?.state?.paper_trades ?? [];
        const paperNet = paper.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
        const mode = agentStatus?.config?.mode ?? "PAPER";
        return (
          <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 9, color: "#3a6a4a", letterSpacing: "0.12em" }}>🤖 AUTONOMOUS AGENT</span>
              {active && <span style={{ flexShrink: 0, fontSize: 8, color: mode === "AUTONOMOUS" ? "#ff8800" : mode === "ASSISTED" ? green : "#4a9fff", border: "1px solid #1e2d1e", borderRadius: 3, padding: "1px 6px", marginLeft: "auto" }}>{mode}</span>}
            </div>
            {active ? (
              <>
                <div style={{ fontSize: 11, color: "#8aaa9a", lineHeight: 1.5 }}>
                  Running <span style={{ color: "#fff" }}>{agentStatus?.config?.signalMode ?? "FUNDING_ONLY"}</span> on {tk((agentStatus?.config?.symbols ?? ["PERP_BTC_USDC"])[0])}.
                  {paper.length > 0 && <> Paper: <span style={{ color: paperNet >= 0 ? green : red }}>{paperNet >= 0 ? "+" : ""}${paperNet.toFixed(2)}</span> over {paper.length} trade{paper.length === 1 ? "" : "s"}.</>}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <a href={`${APP}/lab?tab=agent`} style={{ fontSize: 10, color: green, textDecoration: "none", border: "1px solid #1a4a2a", borderRadius: 5, padding: "8px 0", textAlign: "center", fontFamily: mono, fontWeight: "bold", letterSpacing: "0.04em" }}>⚙ MANAGE ↗</a>
                  <button onClick={shareAgent} style={{ fontSize: 10, color: green, background: "#0a1a0a", border: "1px solid #1a4a2a", borderRadius: 5, padding: "8px 0", textAlign: "center", fontFamily: mono, fontWeight: "bold", letterSpacing: "0.04em", cursor: "pointer" }}>↗ SHARE AGENT</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 11, color: "#8aaa9a", lineHeight: 1.5 }}>
                  Try the <span style={{ color: "#fbbf24" }}>BTC Funding Fade</span> — a selective funding-fade with a breakeven risk-free stop. <span style={{ color: "#fff" }}>Experimental, PAPER only</span> (it doesn't yet pass our cross-market validation). No funds, no key.
                </div>
                <button onClick={deployPaperAgent} disabled={agentBusy} style={{ background: "#1a140a", color: "#fbbf24", border: "1px solid #4a3a1a", borderRadius: 5, padding: "10px 0", fontFamily: mono, fontSize: 11, fontWeight: "bold", cursor: agentBusy ? "wait" : "pointer", letterSpacing: "0.04em", opacity: agentBusy ? 0.6 : 1 }}>{agentBusy ? "DEPLOYING…" : "🧪 PAPER-TEST BTC FUNDING FADE"}</button>
              </>
            )}
            {agentMsg && <div style={{ fontSize: 10, color: agentMsg.ok ? green : "#fbbf24", lineHeight: 1.5 }}>{agentMsg.text}</div>}
          </div>
        );
      })()}

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
              <button onClick={() => tradeThis(t)} title="Trade this call" style={{ marginLeft: "auto", flexShrink: 0, background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 3, fontFamily: mono, fontSize: 9, fontWeight: "bold", padding: "3px 9px", cursor: "pointer", letterSpacing: "0.05em" }}>⚡ TRADE</button>
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
