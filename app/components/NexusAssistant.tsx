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
import { useAccount, usePrivateQuery } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { useIsMobile } from "@/pages/lab/useIsMobile";
import {
  PROVIDERS, LS_PROVIDER, LS_MODEL, LS_KEY, SYSTEM_PROMPT,
  buildContextBlock, runChatStream, listModels, type ProviderId, type ChatMsg,
} from "@/config/assistant";

function pickDefaultModel(provider: ProviderId, ids: string[]): string {
  if (provider === "anthropic") return ids.find((i) => /sonnet/.test(i)) || ids.find((i) => /opus/.test(i)) || ids[0];
  return ids.find((i) => i === "gpt-4o") || ids.find((i) => /^gpt-4/.test(i)) || ids[0];
}

const AGENT_API = "https://og.nexustradinglabs.com";
const mono = "monospace";
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
            <th key={k} style={{ textAlign: "left", color: "#5a8a6a", borderBottom: "1px solid #1a2e1a", padding: "2px 8px 2px 0", fontWeight: "bold" }}>{inline(h)}</th>
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
  const { theses } = useLabStorage(walletAddress);
  const { data: posData } = usePrivateQuery("/v1/positions", { revalidateOnFocus: false });
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
    if (!hasKey) { setView("settings"); return; }

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
      const { toolsUsed } = await runChatStream({
        provider, model, apiKey: apiKey.trim(),
        signal: controller.signal,
        system: `${SYSTEM_PROMPT}\n\n${context}`,
        history: next.map(({ role, content }) => ({ role, content })),
        ctx: {
          wallet: walletAddress,
          navigate: (p: string) => navigate(p),
          openPositions: (((posData as { rows?: Record<string, unknown>[] })?.rows) ?? [])
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
      <button
        onClick={() => setOpen(true)}
        aria-label="Nexus AI Assistant"
        title="Nexus AI Assistant"
        style={{
          position: "fixed", right: 16, bottom: 16, zIndex: 99998,
          width: 52, height: 52, borderRadius: "50%",
          background: "#0a1a0a", border: `1px solid ${GREEN}`,
          color: GREEN, fontFamily: mono, fontSize: 20, cursor: "pointer",
          boxShadow: "0 0 16px rgba(0,255,136,0.35)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        ◆
      </button>
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
        <span style={{ fontFamily: mono, fontSize: 8, color: "#3a6a4a" }}>{PROVIDERS[provider].label.split(" ")[0]} · {model}</span>
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
          onDone={() => setView("chat")}
        />
      ) : (
        <>
          {/* Messages */}
          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.length === 0 && (
              <div style={{ fontFamily: mono, fontSize: 10, color: "#3a6a4a", lineHeight: 1.7 }}>
                {hasKey
                  ? "Ask about your theses, agent, the market, or a trade idea. I can see your live session context."
                  : "Bring your own API key (Anthropic or OpenAI) to start — it stays on your device, never sent to Nexus. Tap ⚙ to set it up."}
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {pageSuggestions.map((s) => (
                    <button key={s} onClick={() => setInput(s)} disabled={!hasKey}
                      style={{ textAlign: "left", background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4, color: hasKey ? "#8aaa9a" : "#2a4a3a", fontFamily: mono, fontSize: 10, padding: "6px 9px", cursor: hasKey ? "pointer" : "default" }}>
                      → {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%", display: "flex", flexDirection: "column", gap: 4 }}>
                {m.tools && m.tools.length > 0 && (
                  <div style={{ fontFamily: mono, fontSize: 8, color: "#3a6a4a", letterSpacing: "0.04em" }}>
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
              <div style={{ fontFamily: mono, fontSize: 10, color: "#3a6a4a" }}>thinking…</div>
            )}
            {error && <div style={{ fontFamily: mono, fontSize: 10, color: "#ff6b6b", lineHeight: 1.5 }}>⚠ {error}</div>}
          </div>

          {/* Composer */}
          <div style={{ borderTop: "1px solid #1a2e1a", padding: 10, display: "flex", gap: 8, alignItems: "flex-end", background: "#0a0e0a" }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={hasKey ? "Ask Nexus AI…" : "Set your API key in ⚙ first"}
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
    borderRadius: 3, color: active ? "#00ff88" : "#5a8a6a", fontFamily: mono, fontSize: 11,
    width: 24, height: 24, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
  };
}

function SettingsView({
  provider, setProvider, model, setModel, apiKey, saveKey, availableModels, onDone,
}: {
  provider: ProviderId; setProvider: (p: ProviderId) => void;
  model: string; setModel: (m: string) => void;
  apiKey: string; saveKey: (k: string) => void;
  availableModels: string[];
  onDone: () => void;
}) {
  const def = PROVIDERS[provider];
  const modelChoices = availableModels.length ? availableModels : def.models;
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontFamily: mono, fontSize: 10, color: "#8aaa9a", lineHeight: 1.6 }}>
        Bring your own model key. It's stored only in this browser (localStorage) and sent <b style={{ color: GREEN }}>directly</b> to the provider — never to Nexus servers.
      </div>

      <Field label="PROVIDER">
        <div style={{ display: "flex", gap: 6 }}>
          {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
            <button key={p} onClick={() => setProvider(p)}
              style={{
                flex: 1, background: provider === p ? "#0a1a0a" : "#0d120d",
                border: `1px solid ${provider === p ? GREEN : "#1a2e1a"}`, borderRadius: 4,
                color: provider === p ? GREEN : "#5a8a6a", fontFamily: mono, fontSize: 10, padding: "7px 6px", cursor: "pointer",
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
                color: model === mdl ? GREEN : "#5a8a6a", fontFamily: mono, fontSize: 9, padding: "5px 9px", cursor: "pointer",
              }}>
              {mdl}
            </button>
          ))}
        </div>
        {!availableModels.length && (
          <div style={{ fontFamily: mono, fontSize: 8, color: "#3a6a4a" }}>
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
      <div style={{ fontFamily: mono, fontSize: 8, color: "#3a6a4a", letterSpacing: "0.1em" }}>{label}</div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4,
  color: "#00ff88", fontFamily: mono, fontSize: 10, padding: "8px 10px", outline: "none", width: "100%", boxSizing: "border-box",
};
