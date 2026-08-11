// The Trading Agent tab: config / status / history / leaderboard, the agent
// track-record panels, and the Orderly delegated-key readers.
// Extracted from index.tsx (god-file split).
import { useState, useEffect, useRef } from "react";
import type { AgentConfig, AgentState, AgentTrade, AgentLeaderboardEntry, AgentPendingThesis } from "./types";
import { DEFAULT_CONFIG } from "./types";
import { agentCardStyle, agentLabelStyle, agentInputStyle, agentBtnStyle, btnPrimary, navBtnStyle } from "./styles";
import { useSubscription } from "@/hooks/useSubscription";
import { isProStrategy } from "@/config/subscription";
import { STRATEGY_PRESETS } from "@/config/strategyPresets";
import { STYLE_PRESETS, deriveStyle, type TradingStyle } from "@/config/agentStyles";
import { AGENT_PREFILL_KEY, DIRECTIVE_PREFILL_KEY, type AgentPrefill, type DirectiveDraft } from "@/utils/agentPrefill";
import { PnlChart, CountUp, TableSkeleton, Coachmark } from "./components";
import { SharePoster, type PosterData } from "./SharePoster";


// ── Extracted modules (god-file split) ──────────────────────────────────────
// Constants/local types, leaf components, and the Orderly key + ownership-proof
// readers now live beside this file. Behavior is unchanged — the move was purely
// mechanical, which matters because this is the agent MONEY PATH.
import { AGENT_API, TG_BOT, AVAILABLE_SYMBOLS, type ActiveDirective, type AgentStanding } from "./agentTypes";
import { NumberField, AgentTrackRecord, AgentToggleCard } from "./AgentPanels";
import { AgentBacktestCard } from "./AgentBacktestCard";
import { AgentStrategyLibrary } from "./AgentStrategyLibrary";
import { getOrderlyKeyStore, findOrderlyTradingKey, getWalletAddress, getAgentSig, formatAgentTime } from "./agentKeys";

export function AgentView() {
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_CONFIG);
  // The config editor is a working copy: load the server config ONCE, then it's the
  // user's to edit. Without this, the 10s status poll re-set config on every tick and
  // silently reverted unsaved edits (worse on mobile, where editing is slower). Saving
  // updates local + server together, so we never need to re-pull it mid-session.
  const serverConfigLoadedRef = useRef(false);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [trades, setTrades] = useState<AgentTrade[]>([]);
  const [pending, setPending] = useState<AgentPendingThesis[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Persistent (until dismissed) expectation banner, set when a prefill arrives from
  // a source whose semantics differ from the agent's (e.g. a directional thesis).
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);
  // Directional directive ("▶ TRADE managed"): a draft awaiting review/arm, and/or
  // the currently armed/live directive read from the server.
  const [activeDirective, setActiveDirective] = useState<ActiveDirective | null>(null);
  const [directiveDraft, setDirectiveDraft] = useState<DirectiveDraft | null>(null);
  const [directiveMode, setDirectiveMode] = useState<"PAPER" | "AUTONOMOUS">("PAPER");
  const [directiveEntry, setDirectiveEntry] = useState<"MARKET" | "LIMIT">("MARKET");
  const [directiveLimitPrice, setDirectiveLimitPrice] = useState("");
  const [directiveBusy, setDirectiveBusy] = useState(false);
  const [tgLinked, setTgLinked] = useState(false);
  const [tgCopied, setTgCopied] = useState(false);
  // History: which trade row is expanded (progressive-disclosure detail panel).
  const [expandedTrade, setExpandedTrade] = useState<string | null>(null);
  // Share poster (in-app branded card) — set to open the modal for a trade.
  const [posterData, setPosterData] = useState<PosterData | null>(null);
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
  const [validation, setValidation] = useState<any | null>(null);
  const [validating, setValidating] = useState(false);
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

  // Consume a directive draft handed over from a thesis (▶ TRADE managed). Read once
  // on mount + when returning to the tab, then cleared so it doesn't re-apply.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DIRECTIVE_PREFILL_KEY);
      if (raw) {
        window.localStorage.removeItem(DIRECTIVE_PREFILL_KEY);
        const p = JSON.parse(raw);
        if (p?.draft?.symbol) {
          setDirectiveDraft(p.draft);
          setDirectiveMode("PAPER"); // default risk-free; user opts into GO LIVE
          setDirectiveEntry("MARKET"); // default fill-now; user can switch to a resting limit
          setDirectiveLimitPrice(p.draft.entryPrice ? String(p.draft.entryPrice) : "");
          setTab("status");
        }
      }
    } catch { /* ignore malformed draft */ }
  }, []);

  async function armDirective() {
    if (!walletAddress || !directiveDraft) return;
    setDirectiveBusy(true); setError(null);
    try {
      const walletSig = await getAgentSig(walletAddress);
      // Fold the entry-type choice into the directive: MARKET fills now; LIMIT waits
      // for the given trigger price (defaults to the thesis entry).
      const dir: DirectiveDraft = { ...directiveDraft, entryType: directiveEntry };
      if (directiveEntry === "LIMIT") dir.entryPrice = parseFloat(directiveLimitPrice) || directiveDraft.entryPrice;
      const payload: Record<string, unknown> = { directive: dir, mode: directiveMode, walletSig };
      if (directiveMode === "AUTONOMOUS") payload.confirm = "GO LIVE";
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/directive`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.hint || data.error || "Could not arm directive"); return; }
      setActiveDirective(data.directive || null);
      setDirectiveDraft(null);
      setSuccess(directiveMode === "AUTONOMOUS"
        ? "Directive armed — LIVE market order fires within ~1 min, then managed to your levels."
        : "Directive armed in PAPER — simulated fill within ~1 min.");
      setTimeout(() => setSuccess(null), 6000);
      fetchAgentData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Signing/submit failed");
    } finally { setDirectiveBusy(false); }
  }

  async function cancelDirective() {
    if (!walletAddress) return;
    setDirectiveBusy(true); setError(null);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/directive`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletSig }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.hint || data.error || "Could not cancel directive"); return; }
      setActiveDirective(null);
      setSuccess("Directive cancelled."); setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    } finally { setDirectiveBusy(false); }
  }


  async function fetchAgentData() {
    if (!walletAddress) return;
    try {
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}`);
      if (res.ok) {
        const data = await res.json();
        // Load config from the server only on the FIRST fetch — after that the editor
        // is the user's working copy (the poll must not clobber unsaved edits).
        if (data.config && !serverConfigLoadedRef.current) {
          setConfig(data.config);
          serverConfigLoadedRef.current = true;
        }
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
              // Persistent expectation (e.g. thesis → signal-bot direction mismatch).
              if (p.notice) setPrefillNotice(p.notice);
            }
          }
        } catch { /* ignore */ }
        if (data.state) setAgentState(data.state);
        if (data.trades) setTrades(data.trades);
        if (data.pending) setPending(data.pending);
        setActiveDirective(data.directive || null);
        setTgLinked(!!data.tgLinked);
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
  // Walk-forward VALIDATE — the honest layer. Replays the config across a diverse
  // symbol universe AND multiple time folds and returns ROBUST / FRAGILE / NOT_ROBUST.
  // "Verify, don't trust" applied to your own strategy: an edge that only works on one
  // symbol in one window fails here by design.
  async function runValidation() {
    if (!walletAddress) { setError("Connect wallet first"); return; }
    setValidating(true); setError(null); setValidation(null);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/validate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config, walletSig }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.hint || data.error || "Validation failed");
      setValidation(data);
    } catch (e: any) { setError(e.message); } finally { setValidating(false); }
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

  // ⚡ AUTOCOPY — follow/unfollow a leader agent. Trustless copy-trading: adds their
  // wallet to config.autocopy.leaders and persists via the owner-authed config path.
  // Your OWN agent then mirrors their trades at your mode/size/guardrails (exec side).
  async function toggleAutocopy(leaderWallet: string) {
    if (!walletAddress) { setError("Connect wallet first"); return; }
    const lw = leaderWallet.toLowerCase();
    const cur = (config.autocopy?.leaders || []).map((w) => w.toLowerCase());
    const following = cur.includes(lw);
    const nextLeaders = following ? cur.filter((w) => w !== lw) : [...cur, lw];
    const nextConfig = { ...config, autocopy: { enabled: nextLeaders.length > 0, leaders: nextLeaders } };
    setConfig(nextConfig);
    setSaving(true);
    try {
      const walletSig = await getAgentSig(walletAddress);
      const res = await fetch(`${AGENT_API}/agent/${walletAddress}/config`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: nextConfig, walletSig }),
      });
      if (!res.ok) throw new Error("Failed to update autocopy");
      setSuccess(following
        ? "Stopped autocopying"
        : agentState?.active ? "Autocopying — your agent will mirror their trades" : "Autocopy set — activate your agent to start mirroring");
      setTimeout(() => setSuccess(null), 3500);
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
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
        <div style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 13 }}>
          // CONNECT WALLET TO CONFIGURE AGENT
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={agentCardStyle}>
        <div style={{ ...agentLabelStyle, opacity: 0.7 }}>// LOADING AGENT STATE…</div>
        <TableSkeleton rows={5} />
      </div>
    );
  }

  const isActive = agentState?.active === true;
  const hasPosition = agentState?.current_position !== null && agentState?.current_position !== undefined;

  return (
    <div>
      {posterData && <SharePoster data={posterData} onClose={() => setPosterData(null)} />}
      {/* ─── Header ──────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, rowGap: 10, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ display: "inline-block" }}>
            <span style={{ display: "block", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 3 }}>Automate</span>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontFamily: "var(--nx-font-serif)", fontSize: 22, fontWeight: 700, color: "#f4f4f5", lineHeight: 1, letterSpacing: "-0.01em" }}>Autonomous Trading Agent</span>
              <span className={isActive ? "nx-pulse" : undefined} style={{
                fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "3px 10px", borderRadius: 3,
                background: isActive ? "#3ecf8e15" : "#f7525f15",
                border: `1px solid ${isActive ? "#3ecf8e40" : "#f7525f40"}`,
                color: isActive ? "#3ecf8e" : "#f7525f",
                textTransform: "uppercase", letterSpacing: "0.1em", whiteSpace: "nowrap",
              }}>
                {isActive ? (hasPosition ? "● TRADING" : "● WATCHING") : "○ INACTIVE"}
              </span>
            </span>
            <span style={{ display: "block", fontFamily: "var(--nx-font-ui)", fontSize: 11, color: "#71717a", marginTop: 6, lineHeight: 1.5, maxWidth: 520 }}>
              Runs <strong style={{ color: "#a1a1aa" }}>your</strong> strategy autonomously — every trade it makes is graded on-chain, no self-reporting. The edge is yours; the accountability is built in.
            </span>
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["config", "status", "history", "leaderboard"] as const).map((t) => (
            <button key={t} onClick={() => { setTab(t); if (t === "leaderboard" && !leaderboard) loadLeaderboard(); }} style={{
              background: tab === t ? "#1a1a1e" : "none",
              border: `1px solid ${tab === t ? "#ededf0" : "transparent"}`,
              color: tab === t ? "#ededf0" : "#71717a",
              fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "4px 10px",
              cursor: "pointer", letterSpacing: "0.05em", borderRadius: 3,
              textTransform: "uppercase",
            }}>
              {t === "leaderboard" ? "TOP AGENTS" : t}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ ...agentCardStyle, borderColor: "#f7525f", background: "#241012", marginBottom: 12 }}>
          <span style={{ color: "#f7525f", fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>⚠ {error}</span>
          <span onClick={() => setError(null)} style={{ float: "right", cursor: "pointer", color: "#f7525f" }}>✕</span>
        </div>
      )}
      {success && (
        <div style={{ ...agentCardStyle, borderColor: "#ededf0", background: "#1a1a1e", marginBottom: 12 }}>
          <span style={{ color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>✓ {success}</span>
        </div>
      )}
      {prefillNotice && (
        <div style={{ ...agentCardStyle, borderColor: "#fbbf24", background: "#2a1a00", marginBottom: 12, display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span style={{ color: "#fbbf24", fontFamily: "var(--nx-font-mono)", fontSize: 13, flexShrink: 0 }}>⚠</span>
          <span style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", fontSize: 12, lineHeight: 1.5, flex: 1 }}>{prefillNotice}</span>
          <span onClick={() => setPrefillNotice(null)} title="Dismiss" style={{ cursor: "pointer", color: "#fbbf24", flexShrink: 0 }}>✕</span>
        </div>
      )}

      {/* ── Telegram trade alerts — passive updates without opening the app ── */}
      {walletAddress && (
        <div style={{ ...agentCardStyle, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold", color: tgLinked ? "#ededf0" : "#a1a1aa", flexShrink: 0 }}>
              {tgLinked ? "✓ TELEGRAM LINKED" : "🔔 TELEGRAM ALERTS"}
            </span>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", lineHeight: 1.4, flex: 1, minWidth: 150 }}>
              {tgLinked
                ? "You get a DM whenever your agent opens or closes a trade."
                : "Get a DM whenever your agent opens or closes a trade — no need to watch the app."}
            </span>
            <a href={`https://t.me/${TG_BOT}?start=${walletAddress.toLowerCase()}`} target="_blank" rel="noopener noreferrer"
              style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, fontWeight: "bold", letterSpacing: "0.05em", textDecoration: "none",
                color: "#6cb6ff", border: "1px solid #33333a", background: "#0f0f11", borderRadius: 3, padding: "7px 14px", flexShrink: 0 }}>
              {tgLinked ? "MANAGE ↗" : "LINK TELEGRAM ↗"}
            </a>
          </div>
          {!tgLinked && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #1a1a1e", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", lineHeight: 1.4, flex: 1, minWidth: 150 }}>
                Link not opening Telegram? Some in-app browsers block it. Open <b style={{ color: "#a1a1aa" }}>@{TG_BOT}</b> in Telegram and send this:
              </span>
              <button
                onClick={() => {
                  const cmd = `/start ${walletAddress.toLowerCase()}`;
                  navigator.clipboard?.writeText(cmd).then(() => { setTgCopied(true); setTimeout(() => setTgCopied(false), 2000); }).catch(() => {});
                }}
                style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, fontWeight: "bold", color: tgCopied ? "#ededf0" : "#a1a1aa",
                  border: `1px solid ${tgCopied ? "#33333a" : "#232327"}`, background: "#0a0a0b", borderRadius: 3, padding: "6px 12px", cursor: "pointer", flexShrink: 0 }}>
                {tgCopied ? "COPIED ✓" : "COPY /start CMD"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── DIRECTIVE: review a draft from a thesis, then arm it ─────────── */}
      {directiveDraft && (() => {
        const tk = directiveDraft.symbol.replace("PERP_", "").replace("_USDC", "");
        const isLong = directiveDraft.direction === "LONG";
        const rr = Math.abs(directiveDraft.entryPrice - directiveDraft.stopLoss) > 0
          ? Math.abs(directiveDraft.takeProfit1 - directiveDraft.entryPrice) / Math.abs(directiveDraft.entryPrice - directiveDraft.stopLoss)
          : 0;
        const live = directiveMode === "AUTONOMOUS";
        const num = (n?: number) => (n && n > 0 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 4 : 2 })}` : "—");
        return (
          <div style={{ ...agentCardStyle, borderColor: "#ededf0", background: "#0f0f11", marginBottom: 12 }}>
            <div style={agentLabelStyle}>// ▶ TRADE THIS THESIS <span style={{ color: "#71717a" }}>— one-shot, managed by the agent</span></div>
            <div style={{ marginTop: 10 }}>
              <Coachmark storageKey="nexus_coach_arm_v1" badge="STEP 2 / 2" title="Arm in PAPER first">
                This hands the agent <strong style={{ color: "#d4d4d8" }}>this exact trade</strong> — your direction, your stops and targets — and it manages the exit for you (scale-out, trailing, breakeven, timeout). Start in <strong style={{ color: "#d4d4d8" }}>PAPER</strong> to watch it work risk-free, then flip to GO LIVE once you trust it. Every close is graded on-chain.
              </Coachmark>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12, marginTop: 10, marginBottom: 10, fontFamily: "var(--nx-font-mono)" }}>
              <span style={{ fontSize: 18, color: "#fff", fontWeight: "bold" }}>{tk}</span>
              <span style={{ fontSize: 13, color: isLong ? "#3ecf8e" : "#f7525f", fontWeight: "bold" }}>{isLong ? "↑ LONG" : "↓ SHORT"}</span>
              {directiveDraft.leverage ? <span style={{ fontSize: 12, color: "#a1a1aa" }}>{directiveDraft.leverage}x</span> : null}
              <span style={{ fontSize: 12, color: rr >= 2 ? "#ededf0" : "#fbbf24" }}>R:R 1:{rr.toFixed(2)}</span>
            </div>
            {/^0x[a-f0-9]{40}$/i.test(directiveDraft.source || "") && (
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", marginBottom: 10 }}>
                ◆ copied from {directiveDraft.source!.slice(0, 6)}…{directiveDraft.source!.slice(-4)} — this close grades back to their public copy record.
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: 8, marginBottom: 12 }}>
              {[
                { label: "ENTRY", val: num(directiveDraft.entryPrice), color: "#a1a1aa" },
                { label: "STOP", val: num(directiveDraft.stopLoss), color: "#f7525f" },
                { label: "TP1", val: num(directiveDraft.takeProfit1), color: "#ededf0" },
                ...(directiveDraft.takeProfit2 ? [{ label: "TP2", val: num(directiveDraft.takeProfit2), color: "#ededf0" }] : []),
              ].map(({ label, val, color }) => (
                <div key={label} style={{ background: "#0a0a0b", border: "1px solid #232327", borderRadius: 4, padding: "6px 10px" }}>
                  <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{label}</div>
                  <div style={{ fontSize: 13, color, fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{val}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#ededf0", fontFamily: "var(--nx-font-ui)", lineHeight: 1.5, marginBottom: 12 }}>
              The agent enters {isLong ? "LONG" : "SHORT"} {tk} and manages to your stop/targets (scale-out, trailing, breakeven, timeout). It stops after this one trade.
            </div>
            {/* Entry type: fill now (MARKET) vs wait for a price (LIMIT) */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.08em", marginBottom: 6 }}>ENTRY</div>
              <div style={{ display: "flex", gap: 6 }}>
                {(["MARKET", "LIMIT"] as const).map((et) => (
                  <button key={et} onClick={() => setDirectiveEntry(et)} style={{
                    flex: 1, padding: "7px 0", fontFamily: "var(--nx-font-mono)", fontSize: 10, cursor: "pointer", borderRadius: 3,
                    border: `1px solid ${directiveEntry === et ? "#ededf0" : "#232327"}`,
                    background: directiveEntry === et ? "#1a1a1e" : "#0f0f11",
                    color: directiveEntry === et ? "#ededf0" : "#52525b",
                  }}>{et === "MARKET" ? "MARKET (fill now)" : "LIMIT (wait for price)"}</button>
                ))}
              </div>
              {directiveEntry === "LIMIT" && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)", flexShrink: 0 }}>trigger&nbsp;$</span>
                    <input value={directiveLimitPrice} onChange={(e) => setDirectiveLimitPrice(e.target.value)} type="number"
                      style={{ flex: 1, minWidth: 0, background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3, color: "#fff", fontFamily: "var(--nx-font-mono)", fontSize: 13, padding: "7px 10px" }} />
                  </div>
                  <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginTop: 4, lineHeight: 1.4 }}>
                    Waits until {tk} reaches this price (±0.15%), then enters + manages. Won&apos;t chase if it gaps &gt;1% through.
                  </div>
                </div>
              )}
            </div>
            {/* Mode toggle */}
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {(["PAPER", "AUTONOMOUS"] as const).map((m) => (
                <button key={m} onClick={() => setDirectiveMode(m)} style={{
                  flex: 1, padding: "8px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11, cursor: "pointer", borderRadius: 3,
                  border: `1px solid ${directiveMode === m ? (m === "PAPER" ? "#d4d4d8" : "#fbbf24") : "#232327"}`,
                  background: directiveMode === m ? (m === "PAPER" ? "#1a1a1e" : "#2a1a00") : "#0f0f11",
                  color: directiveMode === m ? (m === "PAPER" ? "#d4d4d8" : "#fbbf24") : "#52525b",
                }}>{m === "PAPER" ? "PAPER (simulated)" : "AUTONOMOUS (real $)"}</button>
              ))}
            </div>
            {live && (
              <div style={{ fontSize: 10, color: "#fbbf24", fontFamily: "var(--nx-font-ui)", lineHeight: 1.5, marginBottom: 10 }}>
                ⚠ REAL FUNDS. This places a live market order on your next tick (~1 min) via your order-only key (cannot withdraw). Confirming = &quot;GO LIVE&quot;.
              </div>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setDirectiveDraft(null)} disabled={directiveBusy} style={{
                flex: 1, padding: "9px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11, cursor: "pointer", borderRadius: 3,
                border: "1px solid #232327", background: "#0a0a0b", color: "#52525b",
              }}>DISMISS</button>
              <button onClick={armDirective} disabled={directiveBusy} style={{
                flex: 2, padding: "9px 0", fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold", letterSpacing: "0.06em",
                cursor: directiveBusy ? "wait" : "pointer", borderRadius: 3,
                border: `1px solid ${live ? "#fbbf24" : "#33333a"}`, background: live ? "#2a1a00" : "#1a1a1e",
                color: live ? "#fbbf24" : "#ededf0",
              }}>{directiveBusy ? "ARMING…" : live ? "▶ ARM LIVE — GO LIVE" : "▶ ARM (PAPER)"}</button>
            </div>
          </div>
        );
      })()}

      {/* ── DIRECTIVE: currently armed / live ────────────────────────────── */}
      {!directiveDraft && activeDirective && (activeDirective.status === "ARMED" || activeDirective.status === "LIVE") && (() => {
        const tk = activeDirective.symbol.replace("PERP_", "").replace("_USDC", "");
        const isLong = activeDirective.direction === "LONG";
        const armed = activeDirective.status === "ARMED";
        const num = (n?: number) => (n && n > 0 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 4 : 2 })}` : "—");
        return (
          <div style={{ ...agentCardStyle, borderColor: armed ? "#d4d4d8" : "#ededf0", background: armed ? "#0f0f11" : "#0f0f11", marginBottom: 12 }}>
            <div style={agentLabelStyle}>
              // DIRECTIVE <span style={{ color: armed ? "#d4d4d8" : "#ededf0" }}>{armed ? "◷ ARMED" : "● LIVE"}</span>
              <span style={{ color: "#71717a" }}> — {armed
                ? (activeDirective.entryType === "LIMIT" ? `waiting for ${num(activeDirective.entryPrice)}` : "waiting to fill (next tick ~1 min)")
                : "position open, managed by the agent"}</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12, marginTop: 10, marginBottom: 10, fontFamily: "var(--nx-font-mono)" }}>
              <span style={{ fontSize: 16, color: "#fff", fontWeight: "bold" }}>{tk}</span>
              <span style={{ fontSize: 12, color: isLong ? "#3ecf8e" : "#f7525f", fontWeight: "bold" }}>{isLong ? "↑ LONG" : "↓ SHORT"}</span>
              {activeDirective.leverage ? <span style={{ fontSize: 11, color: "#a1a1aa" }}>{activeDirective.leverage}x</span> : null}
              {activeDirective.filledPrice ? <span style={{ fontSize: 11, color: "#ededf0" }}>filled {num(activeDirective.filledPrice)}</span> : null}
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", marginBottom: armed ? 12 : 0 }}>
              <span>entry {num(activeDirective.entryPrice)}</span>
              <span style={{ color: "#f7525f" }}>stop {num(activeDirective.stopLoss)}</span>
              <span style={{ color: "#ededf0" }}>tp1 {num(activeDirective.takeProfit1)}</span>
              {activeDirective.takeProfit2 ? <span style={{ color: "#ededf0" }}>tp2 {num(activeDirective.takeProfit2)}</span> : null}
            </div>
            {armed && (
              <button onClick={cancelDirective} disabled={directiveBusy} style={{
                padding: "7px 16px", fontFamily: "var(--nx-font-mono)", fontSize: 10, cursor: directiveBusy ? "wait" : "pointer",
                borderRadius: 3, border: "1px solid #4a1e22", background: "#241012", color: "#f7525f",
              }}>{directiveBusy ? "…" : "CANCEL DIRECTIVE"}</button>
            )}
            {!armed && (
              <div style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginTop: 8 }}>
                To stop early, use the KILL switch below (closes the position).
              </div>
            )}
          </div>
        );
      })()}

      {/* ─── CONFIG TAB ──────────────────────────────────── */}
      {tab === "config" && (
        <div>
          {/* ── TRADING STYLE — the friendly on-ramp: pick a horizon, get a tuned
              starting config. Day/Swing are the agent's honest home (hourly data +
              1-min cron + funding edge); scalping/position are intentionally absent. */}
          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// TRADING STYLE <span style={{ color: "#71717a" }}>— pick your horizon to start</span></div>
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
                    background: active ? "#ededf010" : "#0a0a0b",
                    border: `1px solid ${active ? "#ededf0" : "#232327"}`, borderRadius: 6, padding: "10px 12px",
                  }}>
                    <div style={{ color: active ? "#ededf0" : "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 600 }}>{p.label}{active ? " ✓" : ""}</div>
                    <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 10, marginTop: 3, lineHeight: 1.4 }}>{p.blurb}</div>
                  </button>
                );
              })}
            </div>
            <div style={{ color: "#52525b", fontFamily: "var(--nx-font-ui)", fontSize: 9, marginTop: 8, lineHeight: 1.5 }}>
              Nexus's agent lives in the day-to-swing middle. Scalping (seconds) needs sub-minute data the funding edge doesn't use; position trading is buy-and-hold — neither fits this tool, so we don't fake them.
            </div>
          </div>

          {/* Quick-start preset templates. Loads into config for review; user still
              saves explicitly. PRO presets gated by isPro. */}
          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// QUICK-START PRESETS <span style={{ color: "#71717a" }}>— load a preset, review, save</span></div>
            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, marginTop: 10 }}>
              {STRATEGY_PRESETS.map((p) => {
                const locked = !!p.pro && !isPro;
                return (
                  <button key={p.id} title={locked ? "Advanced strategy — PRO" : p.blurb}
                    onClick={() => {
                      if (locked) { setProNote(true); return; }
                      setProNote(false);
                      setConfig((prev) => ({ ...prev, ...p.config }));
                      setSuccess(`Loaded "${p.name}" — review params & Save below.`);
                      setTimeout(() => setSuccess(null), 5000);
                    }}
                    style={{
                      flex: "0 0 200px", textAlign: "left", cursor: "pointer",
                      background: "#0a0a0b", border: `1px solid ${locked ? "#232327" : p.accent + "40"}`,
                      borderRadius: 6, padding: "10px 12px",
                    }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: locked ? "#52525b" : "#fff", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{p.name}{locked ? " ◆" : ""}</span>
                    </div>
                    <div style={{ fontSize: 8, color: p.accent, fontFamily: "var(--nx-font-mono)", letterSpacing: "0.08em", marginBottom: 6 }}>{p.tag}</div>
                    <div style={{ fontSize: 9.5, color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", lineHeight: 1.5 }}>{p.blurb}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Track record — surfaced before activation so users judge on real numbers.
              Live (Supabase) and Paper (state ledger) are kept strictly separate. */}
          {(config.mode === "PAPER" || (agentState?.paper_trades?.length ?? 0) > 0) && (
            <AgentTrackRecord title="// 🧪 PAPER TRACK RECORD" accent="#d4d4d8" trades={agentState?.paper_trades ?? []} paper onReset={resetPaperRecord} />
          )}

          {/* Graduation nudge — once a paper agent is proven, bridge to live */}
          {config.mode === "PAPER" && (() => {
            const pt = agentState?.paper_trades ?? [];
            const net = pt.reduce((s, t) => s + t.pnl, 0);
            const wins = pt.filter((t) => t.pnl > 0).length;
            const wr = pt.length ? Math.round((wins / pt.length) * 100) : 0;
            if (pt.length < 5 || net <= 0) return null;
            return (
              <div style={{ ...agentCardStyle, borderColor: "#33333a", background: "#1a1a1e" }}>
                <div style={{ ...agentLabelStyle, color: "#ededf0" }}>🎓 READY TO GO LIVE?</div>
                <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>
                  Your paper agent is proven — <strong style={{ color: "#ededf0" }}>+${net.toFixed(2)}</strong> over{" "}
                  <strong style={{ color: "#fff" }}>{pt.length}</strong> simulated trades ({wr}% win rate). Same strategy,
                  same guardrails — switch it to live to put it to work for real.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button onClick={() => { setConfig({ ...config, mode: "ASSISTED" }); setSuccess("Mode → ASSISTED. Review params + hit Update below."); setTimeout(() => setSuccess(null), 4000); }}
                    style={{ background: "#ededf015", border: "1px solid #ededf0", borderRadius: 4, color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 11, padding: "8px 16px", cursor: "pointer" }}>
                    → GO ASSISTED
                  </button>
                  <button onClick={() => { setConfig({ ...config, mode: "AUTONOMOUS" }); setSuccess("Mode → AUTONOMOUS. Needs a trading key — review below."); setTimeout(() => setSuccess(null), 4000); }}
                    style={{ background: "#fbbf2415", border: "1px solid #fbbf24", borderRadius: 4, color: "#fbbf24", fontFamily: "var(--nx-font-mono)", fontSize: 11, padding: "8px 16px", cursor: "pointer" }}>
                    → GO AUTONOMOUS
                  </button>
                </div>
                <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9, color: "#52525b", marginTop: 10, lineHeight: 1.5 }}>
                  Paper results don't guarantee live results — live trades face real fills, slippage, and funding. Start with size you can afford to lose.
                </div>
              </div>
            );
          })()}

          <AgentTrackRecord title="// LIVE TRACK RECORD" accent="#a1a1aa" trades={trades} summary={standing?.stats ?? null} />

          {/* Onboarding + key-status panel */}
          <div style={{ ...agentCardStyle, borderColor: tradingKey ? "#232327" : "#4a3a00" }}>
            <div style={agentLabelStyle}>// HOW THE AGENT WORKS</div>
            <p style={{ margin: "8px 0 0", color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", fontSize: 11, lineHeight: 1.6 }}>
              The agent is a disciplined operator of <strong style={{ color: "#d4d4d8" }}>your</strong> edge — you choose the strategy and risk limits, it runs them tirelessly and <strong style={{ color: "#d4d4d8" }}>every call is graded objectively on-chain</strong>. It doesn't promise alpha; it proves what actually worked.
            </p>
            <ol style={{ margin: "8px 0 0", paddingLeft: 18, color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", fontSize: 11, lineHeight: 1.7 }}>
              <li>Place at least one manual trade on Nexus — this generates your Orderly trading key (order-only, <strong style={{ color: "#d4d4d8" }}>cannot withdraw funds</strong>).</li>
              <li>Pick your symbols, risk params, and mode below.</li>
              <li><strong style={{ color: "#d4d4d8" }}>ASSISTED</strong> = the agent surfaces signals for you to place yourself. <strong style={{ color: "#d4d4d8" }}>AUTONOMOUS</strong> = it trades within your risk limits.</li>
              <li>Activate. You can DEACTIVATE or KILL anytime — and its record is public and verifiable either way.</li>
            </ol>
            <div style={{
              marginTop: 10, padding: "8px 10px", borderRadius: 3,
              background: tradingKey ? "#1a1a1e" : "#2a1a00",
              border: `1px solid ${tradingKey ? "#33333a" : "#4a3a00"}`,
              fontFamily: "var(--nx-font-mono)", fontSize: 11,
              color: tradingKey ? "#ededf0" : "#fbbf24",
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
                { mode: "PAPER" as const,      color: "#d4d4d8", desc: "Simulated — no real orders, no key needed. Test risk-free." },
                { mode: "ASSISTED" as const,   color: "#ededf0", desc: "Agent generates thesis → you review + deploy" },
                { mode: "AUTONOMOUS" as const, color: "#fbbf24", desc: "Agent executes automatically within your risk params" },
              ]).map(({ mode, color, desc }) => {
                const sel = config.mode === mode;
                return (
                  <button key={mode} onClick={() => setConfig({ ...config, mode })} style={{
                    flex: 1,
                    background: sel ? `${color}20` : "#0a0a0b",
                    border: `1px solid ${sel ? color : "#232327"}`,
                    borderRadius: 4, padding: "10px 16px", cursor: "pointer",
                    color: sel ? color : "#71717a",
                    fontFamily: "var(--nx-font-mono)", fontSize: 12, letterSpacing: "0.05em",
                  }}>
                    <div style={{ fontWeight: 600 }}>{mode === "PAPER" ? "🧪 PAPER" : mode}</div>
                    <div style={{ fontSize: 9, marginTop: 4, opacity: 0.7 }}>{desc}</div>
                  </button>
                );
              })}
            </div>
            {config.mode === "AUTONOMOUS" && (
              <div style={{ marginTop: 8, padding: 8, background: "#2a1a00", border: "1px solid #fbbf2430", borderRadius: 3 }}>
                <span style={{ color: "#fbbf24", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>
                  ⚠ AUTONOMOUS MODE — Agent will execute trades using your Orderly trading key. Your wallet keys are never stored. The trading key can place orders but CANNOT withdraw funds. You can deactivate at any time.
                </span>
              </div>
            )}
            {config.mode === "PAPER" && (
              <div style={{ marginTop: 8, padding: 8, background: "#1a1a1e", border: "1px solid #d4d4d830", borderRadius: 3 }}>
                <span style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>
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
                  <button key={v} title={locked ? "Advanced strategy — PRO" : hint}
                    onClick={() => { if (locked) { setProNote(true); return; } setProNote(false); setConfig({ ...config, signalMode: v }); }}
                    style={{
                    background: sel ? "#ededf015" : "#0a0a0b",
                    border: `1px solid ${sel ? "#ededf060" : "#232327"}`,
                    borderRadius: 3, padding: "4px 10px", cursor: "pointer",
                    color: locked ? "#52525b" : sel ? "#ededf0" : "#71717a",
                    fontFamily: "var(--nx-font-mono)", fontSize: 11,
                  }}>{label}{locked ? " ◆" : ""}</button>
                );
              })}
            </div>
            {proNote && (
              <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 6, color: "#ededf0" }}>
                ◆ Advanced strategies are PRO — hold $NEXUS or subscribe (see PRO in the Lab).
              </div>
            )}
            <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 8, color: "#71717a" }}>
              {({
                CONFLUENCE: "Both funding + OI-divergence must agree. Fewest, highest-quality entries.",
                FUNDING_ONLY: "Trades funding extremes alone. More entries, lower selectivity.",
                OI_ONLY: "Trades OI-divergence alone. Funding ignored.",
                MOMENTUM: "Trades WITH a price move above your threshold — rides strength. Noisy on short ticks; test in PAPER.",
                MEAN_REVERSION: "FADES a price move above your threshold — buy the dip, sell the rip. Test in PAPER.",
              } as Record<string, string>)[config.signalMode ?? "CONFLUENCE"]}
            </div>
          </div>

          {/* Opt-in market-TAPE filter — gates entries that fight a strong tape.
              Server-enforced in the brain; never flips direction or touches positions.
              ⚠️ The stored config key stays `respectRegime` — it's persisted in KV, read
              by the brain and set by the Bankr skill, so renaming it would break live
              agents. Only the LABEL moved to "tape" (see MarketTape.tsx on the naming). */}
          <AgentToggleCard
            label="// MARKET TAPE FILTER"
            description={<>Skip NEW entries that fight a strong tape — RISK-ON gates shorts, RISK-OFF gates longs. Never flips direction or touches open positions. Test in PAPER first. (See the live tape in Market Intel.)</>}
            on={!!config.respectRegime}
            onToggle={() => setConfig({ ...config, respectRegime: !config.respectRegime })}
          />

          <AgentToggleCard
            label="// SMART-MONEY FILTER"
            description={<>Skip a NEW entry that fights a strong consensus (3+) of top on-chain traders on that symbol — see it live in the Smart Money tab. A guardrail, not a signal (smart money is often early AND often wrong). Test in PAPER first.</>}
            on={!!config.respectSmartMoney}
            onToggle={() => setConfig({ ...config, respectSmartMoney: !config.respectSmartMoney })}
          />

          <AgentToggleCard
            label="// VOLATILITY-SCALED STOPS"
            description={<>Sizes TP/SL to each symbol&apos;s recent ATR instead of a flat % — so a high-vol coin (SOL) isn&apos;t noise-stopped and a calm one isn&apos;t over-given. Keeps your R:R ratio. Test in PAPER first.</>}
            on={!!config.volScaledStops}
            onToggle={() => setConfig({ ...config, volScaledStops: !config.volScaledStops })}
          />

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
                    background: selected ? "#ededf015" : "#0a0a0b",
                    border: `1px solid ${selected ? "#ededf060" : "#232327"}`,
                    borderRadius: 3, padding: "4px 10px", cursor: "pointer",
                    color: selected ? "#ededf0" : "#71717a",
                    fontFamily: "var(--nx-font-mono)", fontSize: 11,
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
                { key: "volTargetPct", label: "VOL-TARGET SIZE", suffix: "% (0=off)", min: 0, max: 8, step: 0.5 },
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
                    <span style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>{suffix}</span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 10, color: "#71717a", lineHeight: 1.5 }}>
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
                    fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "4px 12px", borderRadius: 3, cursor: "pointer",
                    background: scaleOut ? "#ededf015" : "#0a0a0b",
                    border: `1px solid ${scaleOut ? "#ededf0" : "#232327"}`,
                    color: scaleOut ? "#ededf0" : "#71717a",
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
                            <span style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>%</span>
                          </div>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ ...agentLabelStyle, fontSize: 9 }}>TP{i + 1} SIZE</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <NumberField value={leg.sizePct} min={5} max={95} step={5} onCommit={(n) => setTp(i, "sizePct", n)} />
                            <span style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>%</span>
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
                      <span style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>% below peak (0 = off)</span>
                    </div>
                  </div>
                  <div>
                    <div style={{ ...agentLabelStyle, fontSize: 9 }}>BREAKEVEN STOP</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <NumberField value={config.breakevenTriggerPct ?? 0} min={0} max={10} step={0.1} onCommit={(n) => setConfig({ ...config, breakevenTriggerPct: n })} />
                      <span style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>% in profit arms it (0 = off)</span>
                    </div>
                  </div>
                  {(config.breakevenTriggerPct ?? 0) > 0 && (
                    <div>
                      <div style={{ ...agentLabelStyle, fontSize: 9 }}>BREAKEVEN BUFFER</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <NumberField value={config.breakevenBufferPct ?? 0} min={0} max={2} step={0.05} onCommit={(n) => setConfig({ ...config, breakevenBufferPct: n })} />
                        <span style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>% above entry the stop locks to</span>
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 10, color: "#71717a", lineHeight: 1.5 }}>
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
                    <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#ededf0", border: "1px solid #33333a", borderRadius: 3, padding: "2px 8px" }}>◆ PRO</span>
                  </div>
                  <button onClick={isPro ? toggle : undefined} disabled={!isPro} style={{
                    fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "4px 12px", borderRadius: 3, cursor: isPro ? "pointer" : "not-allowed",
                    background: on ? "#ededf015" : "#0a0a0b",
                    border: `1px solid ${on ? "#ededf0" : "#232327"}`,
                    color: on ? "#ededf0" : "#71717a", opacity: isPro ? 1 : 0.5,
                  }}>
                    {on ? "ON" : "OFF"}
                  </button>
                </div>
                {!isPro ? (
                  <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
                    Average into a position on adverse moves and take profit off the blended entry — an PRO feature. The whole ladder stays inside your CAPITAL / TRADE budget.
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
                            <span style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>{suffix}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ color: "#71717a", fontFamily: "var(--nx-font-ui)", fontSize: 10, marginTop: 10, lineHeight: 1.6 }}>
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
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#ededf0", border: "1px solid #33333a", borderRadius: 3, padding: "2px 8px" }}>◆ PRO</span>
            </div>
            {!isPro ? (
              <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
                Route TradingView (or any external) alerts straight to your agent — it executes them through the same guardrails + trustless grading. An PRO feature: hold ARCHITECT-tier $NEXUS or subscribe.
              </div>
            ) : !webhookEnabled ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", fontSize: 11, lineHeight: 1.5, marginBottom: 10 }}>
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
                        <code style={{ flex: 1, minWidth: 0, overflowX: "auto", whiteSpace: "nowrap", color: "#ededf0", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3, padding: "6px 8px", fontSize: 11 }}>{webhookInfo.url}</code>
                        <button onClick={() => navigator.clipboard?.writeText(webhookInfo.url)} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 10px" }}>COPY</button>
                      </div>
                    </div>
                    <div>
                      <div style={{ ...agentLabelStyle, fontSize: 9 }}>ALERT MESSAGE (paste into TradingView)</div>
                      <code style={{ display: "block", color: "#d4d4d8", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3, padding: "8px", fontSize: 10, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                        {`{ "action": "BUY", "symbol": "BTC", "passphrase": "${webhookInfo.passphrase}" }`}
                      </code>
                      <div style={{ color: "#71717a", fontFamily: "var(--nx-font-ui)", fontSize: 9, marginTop: 6, lineHeight: 1.5 }}>
                        action = BUY (long) · SELL (short) · CLOSE (flatten). symbol = any perp (BTC, ETH, SOL…). Webhook signals bypass the cooldown; while a position is open, a new OPEN is ignored (no stacking).
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", fontSize: 11, lineHeight: 1.5 }}>
                    Webhook is enabled, but the secret URL is only shown on this device when created. Rotate to reveal a fresh URL (this revokes the old one).
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button onClick={() => manageWebhook("rotate")} disabled={saving} style={{ ...navBtnStyle, fontSize: 10, padding: "6px 14px", opacity: saving ? 0.5 : 1 }}>ROTATE URL</button>
                  <button onClick={() => manageWebhook("disable")} disabled={saving} style={{ ...navBtnStyle, fontSize: 10, padding: "6px 14px", color: "#f7525f", borderColor: "#f7525f50", opacity: saving ? 0.5 : 1 }}>DISABLE</button>
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
                  <div style={{ color: "#f4f4f5", fontFamily: "var(--nx-font-mono)", fontSize: 16, fontWeight: 600 }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          <AgentBacktestCard
            isPro={isPro} config={config}
            backtest={backtest} backtesting={backtesting}
            sweep={sweep} sweeping={sweeping}
            validation={validation} validating={validating}
            runConfigBacktest={runConfigBacktest} runConfigSweep={runConfigSweep}
            runValidation={runValidation} applySweepConfig={applySweepConfig}
          />
          <AgentStrategyLibrary
            stratName={stratName} setStratName={setStratName} saving={saving}
            strategies={strategies} saveStrategy={saveStrategy} loadStrategy={loadStrategy}
            deleteStrategy={deleteStrategy} togglePublish={togglePublish}
            community={community} communityStyle={communityStyle}
            loadCommunity={loadCommunity} copyStrategy={copyStrategy}
          />

          {!isActive && (
            <div style={{ marginTop: 16, padding: "8px 10px", borderRadius: 3, background: "#0a0a0b", border: "1px solid #232327" }}>
              <span style={{ fontFamily: "var(--nx-font-ui)", fontSize: 10, color: "#71717a", lineHeight: 1.6 }}>
                {config.mode === "PAPER"
                  ? <>🧪 Paper mode is fully simulated — <strong style={{ color: "#a1a1aa" }}>no key stored, no orders placed, no funds at risk</strong>. Activate to start building a paper track record against live prices.</>
                  : <>🔒 By activating, your order-only Orderly key is stored encrypted to let the agent trade on your behalf. It <strong style={{ color: "#a1a1aa" }}>cannot withdraw or transfer funds</strong>. Trading is risky — only deploy capital you can afford to lose. Deactivate anytime.</>}
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
                  borderColor: "#f7525f",
                  color: "#f7525f",
                }}>
                  ■ DEACTIVATE
                </button>
                <button onClick={killSwitch} disabled={saving} style={{
                  background: "#f7525f20",
                  border: "1px solid #f7525f",
                  borderRadius: 4,
                  color: "#f7525f",
                  fontFamily: "var(--nx-font-mono)",
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
            <div style={{ marginTop: 12, padding: 10, background: "#2a1a00", border: "1px solid #fbbf2430", borderRadius: 3 }}>
              <span style={{ color: "#fbbf24", fontFamily: "var(--nx-font-mono)", fontSize: 11 }}>
                ⚠ No Orderly trading key detected. Place at least one manual trade on Nexus first — the SDK generates your trading key on first trade. This key allows order placement only and cannot withdraw funds. <strong style={{ color: "#d4d4d8" }}>Or try 🧪 PAPER mode — no key needed.</strong>
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
            <div style={{ ...agentCardStyle, borderColor: "#33333a", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#d4d4d8" }}>
                ⚡ DEV — inject a synthetic PAPER signal (refused outside paper mode)
              </span>
              <button onClick={forceTestSignal} disabled={saving} style={{ ...navBtnStyle, fontSize: 10, padding: "6px 14px", color: "#d4d4d8", borderColor: "#33333a", opacity: saving ? 0.5 : 1 }}>
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
                  gap: 12, padding: "10px 0", borderBottom: "1px solid #232327",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                    <span style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 600 }}>
                      {t.symbol.replace("PERP_", "").replace("_USDC", "")}
                    </span>
                    <span style={{ color: t.direction === "LONG" ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 600 }}>
                      {t.direction}
                    </span>
                    <span style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 11 }}>
                      @ ${t.entryPrice?.toLocaleString()}
                    </span>
                    <span style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 11 }}>
                      conf {t.confidence}% · funding {(t.funding * 100).toFixed(4)}%
                    </span>
                    <span style={{ color: "#52525b", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>
                      {formatAgentTime(Date.now() - t.generatedAt)} ago
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => resolvePending(t.id, "deploy")} style={{
                      background: "#ededf020", border: "1px solid #ededf0", borderRadius: 3,
                      color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "5px 12px",
                      cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase",
                    }}>
                      ✓ Reviewed
                    </button>
                    <button onClick={() => resolvePending(t.id, "dismiss")} style={{
                      background: "none", border: "1px solid #f7525f50", borderRadius: 3,
                      color: "#f7525f", fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "5px 12px",
                      cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase",
                    }}>
                      ✕ Dismiss
                    </button>
                  </div>
                </div>
              ))}
              <div style={{ color: "#52525b", fontFamily: "var(--nx-font-mono)", fontSize: 10, marginTop: 8 }}>
                ASSISTED mode generates these for manual review — the agent does not execute them. Place the trade yourself if you agree, then mark Reviewed.
              </div>
            </div>
          )}

          <div style={agentCardStyle}>
            <div style={agentLabelStyle}>// AGENT STATUS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12, marginTop: 8 }}>
              <div>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>STATE</div>
                <div style={{ color: isActive ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontSize: 16, fontWeight: 600 }}>
                  {isActive ? (hasPosition ? "TRADING" : "WATCHING") : "INACTIVE"}
                </div>
              </div>
              <div>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>MODE</div>
                <div style={{ color: config.mode === "AUTONOMOUS" ? "#fbbf24" : config.mode === "PAPER" ? "#d4d4d8" : "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 16, fontWeight: 600 }}>
                  {config.mode === "PAPER" ? "🧪 PAPER" : config.mode}
                </div>
              </div>
              <div>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>TRADES TODAY</div>
                <div style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 16, fontWeight: 600 }}>
                  {agentState?.trades_today ?? 0} / {config.maxTradesPerDay}
                </div>
              </div>
              <div>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>DAILY P&L</div>
                <div style={{ color: (agentState?.daily_pnl ?? 0) >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontSize: 16, fontWeight: 600 }}>
                  ${(agentState?.daily_pnl ?? 0).toFixed(2)}
                </div>
              </div>
              <div>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>STRATEGY</div>
                <div style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 600 }}>
                  {deriveStyle(config)} · {config.signalMode}{config.dcaEnabled ? " · DCA" : ""}
                </div>
              </div>
            </div>
          </div>

          {/* ── LEADERBOARD STANDING — why this agent is / isn't on TOP AGENTS ── */}
          {standing && standing.stats && standing.stats.trades > 0 && (
            <div style={{ ...agentCardStyle, borderColor: standing.eligible ? "#232327" : "#33333a" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div style={{ ...agentLabelStyle, color: standing.eligible ? "#ededf0" : "#fbbf24" }}>
                  ◆ LEADERBOARD STANDING
                </div>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: standing.eligible ? "#ededf0" : "#fbbf24" }}>
                  {standing.eligible ? "✓ RANKED ON TOP AGENTS" : `${standing.metCount} of ${standing.total} criteria met`}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 12 }}>
                {standing.criteria.map((c) => (
                  <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: c.met ? "#ededf0" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontSize: 13 }}>
                      {c.met ? "✓" : "✗"}
                    </span>
                    <div>
                      <div style={{ color: c.met ? "#d4d4d8" : "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 11 }}>{c.label}</div>
                      <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>
                        {c.key === "profitable"
                          ? `now: ${c.value >= 0 ? "+" : ""}$${c.value.toFixed(2)}`
                          : `${c.value} / ${c.target}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ color: "#52525b", fontFamily: "var(--nx-font-ui)", fontSize: 10, marginTop: 10, lineHeight: 1.5 }}>
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
            const barColor = (pct: number) => pct >= 90 ? "#f7525f" : pct >= 60 ? "#fbbf24" : "#3ecf8e";
            return (
              <div style={{ ...agentCardStyle, borderColor: lossPct >= 90 ? "#f7525f60" : "#232327" }}>
                <div style={agentLabelStyle}>🛡 ACTIVE GUARDRAILS</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16, marginTop: 10 }}>
                  {/* Daily loss limit */}
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ ...agentLabelStyle, fontSize: 9 }}>DAILY LOSS LIMIT</span>
                      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: barColor(lossPct) }}>${dailyLoss.toFixed(2)} / ${config.maxDailyLossUsdc}</span>
                    </div>
                    <div style={{ height: 6, background: "#0a0a0b", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${lossPct}%`, background: barColor(lossPct), transition: "width 0.3s" }} />
                    </div>
                    <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 4 }}>auto-halts trading at limit</div>
                  </div>
                  {/* Trades today */}
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ ...agentLabelStyle, fontSize: 9 }}>TRADES TODAY</span>
                      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: barColor(tradesPct) }}>{agentState?.trades_today ?? 0} / {config.maxTradesPerDay}</span>
                    </div>
                    <div style={{ height: 6, background: "#0a0a0b", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${tradesPct}%`, background: barColor(tradesPct), transition: "width 0.3s" }} />
                    </div>
                    <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 4 }}>stops opening new trades at cap</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginTop: 14, paddingTop: 12, borderTop: "1px solid #232327" }}>
                  {[
                    { label: "MAX LEVERAGE", value: `${config.leverage}x` },
                    { label: "STOP / TRADE", value: `${config.slPercent}%` },
                    { label: "MAX HOLD", value: `${config.maxHoldHours}h` },
                    { label: "MAX RISK / TRADE", value: `$${(config.capitalPerTrade * (config.slPercent / 100) * config.leverage).toFixed(2)}` },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                      <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 14, fontWeight: 600 }}>{value}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, fontFamily: "var(--nx-font-ui)", fontSize: 10, color: "#71717a", lineHeight: 1.5 }}>
                  🔒 Order-only key — the agent <strong style={{ color: "#a1a1aa" }}>cannot withdraw or transfer funds</strong>. Hit ⚡ KILL on the config tab to flatten and stop instantly.
                </div>
              </div>
            );
          })()}

          {hasPosition && agentState?.current_position && (
            <div style={{ ...agentCardStyle, borderColor: agentState.current_position.direction === "LONG" ? "#3ecf8e40" : "#f7525f40" }}>
              <div style={{ ...agentLabelStyle, display: "flex", alignItems: "center", gap: 8 }}>
                // CURRENT POSITION
                {agentState.current_position.paper && (
                  <span style={{ color: "#d4d4d8", border: "1px solid #d4d4d840", borderRadius: 3, padding: "1px 6px", fontSize: 8 }}>🧪 PAPER</span>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 12, marginTop: 8 }}>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>SYMBOL</div>
                  <div style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 14, fontWeight: 600 }}>
                    {agentState.current_position.symbol.replace("PERP_", "").replace("_USDC", "")}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>DIRECTION</div>
                  <div style={{ color: agentState.current_position.direction === "LONG" ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontSize: 14, fontWeight: 600 }}>
                    {agentState.current_position.direction}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>ENTRY</div>
                  <div style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 14 }}>
                    ${(agentState.current_position.entry_price ?? 0).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>CURRENT</div>
                  <div style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 14 }}>
                    ${(agentState.current_position.current_price ?? agentState.current_position.entry_price ?? 0).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>P&L</div>
                  <div style={{ color: (agentState.current_position.pnl_percent ?? 0) >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontSize: 14, fontWeight: 600 }}>
                    {(agentState.current_position.pnl_percent ?? 0) >= 0 ? "+" : ""}{(agentState.current_position.pnl_percent ?? 0).toFixed(3)}%
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 8, color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>
                HELD FOR: {formatAgentTime(Date.now() - (agentState.current_position.opened_at ?? Date.now()))} / {config.maxHoldHours}h max
              </div>
            </div>
          )}

          {isActive && !hasPosition && (
            <div style={{ ...agentCardStyle, textAlign: "center", padding: 24 }}>
              <div style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>
                // SCANNING FOR SIGNALS ON {config.symbols.map(s => s.replace("PERP_", "").replace("_USDC", "")).join(", ")}
              </div>
              <div style={{ color: "#33333a", fontFamily: "var(--nx-font-mono)", fontSize: 10, marginTop: 6 }}>
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
                  <div style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 13 }}>
                    {(agentState.last_signal.symbol || "").replace("PERP_", "").replace("_USDC", "")}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>DIRECTION</div>
                  <div style={{ color: agentState.last_signal.direction === "LONG" ? "#3ecf8e" : agentState.last_signal.direction === "SHORT" ? "#f7525f" : "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 600 }}>
                    {agentState.last_signal.direction}
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>FUNDING</div>
                  <div style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 13 }}>
                    {(agentState.last_signal.funding * 100).toFixed(4)}%
                  </div>
                </div>
                <div>
                  <div style={{ ...agentLabelStyle, fontSize: 9 }}>AGE</div>
                  <div style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 13 }}>
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
                  background: "#141416", border: "1px solid #232327", borderRadius: 3,
                  padding: "3px 8px", fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#a1a1aa",
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
              {isPaperHist && <span style={{ color: "#d4d4d8", border: "1px solid #d4d4d840", borderRadius: 3, padding: "1px 6px", fontSize: 8 }}>🧪 PAPER</span>}
            </div>
            {histTrades.length === 0 ? (
              <div style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 12, padding: 20, textAlign: "center" }}>
                {isPaperHist
                  ? "No paper trades yet. Activate in PAPER mode to start simulating."
                  : "No trades recorded yet. Agent will log trades here once active."}
              </div>
            ) : (
              <div style={{ marginTop: 8, overflowX: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 1fr 1fr 0.8fr 0.6fr 1.3fr", gap: 8, minWidth: 580, padding: "6px 0", borderBottom: "1px solid #232327" }}>
                  {["SYMBOL", "DIR", "ENTRY", "EXIT", "P&L", "REASON", "STRATEGY"].map((h) => (
                    <span key={h} style={{ ...agentLabelStyle, fontSize: 9, marginBottom: 0 }}>{h}</span>
                  ))}
                </div>
                {histTrades.map((trade, i) => {
                  const rowId = trade.id || String(i);
                  const open = expandedTrade === rowId;
                  const asset = trade.symbol.replace("PERP_", "").replace("_USDC", "");
                  const qty = trade.qty ?? 0;
                  const notional = qty * (trade.entry_price || 0);
                  const openedMs = trade.opened_at ? new Date(trade.opened_at).getTime() : 0;
                  const closedMs = trade.closed_at ? new Date(trade.closed_at).getTime() : 0;
                  const holdMin = openedMs && closedMs ? Math.max(0, Math.round((closedMs - openedMs) / 60000)) : null;
                  const holdLabel = holdMin == null ? null : holdMin >= 60 ? `${(holdMin / 60).toFixed(1)}h` : `${holdMin}m`;
                  // R-multiple = realized P&L% ÷ risk taken (stop distance). Only when we
                  // have both the trade's %P&L and its stop; the true measure of a call.
                  const rMultiple = (trade.pnl_percent != null && (trade as unknown as { slPercent?: number }).slPercent)
                    ? trade.pnl_percent / ((trade as unknown as { slPercent: number }).slPercent * (trade.leverage || 1))
                    : null;
                  const entryRef = (trade as unknown as { entry_order_id?: string }).entry_order_id;
                  const closeRef = (trade as unknown as { close_order_id?: string }).close_order_id;
                  const chip = (label: string, value: string, color = "#a1a1aa") => (
                    <span><span style={{ color: "#52525b" }}>{label} </span><span style={{ color }}>{value}</span></span>
                  );
                  return (
                  <div
                    key={rowId}
                    className={`nx-trade-row is-clickable${open ? " is-open" : ""}`}
                    style={{ minWidth: 580, borderBottom: "1px solid #232327" }}
                    onClick={() => setExpandedTrade(open ? null : rowId)}
                    role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedTrade(open ? null : rowId); } }}
                  >
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 1fr 1fr 0.8fr 0.6fr 1.3fr", gap: 8, padding: "9px 0" }}>
                      <span style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>{asset}</span>
                      <span style={{ color: trade.direction === "LONG" ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>
                        {trade.direction}
                      </span>
                      <span style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>${trade.entry_price.toLocaleString()}</span>
                      <span style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>${trade.exit_price.toLocaleString()}</span>
                      <span style={{ color: trade.pnl >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600 }}>
                        {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
                      </span>
                      <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: trade.reason === "TP" ? "#3ecf8e" : trade.reason === "SL" ? "#f7525f" : trade.reason === "BE" ? "#d4d4d8" : "#fbbf24" }}>
                        {trade.reason}
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", minWidth: 0 }}>
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={trade.strategy ?? undefined}>
                          {trade.strategy ?? "—"}
                        </span>
                        <span className="nx-chevron" style={{ marginLeft: "auto", flexShrink: 0, fontSize: 10 }}>&#9656;</span>
                      </span>
                    </div>
                    {/* Progressive-disclosure detail panel */}
                    <div className={`nx-expand${open ? " is-open" : ""}`}>
                      <div className="nx-expand-inner">
                        <div style={{ padding: "2px 0 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>
                            {trade.leverage != null && chip("LEV", `${trade.leverage}x`)}
                            {qty > 0 && chip("SIZE", `${qty.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${asset}`)}
                            {notional > 0 && chip("NOTIONAL", `$${notional.toLocaleString(undefined, { maximumFractionDigits: 0 })}`)}
                            {trade.pnl_percent != null && chip("P&L", `${trade.pnl_percent >= 0 ? "+" : ""}${trade.pnl_percent.toFixed(2)}%`, trade.pnl_percent >= 0 ? "#3ecf8e" : "#f7525f")}
                            {rMultiple != null && isFinite(rMultiple) && chip("R", `${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(2)}R`, rMultiple >= 0 ? "#3ecf8e" : "#f7525f")}
                            {holdLabel && chip("HELD", holdLabel)}
                          </div>
                          {/* Outcome micro-viz: a zero-centered bar, length ∝ |P&L%|
                              (capped), extending right for a win / left for a loss. */}
                          {trade.pnl_percent != null && (() => {
                            const cap = 6; // % that maps to a full half-track
                            const mag = Math.min(1, Math.abs(trade.pnl_percent) / cap);
                            const winSide = trade.pnl_percent >= 0;
                            const col = winSide ? "#3ecf8e" : "#f7525f";
                            return (
                              <div style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: 320 }}>
                                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#52525b", width: 30 }}>MOVE</span>
                                <div style={{ position: "relative", flex: 1, height: 6, background: "#141416", borderRadius: 3 }}>
                                  <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "#33333a" }} />
                                  <div style={{
                                    position: "absolute", top: 0, bottom: 0, borderRadius: 3, background: col,
                                    ...(winSide ? { left: "50%", width: `${mag * 50}%` } : { right: "50%", width: `${mag * 50}%` }),
                                  }} />
                                </div>
                              </div>
                            );
                          })()}
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontFamily: "var(--nx-font-mono)", fontSize: 9 }}>
                            {openedMs > 0 && chip("OPENED", new Date(openedMs).toLocaleString(), "#71717a")}
                            {closedMs > 0 && chip("CLOSED", new Date(closedMs).toLocaleString(), "#71717a")}
                          </div>
                          {(entryRef || closeRef) && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontFamily: "var(--nx-font-mono)", fontSize: 9 }}>
                              <span style={{ color: "#52525b" }}>ORDERLY REF</span>
                              {entryRef && chip("entry", String(entryRef), "#71717a")}
                              {closeRef && chip("close", String(closeRef), "#71717a")}
                              <span style={{ color: "#52525b" }}>· independently exchange-auditable</span>
                            </div>
                          )}
                          <div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPosterData({
                                  kind: "trade", symbol: trade.symbol, direction: trade.direction,
                                  entry: trade.entry_price, exit: trade.exit_price,
                                  pnlPct: trade.pnl_percent ?? null, pnlUsd: trade.pnl,
                                  leverage: trade.leverage ?? null, reason: trade.reason ?? null, held: holdLabel,
                                });
                              }}
                              style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.05em", color: "#a1a1aa", background: "none", border: "1px solid #33333a", borderRadius: 3, padding: "4px 10px", cursor: "pointer" }}
                            >↗ SHARE CARD</button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  );
                })}
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
            // Cumulative equity curve — histTrades is newest-first, so walk it in
            // reverse (chronological) and running-sum the P&L.
            const equityPoints = (() => {
              const pts: number[] = [];
              let run = 0;
              for (let k = histTrades.length - 1; k >= 0; k--) { run += histTrades[k].pnl; pts.push(run); }
              return pts;
            })();
            const usd = (v: number) => `${v >= 0 ? "" : "-"}$${Math.abs(v).toFixed(2)}`;
            const stats: { label: string; value: number; fmt: (v: number) => string; color: string }[] = [
              { label: "TOTAL P&L", value: agentTotalPnl, fmt: (v) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`, color: agentTotalPnl >= 0 ? "#3ecf8e" : "#f7525f" },
              { label: "WIN RATE", value: parseFloat(agentWinRate), fmt: (v) => `${v.toFixed(1)}%`, color: "#d4d4d8" },
              { label: "TRADES", value: histTrades.length, fmt: (v) => `${Math.round(v)}`, color: "#d4d4d8" },
              { label: "AVG WIN", value: agentAvgWin, fmt: usd, color: "#ededf0" },
              { label: "AVG LOSS", value: agentAvgLoss, fmt: usd, color: "#f7525f" },
            ];
            return (
              <div style={agentCardStyle} className="nx-fade-in">
                <div style={{ ...agentLabelStyle, display: "flex", alignItems: "center", gap: 8 }}>
                  // AGENT PERFORMANCE
                  {isPaperHist && <span style={{ color: "#d4d4d8", border: "1px solid #d4d4d840", borderRadius: 3, padding: "1px 6px", fontSize: 8 }}>🧪 PAPER</span>}
                </div>
                {equityPoints.length >= 2 && (
                  <div style={{ marginTop: 10, marginBottom: 4 }}>
                    <div style={{ ...agentLabelStyle, fontSize: 8, marginBottom: 2 }}>CUMULATIVE P&amp;L</div>
                    <PnlChart points={equityPoints} />
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 12, marginTop: 8 }}>
                  {stats.map(({ label, value, fmt, color }) => (
                    <div key={label}>
                      <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                      <div style={{ color, fontFamily: "var(--nx-font-mono)", fontSize: 16, fontWeight: 600 }}>
                        <CountUp value={value} format={fmt} />
                      </div>
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
          <div style={{ ...agentCardStyle, borderColor: "#232327" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={agentLabelStyle}>// TOP AUTONOMOUS AGENTS</div>
              <button onClick={loadLeaderboard} disabled={lbLoading} style={{ ...navBtnStyle, fontSize: 9, padding: "3px 10px", color: "#71717a" }}>
                {lbLoading ? "…" : "↻ REFRESH"}
              </button>
            </div>
            <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 10, color: "#52525b", marginTop: 6, lineHeight: 1.5 }}>
              Ranked by risk-adjusted score (win rate + profit factor, weighted by sample size) over <strong style={{ color: "#a1a1aa" }}>≥10 live trades spanning ≥3 days</strong>. Paper excluded.
              {" "}<strong style={{ color: "#a1a1aa" }}>⚡ Autocopy</strong> mirrors an agent's trades with YOUR agent — at your size, mode &amp; guardrails. Trustless: their record is graded on-chain.
            </div>
            {(config.autocopy?.leaders?.length ?? 0) > 0 && (
              <div style={{ marginTop: 8, fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#ededf0", letterSpacing: "0.02em" }}>
                ⚡ Autocopying {config.autocopy!.leaders.length} agent{config.autocopy!.leaders.length === 1 ? "" : "s"}
                {!agentState?.active && <span style={{ color: "#fbbf24" }}> — activate your agent to start mirroring</span>}
              </div>
            )}
            {/* Congruence bridge: this board is agents built HERE. The Arena is the
                same trustless grading opened to agents built ANYWHERE (external AI). */}
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #232327", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--nx-font-ui)", fontSize: 10, color: "#71717a", lineHeight: 1.5 }}>
                Building an AI agent elsewhere? Prove it on the same standard in the open <strong style={{ color: "#a1a1aa" }}>Arena</strong>.
              </span>
              <a href="/arena" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.06em", color: "#ededf0", textDecoration: "none", border: "1px solid #33333a", borderRadius: 3, padding: "3px 9px", background: "#1a1a1e", whiteSpace: "nowrap" }}>
                ENTER THE ARENA →
              </a>
            </div>
            {ledgerInfo && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #232327", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#ededf0" }}>🔗 LEDGER SHA-256</span>
                <code style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#a1a1aa", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3, padding: "2px 6px" }}>
                  {ledgerInfo.hash.slice(0, 10)}…{ledgerInfo.hash.slice(-8)}
                </code>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>· {ledgerInfo.count} records ·</span>
                <a href={`${AGENT_API}/agents/ledger`} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#d4d4d8", textDecoration: "none" }}>
                  verify ↗
                </a>
                {ledgerInfo.onChain?.verified && (
                  <a href={ledgerInfo.onChain.explorer || "#"} target="_blank" rel="noopener noreferrer"
                    style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#ededf0", textDecoration: "none", border: "1px solid #33333a", borderRadius: 3, padding: "2px 6px", background: "#1a1a1e" }}>
                    ⛓ ANCHORED ON-CHAIN ↗
                  </a>
                )}
              </div>
            )}
          </div>

          {lbLoading && (!leaderboard || leaderboard.length === 0) ? (
            <div style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 12, padding: 24, textAlign: "center" }}>loading leaderboard…</div>
          ) : !leaderboard || leaderboard.length === 0 ? (
            <div style={{ ...agentCardStyle, textAlign: "center", padding: 28 }}>
              <div style={{ fontSize: 22, color: "#ededf0", marginBottom: 8 }}>◆</div>
              <div style={{ color: "#fff", fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: "bold", marginBottom: 6 }}>No ranked agents yet</div>
              <div style={{ color: "#71717a", fontFamily: "var(--nx-font-ui)", fontSize: 11, lineHeight: 1.6 }}>
                Agents qualify after 10 live trades over 3+ days. Run yours live and claim rank #1 — your strategy becomes copyable by everyone.
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowX: "auto" }}>
              {leaderboard.map((e) => {
                const isMe = e.wallet.toLowerCase() === (walletAddress ?? "").toLowerCase();
                const isCopying = (config.autocopy?.leaders || []).map((w) => w.toLowerCase()).includes(e.wallet.toLowerCase());
                const who = e.displayName || `${e.wallet.slice(0, 6)}…${e.wallet.slice(-4)}`;
                const medal = e.rank === 1 ? "#ffd700" : e.rank === 2 ? "#d4d4d8" : e.rank === 3 ? "#cd7f32" : "#52525b";
                return (
                  <div key={e.wallet} style={{ ...agentCardStyle, borderColor: isMe ? "#ededf0" : "#232327", display: "grid", gridTemplateColumns: "34px 1fr repeat(4, auto) 134px", gap: 12, minWidth: 540, alignItems: "center" }}>
                    <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: medal, textAlign: "center" }}>{e.rank}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      {e.pfp
                        ? <img src={e.pfp} alt="" style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                        : <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#1a1a1e", border: "1px solid #232327", flexShrink: 0 }} />}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#fff", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {who}{isMe && <span style={{ color: "#ededf0", fontSize: 9 }}> (you)</span>}
                        </div>
                        <div style={{ display: "flex", gap: 3, marginTop: 2, flexWrap: "wrap" }}>
                          {(e.config?.symbols ?? []).slice(0, 4).map((s) => (
                            <span key={s} style={{ fontSize: 8, color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", background: "#1a1a1e", border: "1px solid #1a1a1e", borderRadius: 2, padding: "1px 4px" }}>
                              {s.replace("PERP_", "").replace("_USDC", "")}
                            </span>
                          ))}
                        </div>
                        {(e.copiers ?? 0) > 0 && (
                          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8.5, color: "#a1a1aa", marginTop: 3, letterSpacing: "0.02em" }}>
                            ⚡ {e.copiers} copier{e.copiers === 1 ? "" : "s"}
                          </div>
                        )}
                      </div>
                    </div>
                    {[
                      { label: "SCORE", val: e.score.toFixed(1), color: "#ededf0" },
                      { label: "NET P&L", val: `+$${e.netPnl.toFixed(0)}`, color: "#3ecf8e" },
                      { label: "WIN", val: `${e.winRate.toFixed(0)}%`, color: e.winRate >= 50 ? "#3ecf8e" : "#fbbf24" },
                      { label: "PF", val: e.profitFactor.toFixed(2), color: "#d4d4d8" },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ textAlign: "right" }}>
                        <div style={{ ...agentLabelStyle, fontSize: 8 }}>{label}</div>
                        <div style={{ color, fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 600 }}>{val}</div>
                        {label === "SCORE" && <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{e.trades}t · {e.daysActive}d</div>}
                      </div>
                    ))}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {/* ⚡ AUTOCOPY — the flagship: your agent mirrors theirs, trustlessly. */}
                      <button
                        onClick={() => toggleAutocopy(e.wallet)}
                        disabled={isMe || saving}
                        title={isMe ? "This is your agent" : "Your agent mirrors this agent's trades — at your own size, mode & guardrails"}
                        style={{
                          background: isMe ? "#0a0a0b" : isCopying ? "#ededf0" : "#ededf015",
                          border: `1px solid ${isMe ? "#232327" : "#ededf0"}`,
                          borderRadius: 4, color: isMe ? "#52525b" : isCopying ? "#0a0a0b" : "#ededf0",
                          fontFamily: "var(--nx-font-mono)", fontSize: 10, fontWeight: 600, padding: "7px 10px",
                          cursor: isMe ? "default" : "pointer", letterSpacing: "0.03em", whiteSpace: "nowrap",
                        }}
                      >
                        {isMe ? "YOUR AGENT" : isCopying ? "⚡ COPYING" : "⚡ AUTOCOPY"}
                      </button>
                      {!isMe && (
                        <button
                          onClick={() => copyAgentConfig(e)}
                          disabled={!e.config}
                          title="Copy this agent's strategy settings into your config (edit before use)"
                          style={{
                            background: "#0a0a0b",
                            border: `1px solid ${e.config ? "#33333a" : "#232327"}`,
                            borderRadius: 4, color: e.config ? "#a1a1aa" : "#52525b",
                            fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "5px 10px",
                            cursor: e.config ? "pointer" : "default", letterSpacing: "0.03em", whiteSpace: "nowrap",
                          }}
                        >
                          COPY CONFIG
                        </button>
                      )}
                    </div>
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
