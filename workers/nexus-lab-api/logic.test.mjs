// Trustless call-grading tests for nexus-lab-api.
// Run: node --test workers/nexus-lab-api/logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { gradeCall, resolveAiUpstream, bankrGatewayModel, rankCaller, confluenceSignal } from "./logic.mjs";

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
import { nexusMinUnits } from "./logic.mjs";

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
