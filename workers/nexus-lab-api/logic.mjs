// ═══════════════════════════════════════════════════════════
// Pure, testable logic for nexus-lab-api.
// Imported by index.js so tests cover the real deployed behavior.
// ═══════════════════════════════════════════════════════════

/**
 * Grade a human "call" (thesis) against public OHLC candles, first-touch.
 * Trustless: the outcome is a fact about public price, not self-report.
 * - LONG  wins if a candle high reaches takeProfit1 before a low hits stopLoss
 * - SHORT wins if a candle low reaches takeProfit1 before a high hits stopLoss
 * - Same-candle TP+SL = LOSS (conservative, anti-gaming)
 * - WIN scores +planned R (riskReward, default 1); LOSS = -1R
 *
 * @param {object} t  thesis { direction, entryPrice, stopLoss, takeProfit1, createdAt, riskReward }
 * @param {object} cd candles { t:number[] (sec), h:number[], l:number[] } ascending by t
 * @returns {{ outcome:"WIN"|"LOSS"|"PENDING"|"INVALID", r:number }}
 */
export function gradeCall(t, cd) {
  const { direction, entryPrice, stopLoss, takeProfit1, createdAt, riskReward } = t;
  if (!entryPrice || !stopLoss || !takeProfit1 || !cd) return { outcome: "INVALID", r: 0 };
  const startSec = Math.floor((createdAt || 0) / 1000);
  const R = (typeof riskReward === "number" && riskReward > 0) ? riskReward : 1;
  for (let i = 0; i < cd.t.length; i++) {
    if (cd.t[i] < startSec) continue;
    const hi = cd.h[i], lo = cd.l[i];
    if (direction === "LONG") {
      const tp = hi >= takeProfit1, sl = lo <= stopLoss;
      if (tp && sl) return { outcome: "LOSS", r: -1 };
      if (tp) return { outcome: "WIN", r: R };
      if (sl) return { outcome: "LOSS", r: -1 };
    } else {
      const tp = lo <= takeProfit1, sl = hi >= stopLoss;
      if (tp && sl) return { outcome: "LOSS", r: -1 };
      if (tp) return { outcome: "WIN", r: R };
      if (sl) return { outcome: "LOSS", r: -1 };
    }
  }
  return { outcome: "PENDING", r: 0 };
}

// ── PRO subscription payment verification ───────────────────────────────────
// Pure: given an eth_getTransactionReceipt result, decide whether it contains a
// qualifying ERC-20 (USDC) Transfer to the subscription receiver, and who paid.
// No network here — the caller fetches the receipt and persists the grant.
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function verifyErc20Payment(receipt, { token, receiver, minAmount }) {
  if (!receipt || receipt.status !== "0x1") return { ok: false, reason: "tx not successful" };
  const tokenL = String(token).toLowerCase();
  const recvTopic = "0x" + String(receiver).toLowerCase().slice(2).padStart(64, "0");
  for (const log of receipt.logs || []) {
    if ((log.address || "").toLowerCase() !== tokenL) continue;
    if (!log.topics || log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if ((log.topics[2] || "").toLowerCase() !== recvTopic) continue;
    let amount;
    try { amount = BigInt(log.data); } catch { continue; }
    if (amount >= minAmount) {
      const from = "0x" + (log.topics[1] || "").slice(-40);
      return { ok: true, from: from.toLowerCase(), amount: amount.toString() };
    }
  }
  return { ok: false, reason: "no qualifying transfer to receiver" };
}

// Minimum token units we'll accept for a $NEXUS-denominated payment, given a live
// USD price, the target USD amount, and a tolerance band (low-liquidity token moves
// between quote and settlement). Pure — caller supplies the price. Returns BigInt
// (token base units) or null if unpriceable.
export function nexusMinUnits(priceUsd, discountUsd, tolerance, decimals = 18) {
  if (!(priceUsd > 0) || !(discountUsd > 0)) return null;
  const wholeTokens = Math.floor((discountUsd / priceUsd) * (1 - tolerance));
  if (!(wholeTokens > 0)) return null;
  return BigInt(wholeTokens) * (10n ** BigInt(decimals));
}

// ── Hosted NEXUS AI model tiers ─────────────────────────────────────────────
// PRO users pick which model the hosted proxy runs; each model carries its OWN
// daily cap so our LLM spend scales with model cost. Stronger model → lower cap;
// cheaper model → higher cap (the user trades model strength for volume). Rates
// per MTok (in/out): Haiku $1/$5 · Sonnet $3/$15 · Opus $5/$25. Default is Sonnet
// (the everyday tier) — Opus is the scarce "big gun". Caps are env-overridable
// (HOSTED_CAP_HAIKU/SONNET/OPUS) for tuning without a code change, and the default
// tier via HOSTED_AI_DEFAULT_MODEL (legacy HOSTED_AI_MODEL still honored as the
// default source). Mirrored on the client in app/config/assistant.ts (HOSTED_TIERS).
export const HOSTED_DEFAULT_MODEL = "claude-sonnet-4-6";

export function hostedCaps(env = {}) {
  return {
    "claude-haiku-4-5": parseInt(env.HOSTED_CAP_HAIKU || "100", 10),
    "claude-sonnet-4-6": parseInt(env.HOSTED_CAP_SONNET || "40", 10),
    "claude-opus-4-8": parseInt(env.HOSTED_CAP_OPUS || "20", 10),
  };
}

// Resolve a client-requested hosted model → an allowed model + its daily cap.
// Whitelist-gated: an unknown / stale / injected id falls back to the default
// tier, so a client can never force an off-list (or arbitrarily expensive) model.
export function resolveHostedModel(requested, env = {}) {
  const caps = hostedCaps(env);
  const wanted = env.HOSTED_AI_DEFAULT_MODEL || env.HOSTED_AI_MODEL || HOSTED_DEFAULT_MODEL;
  const fallback = caps[wanted] != null ? wanted : HOSTED_DEFAULT_MODEL;
  const model = caps[requested] != null ? requested : fallback;
  return { model, cap: caps[model] };
}

// ── Hosted-AI upstream selection (direct Anthropic vs Bankr LLM Gateway) ──────
// Default = Anthropic direct (our ANTHROPIC_API_KEY). When AI_GATEWAY="bankr" and
// BANKR_LLM_KEY is set, route /ai/chat through the Bankr LLM Gateway instead — it's
// Anthropic-compatible (/v1/messages, auth via X-API-Key bk_…), so the request body
// (incl. cache_control) carries over. One env flip A/Bs the gateway against direct
// and falls back instantly. Per-model daily caps stay keyed on the Anthropic-style
// id (resolveHostedModel), so spend accounting is provider-independent.
export const BANKR_GATEWAY_URL = "https://llm.bankr.bot/v1/messages";

// The gateway names models in dot-notation (claude-opus-4.8) vs Anthropic's hyphen
// ids (claude-opus-4-8). Map each tier; every leg is env-overridable so the exact
// gateway id can be corrected from GET https://llm.bankr.bot/v1/models without a
// code change. Unknown ids pass through untouched.
export function bankrGatewayModel(anthropicId, env = {}) {
  const map = {
    "claude-haiku-4-5":  env.BANKR_MODEL_HAIKU  || "claude-haiku-4.5",
    "claude-sonnet-4-6": env.BANKR_MODEL_SONNET || "claude-sonnet-4.6",
    "claude-opus-4-8":   env.BANKR_MODEL_OPUS   || "claude-opus-4.8",
  };
  return map[anthropicId] || anthropicId;
}

// Decide where /ai/chat forwards. `hostedModel` is the Anthropic-style id from
// resolveHostedModel. Returns null if the selected provider isn't configured
// (caller → 503). Header is "x-api-key" for both providers (HTTP headers are
// case-insensitive, so it satisfies Bankr's X-API-Key and Anthropic's x-api-key).
export function resolveAiUpstream(hostedModel, env = {}) {
  if (env.AI_GATEWAY === "bankr" && env.BANKR_LLM_KEY) {
    return {
      provider: "bankr",
      url: BANKR_GATEWAY_URL,
      apiKey: env.BANKR_LLM_KEY,
      model: bankrGatewayModel(hostedModel, env),
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      apiKey: env.ANTHROPIC_API_KEY,
      model: hostedModel,
    };
  }
  return null;
}
