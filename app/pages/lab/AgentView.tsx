// The Trading Agent tab: config / status / history / leaderboard, the agent
// track-record panels, and the Orderly delegated-key readers.
// Extracted from index.tsx (god-file split).
import { useState, useEffect } from "react";
import { signWithInjected } from "@/utils/injectedWallet";
import type { AgentConfig, AgentState, AgentTrade, AgentLeaderboardEntry, AgentPendingThesis } from "./types";
import { DEFAULT_CONFIG } from "./types";
import { agentCardStyle, agentLabelStyle, agentInputStyle, agentBtnStyle, btnPrimary, navBtnStyle } from "./styles";
import { useSubscription } from "@/hooks/useSubscription";
import { isProStrategy } from "@/config/subscription";
import { STRATEGY_PRESETS } from "@/config/strategyPresets";
import { STYLE_PRESETS, deriveStyle, type TradingStyle } from "@/config/agentStyles";
import { AGENT_PREFILL_KEY, type AgentPrefill } from "@/utils/agentPrefill";

const AGENT_API = "https://og.nexustradinglabs.com";

/**
 * Number input that holds its own text state so you can clear/edit freely
 * (empty, "0.", "1.2" mid-type) without the controlled value snapping back to 0
 * or fighting the cursor. Commits a valid number as you type; normalizes on blur.
 */
function NumberField({ value, onCommit, min, max, step }: {
  value: number; onCommit: (n: number) => void; min?: number; max?: number; step?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      value={text}
      min={min} max={max} step={step}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseFloat(e.target.value);
        if (!isNaN(n)) onCommit(n);
      }}
      onBlur={() => {
        const n = parseFloat(text);
        const final = isNaN(n) ? (min ?? 0) : n;
        onCommit(final);
        setText(String(final));
      }}
      style={{ ...agentInputStyle, width: "70%" }}
    />
  );
}

const AVAILABLE_SYMBOLS = [
  "PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_ARB_USDC",
  "PERP_HYPE_USDC", "PERP_ORDER_USDC", "PERP_AVAX_USDC", "PERP_XMR_USDC",
  "PERP_ZEC_USDC", "PERP_PUMP_USDC", "PERP_PENGU_USDC",
  "PERP_SPX500_USDC", "PERP_NAS100_USDC",
];

// ─── Agent Track Record (shared by live + paper) ─────────
function AgentTrackRecord({ title, accent, trades, paper, onReset }: {
  title: string;
  accent: string;
  trades: AgentTrade[];
  paper?: boolean;
  onReset?: () => void;
}) {
  const tr = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const wr = tr ? (wins / tr) * 100 : 0;
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const winsArr = trades.filter((t) => t.pnl > 0);
  const lossArr = trades.filter((t) => t.pnl <= 0);
  const avgWin = winsArr.length ? winsArr.reduce((s, t) => s + t.pnl, 0) / winsArr.length : 0;
  const avgLoss = lossArr.length ? lossArr.reduce((s, t) => s + Math.abs(t.pnl), 0) / lossArr.length : 0;
  const since = tr ? new Date(Math.min(...trades.map((t) => new Date(t.opened_at).getTime() || Date.now()))).toLocaleDateString() : null;

  return (
    <div style={{ ...agentCardStyle, borderColor: tr > 0 ? (net >= 0 ? "#1a4a2a" : "#4a1a1a") : "#1e2d1e" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ ...agentLabelStyle, color: accent }}>{title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {since && <span style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a" }}>since {since}</span>}
          {onReset && tr > 0 && (
            <button onClick={onReset} style={{ ...navBtnStyle, fontSize: 9, padding: "3px 10px", color: "#4a9fff", borderColor: "#1a3a5a" }}>RESET</button>
          )}
        </div>
      </div>
      {tr === 0 ? (
        <div style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
          {paper
            ? <>No paper trades yet — switch to 🧪 PAPER and activate to build a simulated track record against live prices. Risk-free.</>
            : <>No live track record yet — this agent hasn't traded for you. Stats build here transparently from its first trade. <strong style={{ color: "#8aaa9a" }}>Start small.</strong></>}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))", gap: 12, marginTop: 8 }}>
            {[
              { label: "NET P&L", value: `${net >= 0 ? "+" : ""}$${Math.abs(net).toFixed(2)}`, color: net >= 0 ? "#00ff88" : "#ff4444" },
              { label: "WIN RATE", value: `${wr.toFixed(1)}%`, color: wr >= 50 ? "#00ff88" : "#ff4444" },
              { label: "TRADES", value: String(tr), color: "#c0c0c0" },
              { label: "AVG WIN", value: `$${avgWin.toFixed(2)}`, color: "#00ff88" },
              { label: "AVG LOSS", value: `$${avgLoss.toFixed(2)}`, color: "#ff4444" },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                <div style={{ color, fontFamily: "monospace", fontSize: 16, fontWeight: 600 }}>{value}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, fontFamily: "monospace", fontSize: 9, color: "#3a5a4a", lineHeight: 1.5 }}>
            {paper
              ? "🧪 Simulated results — paper trades never touch the exchange. A great paper record is encouraging, not a guarantee."
              : "⚠ Past performance does not guarantee future results. Markets are risky — only deploy capital you can afford to lose, and start small."}
          </div>
        </>
      )}
    </div>
  );
}

// Orderly SDK (@orderly.network/core LocalStorageStore) stores the delegated
// trading key as JSON at `orderly_{networkId}_{address}`:
//   { orderlyKey: "<secret>", accountId: "<id>" }
// The address it keys on is whatever is stored at `orderly_{networkId}_address`.
function getOrderlyNetworkId(): string {
  return (localStorage.getItem("orderly_networkId") as string) || "mainnet";
}

function getOrderlyKeyStore(): { tradingKey: string; accountId: string } | null {
  const networkId = getOrderlyNetworkId();
  const address = localStorage.getItem(`orderly_${networkId}_address`);
  const tryParse = (raw: string | null) => {
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.orderlyKey === "string" && obj.orderlyKey.length > 20) {
        return { tradingKey: obj.orderlyKey as string, accountId: (obj.accountId as string) || "" };
      }
    } catch {
      // not the JSON blob we want
    }
    return null;
  };

  // Preferred: the exact per-address blob
  if (address) {
    const direct = tryParse(localStorage.getItem(`orderly_${networkId}_${address}`));
    if (direct) return direct;
  }

  // Fallback: scan for any orderly_{network}_0x... blob containing an orderlyKey
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !/^orderly_[a-z]+_0x[0-9a-fA-F]+$/.test(key)) continue;
    const parsed = tryParse(localStorage.getItem(key));
    if (parsed) return parsed;
  }
  return null;
}

function findOrderlyTradingKey(): string | null {
  return getOrderlyKeyStore()?.tradingKey ?? null;
}

function getWalletAddress(): string | null {
  const networkId = getOrderlyNetworkId();
  return localStorage.getItem(`orderly_${networkId}_address`);
}

// Ownership proof for agent control ops. Backend ecrecovers a personal_sign of
// "nexus-trading-key-v1" and requires the recovered address to equal the agent's
// wallet — so kill/deactivate/config can't be triggered by anyone but the owner.
// Deterministic message → cache the sig per session (same sig the Orderly key
// derives from). Signs via the injected wallet (same pattern as Holders Room).
async function getAgentSig(address: string): Promise<string> {
  const key = `nexus_agent_sig_${address.toLowerCase()}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) || "null");
    if (cached && typeof cached.sig === "string") return cached.sig;
  } catch { /* ignore */ }
  const sig = await signWithInjected(address, "nexus-trading-key-v1");
  try { sessionStorage.setItem(key, JSON.stringify({ sig })); } catch { /* ignore */ }
  return sig;
}

// This agent's own leaderboard standing (mirrors lab-api /agents/standing).
type AgentStandingCriterion = { key: string; label: string; met: boolean; value: number; target: number };
type AgentStanding = {
  eligible: boolean;
  metCount: number;
  total: number;
  criteria: AgentStandingCriterion[];
  stats: { trades: number; daysActive: number; winRate: number; netPnl: number; profitFactor: number; score: number } | null;
};

function formatAgentTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

export function AgentView() {
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_CONFIG);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [trades, setTrades] = useState<AgentTrade[]>([]);
  const [pending, setPending] = useState<AgentPendingThesis[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<"config" | "status" | "history" | "leaderboard">("config");
  const [leaderboard, setLeaderboard] = useState<AgentLeaderboardEntry[] | null>(null);
  const [lbLoading, setLbLoading] = useState(false);
  const [ledgerInfo, setLedgerInfo] = useState<{ hash: string; count: number; onChain?: { verified?: boolean; explorer?: string } | null } | null>(null);

  const walletAddress = getWalletAddress();
  const tradingKey = findOrderlyTradingKey();
  const { isPro } = useSubscription(walletAddress);
  const [proNote, setProNote] = useState(false);
  const [standing, setStanding] = useState<AgentStanding | null>(null);
  const [backtest, setBacktest] = useState<any | null>(null);
  const [backtesting, setBacktesting] = useState(false);
  const [sweep, setSweep] = useState<any | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [strategies, setStrategies] = useState<any[]>([]);
  const [stratName, setStratName] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookInfo, setWebhookInfo] = useState<{ url: string; passphrase: string } | null>(() => {
    try { return JSON.parse(sessionStorage.getItem(`nexus_webhook_${(walletAddress || "").toLowerCase()}`) || "null"); }
    catch { return null; }
  });

  useEffect(() => {
    if (!walletAddress) { setLoading(false); return; }
    fetchAgentData();
    const interval = setInterval(fetchAgentData, 10000);
    return () => clearInterval(interval);
  }, [walletAddress]);


  async function fetchAgentData() {
    if (!walletAddress) return;
    try {
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}`);
      if (res.ok) {
        const data = await res.json();
        if (data.config) setConfig(data.config);
        // Cross-tab bridge: a prefill handed over from a thesis / signal / call
        // (deployToAgent) wins over the loaded config. Applied ONCE (key removed),
        // AFTER the server config so it can never be clobbered by the 10s refresh.
        try {
          const raw = window.localStorage.getItem(AGENT_PREFILL_KEY);
          if (raw) {
            window.localStorage.removeItem(AGENT_PREFILL_KEY);
            const p: AgentPrefill = JSON.parse(raw);
            if (p?.config && typeof p.config === "object") {
              setConfig((prev) => ({ ...prev, ...p.config }));
              setTab("config");
              setSuccess(`Config prefilled${p.source ? ` from ${p.source}` : ""} — review, then Save or Backtest.`);
              setTimeout(() => setSuccess(null), 5000);
            }
          }
        } catch { /* ignore */ }
        if (data.state) setAgentState(data.state);
        if (data.trades) setTrades(data.trades);
        if (data.pending) setPending(data.pending);
        setWebhookEnabled(!!data.webhook?.enabled);
      }
    } catch (e) {
      console.error("[agent] fetch error:", e);
    } finally {
      setLoading(false);
    }
    // This agent's own leaderboard standing — fail-soft (a thin/new agent just
    // shows "not yet ranked"); separate try so it never blocks the core load.
    try {
      const sres = await fetch(`${AGENT_API}/agents/standing/${walletAddress}`);
      if (sres.ok) setStanding(await sres.json());
    } catch { /* fail-soft */ }
    // Saved strategy library (public read).
    try {
      const lres = await fetch(`${AGENT_API}/agent/${walletAddress}/strategies`);
      if (lres.ok) setStrategies((await lres.json()).strategies || []);
    } catch { /* fail-soft */ }
  }

  async function activateAgent() {
    if (!walletAddress) { setError("Connect wallet first"); return; }
    // PAPER mode never places real orders, so it doesn't need a trading key.
    if (config.mode !== "PAPER" && !tradingKey) { setError("No Orderly trading key found — place at least one trade first to generate it"); return; }
    setSaving(true);
    setError(null);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config,
          tradingKey,
          accountId: getOrderlyKeyStore()?.accountId || "",
          walletSig,
        }),
      });
      if (!res.ok) throw new Error("Failed to activate agent");
      setSuccess("Agent activated");
      setAgentState((prev) => prev ? { ...prev, active: true } : { active: true, daily_pnl: 0, trades_today: 0, current_position: null, last_signal: null });
      setTimeout(() => setSuccess(null), 3000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Backtest the CURRENT config over real Orderly history (PRO). Reuses the same
  // engine the agent runs on, so results reflect real behavior — a "test before you
  // risk it" moment right in the Config tab.
  async function runConfigBacktest() {
    if (!walletAddress) { setError("Connect wallet first"); return; }
    setBacktesting(true); setError(null); setBacktest(null);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/backtest`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config, walletSig, days: 60 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.hint || data.error || "Backtest failed");
      setBacktest(data);
    } catch (e: any) { setError(e.message); } finally { setBacktesting(false); }
  }

  // Sweep a grid of configs (mode × threshold × exit) and rank by net P&L — the
  // terminal sweep, in-app. Uses the base config's leverage/capital/symbols.
  async function runConfigSweep() {
    if (!walletAddress) { setError("Connect wallet first"); return; }
    setSweeping(true); setError(null); setSweep(null);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/backtest/sweep`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config, walletSig, days: 60 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.hint || data.error || "Sweep failed");
      setSweep(data);
    } catch (e: any) { setError(e.message); } finally { setSweeping(false); }
  }
  // Apply a swept winner's strategy params into the editor (keeps the user's
  // symbols/leverage/capital/mode; swaps mode/threshold/exits). The bridge that
  // turns "here's what worked" into "now it's my config."
  function applySweepConfig(cfg: any) {
    const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined));
    setConfig((prev) => ({ ...prev, ...clean }));
    setSuccess("Config applied to the editor — review, then Save or Backtest."); setTimeout(() => setSuccess(null), 4000);
  }

  // Strategy library — save the current composed config under a name, load one
  // back into the editor, or delete. The config IS the strategy object.
  async function saveStrategy() {
    if (!walletAddress) { setError("Connect wallet first"); return; }
    if (!stratName.trim()) { setError("Name your strategy first"); return; }
    setSaving(true); setError(null);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/strategies`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: stratName.trim(), config, stats: backtest?.combined || null, walletSig }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Save failed");
      setStrategies(data.strategies || []);
      setStratName("");
      setSuccess("Strategy saved"); setTimeout(() => setSuccess(null), 3000);
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  }
  function loadStrategy(s: any) {
    setConfig({ ...DEFAULT_CONFIG, ...s.config });
    setSuccess(`Loaded "${s.name}" — review + activate`); setTimeout(() => setSuccess(null), 3000);
  }
  async function deleteStrategy(id: string) {
    if (!walletAddress) return;
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/strategies/${id}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletSig }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setStrategies(data.strategies || []);
    } catch { /* ignore */ }
  }
  async function togglePublish(s: any) {
    if (!walletAddress) return;
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/strategies/${s.id}/publish`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletSig, public: !s.public }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setStrategies(data.strategies || []); setSuccess(!s.public ? "Published to community" : "Made private"); setTimeout(() => setSuccess(null), 3000); }
    } catch { /* ignore */ }
  }

  // Community strategy browse (public, ranked by author graded record).
  const [community, setCommunity] = useState<any[] | null>(null);
  const [communityStyle, setCommunityStyle] = useState<string>("");
  async function loadCommunity(style: string) {
    setCommunityStyle(style);
    try {
      const res = await fetch(`${AGENT_API}/agents/strategies/public${style ? `?style=${style}` : ""}`);
      if (res.ok) setCommunity((await res.json()).strategies || []);
    } catch { setCommunity([]); }
  }
  function copyStrategy(s: any) {
    setConfig({ ...DEFAULT_CONFIG, ...s.config });
    setSuccess(`Copied "${s.name}" into your editor — set your own risk & save.`); setTimeout(() => setSuccess(null), 4000);
  }

  // Signal webhook (TradingView / external). enable & rotate mint a fresh secret
  // URL; disable revokes it. The URL is a secret — cache it client-side (session)
  // since the API only returns it on enable/rotate, never on the public GET.
  async function manageWebhook(op: "enable" | "rotate" | "disable") {
    if (!walletAddress) { setError("Connect wallet first"); return; }
    setSaving(true); setError(null);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/webhook/${op}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletSig }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.hint || data.error || "Webhook request failed");
      const key = `nexus_webhook_${walletAddress.toLowerCase()}`;
      if (op === "disable") {
        setWebhookEnabled(false); setWebhookInfo(null); sessionStorage.removeItem(key);
        setSuccess("Webhook disabled");
      } else {
        const info = { url: data.url, passphrase: data.passphrase };
        setWebhookEnabled(true); setWebhookInfo(info);
        sessionStorage.setItem(key, JSON.stringify(info));
        setSuccess(op === "rotate" ? "Webhook rotated — old URL revoked" : "Webhook enabled");
      }
      setTimeout(() => setSuccess(null), 3000);
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  }

  async function deactivateAgent() {
    if (!walletAddress) return;
    setSaving(true);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletSig }),
      });
      if (!res.ok) throw new Error("Failed to deactivate");
      setAgentState((prev) => prev ? { ...prev, active: false, current_position: null } : null);
      setSuccess("Agent deactivated — trading key removed");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveConfig() {
    if (!walletAddress) return;
    setSaving(true);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, walletSig }),
      });
      if (!res.ok) throw new Error("Failed to save config");
      setSuccess("Config saved");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function resetPaperRecord() {
    if (!walletAddress) return;
    if (!window.confirm("Clear your paper track record? This wipes all simulated trades and resets paper daily stats. Your live record is untouched.")) return;
    setSaving(true);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/paper/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletSig }),
      });
      if (!res.ok) throw new Error("Failed to reset paper record");
      setSuccess("Paper record cleared");
      await fetchAgentData();
      setTimeout(() => setSuccess(null), 3000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function forceTestSignal() {
    if (!walletAddress) return;
    setSaving(true);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/test-signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "LONG", walletSig }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to inject test signal");
      setSuccess("Test signal injected — paper trade fires within ~1 min");
      setTimeout(() => setSuccess(null), 4000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function loadLeaderboard() {
    setLbLoading(true);
    try {
      const [lbRes, ledRes] = await Promise.all([
        fetch(`${AGENT_API}/agents/leaderboard`),
        fetch(`${AGENT_API}/agents/ledger`).catch(() => null),
      ]);
      const data = await lbRes.json();
      setLeaderboard(Array.isArray(data?.leaderboard) ? data.leaderboard : []);
      if (ledRes && ledRes.ok) {
        const led = await ledRes.json();
        if (led?.ledgerHash) setLedgerInfo({ hash: led.ledgerHash, count: led.count ?? 0, onChain: led.onChain ?? null });
      }
    } catch {
      setLeaderboard([]);
    } finally {
      setLbLoading(false);
    }
  }

  function copyAgentConfig(entry: AgentLeaderboardEntry) {
    if (!entry.config) return;
    // Copy the STRATEGY only — keep the user's own capital/daily-loss budget,
    // and force PAPER so they prove the copied strategy before risking real funds.
    setConfig((prev) => ({
      ...prev,
      symbols: entry.config!.symbols ?? prev.symbols,
      leverage: entry.config!.leverage ?? prev.leverage,
      tpPercent: entry.config!.tpPercent ?? prev.tpPercent,
      slPercent: entry.config!.slPercent ?? prev.slPercent,
      maxHoldHours: entry.config!.maxHoldHours ?? prev.maxHoldHours,
      maxTradesPerDay: entry.config!.maxTradesPerDay ?? prev.maxTradesPerDay,
      fundingThreshold: entry.config!.fundingThreshold ?? prev.fundingThreshold,
      signalMode: entry.config!.signalMode ?? prev.signalMode,
      oiChangeThreshold: entry.config!.oiChangeThreshold ?? prev.oiChangeThreshold,
      priceChangeThreshold: entry.config!.priceChangeThreshold ?? prev.priceChangeThreshold,
      mode: "PAPER",
    }));
    setTab("config");
    const who = entry.displayName || `${entry.wallet.slice(0, 6)}…${entry.wallet.slice(-4)}`;
    setSuccess(`Copied ${who}'s strategy → running in PAPER. Review & activate below.`);
    setTimeout(() => setSuccess(null), 5000);
  }

  async function killSwitch() {
    if (!walletAddress) return;
    if (!window.confirm("KILL SWITCH — This will immediately close any open position and deactivate the agent. Continue?")) return;
    setSaving(true);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletSig }),
      });
      if (!res.ok) throw new Error("Kill switch failed");
      setAgentState((prev) => prev ? { ...prev, active: false, current_position: null } : null);
      setSuccess("Agent killed — position closed, key removed");
      setTimeout(() => setSuccess(null), 5000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // ─── Resolve a pending ASSISTED thesis (deploy = manual, dismiss) ──
  async function resolvePending(id: string, action: "deploy" | "dismiss") {
    if (!walletAddress) return;
    setPending((prev) => prev.filter((t) => t.id !== id));
    try {
      const walletSig = await getAgentSig(walletAddress);
      await fetch(`${AGENT_API}/agent/${walletAddress}/pending/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletSig }),
      });
    } catch (e) {
      console.error("[agent] resolve pending error:", e);
    }
  }

  if (!walletAddress) {
    return (
      <div style={{ ...agentCardStyle, textAlign: "center", padding: 40 }}>
        <div style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 13 }}>
          // CONNECT WALLET TO CONFIGURE AGENT
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ ...agentCardStyle, textAlign: "center", padding: 40 }}>
        <div style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 13 }}>
          // LOADING AGENT STATE...
        </div>
      </div>
    );
  }

  const isActive = agentState?.active === true;
  const hasPosition = agentState?.current_position !== null && agentState?.current_position !== undefined;

  return (
    <div>
      {/* ─── Header ──────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, rowGap: 10, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: "monospace", fontSize: 14, color: "#00ff88", fontWeight: 600 }}>
            // NEXUS AGENT
          </span>
          <span style={{
            fontFamily: "monospace", fontSize: 10, padding: "3px 10px", borderRadius: 3,
            background: isActive ? "#00ff8815" : "#ff444415",
            border: `1px solid ${isActive ? "#00ff8840" : "#ff444440"}`,
            color: isActive ? "#00ff88" : "#ff4444",
            textTransform: "uppercase", letterSpacing: "0.1em",
          }}>
            {isActive ? (hasPosition ? "● TRADING" : "● WATCHING") : "○ INACTIVE"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["config", "status", "history", "leaderboard"] as const).map((t) => (
            <button key={t} onClick={() => { setTab(t); if (t === "leaderboard" && !leaderboard) loadLeaderboard(); }} style={{
              background: tab === t ? "#0a1a0a" : "none",
              border: `1px solid ${tab === t ? "#00ff88" : "transparent"}`,
              color: tab === t ? "#00ff88" : "#4a7a5a",
              fontFamily: "monospace", fontSize: 10, padding: "4px 10px",
              cursor: "pointer", letterSpacing: "0.05em", borderRadius: 3,
              textTransform: "uppercase",
            }}>
              {t === "leaderboard" ? "TOP AGENTS" : t}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ ...agentCardStyle, borderColor: "#ff4444", background: "#1a0a0a", marginBottom: 12 }}>
          <span style={{ color: "#ff4444", fontFamily: "monospace", fontSize: 12 }}>⚠ {error}</span>
          <span onClick={() => setError(null)} style={{ float: "right", cursor: "pointer", color: "#ff4444" }}>✕</span>
        </div>
      )}
      {success && (
        <div style={{ ...agentCardStyle, borderColor: "#00ff88", background: "#0a1a0a", marginBottom: 12 }}>
          <span style={{ color: "#00ff88", fontFamily: "monospace", fontSize: 12 }}>✓ {success}</span>
        </div>
      )}

      {/* ─── CONFIG TAB ──────────────────────────────────── */}
      {tab === "config" && (
        <div>
          {/* ── TRADING STYLE — the friendly on-ramp: pick a horizon, get a tuned
              starting config. Day/Swing are the agent's honest home (hourly data +
              1-min cron + funding edge); scalping/position are intentionally absent. */}
          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// TRADING STYLE <span style={{ color: "#3a6a4a" }}>— pick your horizon to start</span></div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              {(Object.keys(STYLE_PRESETS) as TradingStyle[]).map((k) => {
                const p = STYLE_PRESETS[k];
                const active = deriveStyle(config) === k;
                return (
                  <button key={k} onClick={() => {
                    setConfig((prev) => ({ ...prev, ...p.config }));
                    setSuccess(`${p.label} style loaded — review params & Save below.`);
                    setTimeout(() => setSuccess(null), 5000);
                  }} style={{
                    flex: "1 1 200px", textAlign: "left", cursor: "pointer",
                    background: active ? "#00ff8810" : "#0a0e0a",
                    border: `1px solid ${active ? "#00ff88" : "#1e2d1e"}`, borderRadius: 6, padding: "10px 12px",
                  }}>
                    <div style={{ color: active ? "#00ff88" : "#c0c0c0", fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>{p.label}{active ? " ✓" : ""}</div>
                    <div style={{ color: "#5a7a6a", fontFamily: "monospace", fontSize: 10, marginTop: 3, lineHeight: 1.4 }}>{p.blurb}</div>
                  </button>
                );
              })}
            </div>
            <div style={{ color: "#3a5a4a", fontFamily: "monospace", fontSize: 9, marginTop: 8, lineHeight: 1.5 }}>
              Nexus's agent lives in the day-to-swing middle. Scalping (seconds) needs sub-minute data the funding edge doesn't use; position trading is buy-and-hold — neither fits this tool, so we don't fake them.
            </div>
          </div>

          {/* Quick-start preset templates. Loads into config for review; user still
              saves explicitly. PRO presets gated by isPro. */}
          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// QUICK-START PRESETS <span style={{ color: "#3a6a4a" }}>— load a preset, review, save</span></div>
            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, marginTop: 10 }}>
              {STRATEGY_PRESETS.map((p) => {
                const locked = !!p.pro && !isPro;
                return (
                  <button key={p.id} title={locked ? "Advanced strategy — Nexus PRO" : p.blurb}
                    onClick={() => {
                      if (locked) { setProNote(true); return; }
                      setProNote(false);
                      setConfig((prev) => ({ ...prev, ...p.config }));
                      setSuccess(`Loaded "${p.name}" — review params & Save below.`);
                      setTimeout(() => setSuccess(null), 5000);
                    }}
                    style={{
                      flex: "0 0 200px", textAlign: "left", cursor: "pointer",
                      background: "#0a0e0a", border: `1px solid ${locked ? "#1e2d1e" : p.accent + "40"}`,
                      borderRadius: 6, padding: "10px 12px",
                    }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: locked ? "#3a5a4a" : "#fff", fontFamily: "monospace", fontWeight: "bold" }}>{p.name}{locked ? " ◆" : ""}</span>
                    </div>
                    <div style={{ fontSize: 8, color: p.accent, fontFamily: "monospace", letterSpacing: "0.08em", marginBottom: 6 }}>{p.tag}</div>
                    <div style={{ fontSize: 9.5, color: "#6a8a7a", fontFamily: "monospace", lineHeight: 1.5 }}>{p.blurb}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Track record — surfaced before activation so users judge on real numbers.
              Live (Supabase) and Paper (state ledger) are kept strictly separate. */}
          {(config.mode === "PAPER" || (agentState?.paper_trades?.length ?? 0) > 0) && (
            <AgentTrackRecord title="// 🧪 PAPER TRACK RECORD" accent="#4a9fff" trades={agentState?.paper_trades ?? []} paper onReset={resetPaperRecord} />
          )}

          {/* Graduation nudge — once a paper agent is proven, bridge to live */}
          {config.mode === "PAPER" && (() => {
            const pt = agentState?.paper_trades ?? [];
            const net = pt.reduce((s, t) => s + t.pnl, 0);
            const wins = pt.filter((t) => t.pnl > 0).length;
            const wr = pt.length ? Math.round((wins / pt.length) * 100) : 0;
            if (pt.length < 5 || net <= 0) return null;
            return (
              <div style={{ ...agentCardStyle, borderColor: "#1a4a2a", background: "#0a1a0e" }}>
                <div style={{ ...agentLabelStyle, color: "#00ff88" }}>🎓 READY TO GO LIVE?</div>
                <div style={{ color: "#8aaa9a", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>
                  Your paper agent is proven — <strong style={{ color: "#00ff88" }}>+${net.toFixed(2)}</strong> over{" "}
                  <strong style={{ color: "#fff" }}>{pt.length}</strong> simulated trades ({wr}% win rate). Same strategy,
                  same guardrails — switch it to live to put it to work for real.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button onClick={() => { setConfig({ ...config, mode: "ASSISTED" }); setSuccess("Mode → ASSISTED. Review params + hit Update below."); setTimeout(() => setSuccess(null), 4000); }}
                    style={{ background: "#00ff8815", border: "1px solid #00ff88", borderRadius: 4, color: "#00ff88", fontFamily: "monospace", fontSize: 11, padding: "8px 16px", cursor: "pointer" }}>
                    → GO ASSISTED
                  </button>
                  <button onClick={() => { setConfig({ ...config, mode: "AUTONOMOUS" }); setSuccess("Mode → AUTONOMOUS. Needs a trading key — review below."); setTimeout(() => setSuccess(null), 4000); }}
                    style={{ background: "#ff880015", border: "1px solid #ff8800", borderRadius: 4, color: "#ff8800", fontFamily: "monospace", fontSize: 11, padding: "8px 16px", cursor: "pointer" }}>
                    → GO AUTONOMOUS
                  </button>
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a", marginTop: 10, lineHeight: 1.5 }}>
                  Paper results don't guarantee live results — live trades face real fills, slippage, and funding. Start with size you can afford to lose.
                </div>
              </div>
            );
          })()}

          <AgentTrackRecord title="// LIVE TRACK RECORD" accent="#8aaa9a" trades={trades} />

          {/* Onboarding + key-status panel */}
          <div style={{ ...agentCardStyle, borderColor: tradingKey ? "#1a3a2a" : "#4a3a00" }}>
            <div style={agentLabelStyle}>// HOW THE AGENT WORKS</div>
            <ol style={{ margin: "8px 0 0", paddingLeft: 18, color: "#8aaa9a", fontFamily: "monospace", fontSize: 11, lineHeight: 1.7 }}>
              <li>Place at least one manual trade on Nexus — this generates your Orderly trading key (order-only, <strong style={{ color: "#c0c0c0" }}>cannot withdraw funds</strong>).</li>
              <li>Pick your symbols, risk params, and mode below.</li>
              <li><strong style={{ color: "#c0c0c0" }}>ASSISTED</strong> = the agent surfaces signals for you to place yourself. <strong style={{ color: "#c0c0c0" }}>AUTONOMOUS</strong> = it trades within your risk limits.</li>
              <li>Activate. You can DEACTIVATE or KILL anytime.</li>
            </ol>
            <div style={{
              marginTop: 10, padding: "8px 10px", borderRadius: 3,
              background: tradingKey ? "#0a1a0a" : "#1a1400",
              border: `1px solid ${tradingKey ? "#1a4a2a" : "#4a3a00"}`,
              fontFamily: "monospace", fontSize: 11,
              color: tradingKey ? "#00ff88" : "#fbbf24",
            }}>
              {tradingKey
                ? "● TRADING KEY DETECTED — ready to activate. Your key is encrypted at rest and can only place orders, never withdraw."
                : "○ NO TRADING KEY YET — place one manual trade first to generate it, then refresh this tab."}
            </div>
          </div>

          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// EXECUTION MODE</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              {([
                { mode: "PAPER" as const,      color: "#4a9fff", desc: "Simulated — no real orders, no key needed. Test risk-free." },
                { mode: "ASSISTED" as const,   color: "#00ff88", desc: "Agent generates thesis → you review + deploy" },
                { mode: "AUTONOMOUS" as const, color: "#ff8800", desc: "Agent executes automatically within your risk params" },
              ]).map(({ mode, color, desc }) => {
                const sel = config.mode === mode;
                return (
                  <button key={mode} onClick={() => setConfig({ ...config, mode })} style={{
                    flex: 1,
                    background: sel ? `${color}20` : "#0a0e0a",
                    border: `1px solid ${sel ? color : "#1e2d1e"}`,
                    borderRadius: 4, padding: "10px 16px", cursor: "pointer",
                    color: sel ? color : "#4a7a5a",
                    fontFamily: "monospace", fontSize: 12, letterSpacing: "0.05em",
                  }}>
                    <div style={{ fontWeight: 600 }}>{mode === "PAPER" ? "🧪 PAPER" : mode}</div>
                    <div style={{ fontSize: 9, marginTop: 4, opacity: 0.7 }}>{desc}</div>
                  </button>
                );
              })}
            </div>
            {config.mode === "AUTONOMOUS" && (
              <div style={{ marginTop: 8, padding: 8, background: "#1a0e00", border: "1px solid #ff880030", borderRadius: 3 }}>
                <span style={{ color: "#ff8800", fontFamily: "monospace", fontSize: 10 }}>
                  ⚠ AUTONOMOUS MODE — Agent will execute trades using your Orderly trading key. Your wallet keys are never stored. The trading key can place orders but CANNOT withdraw funds. You can deactivate at any time.
                </span>
              </div>
            )}
            {config.mode === "PAPER" && (
              <div style={{ marginTop: 8, padding: 8, background: "#0a1420", border: "1px solid #4a9fff30", borderRadius: 3 }}>
                <span style={{ color: "#4a9fff", fontFamily: "monospace", fontSize: 10 }}>
                  🧪 PAPER MODE — The agent runs its full strategy against live prices but places <strong>zero real orders</strong>. No trading key required. Results are recorded to a separate paper track record below so you can prove it out before risking a cent.
                </span>
              </div>
            )}
          </div>

          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// STRATEGY — SIGNAL MODE</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {([
                { v: "CONFLUENCE", label: "CONFLUENCE", hint: "Funding AND OI must agree (strictest, validated default)" },
                { v: "FUNDING_ONLY", label: "FUNDING", hint: "Fade funding extremes only" },
                { v: "OI_ONLY", label: "OI DIVERGENCE", hint: "Open-interest divergence only" },
                { v: "MOMENTUM", label: "MOMENTUM", hint: "Trade WITH the move (trend-follow)" },
                { v: "MEAN_REVERSION", label: "MEAN REVERSION", hint: "Fade the move (buy dip / sell rip)" },
              ] as const).map(({ v, label, hint }) => {
                const sel = (config.signalMode ?? "CONFLUENCE") === v;
                const locked = isProStrategy(v) && !isPro;
                return (
                  <button key={v} title={locked ? "Advanced strategy — Nexus PRO" : hint}
                    onClick={() => { if (locked) { setProNote(true); return; } setProNote(false); setConfig({ ...config, signalMode: v }); }}
                    style={{
                    background: sel ? "#00ff8815" : "#0a0e0a",
                    border: `1px solid ${sel ? "#00ff8860" : "#1e2d1e"}`,
                    borderRadius: 3, padding: "4px 10px", cursor: "pointer",
                    color: locked ? "#3a5a4a" : sel ? "#00ff88" : "#4a7a5a",
                    fontFamily: "monospace", fontSize: 11,
                  }}>{label}{locked ? " ◆" : ""}</button>
                );
              })}
            </div>
            {proNote && (
              <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 6, color: "#5fd6a0" }}>
                ◆ Advanced strategies are Nexus PRO — hold $NEXUS or subscribe (see PRO in the Lab).
              </div>
            )}
            <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 8, color: "#3a6a4a" }}>
              {({
                CONFLUENCE: "Both funding + OI-divergence must agree. Fewest, highest-quality entries.",
                FUNDING_ONLY: "Trades funding extremes alone. More entries, lower selectivity.",
                OI_ONLY: "Trades OI-divergence alone. Funding ignored.",
                MOMENTUM: "Trades WITH a price move above your threshold — rides strength. Noisy on short ticks; test in PAPER.",
                MEAN_REVERSION: "FADES a price move above your threshold — buy the dip, sell the rip. Test in PAPER.",
              } as Record<string, string>)[config.signalMode ?? "CONFLUENCE"]}
            </div>
          </div>

          {/* Opt-in market-regime filter — gates entries that fight a strong tape.
              Server-enforced in the brain; never flips direction or touches positions. */}
          <div style={agentCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <div style={agentLabelStyle}>// MARKET REGIME FILTER</div>
                <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 6, color: "#3a6a4a", letterSpacing: 0 }}>
                  Skip NEW entries that fight a strong tape — RISK-ON gates shorts, RISK-OFF gates longs.
                  Never flips direction or touches open positions. Test in PAPER first. (See live regime in Market Intel.)
                </div>
              </div>
              <button onClick={() => setConfig({ ...config, respectRegime: !config.respectRegime })}
                style={{
                  flexShrink: 0, cursor: "pointer", fontFamily: "monospace", fontSize: 11, borderRadius: 4, padding: "6px 16px",
                  background: config.respectRegime ? "#00ff8815" : "#0a0e0a",
                  border: `1px solid ${config.respectRegime ? "#00ff88" : "#1e2d1e"}`,
                  color: config.respectRegime ? "#00ff88" : "#4a7a5a",
                }}>
                {config.respectRegime ? "ON" : "OFF"}
              </button>
            </div>
          </div>

          <div style={agentCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <div style={agentLabelStyle}>// VOLATILITY-SCALED STOPS</div>
                <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 6, color: "#3a6a4a", letterSpacing: 0 }}>
                  Sizes TP/SL to each symbol&apos;s recent ATR instead of a flat % — so a high-vol coin (SOL) isn&apos;t
                  noise-stopped and a calm one isn&apos;t over-given. Keeps your R:R ratio. Test in PAPER first.
                </div>
              </div>
              <button onClick={() => setConfig({ ...config, volScaledStops: !config.volScaledStops })}
                style={{
                  flexShrink: 0, cursor: "pointer", fontFamily: "monospace", fontSize: 11, borderRadius: 4, padding: "6px 16px",
                  background: config.volScaledStops ? "#00ff8815" : "#0a0e0a",
                  border: `1px solid ${config.volScaledStops ? "#00ff88" : "#1e2d1e"}`,
                  color: config.volScaledStops ? "#00ff88" : "#4a7a5a",
                }}>
                {config.volScaledStops ? "ON" : "OFF"}
              </button>
            </div>
          </div>

          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// WATCHLIST — SELECT SYMBOLS</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {AVAILABLE_SYMBOLS.map((sym) => {
                const selected = config.symbols.includes(sym);
                const label = sym.replace("PERP_", "").replace("_USDC", "");
                return (
                  <button key={sym} onClick={() => {
                    setConfig({
                      ...config,
                      symbols: selected
                        ? config.symbols.filter((s) => s !== sym)
                        : [...config.symbols, sym],
                    });
                  }} style={{
                    background: selected ? "#00ff8815" : "#0a0e0a",
                    border: `1px solid ${selected ? "#00ff8860" : "#1e2d1e"}`,
                    borderRadius: 3, padding: "4px 10px", cursor: "pointer",
                    color: selected ? "#00ff88" : "#4a7a5a",
                    fontFamily: "monospace", fontSize: 11,
                  }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// RISK PARAMETERS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginTop: 8 }}>
              {[
                { key: "leverage", label: "LEVERAGE", suffix: "x", min: 1, max: 20, step: 1 },
                { key: "capitalPerTrade", label: "CAPITAL / TRADE", suffix: "USDC", min: 10, max: 10000, step: 10 },
                { key: "tpPercent", label: "TAKE PROFIT", suffix: "%", min: 0.25, max: 10, step: 0.25 },
                { key: "slPercent", label: "STOP LOSS", suffix: "%", min: 0.25, max: 5, step: 0.25 },
                { key: "maxHoldHours", label: "MAX HOLD TIME", suffix: "hrs", min: 1, max: 336, step: 1 },
                { key: "maxTradesPerDay", label: "MAX TRADES / DAY", suffix: "", min: 1, max: 50, step: 1 },
                { key: "maxDailyLossUsdc", label: "MAX DAILY LOSS", suffix: "USDC", min: 1, max: 500, step: 1 },
                { key: "fundingThreshold", label: "FUNDING THRESHOLD", suffix: "%", min: 0.001, max: 0.1, step: 0.001 },
                { key: "fundingPercentileMin", label: "FUNDING %ILE MIN", suffix: "pct (0=off)", min: 0, max: 99, step: 5 },
                { key: "oiChangeThreshold", label: "OI MOVE THRESHOLD", suffix: "%", min: 0, max: 10, step: 0.05 },
                { key: "priceChangeThreshold", label: "PRICE MOVE THRESHOLD", suffix: "%", min: 0.1, max: 10, step: 0.1 },
              ].map(({ key, label, suffix, min, max, step }) => (
                <div key={key}>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <NumberField
                      value={(config as any)[key] ?? 0}
                      min={min} max={max} step={step}
                      onCommit={(n) => setConfig({ ...config, [key]: n })}
                    />
                    <span style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 10 }}>{suffix}</span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 10, color: "#3a6a4a", lineHeight: 1.5 }}>
              Entry params (mode, thresholds, symbols, leverage, capital) apply to your NEXT trade.
              <br />
              ⚡ TP / SL / max-hold apply LIVE — changing them adjusts an open position immediately.
            </div>
          </div>

          {/* ── ADVANCED EXITS — multi-level take-profit + trailing stop ── */}
          {(() => {
            const tps = config.takeProfits;
            const scaleOut = Array.isArray(tps) && tps.length > 1;
            const ladder = scaleOut ? tps! : [
              { pct: config.tpPercent, sizePct: 50 },
              { pct: Math.round(config.tpPercent * 1.8 * 4) / 4, sizePct: 50 },
            ];
            const setTp = (i: number, field: "pct" | "sizePct", val: number) => {
              const next = ladder.map((t) => ({ ...t }));
              next[i] = { ...next[i], [field]: val };
              // keep sizes summing to 100 across the two legs
              if (field === "sizePct") next[i === 0 ? 1 : 0].sizePct = Math.max(0, 100 - val);
              setConfig({ ...config, takeProfits: next, tpPercent: next[0].pct });
            };
            const toggleScaleOut = () => setConfig(scaleOut
              ? { ...config, takeProfits: undefined }
              : { ...config, takeProfits: ladder });
            return (
              <div style={agentCardStyle}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div style={agentLabelStyle}>// ADVANCED EXITS</div>
                  <button onClick={toggleScaleOut} style={{
                    fontFamily: "monospace", fontSize: 10, padding: "4px 12px", borderRadius: 3, cursor: "pointer",
                    background: scaleOut ? "#00ff8815" : "#0a0e0a",
                    border: `1px solid ${scaleOut ? "#00ff88" : "#1e2d1e"}`,
                    color: scaleOut ? "#00ff88" : "#4a7a5a",
                  }}>
                    SCALE-OUT {scaleOut ? "ON" : "OFF"}
                  </button>
                </div>

                {scaleOut && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 10 }}>
                    {ladder.slice(0, 2).map((leg, i) => (
                      <div key={i} style={{ display: "flex", gap: 10 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ ...agentLabelStyle, fontSize: 9 }}>TP{i + 1} TARGET</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <NumberField value={leg.pct} min={0.25} max={20} step={0.25} onCommit={(n) => setTp(i, "pct", n)} />
                            <span style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 10 }}>%</span>
                          </div>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ ...agentLabelStyle, fontSize: 9 }}>TP{i + 1} SIZE</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <NumberField value={leg.sizePct} min={5} max={95} step={5} onCommit={(n) => setTp(i, "sizePct", n)} />
                            <span style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 10 }}>%</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 12 }}>
                  <div>
                    <div style={{ ...agentLabelStyle, fontSize: 9 }}>TRAILING STOP</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <NumberField value={config.trailingStopPct ?? 0} min={0} max={5} step={0.1} onCommit={(n) => setConfig({ ...config, trailingStopPct: n })} />
                      <span style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 10 }}>% below peak (0 = off)</span>
                    </div>
                  </div>
                  <div>
                    <div style={{ ...agentLabelStyle, fontSize: 9 }}>BREAKEVEN STOP</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <NumberField value={config.breakevenTriggerPct ?? 0} min={0} max={10} step={0.1} onCommit={(n) => setConfig({ ...config, breakevenTriggerPct: n })} />
                      <span style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 10 }}>% in profit arms it (0 = off)</span>
                    </div>
                  </div>
                  {(config.breakevenTriggerPct ?? 0) > 0 && (
                    <div>
                      <div style={{ ...agentLabelStyle, fontSize: 9 }}>BREAKEVEN BUFFER</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <NumberField value={config.breakevenBufferPct ?? 0} min={0} max={2} step={0.05} onCommit={(n) => setConfig({ ...config, breakevenBufferPct: n })} />
                        <span style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 10 }}>% above entry the stop locks to</span>
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 10, color: "#3a6a4a", lineHeight: 1.5 }}>
                  {scaleOut
                    ? "Scale-out takes partial profit at TP1 and lets the runner ride to TP2 — each slice is graded on its own."
                    : "Single take-profit at the TAKE PROFIT % above. Turn on SCALE-OUT to bank partial profit early."}
                  {(config.trailingStopPct ?? 0) > 0 && " Trailing stop arms at TP1 and locks gains as price runs."}
                  {(config.breakevenTriggerPct ?? 0) > 0 && ` Breakeven stop arms at +${config.breakevenTriggerPct}% and moves the SL to +${config.breakevenBufferPct ?? 0}% — once armed, the trade can no longer close at a real loss.`}
                </div>
              </div>
            );
          })()}

          {/* ── DCA / SAFETY ORDERS — average-in mode (PRO) ── */}
          {(() => {
            const dca = config.dca || { maxSafetyOrders: 3, safetyOrderStepPct: 1.5, safetyOrderStepScale: 1.2, safetyOrderVolumeScale: 1.5 };
            const on = !!config.dcaEnabled;
            const setDca = (k: string, v: number) => setConfig({ ...config, dca: { ...dca, [k]: v }, dcaEnabled: true });
            const toggle = () => setConfig({ ...config, dcaEnabled: !on, dca });
            // Preview the worst-case averaged exposure (base + all safety orders = capitalPerTrade).
            const units = (() => { let U = 0; for (let i = 0; i <= dca.maxSafetyOrders; i++) U += Math.pow(dca.safetyOrderVolumeScale, i); return U; })();
            let cumDev = 0; for (let i = 0; i < dca.maxSafetyOrders; i++) cumDev += dca.safetyOrderStepPct * Math.pow(dca.safetyOrderStepScale, i);
            return (
              <div style={agentCardStyle}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={agentLabelStyle}>// DCA / SAFETY ORDERS</div>
                    <span style={{ fontFamily: "monospace", fontSize: 9, color: "#fbbf24", border: "1px solid #fbbf2440", borderRadius: 3, padding: "2px 8px" }}>◆ PRO</span>
                  </div>
                  <button onClick={isPro ? toggle : undefined} disabled={!isPro} style={{
                    fontFamily: "monospace", fontSize: 10, padding: "4px 12px", borderRadius: 3, cursor: isPro ? "pointer" : "not-allowed",
                    background: on ? "#00ff8815" : "#0a0e0a",
                    border: `1px solid ${on ? "#00ff88" : "#1e2d1e"}`,
                    color: on ? "#00ff88" : "#4a7a5a", opacity: isPro ? 1 : 0.5,
                  }}>
                    {on ? "ON" : "OFF"}
                  </button>
                </div>
                {!isPro ? (
                  <div style={{ color: "#5a7a6a", fontFamily: "monospace", fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
                    Average into a position on adverse moves and take profit off the blended entry — a Nexus PRO feature. The whole ladder stays inside your CAPITAL / TRADE budget.
                  </div>
                ) : on && (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 10 }}>
                      {[
                        { key: "maxSafetyOrders", label: "MAX SAFETY ORDERS", min: 1, max: 8, step: 1, suffix: "" },
                        { key: "safetyOrderStepPct", label: "FIRST STEP", min: 0.25, max: 10, step: 0.25, suffix: "%" },
                        { key: "safetyOrderStepScale", label: "STEP SCALE", min: 1, max: 3, step: 0.1, suffix: "×" },
                        { key: "safetyOrderVolumeScale", label: "VOLUME SCALE", min: 1, max: 3, step: 0.1, suffix: "×" },
                      ].map(({ key, label, min, max, step, suffix }) => (
                        <div key={key}>
                          <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <NumberField value={(dca as any)[key]} min={min} max={max} step={step} onCommit={(n) => setDca(key, n)} />
                            <span style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 10 }}>{suffix}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ color: "#3a6a4a", fontFamily: "monospace", fontSize: 10, marginTop: 10, lineHeight: 1.6 }}>
                      Base order ≈ ${(config.capitalPerTrade / units).toFixed(0)} of your ${config.capitalPerTrade} budget; up to {dca.maxSafetyOrders} safety orders average in if price moves ~{cumDev.toFixed(1)}% against you. TP is taken at {config.tpPercent}% off the blended average; the stop only cuts once all safety orders are spent. Daily-loss cap + kill switch still override.
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {/* ── SIGNAL WEBHOOK — TradingView / external signal → your agent (PRO) ── */}
          <div style={agentCardStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={agentLabelStyle}>// SIGNAL WEBHOOK</div>
              <span style={{ fontFamily: "monospace", fontSize: 9, color: "#fbbf24", border: "1px solid #fbbf2440", borderRadius: 3, padding: "2px 8px" }}>◆ PRO</span>
            </div>
            {!isPro ? (
              <div style={{ color: "#5a7a6a", fontFamily: "monospace", fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
                Route TradingView (or any external) alerts straight to your agent — it executes them through the same guardrails + trustless grading. A Nexus PRO feature: hold ARCHITECT-tier $NEXUS or subscribe.
              </div>
            ) : !webhookEnabled ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ color: "#5a7a6a", fontFamily: "monospace", fontSize: 11, lineHeight: 1.5, marginBottom: 10 }}>
                  Generate a private webhook URL. Point a TradingView alert (or any system) at it and your agent trades the signal in its current mode — {config.mode === "PAPER" ? "simulated in PAPER" : config.mode === "ASSISTED" ? "queued for review in ASSISTED" : "executed live in AUTONOMOUS"}.
                </div>
                <button onClick={() => manageWebhook("enable")} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.5 : 1 }}>
                  ENABLE WEBHOOK
                </button>
              </div>
            ) : (
              <div style={{ marginTop: 10 }}>
                {webhookInfo ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div>
                      <div style={{ ...agentLabelStyle, fontSize: 9 }}>WEBHOOK URL (secret — keep private)</div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <code style={{ flex: 1, minWidth: 0, overflowX: "auto", whiteSpace: "nowrap", color: "#00ff88", background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 3, padding: "6px 8px", fontSize: 11 }}>{webhookInfo.url}</code>
                        <button onClick={() => navigator.clipboard?.writeText(webhookInfo.url)} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 10px" }}>COPY</button>
                      </div>
                    </div>
                    <div>
                      <div style={{ ...agentLabelStyle, fontSize: 9 }}>ALERT MESSAGE (paste into TradingView)</div>
                      <code style={{ display: "block", color: "#c0c0c0", background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 3, padding: "8px", fontSize: 10, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                        {`{ "action": "BUY", "symbol": "BTC", "passphrase": "${webhookInfo.passphrase}" }`}
                      </code>
                      <div style={{ color: "#3a6a4a", fontFamily: "monospace", fontSize: 9, marginTop: 6, lineHeight: 1.5 }}>
                        action = BUY (long) · SELL (short) · CLOSE (flatten). symbol = any perp (BTC, ETH, SOL…). Webhook signals bypass the cooldown; while a position is open, a new OPEN is ignored (no stacking).
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: "#5a7a6a", fontFamily: "monospace", fontSize: 11, lineHeight: 1.5 }}>
                    Webhook is enabled, but the secret URL is only shown on this device when created. Rotate to reveal a fresh URL (this revokes the old one).
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button onClick={() => manageWebhook("rotate")} disabled={saving} style={{ ...navBtnStyle, fontSize: 10, padding: "6px 14px", opacity: saving ? 0.5 : 1 }}>ROTATE URL</button>
                  <button onClick={() => manageWebhook("disable")} disabled={saving} style={{ ...navBtnStyle, fontSize: 10, padding: "6px 14px", color: "#ff4444", borderColor: "#ff444450", opacity: saving ? 0.5 : 1 }}>DISABLE</button>
                </div>
              </div>
            )}
          </div>

          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// RISK SUMMARY</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12, marginTop: 8 }}>
              {[
                { label: "NOTIONAL / TRADE", value: `$${(config.capitalPerTrade * config.leverage).toFixed(0)}` },
                { label: "MAX RISK / TRADE", value: `$${(config.capitalPerTrade * (config.slPercent / 100) * config.leverage).toFixed(2)}` },
                { label: "R:R RATIO", value: `${(config.tpPercent / config.slPercent).toFixed(1)}:1` },
                { label: "MAX DAILY EXPOSURE", value: `$${(config.capitalPerTrade * config.leverage * config.maxTradesPerDay).toFixed(0)}` },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                  <div style={{ color: "#00ff88", fontFamily: "monospace", fontSize: 16, fontWeight: 600 }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── BACKTEST — test this exact config on real history (PRO) ── */}
          <div style={agentCardStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={agentLabelStyle}>// BACKTEST</div>
                <span style={{ fontFamily: "monospace", fontSize: 9, color: "#fbbf24", border: "1px solid #fbbf2440", borderRadius: 3, padding: "2px 8px" }}>◆ PRO</span>
              </div>
              {isPro && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={runConfigBacktest} disabled={backtesting || sweeping} style={{ ...btnPrimary, fontSize: 10, padding: "6px 16px", opacity: (backtesting || sweeping) ? 0.5 : 1 }}>
                    {backtesting ? "RUNNING…" : "▶ TEST THIS CONFIG"}
                  </button>
                  <button onClick={runConfigSweep} disabled={backtesting || sweeping} style={{ ...navBtnStyle, fontSize: 10, padding: "6px 16px", opacity: (backtesting || sweeping) ? 0.5 : 1 }}>
                    {sweeping ? "SWEEPING…" : "⊞ SWEEP CONFIGS"}
                  </button>
                </div>
              )}
            </div>
            {!isPro ? (
              <div style={{ color: "#5a7a6a", fontFamily: "monospace", fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
                Replay this exact config over 60 days of real BTC/ETH/SOL data — using the same engine the agent runs on — before risking a cent. A Nexus PRO feature.
              </div>
            ) : (
              <>
                <div style={{ color: "#3a6a4a", fontFamily: "monospace", fontSize: 10, marginTop: 8, lineHeight: 1.5 }}>
                  Replays your config on real Orderly history with the deployed signal + exit logic. Verify before you deploy capital.
                </div>
                {backtest && (
                  <div style={{ marginTop: 12 }}>
                    {backtest.untestable && (
                      <div style={{ color: "#fbbf24", fontFamily: "monospace", fontSize: 10, lineHeight: 1.5, marginBottom: 10, padding: "6px 8px", border: "1px solid #fbbf2430", borderRadius: 3 }}>
                        ⚠ {backtest.note}
                      </div>
                    )}
                    {/* When OI-driven modes ARE testable, surface the OI-window caveat
                        (funding+price span the full window; confluence only the recorded OI). */}
                    {!backtest.untestable && backtest.note && (
                      <div style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 10, lineHeight: 1.5, marginBottom: 10, padding: "6px 8px", border: "1px solid #1e2d1e", borderRadius: 3 }}>
                        ◆ {backtest.note}
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12 }}>
                      {[
                        { label: "NET P&L (60d)", value: `${backtest.combined.netUsd >= 0 ? "+" : ""}$${backtest.combined.netUsd}`, color: backtest.combined.netUsd >= 0 ? "#00ff88" : "#ff4444" },
                        { label: "WIN RATE", value: `${backtest.combined.winRate}%`, color: "#c0c0c0" },
                        { label: "TRADES", value: String(backtest.combined.trades), color: "#c0c0c0" },
                      ].map(({ label, value, color }) => (
                        <div key={label}>
                          <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                          <div style={{ color, fontFamily: "monospace", fontSize: 18, fontWeight: 600 }}>{value}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                      {backtest.perSymbol.map((s: any) => (
                        <div key={s.symbol} style={{ display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: 10, color: "#5a7a6a", borderTop: "1px solid #1e2d1e", paddingTop: 4 }}>
                          <span>{s.symbol.replace("PERP_", "").replace("_USDC", "")}</span>
                          <span>{s.trades} trades · {s.winRate}% win · PF {s.profitFactor} · <span style={{ color: s.netUsd >= 0 ? "#00ff88" : "#ff4444" }}>{s.netUsd >= 0 ? "+" : ""}${s.netUsd}</span></span>
                        </div>
                      ))}
                    </div>
                    <div style={{ color: "#3a5a4a", fontFamily: "monospace", fontSize: 9, marginTop: 8, lineHeight: 1.5 }}>
                      Past performance ≠ future results. Taker fees modeled (~3bps/side); funding RECEIVED while fading is not (a tailwind — live may run better). 60d hourly, ${(config.capitalPerTrade * config.leverage).toFixed(0)} notional/trade.
                    </div>
                  </div>
                )}
                {sweep && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ ...agentLabelStyle, fontSize: 9, marginBottom: 6 }}>
                      RANKED — {sweep.results.length} configs · {sweep.symbols.map((s: string) => s.replace("PERP_", "").replace("_USDC", "")).join("/")} · {sweep.days}d · ${sweep.notional} notional
                    </div>
                    <div style={{ overflowX: "auto" }}>
                      <div style={{ minWidth: 340 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 52px 56px", gap: 6, fontFamily: "monospace", fontSize: 9, color: "#4a7a5a", padding: "0 0 4px", borderBottom: "1px solid #1e2d1e" }}>
                          <span>STRATEGY</span><span style={{ textAlign: "right" }}>NET$</span><span style={{ textAlign: "right" }}>WIN%</span><span style={{ textAlign: "right" }}>TRADES</span>
                        </div>
                        {sweep.results.slice(0, 12).map((r: any, i: number) => (
                          <div key={i} onClick={() => r.config && applySweepConfig(r.config)} title="Apply this config to the editor above" style={{ display: "grid", gridTemplateColumns: "1fr 70px 52px 56px", gap: 6, fontFamily: "monospace", fontSize: 10, padding: "5px 4px", borderBottom: "1px solid #10160f", color: "#8aaa9a", cursor: r.config ? "pointer" : "default", borderRadius: 3 }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#0f1613"; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}>
                            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i === 0 ? "★ " : ""}{r.name}</span>
                            <span style={{ textAlign: "right", color: r.netUsd >= 0 ? "#00ff88" : "#ff4444", fontWeight: 600 }}>{r.netUsd >= 0 ? "+" : ""}{r.netUsd}</span>
                            <span style={{ textAlign: "right" }}>{r.winRate}</span>
                            <span style={{ textAlign: "right" }}>{r.trades}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{ color: "#3a5a4a", fontFamily: "monospace", fontSize: 9, marginTop: 8, lineHeight: 1.5 }}>
                      ↑ Click any row to apply that config to the editor. CONFLUENCE/OI aren't in the sweep (no OI history yet). Every config here was graded on real price — apply a winner, then paper-test before going live.
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── STRATEGY LIBRARY — save / load composed configs (free) ── */}
          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// STRATEGY LIBRARY</div>
            <div style={{ color: "#3a6a4a", fontFamily: "monospace", fontSize: 10, marginTop: 6, marginBottom: 10, lineHeight: 1.5 }}>
              Save the config above as a named strategy, then load it back anytime. Build → test → save your best.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                value={stratName}
                onChange={(e) => setStratName(e.target.value)}
                placeholder="name this strategy…"
                maxLength={40}
                style={{ ...agentInputStyle, flex: 1, minWidth: 160 }}
              />
              <button onClick={saveStrategy} disabled={saving || !stratName.trim()} style={{ ...btnPrimary, fontSize: 10, padding: "6px 16px", opacity: (saving || !stratName.trim()) ? 0.5 : 1 }}>
                💾 SAVE
              </button>
            </div>
            {strategies.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                {strategies.map((s) => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "8px 10px", background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 3 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
                      <div style={{ color: "#5a7a6a", fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>
                        <span style={{ color: "#4a9fff" }}>{deriveStyle(s.config)}</span> · {s.config.signalMode} · {s.config.mode} · {s.config.leverage}x · TP{s.config.tpPercent}/SL{s.config.slPercent}
                        {s.config.dcaEnabled ? " · DCA" : ""}
                        {s.stats ? <span style={{ color: s.stats.netUsd >= 0 ? "#00ff88" : "#ff4444" }}>{`  ·  60d ${s.stats.netUsd >= 0 ? "+" : ""}$${s.stats.netUsd}`}</span> : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => togglePublish(s)} title={s.public ? "Public — click to make private" : "Share to the community board"} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 10px", color: s.public ? "#00ff88" : "#5a7a6a", borderColor: s.public ? "#00ff8850" : "#1e2d1e" }}>{s.public ? "🌐 PUBLIC" : "SHARE"}</button>
                      <button onClick={() => loadStrategy(s)} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 12px" }}>LOAD</button>
                      <button onClick={() => deleteStrategy(s.id)} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 10px", color: "#ff4444", borderColor: "#ff444450" }}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── COMMUNITY STRATEGIES — browse shared configs, ranked by author's graded record ── */}
          <div style={agentCardStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={agentLabelStyle}>// COMMUNITY STRATEGIES</div>
              <div style={{ display: "flex", gap: 6 }}>
                {[{ k: "", l: "ALL" }, { k: "DAY", l: "DAY" }, { k: "SWING", l: "SWING" }].map(({ k, l }) => (
                  <button key={l} onClick={() => loadCommunity(k)} style={{ ...navBtnStyle, fontSize: 9, padding: "4px 10px", ...(community !== null && communityStyle === k ? { color: "#00ff88", borderColor: "#00ff8850" } : {}) }}>{l}</button>
                ))}
              </div>
            </div>
            <div style={{ color: "#3a6a4a", fontFamily: "monospace", fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
              Strategies shared by the community, ranked by the author's <strong style={{ color: "#8aaa9a" }}>graded live/paper record</strong> — not backtest (shown only as a hypothesis). Copy one to your editor and make it yours.
            </div>
            {community === null ? (
              <button onClick={() => loadCommunity("")} style={{ ...btnPrimary, fontSize: 10, padding: "6px 16px", marginTop: 10 }}>▤ BROWSE STRATEGIES</button>
            ) : community.length === 0 ? (
              <div style={{ color: "#5a7a6a", fontFamily: "monospace", fontSize: 11, marginTop: 10 }}>No public strategies{communityStyle ? ` for ${communityStyle}` : ""} yet — publish one from your library to seed the board.</div>
            ) : (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                {community.map((s) => (
                  <div key={s.owner + s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "8px 10px", background: "#0a0e0a", border: "1px solid #1e2d1e", borderRadius: 3 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 12, fontWeight: 600 }}>
                        {s.name} <span style={{ color: "#4a9fff", fontSize: 9 }}>{s.style}</span>
                      </div>
                      <div style={{ color: "#5a7a6a", fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>
                        by {s.owner.slice(0, 6)}…{s.owner.slice(-4)} · {s.config.signalMode} · {s.config.leverage}x
                        {s.author && s.author.trades > 0
                          ? <span style={{ color: s.author.netPnl >= 0 ? "#00ff88" : "#ff4444" }}>{`  ·  graded ${s.author.winRate}% win, ${s.author.netPnl >= 0 ? "+" : ""}$${s.author.netPnl} (${s.author.trades}t)`}</span>
                          : <span style={{ color: "#4a7a5a" }}>  ·  author unproven</span>}
                        {s.backtest ? <span style={{ color: "#4a7a5a" }}>{`  ·  bt ${s.backtest.netUsd >= 0 ? "+" : ""}$${s.backtest.netUsd}*`}</span> : ""}
                      </div>
                    </div>
                    <button onClick={() => copyStrategy(s)} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 14px", flexShrink: 0 }}>COPY</button>
                  </div>
                ))}
                <div style={{ color: "#3a5a4a", fontFamily: "monospace", fontSize: 9, marginTop: 4 }}>*bt = backtest hypothesis; ranking uses the author's real graded record.</div>
              </div>
            )}
          </div>

          {!isActive && (
            <div style={{ marginTop: 16, padding: "8px 10px", borderRadius: 3, background: "#0a0e0a", border: "1px solid #1e2d1e" }}>
              <span style={{ fontFamily: "monospace", fontSize: 10, color: "#4a7a5a", lineHeight: 1.6 }}>
                {config.mode === "PAPER"
                  ? <>🧪 Paper mode is fully simulated — <strong style={{ color: "#8aaa9a" }}>no key stored, no orders placed, no funds at risk</strong>. Activate to start building a paper track record against live prices.</>
                  : <>🔒 By activating, your order-only Orderly key is stored encrypted to let the agent trade on your behalf. It <strong style={{ color: "#8aaa9a" }}>cannot withdraw or transfer funds</strong>. Trading is risky — only deploy capital you can afford to lose. Deactivate anytime.</>}
              </span>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            {!isActive ? (
              <>
                <button onClick={activateAgent} disabled={saving || config.symbols.length === 0} style={{
                  ...agentBtnStyle(true),
                  opacity: saving || config.symbols.length === 0 ? 0.5 : 1,
                  flex: 1,
                }}>
                  {saving ? "ACTIVATING..." : "▶ ACTIVATE AGENT"}
                </button>
                <button onClick={saveConfig} disabled={saving} style={{ ...agentBtnStyle(false), flex: 0 }}>
                  SAVE CONFIG
                </button>
              </>
            ) : (
              <>
                <button onClick={saveConfig} disabled={saving} style={{ ...agentBtnStyle(true), flex: 1 }}>
                  {saving ? "SAVING..." : "UPDATE CONFIG"}
                </button>
                <button onClick={deactivateAgent} disabled={saving} style={{
                  ...agentBtnStyle(false),
                  borderColor: "#ff4444",
                  color: "#ff4444",
                }}>
                  ■ DEACTIVATE
                </button>
                <button onClick={killSwitch} disabled={saving} style={{
                  background: "#ff000020",
                  border: "1px solid #ff0000",
                  borderRadius: 4,
                  color: "#ff0000",
                  fontFamily: "monospace",
                  fontSize: 11,
                  padding: "8px 16px",
                  cursor: "pointer",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                }}>
                  ⚡ KILL
                </button>
              </>
            )}
          </div>

          {!tradingKey && config.mode !== "PAPER" && (
            <div style={{ marginTop: 12, padding: 10, background: "#1a1a0a", border: "1px solid #ff880030", borderRadius: 3 }}>
              <span style={{ color: "#ff8800", fontFamily: "monospace", fontSize: 11 }}>
                ⚠ No Orderly trading key detected. Place at least one manual trade on Nexus first — the SDK generates your trading key on first trade. This key allows order placement only and cannot withdraw funds. <strong style={{ color: "#4a9fff" }}>Or try 🧪 PAPER mode — no key needed.</strong>
              </span>
            </div>
          )}
        </div>
      )}

      {/* ─── STATUS TAB ──────────────────────────────────── */}
      {tab === "status" && (
        <div>
          {/* DEV-only: force a paper signal so the open→close loop can be tested
              in minutes instead of waiting for real funding/OI confluence. */}
          {(import.meta as any).env?.DEV && isActive && config.mode === "PAPER" && (
            <div style={{ ...agentCardStyle, borderColor: "#1a3a5a", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontFamily: "monospace", fontSize: 10, color: "#4a9fff" }}>
                ⚡ DEV — inject a synthetic PAPER signal (refused outside paper mode)
              </span>
              <button onClick={forceTestSignal} disabled={saving} style={{ ...navBtnStyle, fontSize: 10, padding: "6px 14px", color: "#4a9fff", borderColor: "#1a3a5a", opacity: saving ? 0.5 : 1 }}>
                FORCE TEST SIGNAL
              </button>
            </div>
          )}
          {/* Pending theses — ASSISTED mode review queue */}
          {pending.length > 0 && (
            <div style={{ ...agentCardStyle, borderColor: "#fbbf2440" }}>
              <div style={{ ...agentLabelStyle, color: "#fbbf24" }}>// THESES AWAITING REVIEW ({pending.length})</div>
              {pending.map((t) => (
                <div key={t.id} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 12, padding: "10px 0", borderBottom: "1px solid #1e2d1e",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                    <span style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>
                      {t.symbol.replace("PERP_", "").replace("_USDC", "")}
                    </span>
                    <span style={{ color: t.direction === "LONG" ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>
                      {t.direction}
                    </span>
                    <span style={{ color: "#8aaa9a", fontFamily: "monospace", fontSize: 11 }}>
                      @ ${t.entryPrice?.toLocaleString()}
                    </span>
                    <span style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 11 }}>
                      conf {t.confidence}% · funding {(t.funding * 100).toFixed(4)}%
                    </span>
                    <span style={{ color: "#3a5a4a", fontFamily: "monospace", fontSize: 10 }}>
                      {formatAgentTime(Date.now() - t.generatedAt)} ago
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => resolvePending(t.id, "deploy")} style={{
                      background: "#00ff8820", border: "1px solid #00ff88", borderRadius: 3,
                      color: "#00ff88", fontFamily: "monospace", fontSize: 10, padding: "5px 12px",
                      cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase",
                    }}>
                      ✓ Reviewed
                    </button>
                    <button onClick={() => resolvePending(t.id, "dismiss")} style={{
                      background: "none", border: "1px solid #ff444450", borderRadius: 3,
                      color: "#ff4444", fontFamily: "monospace", fontSize: 10, padding: "5px 12px",
                      cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase",
                    }}>
                      ✕ Dismiss
                    </button>
                  </div>
                </div>
              ))}
              <div style={{ color: "#3a5a4a", fontFamily: "monospace", fontSize: 10, marginTop: 8 }}>
                ASSISTED mode generates these for manual review — the agent does not execute them. Place the trade yourself if you agree, then mark Reviewed.
              </div>
            </div>
          )}

          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// AGENT STATUS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12, marginTop: 8 }}>
              <div>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>STATE</div>
                <div style={{ color: isActive ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontSize: 16, fontWeight: 600 }}>
                  {isActive ? (hasPosition ? "TRADING" : "WATCHING") : "INACTIVE"}
                </div>
              </div>
              <div>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>MODE</div>
                <div style={{ color: config.mode === "AUTONOMOUS" ? "#ff8800" : config.mode === "PAPER" ? "#4a9fff" : "#00ff88", fontFamily: "monospace", fontSize: 16, fontWeight: 600 }}>
                  {config.mode === "PAPER" ? "🧪 PAPER" : config.mode}
                </div>
              </div>
              <div>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>TRADES TODAY</div>
                <div style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 16, fontWeight: 600 }}>
                  {agentState?.trades_today ?? 0} / {config.maxTradesPerDay}
                </div>
              </div>
              <div>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>DAILY P&L</div>
                <div style={{ color: (agentState?.daily_pnl ?? 0) >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontSize: 16, fontWeight: 600 }}>
                  ${(agentState?.daily_pnl ?? 0).toFixed(2)}
                </div>
              </div>
              <div>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>STRATEGY</div>
                <div style={{ color: "#4a9fff", fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>
                  {deriveStyle(config)} · {config.signalMode}{config.dcaEnabled ? " · DCA" : ""}
                </div>
              </div>
            </div>
          </div>

          {/* ── LEADERBOARD STANDING — why this agent is / isn't on TOP AGENTS ── */}
          {standing && standing.stats && standing.stats.trades > 0 && (
            <div style={{ ...agentCardStyle, borderColor: standing.eligible ? "#1a3a2a" : "#2a2a1a" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div style={{ ...agentLabelStyle, color: standing.eligible ? "#00ff88" : "#fbbf24" }}>
                  ◆ LEADERBOARD STANDING
                </div>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: standing.eligible ? "#00ff88" : "#fbbf24" }}>
                  {standing.eligible ? "✓ RANKED ON TOP AGENTS" : `${standing.metCount} of ${standing.total} criteria met`}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 12 }}>
                {standing.criteria.map((c) => (
                  <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: c.met ? "#00ff88" : "#ff6644", fontFamily: "monospace", fontSize: 13 }}>
                      {c.met ? "✓" : "✗"}
                    </span>
                    <div>
                      <div style={{ color: c.met ? "#c0c0c0" : "#9a9a8a", fontFamily: "monospace", fontSize: 11 }}>{c.label}</div>
                      <div style={{ color: "#5a7a6a", fontFamily: "monospace", fontSize: 10 }}>
                        {c.key === "profitable"
                          ? `now: ${c.value >= 0 ? "+" : ""}$${c.value.toFixed(2)}`
                          : `${c.value} / ${c.target}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ color: "#3a5a4a", fontFamily: "monospace", fontSize: 10, marginTop: 10, lineHeight: 1.5 }}>
                {standing.eligible
                  ? `Ranked — score ${standing.stats.score}/100 · ${standing.stats.winRate}% win · PF ${standing.stats.profitFactor} over ${standing.stats.trades} graded trades.`
                  : standing.criteria.find((c) => c.key === "profitable" && !c.met)
                    ? `Your agent is recording fine (${standing.stats.trades} trades, ${standing.stats.winRate}% win) — TOP AGENTS only ranks net-positive agents, so it appears automatically once P&L turns green. Not a bug.`
                    : `Recording fine — keep trading to meet the remaining criteria; ranking is automatic once all three are met.`}
              </div>
            </div>
          )}

          {/* ── GUARDRAILS (always visible while live) ── */}
          {(() => {
            const dailyLoss = Math.max(0, -(agentState?.daily_pnl ?? 0));
            const lossPct = Math.min(100, (dailyLoss / (config.maxDailyLossUsdc || 1)) * 100);
            const tradesPct = Math.min(100, ((agentState?.trades_today ?? 0) / (config.maxTradesPerDay || 1)) * 100);
            const barColor = (pct: number) => pct >= 90 ? "#ff4444" : pct >= 60 ? "#fbbf24" : "#00ff88";
            return (
              <div style={{ ...agentCardStyle, borderColor: lossPct >= 90 ? "#ff444460" : "#1a3a2a" }}>
                <div style={{ ...agentLabelStyle, color: "#00ff88" }}>🛡 ACTIVE GUARDRAILS</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 10 }}>
                  {/* Daily loss limit */}
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ ...agentLabelStyle, fontSize: 9 }}>DAILY LOSS LIMIT</span>
                      <span style={{ fontFamily: "monospace", fontSize: 10, color: barColor(lossPct) }}>${dailyLoss.toFixed(2)} / ${config.maxDailyLossUsdc}</span>
                    </div>
                    <div style={{ height: 6, background: "#0a0e0a", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${lossPct}%`, background: barColor(lossPct), transition: "width 0.3s" }} />
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a", marginTop: 4 }}>auto-halts trading at limit</div>
                  </div>
                  {/* Trades today */}
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ ...agentLabelStyle, fontSize: 9 }}>TRADES TODAY</span>
                      <span style={{ fontFamily: "monospace", fontSize: 10, color: barColor(tradesPct) }}>{agentState?.trades_today ?? 0} / {config.maxTradesPerDay}</span>
                    </div>
                    <div style={{ height: 6, background: "#0a0e0a", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${tradesPct}%`, background: barColor(tradesPct), transition: "width 0.3s" }} />
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a", marginTop: 4 }}>stops opening new trades at cap</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginTop: 14, paddingTop: 12, borderTop: "1px solid #1a2e1a" }}>
                  {[
                    { label: "MAX LEVERAGE", value: `${config.leverage}x` },
                    { label: "STOP / TRADE", value: `${config.slPercent}%` },
                    { label: "MAX HOLD", value: `${config.maxHoldHours}h` },
                    { label: "MAX RISK / TRADE", value: `$${(config.capitalPerTrade * (config.slPercent / 100) * config.leverage).toFixed(2)}` },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                      <div style={{ color: "#8aaa9a", fontFamily: "monospace", fontSize: 14, fontWeight: 600 }}>{value}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, fontFamily: "monospace", fontSize: 10, color: "#4a7a5a", lineHeight: 1.5 }}>
                  🔒 Order-only key — the agent <strong style={{ color: "#8aaa9a" }}>cannot withdraw or transfer funds</strong>. Hit ⚡ KILL on the config tab to flatten and stop instantly.
                </div>
              </div>
            );
          })()}

          {hasPosition && agentState?.current_position && (
            <div style={{ ...agentCardStyle, borderColor: agentState.current_position.direction === "LONG" ? "#00ff8840" : "#ff444440" }}>
              <div style={{ ...agentLabelStyle, display: "flex", alignItems: "center", gap: 8 }}>
                // CURRENT POSITION
                {agentState.current_position.paper && (
                  <span style={{ color: "#4a9fff", border: "1px solid #4a9fff40", borderRadius: 3, padding: "1px 6px", fontSize: 8 }}>🧪 PAPER</span>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 12, marginTop: 8 }}>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>SYMBOL</div>
                  <div style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 14, fontWeight: 600 }}>
                    {agentState.current_position.symbol.replace("PERP_", "").replace("_USDC", "")}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>DIRECTION</div>
                  <div style={{ color: agentState.current_position.direction === "LONG" ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontSize: 14, fontWeight: 600 }}>
                    {agentState.current_position.direction}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>ENTRY</div>
                  <div style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 14 }}>
                    ${agentState.current_position.entry_price.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>CURRENT</div>
                  <div style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 14 }}>
                    ${agentState.current_position.current_price.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>P&L</div>
                  <div style={{ color: agentState.current_position.pnl_percent >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontSize: 14, fontWeight: 600 }}>
                    {agentState.current_position.pnl_percent >= 0 ? "+" : ""}{agentState.current_position.pnl_percent.toFixed(3)}%
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 8, color: "#4a7a5a", fontFamily: "monospace", fontSize: 10 }}>
                HELD FOR: {formatAgentTime(Date.now() - agentState.current_position.opened_at)} / {config.maxHoldHours}h max
              </div>
            </div>
          )}

          {isActive && !hasPosition && (
            <div style={{ ...agentCardStyle, textAlign: "center", padding: 24 }}>
              <div style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 12 }}>
                // SCANNING FOR SIGNALS ON {config.symbols.map(s => s.replace("PERP_", "").replace("_USDC", "")).join(", ")}
              </div>
              <div style={{ color: "#2a4a2a", fontFamily: "monospace", fontSize: 10, marginTop: 6 }}>
                Funding threshold: {config.fundingThreshold}% · Checking every 5 minutes
              </div>
            </div>
          )}

          {agentState?.last_signal && agentState.last_signal.symbol && (
            <div style={agentCardStyle}>
              <div style={agentLabelStyle}>// LAST SIGNAL</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12, marginTop: 8 }}>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>SYMBOL</div>
                  <div style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 13 }}>
                    {(agentState.last_signal.symbol || "").replace("PERP_", "").replace("_USDC", "")}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>DIRECTION</div>
                  <div style={{ color: agentState.last_signal.direction === "LONG" ? "#00ff88" : agentState.last_signal.direction === "SHORT" ? "#ff4444" : "#4a7a5a", fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>
                    {agentState.last_signal.direction}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>FUNDING</div>
                  <div style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 13 }}>
                    {(agentState.last_signal.funding * 100).toFixed(4)}%
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>AGE</div>
                  <div style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 13 }}>
                    {formatAgentTime(Date.now() - agentState.last_signal.timestamp)}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// WATCHING</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {config.symbols.map((sym) => (
                <span key={sym} style={{
                  background: "#00ff8810", border: "1px solid #00ff8830", borderRadius: 3,
                  padding: "3px 8px", fontFamily: "monospace", fontSize: 10, color: "#00ff88",
                }}>
                  {sym.replace("PERP_", "").replace("_USDC", "")}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── HISTORY TAB ─────────────────────────────────── */}
      {tab === "history" && (() => {
        const isPaperHist = config.mode === "PAPER";
        const histTrades = isPaperHist ? (agentState?.paper_trades ?? []) : trades;
        return (
        <div>
          <div style={agentCardStyle}>
            <div style={{ ...agentLabelStyle, display: "flex", alignItems: "center", gap: 8 }}>
              // AGENT TRADE HISTORY
              {isPaperHist && <span style={{ color: "#4a9fff", border: "1px solid #4a9fff40", borderRadius: 3, padding: "1px 6px", fontSize: 8 }}>🧪 PAPER</span>}
            </div>
            {histTrades.length === 0 ? (
              <div style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 12, padding: 20, textAlign: "center" }}>
                {isPaperHist
                  ? "No paper trades yet. Activate in PAPER mode to start simulating."
                  : "No trades recorded yet. Agent will log trades here once active."}
              </div>
            ) : (
              <div style={{ marginTop: 8, overflowX: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 1fr 1fr 0.8fr 0.6fr", gap: 8, minWidth: 480, padding: "6px 0", borderBottom: "1px solid #1e2d1e" }}>
                  {["SYMBOL", "DIR", "ENTRY", "EXIT", "P&L", "REASON"].map((h) => (
                    <span key={h} style={{ ...agentLabelStyle, fontSize: 9, marginBottom: 0 }}>{h}</span>
                  ))}
                </div>
                {histTrades.map((trade, i) => (
                  <div key={trade.id || i} style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 1fr 1fr 0.8fr 0.6fr", gap: 8, minWidth: 480, padding: "8px 0", borderBottom: "1px solid #0d1117" }}>
                    <span style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 12 }}>
                      {trade.symbol.replace("PERP_", "").replace("_USDC", "")}
                    </span>
                    <span style={{ color: trade.direction === "LONG" ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontSize: 12 }}>
                      {trade.direction}
                    </span>
                    <span style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 12 }}>
                      ${trade.entry_price.toLocaleString()}
                    </span>
                    <span style={{ color: "#c0c0c0", fontFamily: "monospace", fontSize: 12 }}>
                      ${trade.exit_price.toLocaleString()}
                    </span>
                    <span style={{ color: trade.pnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontSize: 12, fontWeight: 600 }}>
                      {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
                    </span>
                    <span style={{ fontFamily: "monospace", fontSize: 10, color: trade.reason === "TP" ? "#00ff88" : trade.reason === "SL" ? "#ff4444" : trade.reason === "BE" ? "#4a9fff" : "#ff8800" }}>
                      {trade.reason}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {histTrades.length > 0 && (() => {
            const agentTotalPnl = histTrades.reduce((s, t) => s + t.pnl, 0);
            const agentWins = histTrades.filter((t) => t.pnl > 0).length;
            const agentWinRate = ((agentWins / histTrades.length) * 100).toFixed(1);
            const agentAvgWin = histTrades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / (agentWins || 1);
            const agentLosses = histTrades.filter((t) => t.pnl <= 0);
            const agentAvgLoss = agentLosses.reduce((s, t) => s + Math.abs(t.pnl), 0) / (agentLosses.length || 1);
            return (
              <div style={agentCardStyle}>
                <div style={{ ...agentLabelStyle, display: "flex", alignItems: "center", gap: 8 }}>
                  // AGENT PERFORMANCE
                  {isPaperHist && <span style={{ color: "#4a9fff", border: "1px solid #4a9fff40", borderRadius: 3, padding: "1px 6px", fontSize: 8 }}>🧪 PAPER</span>}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 12, marginTop: 8 }}>
                  {[
                    { label: "TOTAL P&L", value: `$${agentTotalPnl.toFixed(2)}`, color: agentTotalPnl >= 0 ? "#00ff88" : "#ff4444" },
                    { label: "WIN RATE", value: `${agentWinRate}%`, color: "#c0c0c0" },
                    { label: "TRADES", value: `${histTrades.length}`, color: "#c0c0c0" },
                    { label: "AVG WIN", value: `$${agentAvgWin.toFixed(2)}`, color: "#00ff88" },
                    { label: "AVG LOSS", value: `$${agentAvgLoss.toFixed(2)}`, color: "#ff4444" },
                  ].map(({ label, value, color }) => (
                    <div key={label}>
                      <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                      <div style={{ color, fontFamily: "monospace", fontSize: 16, fontWeight: 600 }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
        );
      })()}

      {/* ─── TOP AGENTS (public leaderboard) ─────────────── */}
      {tab === "leaderboard" && (
        <div>
          <div style={{ ...agentCardStyle, borderColor: "#1a3a2a" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={agentLabelStyle}>// TOP AUTONOMOUS AGENTS</div>
              <button onClick={loadLeaderboard} disabled={lbLoading} style={{ ...navBtnStyle, fontSize: 9, padding: "3px 10px", color: "#4a7a5a" }}>
                {lbLoading ? "…" : "↻ REFRESH"}
              </button>
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#3a5a4a", marginTop: 6, lineHeight: 1.5 }}>
              Ranked by risk-adjusted score (win rate + profit factor, weighted by sample size) over <strong style={{ color: "#8aaa9a" }}>≥10 live trades spanning ≥3 days</strong>. Paper excluded. Copy any strategy to test it in PAPER first.
            </div>
            {ledgerInfo && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #1a2e1a", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "monospace", fontSize: 9, color: "#00ff88" }}>🔗 LEDGER SHA-256</span>
                <code style={{ fontFamily: "monospace", fontSize: 9, color: "#8aaa9a", background: "#0a0e0a", border: "1px solid #1a2e1a", borderRadius: 3, padding: "2px 6px" }}>
                  {ledgerInfo.hash.slice(0, 10)}…{ledgerInfo.hash.slice(-8)}
                </code>
                <span style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a" }}>· {ledgerInfo.count} records ·</span>
                <a href={`${AGENT_API}/agents/ledger`} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "monospace", fontSize: 9, color: "#4a9fff", textDecoration: "none" }}>
                  verify ↗
                </a>
                {ledgerInfo.onChain?.verified && (
                  <a href={ledgerInfo.onChain.explorer || "#"} target="_blank" rel="noopener noreferrer"
                    style={{ fontFamily: "monospace", fontSize: 9, color: "#00ff88", textDecoration: "none", border: "1px solid #1a4a2a", borderRadius: 3, padding: "2px 6px", background: "#0a1a0e" }}>
                    ⛓ ANCHORED ON-CHAIN ↗
                  </a>
                )}
              </div>
            )}
          </div>

          {lbLoading && (!leaderboard || leaderboard.length === 0) ? (
            <div style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 12, padding: 24, textAlign: "center" }}>loading leaderboard…</div>
          ) : !leaderboard || leaderboard.length === 0 ? (
            <div style={{ ...agentCardStyle, textAlign: "center", padding: 28 }}>
              <div style={{ fontSize: 22, color: "#00ff88", marginBottom: 8 }}>◆</div>
              <div style={{ color: "#fff", fontFamily: "monospace", fontSize: 13, fontWeight: "bold", marginBottom: 6 }}>No ranked agents yet</div>
              <div style={{ color: "#4a7a5a", fontFamily: "monospace", fontSize: 11, lineHeight: 1.6 }}>
                Agents qualify after 10 live trades over 3+ days. Run yours live and claim rank #1 — your strategy becomes copyable by everyone.
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowX: "auto" }}>
              {leaderboard.map((e) => {
                const isMe = e.wallet.toLowerCase() === (walletAddress ?? "").toLowerCase();
                const who = e.displayName || `${e.wallet.slice(0, 6)}…${e.wallet.slice(-4)}`;
                const medal = e.rank === 1 ? "#ffd700" : e.rank === 2 ? "#c0c0c0" : e.rank === 3 ? "#cd7f32" : "#3a5a4a";
                return (
                  <div key={e.wallet} style={{ ...agentCardStyle, borderColor: isMe ? "#00ff88" : "#1a3a2a", display: "grid", gridTemplateColumns: "34px 1fr repeat(4, auto) 110px", gap: 12, minWidth: 520, alignItems: "center" }}>
                    <div style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: medal, textAlign: "center" }}>{e.rank}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      {e.pfp
                        ? <img src={e.pfp} alt="" style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                        : <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#0a1a0e", border: "1px solid #1a3a2a", flexShrink: 0 }} />}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: "monospace", fontSize: 12, color: "#fff", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {who}{isMe && <span style={{ color: "#00ff88", fontSize: 9 }}> (you)</span>}
                        </div>
                        <div style={{ display: "flex", gap: 3, marginTop: 2, flexWrap: "wrap" }}>
                          {(e.config?.symbols ?? []).slice(0, 4).map((s) => (
                            <span key={s} style={{ fontSize: 8, color: "#4a9fff", fontFamily: "monospace", background: "#0a1a2a", border: "1px solid #0a2a3a", borderRadius: 2, padding: "1px 4px" }}>
                              {s.replace("PERP_", "").replace("_USDC", "")}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    {[
                      { label: "SCORE", val: e.score.toFixed(1), color: "#00ff88" },
                      { label: "NET P&L", val: `+$${e.netPnl.toFixed(0)}`, color: "#00ff88" },
                      { label: "WIN", val: `${e.winRate.toFixed(0)}%`, color: e.winRate >= 50 ? "#00ff88" : "#ff8800" },
                      { label: "PF", val: e.profitFactor.toFixed(2), color: "#c0c0c0" },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ textAlign: "right" }}>
                        <div style={{ ...agentLabelStyle, fontSize: 8 }}>{label}</div>
                        <div style={{ color, fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>{val}</div>
                        {label === "SCORE" && <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>{e.trades}t · {e.daysActive}d</div>}
                      </div>
                    ))}
                    <button
                      onClick={() => copyAgentConfig(e)}
                      disabled={!e.config || isMe}
                      style={{
                        background: e.config && !isMe ? "#00ff8815" : "#0a0e0a",
                        border: `1px solid ${e.config && !isMe ? "#00ff88" : "#1e2d1e"}`,
                        borderRadius: 4, color: e.config && !isMe ? "#00ff88" : "#3a5a4a",
                        fontFamily: "monospace", fontSize: 10, padding: "7px 10px",
                        cursor: e.config && !isMe ? "pointer" : "default", letterSpacing: "0.03em",
                      }}
                    >
                      {isMe ? "YOUR AGENT" : "COPY CONFIG"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
