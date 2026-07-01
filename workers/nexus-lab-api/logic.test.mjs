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
