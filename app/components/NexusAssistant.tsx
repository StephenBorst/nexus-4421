/**
 * NexusAssistant — floating AI copilot (v1).
 *
 * BYOK, client-side only: the user brings their own Anthropic/OpenAI key, stored
 * in localStorage; the browser calls the provider directly (key never hits a
 * Nexus server). Injects live session context (page, theses, agent, wallet) so
 * it's a Nexus-native copilot, not a generic chatbot. Free with BYOK; hosted
 * inference (pay in $NEXUS / USDC) is a later iteration.
 */

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAccount } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { useIsMobile } from "@/pages/lab/useIsMobile";
import {
  PROVIDERS, LS_PROVIDER, LS_MODEL, LS_KEY, SYSTEM_PROMPT,
  buildContextBlock, sendChat, type ProviderId, type ChatMsg,
} from "@/config/assistant";

const AGENT_API = "https://og.nexustradinglabs.com";
const mono = "monospace";
const GREEN = "#00ff88";

export default function NexusAssistant() {
  const { state: acct } = useAccount();
  const walletAddress = (acct as { address?: string })?.address ?? null;
  const { theses } = useLabStorage(walletAddress);
  const location = useLocation();
  const isMobile = useIsMobile();

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "settings">("chat");

  // BYOK settings (persisted client-side).
  const [provider, setProvider] = useState<ProviderId>(
    () => (typeof window !== "undefined" && (window.localStorage.getItem(LS_PROVIDER) as ProviderId)) || "anthropic"
  );
  const [model, setModel] = useState<string>(
    () => (typeof window !== "undefined" && window.localStorage.getItem(LS_MODEL)) || PROVIDERS[provider].defaultModel
  );
  const [apiKey, setApiKey] = useState<string>(
    () => (typeof window !== "undefined" && window.localStorage.getItem(LS_KEY(provider))) || ""
  );

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<{ mode?: string; active?: boolean; hasPosition?: boolean } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Persist settings.
  useEffect(() => { window.localStorage.setItem(LS_PROVIDER, provider); }, [provider]);
  useEffect(() => { window.localStorage.setItem(LS_MODEL, model); }, [model]);
  // When provider changes, load that provider's stored key + default model.
  useEffect(() => {
    setApiKey(window.localStorage.getItem(LS_KEY(provider)) || "");
    setModel(window.localStorage.getItem(LS_MODEL) || PROVIDERS[provider].defaultModel);
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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const saveKey = (k: string) => {
    setApiKey(k);
    window.localStorage.setItem(LS_KEY(provider), k);
  };

  const hasKey = apiKey.trim().length > 0;

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    if (!hasKey) { setView("settings"); return; }

    const next: ChatMsg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
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

    try {
      const reply = await sendChat({
        provider, model, apiKey: apiKey.trim(),
        system: `${SYSTEM_PROMPT}\n\n${context}`,
        history: next,
      });
      setMessages((m) => [...m, { role: "assistant", content: reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setLoading(false);
    }
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
        <span style={{ fontFamily: mono, fontSize: 12, fontWeight: "bold", color: GREEN, letterSpacing: "0.08em" }}>◆ NEXUS AI</span>
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
          model={model} setModel={setModel}
          apiKey={apiKey} saveKey={saveKey}
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
                  {["Grade my open theses by R:R", "What's my agent doing right now?", "Explain funding-rate edge trading"].map((s) => (
                    <button key={s} onClick={() => setInput(s)} disabled={!hasKey}
                      style={{ textAlign: "left", background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4, color: hasKey ? "#8aaa9a" : "#2a4a3a", fontFamily: mono, fontSize: 10, padding: "6px 9px", cursor: hasKey ? "pointer" : "default" }}>
                      → {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%",
                background: m.role === "user" ? "#0a1a0a" : "#0d120d",
                border: `1px solid ${m.role === "user" ? "#1a4a2a" : "#1a2e1a"}`,
                borderRadius: 8, padding: "8px 11px",
                fontFamily: mono, fontSize: 11, lineHeight: 1.55,
                color: m.role === "user" ? GREEN : "#c8d8c8", whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}>
                {m.content}
              </div>
            ))}
            {loading && <div style={{ fontFamily: mono, fontSize: 10, color: "#3a6a4a" }}>thinking…</div>}
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
            <button onClick={send} disabled={loading || !input.trim()}
              style={{
                background: input.trim() && !loading ? "#0a1a0a" : "#080c08",
                border: `1px solid ${input.trim() && !loading ? GREEN : "#1a2e1a"}`,
                borderRadius: 4, color: input.trim() && !loading ? GREEN : "#2a4a3a",
                fontFamily: mono, fontSize: 14, padding: "8px 12px", cursor: input.trim() && !loading ? "pointer" : "default",
              }}>↑</button>
          </div>
          <div style={{ fontFamily: mono, fontSize: 7.5, color: "#2a4a3a", textAlign: "center", padding: "0 8px 6px" }}>
            Analysis & education only — not financial advice. Key stays on your device.
          </div>
        </>
      )}
    </div>
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
  provider, setProvider, model, setModel, apiKey, saveKey, onDone,
}: {
  provider: ProviderId; setProvider: (p: ProviderId) => void;
  model: string; setModel: (m: string) => void;
  apiKey: string; saveKey: (k: string) => void;
  onDone: () => void;
}) {
  const def = PROVIDERS[provider];
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

      <Field label="MODEL">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {def.models.map((mdl) => (
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
