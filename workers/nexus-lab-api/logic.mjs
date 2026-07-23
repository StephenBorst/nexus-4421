import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes, bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

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

// ── Merit rank (identity ladder) ─────────────────────────────────────────────
// A rank EARNED purely from a caller's public-price-graded record — distinct from
// the $NEXUS holder tiers (which are bought/held). This is "proven right", not
// "paid for". Thresholds rise with both sample size and quality so it can't be
// farmed with a few lucky calls. stats = { calls, wins, rSum } from
// computeCallerStats. Returns null when unranked (emerging or net-negative).
export function rankCaller(stats) {
  const calls = stats?.calls || 0;
  if (calls < 5) return null;                 // still emerging — not yet ranked
  const hitRate = stats.wins / calls;          // 0..1
  const avgR = stats.rSum / calls;
  if (avgR <= 0) return null;                  // net-negative by R → unranked (board rule)
  if (calls >= 30 && hitRate >= 0.55 && avgR >= 1.0) return { tier: "APEX", title: "Apex", glyph: "✦" };
  if (calls >= 15 && hitRate >= 0.50 && avgR >= 0.5) return { tier: "SHARP", title: "Sharp", glyph: "◆" };
  return { tier: "SIGNAL", title: "Signal", glyph: "▪" };
}

// ── Signal-webhook ingestion (TradingView / bring-your-own-signal) ───────────
// External signals can't wallet-sign, so the per-user secret token in the URL is
// the auth (it only authorizes order placement on the order-only key, and is
// rotatable). This pure layer just normalizes + validates the alert payload; the
// route writes the result to KV for the exec cron to pick up through the normal
// pipeline (inheriting every guardrail). Tested.

// Normalize a symbol from many shapes (BTC, BTCUSDT, BTC/USDC, PERP_BTC_USDC) to
// the Orderly perp id PERP_<BASE>_USDC. Returns null if unrecognizable.
export function normalizeSymbol(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (/^PERP_[A-Z0-9]+_USDC$/.test(s)) return s;          // already canonical
  s = s.replace(/[\/\-_]/g, "").replace(/^PERP/, "");      // strip separators + PERP prefix
  s = s.replace(/(USDC|USDT|USD)$/g, "");                  // strip quote suffix
  if (!/^[A-Z0-9]{1,15}$/.test(s)) return null;
  return `PERP_${s}_USDC`;
}

// Parse + validate an inbound webhook alert into a normalized intent.
// action mapping (perp semantics): BUY/LONG → open long · SELL/SHORT → open short ·
// CLOSE/EXIT/FLAT → close the open position. Returns { ok, action, direction,
// symbol, sizeOverride } or { ok:false, error }.
export function parseWebhookAlert(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "empty body" };
  const raw = String(body.action ?? body.side ?? "").trim().toUpperCase();
  let action, direction = null;
  if (["CLOSE", "EXIT", "FLAT"].includes(raw)) action = "CLOSE";
  else if (["BUY", "LONG"].includes(raw)) { action = "OPEN"; direction = "LONG"; }
  else if (["SELL", "SHORT"].includes(raw)) { action = "OPEN"; direction = "SHORT"; }
  else return { ok: false, error: `unknown action "${raw}" (use BUY/SELL/CLOSE)` };

  // CLOSE doesn't strictly need a symbol (close whatever's open), but accept one.
  const symbol = normalizeSymbol(body.symbol ?? body.ticker);
  if (action === "OPEN" && !symbol) return { ok: false, error: "missing/invalid symbol" };

  const sizeOverride = Number(body.size) > 0 ? Number(body.size) : null;
  return { ok: true, action, direction, symbol, sizeOverride };
}

// ── Funding / OI percentile-vs-history ───────────────────────────────────────
// Context beats a raw number: "funding 0.02%" means little; "funding in the 95th
// percentile of the last 90 days" means the crowd is extremely long. Computed off
// the oi:hist:{symbol} series the brain records ({t,price,oi,funding}). Pure+tested.

// % of samples <= x (0..100). null on empty.
export function percentileRank(values, x) {
  if (!Array.isArray(values) || !values.length) return null;
  const below = values.reduce((n, v) => n + (v <= x ? 1 : 0), 0);
  return Math.round((below / values.length) * 100);
}

// Current funding/OI + their percentile vs the recorded history. Needs a minimum
// sample so early (thin) history doesn't lie — returns { building:true } until then.
export function oiStats(series, minSamples = 12) {
  if (!Array.isArray(series) || series.length < 2) return { building: true, samples: series?.length || 0 };
  const last = series[series.length - 1];
  const fundings = series.map((p) => p.funding).filter(Number.isFinite);
  const ois = series.map((p) => p.oi).filter(Number.isFinite);
  const stat = (arr, val) => {
    const s = [...arr].sort((a, b) => a - b);
    return { value: val, pct: percentileRank(arr, val), min: s[0], max: s[s.length - 1] };
  };
  return {
    building: series.length < minSamples,
    samples: series.length,
    funding: stat(fundings, last.funding),
    oi: stat(ois, last.oi),
  };
}

// ── Agent leaderboard eligibility + score ────────────────────────────────────
// Shared by /agents/leaderboard (the public ranking) and /agents/standing/:addr
// (a single agent's "why am I / am I not ranked" readout) so the two can never
// drift. The gate is anti-gaming: a meaningful sample, spread over time, and
// actually net-positive (we won't surface a losing agent as "top").
export const AGENT_BOARD = { minTrades: 10, minDays: 3, fullConfTrades: 30 };

// Aggregate a wallet's closed trades into raw counters. rows = [{ pnl, closed_at }].
export function aggregateAgentTrades(rows) {
  let trades = 0, wins = 0, net = 0, grossWin = 0, grossLoss = 0, first = Infinity, last = 0;
  for (const r of rows || []) {
    const pnl = parseFloat(r.pnl) || 0;
    const closed = new Date(r.closed_at).getTime() || 0;
    trades++; net += pnl;
    if (pnl > 0) { wins++; grossWin += pnl; } else { grossLoss += Math.abs(pnl); }
    if (closed) { first = Math.min(first, closed); last = Math.max(last, closed); }
  }
  const daysActive = first === Infinity ? 0 : Math.max(1, Math.round((last - first) / 86400000));
  return { trades, wins, net, grossWin, grossLoss, daysActive, firstTradeAt: first === Infinity ? 0 : first };
}

// Risk-adjusted 0–100 score: win rate + capped profit factor, shrunk by sample
// size so a lucky 3-trade run can't outrank a proven record.
export function agentScore(a, cfg = AGENT_BOARD) {
  const winRate = a.trades ? a.wins / a.trades : 0;
  const profitFactor = a.grossLoss > 0 ? a.grossWin / a.grossLoss : (a.grossWin > 0 ? 99 : 0);
  const pfScore = Math.min(profitFactor, 5) / 5;
  const sampleConf = Math.min(1, a.trades / cfg.fullConfTrades);
  const score = Math.round((0.5 * winRate + 0.5 * pfScore) * sampleConf * 1000) / 10;
  return { winRate, profitFactor, score };
}

// Per-agent eligibility breakdown for the UI readout: each criterion with its
// met/unmet flag + current value, plus the derived stats. `eligible` is the AND
// of all criteria — identical to the leaderboard's inclusion test.
export function agentStanding(a, cfg = AGENT_BOARD) {
  const { winRate, profitFactor, score } = agentScore(a, cfg);
  const criteria = [
    { key: "trades", label: `${cfg.minTrades}+ closed trades`, met: a.trades >= cfg.minTrades, value: a.trades, target: cfg.minTrades },
    { key: "days", label: `active ${cfg.minDays}+ days`, met: a.daysActive >= cfg.minDays, value: a.daysActive, target: cfg.minDays },
    { key: "profitable", label: "net-positive P&L", met: a.net > 0, value: Math.round(a.net * 100) / 100, target: 0 },
  ];
  const eligible = criteria.every((c) => c.met);
  return {
    eligible,
    metCount: criteria.filter((c) => c.met).length,
    total: criteria.length,
    criteria,
    stats: {
      trades: a.trades, daysActive: a.daysActive,
      winRate: Math.round(winRate * 1000) / 10,
      netPnl: Math.round(a.net * 100) / 100,
      profitFactor: Math.round(Math.min(profitFactor, 99) * 100) / 100,
      score,
      // Full-lifetime averages so the LIVE track-record card reads the TRUE record
      // (the /agent GET only ships the last 50 rows — computing avgWin/avgLoss from
      // that truncated set undercounts once an agent passes 50 trades).
      avgWin: a.wins ? Math.round((a.grossWin / a.wins) * 100) / 100 : 0,
      avgLoss: (a.trades - a.wins) ? Math.round((a.grossLoss / (a.trades - a.wins)) * 100) / 100 : 0,
      firstTradeAt: a.firstTradeAt || 0,
    },
  };
}

// ── Funding + OI-divergence + confluence classification ──────────────────────
// Mirrors the agent brain's deriveSignal rules (funding extreme FADES the crowd;
// OI-divergence; confluence = both agree) so the public /signals API and the
// autonomous agent can't drift in spirit. Pure + tested. raw = { fundingRate,
// priceChange, oiChange, hasPrev } as DECIMALS (e.g. 0.0001 = 0.01%).
export function confluenceSignal(raw, opts = {}) {
  const fundingThreshold = (opts.fundingThreshold ?? 0.01) / 100;
  const oiChangeThreshold = (opts.oiChangeThreshold ?? 0) / 100;
  const f = raw.fundingRate || 0, p = raw.priceChange || 0, oi = raw.oiChange || 0;
  const fundingSignal = f >= fundingThreshold ? "SHORT" : f <= -fundingThreshold ? "LONG" : "NONE";
  let oiSignal = "NONE";
  if (raw.hasPrev && Math.abs(oi) >= oiChangeThreshold && oi !== 0) {
    if (p > 0 && oi < 0) oiSignal = "SHORT";       // price up, OI down → fade
    else if (p < 0 && oi > 0) oiSignal = "LONG";   // price down, OI up → fade
    else if (p > 0 && oi > 0) oiSignal = "LONG";   // strong up → follow
    else if (p < 0 && oi < 0) oiSignal = "SHORT";  // strong down → follow
  }
  const confluence = fundingSignal !== "NONE" && fundingSignal === oiSignal ? fundingSignal : "NONE";
  return { fundingSignal, oiSignal, confluence };
}

// ── Request-bound (v2) signing ───────────────────────────────────────────────
// The legacy auth signs a STATIC message ("nexus-trading-key-v1"), so its
// signature is deterministic — a single captured walletSig is a permanent bearer
// token good for trade/withdraw/agent-control until the key rotates. v2 binds each
// high-risk action to a single request: the client signs a server-issued challenge
// carrying a single-use nonce + the exact action + amount + domain + a short expiry.
// A leaked signature then can't be replayed for a different action/amount, can't be
// reused after it expires, and can't be reused at all (the nonce is burned on first
// verify by the caller). Pure here — ecrecover is injected as `recover` so this
// stays crypto/network-free and unit-testable; index.js passes recoverEthAddress.
export const AUTH_V2_DOMAIN = "og.nexustradinglabs.com";
export const AUTH_V2_ACTIONS = new Set([
  "trade", "withdraw",
  "agent.activate", "agent.mode", "agent.config", "agent.deactivate", "agent.kill",
]);

// Canonical challenge string — the ONE format both client and server build, so the
// recovered signature is meaningful only for these exact fields. amount is "-" when
// not applicable (reads/control with no value at risk). wallet lower-cased so the
// hash never depends on checksum casing.
export function buildChallenge({ action, wallet, nonce, amount, expires, domain = AUTH_V2_DOMAIN }) {
  const amt = (amount === undefined || amount === null || amount === "") ? "-" : String(amount);
  return [
    "nexus:v2",
    `action:${action}`,
    `wallet:${String(wallet).toLowerCase()}`,
    `nonce:${nonce}`,
    `amount:${amt}`,
    `domain:${domain}`,
    `expires:${expires}`,
  ].join("\n");
}

// Verify a v2 signature against the TRUSTED challenge record the server minted +
// stored (never client-supplied fields), binding it to what the request actually
// does. Steps: action allowed → not expired → the request's action/amount/wallet
// match the signed record → ecrecover(challenge) === record.wallet. Returns
// { ok:true, wallet } or { ok:false, reason }. The caller is responsible for the
// nonce lifecycle (exists/unconsumed in KV, then burn on success) — replay defense
// lives at the KV layer; this function is the pure binding+expiry+signer check.
export function verifyV2({ record, sig, expected, now, recover, domain = AUTH_V2_DOMAIN }) {
  if (!record || typeof record !== "object") return { ok: false, reason: "no challenge record" };
  const { action, wallet, nonce, amount, expires } = record;
  if (!AUTH_V2_ACTIONS.has(action)) return { ok: false, reason: "action not allowed" };
  if (typeof sig !== "string" || !sig) return { ok: false, reason: "missing signature" };
  if (!Number.isFinite(now) || !Number.isFinite(expires)) return { ok: false, reason: "bad timestamps" };
  if (now > expires) return { ok: false, reason: "challenge expired" };

  const walletL = String(wallet).toLowerCase();
  const norm = (v) => (v === undefined || v === null || v === "" ? "-" : String(v));
  if (expected) {
    if (expected.action !== action) return { ok: false, reason: "action mismatch" };
    if (norm(expected.amount) !== norm(amount)) return { ok: false, reason: "amount mismatch" };
    if (expected.wallet !== undefined && String(expected.wallet).toLowerCase() !== walletL)
      return { ok: false, reason: "wallet mismatch" };
  }

  const challenge = buildChallenge({ action, wallet: walletL, nonce, amount, expires, domain });
  let recovered;
  try { recovered = recover(challenge, sig); } catch { return { ok: false, reason: "recover threw" }; }
  if (!recovered || String(recovered).toLowerCase() !== walletL)
    return { ok: false, reason: "signature does not match wallet" };

  return { ok: true, wallet: walletL };
}

// ── Orderly account_id derivation ────────────────────────────────────────────
// Orderly derives a DETERMINISTIC account id from (wallet, brokerId):
//   accountId = keccak256(abi.encode(address, keccak256(bytes(brokerId))))
// abi.encode of (address,bytes32) == 12 zero bytes + 20-byte address + 32-byte hash.
//
// This is the whole unlock for a public wallet x-ray on Orderly: the dashboard
// indexer is keyed by account_id (not address), so without this we could only
// x-ray wallets that happen to appear in the top-200 PnL ranking. With it, any
// address can be resolved for any broker — no auth, no ranking dependency.
// Verified against live indexer rows (see logic.test.mjs vectors).
export function orderlyAccountId(address, brokerId) {
  const clean = String(address || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error("invalid address");
  if (!brokerId) throw new Error("brokerId required");
  const buf = new Uint8Array(64);
  buf.set(hexToBytes(clean), 12);                       // left-pad address to 32B
  buf.set(keccak_256(utf8ToBytes(String(brokerId))), 32); // brokerHash
  return "0x" + bytesToHex(keccak_256(buf));
}

// ── Catalyst search mapping ("why is X moving") ──────────────────────────────
// A perp ticker is a poor news query: "CL" pulls nothing about crude oil, "BZ"
// nothing about Brent, and a bare "SOL" mixes Solana with unrelated noise. This
// maps a bare ticker → a human search query + a display name + an asset class, so
// the /intel/catalysts route can pull RELEVANT headlines for commodities, equities,
// and majors, and bias the query with "crypto" only when the asset actually is.
// Not exhaustive across 100+ markets by design — the ambiguous TradFi/commodity/
// meme tickers are named explicitly; everything else falls back to crypto (the vast
// majority of the book). Pure + tested.
const ASSET_MAP = {
  // majors (crypto)
  BTC: ["Bitcoin", "crypto"], ETH: ["Ethereum", "crypto"], SOL: ["Solana", "crypto"],
  BNB: ["BNB Binance", "crypto"], XRP: ["XRP Ripple", "crypto"], DOGE: ["Dogecoin", "crypto"],
  ADA: ["Cardano", "crypto"], AVAX: ["Avalanche", "crypto"], LINK: ["Chainlink", "crypto"],
  ARB: ["Arbitrum", "crypto"], OP: ["Optimism crypto", "crypto"], SUI: ["Sui crypto", "crypto"],
  TON: ["Toncoin", "crypto"], TRX: ["Tron crypto", "crypto"], LTC: ["Litecoin", "crypto"],
  // memes (crypto) — bare tickers are hopeless queries
  WIF: ["dogwifhat", "crypto"], PEPE: ["Pepe coin", "crypto"], BONK: ["Bonk crypto", "crypto"],
  TRUMP: ["Official Trump coin", "crypto"], FARTCOIN: ["Fartcoin", "crypto"],
  // commodities (TradFi)
  CL: ["WTI crude oil", "commodity"], BZ: ["Brent crude oil", "commodity"],
  NG: ["natural gas price", "commodity"], GC: ["gold price", "commodity"],
  SI: ["silver price", "commodity"], HG: ["copper price", "commodity"],
  // equities / equity-linked
  MSTR: ["MicroStrategy Strategy stock", "equity"], COIN: ["Coinbase stock", "equity"],
  HOOD: ["Robinhood stock", "equity"], NVDA: ["Nvidia stock", "equity"],
  TSLA: ["Tesla stock", "equity"], AAPL: ["Apple stock", "equity"],
  SPX: ["S&P 500", "equity"], NDX: ["Nasdaq 100", "equity"], WLFI: ["World Liberty Financial", "crypto"],
};

export function symbolToQuery(ticker) {
  const t = String(ticker || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "").replace(/[^A-Z0-9]/g, "");
  if (!t) return null;
  const hit = ASSET_MAP[t];
  if (hit) return { ticker: t, name: hit[0], query: hit[0], assetClass: hit[1] };
  // Fallback: unknown ticker → assume crypto (the book is overwhelmingly crypto).
  // The "crypto" qualifier keeps a short/ambiguous ticker from pulling equity noise.
  return { ticker: t, name: t, query: `${t} crypto`, assetClass: "crypto" };
}

// ── Chart image URL gate (SSRF guard) ────────────────────────────────────────
// The OG card embeds a thesis's chartUrl, which means the WORKER fetches a URL that
// came from user data. That is a server-side request forgery vector — the frontend's
// allowlist protects browsers, not us. Everything below runs BEFORE any fetch.
//
// Mirrors app/pages/lab/helpers.ts#chartImageSrc. Host match is exact-or-dot-suffix so
// "s3.tradingview.com.evil.com" cannot pass, which a naive includes() would allow.
export const CHART_HOSTS = [
  "s3.tradingview.com",
  "www.tradingview.com",
  "tradingview.com",
  "i.imgur.com",
  "imgur.com",
  "pbs.twimg.com",
];

/** Returns a safe https chart URL, or null. Never throws. */
export function safeChartUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const ok = CHART_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return ok ? u.toString() : null;
}
