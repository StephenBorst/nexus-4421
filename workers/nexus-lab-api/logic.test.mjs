// Trustless call-grading tests for nexus-lab-api.
// Run: node --test workers/nexus-lab-api/logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  gradeCall, resolveAiUpstream, bankrGatewayModel, rankCaller, confluenceSignal,
  orderlyAccountId, safeChartUrl, symbolToQuery,
  classifyRegime, callAlignment, regimeBucketsOf, regimeBuckets, regimeEdge,
  planQuality, planSummary,
  expectancyStats, callerScore, convictionCalibration, contestedBoard,
  mispricedBoard, consensusBySymbol, MISPRICED, fundingReversion, edgeQuality, mergeFundingPrice,
  LOSS_REASONS, isLossReason, postmortemSummary,
  validateArenaRegistration, arenaAgentConfig,
  parsePriceTarget, forecastDivergence, FORECAST,
  classifyMacro, macroEvents,
  houseCallFromSignal, wargameScenario,
} from "./logic.mjs";

// Helper: candle series starting at t0 (sec), each 1h apart.
const series = (t0, bars) => ({
  t: bars.map((_, i) => t0 + i * 3600),
  h: bars.map((b) => b.h),
  l: bars.map((b) => b.l),
});

const baseLong = { direction: "LONG", entryPrice: 100, stopLoss: 95, takeProfit1: 110, riskReward: 2, createdAt: 1_000_000 * 1000 };
const t0 = 1_000_000; // sec == createdAt/1000

test("LONG win: high reaches TP1 first → +R", () => {
  const cd = series(t0, [{ h: 105, l: 99 }, { h: 111, l: 104 }]);
  const g = gradeCall(baseLong, cd);
  assert.equal(g.outcome, "WIN");
  assert.equal(g.r, 2);
});

test("LONG loss: low hits SL first → -1R", () => {
  const cd = series(t0, [{ h: 102, l: 94 }, { h: 111, l: 100 }]);
  const g = gradeCall(baseLong, cd);
  assert.equal(g.outcome, "LOSS");
  assert.equal(g.r, -1);
});

test("same-candle TP+SL = LOSS (conservative)", () => {
  const cd = series(t0, [{ h: 111, l: 94 }]); // both touched in one bar
  assert.equal(gradeCall(baseLong, cd).outcome, "LOSS");
});

test("first-touch ordering respected across bars", () => {
  // SL bar comes before TP bar → LOSS even though TP later reached
  const cd = series(t0, [{ h: 101, l: 94 }, { h: 120, l: 100 }]);
  assert.equal(gradeCall(baseLong, cd).outcome, "LOSS");
});

test("candles before the call timestamp are ignored", () => {
  // Pre-call bar would have hit SL, but it's before createdAt → ignored; later TP wins
  const cd = { t: [t0 - 7200, t0 - 3600, t0, t0 + 3600], h: [90, 90, 105, 111], l: [80, 80, 99, 104] };
  assert.equal(gradeCall(baseLong, cd).outcome, "WIN");
});

test("PENDING when neither level touched", () => {
  const cd = series(t0, [{ h: 108, l: 96 }, { h: 109, l: 97 }]);
  assert.equal(gradeCall(baseLong, cd).outcome, "PENDING");
});

test("SHORT is inverted (low=TP, high=SL)", () => {
  const short = { direction: "SHORT", entryPrice: 100, stopLoss: 105, takeProfit1: 90, riskReward: 1.5, createdAt: t0 * 1000 };
  assert.equal(gradeCall(short, series(t0, [{ h: 101, l: 89 }])).outcome, "WIN"); // low hit TP
  assert.equal(gradeCall(short, series(t0, [{ h: 106, l: 99 }])).outcome, "LOSS"); // high hit SL
  assert.equal(gradeCall(short, series(t0, [{ h: 106, l: 89 }])).outcome, "LOSS"); // same-candle → loss
});

test("INVALID on missing levels or candles", () => {
  assert.equal(gradeCall({ ...baseLong, takeProfit1: 0 }, series(t0, [{ h: 111, l: 99 }])).outcome, "INVALID");
  assert.equal(gradeCall(baseLong, null).outcome, "INVALID");
});

test("default R is 1 when riskReward missing/invalid", () => {
  const noRR = { direction: "LONG", entryPrice: 100, stopLoss: 95, takeProfit1: 110, createdAt: t0 * 1000 };
  assert.equal(gradeCall(noRR, series(t0, [{ h: 111, l: 99 }])).r, 1);
});

// ── verifyErc20Payment (PRO subscription rail) ──────────────
import { verifyErc20Payment, ERC20_TRANSFER_TOPIC } from "./logic.mjs";

const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const RECV = "0x06cD9c281E6ab09906B46a10e059F2770EfdE49A";
const PAYER = "0x1111111111111111111111111111111111111111";
const toTopic = (a) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const mkReceipt = (over = {}) => ({
  status: "0x1",
  logs: [{
    address: USDC,
    topics: [ERC20_TRANSFER_TOPIC, toTopic(PAYER), toTopic(RECV)],
    data: "0x" + (20n * 1000000n).toString(16), // 20 USDC (6 decimals)
  }],
  ...over,
});
const MIN = 198n * 100000n; // 19.8 USDC

test("verifyErc20Payment: valid 20 USDC transfer to receiver → ok + payer", () => {
  const v = verifyErc20Payment(mkReceipt(), { token: USDC, receiver: RECV, minAmount: MIN });
  assert.equal(v.ok, true);
  assert.equal(v.from, PAYER.toLowerCase());
});

test("verifyErc20Payment: failed tx → not ok", () => {
  const v = verifyErc20Payment(mkReceipt({ status: "0x0" }), { token: USDC, receiver: RECV, minAmount: MIN });
  assert.equal(v.ok, false);
});

test("verifyErc20Payment: amount below min → not ok", () => {
  const logs = [{ address: USDC, topics: [ERC20_TRANSFER_TOPIC, toTopic(PAYER), toTopic(RECV)], data: "0x" + (5n * 1000000n).toString(16) }];
  const v = verifyErc20Payment({ status: "0x1", logs }, { token: USDC, receiver: RECV, minAmount: MIN });
  assert.equal(v.ok, false);
});

test("verifyErc20Payment: transfer to a DIFFERENT receiver → not ok", () => {
  const other = "0x9999999999999999999999999999999999999999";
  const logs = [{ address: USDC, topics: [ERC20_TRANSFER_TOPIC, toTopic(PAYER), toTopic(other)], data: "0x" + (20n * 1000000n).toString(16) }];
  const v = verifyErc20Payment({ status: "0x1", logs }, { token: USDC, receiver: RECV, minAmount: MIN });
  assert.equal(v.ok, false);
});

test("verifyErc20Payment: wrong token contract → not ok", () => {
  const logs = [{ address: "0xdead000000000000000000000000000000000000", topics: [ERC20_TRANSFER_TOPIC, toTopic(PAYER), toTopic(RECV)], data: "0x" + (20n * 1000000n).toString(16) }];
  const v = verifyErc20Payment({ status: "0x1", logs }, { token: USDC, receiver: RECV, minAmount: MIN });
  assert.equal(v.ok, false);
});

// ── nexusMinUnits (PRO $NEXUS discount path) ────────────────
import { nexusMinUnits, simCreditsFor } from "./logic.mjs";

test("simCreditsFor: USDC $1=1 credit, $NEXUS priced, floors partials", () => {
  // 5 USDC (6 dec), $1/token, $1/credit → 5 credits
  assert.equal(simCreditsFor(5n * 1000000n, { decimals: 6, usdPerToken: 1, usdPerCredit: 1 }), 5);
  // 2.5 USDC → floors to 2
  assert.equal(simCreditsFor(2500000n, { decimals: 6, usdPerToken: 1, usdPerCredit: 1 }), 2);
  // 10M $NEXUS (18 dec) at $0.0000005 = $5 → 5 credits
  assert.equal(simCreditsFor(10000000n * (10n ** 18n), { decimals: 18, usdPerToken: 0.0000005, usdPerCredit: 1 }), 5);
  // below $1 → 0
  assert.equal(simCreditsFor(500000n, { decimals: 6, usdPerToken: 1, usdPerCredit: 1 }), 0);
});

test("nexusMinUnits: $15 at $0.0000005, 12% tol → ~26.4M tokens in 18-dec units", () => {
  const u = nexusMinUnits(0.0000005, 15, 0.12);
  // 15/0.0000005 = 30,000,000 * 0.88 = 26,400,000 tokens
  assert.equal(u, 26400000n * (10n ** 18n));
});

test("nexusMinUnits: zero/invalid price → null", () => {
  assert.equal(nexusMinUnits(0, 15, 0.12), null);
  assert.equal(nexusMinUnits(-1, 15, 0.12), null);
});

test("nexusMinUnits: higher price → fewer tokens required", () => {
  const lo = nexusMinUnits(0.0000005, 15, 0.12);
  const hi = nexusMinUnits(0.000001, 15, 0.12);
  assert.ok(hi < lo);
});

// ── resolveHostedModel (per-model hosted AI caps) ────────────
import { resolveHostedModel, HOSTED_DEFAULT_MODEL } from "./logic.mjs";

test("resolveHostedModel: default (no request) → Sonnet @ 40/day", () => {
  const r = resolveHostedModel(undefined, {});
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.model, HOSTED_DEFAULT_MODEL);
  assert.equal(r.cap, 40);
});

test("resolveHostedModel: each whitelisted tier maps to its own cap", () => {
  assert.deepEqual(resolveHostedModel("claude-haiku-4-5", {}), { model: "claude-haiku-4-5", cap: 100 });
  assert.deepEqual(resolveHostedModel("claude-sonnet-4-6", {}), { model: "claude-sonnet-4-6", cap: 40 });
  assert.deepEqual(resolveHostedModel("claude-opus-4-8", {}), { model: "claude-opus-4-8", cap: 20 });
});

test("resolveHostedModel: unknown/injected id falls back to default tier", () => {
  for (const bad of ["claude-opus-4-7", "gpt-5.5", "claude-3-opus-20240229", "", "../etc"]) {
    const r = resolveHostedModel(bad, {});
    assert.equal(r.model, "claude-sonnet-4-6", `expected fallback for ${JSON.stringify(bad)}`);
    assert.equal(r.cap, 40);
  }
});

test("resolveHostedModel: env overrides caps + default tier", () => {
  const env = { HOSTED_CAP_OPUS: "5", HOSTED_CAP_HAIKU: "250", HOSTED_AI_DEFAULT_MODEL: "claude-haiku-4-5" };
  assert.equal(resolveHostedModel("claude-opus-4-8", env).cap, 5);
  assert.equal(resolveHostedModel("claude-haiku-4-5", env).cap, 250);
  // unknown → env default tier (Haiku), with its overridden cap
  assert.deepEqual(resolveHostedModel("nope", env), { model: "claude-haiku-4-5", cap: 250 });
});

test("resolveHostedModel: legacy HOSTED_AI_MODEL honored as default source", () => {
  const r = resolveHostedModel("nope", { HOSTED_AI_MODEL: "claude-opus-4-8" });
  assert.equal(r.model, "claude-opus-4-8");
  assert.equal(r.cap, 20);
});

// ── Hosted-AI upstream selection (Anthropic direct vs Bankr LLM Gateway) ──────
test("upstream defaults to Anthropic direct when only ANTHROPIC_API_KEY set", () => {
  const u = resolveAiUpstream("claude-sonnet-4-6", { ANTHROPIC_API_KEY: "sk-x" });
  assert.equal(u.provider, "anthropic");
  assert.equal(u.url, "https://api.anthropic.com/v1/messages");
  assert.equal(u.model, "claude-sonnet-4-6"); // unchanged hyphen id
  assert.equal(u.apiKey, "sk-x");
});

test("upstream routes to Bankr gateway when AI_GATEWAY=bankr + key, mapping the model id", () => {
  const u = resolveAiUpstream("claude-opus-4-8", { AI_GATEWAY: "bankr", BANKR_LLM_KEY: "bk-x", ANTHROPIC_API_KEY: "sk-x" });
  assert.equal(u.provider, "bankr");
  assert.equal(u.url, "https://llm.bankr.bot/v1/messages");
  assert.equal(u.model, "claude-opus-4.8"); // dot-notation for the gateway
  assert.equal(u.apiKey, "bk-x");
});

test("gateway flag without BANKR_LLM_KEY falls back to Anthropic", () => {
  const u = resolveAiUpstream("claude-sonnet-4-6", { AI_GATEWAY: "bankr", ANTHROPIC_API_KEY: "sk-x" });
  assert.equal(u.provider, "anthropic");
});

test("no provider configured → null (caller returns 503)", () => {
  assert.equal(resolveAiUpstream("claude-sonnet-4-6", {}), null);
  // gateway flag but neither key
  assert.equal(resolveAiUpstream("claude-sonnet-4-6", { AI_GATEWAY: "bankr" }), null);
});

test("bankrGatewayModel maps tiers, is env-overridable, passes unknown ids through", () => {
  assert.equal(bankrGatewayModel("claude-haiku-4-5"), "claude-haiku-4.5");
  assert.equal(bankrGatewayModel("claude-sonnet-4-6"), "claude-sonnet-4.6");
  assert.equal(bankrGatewayModel("claude-opus-4-8"), "claude-opus-4.8");
  assert.equal(bankrGatewayModel("claude-opus-4-8", { BANKR_MODEL_OPUS: "claude-opus-4.8-vertex" }), "claude-opus-4.8-vertex");
  assert.equal(bankrGatewayModel("something-else"), "something-else");
});

// ── rankCaller (merit identity ladder) ──────────────────────────────────────
test("rankCaller: under 5 calls → unranked (null)", () => {
  assert.equal(rankCaller({ calls: 4, wins: 4, rSum: 8 }), null);
});
test("rankCaller: net-negative R → unranked even with volume", () => {
  assert.equal(rankCaller({ calls: 40, wins: 10, rSum: -5 }), null);
});
test("rankCaller: 5+ calls net-positive → SIGNAL", () => {
  assert.equal(rankCaller({ calls: 6, wins: 3, rSum: 1.2 }).tier, "SIGNAL");
});
test("rankCaller: 15+ / 50% / avgR>=0.5 → SHARP", () => {
  assert.equal(rankCaller({ calls: 16, wins: 8, rSum: 9 }).tier, "SHARP"); // avgR≈0.56
});
test("rankCaller: 30+ / 55% / avgR>=1 → APEX", () => {
  assert.equal(rankCaller({ calls: 30, wins: 18, rSum: 35 }).tier, "APEX"); // hit 60%, avgR≈1.17
});
test("rankCaller: high quality but small sample stays SIGNAL (no farming)", () => {
  // 6 perfect calls, avgR 2 — strong, but sample too small for SHARP/APEX
  assert.equal(rankCaller({ calls: 6, wins: 6, rSum: 12 }).tier, "SIGNAL");
});

// ── confluenceSignal (machine signals API + agent parity) ───────────────────
test("confluenceSignal: positive funding extreme → SHORT (fade longs)", () => {
  const s = confluenceSignal({ fundingRate: 0.0002, priceChange: 0, oiChange: 0, hasPrev: false });
  assert.equal(s.fundingSignal, "SHORT");
});
test("confluenceSignal: negative funding extreme → LONG", () => {
  assert.equal(confluenceSignal({ fundingRate: -0.0002, priceChange: 0, oiChange: 0, hasPrev: false }).fundingSignal, "LONG");
});
test("confluenceSignal: below threshold → NONE", () => {
  assert.equal(confluenceSignal({ fundingRate: 0.00005, priceChange: 0, oiChange: 0, hasPrev: false }).fundingSignal, "NONE");
});
test("confluenceSignal: OI divergence price-up/OI-down → SHORT", () => {
  assert.equal(confluenceSignal({ fundingRate: 0, priceChange: 0.01, oiChange: -0.02, hasPrev: true }).oiSignal, "SHORT");
});
test("confluenceSignal: confluence only when BOTH agree", () => {
  // funding SHORT + oi SHORT → confluence SHORT
  assert.equal(confluenceSignal({ fundingRate: 0.0002, priceChange: 0.01, oiChange: -0.02, hasPrev: true }).confluence, "SHORT");
  // funding SHORT + oi LONG → no confluence
  assert.equal(confluenceSignal({ fundingRate: 0.0002, priceChange: -0.01, oiChange: 0.02, hasPrev: true }).confluence, "NONE");
});
test("confluenceSignal: no prior snapshot → oiSignal NONE", () => {
  assert.equal(confluenceSignal({ fundingRate: 0, priceChange: 0.05, oiChange: 0.05, hasPrev: false }).oiSignal, "NONE");
});

// ── Request-bound (v2) signing ──────────────────────────────────────────────
import { buildChallenge, verifyV2, AUTH_V2_DOMAIN } from "./logic.mjs";

const WALLET = "0xAbC0000000000000000000000000000000000001";
const walletL = WALLET.toLowerCase();
// Fake injected ecrecover: returns WALLET only for the sig "GOOD" over the exact
// challenge it was minted for; anything else recovers a different address. This
// isolates the binding/expiry/replay logic from real crypto (recoverEthAddress is
// already battle-tested elsewhere).
const mkRecover = (validChallenge) => (challenge, sig) =>
  (sig === "GOOD" && challenge === validChallenge) ? WALLET : "0xdead000000000000000000000000000000000000";

const mkRecord = (over = {}) => ({
  action: "withdraw", wallet: walletL, nonce: "n-123", amount: "25.5", expires: 2000, ...over,
});
// Build the challenge a correct client would sign for a given record.
const chalFor = (rec) => buildChallenge(rec);

test("buildChallenge: canonical format, lower-cases wallet, '-' for empty amount", () => {
  const c = buildChallenge({ action: "trade", wallet: WALLET, nonce: "n1", amount: "", expires: 100 });
  assert.equal(c,
    `nexus:v2\naction:trade\nwallet:${walletL}\nnonce:n1\namount:-\ndomain:${AUTH_V2_DOMAIN}\nexpires:100`);
});

test("verifyV2: valid signature + matching request → ok", () => {
  const rec = mkRecord();
  const v = verifyV2({ record: rec, sig: "GOOD", expected: { action: "withdraw", amount: "25.5", wallet: WALLET },
    now: 1000, recover: mkRecover(chalFor(rec)) });
  assert.equal(v.ok, true);
  assert.equal(v.wallet, walletL);
});

test("verifyV2: expired challenge → reject", () => {
  const rec = mkRecord();
  const v = verifyV2({ record: rec, sig: "GOOD", expected: { action: "withdraw", amount: "25.5" },
    now: 2001, recover: mkRecover(chalFor(rec)) });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "challenge expired");
});

test("verifyV2: amount mismatch (signed 25.5, request 999) → reject", () => {
  const rec = mkRecord();
  const v = verifyV2({ record: rec, sig: "GOOD", expected: { action: "withdraw", amount: "999" },
    now: 1000, recover: mkRecover(chalFor(rec)) });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "amount mismatch");
});

test("verifyV2: action mismatch (signed withdraw, request trade) → reject", () => {
  const rec = mkRecord();
  const v = verifyV2({ record: rec, sig: "GOOD", expected: { action: "trade", amount: "25.5" },
    now: 1000, recover: mkRecover(chalFor(rec)) });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "action mismatch");
});

test("verifyV2: signer recovers to a DIFFERENT wallet → reject", () => {
  const rec = mkRecord();
  // wrong sig → fake recover returns the dead address
  const v = verifyV2({ record: rec, sig: "FORGED", expected: { action: "withdraw", amount: "25.5" },
    now: 1000, recover: mkRecover(chalFor(rec)) });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "signature does not match wallet");
});

test("verifyV2: signature for a DIFFERENT challenge (replay onto new nonce) → reject", () => {
  const rec = mkRecord({ nonce: "n-999" });
  // recover only validates the ORIGINAL nonce's challenge; this record has a new nonce
  const recoverForOldNonce = mkRecover(chalFor(mkRecord({ nonce: "n-123" })));
  const v = verifyV2({ record: rec, sig: "GOOD", expected: { action: "withdraw", amount: "25.5" },
    now: 1000, recover: recoverForOldNonce });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "signature does not match wallet");
});

test("verifyV2: domain mismatch (signed for a foreign domain) → reject", () => {
  const rec = mkRecord();
  // client signed against a different domain; server verifies under AUTH_V2_DOMAIN
  const foreign = buildChallenge({ ...rec, domain: "evil.example" });
  const v = verifyV2({ record: rec, sig: "GOOD", expected: { action: "withdraw", amount: "25.5" },
    now: 1000, recover: mkRecover(foreign) });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "signature does not match wallet");
});

test("verifyV2: action not in the allow-list → reject", () => {
  const rec = mkRecord({ action: "drain" });
  const v = verifyV2({ record: rec, sig: "GOOD", now: 1000, recover: mkRecover(chalFor(rec)) });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "action not allowed");
});

test("verifyV2: missing record / missing sig → reject (no throw)", () => {
  assert.equal(verifyV2({ record: null, sig: "GOOD", now: 1, recover: mkRecover("") }).ok, false);
  assert.equal(verifyV2({ record: mkRecord(), sig: "", now: 1000, recover: mkRecover("") }).reason, "missing signature");
});

test("verifyV2: wallet binding — request claims a different wallet than signed → reject", () => {
  const rec = mkRecord();
  const v = verifyV2({ record: rec, sig: "GOOD",
    expected: { action: "withdraw", amount: "25.5", wallet: "0x9999999999999999999999999999999999999999" },
    now: 1000, recover: mkRecover(chalFor(rec)) });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "wallet mismatch");
});

import { aggregateAgentTrades, agentStanding, AGENT_BOARD } from "./logic.mjs";

// Helper: build n trade rows with the given pnls, spread `days` apart.
function mkTrades(pnls, days = 5) {
  const start = Date.parse("2026-06-01T00:00:00Z");
  const span = (days * 86400000) / Math.max(1, pnls.length - 1);
  return pnls.map((pnl, i) => ({ pnl, closed_at: new Date(start + i * span).toISOString() }));
}

test("aggregateAgentTrades: counts wins, net, gross, daysActive", () => {
  const a = aggregateAgentTrades(mkTrades([10, -5, 8, -2], 6));
  assert.equal(a.trades, 4);
  assert.equal(a.wins, 2);
  assert.equal(a.net, 11);
  assert.equal(a.grossWin, 18);
  assert.equal(a.grossLoss, 7);
  assert.equal(a.daysActive, 6);
});

test("agentStanding: net-positive agent meeting all gates is eligible", () => {
  // 12 trades, net positive, spread 10 days
  const pnls = [5, 5, 5, 5, 5, 5, 5, -2, -2, -2, 5, 5];
  const s = agentStanding(aggregateAgentTrades(mkTrades(pnls, 10)));
  assert.equal(s.eligible, true);
  assert.equal(s.metCount, 3);
  assert.ok(s.stats.score > 0);
});

test("agentStanding: net-NEGATIVE agent fails only the profitable gate", () => {
  // 12 trades over 10 days but net negative
  const pnls = [2, 2, 2, 2, -5, -5, -5, -5, 2, 2, -4, -4];
  const s = agentStanding(aggregateAgentTrades(mkTrades(pnls, 10)));
  assert.equal(s.eligible, false);
  assert.equal(s.metCount, 2);
  const profitable = s.criteria.find((c) => c.key === "profitable");
  assert.equal(profitable.met, false);
  assert.equal(s.criteria.find((c) => c.key === "trades").met, true);
  assert.equal(s.criteria.find((c) => c.key === "days").met, true);
});

test("agentStanding: too few trades fails the sample gate", () => {
  const s = agentStanding(aggregateAgentTrades(mkTrades([5, 5, 5], 4)));
  assert.equal(s.eligible, false);
  assert.equal(s.criteria.find((c) => c.key === "trades").met, false);
});

test("agentStanding: all gates use AGENT_BOARD thresholds", () => {
  assert.equal(AGENT_BOARD.minTrades, 10);
  assert.equal(AGENT_BOARD.minDays, 3);
  const s = agentStanding(aggregateAgentTrades([]));
  assert.equal(s.total, 3);
  assert.equal(s.eligible, false);
});

import { parseWebhookAlert, normalizeSymbol } from "./logic.mjs";

test("normalizeSymbol: many shapes → canonical PERP_<BASE>_USDC", () => {
  assert.equal(normalizeSymbol("BTC"), "PERP_BTC_USDC");
  assert.equal(normalizeSymbol("btcusdt"), "PERP_BTC_USDC");
  assert.equal(normalizeSymbol("ETH/USDC"), "PERP_ETH_USDC");
  assert.equal(normalizeSymbol("PERP_SOL_USDC"), "PERP_SOL_USDC");
  assert.equal(normalizeSymbol("HYPE-USD"), "PERP_HYPE_USDC");
  assert.equal(normalizeSymbol(""), null);
  assert.equal(normalizeSymbol("!!!"), null);
});

test("parseWebhookAlert: BUY/LONG → open long, SELL/SHORT → open short", () => {
  assert.deepEqual(parseWebhookAlert({ action: "BUY", symbol: "BTC" }),
    { ok: true, action: "OPEN", direction: "LONG", symbol: "PERP_BTC_USDC", sizeOverride: null });
  assert.deepEqual(parseWebhookAlert({ side: "short", ticker: "ethusdt" }),
    { ok: true, action: "OPEN", direction: "SHORT", symbol: "PERP_ETH_USDC", sizeOverride: null });
});

test("parseWebhookAlert: CLOSE needs no symbol", () => {
  const r = parseWebhookAlert({ action: "close" });
  assert.equal(r.ok, true);
  assert.equal(r.action, "CLOSE");
  assert.equal(r.direction, null);
});

test("parseWebhookAlert: OPEN without symbol → error", () => {
  assert.equal(parseWebhookAlert({ action: "BUY" }).ok, false);
});

test("parseWebhookAlert: unknown action → error", () => {
  assert.match(parseWebhookAlert({ action: "yolo", symbol: "BTC" }).error, /unknown action/);
  assert.equal(parseWebhookAlert(null).ok, false);
});

test("parseWebhookAlert: size override parsed when positive", () => {
  assert.equal(parseWebhookAlert({ action: "BUY", symbol: "BTC", size: 25 }).sizeOverride, 25);
  assert.equal(parseWebhookAlert({ action: "BUY", symbol: "BTC", size: -1 }).sizeOverride, null);
});

import { percentileRank, oiStats } from "./logic.mjs";

test("percentileRank: where current sits in the distribution", () => {
  assert.equal(percentileRank([1,2,3,4,5], 3), 60);
  assert.equal(percentileRank([1,2,3,4,5], 5), 100);
  assert.equal(percentileRank([1,2,3,4,5], 0), 0);
  assert.equal(percentileRank([], 3), null);
});

test("oiStats: building flag until minSamples, then funding/oi percentiles", () => {
  const thin = [{ funding: 0.01, oi: 100 }, { funding: 0.02, oi: 110 }];
  assert.equal(oiStats(thin, 12).building, true);
  const series = Array.from({ length: 20 }, (_, i) => ({ funding: i / 1000, oi: 100 + i }));
  const s = oiStats(series, 12);
  assert.equal(s.building, false);
  assert.equal(s.samples, 20);
  assert.equal(s.funding.pct, 100); // last funding is the max → top percentile
  assert.equal(s.oi.value, 119);
});

// ── orderlyAccountId ─────────────────────────────────────────────────────────
// Vectors captured from LIVE indexer rows (ranking/realized_pnl), so these lock
// the derivation against Orderly's real account ids — not our own assumption.
test("orderlyAccountId matches live Orderly indexer vectors", () => {
  assert.equal(
    orderlyAccountId("0x32831ca2efa20ae6340224bc353d4b241b3d2541", "woofi_pro"),
    "0x85cf9694ff45a0230bb572d9c982126b124036e5bc790c285387d31e4fb482ad",
  );
  assert.equal(
    orderlyAccountId("0x689881d3a1cf1b9863be7ff05c7af8e464c248d0", "woofi_pro"),
    "0xb7630bddf27ca2e478b13cbe31be2f0c2e52695ed0b64ee6e8a45e1955c97c44",
  );
});

test("orderlyAccountId is checksum/prefix agnostic and broker-scoped", () => {
  const lower = orderlyAccountId("0x32831ca2efa20ae6340224bc353d4b241b3d2541", "woofi_pro");
  const upper = orderlyAccountId("0x32831CA2EFA20AE6340224BC353D4B241B3D2541", "woofi_pro");
  const naked = orderlyAccountId("32831ca2efa20ae6340224bc353d4b241b3d2541", "woofi_pro");
  assert.equal(upper, lower);
  assert.equal(naked, lower);
  // same wallet, different broker => different account
  assert.notEqual(orderlyAccountId("0x32831ca2efa20ae6340224bc353d4b241b3d2541", "nexus_trading"), lower);
});

test("orderlyAccountId rejects bad input", () => {
  assert.throws(() => orderlyAccountId("0xnope", "nexus_trading"));
  assert.throws(() => orderlyAccountId("0x32831ca2efa20ae6340224bc353d4b241b3d2541", ""));
});

// ── safeChartUrl (SSRF guard for the OG card) ────────────────────────────────
test("safeChartUrl accepts only https allowlisted chart hosts", () => {
  assert.equal(safeChartUrl("https://s3.tradingview.com/snapshot/a/Ab12.png"),
               "https://s3.tradingview.com/snapshot/a/Ab12.png");
  assert.ok(safeChartUrl("https://i.imgur.com/abc.png"));
  assert.ok(safeChartUrl("https://pbs.twimg.com/media/x.jpg"));
});

test("safeChartUrl blocks SSRF and spoofing vectors", () => {
  assert.equal(safeChartUrl("http://s3.tradingview.com/x.png"), null);   // not https
  assert.equal(safeChartUrl("https://s3.tradingview.com.evil.com/x.png"), null); // suffix spoof
  assert.equal(safeChartUrl("https://evil.com/x.png"), null);            // not allowlisted
  assert.equal(safeChartUrl("http://169.254.169.254/latest/meta-data/"), null); // cloud metadata
  assert.equal(safeChartUrl("http://localhost:8787/admin"), null);       // internal
  assert.equal(safeChartUrl("file:///etc/passwd"), null);
  assert.equal(safeChartUrl("javascript:alert(1)"), null);
  assert.equal(safeChartUrl("not a url"), null);
  assert.equal(safeChartUrl(""), null);
  assert.equal(safeChartUrl(null), null);
  assert.equal(safeChartUrl(undefined), null);
});

// ── symbolToQuery (catalyst search mapping) ──────────────────────────────────
test("symbolToQuery: commodity ticker → named query, not the raw ticker", () => {
  const cl = symbolToQuery("CL");
  assert.equal(cl.name, "WTI crude oil");
  assert.equal(cl.assetClass, "commodity");
  assert.equal(cl.query, "WTI crude oil");
});

test("symbolToQuery: crypto major mapped by name", () => {
  const btc = symbolToQuery("BTC");
  assert.equal(btc.name, "Bitcoin");
  assert.equal(btc.assetClass, "crypto");
});

test("symbolToQuery: meme ticker resolves to real name", () => {
  assert.equal(symbolToQuery("WIF").name, "dogwifhat");
});

test("symbolToQuery: normalizes PERP_ / _USDC / casing", () => {
  assert.equal(symbolToQuery("perp_eth_usdc").name, "Ethereum");
  assert.equal(symbolToQuery("Sol").name, "Solana");
});

test("symbolToQuery: unknown ticker falls back to crypto with qualifier", () => {
  const x = symbolToQuery("ZZZZ");
  assert.equal(x.assetClass, "crypto");
  assert.equal(x.query, "ZZZZ crypto");
  assert.equal(x.ticker, "ZZZZ");
});

test("symbolToQuery: empty/garbage → null", () => {
  assert.equal(symbolToQuery(""), null);
  assert.equal(symbolToQuery("___"), null);
  assert.equal(symbolToQuery(null), null);
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Regime attribution + plan quality
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Candle builder that carries closes (regime needs them; gradeCall doesn't).
const rSeries = (start, closes, rangePct = 1) => ({
  t: closes.map((_, i) => start + i * 3600),
  c: closes.slice(),
  h: closes.map((c) => c * (1 + rangePct / 200)),
  l: closes.map((c) => c * (1 - rangePct / 200)),
});

const rampUp = (n, from = 100, step = 1) => Array.from({ length: n }, (_, i) => from + i * step);
const zigzag = (n, from = 100, amp = 2) => Array.from({ length: n }, (_, i) => from + (i % 2 ? amp : 0));

test("classifyRegime: a straight run up is TREND_UP (high efficiency ratio)", () => {
  const cd = rSeries(t0, rampUp(48));
  const reg = classifyRegime(cd, t0 + 47 * 3600);
  assert.equal(reg.trend, "TREND_UP");
  assert.equal(reg.er, 1); // pure trend â€” every step was progress
  assert.ok(reg.movePct > 1);
});

test("classifyRegime: mirror case is TREND_DOWN", () => {
  const cd = rSeries(t0, rampUp(48, 200, -2));
  assert.equal(classifyRegime(cd, t0 + 47 * 3600).trend, "TREND_DOWN");
});

test("classifyRegime: same ground covered repeatedly is CHOP, not a trend", () => {
  const cd = rSeries(t0, zigzag(48));
  const reg = classifyRegime(cd, t0 + 47 * 3600);
  assert.equal(reg.trend, "CHOP");
  assert.ok(reg.er < 0.35);
});

test("classifyRegime: a big move that backs and fills is still CHOP", () => {
  // travels 100 up to ~130 then back to ~101: large path, no net progress
  const closes = [...rampUp(24, 100, 1.25), ...rampUp(24, 130, -1.2)];
  const reg = classifyRegime(rSeries(t0, closes), t0 + 47 * 3600);
  assert.equal(reg.trend, "CHOP");
});

test("classifyRegime: drift below MIN_MOVE_PCT is CHOP even at perfect efficiency", () => {
  const cd = rSeries(t0, rampUp(48, 100, 0.001)); // er == 1, move ~0.05%
  const reg = classifyRegime(cd, t0 + 47 * 3600);
  assert.equal(reg.er, 1);
  assert.equal(reg.trend, "CHOP");
});

test("classifyRegime: vol is relative to the symbol's own baseline", () => {
  // 60 calm bars then 48 with 5x the bar range: the recent window reads VOLATILE
  const calm = rSeries(t0, rampUp(60), 1);
  const hotCloses = rampUp(48, 160);
  const cd = {
    t: [...calm.t, ...hotCloses.map((_, i) => t0 + (60 + i) * 3600)],
    c: [...calm.c, ...hotCloses],
    h: [...calm.h, ...hotCloses.map((c) => c * 1.025)],
    l: [...calm.l, ...hotCloses.map((c) => c * 0.975)],
  };
  assert.equal(classifyRegime(cd, t0 + 107 * 3600).vol, "VOLATILE");
  // ...and the calm stretch alone is not flagged hot
  assert.notEqual(classifyRegime(calm, t0 + 59 * 3600).vol, "VOLATILE");
});

test("classifyRegime: too little PRIOR history gives null (never guesses)", () => {
  const cd = rSeries(t0, rampUp(48));
  assert.equal(classifyRegime(cd, t0 + 3 * 3600), null); // only 4 bars precede
  assert.equal(classifyRegime(cd, t0 - 86400), null);    // call predates the series
  assert.equal(classifyRegime(null, t0), null);
});

test("classifyRegime: only reads candles BEFORE the call (no hindsight leak)", () => {
  // chop first, violent rally after: a call at the boundary must read CHOP
  const closes = [...zigzag(48), ...rampUp(48, 100, 5)];
  const cd = rSeries(t0, closes);
  assert.equal(classifyRegime(cd, t0 + 47 * 3600).trend, "CHOP");
  assert.equal(classifyRegime(cd, t0 + 95 * 3600).trend, "TREND_UP");
});

test("classifyRegime: a REAL-WORLD-shaped grind still reads as a trend", () => {
  // Regression guard on the calibrated ER threshold. Live markets rarely produce
  // clean ramps — a genuine trend advances two steps and gives one back, which lands
  // around er≈0.33. The original 0.35 threshold called that CHOP and, measured over
  // 60d across 5 symbols, labelled 94% of all windows CHOP. If this test starts
  // failing, the classifier has gone blind again — re-run tools/calibrate-regime.mjs.
  // two steps up (+0.5 each), one step back (-0.5625) → er ≈ 0.28, ~7% net move
  let px = 100;
  const closes = Array.from({ length: 48 }, (_, i) => (px += i % 3 === 2 ? -0.5625 : 0.5));
  const reg = classifyRegime(rSeries(t0, closes), t0 + 47 * 3600);
  assert.equal(reg.trend, "TREND_UP");
  assert.ok(reg.er >= 0.2 && reg.er < 0.35, `er ${reg.er} should sit in the realistic band`);
});

test("callAlignment: with / against / chop", () => {
  assert.equal(callAlignment("LONG", { trend: "TREND_UP" }), "WITH_TREND");
  assert.equal(callAlignment("SHORT", { trend: "TREND_UP" }), "AGAINST_TREND");
  assert.equal(callAlignment("LONG", { trend: "TREND_DOWN" }), "AGAINST_TREND");
  assert.equal(callAlignment("SHORT", { trend: "TREND_DOWN" }), "WITH_TREND");
  assert.equal(callAlignment("LONG", { trend: "CHOP" }), "CHOP");
  assert.equal(callAlignment("LONG", null), "CHOP");
});

test("regimeBucketsOf: one bucket per dimension, none without a regime", () => {
  const b = regimeBucketsOf("SHORT", { trend: "TREND_UP", vol: "CALM" });
  assert.deepEqual(b, ["trend:TREND_UP", "vol:CALM", "align:AGAINST_TREND"]);
  assert.deepEqual(regimeBucketsOf("LONG", null), []);
});

test("regimeBuckets: aggregates hit rate + avg R per bucket", () => {
  const rows = [
    { buckets: ["trend:TREND_UP"], r: 2, win: true },
    { buckets: ["trend:TREND_UP"], r: -1, win: false },
    { buckets: ["trend:CHOP"], r: -1, win: false },
  ];
  const b = regimeBuckets(rows);
  assert.equal(b["trend:TREND_UP"].calls, 2);
  assert.equal(b["trend:TREND_UP"].avgR, 0.5);
  assert.equal(b["trend:TREND_UP"].hitRate, 50);
  assert.equal(b["trend:CHOP"].avgR, -1);
});

test("regimeEdge: surfaces best/worst regime once both have a real sample", () => {
  const rows = [
    ...Array(6).fill({ buckets: ["trend:TREND_UP"], r: 2, win: true }),
    ...Array(6).fill({ buckets: ["trend:CHOP"], r: -1, win: false }),
  ];
  const e = regimeEdge(regimeBuckets(rows), "trend");
  assert.equal(e.best.bucket, "trend:TREND_UP");
  assert.equal(e.worst.bucket, "trend:CHOP");
  assert.equal(e.gapR, 3);
});

test("regimeEdge: stays SILENT on a thin sample or a narrow gap", () => {
  // thin: 4 calls each, below minSample
  const thin = [
    ...Array(4).fill({ buckets: ["trend:TREND_UP"], r: 2, win: true }),
    ...Array(4).fill({ buckets: ["trend:CHOP"], r: -1, win: false }),
  ];
  assert.equal(regimeEdge(regimeBuckets(thin), "trend"), null);
  // sample is fine but both regimes perform the same, so there is no advice to give
  const flat = [
    ...Array(6).fill({ buckets: ["trend:TREND_UP"], r: 1, win: true }),
    ...Array(6).fill({ buckets: ["trend:CHOP"], r: 1, win: true }),
  ];
  assert.equal(regimeEdge(regimeBuckets(flat), "trend"), null);
  // and a single bucket is not a comparison
  assert.equal(regimeEdge(regimeBuckets(thin.slice(0, 4)), "trend"), null);
});

// â”€â”€ plan quality â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// A clean LONG: entry at market, stop 5 away, target 10 away, R:R 2 stated.
const planCd = rSeries(t0, rampUp(60), 1); // bar range ~1% of price
const cleanPlan = (over = {}) => ({
  direction: "LONG", entryPrice: 130, stopLoss: 125, takeProfit1: 140,
  riskReward: 2, createdAt: (t0 + 30 * 3600) * 1000, ...over,
});

test("planQuality: a well-formed call scores 100 with no flags", () => {
  const p = planQuality(cleanPlan(), planCd);
  assert.deepEqual(p.flags, []);
  assert.equal(p.score, 100);
  assert.equal(p.components.rrGeom, 2);
});

test("planQuality: LATE_ENTRY when the move already happened before the post", () => {
  // market is at 130 by bar 30; claiming an entry back at 120 is 2R of free ground
  const p = planQuality(cleanPlan({ entryPrice: 120, stopLoss: 115, takeProfit1: 130 }), planCd);
  assert.ok(p.flags.includes("LATE_ENTRY"));
  assert.equal(p.components.entryDriftR, 2);
  assert.ok(p.score < 100);
});

test("planQuality: entering BEFORE the level is not penalized", () => {
  // price 130, patient long stated at 135, so drift is negative and not a flag
  const p = planQuality(cleanPlan({ entryPrice: 135, stopLoss: 130, takeProfit1: 145 }), planCd);
  assert.ok(!p.flags.includes("LATE_ENTRY"));
  assert.ok(p.components.entryDriftR < 0);
});

test("planQuality: LATE_ENTRY inverts correctly for shorts", () => {
  // price has fallen to ~130 from 160; a short 'entry' at 150 is late
  const down = rSeries(t0, rampUp(60, 160, -0.5), 1);
  const p = planQuality({ direction: "SHORT", entryPrice: 150, stopLoss: 155, takeProfit1: 140, riskReward: 2, createdAt: (t0 + 59 * 3600) * 1000 }, down);
  assert.ok(p.flags.includes("LATE_ENTRY"));
});

test("planQuality: STOP_IN_NOISE when the stop sits inside one bar's range", () => {
  // bar range ~1% of ~130 is ~1.3, so a 0.2-wide stop is noise
  const p = planQuality(cleanPlan({ stopLoss: 129.8, takeProfit1: 130.4, riskReward: 2 }), planCd);
  assert.ok(p.flags.includes("STOP_IN_NOISE"));
  assert.ok(p.components.stopAtr < 0.5);
});

test("planQuality: STOP_TOO_WIDE only fires on a stop that isn't risk control", () => {
  // planCd bars span ~1% of price (~1.3 at 130), so 25 ATR is ~33 away. A stop 100
  // away (~77 ATR) is not a stop; one 23 ATR away is an ordinary swing stop and must
  // NOT flag — see the calibration note on PLAN.stopWideAtr.
  // riskReward 2 matches the geometry (200 reward / 100 risk) so this isolates the
  // stop-width flag instead of also tripping RR_MISMATCH.
  const wide = planQuality(cleanPlan({ stopLoss: 30, takeProfit1: 330, riskReward: 2 }), planCd);
  assert.ok(wide.flags.includes("STOP_TOO_WIDE"));
  const swing = planQuality(cleanPlan({ stopLoss: 100, takeProfit1: 190, riskReward: 2 }), planCd);
  assert.ok(!swing.flags.includes("STOP_TOO_WIDE"), "a normal wide swing stop must not be flagged");
  assert.ok(wide.score > planQuality(cleanPlan({ stopLoss: 129.8, takeProfit1: 130.4 }), planCd).score);
});

test("planQuality: RR_MISMATCH when the claimed R disagrees with the levels", () => {
  // levels give 2R; claiming 5R inflates every graded win
  const p = planQuality(cleanPlan({ riskReward: 5 }), planCd);
  assert.ok(p.flags.includes("RR_MISMATCH"));
  assert.equal(p.components.rrStated, 5);
  assert.equal(p.components.rrGeom, 2);
});

test("planQuality: small R:R rounding is tolerated", () => {
  assert.ok(!planQuality(cleanPlan({ riskReward: 2.2 }), planCd).flags.includes("RR_MISMATCH"));
});

test("planQuality: BAD_LEVELS when target/stop are on the wrong side", () => {
  const tpWrong = planQuality(cleanPlan({ takeProfit1: 120 }), planCd);
  assert.ok(tpWrong.flags.includes("BAD_LEVELS"));
  const slWrong = planQuality({ direction: "SHORT", entryPrice: 130, stopLoss: 125, takeProfit1: 120, createdAt: (t0 + 30 * 3600) * 1000 }, planCd);
  assert.ok(slWrong.flags.includes("BAD_LEVELS"));
});

test("planQuality: score floors at 0 and never goes negative", () => {
  const p = planQuality(cleanPlan({ entryPrice: 120, stopLoss: 119.9, takeProfit1: 119.5, riskReward: 9 }), planCd);
  assert.ok(p.score >= 0);
});

test("planQuality: unscoreable inputs give null (missing levels, zero risk)", () => {
  assert.equal(planQuality(null, planCd), null);
  assert.equal(planQuality(cleanPlan({ stopLoss: 0 }), planCd), null);
  assert.equal(planQuality(cleanPlan({ stopLoss: 130 }), planCd), null); // entry == stop, no risk
});

test("planQuality: still scores geometry with no candles at all", () => {
  const p = planQuality(cleanPlan({ riskReward: 5 }), null);
  assert.ok(p.flags.includes("RR_MISMATCH"));
  assert.equal(p.components.entryDriftR, undefined); // nothing claimed without price
});

test("planSummary: mean score plus the most common leak", () => {
  const s = planSummary([
    { score: 100, flags: [] },
    { score: 70, flags: ["LATE_ENTRY"] },
    { score: 70, flags: ["LATE_ENTRY"] },
    { score: 75, flags: ["STOP_IN_NOISE"] },
  ]);
  assert.equal(s.scored, 4);
  assert.equal(s.score, 79);
  assert.equal(s.topFlag.flag, "LATE_ENTRY");
  assert.equal(s.topFlag.count, 2);
  assert.equal(s.topFlag.rate, 50);
  assert.equal(planSummary([]), null);
});

// ═══════════════════════════════════════════════════════════════════
// Expectancy, ranking score, conviction calibration
// ═══════════════════════════════════════════════════════════════════

const wins = (n, r) => Array.from({ length: n }, () => ({ r, win: true }));
const losses = (n) => Array.from({ length: n }, () => ({ r: -1, win: false }));

test("expectancyStats: mean R per call is the headline number", () => {
  // 4 wins at +2, 6 losses at -1 → (8-6)/10 = +0.2 expectancy despite 40% hit rate
  const s = expectancyStats([...wins(4, 2), ...losses(6)]);
  assert.equal(s.expectancy, 0.2);
  assert.equal(s.avgWinR, 2);
  assert.equal(s.avgLossR, 1);
});

test("expectancyStats: profit factor = R won per R lost, capped and Infinity-guarded", () => {
  assert.equal(expectancyStats([...wins(4, 2), ...losses(4)]).profitFactor, 2); // 8/4
  assert.equal(expectancyStats(wins(3, 2)).profitFactor, 99); // no losses → capped, not Infinity
  assert.equal(expectancyStats(losses(3)).profitFactor, 0);
});

test("expectancyStats: tail ratio captures fat-tail concentration", () => {
  // one +10 monster among four +1 wins → top 20% (1 of 5) is 10/14 of winning R
  const s = expectancyStats([{ r: 10, win: true }, ...wins(4, 1)]);
  assert.ok(s.tailRatio > 0.7);
  // evenly-sized wins → low concentration
  assert.ok(expectancyStats(wins(5, 2)).tailRatio < 0.3);
});

test("expectancyStats: empty / all-invalid input → null", () => {
  assert.equal(expectancyStats([]), null);
  assert.equal(expectancyStats([{ win: true }]), null); // no finite r
});

test("callerScore: a low-hit-rate fat-tail trader beats a high-hit-rate scalper", () => {
  // The whole point of the rework. Both have 20 calls.
  const fatTail = { ...expectancyStats([...wins(8, 3), ...losses(12)]), calls: 20 };   // 40% hit, +0.6 exp
  const scalper = { ...expectancyStats([...wins(15, 0.4), ...losses(5)]), calls: 20 }; // 75% hit, +0.05 exp
  assert.ok(callerScore(fatTail) > callerScore(scalper));
});

test("callerScore: sample confidence shrinks a hot short streak below a proven book", () => {
  const streak = { ...expectancyStats(wins(5, 2)), calls: 5 };                 // +2 exp, tiny sample
  const proven = { ...expectancyStats([...wins(24, 2), ...losses(16)]), calls: 40 }; // +0.8 exp, big sample
  assert.ok(callerScore(proven) > callerScore(streak));
  // ...but a hot streak still outranks a large-sample MEDIOCRE book — thin evidence
  // of a real edge should beat thick evidence of a marginal one.
  const marginal = { ...expectancyStats([...wins(11, 1), ...losses(29)]), calls: 40 }; // ~ -0.45 exp
  assert.ok(callerScore(streak) > callerScore(marginal));
});

test("callerScore: hit rate does NOT enter the ranking", () => {
  // The invariant: callerScore reads expectancy, profitFactor, calls — nothing else.
  // A hitRate field on the stats object must not move the score by a hair.
  const base = { expectancy: 0.2, profitFactor: 1.4, calls: 20 };
  assert.equal(callerScore({ ...base, hitRate: 20 }), callerScore({ ...base, hitRate: 75 }));
});

test("callerScore: 0 for non-positive expectancy or missing stats", () => {
  assert.equal(callerScore({ expectancy: -0.3, profitFactor: 0.5, calls: 20 }), 0);
  assert.equal(callerScore(null), 0);
});

test("convictionCalibration: rewards sizing UP on the calls that worked", () => {
  // big bets (conviction 3) win, small bets (conviction 1) lose
  const rows = [
    ...Array(5).fill(0).map(() => ({ r: 2, win: true, conviction: 3 })),
    ...Array(5).fill(0).map(() => ({ r: -1, win: false, conviction: 1 })),
  ];
  const c = convictionCalibration(rows);
  assert.equal(c.calibrated, true);
  assert.equal(c.inverted, false);
  assert.ok(c.gap > 0);
});

test("convictionCalibration: flags the costly inversion (big bets on the worst calls)", () => {
  const rows = [
    ...Array(5).fill(0).map(() => ({ r: -1, win: false, conviction: 3 })),
    ...Array(5).fill(0).map(() => ({ r: 2, win: true, conviction: 1 })),
  ];
  const c = convictionCalibration(rows);
  assert.equal(c.inverted, true);
  assert.equal(c.calibrated, false);
});

test("convictionCalibration: silent when sizing doesn't vary or sample is thin", () => {
  // everything sized the same → nothing to calibrate
  assert.equal(convictionCalibration(Array(10).fill(0).map(() => ({ r: 1, conviction: 2 }))), null);
  // too few per half
  assert.equal(convictionCalibration([
    ...Array(3).fill(0).map(() => ({ r: 2, conviction: 3 })),
    ...Array(3).fill(0).map(() => ({ r: -1, conviction: 1 })),
  ]), null);
  // no conviction data at all
  assert.equal(convictionCalibration([...wins(6, 2), ...losses(6)]), null);
});

test("convictionCalibration: a small gap is not called calibrated", () => {
  const rows = [
    ...Array(5).fill(0).map(() => ({ r: 1.0, conviction: 3 })),
    ...Array(5).fill(0).map(() => ({ r: 0.9, conviction: 1 })),
  ];
  const c = convictionCalibration(rows);
  assert.equal(c.calibrated, false); // gap 0.1 < 0.25 minimum
  assert.equal(c.inverted, false);
});

// ═══════════════════════════════════════════════════════════════════
// Disagreement board
// ═══════════════════════════════════════════════════════════════════
const E = (wallet, symbol, direction, weight, source) => ({ wallet, symbol, direction, weight, source });

test("contestedBoard: a symbol with both camps is contested; consensus is not", () => {
  const board = contestedBoard([
    E("0xA", "BTC", "LONG"), E("0xB", "BTC", "SHORT"),
    E("0xC", "ETH", "LONG"), E("0xD", "ETH", "LONG"), // consensus long → not contested
  ]);
  assert.equal(board.length, 1);
  assert.equal(board[0].symbol, "BTC");
  assert.equal(board[0].longCount, 1);
  assert.equal(board[0].shortCount, 1);
});

test("contestedBoard: a wallet on both sides of one symbol is voided there", () => {
  const board = contestedBoard([
    E("0xA", "BTC", "LONG"), E("0xA", "BTC", "SHORT"), // self-contradiction → 0xA dropped for BTC
    E("0xB", "BTC", "SHORT"),
  ]);
  // only 0xB survives on BTC → one-sided → not contested
  assert.equal(board.length, 0);
});

test("contestedBoard: a wallet holding + calling the SAME way counts once", () => {
  const board = contestedBoard([
    E("0xA", "BTC", "LONG", 1, "position"), E("0xA", "BTC", "LONG", 1, "thesis"),
    E("0xB", "BTC", "SHORT"),
  ]);
  assert.equal(board[0].longCount, 1); // not 2
  assert.deepEqual(board[0].longs[0].sources.sort(), ["position", "thesis"]);
});

test("contestedBoard: same-side duplicate takes the strongest weight, never doubles", () => {
  const board = contestedBoard([
    E("0xA", "BTC", "LONG", 1), E("0xA", "BTC", "LONG", 3),
    E("0xB", "BTC", "SHORT", 2),
  ]);
  assert.equal(board[0].longWeight, 3); // max(1,3), not 4
});

test("contestedBoard: tension rewards balanced heavyweight standoffs over lopsided ones", () => {
  const board = contestedBoard([
    // ETH: perfectly balanced heavy standoff (3 vs 3 weight)
    E("a", "ETH", "LONG", 3), E("b", "ETH", "SHORT", 3),
    // BTC: lopsided (5 vs 1)
    E("c", "BTC", "LONG", 5), E("d", "BTC", "SHORT", 1),
  ]);
  assert.equal(board[0].symbol, "ETH"); // higher tension ranks first
  assert.ok(board[0].tension > board[1].tension);
  assert.equal(board[0].balance, 1);    // dead even
});

test("contestedBoard: weight lets credibility outrank raw headcount", () => {
  const board = contestedBoard([
    // two heavyweight sharps opposed
    E("a", "SOL", "LONG", 5), E("b", "SOL", "SHORT", 5),
    // many featherweight unknowns, near-balanced
    E("c", "XRP", "LONG", 1), E("d", "XRP", "LONG", 1), E("e", "XRP", "SHORT", 1), E("f", "XRP", "SHORT", 1),
  ]);
  assert.equal(board[0].symbol, "SOL"); // total weight 10 > 4
});

test("contestedBoard: camps come back sorted by weight (loudest voice first)", () => {
  const board = contestedBoard([
    E("a", "BTC", "LONG", 1), E("b", "BTC", "LONG", 4),
    E("c", "BTC", "SHORT", 2),
  ]);
  assert.equal(board[0].longs[0].wallet, "b"); // weight 4 before weight 1
});

test("contestedBoard: junk + empty input is handled cleanly", () => {
  assert.deepEqual(contestedBoard([]), []);
  assert.deepEqual(contestedBoard(null), []);
  assert.deepEqual(contestedBoard([{ wallet: "a" }, E("b", "BTC", "SIDEWAYS"), E("c", "BTC", "LONG")]), []);
});

test("contestedBoard: wallet identity is case-insensitive", () => {
  const board = contestedBoard([
    E("0xAbC", "BTC", "LONG"), E("0xabc", "BTC", "SHORT"), // same wallet, both sides → voided
    E("0xD", "BTC", "SHORT"),
  ]);
  assert.equal(board.length, 0);
});

// ═══════════════════════════════════════════════════════════════════
// Loss postmortems (taxonomy + aggregation)
// ═══════════════════════════════════════════════════════════════════

test("LOSS_REASONS: keys are the exact pinned set (drift guard vs the client copy)", () => {
  // ⚠️ Must stay identical to LOSS_REASONS in app/lib/postmortem.mjs — the client
  // writes these keys, this side aggregates them. Divergence = silently split data.
  assert.deepEqual(
    LOSS_REASONS.map((r) => r.key).sort(),
    ["CHASED", "EARLY", "NO_STOP", "OVERSIZED", "REVENGE", "THESIS_WRONG"],
  );
});

test("isLossReason: enum-guarded (self-reported field arrives from client storage)", () => {
  assert.equal(isLossReason("REVENGE"), true);
  assert.equal(isLossReason("revenge"), false);
  assert.equal(isLossReason("__proto__"), false);
  assert.equal(isLossReason(42), false);
});

test("postmortemSummary: tallies counts and names the most common reason", () => {
  const s = postmortemSummary(["OVERSIZED", "EARLY", "OVERSIZED", "CHASED"]);
  assert.equal(s.tagged, 4);
  assert.equal(s.counts.OVERSIZED, 2);
  assert.equal(s.top.reason, "OVERSIZED");
  assert.equal(s.top.rate, 50);
});

test("postmortemSummary: silently drops junk/injected values", () => {
  const s = postmortemSummary(["EARLY", "NOT_A_REASON", null, "EARLY"]);
  assert.equal(s.tagged, 2);
  assert.deepEqual(Object.keys(s.counts), ["EARLY"]);
});

test("postmortemSummary: nothing valid → null (no empty artifact)", () => {
  assert.equal(postmortemSummary([]), null);
  assert.equal(postmortemSummary(["GARBAGE"]), null);
  assert.equal(postmortemSummary(null), null);
});

// ═══════════════════════════════════════════════════════════════════
// Call resolution events
// ═══════════════════════════════════════════════════════════════════
import { resolutionMessage, resolutionFeedEntry, RESOLVED_FEED_KEY } from "./resolutions.mjs";

const rzThesis = { id: "t1", symbol: "PERP_BTC_USDC", direction: "LONG", entryPrice: 100, stopLoss: 95, takeProfit1: 110 };

test("resolutionMessage: a win states the fact, without celebration", () => {
  const m = resolutionMessage(rzThesis, "WIN", 2);
  assert.equal(m.won, true);
  assert.equal(m.message, "BTC LONG hit target — +2R");
  assert.match(m.telegram, /BTC LONG hit target/);
  assert.match(m.telegram, /graded from public price/);
  // The grade is a fact about price; hype would read as spin.
  assert.ok(!/congrat|nice|great|🎉/i.test(m.message + m.telegram));
});

test("resolutionMessage: a loss states it plainly, without sympathy or blame", () => {
  const m = resolutionMessage(rzThesis, "LOSS", -1);
  assert.equal(m.won, false);
  assert.equal(m.message, "BTC LONG stopped out — -1R");
  assert.ok(!/unlucky|sorry|bad luck|shame/i.test(m.message + m.telegram));
});

test("resolutionMessage: symbol is bare and R is rounded for display", () => {
  assert.match(resolutionMessage({ ...rzThesis, symbol: "PERP_1000PEPE_USDC" }, "WIN", 1.666).message, /^1000PEPE/);
  assert.match(resolutionMessage(rzThesis, "WIN", 1.666).message, /\+1\.67R/);
});

test("resolutionMessage: survives a malformed thesis rather than throwing in cron", () => {
  const m = resolutionMessage({}, "LOSS", -1);
  assert.ok(typeof m.message === "string" && m.message.length > 0);
  assert.doesNotThrow(() => resolutionMessage(null, "WIN", 1));
});

test("resolutionFeedEntry: carries what the feed needs and nothing private", () => {
  const e = resolutionFeedEntry("0xAbC", rzThesis, "WIN", 2);
  assert.equal(e.kind, "RESOLUTION");
  assert.equal(e.symbol, "BTC");
  assert.equal(e.outcome, "WIN");
  assert.equal(e.r, 2);
  assert.equal(e.wallet, "0xAbC");
  assert.ok(e.createdAt > 0);
  // Only fields already public on the call itself — no size, no account, no P&L.
  for (const k of ["positionSize", "accountSize", "riskPercent", "actualPnl", "notes"]) {
    assert.equal(e[k], undefined, `${k} must not ride along into the public feed`);
  }
  assert.equal(RESOLVED_FEED_KEY, "resolved:feed");
});

// ═══════════════════════════════════════════════════════════════════
// Expected time to resolution
// ═══════════════════════════════════════════════════════════════════
import { estimateResolution, RESOLUTION_BUCKETS } from "./logic.mjs";

test("estimateResolution: tight levels resolve in hours, wide levels in weeks", () => {
  const atr = 0.19; // BTC hourly ATR%, measured live
  const scalp = estimateResolution({ entryPrice: 100, stopLoss: 99.7, takeProfit1: 100.6 }, atr);
  const swing = estimateResolution({ entryPrice: 100, stopLoss: 98.5, takeProfit1: 103 }, atr);
  const position = estimateResolution({ entryPrice: 100, stopLoss: 92, takeProfit1: 120 }, atr);
  assert.ok(scalp.hours < swing.hours && swing.hours < position.hours);
  assert.equal(scalp.label, "hours");
  assert.equal(swing.label, "a few days"); // 125h mean
  assert.ok(swing.hours > 100 && swing.hours < 150);
  assert.equal(position.label, "weeks");
});

test("estimateResolution: a more volatile symbol resolves the same levels sooner", () => {
  const levels = { entryPrice: 100, stopLoss: 98.5, takeProfit1: 103 };
  const calm = estimateResolution(levels, 0.19);
  const hot = estimateResolution(levels, 0.7);
  assert.ok(hot.hours < calm.hours, "higher ATR must shorten the estimate");
  // quadratic in vol: ~3.7x the ATR should be ~13x faster
  assert.ok(calm.hours / hot.hours > 10);
});

test("estimateResolution: symmetric in direction — a short is not slower than a long", () => {
  const long = estimateResolution({ entryPrice: 100, stopLoss: 98, takeProfit1: 104 }, 0.3);
  const short = estimateResolution({ entryPrice: 100, stopLoss: 102, takeProfit1: 96 }, 0.3);
  assert.equal(long.hours, short.hours);
});

test("estimateResolution: unusable input yields null, never a fake ETA", () => {
  assert.equal(estimateResolution(null, 0.3), null);
  assert.equal(estimateResolution({ entryPrice: 100, stopLoss: 98, takeProfit1: 104 }, 0), null);
  assert.equal(estimateResolution({ entryPrice: 100, stopLoss: 98, takeProfit1: 104 }, NaN), null);
  assert.equal(estimateResolution({ entryPrice: 100, stopLoss: 100, takeProfit1: 104 }, 0.3), null); // no risk
  assert.equal(estimateResolution({ entryPrice: 0, stopLoss: 98, takeProfit1: 104 }, 0.3), null);
});

test("estimateResolution: buckets are ordered and total coverage is unbounded", () => {
  let prev = 0;
  for (const b of RESOLUTION_BUCKETS) { assert.ok(b.maxHours > prev); prev = b.maxHours; }
  assert.equal(RESOLUTION_BUCKETS[RESOLUTION_BUCKETS.length - 1].maxHours, Infinity);
});

// ── Nexus Arena — registration validation + config clamps ────────────────────
test("validateArenaRegistration: accepts a normal profile and trims/limits fields", () => {
  const v = validateArenaRegistration({ name: "  Fable Fund 1 ", description: "x".repeat(500), builder: "claude-loop" });
  assert.equal(v.ok, true);
  assert.equal(v.name, "Fable Fund 1");
  assert.equal(v.description.length, 240);
  assert.equal(v.builder, "claude-loop");
});

test("validateArenaRegistration: rejects missing/short/oversized/injected names", () => {
  assert.equal(validateArenaRegistration({}).ok, false);
  assert.equal(validateArenaRegistration({ name: "ab" }).ok, false);
  assert.equal(validateArenaRegistration({ name: "x".repeat(41) }).ok, false);
  assert.equal(validateArenaRegistration({ name: "<script>alert(1)</script>" }).ok, false);
});

test("arenaAgentConfig: always PAPER + EXTERNAL + arena-flagged regardless of overrides", () => {
  const c = arenaAgentConfig({ mode: "AUTONOMOUS", signalMode: "CONFLUENCE", arena: false });
  assert.equal(c.mode, "PAPER");
  assert.equal(c.signalMode, "EXTERNAL");
  assert.equal(c.arena, true);
});

test("arenaAgentConfig: clamps hostile risk values and defaults absent ones", () => {
  const c = arenaAgentConfig({ leverage: 500, slPercent: -3, maxTradesPerDay: "nope", capitalPerTrade: 1e9 });
  assert.equal(c.leverage, 10);
  assert.equal(c.slPercent, 0.2);
  assert.equal(c.maxTradesPerDay, 10); // NaN → default
  assert.equal(c.capitalPerTrade, 10000);
  assert.equal(c.tpPercent, 2);
});

test("parseWebhookAlert: TEST/PING → wiring-check action, no symbol required", () => {
  assert.equal(parseWebhookAlert({ action: "TEST" }).action, "TEST");
  assert.equal(parseWebhookAlert({ action: "ping" }).action, "TEST");
  assert.equal(parseWebhookAlert({ action: "TEST" }).ok, true);
  // TEST must never carry a tradable direction the exec could act on.
  assert.equal(parseWebhookAlert({ action: "TEST" }).direction, null);
});

// ── Autocopy — diffCopyLeaders (copiers reverse index) ───────────────────────
import { diffCopyLeaders } from "./logic.mjs";

test("diffCopyLeaders: added + removed computed from old vs new", () => {
  const d = diffCopyLeaders(["0xA", "0xB"], ["0xB", "0xC"], "0xME");
  assert.deepEqual(d.added, ["0xc"]);
  assert.deepEqual(d.removed, ["0xa"]);
});

test("diffCopyLeaders: no change → empty", () => {
  const d = diffCopyLeaders(["0xA"], ["0xa"], "0xME"); // case-insensitive same
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test("diffCopyLeaders: first follow (no old) + self is excluded + deduped", () => {
  const d = diffCopyLeaders(null, ["0xLEAD", "0xLEAD", "0xME"], "0xme");
  assert.deepEqual(d.added, ["0xlead"]);
  assert.deepEqual(d.removed, []);
});

test("diffCopyLeaders: unfollow-all → all removed", () => {
  const d = diffCopyLeaders(["0xA", "0xB"], [], "0xME");
  assert.deepEqual(d.added, []);
  assert.deepEqual(new Set(d.removed), new Set(["0xa", "0xb"]));
});

// ── Mispriced board (funding-edge lens) ──────────────────────────────────────
const futuresRow = (symbol, mark, funding8h, oiBase, open24) =>
  ({ symbol, mark_price: mark, last_funding_rate: funding8h, open_interest: oiBase, "24h_open": open24 });

test("mispricedBoard: positive funding → fade SHORT, annualized edge, flagged", () => {
  // +0.02%/8h → *1095 = +21.9%/yr, well past minEdgePct(8).
  const { markets, scanned, mispricedCount } = mispricedBoard([
    futuresRow("PERP_BTC_USDC", 60000, 0.0002, 100, 59000),
  ]);
  assert.equal(scanned, 1);
  assert.equal(markets.length, 1);
  const m = markets[0];
  assert.equal(m.coin, "BTC");
  assert.equal(m.direction, "SHORT");
  assert.equal(m.fundingAnnualPct, 21.9);
  assert.equal(m.edge, 21.9);
  assert.equal(m.status, "MISPRICED");
  assert.equal(mispricedCount, 1);
  assert.equal(m.change24hPct, 1.69); // (60000-59000)/59000
});

test("mispricedBoard: negative funding → fade LONG", () => {
  const { markets } = mispricedBoard([futuresRow("PERP_ETH_USDC", 3000, -0.0003, 5000, 3000)]);
  assert.equal(markets[0].direction, "LONG");
  assert.ok(markets[0].fundingAnnualPct < 0);
});

test("mispricedBoard: small funding stays PRICED_FAIR", () => {
  // +0.001%/8h → ~3.3%/yr, below minEdgePct.
  const { markets, mispricedCount } = mispricedBoard([futuresRow("PERP_SOL_USDC", 150, 0.00001, 100000, 150)]);
  assert.equal(markets[0].status, "PRICED_FAIR");
  assert.equal(mispricedCount, 0);
});

test("mispricedBoard: illiquid market below OI floor is skipped", () => {
  // 0.1 base * $100 = $10 OI, well under minOiUsd(50k).
  const { markets, scanned } = mispricedBoard([futuresRow("PERP_DUST_USDC", 100, 0.01, 0.1, 100)]);
  assert.equal(scanned, 0);
  assert.equal(markets.length, 0);
});

test("mispricedBoard: ranks by |edge| descending", () => {
  const { markets } = mispricedBoard([
    futuresRow("PERP_A_USDC", 100, 0.0001, 100000, 100),  // ~11%/yr
    futuresRow("PERP_B_USDC", 100, -0.0005, 100000, 100), // ~-55%/yr → biggest |edge|
    futuresRow("PERP_C_USDC", 100, 0.00002, 100000, 100), // ~2%/yr
  ]);
  assert.deepEqual(markets.map((m) => m.coin), ["B", "A", "C"]);
});

test("mispricedBoard: junk rows ignored (no symbol / bad price)", () => {
  const { scanned } = mispricedBoard([{}, { symbol: "PERP_X_USDC", mark_price: 0, last_funding_rate: 0.01, open_interest: 1e6 }, null]);
  assert.equal(scanned, 0);
});

// ── Consensus by symbol (merit-weighted caller lean) ─────────────────────────
test("consensusBySymbol: weighted lean picks the heavier side", () => {
  const c = consensusBySymbol([
    { wallet: "0xA", symbol: "BTC", direction: "LONG", weight: 3 },  // Apex
    { wallet: "0xB", symbol: "BTC", direction: "SHORT", weight: 1 },
  ]);
  assert.equal(c.BTC.side, "LONG");
  assert.equal(c.BTC.lean, 0.5); // (3-1)/4
  assert.equal(c.BTC.participants, 2);
});

test("consensusBySymbol: even split → SPLIT", () => {
  const c = consensusBySymbol([
    { wallet: "0xA", symbol: "ETH", direction: "LONG", weight: 2 },
    { wallet: "0xB", symbol: "ETH", direction: "SHORT", weight: 2 },
  ]);
  assert.equal(c.ETH.side, "SPLIT");
  assert.equal(c.ETH.lean, 0);
});

test("consensusBySymbol: a wallet on both sides is voided for that symbol", () => {
  const c = consensusBySymbol([
    { wallet: "0xA", symbol: "SOL", direction: "LONG", weight: 2 },
    { wallet: "0xA", symbol: "SOL", direction: "SHORT", weight: 2 }, // self-contradiction
    { wallet: "0xB", symbol: "SOL", direction: "LONG", weight: 1 },
  ]);
  assert.equal(c.SOL.longCount, 1); // only 0xB survives
  assert.equal(c.SOL.side, "LONG");
});

test("consensusBySymbol: same wallet same side twice → strongest weight, not doubled", () => {
  const c = consensusBySymbol([
    { wallet: "0xA", symbol: "BTC", direction: "LONG", weight: 1, source: "thesis" },
    { wallet: "0xA", symbol: "BTC", direction: "LONG", weight: 3, source: "position" },
  ]);
  assert.equal(c.BTC.longWeight, 3);
  assert.equal(c.BTC.longCount, 1);
});

// ── Funding reversion (the "proof" stat) ─────────────────────────────────────
const HOUR = 3600 * 1000;
// n hourly points, positive (crowd-long) funding, price falling `dropPctPerHr` each hr.
const revSeries = (n, funding, startPrice, dropPctPerHr) =>
  Array.from({ length: n }, (_, i) => ({ t: 1_000_000_000_000 + i * HOUR, funding, price: startPrice * (1 - dropPctPerHr / 100 * i) }));

test("fundingReversion: crowd-long + price falls → positive reversion, reverted 100%", () => {
  const r = fundingReversion(revSeries(24, 0.001, 100, 1), { horizonH: 3, band: 0.7, minSamples: 2 });
  assert.ok(r, "expected a result");
  assert.equal(r.crowd, "long");
  assert.ok(r.avgReversionPct > 0, `avg should be positive, got ${r.avgReversionPct}`);
  assert.equal(r.revertedPct, 100);
  assert.equal(r.horizonDays, 0); // 3h rounds to 0 days — fine for the test
});

test("fundingReversion: crowd-long + price RISES → negative reversion (fade failed)", () => {
  // price rises 1%/hr → move is +, against-crowd is negative.
  const r = fundingReversion(revSeries(24, 0.001, 100, -1), { horizonH: 3, band: 0.7, minSamples: 2 });
  assert.ok(r);
  assert.ok(r.avgReversionPct < 0, `avg should be negative, got ${r.avgReversionPct}`);
  assert.equal(r.revertedPct, 0);
});

test("fundingReversion: too few samples → null", () => {
  // Only ~2 non-overlapping windows over a huge horizon → below minSamples(4 default).
  assert.equal(fundingReversion(revSeries(20, 0.001, 100, 1)), null);
});

test("fundingReversion: flat/zero current funding → null", () => {
  const pts = revSeries(24, 0.001, 100, 1); pts[pts.length - 1].funding = 0;
  assert.equal(fundingReversion(pts, { horizonH: 3, band: 0.7, minSamples: 2 }), null);
});

test("fundingReversion: short history → null", () => {
  assert.equal(fundingReversion(revSeries(6, 0.001, 100, 1)), null);
});

// ── Edge quality (the board's self-awareness) ────────────────────────────────
test("edgeQuality: high revert rate → PROVEN", () => {
  assert.equal(edgeQuality({ revertedPct: 65, samples: 10 }).tier, "PROVEN");
});
test("edgeQuality: low revert rate → TRAP (fading has failed)", () => {
  assert.equal(edgeQuality({ revertedPct: 20, samples: 10 }).tier, "TRAP");
});
test("edgeQuality: middling → MIXED", () => {
  assert.equal(edgeQuality({ revertedPct: 50, samples: 10 }).tier, "MIXED");
});
test("edgeQuality: no reversion data → UNPROVEN", () => {
  assert.equal(edgeQuality(null).tier, "UNPROVEN");
  assert.equal(edgeQuality({ samples: 0 }).tier, "UNPROVEN");
});

// ── mergeFundingPrice (universal reversion input from public Orderly history) ──
test("mergeFundingPrice: pairs each funding stamp with the candle at/before it", () => {
  const price = { t: [1000, 2000, 3000, 4000], c: [10, 20, 30, 40] }; // t in sec
  // rows come newest-first from the API (descending) — must be sorted ascending.
  const funding = [
    { funding_rate: 0.002, funding_rate_timestamp: 3500 * 1000 }, // → candle t≤3500 = 3000 → 30
    { funding_rate: 0.001, funding_rate_timestamp: 2500 * 1000 }, // → candle t≤2500 = 2000 → 20
  ];
  const out = mergeFundingPrice(funding, price);
  assert.deepEqual(out, [
    { t: 2500000, price: 20, funding: 0.001 },
    { t: 3500000, price: 30, funding: 0.002 },
  ]);
});

test("mergeFundingPrice: funding before first candle uses the first close", () => {
  const out = mergeFundingPrice([{ funding_rate: 0.001, funding_rate_timestamp: 500 * 1000 }], { t: [1000, 2000], c: [10, 20] });
  assert.equal(out[0].price, 10);
});

test("mergeFundingPrice: junk inputs → []", () => {
  assert.deepEqual(mergeFundingPrice(null, { t: [1], c: [1] }), []);
  assert.deepEqual(mergeFundingPrice([{ funding_rate: 1, funding_rate_timestamp: 1 }], null), []);
  assert.deepEqual(mergeFundingPrice([{}], { t: [], c: [] }), []);
});

// ── Tracked x-ray record (xrayTrack) ─────────────────────────────────────────
import { xrayTrack } from "./logic.mjs";

const DAY = 86400 * 1000;
// Build snapshots from a list of cumulative realized-PnL readings, one per day.
const snapsFrom = (realizeds, opts = {}) =>
  realizeds.map((realized, i) => ({ t: (opts.t0 ?? 0) + i * DAY, realized, unrealized: 0, markets: 3, wins: 2, losses: 1, open: opts.open ?? 0 }));

test("xrayTrack: <2 snapshots → building (nothing to grade yet)", () => {
  assert.equal(xrayTrack([]).building, true);
  assert.equal(xrayTrack([{ t: 0, realized: 100 }]).building, true);
  assert.equal(xrayTrack([{ t: 0, realized: 100 }]).points, 1);
});

test("xrayTrack: grades REALIZED DELTAS, not the cumulative total", () => {
  // Cumulative 1000→1100→1250 = +100 then +150 earned WHILE tracked (net +250),
  // never the lifetime 1250 the wallet already had before we watched.
  const r = xrayTrack(snapsFrom([1000, 1100, 1250]));
  assert.equal(r.netRealized, 250);
  assert.equal(r.windows, 2);
  assert.deepEqual(r.curve, [0, 100, 250]);
  assert.equal(r.winWindowRate, 100);
  assert.equal(r.trend, "UP");
});

test("xrayTrack: mixed windows → honest win-window rate + drawdown", () => {
  // deltas: +100, -60, +40  → net +80; one losing window of 3.
  const r = xrayTrack(snapsFrom([0, 100, 40, 80]));
  assert.equal(r.netRealized, 80);
  assert.equal(r.winWindows, 2);
  assert.equal(r.winWindowRate, round2(2 / 3 * 100));
  assert.equal(r.worstWindow, -60);
  assert.equal(r.bestWindow, 100);
  assert.equal(r.maxDrawdown, 60); // peak 100 → trough 40
});

test("xrayTrack: net-negative record scores but earns NO tier", () => {
  const r = xrayTrack(snapsFrom([0, -50, -30, -120, -90]));
  assert.ok(r.netRealized < 0);
  assert.equal(r.tier, null);
  assert.equal(r.trend, "DOWN");
  assert.ok(r.operatorScore >= 0); // still visible, just low
});

test("xrayTrack: score is sample-shrunk — one great window can't mint a high score", () => {
  // Perfect-but-short (2 windows) must score well below a long consistent record.
  const shortRec = xrayTrack(snapsFrom([0, 500, 1000]));      // 2 windows, flawless
  const longRec = xrayTrack(snapsFrom(Array.from({ length: 21 }, (_, i) => i * 100))); // 20 windows, flawless
  assert.ok(longRec.operatorScore > shortRec.operatorScore);
  assert.equal(shortRec.operatorScore, null); // <4 windows → not scored at all
});

test("xrayTrack: consistent long positive record earns the top tier", () => {
  const r = xrayTrack(snapsFrom(Array.from({ length: 16 }, (_, i) => i * 100)));
  assert.equal(r.tier.tier, "CONSISTENT");
  assert.ok(r.operatorScore >= 65);
});

test("xrayTrack: collapses same-day snapshots to the last (no zero-length windows)", () => {
  const noisy = [
    { t: 0, realized: 0 }, { t: 1000, realized: 10 },      // same UTC day → keep realized:10
    { t: DAY, realized: 50 }, { t: DAY + 500, realized: 60 }, // same day → keep 60
  ];
  const r = xrayTrack(noisy);
  assert.equal(r.points, 2);
  assert.equal(r.netRealized, 50); // day0 keeps realized:10, day1 keeps realized:60 → 60-10
  assert.equal(r.windows, 1);
});

test("xrayTrack: a long snapshot GAP is not counted as a green day", () => {
  // day0 → day30 (a 30-day gap, +5000) must NOT read as one flawless green window.
  // Then two genuine daily windows: flat, then red.
  const r = xrayTrack([
    { t: 0, realized: 0 },
    { t: 30 * DAY, realized: 5000 }, // gap window — excluded from consistency
    { t: 31 * DAY, realized: 5000 }, // flat day (delta 0, not green)
    { t: 32 * DAY, realized: 4900 }, // red day
  ]);
  assert.equal(r.windows, 3);
  assert.equal(r.gradedWindows, 2);      // only the two 1-day windows count
  assert.equal(r.gapWindows, 1);
  assert.equal(r.netRealized, 4900);     // headline total is still the real money
  assert.equal(r.winWindows, 0);         // neither graded window was green
  assert.equal(r.winWindowRate, 0);
  assert.equal(r.bestWindow, 0);         // best/worst read graded windows, not the +5000 gap
});

test("xrayTrack: an all-gap series withholds the consistency read (null), total stays real", () => {
  const r = xrayTrack([
    { t: 0, realized: 0 },
    { t: 10 * DAY, realized: 300 },
    { t: 25 * DAY, realized: 500 },
  ]);
  assert.equal(r.gradedWindows, 0);
  assert.equal(r.winWindowRate, null);   // no daily-cadence data → no fake rate
  assert.equal(r.operatorScore, null);   // can't score consistency we don't have
  assert.equal(r.scored, false);
  assert.equal(r.netRealized, 500);      // but the earned total is honest
});

test("xrayTrack: gap windows can't inflate the score above a clean daily record", () => {
  // A wallet with one giant lucky gap + few daily windows must not outscore a
  // long, clean daily record — the gap simply doesn't enter the score.
  const gappy = xrayTrack([
    { t: 0, realized: 0 }, { t: 40 * DAY, realized: 100000 }, // huge gap, excluded
    { t: 41 * DAY, realized: 100050 }, { t: 42 * DAY, realized: 100100 },
    { t: 43 * DAY, realized: 100160 }, { t: 44 * DAY, realized: 100230 },
  ]);
  assert.ok(gappy.gapWindows >= 1);
  assert.equal(gappy.scored, gappy.gradedWindows >= 4);
});

function round2(n) { return Math.round(n * 10) / 10; }

// ── Contested standoff edge (aggregateSideRecord + standoffVerdict) ───────────
import { aggregateSideRecord, standoffVerdict } from "./logic.mjs";

test("aggregateSideRecord: sums calls/wins/rSum and derives rate + avgR", () => {
  const a = aggregateSideRecord([{ calls: 10, wins: 6, rSum: 8 }, { calls: 5, wins: 2, rSum: 1 }]);
  assert.equal(a.calls, 15);
  assert.equal(a.wins, 8);
  assert.equal(a.rSum, 9);
  assert.equal(a.winRate, round1(8 / 15 * 100));
  assert.equal(a.avgR, round2(9 / 15));
});

test("aggregateSideRecord: empty side → null rates, not zero (nothing to claim)", () => {
  const a = aggregateSideRecord([]);
  assert.equal(a.calls, 0);
  assert.equal(a.winRate, null);
  assert.equal(a.avgR, null);
});

test("standoffVerdict: picks the side with the better avg-R when both have a sample", () => {
  const v = standoffVerdict({ calls: 6, avgR: 0.9 }, { calls: 5, avgR: 0.1 });
  assert.equal(v.side, "LONG");
  assert.equal(v.gapR, 0.8);
});

test("standoffVerdict: withheld when a side lacks graded calls", () => {
  const v = standoffVerdict({ calls: 8, avgR: 1.2 }, { calls: 1, avgR: -0.5 });
  assert.equal(v.side, null);
  assert.match(v.reason, /not enough graded calls/);
});

test("standoffVerdict: withheld when records are too close to call", () => {
  const v = standoffVerdict({ calls: 10, avgR: 0.5 }, { calls: 10, avgR: 0.4 });
  assert.equal(v.side, null);
  assert.match(v.reason, /too close/);
});

test("standoffVerdict: a stronger SHORT side wins", () => {
  const v = standoffVerdict({ calls: 5, avgR: -0.2 }, { calls: 7, avgR: 0.9 });
  assert.equal(v.side, "SHORT");
  assert.equal(v.gapR, 1.1);
});

function round1(n) { return Math.round(n * 10) / 10; }

// ── Contrarian grading (stanceAtPost / classifyContrarian / contrarianEdgeScore) ──
import { stanceAtPost, classifyContrarian, contrarianEdgeScore } from "./logic.mjs";

const stanceHist = [
  { t: 1000, side: "LONG", participants: 3 },
  { t: 2000, side: "SHORT", participants: 4 },
  { t: 3000, side: "SPLIT", participants: 5 },   // not a lean → skipped
  { t: 4000, side: "LONG", participants: 1 },     // thin → skipped
];

test("stanceAtPost: picks the latest qualifying snapshot at/before the call", () => {
  assert.deepEqual(stanceAtPost(stanceHist, 2500), { side: "SHORT", participants: 4 });
  assert.deepEqual(stanceAtPost(stanceHist, 1500), { side: "LONG", participants: 3 });
});

test("stanceAtPost: skips SPLIT + thin snapshots, so a later thin/split doesn't win", () => {
  // At t=5000 the newest snapshots are SPLIT(3000) and thin LONG(4000) → fall back to SHORT(2000).
  assert.deepEqual(stanceAtPost(stanceHist, 5000), { side: "SHORT", participants: 4 });
});

test("stanceAtPost: null when every snapshot post-dates the call (cold-start)", () => {
  assert.equal(stanceAtPost(stanceHist, 500), null);
  assert.equal(stanceAtPost([], 9999), null);
  assert.equal(stanceAtPost(stanceHist, "nope"), null);
});

test("stanceAtPost: honors a custom minParticipants gate", () => {
  assert.equal(stanceAtPost([{ t: 1, side: "LONG", participants: 2 }], 10, { minParticipants: 3 }), null);
});

test("classifyContrarian: opposing the lean = CONTRARIAN, matching = WITH_CROWD", () => {
  assert.equal(classifyContrarian("SHORT", "LONG"), "CONTRARIAN");
  assert.equal(classifyContrarian("LONG", "LONG"), "WITH_CROWD");
  assert.equal(classifyContrarian("long", "LONG"), "WITH_CROWD"); // case-insensitive
});

test("classifyContrarian: null when either side is missing/invalid", () => {
  assert.equal(classifyContrarian("LONG", "SPLIT"), null);
  assert.equal(classifyContrarian("LONG", null), null);
  assert.equal(classifyContrarian("", "LONG"), null);
});

test("contrarianEdgeScore: withheld below the contrarian sample gate", () => {
  assert.equal(contrarianEdgeScore({ calls: 2, avgR: 3 }, { calls: 10, avgR: 0 }), null);
});

test("contrarianEdgeScore: shrinks contrarian avg-R and computes edge vs with-crowd", () => {
  const r = contrarianEdgeScore({ calls: 6, wins: 4, winRate: 66.7, avgR: 1.0 }, { calls: 10, avgR: 0.2 });
  assert.equal(r.edge, 0.8);                     // 1.0 − 0.2
  assert.equal(r.score, Math.round(1.0 * (6 / 10) * 1000) / 1000); // shrunk by 6/(6+4)
  assert.equal(r.avgR, 1.0);
});

test("contrarianEdgeScore: with no with-crowd sample, edge is vs zero", () => {
  const r = contrarianEdgeScore({ calls: 5, avgR: 0.5 }, { calls: 0 });
  assert.equal(r.edge, 0.5);
});

// ── Forecast Divergence (prediction-market lens) ─────────────────────────────
test("parsePriceTarget: extracts $-anchored strikes with k/m suffixes + direction", () => {
  assert.deepEqual(parsePriceTarget("Will Bitcoin reach $150,000 by Dec 2026?"), { target: 150000, direction: "UP" });
  assert.deepEqual(parsePriceTarget("Will BTC hit $130k in 2026?"), { target: 130000, direction: "UP" });
  assert.deepEqual(parsePriceTarget("Will ETH fall below $2k this year?"), { target: 2000, direction: "DOWN" });
  assert.deepEqual(parsePriceTarget("Will SOL top $1.5M market... $300 reach?"), { target: 1500000, direction: "UP" });
});

test("parsePriceTarget: null without a $ anchor (never mistakes a year for a strike)", () => {
  assert.equal(parsePriceTarget("Will Bitcoin flip gold by 2026?"), null);
  assert.equal(parsePriceTarget("Will there be a spot XRP ETF?"), null);
  assert.equal(parsePriceTarget(""), null);
});

const futures = [
  { symbol: "PERP_BTC_USDC", mark_price: 118000, last_funding_rate: 0.0001 },   // funding + ⇒ tape leans UP
  { symbol: "PERP_ETH_USDC", mark_price: 3000, last_funding_rate: -0.0002 },    // funding − ⇒ tape leans DOWN
];

test("forecastDivergence: flags a near-money conviction divergence (forecast UP vs tape DOWN)", () => {
  const poly = [
    // ETH: near-money $3,300 (+10%) at 72% YES ⇒ crowd leans UP; funding negative ⇒ tape DOWN ⇒ DIVERGENT
    { id: "1", question: "Will Ethereum reach $3,300 by Sept?", outcomes: '["Yes","No"]', outcomePrices: '["0.72","0.28"]', volumeNum: 250000, liquidity: "40000", endDate: "2026-09-30" },
  ];
  const r = forecastDivergence(poly, futures);
  assert.equal(r.markets.length, 1);
  const m = r.markets[0];
  assert.equal(m.coin, "ETH");
  assert.equal(m.symbol, "PERP_ETH_USDC");
  assert.equal(m.forecastProbPct, 72);
  assert.equal(m.target, 3300);
  assert.equal(m.targetDirection, "UP");
  assert.equal(m.forecastLean, "UP");     // 72% YES on an up-bet ⇒ crowd leans UP
  assert.equal(m.nearMoney, true);
  assert.equal(m.fundingLean, "DOWN");
  assert.equal(m.alignment, "DIVERGENT");
  assert.equal(m.divergence, true);
  assert.equal(r.divergentCount, 1);
});

test("forecastDivergence: probability fold — low YES on a far DOWN tail = UP lean, never flagged", () => {
  const poly = [
    // "dip to $15k" at 2.6% YES: crowd 97% says it WON'T dip ⇒ effectively bullish (UP), matching funding.
    { id: "2", question: "Will Bitcoin dip to $15,000 by 2026?", outcomes: '["Yes","No"]', outcomePrices: '["0.026","0.974"]', volumeNum: 900000 },
  ];
  const r = forecastDivergence(poly, futures);
  const m = r.markets[0];
  assert.equal(m.targetDirection, "DOWN");
  assert.equal(m.forecastLean, "UP");     // folded: low YES on a DOWN bet ⇒ UP lean (not DOWN)
  assert.equal(m.nearMoney, false);       // −87% away ⇒ tail strike, no directional read
  assert.equal(m.alignment, null);        // far strike ⇒ not scored for divergence
  assert.equal(m.divergence, false);
});

test("forecastDivergence: aligned when folded forecast lean matches funding lean", () => {
  const poly = [
    // Near-money $125k (+6%) at 65% YES ⇒ UP lean; BTC funding + ⇒ UP ⇒ ALIGNED
    { id: "3", question: "Will Bitcoin reach $125,000 by Sept?", outcomes: '["Yes","No"]', outcomePrices: '["0.65","0.35"]', volumeNum: 500000, endDate: "2026-09-30" },
  ];
  const r = forecastDivergence(poly, futures);
  assert.equal(r.markets[0].nearMoney, true);
  assert.equal(r.markets[0].forecastLean, "UP");
  assert.equal(r.markets[0].fundingLean, "UP");
  assert.equal(r.markets[0].alignment, "ALIGNED");
  assert.equal(r.markets[0].divergence, false);
});

test("forecastDivergence: a coin-flip forecast is not a divergence (conviction gate)", () => {
  const poly = [
    // Near-money but 52% ⇒ folded lean UP, funding DOWN ⇒ DIVERGENT direction, but conviction 2 < 15
    { id: "4", question: "Will Ethereum reach $3,200 by Sept?", outcomes: '["Yes","No"]', outcomePrices: '["0.52","0.48"]', volumeNum: 80000 },
  ];
  const r = forecastDivergence(poly, futures);
  assert.equal(r.markets[0].nearMoney, true);
  assert.equal(r.markets[0].alignment, "DIVERGENT"); // direction disagrees…
  assert.equal(r.markets[0].divergence, false);       // …but 52% is a coin-flip ⇒ not flagged
});

test("classifyMacro categorizes events and attaches a lens only where textbook", () => {
  assert.deepEqual(classifyMacro("Will the Fed cut rates in December?"), { category: "RATES", riskLens: "RISK_ON" });
  assert.deepEqual(classifyMacro("Will the Fed hike rates in Q1?"), { category: "RATES", riskLens: "RISK_OFF" });
  assert.deepEqual(classifyMacro("US recession in 2026?"), { category: "ECONOMY", riskLens: "RISK_OFF" });
  assert.equal(classifyMacro("Will Iran and Israel reach a ceasefire?").riskLens, "RISK_ON");
  assert.equal(classifyMacro("Will Russia launch a new missile strike on Kyiv?").riskLens, "RISK_OFF");
  // an election has a category but NO confident directional lens
  assert.deepEqual(classifyMacro("Who will win the 2028 presidential election?"), { category: "ELECTION", riskLens: null });
  // off-topic (sports/pop) is not a macro event at all
  assert.equal(classifyMacro("Will the Chiefs win the Super Bowl?"), null);
  // CRYPTO_POLICY requires policy context — a bare crypto/ETF mention is NOT a macro event
  assert.equal(classifyMacro("ETF flows look strong, breakout incoming"), null);
  assert.equal(classifyMacro("crypto rally continues"), null);
  assert.deepEqual(classifyMacro("Will the SEC approve a Solana ETF?"), { category: "CRYPTO_POLICY", riskLens: "RISK_ON" });
  assert.equal(classifyMacro("Will Congress pass a stablecoin bill?").category, "CRYPTO_POLICY");
});

test("classifyMacro lens is robust to word SUFFIXES (the trailing-\\b bug class)", () => {
  // RATES — plural/gerund forms that a bare \b would have dropped
  assert.equal(classifyMacro("Fed cuts rates in March?").riskLens, "RISK_ON");
  assert.equal(classifyMacro("Will the Fed keep hiking rates?").riskLens, "RISK_OFF");
  assert.equal(classifyMacro("Fed raises rates 25bps?").riskLens, "RISK_OFF");
  assert.equal(classifyMacro("Fed pauses rate decisions?").riskLens, "RISK_ON");
  // ECONOMY
  assert.equal(classifyMacro("Will inflation cool by year-end?").riskLens, "RISK_ON"); // "cool"
  assert.equal(classifyMacro("US recession fears grow?").riskLens, "RISK_OFF");        // "recession"
  // GEOPOLITICS — escalates/strikes/wars
  assert.equal(classifyMacro("Will the conflict escalate further?").riskLens, "RISK_OFF");
  assert.equal(classifyMacro("Will Israel strike Iran again?").riskLens, "RISK_OFF");
  assert.equal(classifyMacro("Will the ceasefire hold?").riskLens, "RISK_ON");
  // CRYPTO_POLICY — approves/rejects/bans
  assert.equal(classifyMacro("Will the SEC reject the ETF?").riskLens, "RISK_OFF");
  assert.equal(classifyMacro("Will China ban crypto again?").riskLens, "RISK_OFF");
  // guard against short-word false positives from the \w* stems
  assert.equal(classifyMacro("Will the weather stay warm in Iran?").riskLens, null, "'warm' must NOT match the 'war' risk-off lens");
  assert.equal(classifyMacro("Bank earnings beat?"), null, "'bank' must not trip a macro category");
});

test("macroEvents builds a volume-ranked board, gating low volume + non-macro", () => {
  const poly = [
    { id: "a", question: "Will the Fed cut rates in December?", outcomes: '["Yes","No"]', outcomePrices: '["0.7","0.3"]', volumeNum: 500000, liquidity: 40000, endDate: "2026-12-18" },
    { id: "b", question: "US recession in 2026?", outcomes: '["Yes","No"]', outcomePrices: '["0.35","0.65"]', volumeNum: 900000 },
    { id: "c", question: "Will BTC hit $200k?", outcomes: '["Yes","No"]', outcomePrices: '["0.2","0.8"]', volumeNum: 300000 }, // price-target, not macro-classified here
    { id: "d", question: "Will the Fed cut rates in March?", outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volumeNum: 100 }, // below min volume
  ];
  const r = macroEvents(poly);
  assert.equal(r.events.length, 2, "only the two liquid macro events");
  assert.equal(r.events[0].id, "b", "highest volume first");
  assert.equal(r.events[0].yesProbPct, 35);
  assert.equal(r.events[0].riskLens, "RISK_OFF");
  assert.equal(r.events[1].category, "RATES");
});

test("forecastDivergence: filters dust volume, closed markets, and unlisted assets", () => {
  const poly = [
    { id: "5", question: "Will Bitcoin reach $150k?", outcomes: '["Yes","No"]', outcomePrices: '["0.6","0.4"]', volumeNum: 100 },       // dust
    { id: "6", question: "Will Bitcoin reach $200k?", outcomes: '["Yes","No"]', outcomePrices: '["0.3","0.7"]', volumeNum: 999999, closed: true }, // closed
    { id: "7", question: "Will PEPE reach $0.01?", outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', volumeNum: 999999 },        // unlisted asset
  ];
  const r = forecastDivergence(poly, futures);
  assert.equal(r.markets.length, 0);
});

test("forecastDivergence: coin filter + non-target market surfaces forecast with no divergence", () => {
  const poly = [
    { id: "7", question: "Will there be a spot Solana ETF approved in 2026?", outcomes: '["Yes","No"]', outcomePrices: '["0.8","0.2"]', volume: "300000" },
    { id: "8", question: "Will Bitcoin reach $150k?", outcomes: '["Yes","No"]', outcomePrices: '["0.6","0.4"]', volume: "300000" },
  ];
  const r = forecastDivergence(poly, [...futures, { symbol: "PERP_SOL_USDC", mark_price: 180, last_funding_rate: 0.0001 }], FORECAST, { coin: "SOL" });
  assert.equal(r.markets.length, 1);
  assert.equal(r.markets[0].coin, "SOL");
  assert.equal(r.markets[0].target, null);          // not a price-target market
  assert.equal(r.markets[0].divergence, false);
  assert.equal(r.markets[0].forecastProbPct, 80);
});

// ── houseCallFromSignal (systematic house call that seeds the caller board) ────
test("houseCallFromSignal: SHORT fade sets TP below / SL above entry, grades WIN on revert", () => {
  const m = { coin: "BTC", markPrice: 100000, direction: "SHORT", fundingAnnualPct: 40 };
  const call = houseCallFromSignal(m, 1000);
  assert.equal(call.direction, "SHORT");
  assert.equal(call.entryPrice, 100000);
  assert.ok(call.takeProfit1 < 100000, "short TP is below entry");
  assert.ok(call.stopLoss > 100000, "short SL is above entry");
  assert.equal(call.isPublic, true);
  assert.equal(call.source, "nexus-signal");
  // a candle that touches TP (price fell) before SL → WIN via the same public engine
  const cd = { t: [1001], h: [100050], l: [call.takeProfit1 - 1] };
  assert.equal(gradeCall(call, cd).outcome, "WIN");
});

test("houseCallFromSignal: LONG fade inverts levels; NONE / bad mark → null", () => {
  const long = houseCallFromSignal({ coin: "SOL", markPrice: 150, direction: "LONG", fundingAnnualPct: -30 }, 1);
  assert.ok(long.takeProfit1 > 150 && long.stopLoss < 150, "long TP above / SL below");
  assert.equal(houseCallFromSignal({ coin: "X", markPrice: 10, direction: "NONE", fundingAnnualPct: 0 }), null);
  assert.equal(houseCallFromSignal({ coin: "X", markPrice: 0, direction: "SHORT", fundingAnnualPct: 5 }), null);
});

// ── wargameScenario (Miroshark red-team prompt builder) ────────────────────────
test("wargameScenario: thesis + macro + freeform build directional red-team prompts", () => {
  const th = wargameScenario({ kind: "thesis", coin: "BTC", direction: "SHORT", target: 90000, entry: 100000, notes: "funding stretched" });
  assert.match(th, /BTC falls toward 90000 from 100000/);
  assert.match(th, /bull case/); assert.match(th, /bear case/); assert.match(th, /invalidate/);
  const mc = wargameScenario({ kind: "macro", question: "Fed cuts in Sept?", yesProbPct: 62, lens: "RISK_ON" });
  assert.match(mc, /Fed cuts in Sept\?/); assert.match(mc, /62% YES/); assert.match(mc, /RISK_ON/);
  assert.equal(wargameScenario({ query: "" }), "");
  assert.match(wargameScenario({ query: "ETF approved" }), /Simulate reactions to: ETF approved/);
});

// ── creatorEarnings (#2 per-thesis fee-share) ──────────────────────────────────
import { creatorEarnings, CREATOR_FEE } from "./logic.mjs";
test("creatorEarnings: fee = notional × bps × round-trip × share; dedupes copiers", () => {
  const rows = [
    { entry_price: 100, qty: 10, symbol: "PERP_BTC_USDC", wallet_address: "0xAAA" }, // notional 1000
    { entry_price: 50, qty: 4, symbol: "PERP_ETH_USDC", wallet_address: "0xaaa" },   // notional 200 (same copier, cased)
    { entry_price: 0, qty: 5, symbol: "PERP_X_USDC", wallet_address: "0xBBB" },       // zero notional → skipped
  ];
  const e = creatorEarnings(rows);
  assert.equal(e.trades, 2);
  assert.equal(e.copiers, 1); // 0xAAA == 0xaaa
  assert.equal(e.volumeUsd, 1200);
  // fee = 1200 * 2.5/10000 * 2 = 0.6 ; earned = 0.6 * 0.20 = 0.12
  assert.equal(e.feesUsd, 0.6);
  assert.equal(e.earnedUsd, 0.12);
  assert.equal(e.sharePct, 20);
});
test("creatorEarnings: empty → zeros", () => {
  const e = creatorEarnings([]);
  assert.equal(e.trades, 0); assert.equal(e.earnedUsd, 0);
});
