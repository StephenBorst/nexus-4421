// The Trading Agent tab: config / status / history / leaderboard, the agent
// track-record panels, and the Orderly delegated-key readers.
// Extracted from index.tsx (god-file split).
import { useState, useEffect } from "react";
import type { AgentConfig, AgentState, AgentTrade, AgentLeaderboardEntry, AgentPendingThesis } from "./types";
import { DEFAULT_CONFIG } from "./types";
import { agentCardStyle, agentLabelStyle, agentInputStyle, agentBtnStyle, navBtnStyle } from "./styles";

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
        if (data.state) setAgentState(data.state);
        if (data.trades) setTrades(data.trades);
        if (data.pending) setPending(data.pending);
      }
    } catch (e) {
      console.error("[agent] fetch error:", e);
    } finally {
      setLoading(false);
    }
  }

  async function activateAgent() {
    if (!walletAddress) { setError("Connect wallet first"); return; }
    // PAPER mode never places real orders, so it doesn't need a trading key.
    if (config.mode !== "PAPER" && !tradingKey) { setError("No Orderly trading key found — place at least one trade first to generate it"); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config,
          tradingKey,
          accountId: getOrderlyKeyStore()?.accountId || "",
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

  async function deactivateAgent() {
    if (!walletAddress) return;
    setSaving(true);
    try {
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}`, { method: "DELETE" });
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
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
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
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/paper/reset`, { method: "POST" });
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
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/test-signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "LONG" }),
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
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/kill`, { method: "POST" });
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
      await fetch(`${AGENT_API}/agent/${walletAddress}/pending/${id}/${action}`, { method: "POST" });
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
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
        <div style={{ display: "flex", gap: 8 }}>
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
                return (
                  <button key={v} title={hint} onClick={() => setConfig({ ...config, signalMode: v })} style={{
                    background: sel ? "#00ff8815" : "#0a0e0a",
                    border: `1px solid ${sel ? "#00ff8860" : "#1e2d1e"}`,
                    borderRadius: 3, padding: "4px 10px", cursor: "pointer",
                    color: sel ? "#00ff88" : "#4a7a5a",
                    fontFamily: "monospace", fontSize: 11,
                  }}>{label}</button>
                );
              })}
            </div>
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
                { key: "maxHoldHours", label: "MAX HOLD TIME", suffix: "hrs", min: 1, max: 48, step: 1 },
                { key: "maxTradesPerDay", label: "MAX TRADES / DAY", suffix: "", min: 1, max: 50, step: 1 },
                { key: "maxDailyLossUsdc", label: "MAX DAILY LOSS", suffix: "USDC", min: 1, max: 500, step: 1 },
                { key: "fundingThreshold", label: "FUNDING THRESHOLD", suffix: "%", min: 0.001, max: 0.1, step: 0.001 },
                { key: "oiChangeThreshold", label: "OI MOVE THRESHOLD", suffix: "%", min: 0, max: 10, step: 0.05 },
                { key: "priceChangeThreshold", label: "PRICE MOVE THRESHOLD", suffix: "%", min: 0.1, max: 10, step: 0.1 },
              ].map(({ key, label, suffix, min, max, step }) => (
                <div key={key}>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <NumberField
                      value={(config as any)[key]}
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
            </div>
          </div>

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
                    <span style={{ fontFamily: "monospace", fontSize: 10, color: trade.reason === "TP" ? "#00ff88" : trade.reason === "SL" ? "#ff4444" : "#ff8800" }}>
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
