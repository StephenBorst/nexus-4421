/**
 * Nexus AI Assistant — config + provider plumbing (single source of truth).
 *
 * v1 is BYOK, CLIENT-SIDE ONLY: the user's API key lives in localStorage and the
 * browser calls the model provider directly. The key NEVER touches a Nexus
 * server, so we carry zero key-custody liability. Hosted inference (pay in
 * $NEXUS / USDC) is a later iteration that routes through a worker.
 *
 * No SDKs — we hit the providers' REST APIs with fetch to keep the bundle light.
 */

export type ProviderId = "anthropic" | "openai";

export interface ProviderDef {
  id: ProviderId;
  label: string;
  endpoint: string;
  defaultModel: string;
  models: string[];
  keyHint: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    endpoint: "https://api.anthropic.com/v1/messages",
    // Current 4.x defaults shown before a key is entered; the live /v1/models
    // list (fetched from the user's key) replaces these once available.
    defaultModel: "claude-sonnet-4-6",
    models: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"],
    keyHint: "sk-ant-…",
  },
  openai: {
    id: "openai",
    label: "OpenAI (GPT)",
    endpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini"],
    keyHint: "sk-…",
  },
};

// localStorage keys (client-side only).
export const LS_PROVIDER = "nexus_ai_provider";
export const LS_MODEL = (p: ProviderId) => `nexus_ai_model_${p}`; // per-provider model
export const LS_KEY = (p: ProviderId) => `nexus_ai_key_${p}`;     // per-provider key

import { anthropicTools, openaiTools, TOOL_BY_NAME, type ToolCtx } from "@/config/assistantTools";

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface RunResult {
  text: string;
  toolsUsed: string[];
}

const MAX_TOOL_ROUNDS = 5; // bound the agentic loop

/**
 * System prompt — the assistant's identity + the advice/Howey guardrail. Trading
 * commentary stays analytical and educational; never a personalized "buy/sell"
 * directive. Nexus-specific context is appended at call time.
 */
export const SYSTEM_PROMPT = `You are the Nexus AI Assistant, a copilot built into Nexus Trading Labs — a perpetual DEX trading terminal on Arbitrum (powered by Orderly Network).

Your job: help the trader understand the market, reason about their own theses, agent, and track record, and become a better, more disciplined trader. You have access to live context about the user's session (current page, their planned theses, autonomous agent state, market regime) which is provided below.

HARD RULES:
- You are NOT a licensed financial advisor. Never give personalized investment advice or direct "buy/sell/hold this now" instructions. Frame everything as analysis, education, and helping the user reason — the decision is always theirs.
- Be precise and concise. This is a terminal; traders want signal, not fluff.
- When you reference the user's data, use the context provided — don't invent positions or numbers.
- If asked about something outside the provided context or your knowledge, say so plainly.
- Match the terminal's voice: sharp, technical, no hype.
- The chat panel is NARROW (~380px). Keep answers compact. Prefer short paragraphs and tight bullet lists; AVOID wide markdown tables (they don't fit). Use **bold** for key labels/numbers.

You have TOOLS:
- Read live data: market data (price/funding/OI), broad market regime (Fear & Greed, market-cap change, BTC dominance), the user's LIVE open positions (real exchange exposure + unrealized PnL), the user's agent status, the trustless top-agents leaderboard, the verified human-caller leaderboard. Call them whenever a question needs current numbers — don't guess prices or stats you can fetch.
- Take actions (navigation + planning only, NEVER order execution): open_symbol (open a coin's trade page), open_trader, open_leaderboard, and draft_thesis (pre-fill the Thesis Engine with a trade plan for the user to review). When you draft a thesis, base the levels on real data (fetch the market first if needed) and make the risk/reward sane; tell the user you've drafted it and that they should review sizing/risk before saving — you never place the order yourself.`;

/** Build the per-request context block injected after the system prompt. */
export function buildContextBlock(ctx: {
  page: string;
  wallet: string | null;
  theses: { symbol: string; direction: string; status: string; riskReward?: number }[];
  agent: { mode?: string; active?: boolean; hasPosition?: boolean } | null;
  regime?: string | null;
}): string {
  const lines: string[] = ["--- LIVE SESSION CONTEXT ---"];
  lines.push(`Current page: ${ctx.page}`);
  lines.push(`Wallet: ${ctx.wallet ? ctx.wallet : "not connected"}`);
  if (ctx.regime) lines.push(`Market regime: ${ctx.regime}`);
  if (ctx.agent) {
    lines.push(
      `Agent: ${ctx.agent.active ? "ACTIVE" : "inactive"}` +
        (ctx.agent.mode ? ` (${ctx.agent.mode})` : "") +
        (ctx.agent.hasPosition ? " — holding a position" : "")
    );
  }
  if (ctx.theses.length) {
    lines.push(`User's theses (${ctx.theses.length}):`);
    for (const t of ctx.theses.slice(0, 12)) {
      const sym = t.symbol.replace("PERP_", "").replace("_USDC", "");
      lines.push(`  • ${sym} ${t.direction} — ${t.status}${t.riskReward ? ` (R:R 1:${t.riskReward.toFixed(2)})` : ""}`);
    }
  } else {
    lines.push("User has no saved theses yet.");
  }
  lines.push("--- END CONTEXT ---");
  return lines.join("\n");
}

/**
 * Send a chat turn to the selected provider directly from the browser.
 * Returns the assistant's reply text. Throws on auth/network errors.
 */
export async function sendChat(opts: {
  provider: ProviderId;
  model: string;
  apiKey: string;
  system: string;
  history: ChatMsg[];
}): Promise<string> {
  const { provider, model, apiKey, system, history } = opts;

  if (provider === "anthropic") {
    const res = await fetch(PROVIDERS.anthropic.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(await errText(res));
    const data = await res.json();
    return data?.content?.[0]?.text ?? "(empty response)";
  }

  // openai
  const res = await fetch(PROVIDERS.openai.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...history.map((m) => ({ role: m.role, content: m.content }))],
    }),
  });
  if (!res.ok) throw new Error(await errText(res));
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "(empty response)";
}

/**
 * Agentic chat: runs a bounded tool-use loop so the model can pull live Nexus
 * data (market, agent status, leaderboards) before answering. Same BYOK,
 * client-side, both providers. Returns the final text + which tools were used.
 */
export async function runChat(opts: {
  provider: ProviderId;
  model: string;
  apiKey: string;
  system: string;
  history: ChatMsg[];
  ctx: ToolCtx;
  signal?: AbortSignal;
}): Promise<RunResult> {
  return opts.provider === "anthropic" ? runAnthropic(opts) : runOpenAI(opts);
}

async function runAnthropic(opts: {
  model: string; apiKey: string; system: string; history: ChatMsg[]; ctx: ToolCtx; signal?: AbortSignal;
}): Promise<RunResult> {
  const { model, apiKey, system, history, ctx, signal } = opts;
  const messages: { role: string; content: unknown }[] = history.map((m) => ({ role: m.role, content: m.content }));
  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(PROVIDERS.anthropic.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, max_tokens: 1024, system, tools: anthropicTools(), messages }),
      signal,
    });
    if (!res.ok) throw new Error(await errText(res));
    const data = await res.json();
    const content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[] = data?.content ?? [];

    if (data?.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content });
      const results: unknown[] = [];
      for (const block of content) {
        if (block.type !== "tool_use" || !block.name) continue;
        toolsUsed.push(block.name);
        const out = await runTool(block.name, block.input ?? {}, ctx);
        results.push({ type: "tool_result", tool_use_id: block.id, content: out });
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return { text: text || "(empty response)", toolsUsed };
  }
  return { text: "Stopped after too many tool calls — try narrowing the question.", toolsUsed };
}

async function runOpenAI(opts: {
  model: string; apiKey: string; system: string; history: ChatMsg[]; ctx: ToolCtx; signal?: AbortSignal;
}): Promise<RunResult> {
  const { model, apiKey, system, history, ctx, signal } = opts;
  const messages: Record<string, unknown>[] = [
    { role: "system", content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(PROVIDERS.openai.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools: openaiTools(), tool_choice: "auto" }),
      signal,
    });
    if (!res.ok) throw new Error(await errText(res));
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    const toolCalls: { id: string; function: { name: string; arguments: string } }[] = msg?.tool_calls ?? [];

    if (toolCalls.length) {
      messages.push(msg);
      for (const tc of toolCalls) {
        toolsUsed.push(tc.function.name);
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* keep {} */ }
        const out = await runTool(tc.function.name, args, ctx);
        messages.push({ role: "tool", tool_call_id: tc.id, content: out });
      }
      continue;
    }
    return { text: msg?.content ?? "(empty response)", toolsUsed };
  }
  return { text: "Stopped after too many tool calls — try narrowing the question.", toolsUsed };
}

async function runTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const tool = TOOL_BY_NAME[name];
  if (!tool) return JSON.stringify({ error: `unknown tool: ${name}` });
  try {
    return await tool.run(input, ctx);
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : "tool failed" });
  }
}

/**
 * List the models the given key can actually access, so the UI never offers a
 * stale/retired model id (the cause of 404s). Best-effort: returns [] on failure
 * and the UI falls back to the static defaults + the free-text model field.
 */
export async function listModels(provider: ProviderId, apiKey: string): Promise<string[]> {
  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.data ?? []).map((m: { id: string }) => m.id).filter(Boolean);
    }
    // openai — filter the (large) list to chat-capable model families.
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.data ?? [])
      .map((m: { id: string }) => m.id)
      .filter((id: string) => /^(gpt-|chatgpt|o\d)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id))
      .sort();
  } catch {
    return [];
  }
}

async function errText(res: Response): Promise<string> {
  let detail = "";
  try {
    const j = await res.json();
    detail = j?.error?.message || JSON.stringify(j).slice(0, 200);
  } catch {
    detail = await res.text().catch(() => "");
  }
  if (res.status === 401) return "Invalid API key (401). Check your key in settings.";
  if (res.status === 429) return "Rate limited / quota exceeded (429).";
  return `Request failed (${res.status}). ${detail}`.trim();
}
