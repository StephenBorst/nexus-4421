/**
 * NexusAssistant — floating AI copilot (v1).
 *
 * BYOK, client-side only: the user brings their own Anthropic/OpenAI key, stored
 * in localStorage; the browser calls the provider directly (key never hits a
 * Nexus server). Injects live session context (page, theses, agent, wallet) so
 * it's a Nexus-native copilot, not a generic chatbot. Free with BYOK; hosted
 * inference (pay in $NEXUS / USDC) is a later iteration.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAccount, usePrivateQuery, usePositionStream } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { useIsMobile } from "@/pages/lab/useIsMobile";
import { useSubscription } from "@/hooks/useSubscription";
import {
  PROVIDERS, LS_PROVIDER, LS_MODEL, LS_KEY, LS_HOSTED_MODEL, SYSTEM_PROMPT,
  HOSTED_TIERS, loadHostedModel,
  buildContextBlock, runChatStream, listModels, getHostedAccess, type ProviderId, type ChatMsg,
} from "@/config/assistant";

function pickDefaultModel(provider: ProviderId, ids: string[]): string {
  if (provider === "anthropic") return ids.find((i) => /sonnet/.test(i)) || ids.find((i) => /opus/.test(i)) || ids[0];
  return ids.find((i) => i === "gpt-4o") || ids.find((i) => /^gpt-4/.test(i)) || ids[0];
}

const AGENT_API = "https://og.nexustradinglabs.com";
const mono = "var(--nx-font-mono)";
const GREEN = "#00ff88";

type DisplayMsg = ChatMsg & { tools?: string[] };

// Load the stored model for a provider. Reject dead "-latest" aliases (404) and
// cross-provider ids (e.g. a Claude model stored under OpenAI) → default.
function loadModel(p: ProviderId): string {
  const stored = typeof window !== "undefined" ? window.localStorage.getItem(LS_MODEL(p)) : null;
  if (!stored || /-latest$/.test(stored)) return PROVIDERS[p].defaultModel;
  const matchesFamily = p === "anthropic" ? /^claude/i.test(stored) : /^(gpt|o\d|chatgpt)/i.test(stored);
  return matchesFamily ? stored : PROVIDERS[p].defaultModel;
}

const CHAT_KEY = "nexus_ai_chat";
const CHAT_CAP = 40; // keep the last N messages
function loadChat(): DisplayMsg[] {
  try { const r = window.localStorage.getItem(CHAT_KEY); return r ? JSON.parse(r) : []; } catch { return []; }
}

// Minimal markdown renderer (no dep): **bold**, `code`, bullet lists, and
// #/##/### headers — enough polish for the narrow terminal panel.
function inline(text: string): React.ReactNode {
  // Order matters: match **bold** before *italic*.
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <b key={i} style={{ color: "#fff" }}>{p.slice(2, -2)}</b>;
    if (p.startsWith("*") && p.endsWith("*")) return <i key={i} style={{ color: "#a8c8b8" }}>{p.slice(1, -1)}</i>;
    if (p.startsWith("`") && p.endsWith("`")) return <code key={i} style={{ color: "#00ff88", background: "#0a1a0a", padding: "0 3px", borderRadius: 2 }}>{p.slice(1, -1)}</code>;
    return p;
  });
}
const isTableSep = (l: string) => /\|/.test(l) && /^[\s:|-]+$/.test(l.trim()) && l.includes("-");
const splitRow = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function renderRich(text: string): React.ReactNode {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimEnd();

    // Table: header row + separator row + body rows.
    if (t.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(t);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|")) { rows.push(splitRow(lines[j])); j++; }
      out.push(
        <table key={i} style={{ borderCollapse: "collapse", margin: "4px 0", fontSize: 10 }}>
          <thead><tr>{header.map((h, k) => (
            <th key={k} style={{ textAlign: "left", color: "#8aaa9a", borderBottom: "1px solid #1a2e1a", padding: "2px 8px 2px 0", fontWeight: "bold" }}>{inline(h)}</th>
          ))}</tr></thead>
          <tbody>{rows.map((r, ri) => (
            <tr key={ri}>{r.map((c, ci) => (
              <td key={ci} style={{ padding: "2px 8px 2px 0", color: "#c8d8c8", verticalAlign: "top" }}>{inline(c)}</td>
            ))}</tr>
          ))}</tbody>
        </table>
      );
      i = j - 1;
      continue;
    }

    if (t.trim() === "") { out.push(<div key={i} style={{ height: 5 }} />); continue; }
    const hdr = t.match(/^(#{1,3})\s+(.*)/);
    if (hdr) { out.push(<div key={i} style={{ color: "#fff", fontWeight: "bold", marginTop: 4 }}>{inline(hdr[2])}</div>); continue; }
    const bullet = t.match(/^\s*[-*•]\s+(.*)/);
    if (bullet) { out.push(
      <div key={i} style={{ display: "flex", gap: 6 }}>
        <span style={{ color: GREEN }}>•</span>
        <span>{inline(bullet[1])}</span>
      </div>
    ); continue; }
    out.push(<div key={i}>{inline(t)}</div>);
  }
  return out;
}

export default function NexusAssistant() {
  const { state: acct } = useAccount();
  const walletAddress = (acct as { address?: string })?.address ?? null;
  const { isPro } = useSubscription(walletAddress);
  const [useHosted, setUseHosted] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("nexus_ai_hosted") === "1");
  const setHosted = (v: boolean) => { setUseHosted(v); try { window.localStorage.setItem("nexus_ai_hosted", v ? "1" : "0"); } catch { /* ignore */ } };
  // Hosted (PRO) model tier — which model our proxy runs (each has its own daily cap).
  const [hostedModel, setHostedModel] = useState<string>(() => loadHostedModel());
  const chooseHostedModel = (m: string) => { setHostedModel(m); try { window.localStorage.setItem(LS_HOSTED_MODEL, m); } catch { /* ignore */ } };
  const { theses } = useLabStorage(walletAddress);
  // ⚠️ Do NOT use usePrivateQuery("/v1/positions") here — it shares the SWR key the
  // SDK's own account/collateral pipeline owns, and a competing config poisons it
  // (blanks Total value / buying power, stalls Enable Trading). Join the SDK's shared
  // position stream instead so we read the same managed data without conflict.
  const [posStream] = usePositionStream();
  const { data: histData } = usePrivateQuery("/v1/position_history?limit=500", { revalidateOnFocus: false });
  const location = useLocation();

  // Realized-performance summary from closed trades (same source as the Lab).
  const performance = useMemo(() => {
    const rows = Array.isArray(histData) ? histData : ((histData as { rows?: unknown[] })?.rows ?? []);
    const trades = (rows as Record<string, unknown>[])
      .filter((o) => o.position_status === "closed")
      .map((o) => ({ symbol: String(o.symbol ?? ""), pnl: parseFloat(String(o.realized_pnl ?? 0)) }));
    if (!trades.length) return null;
    const wins = trades.filter((t) => t.pnl > 0).length;
    const losses = trades.filter((t) => t.pnl < 0).length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const best = trades.reduce<{ symbol: string; pnl: number } | null>((a, t) => (!a || t.pnl > a.pnl ? t : a), null);
    const worst = trades.reduce<{ symbol: string; pnl: number } | null>((a, t) => (!a || t.pnl < a.pnl ? t : a), null);
    const bySym: Record<string, { trades: number; pnl: number }> = {};
    for (const t of trades) {
      const k = t.symbol.replace("PERP_", "").replace("_USDC", "");
      bySym[k] = bySym[k] || { trades: 0, pnl: 0 };
      bySym[k].trades += 1; bySym[k].pnl += t.pnl;
    }
    const clean = (s: string) => s.replace("PERP_", "").replace("_USDC", "");
    return {
      closed_trades: trades.length, wins, losses,
      win_rate_pct: wins + losses ? Math.round((wins / (wins + losses)) * 100) : null,
      total_pnl: +totalPnl.toFixed(2),
      best_trade: best ? { symbol: clean(best.symbol), pnl: +best.pnl.toFixed(2) } : null,
      worst_trade: worst ? { symbol: clean(worst.symbol), pnl: +worst.pnl.toFixed(2) } : null,
      by_symbol: Object.entries(bySym).map(([s, v]) => ({ symbol: s, trades: v.trades, pnl: +v.pnl.toFixed(2) })).sort((a, b) => b.trades - a.trades).slice(0, 8),
    };
  }, [histData]);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "settings">("chat");
  // First-run discovery: pulse + one-time tooltip until the panel is first opened.
  const [seen, setSeen] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("nexus_ai_seen") === "1");
  const openPanel = () => {
    setOpen(true);
    if (!seen) { setSeen(true); try { window.localStorage.setItem("nexus_ai_seen", "1"); } catch { /* ignore */ } }
  };

  // ── Draggable launcher ──
  // The bubble can be press-and-dragged anywhere; a tap (no real movement) still
  // opens the panel. Position (top-left px) is persisted so it stays put.
  const loadPos = (): { x: number; y: number } | null => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem("nexus_ai_pos");
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p?.x === "number" && typeof p?.y === "number") {
          // Clamp a position saved on a wider screen back into the current
          // viewport — otherwise a desktop-dragged bubble loads off-screen on mobile.
          const w = 52, h = 52;
          return {
            x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - w)),
            y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - h)),
          };
        }
      }
    } catch { /* ignore */ }
    return null;
  };
  const [pos, setPos] = useState<{ x: number; y: number } | null>(loadPos);
  const launcherRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ sx: 0, sy: 0, ox: 0, oy: 0, moved: false, active: false, lx: 0, ly: 0 });

  const onLauncherDown = (e: React.PointerEvent) => {
    const el = launcherRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false, active: true, lx: r.left, ly: r.top };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onLauncherMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d.active) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return; // tap threshold — below this it's a click
    d.moved = true;
    const el = launcherRef.current;
    const w = el?.offsetWidth ?? 52, h = el?.offsetHeight ?? 52;
    const nx = Math.min(Math.max(0, d.ox + dx), window.innerWidth - w);
    const ny = Math.min(Math.max(0, d.oy + dy), window.innerHeight - h);
    d.lx = nx; d.ly = ny;
    setPos({ x: nx, y: ny });
  };
  const onLauncherUp = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d.active) return;
    d.active = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d.moved) { try { window.localStorage.setItem("nexus_ai_pos", JSON.stringify({ x: d.lx, y: d.ly })); } catch { /* ignore */ } }
    else { openPanel(); } // it was a tap, not a drag
  };
  // Keep a saved position on-screen if the window shrinks.
  useEffect(() => {
    if (!pos) return;
    const clamp = () => {
      const el = launcherRef.current;
      const w = el?.offsetWidth ?? 52, h = el?.offsetHeight ?? 52;
      setPos((p) => {
        if (!p) return p;
        const nx = Math.min(Math.max(0, p.x), window.innerWidth - w);
        const ny = Math.min(Math.max(0, p.y), window.innerHeight - h);
        return nx === p.x && ny === p.y ? p : { x: nx, y: ny };
      });
    };
    clamp(); // clamp immediately too — mount/orientation change fires no resize event
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [pos]);

  // BYOK settings (persisted client-side).
  const [provider, setProvider] = useState<ProviderId>(
    () => (typeof window !== "undefined" && (window.localStorage.getItem(LS_PROVIDER) as ProviderId)) || "anthropic"
  );
  const [model, setModel] = useState<string>(() => loadModel(provider));
  const [apiKey, setApiKey] = useState<string>(
    () => (typeof window !== "undefined" && window.localStorage.getItem(LS_KEY(provider))) || ""
  );

  const [messages, setMessages] = useState<DisplayMsg[]>(loadChat);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<{ mode?: string; active?: boolean; hasPosition?: boolean } | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Fetch the models this key can actually access → avoids stale/retired model
  // ids (the 404 cause). Auto-correct the selected model if it's not in the list.
  useEffect(() => {
    if (!apiKey.trim()) { setAvailableModels([]); return; }
    let cancelled = false;
    listModels(provider, apiKey.trim()).then((ids) => {
      if (cancelled || !ids.length) return;
      setAvailableModels(ids);
      setModel((cur) => {
        const corrected = ids.includes(cur) ? cur : pickDefaultModel(provider, ids);
        if (corrected !== cur) window.localStorage.setItem(LS_MODEL(provider), corrected);
        return corrected;
      });
    });
    return () => { cancelled = true; };
  }, [provider, apiKey]);

  // Set + persist the model for the CURRENT provider. Used by explicit user
  // choices (and auto-correct) — NOT by the provider-switch loader, which would
  // otherwise write the previous provider's model into the new provider's slot
  // (an effect-ordering race).
  const chooseModel = (m: string) => {
    setModel(m);
    window.localStorage.setItem(LS_MODEL(provider), m);
  };

  // Persist provider.
  useEffect(() => { window.localStorage.setItem(LS_PROVIDER, provider); }, [provider]);
  // When provider changes, load that provider's own stored key + model (each
  // provider remembers its own — never carry a Claude model id onto OpenAI).
  useEffect(() => {
    setApiKey(window.localStorage.getItem(LS_KEY(provider)) || "");
    setModel(loadModel(provider));
  }, [provider]);

  // Pull agent state when the panel opens (best-effort).
  useEffect(() => {
    if (!open || !walletAddress) return;
    let cancelled = false;
    fetch(`${AGENT_API}/agent/${walletAddress}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const s = d?.state || {};
        const c = d?.config || {};
        setAgent({ mode: c.mode, active: !!s.active, hasPosition: !!s.current_position });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, walletAddress]);

  useEffect(() => {
    // Instant (not smooth) — keeps pinned to bottom during rapid token streaming.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  // Persist the conversation (capped) so it survives close/reload.
  useEffect(() => {
    try { window.localStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-CHAT_CAP))); } catch { /* ignore quota */ }
  }, [messages]);

  const saveKey = (k: string) => {
    setApiKey(k);
    window.localStorage.setItem(LS_KEY(provider), k);
  };

  const hasKey = apiKey.trim().length > 0;
  // Hosted PRO inference: PRO wallet → no key needed (we inject ours server-side).
  const hostedActive = useHosted && isPro && !!walletAddress;
  const ready = hostedActive || hasKey; // can the user chat?

  // Locally-computed (no API call) personalized hook — drives the first
  // conversation by surfacing a real leak the moment the panel opens.
  const personalInsight = (() => {
    const wr = performance?.win_rate_pct as number | null | undefined;
    const pnl = performance?.total_pnl as number | undefined;
    const worst = performance?.worst_trade as { symbol: string; pnl: number } | null | undefined;
    if (wr != null && wr >= 50 && typeof pnl === "number" && pnl < 0) {
      return {
        text: `You win ${wr}% of trades but you're down $${Math.abs(pnl).toFixed(0)} overall — ask me why.`,
        prompt: "I win more often than I lose but I'm down overall — analyze my closed trades and tell me exactly what to fix.",
      };
    }
    if (worst && typeof pnl === "number" && worst.pnl < 0 && Math.abs(worst.pnl) > Math.abs(pnl) && pnl < 0) {
      return {
        text: `One ${worst.symbol} trade (-$${Math.abs(worst.pnl).toFixed(0)}) is sinking your record — ask me how to fix it.`,
        prompt: `My worst trade was ${worst.symbol}. Analyze my closed trades and tell me how to stop single positions from blowing up my account.`,
      };
    }
    return null;
  })();

  // Context-aware starter prompts based on the page the user is on.
  const pageSuggestions = (() => {
    const p = location.pathname;
    const trader = p.match(/\/feed\/trader\/(0x[0-9a-fA-F]{40})/);
    if (trader) return ["Analyze this trader's track record", "How do they compare to the top callers?", "What's their best setup?"];
    const sym = p.match(/\/perp\/PERP_([A-Z0-9]+)_USDC/i);
    if (sym) { const s = sym[1].toUpperCase(); return [`What's ${s}'s funding & OI right now?`, `Draft me a thesis on ${s}`, `Is now a risky time to trade ${s}?`]; }
    if (p.startsWith("/lab")) return ["How's my track record?", "Draft me a thesis on BTC", "What's my agent doing right now?"];
    return ["What's BTC's funding rate right now?", "What's my agent doing right now?", "Who are the top agents on the leaderboard?"];
  })();

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    if (!ready) { setView("settings"); return; }

    const next: DisplayMsg[] = [...messages, { role: "user", content: text }];
    // Add an empty assistant placeholder that streamed tokens append to.
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setError(null);
    setLoading(true);

    const context = buildContextBlock({
      page: location.pathname,
      wallet: walletAddress,
      theses: theses.map((t) => ({ symbol: t.symbol, direction: t.direction, status: t.status, riskReward: t.riskReward })),
      agent,
      regime: null,
    });

    const appendToLast = (patch: (last: DisplayMsg) => DisplayMsg) =>
      setMessages((m) => {
        const copy = m.slice();
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant") copy[copy.length - 1] = patch(last);
        return copy;
      });

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // Hosted (PRO): sign a short-lived access challenge once, then route through
      // our proxy (no user key). Falls back to BYOK otherwise.
      const hosted = hostedActive && walletAddress ? await getHostedAccess(walletAddress) : undefined;
      const { toolsUsed } = await runChatStream({
        provider: hosted ? "anthropic" : provider,
        model: hosted ? hostedModel : model,
        apiKey: hosted ? "" : apiKey.trim(),
        hosted,
        signal: controller.signal,
        system: `${SYSTEM_PROMPT}\n\n${context}`,
        history: next.map(({ role, content }) => ({ role, content })),
        ctx: {
          wallet: walletAddress,
          navigate: (p: string) => navigate(p),
          openPositions: ((posStream?.rows as unknown as Record<string, unknown>[] | undefined) ?? [])
            .map((p) => ({
              symbol: String(p.symbol ?? ""),
              qty: Number(p.position_qty ?? 0),
              entry: Number(p.average_open_price ?? 0),
              mark: Number(p.mark_price ?? 0),
              pnl: Number(p.unrealized_pnl ?? p.unsettled_pnl ?? 0),
            }))
            .filter((p) => Math.abs(p.qty) > 0),
          performance,
        },
        onDelta: (chunk) => appendToLast((last) => ({ ...last, content: last.content + chunk })),
      });
      appendToLast((last) => ({ ...last, tools: toolsUsed }));
    } catch (e) {
      // User-initiated stop keeps whatever streamed so far.
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : "Request failed.");
        // Drop the empty placeholder if nothing streamed.
        setMessages((m) => {
          const last = m[m.length - 1];
          return last && last.role === "assistant" && !last.content ? m.slice(0, -1) : m;
        });
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  // ── Floating launcher ──
  if (!open) {
    return (
      <div
        ref={launcherRef}
        style={{
          position: "fixed", zIndex: 99998, display: "flex", alignItems: "center", gap: 10,
          ...(pos ? { left: pos.x, top: pos.y } : { right: 16, bottom: 16 }),
        }}
      >
        {!seen && !pos && (
          <>
            <style>{`@keyframes nexAiPulse{0%,100%{box-shadow:0 0 14px rgba(0,255,136,0.35)}50%{box-shadow:0 0 22px rgba(0,255,136,0.85)}}`}</style>
            <div
              onClick={openPanel}
              style={{
                cursor: "pointer", background: "#0a1a0a", border: `1px solid ${GREEN}`, borderRadius: 6,
                padding: "8px 12px", maxWidth: 200, boxShadow: "0 0 16px rgba(0,0,0,0.5)",
              }}
            >
              <div style={{ fontFamily: mono, fontSize: 10, color: GREEN, fontWeight: "bold", letterSpacing: "0.06em" }}>✦ Meet // NEXUS AI</div>
              <div style={{ fontFamily: mono, fontSize: 8.5, color: "#8aaa9a", lineHeight: 1.5, marginTop: 2 }}>
                Your trading copilot — ask about the market, your positions, or your track record.
              </div>
            </div>
          </>
        )}
        <button
          onPointerDown={onLauncherDown}
          onPointerMove={onLauncherMove}
          onPointerUp={onLauncherUp}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPanel(); } }}
          aria-label="Nexus AI Assistant (drag to move, tap to open)"
          title="Nexus AI — tap to open, hold & drag to move"
          style={{
            width: 52, height: 52, borderRadius: "50%",
            background: "#0a1a0a", border: `1px solid ${GREEN}`,
            color: GREEN, fontFamily: mono, fontSize: 20, cursor: "grab",
            boxShadow: "0 0 16px rgba(0,255,136,0.35)", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            animation: seen ? undefined : "nexAiPulse 2s infinite",
            touchAction: "none", userSelect: "none",
          }}
        >
          ◆
        </button>
      </div>
    );
  }

  const panelW = isMobile ? "100vw" : 400;
  const panelH = isMobile ? "80dvh" : 560;

  return (
    <div
      style={{
        position: "fixed", right: isMobile ? 0 : 16, bottom: isMobile ? 0 : 16, zIndex: 99999,
        width: panelW, height: panelH, maxWidth: "100vw",
        background: "#080c08", border: `1px solid ${GREEN}`,
        borderRadius: isMobile ? "10px 10px 0 0" : 8, overflow: "hidden",
        display: "flex", flexDirection: "column",
        boxShadow: "0 0 24px rgba(0,0,0,0.6)",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid #1a2e1a", background: "#0a1a0a" }}>
        <span style={{ fontFamily: mono, fontSize: 12, fontWeight: "bold", letterSpacing: "0.18em" }}>
          <span style={{ color: GREEN, textShadow: "0 0 10px rgba(0,255,136,0.5)" }}>//</span>
          <span style={{ color: "#fff" }}> NEXUS AI</span>
        </span>
        <span style={{ fontFamily: mono, fontSize: 8, color: "#4a7a5a" }}>{hostedActive ? `Hosted · ${HOSTED_TIERS.find((t) => t.id === hostedModel)?.label ?? hostedModel}` : `${PROVIDERS[provider].label.split(" ")[0]} · ${model}`}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={() => setView(view === "settings" ? "chat" : "settings")} title="Settings"
            style={btn(view === "settings")}>⚙</button>
          <button onClick={() => { setMessages([]); setError(null); }} title="New chat" style={btn(false)}>✎</button>
          <button onClick={() => setOpen(false)} title="Close" style={btn(false)}>✕</button>
        </div>
      </div>

      {view === "settings" ? (
        <SettingsView
          provider={provider} setProvider={setProvider}
          model={model} setModel={chooseModel}
          apiKey={apiKey} saveKey={saveKey}
          availableModels={availableModels}
          isPro={isPro} useHosted={useHosted} setHosted={setHosted}
          hostedModel={hostedModel} setHostedModel={chooseHostedModel}
          onDone={() => setView("chat")}
        />
      ) : (
        <>
          {/* Messages */}
          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.length === 0 && (
              <div style={{ fontFamily: mono, fontSize: 10, color: "#4a7a5a", lineHeight: 1.7 }}>
                {ready
                  ? "Ask about your theses, agent, the market, or a trade idea. I can see your live session context."
                  : "Start with Nexus Hosted (PRO — no key needed) or bring your own API key. Tap ⚙ to set it up."}
                {personalInsight && (
                  <div
                    onClick={() => ready && setInput(personalInsight.prompt)}
                    style={{
                      marginTop: 12, padding: "9px 11px", borderRadius: 5,
                      background: "#1a1206", border: "1px solid #4a3a00",
                      cursor: ready ? "pointer" : "default",
                    }}
                  >
                    <div style={{ fontFamily: mono, fontSize: 9, color: "#fbbf24", fontWeight: "bold", letterSpacing: "0.04em", marginBottom: 2 }}>⚠ TRADING INSIGHT</div>
                    <div style={{ fontFamily: mono, fontSize: 10, color: "#d8c89a", lineHeight: 1.5 }}>{personalInsight.text}</div>
                  </div>
                )}
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {pageSuggestions.map((s) => (
                    <button key={s} onClick={() => setInput(s)} disabled={!ready}
                      style={{ textAlign: "left", background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4, color: ready ? "#8aaa9a" : "#2a4a3a", fontFamily: mono, fontSize: 10, padding: "6px 9px", cursor: ready ? "pointer" : "default" }}>
                      → {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%", display: "flex", flexDirection: "column", gap: 4 }}>
                {m.tools && m.tools.length > 0 && (
                  <div style={{ fontFamily: mono, fontSize: 8, color: "#4a7a5a", letterSpacing: "0.04em" }}>
                    ⚡ {[...new Set(m.tools)].join(" · ")}
                  </div>
                )}
                <div style={{
                  background: m.role === "user" ? "#0a1a0a" : "#0d120d",
                  border: `1px solid ${m.role === "user" ? "#1a4a2a" : "#1a2e1a"}`,
                  borderRadius: 8, padding: "8px 11px",
                  fontFamily: mono, fontSize: 11, lineHeight: 1.55,
                  color: m.role === "user" ? GREEN : "#c8d8c8", whiteSpace: "pre-wrap", wordBreak: "break-word",
                }}>
                  {m.role === "assistant" ? renderRich(m.content) : m.content}
                </div>
                {m.role === "assistant" && <CopyBtn text={m.content} />}
              </div>
            ))}
            {loading && !messages[messages.length - 1]?.content && (
              <div style={{ fontFamily: mono, fontSize: 10, color: "#4a7a5a" }}>thinking…</div>
            )}
            {error && <div style={{ fontFamily: mono, fontSize: 10, color: "#ff6b6b", lineHeight: 1.5 }}>⚠ {error}</div>}
          </div>

          {/* Composer */}
          <div style={{ borderTop: "1px solid #1a2e1a", padding: 10, display: "flex", gap: 8, alignItems: "flex-end", background: "#0a0e0a" }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={ready ? "Ask Nexus AI…" : "Enable hosted (PRO) or set a key in ⚙"}
              rows={1}
              style={{
                flex: 1, background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4,
                color: GREEN, fontFamily: mono, fontSize: 11, padding: "8px 10px", outline: "none",
                resize: "none", maxHeight: 100, minHeight: 36,
              }}
            />
            {loading ? (
              <button onClick={stop} title="Stop"
                style={{ background: "#1a0a0a", border: "1px solid #ff6b6b", borderRadius: 4, color: "#ff6b6b", fontFamily: mono, fontSize: 13, padding: "8px 12px", cursor: "pointer" }}>■</button>
            ) : (
              <button onClick={send} disabled={!input.trim()}
                style={{
                  background: input.trim() ? "#0a1a0a" : "#080c08",
                  border: `1px solid ${input.trim() ? GREEN : "#1a2e1a"}`,
                  borderRadius: 4, color: input.trim() ? GREEN : "#2a4a3a",
                  fontFamily: mono, fontSize: 14, padding: "8px 12px", cursor: input.trim() ? "pointer" : "default",
                }}>↑</button>
            )}
          </div>
          <div style={{ fontFamily: mono, fontSize: 7.5, color: "#2a4a3a", textAlign: "center", padding: "0 8px 6px" }}>
            Analysis & education only — not financial advice. Key stays on your device.
          </div>
        </>
      )}
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
      style={{ alignSelf: "flex-start", background: "none", border: "none", color: copied ? GREEN : "#2a4a3a", fontFamily: mono, fontSize: 8, cursor: "pointer", padding: "1px 0" }}
    >
      {copied ? "✓ copied" : "⧉ copy"}
    </button>
  );
}

function btn(active: boolean): React.CSSProperties {
  return {
    background: active ? "#0a1a0a" : "none", border: `1px solid ${active ? "#00ff88" : "#1a2e1a"}`,
    borderRadius: 3, color: active ? "#00ff88" : "#8aaa9a", fontFamily: mono, fontSize: 11,
    width: 24, height: 24, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
  };
}

function SettingsView({
  provider, setProvider, model, setModel, apiKey, saveKey, availableModels, isPro, useHosted, setHosted,
  hostedModel, setHostedModel, onDone,
}: {
  provider: ProviderId; setProvider: (p: ProviderId) => void;
  model: string; setModel: (m: string) => void;
  apiKey: string; saveKey: (k: string) => void;
  availableModels: string[];
  isPro: boolean; useHosted: boolean; setHosted: (v: boolean) => void;
  hostedModel: string; setHostedModel: (m: string) => void;
  onDone: () => void;
}) {
  const def = PROVIDERS[provider];
  const modelChoices = availableModels.length ? availableModels : def.models;
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Hosted (PRO) — no key needed; we inject ours server-side for PRO wallets. */}
      <div style={{ border: `1px solid ${useHosted && isPro ? GREEN : "#1a2e1a"}`, borderRadius: 6, padding: 12, background: "#0a120a" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div style={{ fontFamily: mono, fontSize: 11, color: GREEN, fontWeight: "bold" }}>◆ NEXUS HOSTED <span style={{ color: "#8aaa9a", fontWeight: "normal" }}>· PRO</span></div>
            <div style={{ fontFamily: mono, fontSize: 9, color: "#8aaa9a", lineHeight: 1.5, marginTop: 3 }}>
              {isPro ? "Run NEXUS AI with no API key — we host it. One wallet signature per session." : "Hosted AI is a PRO benefit. Subscribe or hold ARCHITECT $NEXUS to enable."}
            </div>
          </div>
          <button
            onClick={() => { if (isPro) setHosted(!useHosted); }}
            disabled={!isPro}
            title={isPro ? "Toggle hosted inference" : "PRO required"}
            style={{
              flexShrink: 0, fontFamily: mono, fontSize: 10, fontWeight: "bold", borderRadius: 3, padding: "6px 14px",
              cursor: isPro ? "pointer" : "default",
              background: useHosted && isPro ? "#00ff8815" : "#0d120d",
              border: `1px solid ${useHosted && isPro ? GREEN : "#1a2e1a"}`,
              color: !isPro ? "#3a5a4a" : useHosted ? GREEN : "#8aaa9a",
            }}>
            {useHosted && isPro ? "ON" : "OFF"}
          </button>
        </div>

        {/* Model tier — stronger model = lower daily cap, cheaper = higher cap. */}
        {useHosted && isPro && (
          <div style={{ marginTop: 12, borderTop: "1px solid #1a2e1a", paddingTop: 10 }}>
            <div style={{ fontFamily: mono, fontSize: 8, color: "#8aaa9a", letterSpacing: "0.12em", marginBottom: 6 }}>MODEL TIER · DAILY CAP</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {HOSTED_TIERS.map((t) => {
                const on = hostedModel === t.id;
                return (
                  <button key={t.id} onClick={() => setHostedModel(t.id)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, textAlign: "left",
                      background: on ? "#0a1a0a" : "#0d120d", border: `1px solid ${on ? GREEN : "#1a2e1a"}`,
                      borderRadius: 4, padding: "7px 10px", cursor: "pointer",
                    }}>
                    <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontFamily: mono, fontSize: 10, color: on ? GREEN : "#7aaa8a", fontWeight: "bold" }}>{t.label}</span>
                      <span style={{ fontFamily: mono, fontSize: 8, color: "#8aaa9a" }}>{t.note}</span>
                    </span>
                    <span style={{ fontFamily: mono, fontSize: 10, color: on ? GREEN : "#8aaa9a", fontWeight: "bold", flexShrink: 0 }}>{t.cap}/day</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div style={{ fontFamily: mono, fontSize: 10, color: "#8aaa9a", lineHeight: 1.6 }}>
        {useHosted && isPro
          ? "Hosted is ON — no key needed. Or bring your own key below to use a different provider/model."
          : <>Bring your own model key. It's stored only in this browser (localStorage) and sent <b style={{ color: GREEN }}>directly</b> to the provider — never to Nexus servers.</>}
      </div>

      <Field label="PROVIDER">
        <div style={{ display: "flex", gap: 6 }}>
          {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
            <button key={p} onClick={() => setProvider(p)}
              style={{
                flex: 1, background: provider === p ? "#0a1a0a" : "#0d120d",
                border: `1px solid ${provider === p ? GREEN : "#1a2e1a"}`, borderRadius: 4,
                color: provider === p ? GREEN : "#8aaa9a", fontFamily: mono, fontSize: 10, padding: "7px 6px", cursor: "pointer",
              }}>
              {PROVIDERS[p].label}
            </button>
          ))}
        </div>
      </Field>

      <Field label={availableModels.length ? "MODEL (from your key)" : "MODEL"}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 120, overflowY: "auto" }}>
          {modelChoices.map((mdl) => (
            <button key={mdl} onClick={() => setModel(mdl)}
              style={{
                background: model === mdl ? "#0a1a0a" : "#0d120d",
                border: `1px solid ${model === mdl ? GREEN : "#1a2e1a"}`, borderRadius: 4,
                color: model === mdl ? GREEN : "#8aaa9a", fontFamily: mono, fontSize: 9, padding: "5px 9px", cursor: "pointer",
              }}>
              {mdl}
            </button>
          ))}
        </div>
        {!availableModels.length && (
          <div style={{ fontFamily: mono, fontSize: 8, color: "#4a7a5a" }}>
            Enter your key below to load your account's exact model list.
          </div>
        )}
        <input
          value={model} onChange={(e) => setModel(e.target.value)}
          placeholder="or type a model id"
          style={inputStyle}
        />
      </Field>

      <Field label={`API KEY (${def.label})`}>
        <input
          type="password" value={apiKey} onChange={(e) => saveKey(e.target.value)}
          placeholder={def.keyHint} autoComplete="off" spellCheck={false}
          style={inputStyle}
        />
      </Field>

      <button onClick={onDone}
        style={{ background: "#0a1a0a", border: `1px solid ${GREEN}`, borderRadius: 4, color: GREEN, fontFamily: mono, fontSize: 11, padding: "9px", cursor: "pointer", letterSpacing: "0.08em" }}>
        {apiKey.trim() ? "DONE →" : "SAVE KEY TO CONTINUE"}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontFamily: mono, fontSize: 8, color: "#4a7a5a", letterSpacing: "0.1em" }}>{label}</div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4,
  color: "#00ff88", fontFamily: mono, fontSize: 10, padding: "8px 10px", outline: "none", width: "100%", boxSizing: "border-box",
};
