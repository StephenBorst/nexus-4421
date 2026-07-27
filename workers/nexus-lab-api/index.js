/**
 * nexus-lab-api — Cloudflare Worker
 *
 * KV namespace binding: LAB_STORE  (set in Cloudflare dashboard)
 *
 * Routes:
 *   GET    /lab/:address              → fetch all LAB data for wallet
 *   PUT    /lab/:address              → save all LAB data for wallet
 *   DELETE /lab/:address/thesis/:id   → remove one thesis
 *   GET    /profile/:address          → fetch profile { pfp, displayName }
 *   PUT    /profile/:address          → save profile { pfp, displayName }
 *   GET    /feed                      → public theses feed (all wallets, isPublic=true)
 *   GET    /og/trader/:wallet         → Ph16: SVG OG image for trader profile
 *   GET    /og/trader/:wallet.png     → Ph21: PNG OG image for Twitter (via resvg-wasm)
 *   GET    /wallets/onchain           → Ph17: on-chain wallet discovery via ThesisRegistered logs
 */

// Ph21: resvg-wasm for PNG generation (Twitter support)
// Bundled by wrangler esbuild — run `npm install` in this directory before `wrangler deploy`
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
// Holders Room signature gate — EIP-191 ecrecover (verifies wallet ownership)
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes, bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { gradeCall, verifyErc20Payment, nexusMinUnits, resolveHostedModel, resolveAiUpstream, confluenceSignal, buildChallenge, verifyV2, AUTH_V2_ACTIONS, AGENT_BOARD, aggregateAgentTrades, agentStanding, parseWebhookAlert, normalizeSymbol, percentileRank, oiStats, orderlyAccountId, safeChartUrl, symbolToQuery } from "./logic.mjs";

import { backtestConfig, runSweep, oiSeriesInfo, walkForwardValidate } from "./backtest.mjs";
// Route families lifted out of the 74-route fetch handler (see shared.mjs for the
// migration rules — one family per commit, read-only families first).
import { handleSmart, refreshSmartSeed } from "./routes-smart.mjs";
import { handleTheses } from "./routes-theses.mjs";
import { json, cors, normalizeAddress, recoverEthAddress, ALLOWED_ORIGINS } from "./shared.mjs";
import { gradedStatusOf, fetchGradeHistory, gradePublicTheses, computeCallerStats, REGIME_PAD_S, ADVICE_FLAG_TEXT } from "./grading.mjs";
// Directive level validation lives with the exec's money-path logic (single source);
// wrangler bundles the cross-dir import (same as backtest.mjs).
import { directiveLevels } from "../nexus-agent-exec/logic.mjs";

// Orderly sits behind Cloudflare bot-management, which intermittently serves an HTML
// 403 challenge to header-light Worker fetches — which would break the mini-app money
// path (register / key / trade / close / withdraw), /agents/live mark-price, and
// backtest data reads. Rather than touch ~30 call sites in this money-path worker, wrap
// the global fetch ONCE to attach realistic browser headers to Orderly requests only;
// every non-Orderly fetch (Supabase, RPC, Anthropic) passes through untouched. Mirrors
// the header fix in nexus-agent-exec / -brain.
const ORDERLY_BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};
const _origFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (url.includes("api-evm.orderly.org")) {
    init = { ...init, headers: { ...ORDERLY_BROWSER_HEADERS, ...(init.headers || {}) } };
  }
  return _origFetch(input, init);
};

// URL-safe random token (hook secret / passphrase). Crypto-strong via Web Crypto.
function randToken(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}


// Canonical message both client and server build identically.
function holdersRoomMessage(address, ts) {
  return `Nexus Holders Room\nAddress: ${address.toLowerCase()}\nTimestamp: ${ts}`;
}

// Hosted-AI access challenge (proves the caller owns a PRO wallet).
function aiAccessMessage(address, ts) {
  return `Nexus AI Access\nAddress: ${address.toLowerCase()}\nTimestamp: ${ts}`;
}

// ── Request-bound (v2) auth gate — Phase 2 of #14 ────────────────────────────
// ADDITIVE + flag-gated: a no-op unless env.AUTH_V2 === "true", so enabling it is a
// deliberate migration step and merging this changes no live behavior. When on, a
// high-risk route requires a FRESH per-request challenge signature (single-use nonce
// + action + amount + domain + short expiry) on top of the existing walletSig — so a
// captured static walletSig alone can no longer move funds / arm an agent. The signed
// fields are read back from the server-minted KV record (never the client body), then
// the nonce is burned on success (replay guard). Returns a 401 json Response to short-
// circuit the route, or null to proceed. recoverEthAddress is injected into verifyV2.
async function requireOwnerV2(env, request, { action, wallet, amount, nonce, v2Sig }) {
  if (env.AUTH_V2 !== "true") return null; // disabled during migration → no-op
  const KV = env.NEXUS_AGENT || env.LAB_STORE;
  if (!nonce || !v2Sig) {
    return json({ error: "v2_auth_required",
      hint: "GET /auth/challenge?wallet=&action=&amount= then sign the returned challenge; send { nonce, v2Sig } in the body." },
      request, 401);
  }
  const recRaw = await KV.get(`auth:nonce:${nonce}`);
  if (!recRaw) return json({ error: "challenge_unknown_or_expired" }, request, 401);
  let record;
  try { record = JSON.parse(recRaw); } catch { return json({ error: "challenge_corrupt" }, request, 401); }
  const v = verifyV2({
    record, sig: v2Sig, expected: { action, amount, wallet }, now: Date.now(), recover: recoverEthAddress,
  });
  if (!v.ok) return json({ error: "v2_verify_failed", reason: v.reason }, request, 401);
  await KV.delete(`auth:nonce:${nonce}`); // single-use → burn so it can't be replayed
  return null;
}

let resvgReady = false;
let fontCache = null;

async function ensureResvg() {
  if (!resvgReady) {
    await initWasm(resvgWasm);
    resvgReady = true;
  }
}

// JetBrains Mono TTF — cached per Worker instance, fetched once on first PNG request
async function getMonoFont() {
  if (fontCache) return fontCache;
  const resp = await fetch(
    "https://github.com/JetBrains/JetBrainsMono/raw/v2.304/fonts/ttf/JetBrainsMono-Regular.ttf"
  );
  if (!resp.ok) throw new Error("font fetch failed: " + resp.status);
  fontCache = new Uint8Array(await resp.arrayBuffer());
  return fontCache;
}






// ── Agent key encryption at rest (AES-256-GCM via Web Crypto) ──────────────────
// Trading keys are encrypted before being written to KV so a KV dump alone is
// useless without the AGENT_ENC_KEY Worker secret. Format: "v1:<b64 iv>:<b64 ct>".
async function importAencKey(env) {
  const raw = Uint8Array.from(atob(env.AGENT_ENC_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(plaintext, env) {
  if (!env.AGENT_ENC_KEY) throw new Error("AGENT_ENC_KEY not configured");
  const key = await importAencKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

// base58 encode (Bitcoin alphabet) — matches the `bs58` npm pkg the exec signer
// uses (it does bs58.decode(tradingKey) → 32-byte ed25519 seed).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n = n / 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out || "1";
}

// Derive the agent's trading secret from a wallet signature, the SAME way
// /trade and bankr-register do: seed = SHA-256(sigBytes) (the 32-byte ed25519
// seed), then bs58-encode so the exec's bs58.decode + noble signer reproduce the
// exact registered key. Possessing a valid walletSig IS the auth — only the
// wallet owner can produce it (via Bankr sign_message).
async function agentSecretFromWalletSig(walletSig) {
  const sigHex = walletSig.startsWith("0x") ? walletSig.slice(2) : walletSig;
  const seedBytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(sigHex.match(/.{2}/g).map((b) => parseInt(b, 16)))
  ));
  return bs58Encode(seedBytes);
}


// ── Nexus PRO gate (server-side, source of truth) ─────────────────────────────
// PRO agent strategies (MOMENTUM, MEAN_REVERSION) require Nexus PRO. PRO resolves
// two ways: (1) an active paid subscription record (sub:{addr} — paid rail, when
// live) OR (2) holder-unlock = holding ARCHITECT-tier $NEXUS (100M) on Base. The
// UI gated these before; this makes the paywall real at the API too.
const PRO_STRATEGIES = ["MOMENTUM", "MEAN_REVERSION"];
async function walletIsPro(address, env) {
  // 1) Paid subscription (future-proof — no-ops until the payment rail writes sub:{addr}).
  try {
    const subRaw = await env.LAB_STORE.get(`sub:${address}`);
    if (subRaw) { const s = JSON.parse(subRaw); if (s.expiresAt && s.expiresAt > Date.now()) return true; }
  } catch { /* ignore */ }
  // 2) Holder-unlock: $NEXUS balanceOf(address) >= ARCHITECT tier (100M) on Base.
  const NEXUS_TOKEN = "0x3D958634ab725B627919EF8F2Ed59227309fDba3";
  const ARCHITECT_MIN = 100000000n * (10n ** 18n); // PRO_HOLDER_TIER = ARCHITECT
  const callData = "0x70a08231000000000000000000000000" + address.slice(2);
  for (const rpc of ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.llamarpc.com"]) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: NEXUS_TOKEN, data: callData }, "latest"] }),
      });
      const j = await res.json();
      if (j.result) return BigInt(j.result) >= ARCHITECT_MIN;
    } catch { /* try next rpc */ }
  }
  return false; // RPC unreachable → fail closed (paywall stays shut)
}

// ── OI-history loader for backtests ───────────────────────────────────────────
// CONFLUENCE / OI_ONLY need the brain's recorded oi:hist:{symbol} series (Orderly
// has no OI history endpoint). This reads it for the given symbols and reports
// whether coverage is deep enough to trust an OI backtest. Shared by the single
// backtest + the sweep so the maturity gate can't drift. Until mature it no-ops
// (oiMature:false) and callers stay honestly "untestable".
const OI_BACKTEST_MIN_DAYS = 14, OI_BACKTEST_MIN_SAMPLES = 200;
async function loadOiHistForBacktest(symbols, env) {
  const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
  const oiHistBySymbol = {};
  const infos = [];
  for (const s of symbols) {
    let rows = [];
    try { const raw = await AGENT_KV.get(`oi:hist:${s}`); rows = raw ? JSON.parse(raw) : []; } catch { /* absent → thin */ }
    oiHistBySymbol[s] = rows;
    infos.push({ symbol: s, ...oiSeriesInfo(rows) });
  }
  const minDays = infos.length ? Math.min(...infos.map((i) => i.days)) : 0;
  const minSamples = infos.length ? Math.min(...infos.map((i) => i.samples)) : 0;
  const oiMature = minDays >= OI_BACKTEST_MIN_DAYS && minSamples >= OI_BACKTEST_MIN_SAMPLES;
  return { oiHistBySymbol, oiMature, gate: { minDays, minSamples, perSymbol: infos } };
}

// Walk-forward validate a PUBLISHED strategy and stamp the verdict onto its record —
// the community board's trust badge. Run in the background (ctx.waitUntil) at publish
// so the toggle stays snappy. Server-computed (never client-supplied) since it's a
// trust signal. CONFLUENCE/OI_ONLY stay "pending_oi" until recorded OI matures.
const VALIDATE_UNIVERSE = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_BNB_USDC", "PERP_XRP_USDC", "PERP_LINK_USDC"];
async function revalidateStrategy(address, stratId, config, env) {
  const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
  let validation;
  try {
    const needsOi = ["CONFLUENCE", "OI_ONLY"].includes(config.signalMode);
    const oi = needsOi ? await loadOiHistForBacktest(VALIDATE_UNIVERSE, env) : null;
    if (needsOi && !oi.oiMature) {
      validation = { status: "pending_oi", note: `awaiting OI history (${oi.gate.minDays}/${OI_BACKTEST_MIN_DAYS}d)`, checkedAt: Date.now() };
    } else {
      const r = await walkForwardValidate(config, { symbols: VALIDATE_UNIVERSE, days: 60, folds: 4 }, oi?.oiMature ? oi.oiHistBySymbol : {});
      validation = { status: "done", verdict: r.verdict, posSymbols: r.posSymbols, totalSymbols: r.totalSymbols, foldConsistency: r.foldConsistency, totalNet: r.totalNet, validatedAt: Date.now() };
    }
  } catch { validation = { status: "error", checkedAt: Date.now() }; }
  // Re-read latest before patching so a concurrent save/publish isn't clobbered.
  const key = `agent:strategies:${address}`;
  const raw = await AGENT_KV.get(key);
  if (!raw) return;
  let list; try { list = JSON.parse(raw); } catch { return; }
  const s = list.find((x) => x.id === stratId);
  if (!s) return;
  s.validation = validation;
  await AGENT_KV.put(key, JSON.stringify(list));
}

// ── Ph27: notification helpers ────────────────────────────────────────────────
async function appendNotification(env, wallet, notif) {
  const key = `notif:${wallet}`;
  const raw = await env.LAB_STORE.get(key);
  const list = raw ? JSON.parse(raw) : [];
  list.unshift(notif);
  await env.LAB_STORE.put(key, JSON.stringify(list.slice(0, 50)));
}

// ── Ph16: SVG OG image helpers ────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function calcRepScore(wins, losses, avgRR) {
  const closed = wins + losses;
  const winRate = closed > 0 ? (wins / closed) * 100 : 0;
  const rrBonus = Math.min(avgRR * 10, 20);
  const samplePenalty = Math.max(0, 10 - closed) * 2;
  return Math.max(0, Math.min(100, Math.round(winRate + rrBonus - samplePenalty)));
}

function buildOgSvg({ displayName, wallet, wins, losses, active, total, avgRR, winRate, rep, fontFamily = "'Courier New', Courier, monospace" }) {
  const shortAddr = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  const name = esc(displayName || shortAddr);
  const closed = wins + losses;
  const repColor = rep >= 70 ? "#00ff88" : rep >= 40 ? "#fbbf24" : "#ff4444";
  const wrColor = winRate !== null
    ? (winRate >= 60 ? "#00ff88" : winRate >= 40 ? "#fbbf24" : "#ff4444")
    : "#3a5a4a";
  const rrColor = avgRR >= 2 ? "#00ff88" : "#fbbf24";

  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>text { font-family: ${fontFamily}; }</style>
  </defs>
  <rect width="1200" height="630" fill="#0a0e0a"/>
  <rect width="1200" height="3" fill="#00ff88" opacity="0.5"/>
  <rect y="627" width="1200" height="3" fill="#1a3a1a"/>

  <!-- Branding -->
  <text x="48" y="54" fill="#2a4a3a" font-size="13" letter-spacing="3">NEXUS TRADING LABS</text>
  <text x="1152" y="54" fill="#2a4a3a" font-size="13" letter-spacing="1" text-anchor="end">trade.nexustradinglabs.com</text>

  <!-- Trader identity -->
  <text x="48" y="170" fill="#ffffff" font-size="54" font-weight="bold">${name}</text>
  <text x="48" y="210" fill="#3a5a4a" font-size="18">${esc(shortAddr)}</text>
  <text x="48" y="240" fill="#2a4a3a" font-size="14">${total} thesis${total !== 1 ? "es" : ""} published on-chain</text>

  <!-- REP Score (right column) -->
  <text x="980" y="130" fill="#3a5a4a" font-size="13" letter-spacing="4" text-anchor="middle">REP SCORE</text>
  <text x="980" y="265" fill="${repColor}" font-size="148" font-weight="bold" text-anchor="middle">${closed > 0 ? rep : "-"}</text>

  <!-- Divider -->
  <line x1="48" y1="310" x2="1152" y2="310" stroke="#1a2e1a" stroke-width="1"/>

  <!-- Stats row -->
  <text x="60" y="358" fill="#3a5a4a" font-size="12" letter-spacing="3">WIN RATE</text>
  <text x="60" y="412" fill="${wrColor}" font-size="48" font-weight="bold">${winRate !== null ? winRate + "%" : "-"}</text>

  <text x="310" y="358" fill="#3a5a4a" font-size="12" letter-spacing="3">W / L</text>
  <text x="310" y="412" fill="#8aaa9a" font-size="48" font-weight="bold">${wins} / ${losses}</text>

  <text x="570" y="358" fill="#3a5a4a" font-size="12" letter-spacing="3">AVG R:R</text>
  <text x="570" y="412" fill="${rrColor}" font-size="48" font-weight="bold">1:${avgRR.toFixed(1)}</text>

  <text x="830" y="358" fill="#3a5a4a" font-size="12" letter-spacing="3">ACTIVE</text>
  <text x="830" y="412" fill="${active > 0 ? "#4a9fff" : "#3a5a4a"}" font-size="48" font-weight="bold">${active}</text>

  <!-- Bottom tag -->
  <line x1="48" y1="468" x2="1152" y2="468" stroke="#1a2e1a" stroke-width="1"/>
  <text x="48" y="512" fill="#2a4a3a" font-size="13" letter-spacing="1">on-chain verified · arbitrum</text>
  <text x="1152" y="512" fill="#1a3a1a" font-size="13" text-anchor="end">${esc(wallet)}</text>
</svg>`;
}

// ── Ph22: Thesis OG SVG ───────────────────────────────────────────────────────
// This card is the most public brand surface we have — it's what unfurls when a call is
// shared to X. It was still on the RETIRED palette (#0a0e0a green-tinted black, #00ff88
// terminal green, #4a9fff blue, green-tinted greys). Now monochrome, matching the app:
// bone/greys for structure, and chroma ONLY where it carries meaning (green=profit/up,
// red=loss/down, amber=caution).
//
// `chartDataUri` is optional and already SSRF-gated + size-capped by fetchChartDataUri().
// With a chart we run a two-column layout; without one we keep the full-width layout so
// the card never has a dead half.
function buildThesisOgSvg({ displayName, wallet, ticker, direction, entryPrice, stopLoss, takeProfit1, riskReward, status, notes, chartDataUri = null, fontFamily = "'Courier New', Courier, monospace" }) {
  const shortAddr = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  const name = esc(displayName || shortAddr);
  const dirColor = direction === "LONG" ? "#3ecf8e" : "#f7525f";
  const dirArrow = direction === "LONG" ? "↑" : "↓";
  const rrColor = parseFloat(riskReward) >= 2 ? "#3ecf8e" : "#ededf0";
  const statusMap = { HIT_TP: "HIT TP ✓", STOPPED_OUT: "STOPPED OUT", ACTIVE: "ACTIVE", INVALIDATED: "INVALIDATED" };
  const statusColorMap = { HIT_TP: "#3ecf8e", STOPPED_OUT: "#f7525f", ACTIVE: "#d4d4d8", INVALIDATED: "#fbbf24" };
  const statusLabel = statusMap[status] || status;
  const statusColor = statusColorMap[status] || "#a1a1aa";
  const notesLine = notes ? esc(String(notes).slice(0, chartDataUri ? 46 : 90)) : "";

  // Level block — positions differ between the one- and two-column layouts.
  const lvl = (x, y, label, value, color) => `
  <text x="${x}" y="${y}" fill="#52525b" font-size="12" letter-spacing="3">${label}</text>
  <text x="${x}" y="${y + 62}" fill="${color}" font-size="${chartDataUri ? 40 : 52}" font-weight="bold">${value}</text>`;

  const money = (v) => `$${parseFloat(v).toFixed(2)}`;

  const levels = chartDataUri
    // two-column: 2x2 on the left, chart panel on the right
    ? lvl(60, 312, "ENTRY", money(entryPrice), "#f4f4f5")
      + lvl(300, 312, "STOP", money(stopLoss), "#f7525f")
      + lvl(60, 430, "TP1", money(takeProfit1), "#3ecf8e")
      + lvl(300, 430, "R:R", `1:${parseFloat(riskReward).toFixed(2)}`, rrColor)
    // full-width: single row of four
    : lvl(60, 312, "ENTRY", money(entryPrice), "#f4f4f5")
      + lvl(360, 312, "STOP", money(stopLoss), "#f7525f")
      + lvl(660, 312, "TP1", money(takeProfit1), "#3ecf8e")
      + lvl(960, 312, "R:R", `1:${parseFloat(riskReward).toFixed(2)}`, rrColor);

  const chartPanel = chartDataUri ? `
  <rect x="596" y="286" width="556" height="330" fill="#0f0f11" stroke="#232327" stroke-width="1" rx="4"/>
  <image x="604" y="294" width="540" height="314" href="${chartDataUri}" preserveAspectRatio="xMidYMid meet"/>` : "";

  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs><style>text { font-family: ${fontFamily}; }</style></defs>
  <rect width="1200" height="630" fill="#0a0a0b"/>
  <rect width="1200" height="3" fill="#ededf0" opacity="0.5"/>
  <rect y="627" width="1200" height="3" fill="#232327"/>
  <text x="48" y="54" fill="#71717a" font-size="13" letter-spacing="3">NEXUS TRADING LABS</text>
  <text x="1152" y="54" fill="#71717a" font-size="13" text-anchor="end">trade.nexustradinglabs.com</text>
  <text x="48" y="180" fill="#f4f4f5" font-size="86" font-weight="bold">${esc(ticker)}</text>
  <text x="48" y="232" fill="${dirColor}" font-size="32" font-weight="bold">${dirArrow} ${esc(direction)}</text>
  <text x="1152" y="180" fill="${statusColor}" font-size="22" font-weight="bold" text-anchor="end">${statusLabel}</text>
  <text x="1152" y="214" fill="#a1a1aa" font-size="14" text-anchor="end">${name}</text>
  <text x="1152" y="234" fill="#71717a" font-size="12" text-anchor="end">${esc(shortAddr)}</text>
  <line x1="48" y1="270" x2="1152" y2="270" stroke="#232327" stroke-width="1"/>
  ${levels}
  ${chartPanel}
  ${notesLine ? `<text x="48" y="${chartDataUri ? 556 : 464}" fill="#a1a1aa" font-size="16" font-style="italic">"${notesLine}"</text>` : ""}
  ${chartDataUri ? "" : `<line x1="48" y1="530" x2="1152" y2="530" stroke="#232327" stroke-width="1"/>`}
  <text x="48" y="592" fill="#71717a" font-size="13" letter-spacing="1">graded from public price · anchored on arbitrum</text>
  ${chartDataUri ? "" : `<text x="1152" y="592" fill="#52525b" font-size="13" text-anchor="end">${esc(wallet)}</text>`}
</svg>`;
}

// Fetch a thesis chart for embedding in the OG card. Every guard here matters because
// the URL originates in user data:
//   • safeChartUrl() blocks non-https, non-allowlisted hosts, and SSRF targets
//     (169.254.169.254, localhost, file://) BEFORE any network call
//   • 4s timeout so a slow host can't hang OG rendering
//   • content-type must be image/*, and we cap at 1.5MB so a huge file can't blow the
//     worker's memory during base64 + resvg rasterisation
// Fails soft in every case — the card just renders without a chart.
const CHART_MAX_BYTES = 1_500_000;
async function fetchChartDataUri(rawUrl) {
  const url = safeChartUrl(rawUrl);
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "follow" });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) return null;
    const len = parseInt(r.headers.get("content-length") || "0", 10);
    if (len && len > CHART_MAX_BYTES) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > CHART_MAX_BYTES) return null;   // covers chunked/no content-length
    const b = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return `data:${ct.split(";")[0]};base64,${btoa(s)}`;
  } catch { return null; }
}

// ── Ph17: On-chain wallet discovery ──────────────────────────────────────────
// ARB_RPC resolved at runtime — Alchemy if ALCHEMY_KEY secret set, public RPC fallback
function getArbRpc(env) {
  return env.ALCHEMY_KEY
    ? `https://arb-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`
    : "https://arb1.arbitrum.io/rpc";
}

// Live $NEXUS/USD price for the pay-in-$NEXUS subscription path. DexScreener is
// server-friendly (no key, unlike GeckoTerminal which 403s worker IPs). Returns
// the deepest Base pair's USD price, or null → caller fails closed (use USDC).
async function getNexusPriceUsd() {
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/0x3D958634ab725B627919EF8F2Ed59227309fDba3");
    const j = await r.json();
    const pairs = (j && j.pairs) || [];
    const base = pairs.filter((p) => String(p.chainId || "").toLowerCase() === "base");
    const best = base.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0] || pairs[0];
    const price = best && parseFloat(best.priceUsd);
    return price && isFinite(price) && price > 0 ? price : null;
  } catch { return null; }
}
const THESIS_REGISTRY = "0x2f4eda890f96a7979d6f26bcb210cedad68346bc";
const ONCHAIN_CACHE_KEY = "cache:onchain-wallets";
const ONCHAIN_TTL_MS = 5 * 60 * 1000; // 5 min

async function getOnChainWallets(env) {
  // Return cached if fresh
  const cached = await env.LAB_STORE.get(ONCHAIN_CACHE_KEY);
  if (cached) {
    const parsed = JSON.parse(cached);
    if (Date.now() - (parsed.updatedAt || 0) < ONCHAIN_TTL_MS) {
      return { wallets: parsed.wallets, fromCache: true };
    }
  }

  const ARB_RPC = getArbRpc(env);

  try {
    // Get latest block
    const blockResp = await fetch(ARB_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const blockData = await blockResp.json();
    const latestBlock = parseInt(blockData.result, 16);

    // Scan last ~30M blocks (~87 days at ~4 blk/s on Arbitrum)
    // The contract is new so this window covers all registrations
    const fromBlock = "0x" + Math.max(0, latestBlock - 30_000_000).toString(16);

    const logsResp = await fetch(ARB_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "eth_getLogs",
        params: [{ address: THESIS_REGISTRY, fromBlock, toBlock: "latest" }],
      }),
    });
    const logsData = await logsResp.json();
    if (logsData.error) throw new Error(logsData.error.message);

    // ThesisRegistered(uint256 indexed thesisId, address indexed trader)
    // topics[0]=event hash, topics[1]=thesisId, topics[2]=trader (padded to 32 bytes)
    const wallets = [
      ...new Set(
        (logsData.result || [])
          .filter((log) => log.topics && log.topics.length >= 3)
          .map((log) => "0x" + log.topics[2].slice(26).toLowerCase())
      ),
    ];

    // Cache with TTL
    await env.LAB_STORE.put(
      ONCHAIN_CACHE_KEY,
      JSON.stringify({ wallets, updatedAt: Date.now() }),
      { expirationTtl: 300 }
    );
    return { wallets, fromCache: false };
  } catch (err) {
    // Fall back to stale cache or empty
    const stale = await env.LAB_STORE.get(ONCHAIN_CACHE_KEY);
    return {
      wallets: stale ? JSON.parse(stale).wallets : [],
      fromCache: true,
      error: String(err),
    };
  }
}

export default {
  // Cron (wrangler.toml [triggers]) — best-effort refresh of the Smart Money
  // tracked set from the live HL leaderboard. Fails safe: on error the routes
  // fall back to the static SMART_SEED, so a heavy/failed parse never breaks the tab.
  async scheduled(event, env, ctx) {
    // Hourly ("17 * * * *"): objectively grade public theses from public price.
    // Every run also grades (cheap, idempotent) so a fresh deploy resolves immediately.
    ctx.waitUntil((async () => {
      try { const n = await gradePublicTheses(env); console.log(`[grade] cron resolved ${n} calls`); }
      catch (e) { console.error("[grade] cron failed:", String(e)); }
    })());
    // 12h: refresh the Smart Money tracked set.
    if (event.cron === "0 */12 * * *") {
      ctx.waitUntil((async () => {
        try { const n = await refreshSmartSeed(env); console.log(`[smart] refreshed tracked set: ${n}`); }
        catch (e) { console.error("[smart] refresh failed (using static seed):", String(e)); }
      })());
    }
  },

  async fetch(request, env, ctx) {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(request) });
    }

    try {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // ── GET /smart/board — graded top traders + their live positions ────────────
    // Multi-source: ORDERLY primary (public dashboard indexer — native venue, all
    // positions copyable) + HYPERLIQUID secondary (wider discovery). Unified shape
    // with a `source` tag. KV-cached 10min so browsers get a light payload.
    // Smart Money family → routes-smart.mjs (migration rules in shared.mjs).
    {
      const smartRes = await handleSmart(parts, request, env, ctx);
      if (smartRes) return smartRes;
    }
    if (parts[0] === "tg" && parts[1] === "webhook" && request.method === "POST") {
      const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
      let upd = null;
      try { upd = await request.json(); } catch { /* ignore malformed */ }
      const msg = upd?.message || upd?.edited_message;
      const chatId = msg?.chat?.id;
      const text = String(msg?.text || "").trim();
      const reply = async (t) => {
        if (!env.TELEGRAM_TOKEN || !chatId) return;
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: t, parse_mode: "HTML", disable_web_page_preview: true }),
          });
        } catch { /* fail-soft */ }
      };
      if (chatId && text.startsWith("/start")) {
        const arg = text.split(/\s+/)[1] || "";
        const addr = /^0x[a-fA-F0-9]{40}$/.test(arg) ? arg.toLowerCase() : null;
        if (addr) {
          await AGENT_KV.put(`tg:chat:${addr}`, String(chatId));
          await AGENT_KV.put(`tg:wallet:${chatId}`, addr);
          await reply(`✅ Linked to <code>${addr.slice(0, 6)}…${addr.slice(-4)}</code>. You'll get a message whenever your Nexus agent opens or closes a trade. Send /stop to unlink.`);
        } else {
          await reply("👋 To get Nexus agent trade alerts, open the Agent tab on Nexus Trading Labs and tap “Link Telegram”.");
        }
      } else if (chatId && text.startsWith("/stop")) {
        const stopArg = text.split(/\s+/)[1] || "";
        const stopAddr = /^0x[a-fA-F0-9]{40}$/.test(stopArg) ? stopArg.toLowerCase() : null;
        if (stopAddr) {
          // Unlink the SPECIFIED wallet — but only if it's actually linked to THIS chat.
          const linkedChat = await AGENT_KV.get(`tg:chat:${stopAddr}`);
          if (String(linkedChat) === String(chatId)) {
            await AGENT_KV.delete(`tg:chat:${stopAddr}`);
            const cur = await AGENT_KV.get(`tg:wallet:${chatId}`);
            if (cur === stopAddr) await AGENT_KV.delete(`tg:wallet:${chatId}`);
            await reply(`🔕 Unlinked <code>${stopAddr.slice(0, 6)}…${stopAddr.slice(-4)}</code>. Send /start to re-enable.`);
          } else {
            await reply("That wallet isn't linked to this chat.");
          }
        } else {
          // No arg → unlink the most-recently linked wallet for this chat.
          const addr = await AGENT_KV.get(`tg:wallet:${chatId}`);
          if (addr) await AGENT_KV.delete(`tg:chat:${addr}`);
          await AGENT_KV.delete(`tg:wallet:${chatId}`);
          await reply("🔕 Unlinked. Send /start (or /start &lt;wallet&gt;) to re-enable agent trade alerts.");
        }
      }
      return new Response("ok"); // Telegram only needs a 200
    }

    // ── Ph16/21: /og/trader/:wallet(.png)? → OG image ─────
    // SVG endpoint: Discord, Telegram, iMessage, most crawlers
    // PNG endpoint (.png suffix): Twitter/X (requires raster image)
    if (parts[0] === "og" && parts[1] === "trader" && parts[2]) {
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

      const isPng = parts[2].endsWith(".png");
      const walletRaw = isPng ? parts[2].slice(0, -4) : parts[2];
      const wallet = normalizeAddress(walletRaw);

      const [raw, profileRaw] = await Promise.all([
        env.LAB_STORE.get(`lab:${wallet}`),
        env.LAB_STORE.get(`profile:${wallet}`),
      ]);
      const data = raw ? JSON.parse(raw) : { theses: [] };
      const profile = profileRaw ? JSON.parse(profileRaw) : {};
      const theses = data.theses || [];

      const wins = theses.filter((t) => t.status === "HIT_TP").length;
      const losses = theses.filter((t) => t.status === "STOPPED_OUT").length;
      const active = theses.filter((t) => t.status === "ACTIVE").length;
      const closed = wins + losses;
      const winRate = closed > 0 ? Math.round((wins / closed) * 100) : null;
      const avgRR =
        theses.length > 0
          ? theses.reduce((s, t) => s + (t.riskReward || 0), 0) / theses.length
          : 0;
      const rep = calcRepScore(wins, losses, avgRR);

      const statsPayload = {
        displayName: profile.displayName || null,
        wallet,
        wins,
        losses,
        active,
        total: theses.length,
        avgRR,
        winRate,
        rep,
      };

      // Ph21: PNG for Twitter
      if (isPng) {
        try {
          await ensureResvg();
          const font = await getMonoFont();
          // Use JetBrains Mono family name since we're loading that font
          const svg = buildOgSvg({ ...statsPayload, fontFamily: "'JetBrains Mono'" });
          const resvg = new Resvg(svg, {
            font: { loadSystemFonts: false, fontBuffers: [font], defaultFontFamily: "JetBrains Mono" },
          });
          const png = resvg.render().asPng();
          return new Response(png, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (e) {
          // Graceful fallback to SVG if PNG generation fails
          console.error("[OG PNG] failed, falling back to SVG:", String(e));
        }
      }

      // Default / fallback: SVG
      const svg = buildOgSvg(statsPayload);
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── Ph17: /wallets/onchain → on-chain trader discovery ─
    if (parts[0] === "wallets" && parts[1] === "onchain") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
      const result = await getOnChainWallets(env);
      return json(result, request);
    }

    // ── /account-snapshot — read positions+orders using stored seed (no walletSig) ─
    if (parts[0] === "account-snapshot" && request.method === "GET") {
      const asWallet = url.searchParams.get("wallet");
      if (!asWallet) return json({ error: "wallet required" }, request, 400);
      const asNorm = asWallet.toLowerCase().trim();
      const asRaw = await env.LAB_STORE.get("user:" + asNorm);
      if (!asRaw) return json({ error: "wallet_not_registered", hint: "Use the Nexus Bankr skill to register." }, request, 404);
      const asRec = JSON.parse(asRaw);
      if (!asRec.seed) return json({ error: "session_not_cached", hint: "Run any Nexus command via the Bankr agent (e.g. check balance) to activate." }, request, 403);
      const AS_HDR = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      const asSeedBytes = new Uint8Array(asRec.seed.match(/.{2}/g).map(b => parseInt(b,16)));
      const asPk8 = new Uint8Array(48); asPk8.set(AS_HDR,0); asPk8.set(asSeedBytes,16);
      const asSk = await crypto.subtle.importKey("pkcs8", asPk8, { name:"Ed25519" }, false, ["sign"]);
      const asSign = async (method, path) => {
        const ts = Date.now();
        const msg = new TextEncoder().encode(ts + method + path);
        const s = new Uint8Array(await crypto.subtle.sign("Ed25519", asSk, msg));
        const b64 = btoa(String.fromCharCode(...s)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
        return { "orderly-timestamp": String(ts), "orderly-account-id": asRec.accountId, "orderly-key": asRec.orderlyKey, "orderly-signature": b64 };
      };
      const [posFetch, ordFetch] = await Promise.all([
        fetch("https://api-evm.orderly.org/v1/positions", { headers: await asSign("GET", "/v1/positions") }),
        fetch("https://api-evm.orderly.org/v1/orders?size=100&page=1", { headers: await asSign("GET", "/v1/orders?size=100&page=1") }),
      ]);
      const [posJson, ordJson] = await Promise.all([posFetch.json(), ordFetch.json()]);
      const positions = (posJson?.data?.rows ?? []).map(p => ({
        symbol: p.symbol, side: p.position_qty > 0 ? "LONG" : "SHORT",
        size: Math.abs(p.position_qty), entryPrice: p.average_open_price,
        markPrice: p.mark_price, unrealizedPnl: p.unrealized_pnl,
        liquidationPrice: p.est_liq_price, leverage: p.leverage,
        fundingRate: p.last_funding_rate,
      }));
      const orders = (ordJson?.data?.rows ?? []).map(o => ({
        orderId: o.order_id, symbol: o.symbol, side: o.side, type: o.type,
        status: o.status, price: o.price, quantity: o.quantity,
        executedQty: o.executed, avgPrice: o.average_executed_price,
        fee: o.total_fee, feeCurrency: o.fee_asset, realizedPnl: o.realized_pnl,
        createdAt: o.created_time, updatedAt: o.updated_time,
      }));
      return json({ positions, orders, wallet: asNorm }, request);
    }

    // ── Ph22: /og/thesis/:wallet/:id(.png)? → thesis OG image ─
    if (parts[0] === "og" && parts[1] === "thesis" && parts[2] && parts[3]) {
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      const isPng = parts[3].endsWith(".png");
      const thesisId = isPng ? parts[3].slice(0, -4) : parts[3];
      const wallet = normalizeAddress(parts[2]);
      const [raw, profileRaw] = await Promise.all([
        env.LAB_STORE.get(`lab:${wallet}`),
        env.LAB_STORE.get(`profile:${wallet}`),
      ]);
      if (!raw) return new Response("not found", { status: 404 });
      const data = JSON.parse(raw);
      const thesis = (data.theses || []).find((t) => t.id === thesisId);
      if (!thesis) return new Response("not found", { status: 404 });
      const profile = profileRaw ? JSON.parse(profileRaw) : {};
      const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
      // Card shows the OBJECTIVE grade, never the self-report — grade live if unresolved.
      let ogStatus = thesis.gradedOutcome ? gradedStatusOf(thesis.gradedOutcome) : "ACTIVE";
      if (ogStatus === "ACTIVE" && thesis.gradedOutcome !== "WIN" && thesis.gradedOutcome !== "LOSS") {
        try {
          const g = gradeCall(thesis, await fetchGradeHistory(thesis.symbol, thesis.createdAt));
          if (g.outcome === "WIN" || g.outcome === "LOSS") ogStatus = gradedStatusOf(g.outcome);
        } catch { /* keep ACTIVE */ }
      }
      const payload = {
        displayName: profile.displayName || null, wallet, ticker,
        direction: thesis.direction, entryPrice: thesis.entryPrice,
        stopLoss: thesis.stopLoss, takeProfit1: thesis.takeProfit1,
        riskReward: thesis.riskReward, status: ogStatus, notes: thesis.notes || "",
      };
      // Chart is fetched ONLY for the PNG path — the SVG path would need the same
      // inlining anyway (resvg can't pull remote refs), and X/Twitter unfurls the PNG.
      if (isPng) {
        try {
          await ensureResvg();
          const font = await getMonoFont();
          // Only the FIRST chart goes on the share card — an unfurl needs one legible
          // image, not four thumbnails. Also keeps the fetch/size budget bounded.
          const firstChart = (thesis.chartUrls && thesis.chartUrls[0]) || thesis.chartUrl;
          const chartDataUri = await fetchChartDataUri(firstChart);
          const svg = buildThesisOgSvg({ ...payload, chartDataUri, fontFamily: "'JetBrains Mono'" });
          const resvg = new Resvg(svg, { font: { loadSystemFonts: false, fontBuffers: [font], defaultFontFamily: "JetBrains Mono" } });
          const png = resvg.render().asPng();
          return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
        } catch (e) { console.error("[OG PNG thesis]", String(e)); }
      }
      const svg = buildThesisOgSvg(payload);
      return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
    }

    // ── Ph22: /thesis/:wallet/:id → single thesis data ─────
    if (parts[0] === "thesis" && parts[1] && parts[2]) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
      const wallet = normalizeAddress(parts[1]);
      const thesisId = parts[2];
      const [raw, profileRaw] = await Promise.all([
        env.LAB_STORE.get(`lab:${wallet}`),
        env.LAB_STORE.get(`profile:${wallet}`),
      ]);
      if (!raw) return json({ error: "not found" }, request, 404);
      const data = JSON.parse(raw);
      const thesis = (data.theses || []).find((t) => t.id === thesisId && t.isPublic);
      if (!thesis) return json({ error: "not found" }, request, 404);
      const profile = profileRaw ? JSON.parse(profileRaw) : {};
      // Grade LIVE on read (one symbol) if the cron hasn't resolved it yet — the
      // permalink + its OG card should never lag the market by up to an hour.
      if (thesis.gradedOutcome !== "WIN" && thesis.gradedOutcome !== "LOSS") {
        try {
          const g = gradeCall(thesis, await fetchGradeHistory(thesis.symbol, thesis.createdAt));
          if (g.outcome === "WIN" || g.outcome === "LOSS") {
            thesis.gradedOutcome = g.outcome; thesis.gradedR = g.r; thesis.gradedAt = Date.now();
          }
        } catch { /* fall through with the stored value */ }
      }
      return json({ thesis: { ...thesis, wallet, pfp: profile.pfp || null, displayName: profile.displayName || null } }, request);
    }

    // ── GET /share/thesis/:w/:id — crawler-friendly OG proxy ────────────────────
    // The app is a SPA: its per-thesis OG tags are injected by JS AFTER load, but
    // X/Farcaster/Telegram crawlers DON'T run JS — they read static index.html and got
    // the generic site card. This route returns real per-thesis OG meta a crawler can
    // read, and redirects humans to the actual app page. Share links point here.
    if (parts[0] === "share" && parts[1] === "thesis" && parts[2] && parts[3]) {
      const wallet = normalizeAddress(parts[2]);
      const thesisId = parts[3];
      const appUrl = `https://trade.nexustradinglabs.com/feed/thesis/${wallet}/${thesisId}`;
      const [raw, profileRaw] = await Promise.all([
        env.LAB_STORE.get(`lab:${wallet}`),
        env.LAB_STORE.get(`profile:${wallet}`),
      ]);
      const data = raw ? JSON.parse(raw) : null;
      const thesis = data && (data.theses || []).find((t) => t.id === thesisId && t.isPublic);
      // Unknown/private → just bounce to the app; nothing to preview.
      if (!thesis) return Response.redirect(appUrl, 302);
      const profile = profileRaw ? JSON.parse(profileRaw) : {};
      const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
      const name = esc(profile.displayName || `${wallet.slice(0, 6)}…${wallet.slice(-4)}`);
      const st = thesis.gradedOutcome ? gradedStatusOf(thesis.gradedOutcome) : "ACTIVE";
      const stWord = st === "HIT_TP" ? "✓ HIT TP" : st === "STOPPED_OUT" ? "STOPPED OUT" : "ACTIVE";
      const title = `${esc(ticker)} ${esc(thesis.direction)} by ${name} · ${stWord}`;
      const desc = `Entry $${(+thesis.entryPrice).toFixed(2)} · SL $${(+thesis.stopLoss).toFixed(2)} · TP $${(+thesis.takeProfit1).toFixed(2)} · R:R 1:${(+thesis.riskReward).toFixed(2)} — graded from public price, on-chain.`;
      const img = `https://og.nexustradinglabs.com/og/thesis/${wallet}/${thesisId}.png`;
      const shareUrl = `https://og.nexustradinglabs.com/share/thesis/${wallet}/${thesisId}`;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${img}">
<meta property="og:url" content="${shareUrl}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0; url=${appUrl}">
<script>location.replace(${JSON.stringify(appUrl)})</script>
</head><body style="background:#0a0a0b;color:#a1a1aa;font-family:monospace;padding:40px">
Redirecting to the call… <a style="color:#ededf0" href="${appUrl}">view on Nexus →</a>
</body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=120", "Access-Control-Allow-Origin": "*" } });
    }

    // ── GET /theses/grade-now — ops trigger for the objective grader (no auth,
    // read-only-ish: it only stamps objective outcomes, which any observer can
    // recompute). Returns how many calls resolved this run. ──────────────────────
    if (parts[0] === "theses" && parts[1] === "grade-now" && request.method === "GET") {
      try { const n = await gradePublicTheses(env); return json({ graded: n }, request); }
      catch (e) { return json({ error: String(e) }, request, 500); }
    }

    // ── Ph24: /follows/:wallet → follow graph ──────────────
    if (parts[0] === "follows" && parts[1]) {
      const wallet = normalizeAddress(parts[1]);
      const followKey = `follows:${wallet}`;
      if (request.method === "GET") {
        const raw = await env.LAB_STORE.get(followKey);
        return json({ following: raw ? JSON.parse(raw) : [] }, request);
      }
      if (request.method === "PUT") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        if (!Array.isArray(body.following)) return json({ error: "expected { following: [] }" }, request, 400);
        const newFollowing = body.following.map((a) => normalizeAddress(a)).slice(0, 500);

        // Detect newly followed wallets to trigger notifications
        const oldRaw = await env.LAB_STORE.get(followKey);
        const oldSet = new Set(oldRaw ? JSON.parse(oldRaw) : []);
        const newlyAdded = newFollowing.filter((a) => !oldSet.has(a));

        await env.LAB_STORE.put(followKey, JSON.stringify(newFollowing));

        // Notify each newly followed wallet
        const followerShort = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
        await Promise.all(
          newlyAdded.map((followedWallet) =>
            appendNotification(env, followedWallet, {
              id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              type: "follow",
              message: `${followerShort} started following you`,
              fromWallet: wallet,
              createdAt: Date.now(),
            })
          )
        );

        return json({ ok: true }, request);
      }
      return json({ error: "method not allowed" }, request, 405);
    }

    // ── Ph25: /verify/:wallet/:id → price-verify thesis outcome ─
    if (parts[0] === "verify" && parts[1] && parts[2]) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
      const wallet = normalizeAddress(parts[1]);
      const thesisId = parts[2];
      const raw = await env.LAB_STORE.get(`lab:${wallet}`);
      if (!raw) return json({ error: "not found" }, request, 404);
      const data = JSON.parse(raw);
      const thesis = (data.theses || []).find((t) => t.id === thesisId);
      if (!thesis) return json({ error: "not found" }, request, 404);

      const COINGECKO_IDS = {
        BTC: "bitcoin", ETH: "ethereum", SOL: "solana", ARB: "arbitrum", OP: "optimism",
        AVAX: "avalanche-2", LINK: "chainlink", UNI: "uniswap", AAVE: "aave",
        MATIC: "matic-network", SUI: "sui", SEI: "sei-network", TIA: "celestia",
        INJ: "injective-protocol", WIF: "dogwifcoin", DOGE: "dogecoin", PEPE: "pepe",
        SHIB: "shiba-inu", XRP: "ripple", ADA: "cardano", DOT: "polkadot",
        LTC: "litecoin", BCH: "bitcoin-cash", ATOM: "cosmos", FTM: "fantom",
        NEAR: "near", APT: "aptos", JUP: "jupiter-exchange-solana", WLD: "worldcoin-wld",
        TON: "the-open-network", POL: "matic-network", STRK: "starknet",
      };
      const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
      const coinId = COINGECKO_IDS[ticker];
      if (!coinId) return json({ error: "unsupported asset", ticker }, request, 422);

      // CoinGecko /ohlc only accepts these discrete `days` values — snap up to the
      // smallest one that still covers the thesis lifetime (arbitrary values 400).
      const rawDays = Math.ceil((Date.now() - thesis.createdAt) / 86400000) + 1;
      const ALLOWED_DAYS = [1, 7, 14, 30, 90, 180, 365];
      const daysSince = ALLOWED_DAYS.find((d) => d >= rawDays) ?? 365;
      try {
        // Keyless requests from cloud IPs get 403 — a (free) demo key is required.
        const cgHeaders = { Accept: "application/json" };
        if (env.COINGECKO_API_KEY) cgHeaders["x-cg-demo-api-key"] = env.COINGECKO_API_KEY;
        const cgResp = await fetch(
          `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${daysSince}`,
          { headers: cgHeaders }
        );
        if (!cgResp.ok) throw new Error(`CoinGecko ${cgResp.status}`);
        const ohlc = await cgResp.json();
        const { entryPrice, stopLoss, takeProfit1, direction, createdAt } = thesis;
        const relevant = ohlc.filter(([ts]) => ts >= createdAt);
        let hitTP = false;
        let hitSL = false;
        for (const [, , high, low] of relevant) {
          if (direction === "LONG") {
            if (high >= takeProfit1) { hitTP = true; break; }
            if (low <= stopLoss) { hitSL = true; break; }
          } else {
            if (low <= takeProfit1) { hitTP = true; break; }
            if (high >= stopLoss) { hitSL = true; break; }
          }
        }
        const priceConfirms =
          (thesis.status === "HIT_TP" && hitTP) ||
          (thesis.status === "STOPPED_OUT" && hitSL) ||
          (thesis.status === "ACTIVE" && !hitTP && !hitSL);
        return json({
          verified: priceConfirms, hitTP, hitSL,
          status: thesis.status, direction, entryPrice, stopLoss, takeProfit1,
          method: "coingecko_ohlc", candlesChecked: relevant.length,
        }, request);
      } catch (e) {
        return json({ error: "price fetch failed", detail: String(e) }, request, 502);
      }
    }

    // ── Nexus PRO — subscription payment rail (USDC on Arbitrum) ──
    // A sub payment = an ERC-20 transfer to the treasury receiver. We verify ONE
    // tx receipt (no indexer): success + correct token + to===receiver + amount≥price
    // + txHash not already redeemed → grant PRO to the tx's `from` (spoof-proof).
    {
      const SUB_RECEIVER = "0x06cd9c281e6ab09906b46a10e059f2770efde49a";
      const USDC_ARBITRUM = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
      const NEXUS_BASE = "0x3d958634ab725b627919ef8f2ed59227309fdba3";
      const NEXUS_DISCOUNT_USD = 15;  // $20 - 25% = $15 when paying in $NEXUS
      const NEXUS_TOLERANCE = 0.12;   // accept ≥88% of target (low-liq token slippage)
      const SUB_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

      // GET /sub/:address → { expiresAt, active }  (read by useSubscription)
      if (parts[0] === "sub" && parts[1] && parts[1] !== "verify" && request.method === "GET") {
        try {
          const raw = await env.LAB_STORE.get(`sub:${parts[1].toLowerCase()}`);
          const s = raw ? JSON.parse(raw) : null;
          const expiresAt = s?.expiresAt || 0;
          return json({ expiresAt, active: expiresAt > Date.now() }, request);
        } catch { return json({ expiresAt: 0, active: false }, request); }
      }

      // POST /sub/verify { txHash, chain } → verify payment + grant 30 days.
      // arbitrum = USDC ($20, fixed). base = $NEXUS ($15 worth, live-priced).
      if (parts[0] === "sub" && parts[1] === "verify" && request.method === "POST") {
        try {
          const body = await request.json().catch(() => ({}));
          const txHash = String(body?.txHash || "").trim().toLowerCase();
          const chain = String(body?.chain || "arbitrum").toLowerCase();
          if (!/^0x[0-9a-f]{64}$/.test(txHash)) return json({ error: "invalid txHash" }, request, 400);

          // Resolve chain → token + min amount + RPC endpoints.
          let token, minUnits, rpcs;
          if (chain === "arbitrum") {
            token = USDC_ARBITRUM;
            minUnits = 198n * 100000n; // 19.8 USDC (6 dec) — 1% under $20
            rpcs = [getArbRpc(env)];
          } else if (chain === "base") {
            token = NEXUS_BASE;
            const price = await getNexusPriceUsd();
            minUnits = nexusMinUnits(price, NEXUS_DISCOUNT_USD, NEXUS_TOLERANCE);
            if (!minUnits) return json({ error: "could not price $NEXUS right now — please pay with USDC on Arbitrum" }, request, 503);
            rpcs = ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.llamarpc.com"];
          } else {
            return json({ error: "unsupported chain" }, request, 400);
          }

          // Replay guard — a tx can only ever buy one period.
          if (await env.LAB_STORE.get(`sub:redeemed:${txHash}`)) return json({ error: "this transaction was already redeemed" }, request, 409);

          // Fetch the receipt (try RPCs in order for reliability).
          let receipt = null;
          for (const rpc of rpcs) {
            try {
              const res = await fetch(rpc, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
              });
              const j = await res.json();
              if (j && j.result) { receipt = j.result; break; }
            } catch { /* try next rpc */ }
          }
          if (!receipt) return json({ error: "tx not found or still pending — wait for confirmation, then retry" }, request, 404);

          const v = verifyErc20Payment(receipt, { token, receiver: SUB_RECEIVER, minAmount: minUnits });
          if (!v.ok) {
            const hint = chain === "base"
              ? `Send $NEXUS worth ≥ $${NEXUS_DISCOUNT_USD} on Base to ${SUB_RECEIVER}`
              : `Send ≥ 20 USDC on Arbitrum to ${SUB_RECEIVER}`;
            return json({ error: v.reason || "verification failed", hint }, request, 400);
          }

          const now = Date.now();
          const existingRaw = await env.LAB_STORE.get(`sub:${v.from}`);
          const existing = existingRaw ? JSON.parse(existingRaw) : null;
          const base = existing?.expiresAt && existing.expiresAt > now ? existing.expiresAt : now;
          const expiresAt = base + SUB_PERIOD_MS;
          await env.LAB_STORE.put(`sub:${v.from}`, JSON.stringify({ expiresAt, lastTx: txHash, chain, token, amount: v.amount, updatedAt: now }));
          await env.LAB_STORE.put(`sub:redeemed:${txHash}`, v.from);
          return json({ ok: true, address: v.from, expiresAt, active: true }, request);
        } catch (e) {
          return json({ error: "verify failed", detail: String((e && e.message) || e) }, request, 500);
        }
      }
    }

    // ── Hosted NEXUS AI inference (PRO-gated proxy) ──────────────
    // PRO subscribers use NEXUS AI with no API key of their own — we inject ours
    // server-side. Auth = wallet-signed challenge (proves PRO wallet ownership, so
    // nobody freeloads on our LLM bill); per-wallet daily call cap controls spend.
    // The client keeps orchestrating its tool loop — this is a thin authed forwarder.
    if (parts[0] === "ai" && parts[1] === "chat" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        if (!body) return json({ error: "bad request" }, request, 400);

        // Auth (in body to avoid CORS preflight on custom headers).
        const addr = String(body._addr || "").toLowerCase();
        const ts = Number(body._ts || 0);
        const sig = String(body._sig || "");
        if (!/^0x[a-f0-9]{40}$/.test(addr) || !ts || !sig) return json({ error: "auth required" }, request, 401);
        if (Math.abs(Date.now() - ts) > 30 * 60 * 1000) return json({ error: "auth expired — re-sign" }, request, 401);
        if (recoverEthAddress(aiAccessMessage(addr, ts), sig) !== addr) return json({ error: "bad signature" }, request, 401);
        if (!(await walletIsPro(addr, env))) return json({ error: "pro_required", hint: "Hosted NEXUS AI is a Nexus PRO benefit — subscribe or hold ARCHITECT $NEXUS." }, request, 402);

        // Per-MODEL daily spend cap. The PRO user picks a model (Haiku/Sonnet/Opus);
        // each tier has its OWN cap so our spend scales with model cost — stronger
        // model = lower cap, cheaper model = higher cap. resolveHostedModel whitelists
        // the requested id (an unknown/injected model falls back to the default
        // Sonnet tier) and returns its cap; see logic.mjs. The counter is keyed PER
        // MODEL so the tiers don't share a budget. BYOK remains the unlimited valve.
        const { model: hostedModel, cap: CAP } = resolveHostedModel(body.model, env);

        // Pick upstream: direct Anthropic (default) or the Bankr LLM Gateway when
        // AI_GATEWAY=bankr + BANKR_LLM_KEY are set. 503 only if neither is configured.
        const upstreamCfg = resolveAiUpstream(hostedModel, env);
        if (!upstreamCfg) return json({ error: "hosted inference not configured", hint: "set ANTHROPIC_API_KEY (or AI_GATEWAY=bankr + BANKR_LLM_KEY) on nexus-lab-api" }, request, 503);

        const usageKey = `ai:usage:${addr}:${hostedModel}:${new Date().toISOString().slice(0, 10)}`;
        const used = parseInt((await env.LAB_STORE.get(usageKey)) || "0", 10);
        if (used >= CAP) return json({ error: "daily_limit", model: hostedModel, cap: CAP, hint: `Hosted ${hostedModel} cap is ${CAP}/day (resets 00:00 UTC). Switch to a lighter model in ⚙ for a higher cap, or use your own API key.` }, request, 429);
        await env.LAB_STORE.put(usageKey, String(used + 1), { expirationTtl: 60 * 60 * 48 });

        // Forward to Anthropic — use the resolved (whitelisted) model + clamp tokens.
        const upstreamBody = { ...body };
        delete upstreamBody._addr; delete upstreamBody._ts; delete upstreamBody._sig;
        upstreamBody.model = upstreamCfg.model; // provider-correct id (gateway uses dot-notation)
        upstreamBody.max_tokens = Math.min(Number(upstreamBody.max_tokens) || 1024, 1024);

        // Prompt caching — the system prompt + 12 tool schemas are identical every
        // call, so cache that stable prefix → repeat calls bill at ~0.1x instead of
        // 1x (the dominant input cost). Breakpoints: the last tool (caches the tool
        // defs) + the system block (render order tools→system→messages, so a system
        // breakpoint caches tools+system together). 5-min TTL covers a tool loop.
        if (Array.isArray(upstreamBody.tools) && upstreamBody.tools.length) {
          const lastTool = upstreamBody.tools[upstreamBody.tools.length - 1];
          if (lastTool && typeof lastTool === "object") lastTool.cache_control = { type: "ephemeral" };
        }
        if (typeof upstreamBody.system === "string" && upstreamBody.system.length) {
          upstreamBody.system = [{ type: "text", text: upstreamBody.system, cache_control: { type: "ephemeral" } }];
        } else if (Array.isArray(upstreamBody.system) && upstreamBody.system.length) {
          const lastSys = upstreamBody.system[upstreamBody.system.length - 1];
          if (lastSys && typeof lastSys === "object") lastSys.cache_control = { type: "ephemeral" };
        }

        const upstream = await fetch(upstreamCfg.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": upstreamCfg.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify(upstreamBody),
        });

        if (upstreamBody.stream) {
          return new Response(upstream.body, {
            status: upstream.status,
            headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...cors(request) },
          });
        }
        return json(await upstream.json(), request, upstream.status);
      } catch (e) {
        return json({ error: "inference error", detail: String((e && e.message) || e) }, request, 500);
      }
    }

    // ── Ph29: /comments/:thesisId ─────────────────────────
    if (parts[0] === "comments" && parts[1]) {
      const thesisId = parts[1];
      const commentKey = `comments:${thesisId}`;

      if (request.method === "GET" && parts.length === 2) {
        const raw = await env.LAB_STORE.get(commentKey);
        return json(raw ? JSON.parse(raw) : [], request);
      }

      if (request.method === "POST" && parts.length === 2) {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        const wallet = typeof body.wallet === "string" ? body.wallet.toLowerCase().trim() : null;
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 280) : null;
        if (!wallet || !text) return json({ error: "missing wallet or text" }, request, 400);
        const raw = await env.LAB_STORE.get(commentKey);
        const list = raw ? JSON.parse(raw) : [];
        list.unshift({
          id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          wallet,
          text,
          createdAt: Date.now(),
        });
        await env.LAB_STORE.put(commentKey, JSON.stringify(list.slice(0, 50)));
        return json({ ok: true }, request);
      }

      if (request.method === "DELETE" && parts.length === 3) {
        const commentId = parts[2];
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        const wallet = typeof body.wallet === "string" ? body.wallet.toLowerCase().trim() : null;
        if (!wallet) return json({ error: "missing wallet" }, request, 400);
        const raw = await env.LAB_STORE.get(commentKey);
        if (!raw) return json({ ok: true }, request);
        const list = JSON.parse(raw);
        const target = list.find((c) => c.id === commentId);
        if (!target) return json({ error: "not found" }, request, 404);
        if (target.wallet !== wallet) return json({ error: "forbidden" }, request, 403);
        await env.LAB_STORE.put(commentKey, JSON.stringify(list.filter((c) => c.id !== commentId)));
        return json({ ok: true }, request);
      }

      return json({ error: "method not allowed" }, request, 405);
    }

    // ── Ph29: /reactions/:thesisId ────────────────────────
    if (parts[0] === "reactions" && parts[1]) {
      const thesisId = parts[1];
      const reactionKey = `reactions:${thesisId}`;
      const ALLOWED_EMOJIS = ["🔥", "💎", "📉", "✅", "❌"];

      if (request.method === "GET" && parts.length === 2) {
        const raw = await env.LAB_STORE.get(reactionKey);
        return json(raw ? JSON.parse(raw) : {}, request);
      }

      if (request.method === "PUT" && parts.length === 3) {
        const emoji = decodeURIComponent(parts[2]);
        if (!ALLOWED_EMOJIS.includes(emoji)) return json({ error: "emoji not allowed" }, request, 400);
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        const wallet = typeof body.wallet === "string" ? body.wallet.toLowerCase().trim() : null;
        if (!wallet) return json({ error: "missing wallet" }, request, 400);
        const raw = await env.LAB_STORE.get(reactionKey);
        const reactions = raw ? JSON.parse(raw) : {};
        const reactors = reactions[emoji] ?? [];
        const idx = reactors.indexOf(wallet);
        if (idx >= 0) reactors.splice(idx, 1);
        else reactors.push(wallet);
        reactions[emoji] = reactors;
        await env.LAB_STORE.put(reactionKey, JSON.stringify(reactions));
        return json({ ok: true }, request);
      }

      return json({ error: "method not allowed" }, request, 405);
    }

    // ── Ph27: /notifications/:wallet ──────────────────────
    if (parts[0] === "notifications" && parts[1]) {
      const wallet = normalizeAddress(parts[1]);
      const notifKey = `notif:${wallet}`;

      // GET /notifications/:wallet
      if (request.method === "GET" && parts.length === 2) {
        const raw = await env.LAB_STORE.get(notifKey);
        return json(raw ? JSON.parse(raw) : [], request);
      }

      // POST /notifications/:wallet — append (internal)
      if (request.method === "POST" && parts.length === 2) {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        if (!body.type || !body.message) return json({ error: "missing type or message" }, request, 400);
        await appendNotification(env, wallet, {
          id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: body.type,
          message: String(body.message).slice(0, 200),
          fromWallet: body.fromWallet || undefined,
          thesisId: body.thesisId || undefined,
          createdAt: Date.now(),
        });
        return json({ ok: true }, request);
      }

      // PUT /notifications/:wallet/read — mark all read
      if (request.method === "PUT" && parts.length === 3 && parts[2] === "read") {
        const raw = await env.LAB_STORE.get(notifKey);
        if (!raw) return json({ ok: true }, request);
        const now = Date.now();
        const list = JSON.parse(raw).map((n) => n.readAt ? n : { ...n, readAt: now });
        await env.LAB_STORE.put(notifKey, JSON.stringify(list));
        return json({ ok: true }, request);
      }

      // DELETE /notifications/:wallet/:id
      if (request.method === "DELETE" && parts.length === 3) {
        const id = parts[2];
        const raw = await env.LAB_STORE.get(notifKey);
        if (!raw) return json({ ok: true }, request);
        const list = JSON.parse(raw).filter((n) => n.id !== id);
        await env.LAB_STORE.put(notifKey, JSON.stringify(list));
        return json({ ok: true }, request);
      }

      return json({ error: "method not allowed" }, request, 405);
    }

    // ── Ph29: /comments/:thesisId ────────────────────────────────────────────
    if (parts[0] === "comments" && parts[1]) {
      const thesisId = parts[1];
      const commentsKey = `comments:${thesisId}`;

      if (request.method === "GET" && parts.length === 2) {
        const raw = await env.LAB_STORE.get(commentsKey);
        return json(raw ? JSON.parse(raw) : [], request);
      }

      if (request.method === "POST" && parts.length === 2) {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        if (typeof body.wallet !== "string" || !body.wallet) return json({ error: "missing wallet" }, request, 400);
        if (typeof body.text !== "string" || !body.text.trim()) return json({ error: "text required" }, request, 400);
        const text = body.text.trim().slice(0, 280);
        const raw = await env.LAB_STORE.get(commentsKey);
        const list = raw ? JSON.parse(raw) : [];
        const newComment = {
          id: crypto.randomUUID(),
          wallet: normalizeAddress(body.wallet),
          text,
          createdAt: Date.now(),
        };
        await env.LAB_STORE.put(commentsKey, JSON.stringify([newComment, ...list].slice(0, 50)));
        return json(newComment, request, 201);
      }

      if (request.method === "DELETE" && parts.length === 3) {
        const commentId = parts[2];
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        if (typeof body.wallet !== "string" || !body.wallet) return json({ error: "missing wallet" }, request, 400);
        const walletNorm = normalizeAddress(body.wallet);
        const raw = await env.LAB_STORE.get(commentsKey);
        if (!raw) return json({ error: "not found" }, request, 404);
        const list = JSON.parse(raw);
        const comment = list.find((c) => c.id === commentId);
        if (!comment) return json({ error: "not found" }, request, 404);
        if (comment.wallet !== walletNorm) return json({ error: "forbidden" }, request, 403);
        await env.LAB_STORE.put(commentsKey, JSON.stringify(list.filter((c) => c.id !== commentId)));
        return json({ ok: true }, request);
      }

      return json({ error: "method not allowed" }, request, 405);
    }

    // ── Ph29: /reactions/:thesisId ────────────────────────────────────────────
    if (parts[0] === "reactions" && parts[1]) {
      const thesisId = parts[1];
      const reactionsKey = `reactions:${thesisId}`;
      const ALLOWED_EMOJIS = new Set(["🔥", "💎", "📉", "✅", "❌"]);

      if (request.method === "GET" && parts.length === 2) {
        const raw = await env.LAB_STORE.get(reactionsKey);
        return json(raw ? JSON.parse(raw) : {}, request);
      }

      if (request.method === "PUT" && parts.length === 3) {
        const emoji = decodeURIComponent(parts[2]);
        if (!ALLOWED_EMOJIS.has(emoji)) return json({ error: "emoji not allowed" }, request, 400);
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        if (typeof body.wallet !== "string" || !body.wallet) return json({ error: "missing wallet" }, request, 400);
        const wallet = normalizeAddress(body.wallet);
        const raw = await env.LAB_STORE.get(reactionsKey);
        const reactions = raw ? JSON.parse(raw) : {};
        const wallets = reactions[emoji] || [];
        const idx = wallets.indexOf(wallet);
        if (idx === -1) {
          reactions[emoji] = [...wallets, wallet];
        } else {
          reactions[emoji] = wallets.filter((w) => w !== wallet);
          if (reactions[emoji].length === 0) delete reactions[emoji];
        }
        await env.LAB_STORE.put(reactionsKey, JSON.stringify(reactions));
        return json(reactions, request);
      }

      return json({ error: "method not allowed" }, request, 405);
    }

    // ── /trade — execute perp order via Orderly REST API ─────────────────────
    // Multi-user: body includes walletSig + walletAddress; single-user: env secrets
    if (parts[0] === "trade" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }

      console.log("[trade] body:", JSON.stringify({ symbol: body.symbol, side: body.side, notional: body.notional, leverage: body.leverage, hasWalletSig: !!body.walletSig, walletAddress: body.walletAddress || null }));
      if (!body.symbol || !body.side || !body.notional) {
        return json({ error: "symbol, side, and notional (USDC) required" }, request, 400);
      }
      // Normalize symbol: "BTC" → "PERP_BTC_USDC", "ETH-PERP" → "PERP_ETH_USDC", "PERP_SOL_USDC" → unchanged
      const normalizeSymbol = (s) => {
        s = s.toUpperCase().trim();
        if (s.startsWith("PERP_")) return s;
        s = s.replace(/[-_]?(PERP|USDC|USD|USDT)$/i, "").replace(/[^A-Z0-9]/g, "");
        return "PERP_" + s + "_USDC";
      };
      const symbol    = normalizeSymbol(body.symbol);
      const { side, notional, leverage = 1, orderType = "MARKET", walletSig, walletAddress, stopLoss, takeProfit, reduceOnly = false, closePosition = false } = body;
      const isReduceOnly = reduceOnly || closePosition;

      const ORDERLY_BASE = "https://api-evm.orderly.org";
      const PKCS8_HDR = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      let accountId, orderlyApiKey, signingKey;

      // Resolve accountId, orderlyApiKey, signingKey
      // Priority: per-user KV record > env secrets (platform account fallback)
      const useEnvSecrets = async () => {
        if (!env.ORDERLY_API_SECRET || !env.ORDERLY_API_KEY || !env.ORDERLY_ACCOUNT_ID) {
          return json({ error: "Orderly credentials not configured" }, request, 500);
        }
        accountId     = env.ORDERLY_ACCOUNT_ID;
        orderlyApiKey = env.ORDERLY_API_KEY;
        let pb = Uint8Array.from(atob(env.ORDERLY_API_SECRET), c => c.charCodeAt(0));
        if (pb.length === 32) {
          const full = new Uint8Array(48); full.set(PKCS8_HDR, 0); full.set(pb, 16); pb = full;
        }
        signingKey = await crypto.subtle.importKey("pkcs8", pb, { name: "Ed25519" }, false, ["sign"]);
      };

      if (walletSig && walletAddress) {
        // Phase 3 (#14): request-bound v2 on user-wallet trades. Binds the single-use
        // challenge to action+wallet+notional, so a leaked static walletSig can't place
        // an order (or a different-sized one). No-op unless AUTH_V2 is on. Reduce-only
        // exits (closePosition) skip the gate — they only ever shrink risk.
        if (!isReduceOnly) {
          const deniedV2 = await requireOwnerV2(env, request, {
            action: "trade", wallet: walletAddress.toLowerCase().trim(), amount: String(notional),
            nonce: body.nonce, v2Sig: body.v2Sig,
          });
          if (deniedV2) return deniedV2;
        }
        // Check KV for a registered per-user Orderly key
        const walletNorm = walletAddress.toLowerCase().trim();
        const userRaw    = await env.LAB_STORE.get("user:" + walletNorm);
        if (userRaw) {
          // Registered user: derive their private key from walletSig, use stored accountId/orderlyKey
          const rec  = JSON.parse(userRaw);
          accountId     = rec.accountId;
          orderlyApiKey = rec.orderlyKey;
          const hex  = walletSig.startsWith("0x") ? walletSig.slice(2) : walletSig;
          const seed = new Uint8Array(await crypto.subtle.digest("SHA-256",
            new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)))));
          const pk8  = new Uint8Array(48); pk8.set(PKCS8_HDR, 0); pk8.set(seed, 16);
          signingKey = await crypto.subtle.importKey("pkcs8", pk8, { name: "Ed25519" }, false, ["sign"]);
        } else {
          // Wallet provided but not registered — return specific error so skill can trigger registration
          return json({
            error: "wallet_not_registered",
            walletAddress: walletNorm,
            message: "Wallet not linked to a Nexus trading account. Register first at /register-orderly-key or via the skill registration flow.",
          }, request, 401);
        }
      } else if (walletAddress && !walletSig) {
        // walletAddress provided but sign_message was not called — reject
        return json({
          error: "walletSig_required",
          walletAddress,
          message: "sign_message('nexus-trading-key-v1') must be called before every trade. walletAddress alone is not enough — the server needs the signature to derive your private signing key.",
        }, request, 401);
      } else {
        // No walletSig, no walletAddress — platform account (single-user / direct call)
        const err = await useEnvSecrets();
        if (err) return err;
      }

      async function orderlySign(method, path, bodyStr) {
        const timestamp = Date.now();
        const msgBytes  = new TextEncoder().encode(timestamp + method.toUpperCase() + path + (bodyStr || ""));
        const sigBuf    = new Uint8Array(await crypto.subtle.sign("Ed25519", signingKey, msgBytes));
        const sig       = btoa(String.fromCharCode(...sigBuf)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
        return {
          "Content-Type":       "application/json",
          "orderly-timestamp":  String(timestamp),
          "orderly-account-id": accountId,
          "orderly-key":        orderlyApiKey,
          "orderly-signature":  sig,
        };
      }

      async function orderlyRequest(method, path, data) {
        const bodyStr = data ? JSON.stringify(data) : undefined;
        const headers = await orderlySign(method, path, bodyStr);
        const res = await fetch(ORDERLY_BASE + path, { method, headers, body: bodyStr });
        return res.json();
      }

      try {
        const priceData   = await (await fetch(ORDERLY_BASE + "/v1/public/futures/" + symbol)).json();
        const futuresInfo = priceData?.data || {};
        const markPrice   = futuresInfo.mark_price;
        if (!markPrice) return json({ error: "failed to fetch mark price", symbol, hint: "Symbol may not be listed on Orderly Network. Try PERP_BTC_USDC, PERP_ETH_USDC, PERP_SOL_USDC, PERP_ARB_USDC, PERP_HYPE_USDC.", raw: priceData }, request, 502);

        // ⚠️ Step size + min_notional live on /v1/public/info — NOT /v1/public/futures,
        // which returns null for them. Reading them off /futures silently defaulted
        // minNotional→1, so sub-minimum orders slipped past the guard and were then
        // rejected by the exchange (and that rejection used to be reported as success).
        const symInfo       = (await (await fetch(ORDERLY_BASE + "/v1/public/info/" + symbol)).json())?.data || {};
        const qtyStep       = symInfo.base_tick ?? futuresInfo.base_tick ?? futuresInfo.qty_step ?? 0.01;
        const baseMin       = symInfo.base_min ?? 0;
        const minNotional   = symInfo.min_notional ?? futuresInfo.min_notional ?? 10;
        const validNotional = notional;
        // Snap to the step with toFixed (avoids float artifacts like 0.17000000003
        // → Orderly -1104). decimals = -log10(step), e.g. 0.01 → 2dp.
        const decimals = Math.max(0, Math.round(-Math.log10(qtyStep)));
        const snap = (q) => parseFloat((Math.floor(q / qtyStep) * qtyStep).toFixed(decimals));
        let quantity = snap(validNotional / markPrice);
        // ⚠️ Floor-snapping a min-sized order can dip its VALUE just under min_notional
        // (e.g. $10 HYPE → 0.17 → $9.95) → Orderly "order value should be ≥ 10". Bump
        // up one step to clear the exchange minimum. Skip for reduce-only.
        if (!isReduceOnly && quantity * markPrice < minNotional) {
          quantity = parseFloat((Math.ceil((minNotional / markPrice) / qtyStep) * qtyStep).toFixed(decimals));
        }
        if (!isReduceOnly && baseMin && quantity < baseMin) quantity = baseMin;

        // ── Minimum notional / size guard (skip for reduce-only — qty comes from position) ──
        if (!isReduceOnly && (validNotional < minNotional || quantity <= 0)) {
          return json({
            error: "below_min_notional",
            notional: validNotional,
            minNotional,
            message: `Minimum order size for ${symbol.replace("PERP_", "").replace("_USDC", "")} is $${minNotional} notional. You tried $${validNotional}. Increase size (or leverage so the margin still fits).`,
            hint: `Minimum order size for ${symbol} is $${minNotional}. Requested: $${validNotional}.`,
          }, request, 400);
        }

        const authCheck = await orderlyRequest("GET", "/v1/client/holding", null);
        if (!authCheck.success) {
          return json({ error: "auth failed", detail: authCheck, hint: "key/secret mismatch" }, request, 401);
        }

        // ── Margin check (skip for reduce-only — closing never requires margin) ──
        // Use the ACTUAL order value (qty may have been bumped to clear min_notional),
        // not the requested notional, so the margin estimate is honest.
        const lev = Math.max(1, Number(leverage) || 1);
        const actualNotional = quantity * markPrice;
        if (!isReduceOnly) {
          const holdingRows    = authCheck?.data?.holding ?? [];
          const usdcHolding    = holdingRows.find(h => h.token === "USDC");
          const freeCollateral = Number(usdcHolding?.holding ?? usdcHolding?.available ?? 0);
          const requiredMargin = actualNotional / lev;
          if (freeCollateral > 0 && requiredMargin > freeCollateral * 0.95) {
            return json({
              error: "insufficient_margin",
              freeCollateral,
              requiredMargin,
              hint: `Trade requires ~$${requiredMargin.toFixed(2)} margin at ${lev}x but only $${freeCollateral.toFixed(2)} free collateral available. Reduce size or add collateral via /proxy/bankr-deposit.`,
            }, request, 400);
          }
        }

        const leverageResult = isReduceOnly ? null : await orderlyRequest("POST", "/v1/client/leverage", { leverage: lev });
        const orderBody = {
          symbol, order_type: orderType.toUpperCase(), side: side.toUpperCase(), order_quantity: quantity,
          ...(isReduceOnly && { reduce_only: true }),
        };
        const orderResult = await orderlyRequest("POST", "/v1/order", orderBody);

        // ⚠️ Don't report a rejected order as success. Orderly returns
        // { success:false, code, message } on reject (min-notional, step size,
        // margin, etc.); surfacing it as ok:true (the old behavior) made trades
        // "place" with no resulting position. Fail loudly with the real reason.
        if (!orderResult || orderResult.success === false) {
          return json({
            error: "order_rejected",
            code: orderResult?.code,
            message: orderResult?.message || "Orderly rejected the order — check size, min notional, step size, or margin.",
            detail: orderResult,
            quantity, validNotional, minNotional,
          }, request, 400);
        }

        // ── SL/TP via POSITIONAL_TP_SL algo order (optional) ───────────────────
        // Orderly requires child_orders array with CLOSE_POSITION type — NOT flat tp/sl fields.
        // Close side: LONG position (entry BUY) → SELL to close; SHORT (entry SELL) → BUY to close.
        let slTpResult = null;
        if (stopLoss || takeProfit) {
          const closeSide = side.toUpperCase() === "BUY" ? "SELL" : "BUY";
          const childOrders = [];
          if (takeProfit) childOrders.push({
            symbol, algo_type: "TAKE_PROFIT", side: closeSide, type: "CLOSE_POSITION",
            trigger_price_type: "MARK_PRICE", trigger_price: Number(takeProfit), reduce_only: true,
          });
          if (stopLoss) childOrders.push({
            symbol, algo_type: "STOP_LOSS", side: closeSide, type: "CLOSE_POSITION",
            trigger_price_type: "MARK_PRICE", trigger_price: Number(stopLoss), reduce_only: true,
          });
          const algoBody = {
            symbol, algo_type: "POSITIONAL_TP_SL",
            quantity: null,            // MUST be null for POSITIONAL_TP_SL — Orderly rejects any qty value
            trigger_price_type: "MARK_PRICE",
            child_orders: childOrders,
          };
          slTpResult = await orderlyRequest("POST", "/v1/algo/order", algoBody);
        }

        return json({
          ok: true, symbol, side: side.toUpperCase(), markPrice, qtyStep, minNotional,
          validNotional, actualNotional: Number(actualNotional.toFixed(2)), quantity, notional, leverage: lev, leverageResult, order: orderResult,
          slTp: slTpResult,
          mode: walletSig ? "multi-user" : "single-user",
        }, request);

      } catch (e) {
        return json({ error: "trade execution failed", detail: String(e) }, request, 500);
      }
    }

    // ── /set-sl-tp — attach POSITIONAL_TP_SL to an existing open position ──────
    // Called after trade confirms. Looks up position qty from Orderly, then places algo order.
    // Same walletSig/walletAddress auth as /trade.
    if (parts[0] === "set-sl-tp" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { symbol: rawSym, stopLoss: sl, takeProfit: tp, walletSig: wSig2, walletAddress: wAddr2 } = body;
      if (!rawSym || (!sl && !tp)) {
        return json({ error: "symbol and at least one of stopLoss or takeProfit required" }, request, 400);
      }
      const normSym2 = (s) => {
        s = s.toUpperCase().trim();
        if (s.startsWith("PERP_")) return s;
        s = s.replace(/[-_]?(PERP|USDC|USD|USDT)$/i, "").replace(/[^A-Z0-9]/g, "");
        return "PERP_" + s + "_USDC";
      };
      const sym2 = normSym2(rawSym);
      const OBASE2 = "https://api-evm.orderly.org";
      const HDR2 = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      let acctId2, apiKey2, signKey2;
      if (wSig2 && wAddr2) {
        const wn2 = wAddr2.toLowerCase().trim();
        const ur2 = await env.LAB_STORE.get("user:" + wn2);
        if (!ur2) return json({ error: "wallet_not_registered" }, request, 401);
        const rec2 = JSON.parse(ur2);
        acctId2 = rec2.accountId; apiKey2 = rec2.orderlyKey;
        const hex2 = wSig2.startsWith("0x") ? wSig2.slice(2) : wSig2;
        const seed2 = new Uint8Array(await crypto.subtle.digest("SHA-256",
          new Uint8Array(hex2.match(/.{2}/g).map(b => parseInt(b, 16)))));
        const pk82 = new Uint8Array(48); pk82.set(HDR2, 0); pk82.set(seed2, 16);
        signKey2 = await crypto.subtle.importKey("pkcs8", pk82, { name: "Ed25519" }, false, ["sign"]);
      } else {
        if (!env.ORDERLY_API_SECRET || !env.ORDERLY_API_KEY || !env.ORDERLY_ACCOUNT_ID) {
          return json({ error: "credentials not configured" }, request, 500);
        }
        acctId2 = env.ORDERLY_ACCOUNT_ID; apiKey2 = env.ORDERLY_API_KEY;
        let pb2 = Uint8Array.from(atob(env.ORDERLY_API_SECRET), c => c.charCodeAt(0));
        if (pb2.length === 32) { const f2 = new Uint8Array(48); f2.set(HDR2,0); f2.set(pb2,16); pb2 = f2; }
        signKey2 = await crypto.subtle.importKey("pkcs8", pb2, { name: "Ed25519" }, false, ["sign"]);
      }
      const req2 = async (method, path, data) => {
        const bs = data ? JSON.stringify(data) : undefined;
        const ts2 = Date.now();
        const mb = new TextEncoder().encode(ts2 + method.toUpperCase() + path + (bs || ""));
        const sb = new Uint8Array(await crypto.subtle.sign("Ed25519", signKey2, mb));
        const b64 = btoa(String.fromCharCode(...sb)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
        const h = { "Content-Type":"application/json", "orderly-timestamp":String(ts2),
          "orderly-account-id":acctId2, "orderly-key":apiKey2, "orderly-signature":b64 };
        return (await fetch(OBASE2 + path, { method, headers: h, body: bs })).json();
      };
      // Fetch actual position quantity and direction from Orderly
      let posQty = null;
      let closeSide2 = "BUY";
      try {
        const pd = await req2("GET", "/v1/positions", null);
        const pos2 = (pd?.data?.rows || []).find(p => p.symbol === sym2);
        if (pos2) {
          const rawQty = Number(pos2.position_qty);
          posQty = Math.abs(rawQty);
          closeSide2 = rawQty >= 0 ? "SELL" : "BUY"; // LONG → SELL to close; SHORT → BUY to close
        }
      } catch (_) {}
      if (!posQty) {
        return json({ error: "no_open_position", symbol: sym2, hint: "No open position found for this symbol — open a position first" }, request, 400);
      }
      const childOrders2 = [];
      if (tp) childOrders2.push({
        symbol: sym2, algo_type: "TAKE_PROFIT", side: closeSide2, type: "CLOSE_POSITION",
        trigger_price_type: "MARK_PRICE", trigger_price: Number(tp), reduce_only: true,
      });
      if (sl) childOrders2.push({
        symbol: sym2, algo_type: "STOP_LOSS", side: closeSide2, type: "CLOSE_POSITION",
        trigger_price_type: "MARK_PRICE", trigger_price: Number(sl), reduce_only: true,
      });
      const algoB = {
        symbol: sym2, algo_type: "POSITIONAL_TP_SL",
        quantity: null,                // MUST be null for POSITIONAL_TP_SL — Orderly rejects any qty value
        trigger_price_type: "MARK_PRICE",
        child_orders: childOrders2,
      };
      const algoRes = await req2("POST", "/v1/algo/order", algoB);
      return json({ ok: algoRes?.success ?? false, symbol: sym2, stopLoss: sl, takeProfit: tp, quantity: posQty, closeSide: closeSide2, raw: algoRes }, request);
    }


    // ── /close-position — close an open position at market price ────────────
    // Looks up current position qty, fires reduce_only opposite-side market order.
    // No margin check — closing never requires margin.
    if (parts[0] === "close-position" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { symbol: rawSym, walletSig: wSig3, walletAddress: wAddr3 } = body;
      if (!rawSym) return json({ error: "symbol required" }, request, 400);

      const normSym3 = (s) => {
        s = s.toUpperCase().trim();
        return s.startsWith("PERP_") ? s : "PERP_" + s + "_USDC";
      };
      const sym3 = normSym3(rawSym);

      const OBASE3 = "https://api-evm.orderly.org";
      const PKCS8_HDR3 = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      let acctId3, apiKey3, signKey3;

      if (wSig3 && wAddr3) {
        const walletNorm3 = wAddr3.toLowerCase().trim();
        const userRaw3 = await env.LAB_STORE.get("user:" + walletNorm3);
        if (!userRaw3) return json({ error: "wallet_not_registered" }, request, 401);
        const rec3 = JSON.parse(userRaw3);
        acctId3 = rec3.accountId; apiKey3 = rec3.orderlyKey;
        const hex3 = wSig3.startsWith("0x") ? wSig3.slice(2) : wSig3;
        const seed3 = new Uint8Array(await crypto.subtle.digest("SHA-256",
          new Uint8Array(hex3.match(/.{2}/g).map(b => parseInt(b, 16)))));
        const pk83 = new Uint8Array(48); pk83.set(PKCS8_HDR3, 0); pk83.set(seed3, 16);
        signKey3 = await crypto.subtle.importKey("pkcs8", pk83, { name: "Ed25519" }, false, ["sign"]);
      } else {
        return json({ error: "walletSig and walletAddress required" }, request, 401);
      }

      const req3 = async (method, path, data) => {
        const bs = data ? JSON.stringify(data) : undefined;
        const ts3 = Date.now();
        const mb3 = new TextEncoder().encode(ts3 + method.toUpperCase() + path + (bs || ""));
        const sb3 = new Uint8Array(await crypto.subtle.sign("Ed25519", signKey3, mb3));
        const b643 = btoa(String.fromCharCode(...sb3)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
        const h3 = { "Content-Type":"application/json", "orderly-timestamp":String(ts3),
          "orderly-account-id":acctId3, "orderly-key":apiKey3, "orderly-signature":b643 };
        return (await fetch(OBASE3 + path, { method, headers: h3, body: bs })).json();
      };

      // Fetch position to get qty and direction
      const pd3 = await req3("GET", "/v1/positions", null);
      const pos3 = (pd3?.data?.rows || []).find(p => p.symbol === sym3);
      if (!pos3 || Number(pos3.position_qty) === 0) {
        return json({ error: "no_open_position", symbol: sym3, hint: "No open position found for this symbol." }, request, 400);
      }
      const rawQty3 = Number(pos3.position_qty);
      const closeQty = Math.abs(rawQty3);
      const closeSide3 = rawQty3 > 0 ? "SELL" : "BUY"; // LONG→SELL, SHORT→BUY

      const closeOrder = await req3("POST", "/v1/order", {
        symbol: sym3, order_type: "MARKET", side: closeSide3,
        order_quantity: closeQty, reduce_only: true,
      });
      return json({
        ok: closeOrder?.success ?? false,
        symbol: sym3, closeSide: closeSide3, quantity: closeQty,
        markPrice: pos3.mark_price, entryPrice: pos3.average_open_price,
        unrealizedPnl: pos3.unsettled_pnl,
        raw: closeOrder,
      }, request);
    }

    // ── /proxy/thesis-register — register a thesis on ThesisRegistry (Arbitrum) ─
    // ABI-encodes registerThesis() and submits via Bankr /wallet/submit.
    // Selector: 0xce4d0f18 = keccak256("registerThesis(string,uint8,uint256,uint256,uint256,uint256,uint256,bool,string)")
    // Price scaling: 1e6 (e.g. $65000.50 → 65000500000). RR scaling: 1e4.
    if (parts[0] === "proxy" && parts[1] === "thesis-register" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletAddress, bankrApiKey, symbol: rawSym, direction, entryPrice, stopLoss, takeProfit1, takeProfit2 = 0, isPublic = true, notes = "" } = body;
      if (!walletAddress || !bankrApiKey || !rawSym || !direction || !entryPrice || !stopLoss || !takeProfit1) {
        return json({ error: "missing required fields: walletAddress, bankrApiKey, symbol, direction, entryPrice, stopLoss, takeProfit1" }, request, 400);
      }

      const THESIS_REGISTRY = "0x2F4EdA890f96a7979d6f26bCB210cEDAD68346Bc";
      const CHAIN_ID = 42161; // Arbitrum One

      const normSym = (s) => { s = s.toUpperCase().trim(); return s.startsWith("PERP_") ? s : "PERP_" + s + "_USDC"; };
      const sym = normSym(rawSym);
      const dirEnum = direction.toUpperCase() === "LONG" ? 0 : 1;

      // Price encoding: 1e6 (contract uses 6 decimal scaling)
      const scale = (v) => BigInt(Math.round(Number(v) * 1_000_000));
      const entryScaled = scale(entryPrice);
      const slScaled    = scale(stopLoss);
      const tp1Scaled   = scale(takeProfit1);
      const tp2Scaled   = scale(takeProfit2);

      // Risk-reward: |tp1 - entry| / |entry - sl|, scaled by 1e4
      const rrRaw = Math.abs(Number(takeProfit1) - Number(entryPrice)) / Math.abs(Number(entryPrice) - Number(stopLoss));
      const rrScaled = BigInt(Math.round(rrRaw * 10_000));

      // ── ABI encode registerThesis(string,uint8,uint256,uint256,uint256,uint256,uint256,bool,string) ──
      const enc = new TextEncoder();
      const symBytes   = enc.encode(sym);
      const notesBytes = enc.encode(notes);

      const padTo32bytes = (bytes) => {
        const padLen = Math.ceil(Math.max(bytes.length, 1) / 32) * 32;
        const out = new Uint8Array(padLen); out.set(bytes); return out;
      };
      const toBE32 = (val) => {
        const b = new Uint8Array(32);
        let v = typeof val === 'bigint' ? val : BigInt(val);
        for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
        return b;
      };

      const symPadded   = padTo32bytes(symBytes);
      // notesPadded only used when notes is non-empty; empty string = length 0 + no data bytes
      const notesPadded = notesBytes.length ? padTo32bytes(notesBytes) : null;

      const HEAD = 9 * 32; // 288 bytes — 9 params
      const offsetSym   = HEAD;
      // offsetNotes: after selector-less HEAD + sym length word + sym data
      const offsetNotes = HEAD + 32 + symPadded.length;

      const parts_enc = [
        new Uint8Array([0xce, 0x4d, 0x0f, 0x18]), // selector
        toBE32(offsetSym),
        toBE32(dirEnum),
        toBE32(entryScaled),
        toBE32(slScaled),
        toBE32(tp1Scaled),
        toBE32(tp2Scaled),
        toBE32(rrScaled),
        toBE32(isPublic ? 1 : 0),
        toBE32(offsetNotes),
        toBE32(symBytes.length),   // symbol: length word
        symPadded,                 // symbol: padded data
        toBE32(notesBytes.length), // notes: length word (0 if empty)
        ...(notesPadded ? [notesPadded] : []), // notes: padded data (omit if empty)
      ];

      const totalLen = parts_enc.reduce((s, p) => s + p.length, 0);
      const calldata = new Uint8Array(totalLen);
      let off = 0;
      for (const p of parts_enc) { calldata.set(p, off); off += p.length; }
      const calldataHex = "0x" + Array.from(calldata).map(b => b.toString(16).padStart(2,"0")).join("");

      // Submit via Bankr /wallet/submit
      const bankrRes = await fetch("https://api.bankr.bot/wallet/submit", {
        method: "POST",
        headers: { "X-API-Key": bankrApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction: { to: THESIS_REGISTRY, chainId: CHAIN_ID, value: "0", data: calldataHex },
          description: `Register ${direction.toUpperCase()} thesis for ${sym} on ThesisRegistry`,
          waitForConfirmation: true,
        }),
      });
      const bankrData = await bankrRes.json();
      if (!bankrData?.success) {
        return json({ error: "bankr_submit_failed", detail: bankrData }, request, 502);
      }
      const txHash = bankrData.txHash || bankrData?.transaction?.hash || bankrData.hash;

      // Write thesis to KV so it shows in /feed immediately
      const walletNormTR = walletAddress.toLowerCase().trim();
      const labKeyTR = `lab:${walletNormTR}`;
      const existingRawTR = await env.LAB_STORE.get(labKeyTR);
      const existingDataTR = existingRawTR ? JSON.parse(existingRawTR) : { theses: [] };
      const rrFinal = Math.round(rrRaw * 100) / 100;
      const newThesis = {
        id: crypto.randomUUID(),
        symbol: sym,
        direction: direction.toUpperCase(),
        entryPrice: Number(entryPrice),
        stopLoss: Number(stopLoss),
        takeProfit1: Number(takeProfit1),
        takeProfit2: Number(takeProfit2),
        riskPercent: 0,
        accountSize: 0,
        fundingRate: 0,
        notes: notes || "",
        createdAt: Date.now(),
        positionSize: 0,
        leverage: 0,
        riskReward: rrFinal,
        fundingCost8h: 0,
        fundingCost24h: 0,
        fundingCost72h: 0,
        status: "ACTIVE",
        actualPnl: null,
        isPublic: isPublic !== false,
        onChainTxHash: txHash,
      };
      existingDataTR.theses = [newThesis, ...(existingDataTR.theses || [])];
      await env.LAB_STORE.put(labKeyTR, JSON.stringify(existingDataTR));

      return json({ ok: true, txHash, thesisId: newThesis.id, symbol: sym, direction: direction.toUpperCase(), entryPrice, stopLoss, takeProfit1, takeProfit2, isPublic, notes, riskReward: rrFinal, hint: "Thesis registered on-chain and indexed in /feed. Parse ThesisRegistered event from txHash to get onChainId." }, request);
    }

    // ── /mark-price — get current mark price for a symbol ───────────────────
    // ── GET /auth/challenge — mint a request-bound (v2) signing challenge (Phase 2 of #14) ──
    // Public to ISSUE (it grants nothing); the signature proves ownership at verify time.
    // ?wallet=&action=&amount=  → { challenge, nonce, expires }. The client signs `challenge`
    // (personal_sign) and replays { nonce, v2Sig } on the high-risk call. The nonce + signed
    // fields are stored server-side (KV, ~120s TTL) so verifyV2 rebuilds the canonical message
    // from the TRUSTED record, not client input. Single-use: burned on first successful verify.
    if (parts[0] === "auth" && parts[1] === "challenge" && request.method === "GET") {
      const qa = url.searchParams;
      const wallet = (qa.get("wallet") || "").toLowerCase().trim();
      const action = qa.get("action") || "";
      const amount = qa.has("amount") ? qa.get("amount") : null;
      if (!/^0x[0-9a-f]{40}$/.test(wallet)) return json({ error: "valid wallet required (0x… 40 hex)" }, request, 400);
      if (!AUTH_V2_ACTIONS.has(action)) return json({ error: "unknown action", allowed: [...AUTH_V2_ACTIONS] }, request, 400);
      const TTL_SEC = 120;
      const nonce = crypto.randomUUID();
      const expires = Date.now() + TTL_SEC * 1000;
      const record = { action, wallet, nonce, amount, expires };
      const KV = env.NEXUS_AGENT || env.LAB_STORE;
      await KV.put(`auth:nonce:${nonce}`, JSON.stringify(record), { expirationTtl: TTL_SEC });
      const challenge = buildChallenge({ action, wallet, nonce, amount, expires });
      return json({ challenge, nonce, expires, action, wallet, amount, ttlSeconds: TTL_SEC }, request);
    }

    // Public endpoint, no auth required. Symbol: BTC, ETH, SOL, or PERP suffix.
    // Returns { symbol, markPrice, indexPrice, lastPrice }
    if (parts[0] === "mark-price" && request.method === "GET") {
      const qp2 = new URL(request.url).searchParams;
      const rawSym = qp2.get("symbol") || qp2.get("sym") || "";
      if (!rawSym) return json({ error: "symbol required — GET /mark-price?symbol=BTC" }, request, 400);
      const symMap = { BTC:"PERP_BTC_USDC", ETH:"PERP_ETH_USDC", SOL:"PERP_SOL_USDC", ARB:"PERP_ARB_USDC", LINK:"PERP_LINK_USDC", WIF:"PERP_WIF_USDC" };
      const mpSym = symMap[rawSym.toUpperCase()] || (rawSym.toUpperCase().startsWith("PERP_") ? rawSym.toUpperCase() : "PERP_" + rawSym.toUpperCase() + "_USDC");
      try {
        const mpRes = await fetch(`https://api-evm.orderly.org/v1/public/futures/${mpSym}`);
        const mpData = await mpRes.json();
        if (!mpData?.data) return json({ error: "symbol not found", symbol: mpSym }, request, 404);
        const d = mpData.data;
        return json({ symbol: mpSym, markPrice: d.mark_price, indexPrice: d.index_price, lastPrice: d.last_price, openInterest: d.open_interest, volume24h: d.volume }, request);
      } catch (e) {
        return json({ error: "price fetch failed", detail: String(e) }, request, 500);
      }
    }


    // ── /intel/catalysts/:symbol — "why is X moving": move context + headlines ─
    // Powers the explain_move copilot tool + the Market Intel "Why?" chip. Fuses
    // the Orderly public move (price/funding/OI) with recent headlines for the
    // ASSET (rss2json → Google News search, keyed by symbolToQuery so "CL" pulls
    // crude-oil news, not nothing). The copilot does the SYNTHESIS + citation —
    // this route only supplies grounded data, so there is NO LLM spend here and
    // it stays public/no-auth. Fail-soft: a news failure still returns the move.
    // Edge-cached 300s (also protects the rss2json free-tier quota).
    if (parts[0] === "intel" && parts[1] === "catalysts" && request.method === "GET") {
      const rawSym = parts[2] || new URL(request.url).searchParams.get("symbol") || "";
      const meta = symbolToQuery(rawSym);
      if (!meta) return json({ error: "symbol required — GET /intel/catalysts/BTC" }, request, 400);
      const perpSym = `PERP_${meta.ticker}_USDC`;
      // move context (fail-soft)
      let move = null;
      try {
        const d = (await (await fetch(`https://api-evm.orderly.org/v1/public/futures/${perpSym}`)).json())?.data;
        if (d) {
          const mark = Number(d.mark_price), open24 = Number(d["24h_open"]);
          move = {
            markPrice: d.mark_price,
            change24hPct: (mark && open24) ? Math.round(((mark - open24) / open24) * 10000) / 100 : null,
            fundingRate8h: d.last_funding_rate,
            openInterest: d.open_interest,
            volume24h: d["24h_amount"] ?? d.volume,
          };
        }
      } catch { /* fail-soft — return catalysts without move */ }
      // catalysts (fail-soft): recent headlines for the asset, last 3 days
      let catalysts = [];
      try {
        const gnews = `https://news.google.com/rss/search?q=${encodeURIComponent(meta.query + " when:3d")}&hl=en-US&gl=US&ceid=US:en`;
        // NB: rss2json's `count` param requires a paid key (422s on free tier) —
        // omit it and slice below. Edge cache (300s) absorbs the free-tier rate limit.
        const nd = await (await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(gnews)}`, { signal: AbortSignal.timeout(6000) })).json();
        if (nd?.status === "ok" && Array.isArray(nd.items)) {
          catalysts = nd.items.slice(0, 6).map((it) => ({
            title: String(it.title || "").replace(/ - [^-]*$/, ""), // strip trailing " - Source"
            source: (String(it.title || "").split(" - ").pop() || "").trim() || (nd.feed?.title ?? ""),
            link: it.link,
            pubDate: it.pubDate,
          }));
        }
      } catch { /* fail-soft — return move without catalysts */ }
      return new Response(JSON.stringify({
        symbol: perpSym, ticker: meta.ticker, name: meta.name, assetClass: meta.assetClass,
        move, catalysts, asOf: new Date().toISOString(),
        note: "Headlines are candidate context, not confirmed causes — correlation is not causation.",
      }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ...cors(request) } });
    }

    // ── /funding-rate — current funding rate for a symbol ────────────────────
    // Public endpoint, no auth. Returns current funding rate + next funding time.
    if (parts[0] === "funding-rate" && request.method === "GET") {
      const frSym = new URL(request.url).searchParams.get("symbol") || "";
      if (!frSym) return json({ error: "symbol required — GET /funding-rate?symbol=BTC" }, request, 400);
      const symMap2 = { BTC:"PERP_BTC_USDC", ETH:"PERP_ETH_USDC", SOL:"PERP_SOL_USDC", ARB:"PERP_ARB_USDC", LINK:"PERP_LINK_USDC", WIF:"PERP_WIF_USDC", HYPE:"PERP_HYPE_USDC", XMR:"PERP_XMR_USDC" };
      const frFull = symMap2[frSym.toUpperCase()] || (frSym.toUpperCase().startsWith("PERP_") ? frSym.toUpperCase() : "PERP_" + frSym.toUpperCase() + "_USDC");
      try {
        const frRes  = await fetch(`https://api-evm.orderly.org/v1/public/funding_rate/${frFull}`);
        const frData = await frRes.json();
        if (!frData?.data) return json({ error: "symbol not found or no funding data", symbol: frFull }, request, 404);
        const fd = frData.data;
        return json({
          symbol: frFull,
          fundingRate: fd.last_funding_rate,         // annualized rate as decimal (e.g. 0.0001 = 0.01%)
          fundingRatePct: (fd.last_funding_rate * 100).toFixed(6) + "%",
          nextFundingTime: fd.next_funding_time,     // unix ms
          estFundingRate: fd.est_funding_rate,
        }, request);
      } catch (e) {
        return json({ error: "funding rate fetch failed", detail: String(e) }, request, 500);
      }
    }

    // ── /24h-stats — 24h volume, OI, price stats for a symbol ───────────────
    // Public endpoint, no auth.
    if ((parts[0] === "24h-stats" || parts[0] === "stats") && request.method === "GET") {
      const stSym = new URL(request.url).searchParams.get("symbol") || "";
      if (!stSym) return json({ error: "symbol required — GET /24h-stats?symbol=BTC" }, request, 400);
      const symMap3 = { BTC:"PERP_BTC_USDC", ETH:"PERP_ETH_USDC", SOL:"PERP_SOL_USDC", ARB:"PERP_ARB_USDC", LINK:"PERP_LINK_USDC", WIF:"PERP_WIF_USDC", HYPE:"PERP_HYPE_USDC", XMR:"PERP_XMR_USDC" };
      const stFull = symMap3[stSym.toUpperCase()] || (stSym.toUpperCase().startsWith("PERP_") ? stSym.toUpperCase() : "PERP_" + stSym.toUpperCase() + "_USDC");
      try {
        const stRes  = await fetch(`https://api-evm.orderly.org/v1/public/futures/${stFull}`);
        const stData = await stRes.json();
        if (!stData?.data) return json({ error: "symbol not found", symbol: stFull }, request, 404);
        const sd = stData.data;
        return json({
          symbol: stFull,
          markPrice: sd.mark_price,
          indexPrice: sd.index_price,
          lastPrice: sd.last_price,
          change24h: sd.change,                      // % price change 24h
          high24h: sd["24h_high"] || sd.high,
          low24h: sd["24h_low"] || sd.low,
          volume24h: sd.volume,                      // USDC volume
          openInterest: sd.open_interest,
          fundingRate: sd.last_funding_rate,
          nextFundingTime: sd.next_funding_time,
        }, request);
      } catch (e) {
        return json({ error: "stats fetch failed", detail: String(e) }, request, 500);
      }
    }

    // ── /order-history — recent filled/cancelled orders ──────────────────────
    // POST { walletAddress, walletSig, symbol?, limit? }
    // Returns last N orders (default 20, max 100). Requires walletSig auth.
    if (parts[0] === "order-history" && request.method === "POST") {
      let ohbody; try { ohbody = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletAddress: ohwa, walletSig: ohws, symbol: ohsym, limit: ohlim } = ohbody;
      if (!ohwa || !ohws) return json({ error: "walletSig_required", hint: "POST { walletAddress, walletSig, symbol?, limit? }" }, request, 401);
      const ohNorm = ohwa.toLowerCase().trim();
      const ohRaw  = await env.LAB_STORE.get("user:" + ohNorm);
      if (!ohRaw) return json({ error: "wallet_not_registered" }, request, 401);
      const ohrec  = JSON.parse(ohRaw);
      const OHHDR  = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      const ohhex  = ohws.startsWith("0x") ? ohws.slice(2) : ohws;
      const ohseed = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(ohhex.match(/.{1,2}/g).map(b => parseInt(b, 16)))));
      const ohpk8  = new Uint8Array(48); ohpk8.set(OHHDR, 0); ohpk8.set(ohseed, 16);
      const ohsk   = await crypto.subtle.importKey("pkcs8", ohpk8, { name: "Ed25519" }, false, ["sign"]);
      if (!ohrec.seed) {
        const _ohSeedHex = [...ohseed].map(b => b.toString(16).padStart(2,"0")).join("");
        await env.LAB_STORE.put("user:" + ohNorm, JSON.stringify({ ...ohrec, seed: _ohSeedHex }));
      }
      const ohsign = async (method, path) => {
        const ts  = Date.now();
        const msg = new TextEncoder().encode(ts + method + path);
        const s   = new Uint8Array(await crypto.subtle.sign("Ed25519", ohsk, msg));
        const b64 = btoa(String.fromCharCode(...s)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
        return { "orderly-timestamp": String(ts), "orderly-account-id": ohrec.accountId, "orderly-key": ohrec.orderlyKey, "orderly-signature": b64 };
      };
      const pageSize = Math.min(Number(ohlim) || 20, 100);
      const symParam = ohsym ? `&symbol=${ohsym.toUpperCase().startsWith("PERP_") ? ohsym.toUpperCase() : "PERP_" + ohsym.toUpperCase() + "_USDC"}` : "";
      const ohPath   = `/v1/orders?size=${pageSize}&page=1${symParam}`;
      const ohHdrs   = await ohsign("GET", ohPath);
      const ohRes    = await fetch("https://api-evm.orderly.org" + ohPath, { headers: ohHdrs });
      const ohData   = await ohRes.json();
      const orders   = (ohData?.data?.rows ?? []).map(o => ({
        orderId: o.order_id, symbol: o.symbol, side: o.side, type: o.type,
        status: o.status, price: o.price, quantity: o.quantity,
        executedQty: o.executed, avgPrice: o.average_executed_price,
        fee: o.total_fee, feeCurrency: o.fee_asset,
        createdAt: o.created_time, updatedAt: o.updated_time,
      }));
      return json({ count: orders.length, orders }, request);
    }

    // ── /cancel — cancel an open (unfilled) order ────────────────────────────
    // POST { walletAddress, walletSig, orderId, symbol }
    // orderId from the original /trade response raw.data.order_id
    if (parts[0] === "cancel" && request.method === "POST") {
      let cbody; try { cbody = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletAddress: cwa, walletSig: cws, orderId: coid, symbol: csym } = cbody;
      if (!cwa || !cws) return json({ error: "walletSig_required", hint: "POST { walletAddress, walletSig, orderId, symbol }" }, request, 401);
      if (!coid) return json({ error: "orderId required" }, request, 400);
      const cwNorm = cwa.toLowerCase().trim();
      const cuRaw = await env.LAB_STORE.get("user:" + cwNorm);
      if (!cuRaw) return json({ error: "wallet_not_registered" }, request, 401);
      const curec = JSON.parse(cuRaw);
      const CPHDR = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      const chex  = cws.startsWith("0x") ? cws.slice(2) : cws;
      const cseed = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(chex.match(/.{1,2}/g).map(b => parseInt(b, 16)))));
      const cpk8  = new Uint8Array(48); cpk8.set(CPHDR, 0); cpk8.set(cseed, 16);
      const csk   = await crypto.subtle.importKey("pkcs8", cpk8, { name: "Ed25519" }, false, ["sign"]);
      const csign = async (method, path, body2) => {
        const ts  = Date.now();
        const bs2 = body2 ? JSON.stringify(body2) : "";
        const msg = new TextEncoder().encode(ts + method + path + bs2);
        const s   = new Uint8Array(await crypto.subtle.sign("Ed25519", csk, msg));
        const b64 = btoa(String.fromCharCode(...s)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
        return { "Content-Type": "application/json", "orderly-timestamp": String(ts), "orderly-account-id": curec.accountId, "orderly-key": curec.orderlyKey, "orderly-signature": b64 };
      };
      const cancelSym = csym ? (csym.toUpperCase().startsWith("PERP_") ? csym.toUpperCase() : "PERP_" + csym.toUpperCase() + "_USDC") : undefined;
      const cancelPath = cancelSym ? `/v1/order?order_id=${coid}&symbol=${cancelSym}` : `/v1/order?order_id=${coid}`;
      const cancelHdrs = await csign("DELETE", cancelPath);
      const cancelRes  = await fetch("https://api-evm.orderly.org" + cancelPath, { method: "DELETE", headers: cancelHdrs });
      const cancelData = await cancelRes.json();
      return json({ ok: cancelData?.success ?? false, orderId: coid, raw: cancelData }, request);
    }

    // ── /order-status — check fill status of a specific order ────────────────
    // POST { walletAddress, walletSig, orderId }
    // Returns order status: NEW, PARTIAL_FILLED, FILLED, CANCELLED, REJECTED
    if (parts[0] === "order-status" && request.method === "POST") {
      let osbody; try { osbody = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletAddress: oswa, walletSig: osws, orderId: osoid } = osbody;
      if (!oswa || !osws) return json({ error: "walletSig_required", hint: "POST { walletAddress, walletSig, orderId }" }, request, 401);
      if (!osoid) return json({ error: "orderId required" }, request, 400);
      const osNorm = oswa.toLowerCase().trim();
      const osRaw  = await env.LAB_STORE.get("user:" + osNorm);
      if (!osRaw) return json({ error: "wallet_not_registered" }, request, 401);
      const osrec  = JSON.parse(osRaw);
      const OSPHDR = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      const oshex  = osws.startsWith("0x") ? osws.slice(2) : osws;
      const osseed = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(oshex.match(/.{1,2}/g).map(b => parseInt(b, 16)))));
      const ospk8  = new Uint8Array(48); ospk8.set(OSPHDR, 0); ospk8.set(osseed, 16);
      const ossk   = await crypto.subtle.importKey("pkcs8", ospk8, { name: "Ed25519" }, false, ["sign"]);
      const ossign = async (method, path) => {
        const ts  = Date.now();
        const msg = new TextEncoder().encode(ts + method + path);
        const s   = new Uint8Array(await crypto.subtle.sign("Ed25519", ossk, msg));
        const b64 = btoa(String.fromCharCode(...s)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
        return { "orderly-timestamp": String(ts), "orderly-account-id": osrec.accountId, "orderly-key": osrec.orderlyKey, "orderly-signature": b64 };
      };
      const osPath = `/v1/order/${osoid}`;
      const osHdrs = await ossign("GET", osPath);
      const osRes  = await fetch("https://api-evm.orderly.org" + osPath, { headers: osHdrs });
      const osData = await osRes.json();
      if (!osData?.data) return json({ error: "order not found", orderId: osoid, raw: osData }, request, 404);
      const od = osData.data;
      return json({
        orderId: od.order_id, symbol: od.symbol, status: od.status,
        side: od.side, type: od.type, price: od.price, quantity: od.quantity,
        executedQty: od.executed, avgPrice: od.average_executed_price,
        filled: od.status === "FILLED", cancelled: od.status === "CANCELLED",
        raw: od,
      }, request);
    }

    // ── /derive-key — derive ed25519 public key from wallet signature ──────────
    // Browser sends walletSig from personal_sign, gets back orderlyKey (public only)
    if (parts[0] === "derive-key" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletSig } = body;
      if (!walletSig) return json({ error: "walletSig required" }, request, 400);
      try {
        const HDR  = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
        const B58C = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        const hex  = walletSig.startsWith("0x") ? walletSig.slice(2) : walletSig;
        const seed = new Uint8Array(await crypto.subtle.digest("SHA-256",
          new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)))));
        const pk8  = new Uint8Array(48); pk8.set(HDR,0); pk8.set(seed,16);
        const priv = await crypto.subtle.importKey("pkcs8", pk8, { name: "Ed25519" }, true, ["sign"]);
        const jwk  = await crypto.subtle.exportKey("jwk", priv);
        const raw  = Uint8Array.from(atob(jwk.x.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
        let n = BigInt("0x" + [...raw].map(b => b.toString(16).padStart(2,"0")).join(""));
        let s = ""; while (n > 0n) { s = B58C[Number(n%58n)] + s; n = n/58n; }
        for (const b of raw) { if (b===0) s="1"+s; else break; }
        return new Response(JSON.stringify({ orderlyKey: "ed25519:" + s }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ── /positions and /balance — proxy to Orderly private API ─────────────
    // POST body { walletAddress, walletSig } preferred; GET ?wallet=&sig= also accepted
    if ((parts[0] === "positions" || parts[0] === "balance") && (request.method === "GET" || request.method === "POST")) {
      const qp = new URL(request.url).searchParams;
      let wAddr = qp.get("wallet") || qp.get("walletAddress");
      let wSig  = qp.get("sig")    || qp.get("walletSig");
      if (request.method === "POST") {
        let pb; try { pb = await request.json(); } catch { pb = {}; }
        wAddr = wAddr || pb.walletAddress || pb.wallet;
        wSig  = wSig  || pb.walletSig    || pb.sig;
      }
      if (!wAddr || !wSig) return json({ error: "wallet and sig required — POST { walletAddress, walletSig } or GET ?wallet=&sig=" }, request, 400);
      const wNorm = wAddr.toLowerCase().trim();
      const uRaw  = await env.LAB_STORE.get("user:" + wNorm);
      if (!uRaw) return json({ error: "wallet_not_registered" }, request, 401);
      const urec  = JSON.parse(uRaw);
      const PHDR  = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      const phex  = wSig.startsWith("0x") ? wSig.slice(2) : wSig;
      const pseed = new Uint8Array(await crypto.subtle.digest("SHA-256",
        new Uint8Array(phex.match(/.{1,2}/g).map(b => parseInt(b, 16)))));
      const ppk8  = new Uint8Array(48); ppk8.set(PHDR, 0); ppk8.set(pseed, 16);
      const psk   = await crypto.subtle.importKey("pkcs8", ppk8, { name: "Ed25519" }, false, ["sign"]);
      if (!urec.seed) {
        const _pSeedHex = [...pseed].map(b => b.toString(16).padStart(2,"0")).join("");
        await env.LAB_STORE.put("user:" + wNorm, JSON.stringify({ ...urec, seed: _pSeedHex }));
      }
      const OBASE = "https://api-evm.orderly.org";
      const psign = async (method, path) => {
        const ts  = Date.now();
        const msg = new TextEncoder().encode(ts + method + path);
        const s   = new Uint8Array(await crypto.subtle.sign("Ed25519", psk, msg));
        const b64 = btoa(String.fromCharCode(...s)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
        return { "orderly-timestamp": String(ts), "orderly-account-id": urec.accountId, "orderly-key": urec.orderlyKey, "orderly-signature": b64 };
      };
      const opath = parts[0] === "positions" ? "/v1/positions" : "/v1/client/holding";
      const ohdrs = await psign("GET", opath);
      const ores  = await fetch(OBASE + opath, { headers: ohdrs });
      return json(await ores.json(), request);
    }

    // ── /deposit/prepare — build signed tx data for Orderly vault deposit ────
    if (parts[0] === "deposit" && parts[1] === "prepare" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }

      const { wallet, amount } = body;
      if (!wallet || !amount) {
        return json({ error: "wallet and amount (USDC) required — accountId is fetched automatically" }, request, 400);
      }

      // Fetch accountId from Orderly (never require caller to pass it)
      const prepAcctRes  = await fetch(`https://api-evm.orderly.org/v1/get_account?address=${wallet.toLowerCase().trim()}&broker_id=nexus_trading`);
      const prepAcctData = await prepAcctRes.json();
      const accountId    = prepAcctData?.data?.account_id ?? null;
      if (!accountId) {
        return json({ error: "no_orderly_account", hint: "Register first via /proxy/bankr-register" }, request, 400);
      }

      // Orderly vault constants (Arbitrum One)
      const VAULT    = "0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9";
      const USDC     = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
      const ARB_RPC  = getArbRpc(env);

      // Pre-computed hashes via solidityPackedKeccak256(["string"], [input])
      const BROKER_HASH = "69729be60357fd58653e988388922e200193543b4328eda1b9b9bdaaef2f1a70";
      const TOKEN_HASH  = "d6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa";

      // Pad a hex string (with or without 0x) to 32 bytes (64 hex chars)
      function pad32(hex) {
        const h = hex.startsWith("0x") ? hex.slice(2) : hex;
        return h.padStart(64, "0");
      }

      // Make an eth_call to Arbitrum RPC
      async function ethCall(to, data) {
        const res = await fetch(ARB_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        });
        const out = await res.json();
        if (out.error) throw new Error(out.error.message);
        return out.result;
      }

      // USDC has 6 decimals on Arbitrum
      const tokenAmountBig = BigInt(Math.round(Number(amount) * 1_000_000));
      const accountIdHex = pad32(accountId);

      // Deposit fee — depositFeeEnabled is true on Arbitrum mainnet.
      // Fee routes through LayerZero which refunds excess, so we send a fixed
      // generous amount (~$0.02) rather than computing dynamically.
      // Observed on-chain fee is ~0.000005 ETH; 0.00001 ETH gives 2x headroom.
      const feeHex = "0x" + (10000000000000n).toString(16); // 0.00001 ETH

      // Build approve calldata: approve(address spender, uint256 amount)
      // selector: 0x095ea7b3
      const approveData =
        "0x095ea7b3" +
        pad32(VAULT.replace(/^0x/, "").toLowerCase()) +
        pad32(tokenAmountBig.toString(16));

      // Build deposit calldata: deposit((bytes32,bytes32,bytes32,uint128))
      // selector: 0x322dda6d
      const depositData =
        "0x322dda6d" +
        accountIdHex +
        BROKER_HASH +
        TOKEN_HASH +
        pad32(tokenAmountBig.toString(16));

      return new Response(JSON.stringify({
        chainId: 42161,
        depositFee: feeHex,
        steps: [
          {
            step: 1,
            description: `Approve ${amount} USDC to Orderly vault`,
            to: USDC,
            data: approveData,
            value: "0x0",
          },
          {
            step: 2,
            description: `Deposit ${amount} USDC to Nexus trading account`,
            to: VAULT,
            data: depositData,
            value: feeHex,
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }


    // ── /proxy/bankr-deposit — execute USDC deposit via Bankr /wallet/submit ────
    // Flow: fetch accountId → build approve calldata → /wallet/submit (approve)
    //       → build deposit calldata → /wallet/submit (deposit) → done
    // Requires Wallet & Agent API enabled on bankrApiKey, and NO allowedRecipients set.
    // If allowedRecipients is set on the key, /wallet/submit blocks raw tx — user must
    // clear it in bankr.bot/api settings or deposit manually at trade.nexustradinglabs.com.
    if (parts[0] === "proxy" && parts[1] === "bankr-deposit" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletAddress, bankrApiKey, amount } = body;
      if (!walletAddress || !bankrApiKey || !amount) {
        return json({ error: "walletAddress, bankrApiKey, and amount (USDC) required" }, request, 400);
      }
      try {
        const walletNorm    = walletAddress.toLowerCase().trim();
        const VAULT_D       = "0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9";
        const USDC_D        = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
        const BROKER_HASH_D = "69729be60357fd58653e988388922e200193543b4328eda1b9b9bdaaef2f1a70";
        const TOKEN_HASH_D  = "d6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa";
        const feeWei        = "10000000000000"; // 0.00001 ETH LayerZero fee in wei (string for submit)
        const BANKR_SUBMIT  = "https://api.bankr.bot/wallet/submit";
        const CHAIN_D       = 42161; // Arbitrum One

        function pad32D(hex) {
          const h = hex.startsWith("0x") ? hex.slice(2) : hex;
          return h.padStart(64, "0");
        }

        // 1. Fetch accountId from Orderly
        const acctRes = await fetch(
          `https://api-evm.orderly.org/v1/get_account?address=${walletNorm}&broker_id=nexus_trading`
        );
        const acctData = await acctRes.json();
        const accountId = acctData?.data?.account_id ?? null;
        if (!accountId) {
          return json({
            error: "no_orderly_account",
            hint: "Wallet not registered. Call /proxy/bankr-register first.",
          }, request, 400);
        }

        const tokenAmountBig = BigInt(Math.round(Number(amount) * 1_000_000));

        // 2. Build calldata
        const approveCalldata =
          "0x095ea7b3" +
          pad32D(VAULT_D.replace(/^0x/, "").toLowerCase()) +
          pad32D(tokenAmountBig.toString(16));

        const depositCalldata =
          "0x322dda6d" +
          pad32D(accountId.replace(/^0x/, "")) +
          BROKER_HASH_D +
          TOKEN_HASH_D +
          pad32D(tokenAmountBig.toString(16));

        const bankrHeaders = { "X-API-Key": bankrApiKey, "Content-Type": "application/json" };

        // 3. Submit approve tx via Bankr /wallet/submit
        const approveRes = await fetch(BANKR_SUBMIT, {
          method: "POST",
          headers: bankrHeaders,
          body: JSON.stringify({
            transaction: { to: USDC_D, chainId: CHAIN_D, value: "0", data: approveCalldata },
            description: `Approve ${amount} USDC to Orderly vault`,
            waitForConfirmation: true,
          }),
        });
        const approveData = await approveRes.json();
        if (!approveData?.success) {
          // If blocked due to allowedRecipients, give clear guidance
          const isBlocked = approveRes.status === 403 || String(approveData?.error ?? "").includes("recipient");
          return json({
            ok: false,
            step: "approve",
            error: approveData?.error ?? "approve_failed",
            hint: isBlocked
              ? "Your Bankr API key has allowedRecipients set, which blocks raw tx submission. Go to bankr.bot/api and clear the allowedRecipients list, then retry. Or deposit manually at https://trade.nexustradinglabs.com"
              : "Approve transaction failed. Check your ETH balance on Arbitrum and try again.",
            raw: approveData,
          }, request, 400);
        }

        // 4. Submit deposit tx via Bankr /wallet/submit
        const depositRes = await fetch(BANKR_SUBMIT, {
          method: "POST",
          headers: bankrHeaders,
          body: JSON.stringify({
            transaction: { to: VAULT_D, chainId: CHAIN_D, value: feeWei, data: depositCalldata },
            description: `Deposit ${amount} USDC to Nexus trading account`,
            waitForConfirmation: true,
          }),
        });
        const depositData2 = await depositRes.json();
        if (!depositData2?.success) {
          return json({
            ok: false,
            step: "deposit",
            error: depositData2?.error ?? "deposit_failed",
            hint: "Approve succeeded but deposit tx failed. Ensure wallet has ~0.00001 ETH on Arbitrum for LayerZero fee.",
            approveTxHash: approveData.transactionHash,
            raw: depositData2,
          }, request, 400);
        }

        // 5. Success
        return json({
          ok: true,
          amount,
          accountId,
          approveTxHash: approveData.transactionHash,
          depositTxHash: depositData2.transactionHash,
          message: `${amount} USDC deposited to Nexus. Funds available in ~2 Arbitrum blocks (~4s).`,
        }, request);

      } catch (e) {
        return json({ error: "bankr-deposit internal error", detail: String(e) }, request, 500);
      }
    }

    // ── /proxy/vault-deposit — deposit USDC into Orderly OmniVault ──────────────
    // Contract: 0x70fe7d65ac7c1a1732f64d2e6fc0e33622d0c991 (Arbitrum One, ERC1967 proxy)
    // Flow: approve USDC → deposit((payloadType,receiver,token,amount,brokerHash)) + LZ fee
    // Selector: 0x91ccaefd  payloadType: 0 = LP (standard user)
    if (parts[0] === "proxy" && parts[1] === "vault-deposit" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletAddress, bankrApiKey, amount } = body;
      if (!walletAddress || !bankrApiKey || !amount) {
        return json({ error: "walletAddress, bankrApiKey, and amount (USDC) required" }, request, 400);
      }
      if (Number(amount) < 10) {
        return json({ error: "minimum deposit is 10 USDC", minDeposit: 10 }, request, 400);
      }

      const VAULT_V        = "0x70fe7d65ac7c1a1732f64d2e6fc0e33622d0c991";
      const USDC_V         = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
      const CHAIN_V        = 42161;
      const BANKR_SUBMIT_V = "https://api.bankr.bot/wallet/submit";
      // bytes32(0) — unattributed deposit (isAllowedBroker is yield attribution only, not a gate)
      const BROKER_HASH_V  = "0000000000000000000000000000000000000000000000000000000000000000";

      function pad32V(hex) {
        const h = hex.startsWith("0x") ? hex.slice(2) : hex;
        return h.padStart(64, "0");
      }

      const walletNormV = walletAddress.toLowerCase().trim();
      const amountBigV  = BigInt(Math.round(Number(amount) * 1_000_000)); // USDC 6 decimals

      // ── Quote exact LayerZero fee via quoteOperation(uint8,address,uint256) ─
      // Selector 0xff6072f5. All static → inline encode. Call via Alchemy eth_call.
      const quoteCd =
        "0xff6072f5" +
        pad32V("0") +                        // payloadType = 0 (LP)
        pad32V(walletNormV.slice(2)) +       // receiver
        pad32V(amountBigV.toString(16));     // amount

      let lzFeeWei = "1000000000000000"; // 0.001 ETH fallback
      try {
        const quoteRes = await fetch(getArbRpc(env), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_call",
            params: [{ to: VAULT_V, data: quoteCd }, "latest"],
          }),
        });
        const quoteData = await quoteRes.json();
        if (quoteData.result && quoteData.result !== "0x") {
          // Returns uint256 fee in wei
          lzFeeWei = BigInt(quoteData.result).toString();
        }
      } catch (_) { /* use fallback */ }

      // approve(vault, amount) — selector 0x095ea7b3
      const approveCalldataV =
        "0x095ea7b3" +
        pad32V(VAULT_V.slice(2)) +
        pad32V(amountBigV.toString(16));

      // deposit((uint8 payloadType, address receiver, address token, uint256 amount, bytes32 brokerHash))
      // All static types → encode inline, no offset pointers
      const depositCalldataV =
        "0x91ccaefd" +
        pad32V("0") +                                   // payloadType = 0 (LP)
        pad32V(walletNormV.slice(2)) +                  // receiver
        pad32V(USDC_V.toLowerCase().slice(2)) +         // token (USDC on Arbitrum)
        pad32V(amountBigV.toString(16)) +               // amount
        BROKER_HASH_V;                                  // brokerHash bytes32(0)

      const bankrHdrsV = { "X-API-Key": bankrApiKey, "Content-Type": "application/json" };

      // Step 1 — approve USDC to vault
      const approveResV = await fetch(BANKR_SUBMIT_V, {
        method: "POST",
        headers: bankrHdrsV,
        body: JSON.stringify({
          transaction: { to: USDC_V, chainId: CHAIN_V, value: "0", data: approveCalldataV },
          description: `Approve ${amount} USDC to Orderly OmniVault`,
          waitForConfirmation: true,
        }),
      });
      const approveDataV = await approveResV.json();
      if (!approveDataV?.success) {
        const isBlocked = approveResV.status === 403 || String(approveDataV?.error ?? "").includes("recipient");
        return json({
          ok: false, step: "approve",
          error: approveDataV?.error ?? "approve_failed",
          hint: isBlocked
            ? "Bankr key has allowedRecipients set — clear it at bankr.bot/api then retry."
            : "USDC approval failed. Check ETH balance on Arbitrum.",
          raw: approveDataV,
        }, request, 400);
      }

      // Step 1.5 — simulate deposit via eth_call to capture revert reason before spending gas
      try {
        const simRes = await fetch(getArbRpc(env), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 99, method: "eth_call",
            params: [{
              from: walletNormV,
              to: VAULT_V,
              data: depositCalldataV,
              value: "0x" + BigInt(lzFeeWei).toString(16),
            }, "latest"],
          }),
        });
        const simData = await simRes.json();
        if (simData.error) {
          // Decode string revert if present (0x08c379a0 prefix)
          let reason = simData.error.message || "reverted";
          const hex = simData.error.data || "";
          if (hex.startsWith("0x08c379a0")) {
            try {
              const msgHex = hex.slice(10 + 64); // skip selector + offset
              const msgLen = parseInt(hex.slice(10 + 64, 10 + 128), 16);
              // ⚠️ Was Buffer.from(...) — Buffer does NOT exist in the Workers runtime
              // (no nodejs_compat flag), so this threw every time and the empty catch
              // swallowed it: the decoded revert reason was silently never produced.
              // Found by an eslint no-undef sweep, not by any test. hexToBytes is
              // already imported; TextDecoder is a Workers global.
              const bytes = hexToBytes(msgHex.slice(64, 64 + msgLen * 2));
              reason = new TextDecoder().decode(bytes);
            } catch (_) {}
          }
          return json({
            ok: false, step: "simulate",
            revert: reason,
            revertHex: simData.error.data || null,
            lzFeeWei, lzFeeEth: (Number(lzFeeWei) / 1e18).toFixed(6),
            calldata: depositCalldataV,
            hint: "Deposit would revert on-chain. Check revert/revertHex to diagnose.",
          }, request, 400);
        }
      } catch (_) { /* simulation failed — proceed anyway */ }

      // Step 2 — deposit to vault with quoted LayerZero fee
      const depositResV = await fetch(BANKR_SUBMIT_V, {
        method: "POST",
        headers: bankrHdrsV,
        body: JSON.stringify({
          transaction: { to: VAULT_V, chainId: CHAIN_V, value: lzFeeWei, data: depositCalldataV },
          description: `Deposit ${amount} USDC into Orderly OmniVault`,
          waitForConfirmation: true,
        }),
      });
      const depositDataV = await depositResV.json();
      if (!depositDataV?.success) {
        return json({
          ok: false, step: "deposit",
          error: depositDataV?.error ?? "deposit_failed",
          hint: "Approve succeeded but deposit failed. Wallet needs ~0.00001 ETH for LayerZero fee. If fee error, try increasing payable ETH.",
          approveTxHash: approveDataV.txHash || approveDataV.transactionHash,
          raw: depositDataV,
        }, request, 400);
      }

      return json({
        ok: true,
        amount,
        lzFeeWei,
        lzFeeEth: (Number(lzFeeWei) / 1e18).toFixed(6),
        approveTxHash: approveDataV.txHash || approveDataV.transactionHash,
        depositTxHash: depositDataV.txHash || depositDataV.transactionHash,
        hint: "Deposited to Orderly OmniVault. 2-day lockup from start of current vault period (3-hour periods). Track at https://app.orderly.network/vaults",
      }, request);
    }

    // ── /set-leverage — set account-level max leverage ──────────────────────────
    // POST { walletAddress, walletSig, leverage }
    // leverage: integer 1–100. Sets the account-wide max leverage on Orderly.
    if (parts[0] === "set-leverage" && request.method === "POST") {
      let slbody; try { slbody = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletAddress: slwa, walletSig: slws, leverage: slev } = slbody;
      if (!slwa || !slws || slev == null) return json({ error: "walletSig_required", hint: "POST { walletAddress, walletSig, leverage }" }, request, 401);
      if (typeof slev !== "number" || slev < 1 || slev > 100) return json({ error: "leverage must be a number between 1 and 100" }, request, 400);
      const slNorm = slwa.toLowerCase().trim();
      const slRaw  = await env.LAB_STORE.get("user:" + slNorm);
      if (!slRaw) return json({ error: "wallet_not_registered" }, request, 401);
      const slrec  = JSON.parse(slRaw);
      const SLHDR  = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      const slhex  = slws.startsWith("0x") ? slws.slice(2) : slws;
      const slseed = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(slhex.match(/.{1,2}/g).map(b => parseInt(b, 16)))));
      const slpk8  = new Uint8Array(48); slpk8.set(SLHDR, 0); slpk8.set(slseed, 16);
      const slsk   = await crypto.subtle.importKey("pkcs8", slpk8, { name: "Ed25519" }, false, ["sign"]);
      const slsign = async (method, path, bodyObj) => {
        const ts  = Date.now();
        const bs  = bodyObj ? JSON.stringify(bodyObj) : "";
        const msg = new TextEncoder().encode(ts + method + path + bs);
        const s   = new Uint8Array(await crypto.subtle.sign("Ed25519", slsk, msg));
        const b64 = btoa(String.fromCharCode(...s)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
        return { "Content-Type": "application/json", "orderly-timestamp": String(ts), "orderly-account-id": slrec.accountId, "orderly-key": slrec.orderlyKey, "orderly-signature": b64 };
      };
      const levBody = { leverage: slev };
      const slHdrs = await slsign("POST", "/v1/client/leverage", levBody);
      const slRes  = await fetch("https://api-evm.orderly.org/v1/client/leverage", {
        method: "POST", headers: slHdrs,
        body: JSON.stringify(levBody),
      });
      const slData = await slRes.json();
      return json({
        ok: slData?.success ?? false,
        leverage: slev,
        raw: slData,
      }, request);
    }

        // ── /settle-pnl — settle unrealized PnL so it clears margin for withdrawal ──
    // POST { walletAddress, walletSig, symbol? }
    // symbol is optional — omit to settle all positions, or pass e.g. "SOL" to settle one.
    // Must be called before withdrawing if unsettled_pnl is negative (code 78).
    // After calling, wait ~5s for Orderly to process, then retry withdrawal.
    if (parts[0] === "settle-pnl" && request.method === "POST") {
      let spbody; try { spbody = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletAddress: spwa, walletSig: spws, symbol: spsym } = spbody;
      if (!spwa || !spws) return json({ error: "walletSig_required", hint: "POST { walletAddress, walletSig, symbol? }" }, request, 401);
      const spNorm = spwa.toLowerCase().trim();
      const spRaw  = await env.LAB_STORE.get("user:" + spNorm);
      if (!spRaw) return json({ error: "wallet_not_registered" }, request, 401);
      const sprec  = JSON.parse(spRaw);
      const SPHDR  = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      const sphex  = spws.startsWith("0x") ? spws.slice(2) : spws;
      const spseed = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(sphex.match(/.{1,2}/g).map(b => parseInt(b, 16)))));
      const sppk8  = new Uint8Array(48); sppk8.set(SPHDR, 0); sppk8.set(spseed, 16);
      const spsk   = await crypto.subtle.importKey("pkcs8", sppk8, { name: "Ed25519" }, false, ["sign"]);
      const spsign = async (method, path, bodyObj) => {
        const ts  = Date.now();
        const bs  = bodyObj ? JSON.stringify(bodyObj) : "";
        const msg = new TextEncoder().encode(ts + method + path + bs);
        const s   = new Uint8Array(await crypto.subtle.sign("Ed25519", spsk, msg));
        const b64 = btoa(String.fromCharCode(...s)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
        return { "Content-Type": "application/json", "orderly-timestamp": String(ts), "orderly-account-id": sprec.accountId, "orderly-key": sprec.orderlyKey, "orderly-signature": b64 };
      };
      // Optionally scope to a single symbol
      const settleBody = spsym
        ? { symbol: spsym.toUpperCase().startsWith("PERP_") ? spsym.toUpperCase() : "PERP_" + spsym.toUpperCase() + "_USDC" }
        : {};
      const spHdrs = await spsign("POST", "/v1/settle_pnl", settleBody);
      const spRes  = await fetch("https://api-evm.orderly.org/v1/settle_pnl", {
        method: "POST", headers: spHdrs,
        body: JSON.stringify(settleBody),
      });
      const spData = await spRes.json();
      return json({
        ok: spData?.success ?? false,
        settled: spData?.success ?? false,
        symbol: spsym ?? "all",
        hint: spData?.success
          ? "PnL settled. Wait ~5 seconds then retry withdrawal with free_collateral amount."
          : "Settlement request sent — Orderly processes async. Wait 5-10s then check /balance before withdrawing.",
        raw: spData,
      }, request);
    }

    // ── /proxy/bankr-withdraw — server-side withdrawal via Bankr Wallet API ────
    // Flow: get nonce → EIP-712 Withdraw → Bankr eth_signTypedData_v4 → POST /v1/withdraw_request
    // Bankr API key is only used transiently — never stored.
    if (parts[0] === "proxy" && parts[1] === "bankr-withdraw" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletAddress, bankrApiKey, amount } = body;
      if (!walletAddress || !bankrApiKey || !amount) {
        return json({ error: "walletAddress, bankrApiKey, and amount (USDC) required" }, request, 400);
      }
      try {
        const walletNorm = walletAddress.toLowerCase().trim();
        const ORDERLY_BASE_W = "https://api-evm.orderly.org";
        const BANKR_API_W    = "https://api.bankr.bot";
        const BROKER_W       = "nexus_trading";
        const CHAIN_W        = 42161;
        const VC_W           = "0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203"; // Orderly mainnet verifyingContract (mainnetVerifyAddress)
        const HDR_W          = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);

        // 1. Derive ed25519 key from Bankr personal_sign (for Orderly REST auth)
        const sigRes = await fetch(`${BANKR_API_W}/wallet/sign`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": bankrApiKey },
          body: JSON.stringify({ signatureType: "personal_sign", message: "nexus-trading-key-v1" }),
        });
        if (!sigRes.ok) return json({ error: "Bankr personal_sign HTTP error", status: sigRes.status, body: await sigRes.text() }, request, 502);
        const sigData = await sigRes.json();
        if (!sigData.signature) return json({ error: "Bankr personal_sign returned no signature", detail: sigData }, request, 502);
        const sHex  = sigData.signature.startsWith("0x") ? sigData.signature.slice(2) : sigData.signature;
        const seed  = new Uint8Array(await crypto.subtle.digest("SHA-256",
          new Uint8Array(sHex.match(/.{2}/g).map(b => parseInt(b, 16)))));
        const pk8   = new Uint8Array(48); pk8.set(HDR_W, 0); pk8.set(seed, 16);
        const sk    = await crypto.subtle.importKey("pkcs8", pk8, { name: "Ed25519" }, false, ["sign"]);

        // Orderly REST signing helper
        const userRaw = await env.LAB_STORE.get("user:" + walletNorm);
        if (!userRaw) return json({ error: "wallet_not_registered" }, request, 401);
        const urec = JSON.parse(userRaw);
        const oSign = async (method, path, bodyStr) => {
          const ts  = Date.now();
          const msg = new TextEncoder().encode(ts + method.toUpperCase() + path + (bodyStr || ""));
          const sb  = new Uint8Array(await crypto.subtle.sign("Ed25519", sk, msg));
          const b64 = btoa(String.fromCharCode(...sb)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
          return { "Content-Type": "application/json", "orderly-timestamp": String(ts),
            "orderly-account-id": urec.accountId, "orderly-key": urec.orderlyKey, "orderly-signature": b64 };
        };
        const oReq = async (method, path, data) => {
          const bs   = data ? JSON.stringify(data) : undefined;
          const hdrs = await oSign(method, path, bs);
          const res  = await fetch(ORDERLY_BASE_W + path, { method, headers: hdrs, body: bs });
          return res.json();
        };

        // 2. Get withdrawal nonce
        const nonceData = await oReq("GET", "/v1/withdraw_nonce", null);
        const withdrawNonce = nonceData?.data?.withdraw_nonce;
        if (!withdrawNonce && withdrawNonce !== 0) {
          return json({ error: "failed to get withdraw nonce", detail: nonceData }, request, 502);
        }

        // 3. Build EIP-712 Withdraw message
        const ts2 = Date.now();
        const amountUnits = Math.round(Number(amount) * 1e6); // USDC 6 decimals
        const withdrawMsg = {
          brokerId: BROKER_W,
          chainId: CHAIN_W,
          receiver: walletNorm,
          token: "USDC",
          amount: amountUnits,           // uint256 — must be number, not string
          withdrawNonce: Number(withdrawNonce),
          timestamp: ts2,
        };
        const typedData = {
          types: {
            EIP712Domain: [
              { name: "name", type: "string" }, { name: "version", type: "string" },
              { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
            ],
            Withdraw: [
              { name: "brokerId", type: "string" }, { name: "chainId", type: "uint256" },
              { name: "receiver", type: "address" }, { name: "token", type: "string" },
              { name: "amount", type: "uint256" }, { name: "withdrawNonce", type: "uint64" },
              { name: "timestamp", type: "uint64" },
            ],
          },
          primaryType: "Withdraw",
          domain: { name: "Orderly", version: "1", chainId: CHAIN_W, verifyingContract: VC_W },
          message: withdrawMsg,
        };

        // 4. EIP-712 sign via Bankr
        const wSignRes = await fetch(`${BANKR_API_W}/wallet/sign`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": bankrApiKey },
          body: JSON.stringify({ signatureType: "eth_signTypedData_v4", typedData }),
        });
        if (!wSignRes.ok) return json({ error: "Bankr EIP-712 HTTP error", status: wSignRes.status, body: await wSignRes.text() }, request, 502);
        const wSignData = await wSignRes.json();
        if (!wSignData.signature) return json({ error: "Bankr EIP-712 sign returned no signature", detail: wSignData }, request, 502);

        // 5. Submit withdrawal request to Orderly
        // verifyingContract IS required in the POST body (Orderly error -1005 if missing)
        let withdrawRes = await oReq("POST", "/v1/withdraw_request", {
          message: withdrawMsg,
          signature: wSignData.signature,
          userAddress: walletNorm,
          verifyingContract: VC_W,
        });

        // Auto-handle code 78 (margin occupied by unsettled PnL):
        // settle all positions, wait 4s, fetch free_collateral, retry with safe amount.
        const code78 = withdrawRes?.code === 78 || String(withdrawRes?.message ?? "").includes("occupied");
        if (code78) {
          // Settle PnL
          await oReq("POST", "/v1/settle_pnl", {});
          // Wait for Orderly to process (~4s)
          await new Promise(r => setTimeout(r, 4000));
          // Fetch free_collateral
          const holdingRes = await oReq("GET", "/v1/client/holding", null);
          const holdings   = holdingRes?.data?.holding ?? [];
          const usdcRow    = holdings.find(h => h.token === "USDC");
          const freeCol    = Number(usdcRow?.holding ?? usdcRow?.available ?? 0);
          // Leave 0.5 USDC buffer; cap at original requested amount
          const safeAmount = Math.min(Number(amount), Math.max(0, freeCol - 0.5));
          if (safeAmount <= 0) {
            return json({ ok: false, error: "insufficient_free_collateral", freeCollateral: freeCol,
              hint: "After settlement, free collateral is too low to withdraw. Wait for the daily Orderly settlement cycle or close open positions." }, request, 400);
          }
          const safeUnits = Math.round(safeAmount * 1e6);
          // Rebuild message with safe amount + fresh nonce
          const nonceData2 = await oReq("GET", "/v1/withdraw_nonce", null);
          const nonce2 = nonceData2?.data?.withdraw_nonce;
          const ts3    = Date.now();
          const msg2   = { brokerId: BROKER_W, chainId: CHAIN_W, receiver: walletNorm, token: "USDC",
            amount: safeUnits, withdrawNonce: Number(nonce2), timestamp: ts3 };
          const td2    = { ...typedData, message: msg2 };
          const sig2Res = await fetch(`${BANKR_API_W}/wallet/sign`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": bankrApiKey },
            body: JSON.stringify({ signatureType: "eth_signTypedData_v4", typedData: td2 }),
          });
          const sig2Data = await sig2Res.json();
          if (!sig2Data.signature) return json({ error: "re-sign after settle failed", detail: sig2Data }, request, 502);
          withdrawRes = await oReq("POST", "/v1/withdraw_request", {
            message: msg2, signature: sig2Data.signature, userAddress: walletNorm, verifyingContract: VC_W,
          });
          return json({
            ok: withdrawRes?.success ?? false,
            autoSettled: true,
            originalAmount: amount,
            withdrawnAmount: safeAmount,
            freeCollateral: freeCol,
            hint: safeAmount < Number(amount) ? `Withdrew ${safeAmount} USDC (adjusted from ${amount} to account for unsettled PnL of ~${(freeCol - safeAmount).toFixed(2)} USDC)` : undefined,
            raw: withdrawRes,
          }, request);
        }

        return json({
          ok: withdrawRes?.success ?? false,
          walletAddress: walletNorm,
          amount,
          amountUnits,
          withdrawNonce,
          raw: withdrawRes,
        }, request);
      } catch (e) {
        return json({ error: "bankr-withdraw internal error", detail: String(e), stack: e?.stack }, request, 500);
      }
    }

    // ── /withdraw/prepare + /withdraw/submit — miniapp withdrawal (frame wallet signs) ──
    // Same Orderly flow as /proxy/bankr-withdraw, but the frame EOA signs the Withdraw
    // EIP-712 CLIENT-SIDE (we never hold its key). prepare → returns typedData to sign;
    // submit → relays {message,signature} to Orderly. settle:true settles PnL first
    // (code-78 fix) and recomputes a safe amount from free_collateral.
    if (parts[0] === "withdraw" && (parts[1] === "prepare" || parts[1] === "submit") && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletSig, walletAddress } = body;
      if (!walletSig || !walletAddress) return json({ error: "walletSig and walletAddress required" }, request, 400);
      try {
        const walletNorm = walletAddress.toLowerCase().trim();
        const ORDERLY_BASE_W = "https://api-evm.orderly.org";
        const BROKER_W = "nexus_trading";
        const CHAIN_W  = 42161;
        const VC_W     = "0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203"; // Orderly mainnet verifyingContract (Withdraw)
        const HDR_W    = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);

        // Derive the ed25519 trading key from the frame wallet's personal_sig (Orderly REST auth).
        const sHex = walletSig.startsWith("0x") ? walletSig.slice(2) : walletSig;
        const seed = new Uint8Array(await crypto.subtle.digest("SHA-256",
          new Uint8Array(sHex.match(/.{2}/g).map(b => parseInt(b, 16)))));
        const pk8  = new Uint8Array(48); pk8.set(HDR_W, 0); pk8.set(seed, 16);
        const sk   = await crypto.subtle.importKey("pkcs8", pk8, { name: "Ed25519" }, false, ["sign"]);

        const userRaw = await env.LAB_STORE.get("user:" + walletNorm);
        if (!userRaw) return json({ error: "wallet_not_registered" }, request, 401);
        const urec = JSON.parse(userRaw);
        const oReq = async (method, path, data) => {
          const bs  = data ? JSON.stringify(data) : undefined;
          const ts  = Date.now();
          const m   = new TextEncoder().encode(ts + method.toUpperCase() + path + (bs || ""));
          const sb  = new Uint8Array(await crypto.subtle.sign("Ed25519", sk, m));
          const b64 = btoa(String.fromCharCode(...sb)).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
          const hdrs = { "Content-Type": "application/json", "orderly-timestamp": String(ts),
            "orderly-account-id": urec.accountId, "orderly-key": urec.orderlyKey, "orderly-signature": b64 };
          const res = await fetch(ORDERLY_BASE_W + path, { method, headers: hdrs, body: bs });
          return res.json();
        };
        const buildTyped = (message) => ({
          types: {
            EIP712Domain: [
              { name: "name", type: "string" }, { name: "version", type: "string" },
              { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
            ],
            Withdraw: [
              { name: "brokerId", type: "string" }, { name: "chainId", type: "uint256" },
              { name: "receiver", type: "address" }, { name: "token", type: "string" },
              { name: "amount", type: "uint256" }, { name: "withdrawNonce", type: "uint64" },
              { name: "timestamp", type: "uint64" },
            ],
          },
          primaryType: "Withdraw",
          domain: { name: "Orderly", version: "1", chainId: CHAIN_W, verifyingContract: VC_W },
          message,
        });

        if (parts[1] === "prepare") {
          const { amount, settle } = body;
          if (!amount || Number(amount) <= 0) return json({ error: "amount (USDC) required" }, request, 400);
          let effAmount = Number(amount);
          if (settle) {
            await oReq("POST", "/v1/settle_pnl", {});
            await new Promise(r => setTimeout(r, 4000));
            const holdingRes = await oReq("GET", "/v1/client/holding", null);
            const usdcRow = (holdingRes?.data?.holding ?? []).find(h => h.token === "USDC");
            const freeCol = Number(usdcRow?.holding ?? usdcRow?.available ?? 0);
            effAmount = Math.min(Number(amount), Math.max(0, freeCol - 0.5));
            if (effAmount <= 0) return json({ ok: false, error: "insufficient_free_collateral", freeCollateral: freeCol,
              hint: "Free collateral too low to withdraw after settlement. Close positions or wait for the daily settlement cycle." }, request, 400);
          }
          const nonceData = await oReq("GET", "/v1/withdraw_nonce", null);
          const withdrawNonce = nonceData?.data?.withdraw_nonce;
          if (withdrawNonce == null) return json({ error: "failed to get withdraw nonce", detail: nonceData }, request, 502);
          const message = { brokerId: BROKER_W, chainId: CHAIN_W, receiver: walletNorm, token: "USDC",
            amount: Math.round(effAmount * 1e6), withdrawNonce: Number(withdrawNonce), timestamp: Date.now() };
          return json({ typedData: buildTyped(message), message, amount: effAmount, verifyingContract: VC_W }, request);
        }

        // submit
        const { message, signature } = body;
        if (!message || !signature) return json({ error: "message and signature required" }, request, 400);
        // Guard: the signed receiver must be the caller's own wallet (no redirecting funds).
        if (String(message.receiver).toLowerCase() !== walletNorm) {
          return json({ error: "receiver_mismatch", hint: "Withdrawal receiver must equal your wallet address." }, request, 400);
        }
        // Request-bound (v2) auth — withdraw is the highest-blast-radius action, so it's
        // the first route gated (Phase 2 of #14). No-op unless AUTH_V2 is enabled. Binds the
        // single-use challenge to action+wallet (+amount if the client included one), so a
        // leaked static walletSig can't replay a withdrawal. Enforced on submit (the money move).
        {
          const denied = await requireOwnerV2(env, request, {
            action: "withdraw", wallet: walletNorm,
            amount: body.amount != null ? String(body.amount) : undefined,
            nonce: body.nonce, v2Sig: body.v2Sig,
          });
          if (denied) return denied;
        }
        const withdrawRes = await oReq("POST", "/v1/withdraw_request", {
          message, signature, userAddress: walletNorm, verifyingContract: VC_W,
        });
        const code78 = withdrawRes?.code === 78 || String(withdrawRes?.message ?? "").includes("occupied");
        if (code78) {
          return json({ ok: false, code: 78, needsSettle: true,
            hint: "Unsettled PnL is occupying margin. Re-run /withdraw/prepare with settle:true, re-sign, and resubmit." }, request);
        }
        return json({ ok: withdrawRes?.success ?? false, raw: withdrawRes }, request);
      } catch (e) {
        return json({ error: "withdraw internal error", detail: String(e) }, request, 500);
      }
    }

    // ── /proxy/bankr-register — fully server-side onboarding via Bankr Wallet API ──
    // Flow: check account → deposit if new → personal_sign → derive ed25519 → EIP-712 → register → KV
    // depositAmount defaults to 5 USDC. key is used transiently, never stored.
    if (parts[0] === "proxy" && parts[1] === "bankr-register" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }

      const { walletAddress, bankrApiKey } = body;
      if (!walletAddress || !bankrApiKey) {
        return json({ error: "walletAddress and bankrApiKey required" }, request, 400);
      }

      const walletNorm   = walletAddress.toLowerCase().trim();
      const ORDERLY_BASE = "https://api-evm.orderly.org";
      const BANKR_API    = "https://api.bankr.bot";
      const BROKER       = "nexus_trading";
      const CHAIN        = 42161;
      const VC           = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
      const HDR          = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
      const B58C         = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

      try {
        // ── Check if Orderly account exists ──
        let accountId = null;
        try {
          const ar = await fetch(`${ORDERLY_BASE}/v1/get_account?address=${walletNorm}&broker_id=${BROKER}`);
          accountId = (await ar.json())?.data?.account_id ?? null;
        } catch (_) {}

        // ── No account: register via REST (no on-chain tx needed) ──
        if (!accountId) {
          // Step A: Get registration nonce
          const nonceRes  = await fetch(`${ORDERLY_BASE}/v1/registration_nonce`);
          const nonceData = await nonceRes.json();
          const registrationNonce = nonceData?.data?.registration_nonce;
          if (!registrationNonce) {
            return json({ error: "Failed to get registration nonce", detail: nonceData }, request, 500);
          }

          // Step B: EIP-712 sign the Registration typed data
          const regTs  = Date.now();
          const regMsg = { brokerId: BROKER, chainId: CHAIN, timestamp: regTs, registrationNonce: String(registrationNonce) };
          const regTypedData = {
            types: {
              EIP712Domain: [
                { name: "name",              type: "string"  },
                { name: "version",           type: "string"  },
                { name: "chainId",           type: "uint256" },
                { name: "verifyingContract", type: "address" },
              ],
              Registration: [
                { name: "brokerId",           type: "string"  },
                { name: "chainId",            type: "uint256" },
                { name: "timestamp",          type: "uint64"  },
                { name: "registrationNonce",  type: "uint256" },
              ],
            },
            primaryType: "Registration",
            domain: { name: "Orderly", version: "1", chainId: CHAIN, verifyingContract: VC },
            message: regMsg,
          };
          const regSignRes  = await fetch(`${BANKR_API}/wallet/sign`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": bankrApiKey },
            body: JSON.stringify({ signatureType: "eth_signTypedData_v4", typedData: regTypedData }),
          });
          const regSignData = await regSignRes.json();
          if (!regSignData.success || !regSignData.signature) {
            return json({ error: "Bankr Registration EIP-712 sign failed", detail: regSignData }, request, 400);
          }

          // Step C: Register account with Orderly
          const acctRes  = await fetch(`${ORDERLY_BASE}/v1/register_account`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: regMsg, signature: regSignData.signature, userAddress: walletNorm }),
          });
          const acctData = await acctRes.json();
          if (!acctData.success && !acctData.data?.account_id) {
            return json({ error: "Orderly account registration failed", detail: acctData }, request, 400);
          }
          accountId = acctData?.data?.account_id ?? null;
        }

        // ── personal_sign → derive ed25519 key ──
        const s1 = await fetch(`${BANKR_API}/wallet/sign`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": bankrApiKey },
          body: JSON.stringify({ signatureType: "personal_sign", message: "nexus-trading-key-v1" }),
        });
        const d1 = await s1.json();
        if (!d1.success || !d1.signature) {
          return json({ error: "Bankr personal_sign failed", detail: d1, hint: "Ensure Wallet & Agent API is enabled at bankr.bot/api" }, request, 400);
        }
        if (d1.signer && d1.signer.toLowerCase() !== walletNorm) {
          return json({ error: "Signer mismatch", expected: walletNorm, got: d1.signer.toLowerCase() }, request, 400);
        }

        const sigHex = d1.signature.startsWith("0x") ? d1.signature.slice(2) : d1.signature;
        const seed   = new Uint8Array(await crypto.subtle.digest("SHA-256",
          new Uint8Array(sigHex.match(/.{2}/g).map(b => parseInt(b, 16)))));
        const pk8    = new Uint8Array(48); pk8.set(HDR, 0); pk8.set(seed, 16);
        const priv   = await crypto.subtle.importKey("pkcs8", pk8, { name: "Ed25519" }, true, ["sign"]);
        const jwk    = await crypto.subtle.exportKey("jwk", priv);
        const rawPub = Uint8Array.from(atob(jwk.x.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
        let n = BigInt("0x" + [...rawPub].map(b => b.toString(16).padStart(2,"0")).join(""));
        let b58 = ""; while (n > 0n) { b58 = B58C[Number(n%58n)] + b58; n = n/58n; }
        for (const b of rawPub) { if (b === 0) b58 = "1" + b58; else break; }
        const orderlyKey = "ed25519:" + b58;

        // ── EIP-712 typed data for Orderly key registration ──
        const ts  = Date.now();
        const exp = ts + 365 * 24 * 60 * 60 * 1000;
        const msg = { brokerId: BROKER, chainId: CHAIN, orderlyKey, scope: "read,trading", timestamp: ts, expiration: exp };
        const typedData = {
          types: {
            EIP712Domain: [
              { name: "name",              type: "string"  },
              { name: "version",           type: "string"  },
              { name: "chainId",           type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            AddOrderlyKey: [
              { name: "brokerId",   type: "string"  },
              { name: "chainId",    type: "uint256" },
              { name: "orderlyKey", type: "string"  },
              { name: "scope",      type: "string"  },
              { name: "timestamp",  type: "uint64"  },
              { name: "expiration", type: "uint64"  },
            ],
          },
          primaryType: "AddOrderlyKey",
          domain: { name: "Orderly", version: "1", chainId: CHAIN, verifyingContract: VC },
          message: msg,
        };

        // ── EIP-712 sign via Bankr ──
        const s2 = await fetch(`${BANKR_API}/wallet/sign`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": bankrApiKey },
          body: JSON.stringify({ signatureType: "eth_signTypedData_v4", typedData }),
        });
        const d2 = await s2.json();
        if (!d2.success || !d2.signature) {
          return json({
            error: "Bankr EIP-712 sign failed", detail: d2,
            hint: "API key may have 'allowed recipients' restrictions blocking EIP-712 — generate a clean key at bankr.bot/api",
          }, request, 400);
        }

        // ── Register key with Orderly ──
        const rh = { "Content-Type": "application/json" };
        if (accountId) rh["X-Account-Id"] = accountId;
        const regRes  = await fetch(`${ORDERLY_BASE}/v1/orderly_key`, {
          method: "POST", headers: rh,
          body: JSON.stringify({ message: msg, signature: d2.signature, userAddress: walletNorm, orderlyKey }),
        });
        const regData = await regRes.json();
        if (!accountId) accountId = regData?.data?.account_id ?? null;

        // ── Store in KV ──
        if (regData.success || regData.data) {
          const _regSeedHex = [...seed].map(b => b.toString(16).padStart(2,"0")).join("");
          await env.LAB_STORE.put("user:" + walletNorm, JSON.stringify({
            accountId, orderlyKey, seed: _regSeedHex, registeredAt: Date.now(),
          }));
          return json({ ok: true, walletAddress: walletNorm, orderlyKey, accountId }, request);
        } else {
          return json({ error: "Orderly registration failed", detail: regData }, request, 400);
        }
      } catch (e) {
        return json({ error: "registration failed", detail: String(e) }, request, 500);
      }
    }

    // ── /proxy/registration-nonce — GET Orderly registration nonce (CORS proxy) ──
    if (parts[0] === "proxy" && parts[1] === "registration-nonce" && request.method === "GET") {
      try {
        const r = await fetch("https://api-evm.orderly.org/v1/registration_nonce");
        const d = await r.json();
        return new Response(JSON.stringify(d), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }
    }

    // ── /proxy/register-account — create an Orderly account (browser-signed EIP-712 Registration) ──
    if (parts[0] === "proxy" && parts[1] === "register-account" && request.method === "POST") {
      let rb;
      try { rb = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      try {
        const r = await fetch("https://api-evm.orderly.org/v1/register_account", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rb),
        });
        const d = await r.json();
        return new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }
    }

    // ── /proxy/register-key — server-side proxy to Orderly (multi-user) ──────────
    if (parts[0] === "proxy" && parts[1] === "register-key" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { userAddress, orderlyKey: userOrderlyKey } = body;
      const walletNorm = userAddress ? userAddress.toLowerCase().trim() : null;
      try {
        let accountId = null;
        if (walletNorm) {
          try {
            const ar = await fetch("https://api-evm.orderly.org/v1/get_account?address=" + walletNorm + "&broker_id=nexus_trading");
            accountId = (await ar.json())?.data?.account_id ?? null;
          } catch (_) {}
        }
        const rh = { "Content-Type": "application/json" };
        if (accountId) rh["X-Account-Id"] = accountId;
        const r = await fetch("https://api-evm.orderly.org/v1/orderly_key", {
          method: "POST", headers: rh, body: JSON.stringify(body),
        });
        const d = await r.json();
        if (!accountId) accountId = d?.data?.account_id ?? null;
        if ((d.success || d.data) && walletNorm && accountId && userOrderlyKey) {
          await env.LAB_STORE.put("user:" + walletNorm, JSON.stringify({
            accountId, orderlyKey: userOrderlyKey, registeredAt: Date.now(),
          }));
        }
        return new Response(JSON.stringify({ ...d, accountId }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ── /register-orderly-key — deterministic wallet registration ───────────────
    // Flow: personal_sign("nexus-trading-key-v1") -> /derive-key -> EIP-712 sign -> /proxy/register-key
    // No private keys stored anywhere. Same wallet = same trading key every session.
    if (parts[0] === "register-orderly-key" && request.method === "GET") {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nexus - Connect Trading Wallet</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{max-width:560px;width:100%}
h1{color:#00ff88;font-size:1.1rem;letter-spacing:2px;margin-bottom:6px}
p.sub{color:#555;font-size:.75rem;margin-bottom:24px;line-height:1.7}
button{width:100%;background:#00ff88;color:#000;border:none;padding:14px;border-radius:6px;font-family:monospace;font-size:.9rem;font-weight:bold;cursor:pointer;margin:8px 0;letter-spacing:1px}
button:disabled{opacity:.3;cursor:not-allowed}
.status{padding:13px 16px;border-radius:6px;font-size:.82rem;margin:10px 0;line-height:1.7}
.ok{background:#001a0e;border:1px solid #00ff88;color:#00ff88}
.err{background:#1a0000;border:1px solid #ff4444;color:#ff4444}
.info{background:#0a0d1a;border:1px solid #2a4a7f;color:#7ab3ff}
</style>
</head>
<body>
<div class="wrap">
  <h1>NEXUS - CONNECT TRADING WALLET</h1>
  <p class="sub">Links your wallet to Nexus via Orderly Network.<br>
  Two MetaMask prompts. No private keys stored anywhere.<br>
  Same wallet always derives the same trading key.</p>
  <button id="btn">Connect MetaMask &amp; Register</button>
  <div id="out"></div>
</div>
<script>
const BROKER = "nexus_trading", CHAIN = 42161;
const VC = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
const MSG = "nexus-trading-key-v1";
function st(h,c){document.getElementById("out").innerHTML='<div class="status '+c+'">'+h+'</div>';}
async function go(){
  const btn=document.getElementById("btn");
  btn.disabled=true;
  try{
    if(!window.ethereum) throw new Error("MetaMask not found.");
    st("Step 1 / 3 - Connecting wallet...","info");
    const [wallet] = await ethereum.request({method:"eth_requestAccounts"});
    try{await ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:"0xa4b1"}]});}catch(_){}

    st("Step 2 / 3 - Sign to derive your trading key (MetaMask)...","info");
    const deriveSig = await ethereum.request({method:"personal_sign",params:[MSG,wallet]});
    const dk = await (await fetch("/derive-key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({walletSig:deriveSig})})).json();
    if(!dk.orderlyKey) throw new Error("Derivation failed: "+JSON.stringify(dk));
    const ok = dk.orderlyKey;

    st("Step 3 / 3 - Register key with Orderly (MetaMask)...","info");
    const ts=Date.now(), exp=ts+365*24*60*60*1000;
    const msg={brokerId:BROKER,chainId:CHAIN,orderlyKey:ok,scope:"read,trading",timestamp:ts,expiration:exp};
    const td={
      types:{
        EIP712Domain:[{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}],
        AddOrderlyKey:[{name:"brokerId",type:"string"},{name:"chainId",type:"uint256"},{name:"orderlyKey",type:"string"},{name:"scope",type:"string"},{name:"timestamp",type:"uint64"},{name:"expiration",type:"uint64"}]
      },
      primaryType:"AddOrderlyKey",
      domain:{name:"Orderly",version:"1",chainId:CHAIN,verifyingContract:VC},
      message:msg
    };
    const sig = await ethereum.request({method:"eth_signTypedData_v4",params:[wallet,JSON.stringify(td)]});
    const res = await (await fetch("/proxy/register-key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg,signature:sig,userAddress:wallet,orderlyKey:ok})})).json();
    console.log("Orderly:",res);
    if(res.success||res.data){
      st("Wallet connected to Nexus!<br><br>Wallet: <b>"+wallet+"</b><br>Key: <b>"+ok.slice(0,30)+"...</b><br><br>Open Bankr terminal in wallet mode, install the Nexus skill, and start trading.","ok");
      btn.textContent="Registered";
    } else {
      throw new Error(JSON.stringify(res));
    }
  }catch(e){
    st("Error: "+e.message,"err");
    btn.disabled=false; btn.textContent="Retry";
  }
}
document.getElementById("btn").addEventListener("click",go);
</script>
</body>
</html>`;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html;charset=UTF-8", "Access-Control-Allow-Origin": "*" } });
    }

    // ── POST /agent/backtest/sweep — rank a grid of configs (PRO) ────────────
    // Fetches each symbol's data once, runs ~27 mode×threshold×exit variants, and
    // returns them ranked by net P&L — the terminal sweep, in-app.
    if (parts[0] === "agent" && parts[1] === "backtest" && parts[2] === "sweep" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { config, walletSig } = body || {};
      const caller = typeof walletSig === "string" ? recoverEthAddress("nexus-trading-key-v1", walletSig) : null;
      if (!caller) return json({ error: "walletSig_required", hint: "Backtesting requires walletSig = sign_message('nexus-trading-key-v1')." }, request, 401);
      if (!(await walletIsPro(caller, env))) return json({ error: "pro_backtest_locked", hint: "Strategy backtesting is a Nexus PRO feature — hold ARCHITECT-tier $NEXUS or subscribe." }, request, 402);
      const symbols = (Array.isArray(config?.symbols) && config.symbols.length ? config.symbols : ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC"]).slice(0, 3);
      const days = Math.min(90, Math.max(7, Number(body.days) || 60));
      try {
        // Fold CONFLUENCE / OI_ONLY into the discovery grid only once recorded OI is
        // deep enough; until then the sweep stays funding/price-only (still honest).
        const oi = await loadOiHistForBacktest(symbols, env);
        const sweep = await runSweep(config || {}, { symbols, days }, oi.oiMature ? oi.oiHistBySymbol : {});
        return json({ ...sweep, oiTested: oi.oiMature, oiCoverage: oi.gate }, request);
      } catch (e) {
        console.error("[sweep] error:", e);
        return json({ error: "sweep failed", detail: String(e.message || e) }, request, 500);
      }
    }

    // ── POST /agent/validate — WALK-FORWARD robustness verdict (PRO) ─────────
    // The honest layer over backtest: replays the config across a DIVERSE symbol
    // universe AND multiple time folds, and returns ROBUST / FRAGILE / NOT_ROBUST.
    // This is the "verify, don't trust" test — an edge that only works on one symbol
    // in one window is NOT_ROBUST here, by design. PRO-gated (same as backtest).
    if (parts[0] === "agent" && parts[1] === "validate" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { config, walletSig } = body || {};
      if (!config || typeof config !== "object") return json({ error: "config required" }, request, 400);
      const caller = typeof walletSig === "string" ? recoverEthAddress("nexus-trading-key-v1", walletSig) : null;
      if (!caller) return json({ error: "walletSig_required", hint: "Validation requires walletSig = sign_message('nexus-trading-key-v1')." }, request, 401);
      if (!(await walletIsPro(caller, env))) return json({ error: "pro_validate_locked", hint: "Walk-forward validation is a Nexus PRO feature — hold ARCHITECT-tier $NEXUS or subscribe." }, request, 402);
      // Fixed diverse universe (cross-market breadth is the whole point) — capped so it
      // fits a Worker's subrequest budget. Cross-time via folds.
      const UNIVERSE = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_BNB_USDC", "PERP_XRP_USDC", "PERP_LINK_USDC"];
      const days = Math.min(90, Math.max(28, Number(body.days) || 60));
      const folds = Math.min(6, Math.max(3, Number(body.folds) || 4));
      const needsOi = ["CONFLUENCE", "OI_ONLY"].includes(config.signalMode);
      const oi = needsOi ? await loadOiHistForBacktest(UNIVERSE, env) : null;
      const untestable = needsOi && !oi.oiMature;
      try {
        const result = await walkForwardValidate(config, { symbols: UNIVERSE, days, folds }, oi?.oiMature ? oi.oiHistBySymbol : {});
        return json({
          ...result, untestable,
          note: untestable
            ? `${config.signalMode} needs recorded OI history to validate — still maturing (${oi.gate.minDays}/${OI_BACKTEST_MIN_DAYS}d). Validate MOMENTUM / MEAN_REVERSION / FUNDING_ONLY meanwhile.`
            : null,
        }, request);
      } catch (e) {
        console.error("[validate] error:", e);
        return json({ error: "validate failed", detail: String(e.message || e) }, request, 500);
      }
    }

    // ── POST /agent/backtest — run a config over real history (PRO) ──────────
    // "Test my strategy": replays the given config over Orderly OHLC + funding
    // history using the deployed deriveSignal/evaluateExit, returns per-symbol +
    // combined stats. PRO-gated (walletSig → ecrecover → walletIsPro). Read-only.
    // Note: CONFLUENCE/OI_ONLY can't be backtested (no OI history) — surfaced to UI.
    if (parts[0] === "agent" && parts[1] === "backtest" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { config, walletSig } = body || {};
      if (!config || typeof config !== "object") return json({ error: "config required" }, request, 400);
      const caller = typeof walletSig === "string" ? recoverEthAddress("nexus-trading-key-v1", walletSig) : null;
      if (!caller) return json({ error: "walletSig_required", hint: "Backtesting requires walletSig = sign_message('nexus-trading-key-v1')." }, request, 401);
      if (!(await walletIsPro(caller, env))) {
        return json({ error: "pro_backtest_locked", hint: "Strategy backtesting is a Nexus PRO feature — hold ARCHITECT-tier $NEXUS or subscribe." }, request, 402);
      }
      const symbols = (Array.isArray(config.symbols) && config.symbols.length ? config.symbols : ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC"]).slice(0, 3);
      const days = Math.min(90, Math.max(7, Number(body.days) || 60));
      // OI-dependent modes (CONFLUENCE / OI_ONLY) become testable once the brain's
      // recorded oi:hist has matured — load it, gate on coverage, feed the engine
      // only when deep enough; otherwise stay honestly "untestable".
      const needsOi = ["CONFLUENCE", "OI_ONLY"].includes(config.signalMode);
      const oi = needsOi ? await loadOiHistForBacktest(symbols, env) : null;
      const untestable = needsOi && !oi.oiMature;
      try {
        const result = await backtestConfig(config, { symbols, days }, oi?.oiMature ? oi.oiHistBySymbol : {});
        return json({
          ...result, untestable,
          ...(oi?.oiMature ? { oiWindowDays: oi.gate.minDays } : {}),
          note: untestable
            ? `${config.signalMode} needs recorded OI history — still maturing (${oi.gate.minDays}/${OI_BACKTEST_MIN_DAYS}d, ${oi.gate.minSamples}/${OI_BACKTEST_MIN_SAMPLES} samples across symbols). Entries shown are funding/price-driven only; test MOMENTUM / MEAN_REVERSION / FUNDING_ONLY for a full backtest.`
            : (needsOi ? `CONFLUENCE tested over the ${oi.gate.minDays}d of recorded OI history (funding+price span the full ${days}d).` : null),
        }, request);
      } catch (e) {
        console.error("[backtest] error:", e);
        return json({ error: "backtest failed", detail: String(e.message || e) }, request, 500);
      }
    }

    // ── GET /signals/context/:symbol — funding/OI percentile-vs-history ──────
    // "Is this extreme?" context. FUNDING percentile uses Orderly's months of
    // funding history (rich NOW); OI percentile uses our recorded oi:hist (matures
    // over weeks → `building` until it has enough samples). Public read-only.
    // ── /proxy/ls?symbols=BTC,ETH,SOL — real long/short ACCOUNT ratio ──────────
    // Market Intel needs a live L/S ratio + a real long/short liquidation lean.
    // Binance's endpoint 451s from restricted regions (incl. our worker + most US
    // users), so we source it from OKX's public rubik stats (no key, not geo-fenced)
    // and proxy server-side to dodge CORS. Returns { BTC: 1.25, ... }; null when a
    // symbol has no data. Fail-soft per symbol so one gap never blanks the rest.
    if (parts[0] === "proxy" && parts[1] === "ls" && request.method === "GET") {
      const syms = (url.searchParams.get("symbols") || "BTC,ETH,SOL")
        .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 12);
      const out = {};
      await Promise.all(syms.map(async (sym) => {
        out[sym] = null;
        try {
          const r = await fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${sym}&period=5m`);
          if (!r.ok) return;
          const d = await r.json();
          const latest = d?.data?.[0]; // [ts, ratio], newest first
          const v = latest ? parseFloat(latest[1]) : NaN;
          if (Number.isFinite(v)) out[sym] = Math.round(v * 1000) / 1000;
        } catch { /* leave null */ }
      }));
      return json({ ls: out, source: "okx", ts: Date.now() }, request);
    }

    if (parts[0] === "signals" && parts[1] === "context" && parts[2] && request.method === "GET") {
      const symbol = parts[2];
      const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
      let rates = [];
      try {
        for (let page = 1; page <= 5; page++) {
          const r = await fetch(`https://api-evm.orderly.org/v1/public/funding_rate_history?symbol=${symbol}&page=${page}&size=100`);
          const d = await r.json();
          const rows = d?.data?.rows || [];
          rates.push(...rows.map((x) => Number(x.funding_rate)).filter(Number.isFinite));
          if (rows.length < 100) break;
        }
      } catch { /* ignore */ }
      const cur = rates.length ? rates[0] : null; // rows are newest-first
      const funding = cur == null ? null : {
        value: cur, pct: percentileRank(rates, cur), samples: rates.length,
        days: Math.round(rates.length / 3), // ~3 settlements/day
        min: Math.min(...rates), max: Math.max(...rates),
      };
      let oi = null;
      try {
        const raw = await AGENT_KV.get(`oi:hist:${symbol}`);
        const s = oiStats(raw ? JSON.parse(raw) : []);
        oi = { building: s.building, samples: s.samples, ...(s.oi || {}) };
      } catch { /* ignore */ }
      return json({ symbol, funding, oi }, request);
    }

    // ── GET /agent/oi-history/:symbol — recorded OI series (public market data) ──
    // The brain snapshots hourly {t,price,oi,funding} into oi:hist:{symbol} because
    // Orderly has no OI history endpoint. Exposed so the confluence backtest (and
    // any analytics) can read the series we've accumulated. Read-only, no secrets.
    if (parts[0] === "agent" && parts[1] === "oi-history" && parts[2] && request.method === "GET") {
      const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
      const raw = await AGENT_KV.get(`oi:hist:${parts[2]}`);
      return json({ symbol: parts[2], points: raw ? JSON.parse(raw) : [] }, request);
    }

    // ── POST /agent/hook/:token — TradingView / external signal webhook ──────
    // Token-authed (no walletSig — TradingView can't sign). The token only
    // authorizes order placement on the user's order-only key (can't withdraw) and
    // is rotatable. We validate + write the intent to KV; the exec cron picks it up
    // through the normal pipeline, inheriting every guardrail. Must be fast (<3s,
    // TV timeout) so it never places the order inline.
    if (parts[0] === "agent" && parts[1] === "hook" && parts[2] && request.method === "POST") {
      const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
      const metaRaw = await AGENT_KV.get(`agent:webhook:${parts[2]}`);
      if (!metaRaw) return json({ error: "invalid or revoked token" }, request, 401);
      const meta = JSON.parse(metaRaw);
      if (!meta.enabled) return json({ error: "webhook disabled" }, request, 403);
      let body; try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      if (meta.passphrase && String(body.passphrase || "") !== meta.passphrase) {
        return json({ error: "bad passphrase" }, request, 401);
      }
      const parsed = parseWebhookAlert(body);
      if (!parsed.ok) return json({ error: parsed.error }, request, 400);
      const intent = {
        action: parsed.action, direction: parsed.direction, symbol: parsed.symbol,
        sizeOverride: parsed.sizeOverride, timestamp: Date.now(), source: "WEBHOOK",
      };
      // Short TTL: a stale alert self-expires so it can't fire late (exec also gates
      // on age). Latest write wins — exec consumes (deletes) on pickup.
      await AGENT_KV.put(`agent:webhook_signal:${meta.address}`, JSON.stringify(intent), { expirationTtl: 600 });
      return json({ ok: true, queued: intent }, request);
    }

    // ── /feed ──────────────────────────────────────────────
    // ── /agent/:address — agent config, state, trade history ──
    if (parts[0] === "agent" && parts[1]) {
      const address = parts[1].toLowerCase();
      // Agent data MUST live in the same KV namespace the brain/exec Workers read
      // (binding NEXUS_AGENT). Falling back to LAB_STORE only if the binding is
      // somehow absent so the route never hard-crashes.
      const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;

      // ── Ownership auth for agent MUTATIONS ──────────────────────────────────
      // Every state-changing agent op (activate, config, mode, deactivate, kill,
      // resolve pending) is an account-control action and MUST prove the caller
      // owns :address — otherwise anyone who knows a wallet could kill an agent or
      // force-close its positions. Auth = a personal_sign of "nexus-trading-key-v1"
      // (same sig the skill/web already produce); we ecrecover it and require the
      // recovered address to equal :address. GET reads stay public.
      const ownsAgent = (walletSig) =>
        typeof walletSig === "string" && recoverEthAddress("nexus-trading-key-v1", walletSig) === address;
      const requireOwner = (walletSig) =>
        ownsAgent(walletSig)
          ? null
          : json({ error: "walletSig_required", hint: "This agent action requires walletSig = sign_message('nexus-trading-key-v1') from the agent's own wallet." }, request, 401);

      // GET /agent/:address
      if (request.method === "GET" && !parts[2]) {
        const [configRaw, stateRaw, pendingRaw, signalRaw, whMetaRaw, directiveRaw] = await Promise.all([
          AGENT_KV.get(`agent:config:${address}`),
          AGENT_KV.get(`agent:state:${address}`),
          AGENT_KV.get(`agent:pending:${address}`),
          AGENT_KV.get(`agent:signal:${address}`),
          AGENT_KV.get(`agent:webhook_meta:${address}`),
          AGENT_KV.get(`agent:directive:${address}`),
        ]);
        const config = configRaw ? JSON.parse(configRaw) : null;
        const state = stateRaw ? JSON.parse(stateRaw) : null;
        const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
        // Current directional directive (read-only) so the UI can render/cancel it.
        let directive = null;
        if (directiveRaw) { try { directive = JSON.parse(directiveRaw); } catch { /* ignore */ } }
        // last_signal is owned by the brain via agent:signal — merge it into the
        // state response (read-only) so the brain never has to write agent:state.
        if (state && signalRaw) {
          try { state.last_signal = JSON.parse(signalRaw); } catch { /* keep stored */ }
        }
        let trades = [];
        // Only query Supabase if configured — an undefined SUPABASE_URL produces a
        // relative fetch (self-subrequest) that fails the whole route (CF error 1042).
        if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
          try {
            const tradesRes = await fetch(
              `${env.SUPABASE_URL}/rest/v1/agent_trades?wallet_address=eq.${address}&order=closed_at.desc&limit=50`,
              { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
            );
            if (tradesRes.ok) trades = await tradesRes.json();
          } catch (e) { console.error("[agent-api] supabase fetch error:", e); }
        }
        // Non-secret webhook status only (the token is NEVER returned on the public GET).
        let webhook = null;
        if (whMetaRaw) { try { webhook = { enabled: !!JSON.parse(whMetaRaw).enabled }; } catch { /* ignore */ } }
        // Whether this wallet has linked a Telegram chat for agent trade alerts.
        const tgLinked = !!(await AGENT_KV.get(`tg:chat:${address}`));
        return json({ config, state, trades, pending, webhook, directive, tgLinked }, request);
      }

      // POST /agent/:address/webhook/(enable|rotate|disable) — manage the signal
      // webhook. enable/rotate mint a fresh token+passphrase (rotate revokes the old
      // token); disable revokes without minting. PRO-gated. Owner-authed (walletSig).
      // The token is a SECRET — returned ONLY here, never on the public GET.
      if (request.method === "POST" && parts[2] === "webhook" && ["enable", "rotate", "disable"].includes(parts[3])) {
        const wbody = await request.json().catch(() => ({}));
        const denied = requireOwner(wbody.walletSig); if (denied) return denied;
        const metaKey = `agent:webhook_meta:${address}`;
        const prevRaw = await AGENT_KV.get(metaKey);
        const prev = prevRaw ? JSON.parse(prevRaw) : null;

        if (parts[3] === "disable") {
          if (prev?.token) await AGENT_KV.delete(`agent:webhook:${prev.token}`);
          await AGENT_KV.put(metaKey, JSON.stringify({ ...(prev || {}), enabled: false, token: null }));
          return json({ ok: true, enabled: false }, request);
        }

        // enable / rotate both require PRO and produce a new token.
        if (!(await walletIsPro(address, env))) {
          return json({ error: "pro_webhook_locked", hint: "The signal webhook is a Nexus PRO feature — hold ARCHITECT-tier $NEXUS or subscribe." }, request, 402);
        }
        if (prev?.token) await AGENT_KV.delete(`agent:webhook:${prev.token}`); // revoke old on rotate
        const token = randToken(24);
        const passphrase = randToken(9);
        await AGENT_KV.put(`agent:webhook:${token}`, JSON.stringify({ address, passphrase, enabled: true, createdAt: Date.now() }));
        await AGENT_KV.put(metaKey, JSON.stringify({ token, passphrase, enabled: true, createdAt: Date.now() }));
        const base = new URL(request.url).origin;
        return json({ ok: true, enabled: true, url: `${base}/agent/hook/${token}`, token, passphrase }, request);
      }

      // ── /agent/:address/strategies — personal saved-strategy library ──────
      // Compose a config in the builder, name it, save it, load it back later.
      // FREE (composing/saving is basic UX; backtest/sweep stay PRO). Save/delete
      // are owner-authed (walletSig); list is public (a config isn't secret, and it
      // sets up browsing/sharing strategies later).
      if (parts[2] === "strategies") {
        const key = `agent:strategies:${address}`;
        if (request.method === "GET" && !parts[3]) {
          const raw = await AGENT_KV.get(key);
          return json({ strategies: raw ? JSON.parse(raw) : [] }, request);
        }
        if (request.method === "POST" && !parts[3]) {
          const b = await request.json().catch(() => ({}));
          const denied = requireOwner(b.walletSig); if (denied) return denied;
          if (!b.name || !b.config) return json({ error: "name and config required" }, request, 400);
          const raw = await AGENT_KV.get(key);
          const list = raw ? JSON.parse(raw) : [];
          const strat = { id: `strat_${Date.now()}`, name: String(b.name).slice(0, 40), config: b.config, stats: b.stats || null, createdAt: Date.now() };
          list.unshift(strat);
          if (list.length > 20) list.pop();
          await AGENT_KV.put(key, JSON.stringify(list));
          return json({ ok: true, strategy: strat, strategies: list }, request);
        }
        // POST /agent/:address/strategies/:id/publish {public} — toggle sharing.
        if (request.method === "POST" && parts[3] && parts[4] === "publish") {
          const b = await request.json().catch(() => ({}));
          const denied = requireOwner(b.walletSig); if (denied) return denied;
          const raw = await AGENT_KV.get(key);
          const list = raw ? JSON.parse(raw) : [];
          const s = list.find((x) => x.id === parts[3]);
          if (!s) return json({ error: "not found" }, request, 404);
          s.public = !!b.public;
          s.publishedAt = s.public ? Date.now() : null;
          // Publishing kicks off a background walk-forward → trust badge on the board.
          if (s.public) s.validation = { status: "validating", requestedAt: Date.now() };
          else s.validation = null;
          await AGENT_KV.put(key, JSON.stringify(list));
          if (s.public && ctx?.waitUntil) ctx.waitUntil(revalidateStrategy(address, s.id, s.config, env));
          return json({ ok: true, strategies: list }, request);
        }
        if (request.method === "DELETE" && parts[3]) {
          const b = await request.json().catch(() => ({}));
          const denied = requireOwner(b.walletSig); if (denied) return denied;
          const raw = await AGENT_KV.get(key);
          const list = (raw ? JSON.parse(raw) : []).filter((s) => s.id !== parts[3]);
          await AGENT_KV.put(key, JSON.stringify(list));
          return json({ ok: true, strategies: list }, request);
        }
      }

      // POST /agent/:address/pending/:id/(deploy|dismiss) — resolve a thesis
      if (request.method === "POST" && parts[2] === "pending" && parts[3] && parts[4]) {
        const pbody = await request.json().catch(() => ({}));
        const denied = requireOwner(pbody.walletSig); if (denied) return denied;
        const action = parts[4];
        const pendingRaw = await AGENT_KV.get(`agent:pending:${address}`);
        const list = pendingRaw ? JSON.parse(pendingRaw) : [];
        const next = list.filter((t) => t.id !== parts[3]);
        await AGENT_KV.put(`agent:pending:${address}`, JSON.stringify(next));
        return json({ ok: true, action, remaining: next.length }, request);
      }

      // POST /agent/:address/paper/reset — clear the simulated paper ledger
      if (request.method === "POST" && parts[2] === "paper" && parts[3] === "reset") {
        const prbody = await request.json().catch(() => ({}));
        const denied = requireOwner(prbody.walletSig); if (denied) return denied;
        const stateRaw = await AGENT_KV.get(`agent:state:${address}`);
        if (!stateRaw) return json({ ok: true, cleared: 0 }, request);
        const state = JSON.parse(stateRaw);
        const cleared = (state.paper_trades || []).length;
        state.paper_trades = [];
        // Also reset paper-mode daily counters so the record starts clean
        if (state.current_position?.paper) state.current_position = null;
        state.daily_pnl = 0;
        state.trades_today = 0;
        await AGENT_KV.put(`agent:state:${address}`, JSON.stringify(state));
        return json({ ok: true, cleared }, request);
      }

      // POST /agent/:address/test-signal — DEV: inject a synthetic signal so a
      // PAPER trade fires on the next exec tick. Hard-refuses unless the user is
      // in PAPER mode, so it can never trigger a real order.
      if (request.method === "POST" && parts[2] === "test-signal") {
        const configRaw = await AGENT_KV.get(`agent:config:${address}`);
        if (!configRaw) return json({ error: "no agent config — activate first" }, request, 400);
        const config = JSON.parse(configRaw);
        if (config.mode !== "PAPER") return json({ error: "test-signal only allowed in PAPER mode" }, request, 403);
        let body = {};
        try { body = await request.json(); } catch { /* optional */ }
        const denied = requireOwner(body?.walletSig); if (denied) return denied;
        const direction = body?.direction === "SHORT" ? "SHORT" : "LONG";
        const symbol = (config.symbols && config.symbols[0]) || "PERP_BTC_USDC";
        let price = 0;
        try {
          const r = await fetch(`https://api-evm.orderly.org/v1/public/futures/${symbol}`);
          const d = await r.json();
          price = parseFloat(d?.data?.mark_price) || 0;
        } catch { /* entry uses live mark price in exec anyway */ }
        const signal = { symbol, direction, funding: 0.05, oi: 0, confidence: 80, price, reason: "DEV test-signal", timestamp: Date.now(), user: address };
        await AGENT_KV.put(`agent:signal:${address}`, JSON.stringify(signal));
        // Clear cooldown so the next tick acts immediately
        const stateRaw = await AGENT_KV.get(`agent:state:${address}`);
        if (stateRaw) {
          const state = JSON.parse(stateRaw);
          state.last_trade_time = 0;
          await AGENT_KV.put(`agent:state:${address}`, JSON.stringify(state));
        }
        return json({ ok: true, signal }, request);
      }

      // PUT /agent/:address — activate (config + key)
      if (request.method === "PUT" && !parts[2]) {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        const denied = requireOwner(body.walletSig); if (denied) return denied;
        const { config, tradingKey, accountId } = body;
        // PAPER mode is fully simulated — it never places real orders, so no
        // trading key is required or stored.
        const isPaper = config?.mode === "PAPER";
        if (!config || (!isPaper && !tradingKey)) return json({ error: "config and tradingKey required" }, request, 400);
        if (config.signalMode && PRO_STRATEGIES.includes(config.signalMode) && !(await walletIsPro(address, env))) {
          return json({ error: "pro_strategy_locked", strategy: config.signalMode, hint: "MOMENTUM and MEAN_REVERSION require Nexus PRO — hold ARCHITECT-tier $NEXUS or subscribe. Free: CONFLUENCE, FUNDING_ONLY, OI_ONLY." }, request, 402);
        }
        if (config.dcaEnabled && !(await walletIsPro(address, env))) {
          return json({ error: "pro_dca_locked", hint: "DCA / safety-order mode requires Nexus PRO — hold ARCHITECT-tier $NEXUS or subscribe." }, request, 402);
        }
        await AGENT_KV.put(`agent:config:${address}`, JSON.stringify(config));
        if (!isPaper) {
          // Encrypt the trading key at rest — KV never holds it in plaintext.
          const encryptedKey = await encryptSecret(tradingKey, env);
          await AGENT_KV.put(`agent:key:${address}`, JSON.stringify({ tradingKey: encryptedKey, accountId, registeredAt: Date.now(), enc: "v1" }));
        }
        const existingState = await AGENT_KV.get(`agent:state:${address}`);
        const state = existingState ? JSON.parse(existingState) : { active: true, daily_pnl: 0, trades_today: 0, last_reset: Date.now(), current_position: null, last_signal: null };
        state.active = true;
        await AGENT_KV.put(`agent:state:${address}`, JSON.stringify(state));
        const usersRaw = await AGENT_KV.get("agent:users");
        const users = usersRaw ? JSON.parse(usersRaw) : [];
        if (!users.includes(address)) { users.push(address); await AGENT_KV.put("agent:users", JSON.stringify(users)); }
        return json({ ok: true, state }, request);
      }

      // PUT /agent/:address/config — update config only
      if (request.method === "PUT" && parts[2] === "config") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        const denied = requireOwner(body.walletSig); if (denied) return denied;
        const { config } = body;
        if (!config) return json({ error: "config required" }, request, 400);
        if (config.signalMode && PRO_STRATEGIES.includes(config.signalMode) && !(await walletIsPro(address, env))) {
          return json({ error: "pro_strategy_locked", strategy: config.signalMode, hint: "MOMENTUM and MEAN_REVERSION require Nexus PRO — hold ARCHITECT-tier $NEXUS or subscribe. Free: CONFLUENCE, FUNDING_ONLY, OI_ONLY." }, request, 402);
        }
        if (config.dcaEnabled && !(await walletIsPro(address, env))) {
          return json({ error: "pro_dca_locked", hint: "DCA / safety-order mode requires Nexus PRO — hold ARCHITECT-tier $NEXUS or subscribe." }, request, 402);
        }
        await AGENT_KV.put(`agent:config:${address}`, JSON.stringify(config));
        return json({ ok: true }, request);
      }

      // DELETE /agent/:address — deactivate
      if (request.method === "DELETE" && !parts[2]) {
        const dbody = await request.json().catch(() => ({}));
        const denied = requireOwner(dbody.walletSig); if (denied) return denied;
        await AGENT_KV.delete(`agent:key:${address}`);
        const stateRaw = await AGENT_KV.get(`agent:state:${address}`);
        if (stateRaw) {
          const state = JSON.parse(stateRaw);
          state.active = false;
          state.current_position = null;
          await AGENT_KV.put(`agent:state:${address}`, JSON.stringify(state));
        }
        const usersRaw = await AGENT_KV.get("agent:users");
        if (usersRaw) {
          const users = JSON.parse(usersRaw).filter((u) => u !== address);
          await AGENT_KV.put("agent:users", JSON.stringify(users));
        }
        return json({ ok: true }, request);
      }

      // POST /agent/:address/kill — kill switch
      if (request.method === "POST" && parts[2] === "kill") {
        const kbody = await request.json().catch(() => ({}));
        const denied = requireOwner(kbody.walletSig); if (denied) return denied;
        // Phase 3 (#14): kill force-closes positions → request-bound v2 on top of the
        // static sig. No-op unless AUTH_V2 is on.
        const deniedV2 = await requireOwnerV2(env, request, { action: "agent.kill", wallet: address, nonce: kbody.nonce, v2Sig: kbody.v2Sig });
        if (deniedV2) return deniedV2;
        // Emergency stop must be un-clobberable. Write a DEDICATED kill flag the
        // exec consumes + clears — never rely on a state field the exec also
        // rewrites every minute (that write could race and drop the kill).
        await AGENT_KV.put(`agent:kill:${address}`, "1");
        await AGENT_KV.delete(`agent:key:${address}`);
        const usersRaw = await AGENT_KV.get("agent:users");
        if (usersRaw) {
          const users = JSON.parse(usersRaw).filter((u) => u !== address);
          await AGENT_KV.put("agent:users", JSON.stringify(users));
        }
        return json({ ok: true, message: "Kill switch activated" }, request);
      }

      // ── POST /agent/:address/directive — arm a directional "trade my thesis"
      // one-shot managed order (docs/directional-agent-spec.md). The direction is
      // honored VERBATIM (unlike the signal bot). PAPER simulates; AUTONOMOUS places
      // a real market order and requires confirm:"GO LIVE". Owner-authed. Phase 1 =
      // MARKET entries only.
      if (request.method === "POST" && parts[2] === "directive") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        const denied = requireOwner(body?.walletSig); if (denied) return denied;

        const mode = body?.mode === "AUTONOMOUS" ? "AUTONOMOUS" : "PAPER";
        if (mode === "AUTONOMOUS" && body?.confirm !== "GO LIVE") {
          return json({ error: "confirm_required", hint: 'A live directive places a real market order — pass confirm:"GO LIVE". The order-only key cannot withdraw.' }, request, 409);
        }
        if (mode === "AUTONOMOUS") {
          const deniedV2 = await requireOwnerV2(env, request, { action: "agent.activate", wallet: address, nonce: body?.nonce, v2Sig: body?.v2Sig });
          if (deniedV2) return deniedV2;
        }

        const d = body?.directive || {};
        const symbol = typeof d.symbol === "string" ? d.symbol : null;
        const direction = d.direction === "SHORT" ? "SHORT" : d.direction === "LONG" ? "LONG" : null;
        if (!symbol || !direction) return json({ error: "directive needs symbol + direction (LONG|SHORT)" }, request, 400);
        // MARKET fills next tick; LIMIT waits until mark reaches entryPrice (± tolerance,
        // within maxChase). Both require a planned entryPrice — MARKET uses it only to
        // validate level sides; LIMIT uses it as the trigger.
        const entryType = String(d.entryType || "MARKET").toUpperCase() === "LIMIT" ? "LIMIT" : "MARKET";
        if (!(Number(d.entryPrice) > 0)) return json({ error: "entryPrice required", hint: "Provide the entry price (MARKET: to validate stop/target sides; LIMIT: the fill trigger)." }, request, 400);
        const lv = directiveLevels({ ...d, direction }, Number(d.entryPrice));
        if (lv.error) return json({ error: "invalid_levels", hint: lv.error }, request, 400);

        // One active directive per wallet.
        const existingRaw = await AGENT_KV.get(`agent:directive:${address}`);
        if (existingRaw) {
          try {
            const ex = JSON.parse(existingRaw);
            if (ex.status === "ARMED" || ex.status === "LIVE") return json({ error: "directive_active", hint: "A directive is already armed/live — cancel it (DELETE) or kill the position first." }, request, 409);
          } catch { /* corrupt → overwrite below */ }
        }

        // AUTONOMOUS needs the order-only key — derive from walletSig (like activate).
        if (mode === "AUTONOMOUS") {
          const haveKey = await AGENT_KV.get(`agent:key:${address}`);
          if (!haveKey) {
            const recRaw = await env.LAB_STORE.get("user:" + address);
            if (!recRaw) return json({ error: "wallet_not_registered", hint: "Register your Orderly account first, then retry." }, request, 401);
            const rec = JSON.parse(recRaw);
            if (!rec.accountId) return json({ error: "wallet_not_registered", hint: "No Orderly account on file." }, request, 401);
            const secret = await agentSecretFromWalletSig(body.walletSig);
            const encryptedKey = await encryptSecret(secret, env);
            await AGENT_KV.put(`agent:key:${address}`, JSON.stringify({ tradingKey: encryptedKey, accountId: rec.accountId, registeredAt: Date.now(), enc: "v1" }));
          }
        }

        // Ensure a config exists + set the execution mode so the exec dispatches it.
        const cfgRaw = await AGENT_KV.get(`agent:config:${address}`);
        const baseCfg = cfgRaw ? JSON.parse(cfgRaw) : { symbols: [symbol], leverage: 5, capitalPerTrade: 30, tpPercent: 1.5, slPercent: 0.75, maxHoldHours: 4, maxTradesPerDay: 4, maxDailyLossUsdc: 5, fundingThreshold: 0.01, signalMode: "FUNDING_ONLY" };
        baseCfg.mode = mode;
        await AGENT_KV.put(`agent:config:${address}`, JSON.stringify(baseCfg));

        // Build + store the ARMED directive.
        const now = Date.now();
        const MAX_HORIZON = 7 * 24 * 3600 * 1000;
        const validUntil = Math.min(now + MAX_HORIZON, Number(d.validUntil) || (now + 24 * 3600 * 1000));
        const directive = {
          id: `dir_${now}`,
          symbol, direction, source: d.source || "THESIS", thesisId: d.thesisId || null,
          entryType, entryPrice: Number(d.entryPrice) || 0,
          entryTolerancePct: entryType === "LIMIT" ? (Number(d.entryTolerancePct) > 0 ? Number(d.entryTolerancePct) : 0.15) : 0,
          maxChasePct: entryType === "LIMIT" ? (Number(d.maxChasePct) > 0 ? Number(d.maxChasePct) : 1.0) : 0,
          stopLoss: Number(d.stopLoss), takeProfit1: Number(d.takeProfit1),
          takeProfit2: Number(d.takeProfit2) || 0, tp1SizePct: Number(d.tp1SizePct) || 50,
          leverage: Number(d.leverage) > 0 ? Number(d.leverage) : 0,
          capitalPerTrade: Number(d.capitalPerTrade) > 0 ? Number(d.capitalPerTrade) : 0,
          resumeSignals: !!d.resumeSignals,
          status: "ARMED", validUntil, createdAt: now,
        };
        await AGENT_KV.put(`agent:directive:${address}`, JSON.stringify(directive));
        await AGENT_KV.delete(`agent:kill:${address}`); // clear a stale kill so it can fill

        // Activate + register so the exec picks it up next tick.
        const stRaw = await AGENT_KV.get(`agent:state:${address}`);
        const state = stRaw ? JSON.parse(stRaw) : { active: true, daily_pnl: 0, trades_today: 0, last_reset: now, current_position: null, last_signal: null };
        state.active = true;
        await AGENT_KV.put(`agent:state:${address}`, JSON.stringify(state));
        const usersRaw2 = await AGENT_KV.get("agent:users");
        const users2 = usersRaw2 ? JSON.parse(usersRaw2) : [];
        if (!users2.includes(address)) { users2.push(address); await AGENT_KV.put("agent:users", JSON.stringify(users2)); }

        const tkShort = symbol.replace("PERP_", "").replace("_USDC", "");
        const fillNote = entryType === "LIMIT" ? `waits until ${tkShort} reaches $${Number(d.entryPrice)}` : "fills next tick (~1 min)";
        return json({ ok: true, mode, directive, note: mode === "AUTONOMOUS"
          ? `Live: the agent ${fillNote} with a real order, then manages to your TP/SL.`
          : `Paper: simulated — ${fillNote}.` }, request);
      }

      // DELETE /agent/:address/directive — cancel an ARMED directive (no-op on LIVE;
      // use /kill to stop a live one).
      if (request.method === "DELETE" && parts[2] === "directive") {
        const dbody = await request.json().catch(() => ({}));
        const denied = requireOwner(dbody.walletSig); if (denied) return denied;
        const raw = await AGENT_KV.get(`agent:directive:${address}`);
        if (!raw) return json({ ok: true, cancelled: false }, request);
        let ex = null; try { ex = JSON.parse(raw); } catch { /* ignore */ }
        if (ex && ex.status === "LIVE") return json({ error: "directive_live", hint: "This directive already has an open position — use /agent/:address/kill to close it." }, request, 409);
        await AGENT_KV.delete(`agent:directive:${address}`);
        return json({ ok: true, cancelled: true }, request);
      }

      // ── POST /agent/:address/bankr/activate — deploy the agent from a Bankr chat ──
      // PAPER needs no key. ASSISTED/AUTONOMOUS derive the order-only key from the
      // provided walletSig (sign_message('nexus-trading-key-v1')) — same auth as
      // /trade. AUTONOMOUS (live) requires explicit confirm:"GO LIVE".
      if (request.method === "POST" && parts[2] === "bankr" && parts[3] === "activate") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        // Ownership auth for ALL modes (PAPER included) — activating/reconfiguring an
        // agent is a mutation. Live modes additionally derive the key from this sig below.
        const denied = requireOwner(body?.walletSig); if (denied) return denied;
        const mode = ["PAPER", "ASSISTED", "AUTONOMOUS"].includes(body?.mode) ? body.mode : "PAPER";
        if (mode === "AUTONOMOUS" && body?.confirm !== "GO LIVE") {
          return json({ error: "confirm_required", hint: 'Live trading needs confirm:"GO LIVE". The agent uses an order-only key that cannot withdraw.' }, request, 409);
        }
        // Phase 3 (#14): going live (AUTONOMOUS) arms real-money trading → request-bound
        // v2 on top of confirm + static sig. Sim/assisted modes keep the static-sig gate.
        if (mode === "AUTONOMOUS") {
          const deniedV2 = await requireOwnerV2(env, request, { action: "agent.activate", wallet: address, nonce: body?.nonce, v2Sig: body?.v2Sig });
          if (deniedV2) return deniedV2;
        }
        const defaults = { symbols: ["PERP_BTC_USDC"], leverage: 5, capitalPerTrade: 30, tpPercent: 1.5, slPercent: 0.75, maxHoldHours: 4, maxTradesPerDay: 10, maxDailyLossUsdc: 5, fundingThreshold: 0.01 };
        const config = { ...defaults, ...(body?.config || {}), mode };

        // PRO strategy gate — reject before doing any key/crypto work.
        if (config.signalMode && PRO_STRATEGIES.includes(config.signalMode) && !(await walletIsPro(address, env))) {
          return json({ error: "pro_strategy_locked", strategy: config.signalMode, hint: "MOMENTUM and MEAN_REVERSION require Nexus PRO — hold ARCHITECT-tier $NEXUS or subscribe. Free strategies: CONFLUENCE, FUNDING_ONLY, OI_ONLY." }, request, 402);
        }
        if (config.dcaEnabled && !(await walletIsPro(address, env))) {
          return json({ error: "pro_dca_locked", hint: "DCA / safety-order mode requires Nexus PRO — hold ARCHITECT-tier $NEXUS or subscribe." }, request, 402);
        }

        // Live modes need the delegated key. Derive it from the wallet signature
        // (auth) + the registered accountId.
        if (mode !== "PAPER") {
          if (!body?.walletSig) return json({ error: "walletSig required", hint: "Call sign_message('nexus-trading-key-v1') and pass walletSig for live modes." }, request, 400);
          const recRaw = await env.LAB_STORE.get("user:" + address);
          if (!recRaw) return json({ error: "wallet_not_registered", hint: "Register first via POST /proxy/bankr-register, then retry." }, request, 401);
          const rec = JSON.parse(recRaw);
          if (!rec.accountId) return json({ error: "wallet_not_registered", hint: "No Orderly account on file — register first." }, request, 401);
          const secret = await agentSecretFromWalletSig(body.walletSig);
          const encryptedKey = await encryptSecret(secret, env);
          await AGENT_KV.put(`agent:key:${address}`, JSON.stringify({ tradingKey: encryptedKey, accountId: rec.accountId, registeredAt: Date.now(), enc: "v1" }));
        }

        await AGENT_KV.put(`agent:config:${address}`, JSON.stringify(config));
        await AGENT_KV.delete(`agent:kill:${address}`); // clear any stale kill flag from a prior KILL
        const existingState = await AGENT_KV.get(`agent:state:${address}`);
        const state = existingState ? JSON.parse(existingState) : { active: true, daily_pnl: 0, trades_today: 0, last_reset: Date.now(), current_position: null, last_signal: null };
        state.active = true;
        await AGENT_KV.put(`agent:state:${address}`, JSON.stringify(state));
        const usersRaw = await AGENT_KV.get("agent:users");
        const users = usersRaw ? JSON.parse(usersRaw) : [];
        if (!users.includes(address)) { users.push(address); await AGENT_KV.put("agent:users", JSON.stringify(users)); }
        return json({ ok: true, mode, config, state, note: "Order-only key — the agent can trade but never withdraw or transfer your funds." }, request);
      }

      // ── POST /agent/:address/bankr/mode — change execution mode by chat ──
      // PAPER → immediate. ASSISTED/AUTONOMOUS need the key present (provision from
      // walletSig if missing). AUTONOMOUS (live) requires confirm:"GO LIVE".
      if (request.method === "POST" && parts[2] === "bankr" && parts[3] === "mode") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        const denied = requireOwner(body?.walletSig); if (denied) return denied;
        const mode = body?.mode;
        if (!["PAPER", "ASSISTED", "AUTONOMOUS"].includes(mode)) return json({ error: "mode must be PAPER | ASSISTED | AUTONOMOUS" }, request, 400);
        if (mode === "AUTONOMOUS" && body?.confirm !== "GO LIVE") {
          return json({ error: "confirm_required", hint: 'Going live needs confirm:"GO LIVE".' }, request, 409);
        }
        // Phase 3 (#14): flipping live → request-bound v2 (same as activate go-live).
        if (mode === "AUTONOMOUS") {
          const deniedV2 = await requireOwnerV2(env, request, { action: "agent.mode", wallet: address, nonce: body?.nonce, v2Sig: body?.v2Sig });
          if (deniedV2) return deniedV2;
        }
        const configRaw = await AGENT_KV.get(`agent:config:${address}`);
        if (!configRaw) return json({ error: "no_agent", hint: "Activate the agent first via /agent/:address/bankr/activate." }, request, 400);
        const config = JSON.parse(configRaw);

        // Live modes require the order-only key to exist; provision it from the
        // wallet signature if this agent was previously PAPER (no key stored).
        if (mode !== "PAPER") {
          const haveKey = await AGENT_KV.get(`agent:key:${address}`);
          if (!haveKey) {
            if (!body?.walletSig) return json({ error: "walletSig required", hint: "Going live needs walletSig (sign_message('nexus-trading-key-v1'))." }, request, 400);
            const recRaw = await env.LAB_STORE.get("user:" + address);
            if (!recRaw) return json({ error: "wallet_not_registered", hint: "Register first via POST /proxy/bankr-register." }, request, 401);
            const rec = JSON.parse(recRaw);
            const secret = await agentSecretFromWalletSig(body.walletSig);
            const encryptedKey = await encryptSecret(secret, env);
            await AGENT_KV.put(`agent:key:${address}`, JSON.stringify({ tradingKey: encryptedKey, accountId: rec.accountId, registeredAt: Date.now(), enc: "v1" }));
          }
        }

        config.mode = mode;
        await AGENT_KV.put(`agent:config:${address}`, JSON.stringify(config));
        return json({ ok: true, mode }, request);
      }

      return json({ error: "not found" }, request, 404);
    }

    // ── /agents/leaderboard — public ranking of autonomous agents ──
    // Ranks by a risk-adjusted score (win rate + capped profit factor, shrunk by
    // sample size) so it reflects STRATEGY quality, not deposit size or a lucky
    // small sample. Live trades only (paper never reaches Supabase).
    // ── POST /live/publish — a human OPTS IN to broadcast their OPEN positions ──
    // We can't read a user's positions server-side (their Orderly key is private),
    // so the client publishes a snapshot. EPHEMERAL by design: stored with a ~6-min
    // TTL, so it self-expires the moment they stop refreshing — we retain nothing.
    // Auth = ecrecover of sign_message('nexus-trading-key-v1') === wallet. uPnL is
    // recomputed from PUBLIC mark price in /agents/live (we never trust client PnL).
    // Identity (name/pfp) is the user's own already-public profile data. Empty
    // positions → opt-out (delete the key).
    if (parts[0] === "live" && parts[1] === "publish" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const { walletAddress, walletSig, positions, displayName, pfpUrl } = body || {};
      if (!walletAddress || !walletSig) return json({ error: "walletAddress + walletSig required" }, request, 401);
      const addr = String(walletAddress).toLowerCase();
      if (recoverEthAddress("nexus-trading-key-v1", walletSig) !== addr) return json({ error: "bad signature" }, request, 401);
      const KV = env.NEXUS_AGENT || env.LAB_STORE;
      const clean = (Array.isArray(positions) ? positions : [])
        .filter((p) => p && p.symbol && Number(p.entry_price) > 0 && Number(p.qty) > 0 && (p.direction === "LONG" || p.direction === "SHORT"))
        .slice(0, 20)
        .map((p) => ({ symbol: String(p.symbol), direction: p.direction, entry_price: Number(p.entry_price), qty: Math.abs(Number(p.qty)), opened_at: Number(p.opened_at) || null }));
      if (!clean.length) { await KV.delete(`live:human:${addr}`); return json({ ok: true, cleared: true }, request); }
      await KV.put(`live:human:${addr}`, JSON.stringify({
        positions: clean,
        displayName: displayName ? String(displayName).slice(0, 40) : null,
        pfpUrl: pfpUrl ? String(pfpUrl).slice(0, 300) : null,
      }), { expirationTtl: 360 }); // self-expiring — nothing retained
      return json({ ok: true, count: clean.length }, request);
    }

    // ── /agents/live — LIVE NOW feed: currently-OPEN positions (agents + opted-in ──
    // humans), with uPnL recomputed from PUBLIC mark price. Agents come from
    // agent:state (real, non-paper); humans from their ephemeral live:human snapshot.
    // Pure public read. Verifiable — the PnL is derived from public price, not claimed.
    if (parts[0] === "agents" && parts[1] === "live") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
      const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;

      // Agents: open, non-paper current_position per agent:users.
      const usersRaw = await AGENT_KV.get("agent:users");
      const users = usersRaw ? JSON.parse(usersRaw) : [];
      const agentStates = await Promise.all(users.map(async (w) => {
        const s = await AGENT_KV.get(`agent:state:${w}`);
        return { w, p: s ? (JSON.parse(s).current_position || null) : null };
      }));
      const rows = [];
      for (const { w, p } of agentStates) {
        if (p && !p.paper && p.symbol && p.entry_price && p.qty) {
          rows.push({ wallet: w, agent: true, displayName: null, pfpUrl: null, symbol: p.symbol, direction: p.direction, entry_price: Number(p.entry_price), qty: Number(p.qty), opened_at: p.opened_at || null });
        }
      }

      // Humans: ephemeral opted-in snapshots (live:human:*), still within TTL.
      try {
        const list = await AGENT_KV.list({ prefix: "live:human:", limit: 1000 });
        const snaps = await Promise.all(list.keys.map(async (k) => {
          const raw = await AGENT_KV.get(k.name);
          return raw ? { wallet: k.name.slice("live:human:".length), ...JSON.parse(raw) } : null;
        }));
        for (const sn of snaps) {
          if (!sn) continue;
          for (const p of sn.positions || []) {
            rows.push({ wallet: sn.wallet, agent: false, displayName: sn.displayName || null, pfpUrl: sn.pfpUrl || null, symbol: p.symbol, direction: p.direction, entry_price: Number(p.entry_price), qty: Number(p.qty), opened_at: p.opened_at || null });
          }
        }
      } catch (e) { console.error("[live] human snapshot list error:", e); }

      // One public mark-price fetch per unique symbol → recompute uPnL.
      const markBy = {};
      await Promise.all([...new Set(rows.map((r) => r.symbol))].map(async (sym) => {
        try { markBy[sym] = Number((await (await fetch(`https://api-evm.orderly.org/v1/public/futures/${sym}`)).json())?.data?.mark_price) || null; }
        catch { markBy[sym] = null; }
      }));
      const positions = rows.map((r) => {
        const mark = markBy[r.symbol], entry = r.entry_price, qty = r.qty;
        const move = mark ? (r.direction === "LONG" ? mark - entry : entry - mark) : null;
        return {
          wallet: r.wallet, agent: r.agent, displayName: r.displayName, pfpUrl: r.pfpUrl,
          symbol: r.symbol, direction: r.direction, entry_price: entry, mark_price: mark, qty,
          notional: Number((entry * qty).toFixed(2)),
          unrealized_pnl: move != null ? Number((move * qty).toFixed(2)) : null,
          unrealized_pnl_pct: move != null ? Number(((move / entry) * 100).toFixed(2)) : null,
          opened_at: r.opened_at,
        };
      }).sort((a, b) => (b.opened_at || 0) - (a.opened_at || 0));
      return json({ count: positions.length, positions }, request);
    }

    // ── /signals — machine-readable current funding + OI-divergence reads ────────
    // The agent's actual edge, exposed as data: per symbol, the funding-extreme
    // (fade-the-crowd) + OI-divergence reads + confluence, classified by the SAME
    // rules as the autonomous agent (confluenceSignal, tested). Deltas are vs the
    // brain's ~5-min prior snapshot (market:prev:{symbol}). The premium x402 product.
    if (parts[0] === "signals") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
      const KV = env.NEXUS_AGENT || env.LAB_STORE;
      const SYMS = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_ARB_USDC", "PERP_HYPE_USDC", "PERP_XRP_USDC", "PERP_DOGE_USDC"];
      const rows = await Promise.all(SYMS.map(async (sym) => {
        try {
          const d = (await (await fetch(`https://api-evm.orderly.org/v1/public/futures/${sym}`)).json())?.data;
          if (!d || !d.mark_price) return null;
          const mark = Number(d.mark_price), funding = Number(d.last_funding_rate) || 0, oi = Number(d.open_interest) || 0;
          const prev = JSON.parse((await KV.get(`market:prev:${sym}`)) || "null");
          const priceChange = prev?.price ? (mark - prev.price) / prev.price : 0;
          const oiChange = prev?.oi ? (oi - prev.oi) / prev.oi : 0;
          const sig = confluenceSignal({ fundingRate: funding, priceChange, oiChange, hasPrev: !!prev });
          return {
            symbol: sym.replace("PERP_", "").replace("_USDC", ""),
            mark_price: mark, funding_rate_8h: funding, open_interest: oi,
            price_change_pct: Number((priceChange * 100).toFixed(3)),
            oi_change_pct: Number((oiChange * 100).toFixed(3)),
            funding_signal: sig.fundingSignal, oi_signal: sig.oiSignal, confluence: sig.confluence,
          };
        } catch { return null; }
      }));
      const signals = rows.filter(Boolean).sort(
        (a, b) => (b.confluence !== "NONE") - (a.confluence !== "NONE") || Math.abs(b.funding_rate_8h) - Math.abs(a.funding_rate_8h)
      );
      return json({
        generated_at: new Date().toISOString(),
        note: "Funding-extreme (fade the crowd) + OI-divergence reads, same rules as the Nexus autonomous agent. confluence = both rules agree (strongest). Deltas vs ~5-min prior snapshot.",
        signals,
      }, request);
    }

    // ── /desks — team layer ("clans") ranked by aggregate TRUSTLESS call score ──
    // A Desk groups wallets; its rank = the COMBINED graded-call record of its
    // members (same public-price grading as the caller leaderboard, via the shared
    // computeCallerStats). One desk per wallet. Mutations require walletSig
    // ownership. Identity = members' already-public wallets/profiles — no new PII.
    if (parts[0] === "desks") {
      const KV = env.LAB_STORE;
      const ownsWallet = (sig, addr) => typeof sig === "string" && recoverEthAddress("nexus-trading-key-v1", sig) === addr;
      const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

      // POST /desks — create (creator = first member)
      if (request.method === "POST" && !parts[1]) {
        let body; try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        const { name, walletAddress, walletSig } = body || {};
        const addr = String(walletAddress || "").toLowerCase();
        if (!name || !addr || !ownsWallet(walletSig, addr)) return json({ error: "name + walletAddress + valid walletSig required" }, request, 401);
        const existing = await KV.get(`desk:mem:${addr}`);
        if (existing) return json({ error: "already_in_desk", deskId: existing, hint: "Leave your current desk first." }, request, 409);
        const base = slugify(name) || `desk-${Date.now().toString(36)}`;
        let id = base, n = 1;
        while (await KV.get(`desk:rec:${id}`)) id = `${base}-${++n}`;
        const desk = { id, name: String(name).slice(0, 40), owner: addr, members: [addr], createdAt: Date.now() };
        await KV.put(`desk:rec:${id}`, JSON.stringify(desk));
        await KV.put(`desk:mem:${addr}`, id);
        return json({ ok: true, desk }, request);
      }

      // POST /desks/:id/join | /leave
      if (request.method === "POST" && parts[1] && (parts[2] === "join" || parts[2] === "leave")) {
        const id = parts[1];
        let body; try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
        const addr = String(body?.walletAddress || "").toLowerCase();
        if (!addr || !ownsWallet(body?.walletSig, addr)) return json({ error: "walletAddress + valid walletSig required" }, request, 401);
        const raw = await KV.get(`desk:rec:${id}`);
        if (!raw) return json({ error: "desk_not_found" }, request, 404);
        const desk = JSON.parse(raw);
        if (parts[2] === "join") {
          const existing = await KV.get(`desk:mem:${addr}`);
          if (existing) return json({ error: "already_in_desk", deskId: existing }, request, 409);
          if (!desk.members.includes(addr)) desk.members.push(addr);
          await KV.put(`desk:rec:${id}`, JSON.stringify(desk));
          await KV.put(`desk:mem:${addr}`, id);
          return json({ ok: true, desk }, request);
        }
        // leave — disband if empty; transfer ownership if the owner leaves
        desk.members = desk.members.filter((m) => m !== addr);
        await KV.delete(`desk:mem:${addr}`);
        if (desk.members.length === 0) { await KV.delete(`desk:rec:${id}`); return json({ ok: true, disbanded: true }, request); }
        if (desk.owner === addr) desk.owner = desk.members[0];
        await KV.put(`desk:rec:${id}`, JSON.stringify(desk));
        return json({ ok: true, desk }, request);
      }

      // GET /desks/:id — detail (members + per-member graded stats)
      if (request.method === "GET" && parts[1]) {
        const raw = await KV.get(`desk:rec:${parts[1]}`);
        if (!raw) return json({ error: "desk_not_found" }, request, 404);
        const d = JSON.parse(raw);
        const stats = await computeCallerStats(env);
        const memberStats = await Promise.all(d.members.map(async (m) => {
          const a = stats[m] || { calls: 0, wins: 0, rSum: 0 };
          const profileRaw = await KV.get(`profile:${m}`);
          const p = profileRaw ? JSON.parse(profileRaw) : {};
          return { wallet: m, displayName: p.displayName || null, pfp: p.pfp || null, calls: a.calls, hitRate: a.calls ? Math.round((a.wins / a.calls) * 1000) / 10 : 0, totalR: Math.round(a.rSum * 100) / 100 };
        }));
        return json({ desk: { ...d, memberStats } }, request);
      }

      // GET /desks — ranked desk leaderboard
      if (request.method === "GET" && !parts[1]) {
        const MIN_CALLS = 5, FULL_CONF = 30;
        const stats = await computeCallerStats(env);
        const listed = await KV.list({ prefix: "desk:rec:" });
        const desks = [];
        for (const k of listed.keys) {
          const raw = await KV.get(k.name);
          if (!raw) continue;
          const d = JSON.parse(raw);
          let calls = 0, wins = 0, rSum = 0;
          for (const m of d.members) { const a = stats[m]; if (a) { calls += a.calls; wins += a.wins; rSum += a.rSum; } }
          const hitRate = calls ? wins / calls : 0, avgR = calls ? rSum / calls : 0;
          const rScore = Math.max(0, Math.min(avgR, 3)) / 3, conf = Math.min(1, calls / FULL_CONF);
          const score = calls >= MIN_CALLS && avgR > 0 ? Math.round((0.5 * hitRate + 0.5 * rScore) * conf * 1000) / 10 : 0;
          desks.push({ id: d.id, name: d.name, members: d.members.length, owner: d.owner, calls, hitRate: Math.round(hitRate * 1000) / 10, avgR: Math.round(avgR * 100) / 100, totalR: Math.round(rSum * 100) / 100, score });
        }
        desks.sort((a, b) => b.score - a.score || b.totalR - a.totalR || b.members - a.members);
        desks.forEach((d, i) => { d.rank = i + 1; });
        return json({ desks }, request);
      }

      return json({ error: "not found" }, request, 404);
    }

    // ── GET /agents/strategies/public — browse shared strategies ─────────────
    // Community strategy marketplace. Ranked by the AUTHOR's GRADED agent record
    // (the trustless signal) — NOT by backtest, which is shown only as a labeled
    // hypothesis. Optional ?style=DAY|SWING|POSITION filter (derived from hold time).
    if (parts[0] === "agents" && parts[1] === "strategies" && parts[2] === "public") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
      const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
      const styleFilter = url.searchParams.get("style");
      const derive = (h) => (h <= 8 ? "DAY" : h <= 120 ? "SWING" : "POSITION");
      const listing = await AGENT_KV.list({ prefix: "agent:strategies:" });
      const collected = [];
      for (const k of listing.keys.slice(0, 300)) {
        const owner = k.name.slice("agent:strategies:".length);
        const raw = await AGENT_KV.get(k.name);
        if (!raw) continue;
        let arr; try { arr = JSON.parse(raw); } catch { continue; }
        for (const s of arr) {
          if (!s.public || !s.config) continue;
          const style = derive(s.config.maxHoldHours ?? 0);
          if (styleFilter && style !== styleFilter) continue;
          collected.push({ owner, id: s.id, name: s.name, style, config: s.config, backtest: s.stats || null, validation: s.validation || null, publishedAt: s.publishedAt || s.createdAt });
        }
      }
      // Attach each author's GRADED standing — the trust signal we rank on.
      const owners = [...new Set(collected.map((c) => c.owner))];
      const standings = {};
      if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
        await Promise.all(owners.map(async (o) => {
          try {
            const res = await fetch(`${env.SUPABASE_URL}/rest/v1/agent_trades?select=pnl,closed_at&wallet_address=ilike.${o}&limit=10000`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } });
            if (res.ok) standings[o] = agentStanding(aggregateAgentTrades(await res.json())).stats;
          } catch { /* skip */ }
        }));
      }
      // Self-heal badges: (re)validate strategies that are missing a verdict, stuck
      // "validating", or "pending_oi" — the latter auto-flips to a real verdict once OI
      // matures (no re-publish needed). Bounded per request + idempotent to cap load.
      if (ctx?.waitUntil) {
        const stale = (v) => !v || v.status === "validating" || v.status === "error" ||
          (v.status === "pending_oi" && Date.now() - (v.checkedAt || 0) > 6 * 3600 * 1000);
        const needing = collected.filter((c) => stale(c.validation)).slice(0, 3);
        for (const c of needing) ctx.waitUntil(revalidateStrategy(c.owner, c.id, c.config, env));
      }
      const items = collected
        .map((c) => ({ ...c, author: standings[c.owner] || null }))
        .sort((a, b) => (b.author?.score || 0) - (a.author?.score || 0) || (b.author?.netPnl || 0) - (a.author?.netPnl || 0));
      return json({ strategies: items.slice(0, 50), rankedBy: "author_graded_record" }, request);
    }

    if (parts[0] === "agents" && parts[1] === "leaderboard") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
      const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;

      const MIN_TRADES = AGENT_BOARD.minTrades;  // anti-gaming: meaningful sample
      const MIN_DAYS = AGENT_BOARD.minDays;       // anti-gaming: spread over time
      const TOP_N = 25;

      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return json({ leaderboard: [], criteria: { minTrades: MIN_TRADES, minDays: MIN_DAYS } }, request);
      }

      // One pull of all live agent trades; group per wallet in-worker, then score
      // each via the SAME shared helper /agents/standing uses (no drift).
      let rows = [];
      try {
        const res = await fetch(
          `${env.SUPABASE_URL}/rest/v1/agent_trades?select=wallet_address,pnl,closed_at&order=closed_at.desc&limit=10000`,
          { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
        );
        if (res.ok) rows = await res.json();
      } catch (e) { console.error("[leaderboard] supabase error:", e); }

      const rowsByWallet = {};
      for (const r of rows) {
        const w = (r.wallet_address || "").toLowerCase();
        if (!w) continue;
        (rowsByWallet[w] = rowsByWallet[w] || []).push(r);
      }

      const eligible = [];
      for (const [wallet, wRows] of Object.entries(rowsByWallet)) {
        const standing = agentStanding(aggregateAgentTrades(wRows));
        if (!standing.eligible) continue;
        eligible.push({ wallet, ...standing.stats });
      }

      eligible.sort((x, y) => y.score - x.score || y.netPnl - x.netPnl);
      const top = eligible.slice(0, TOP_N);

      // Enrich top entries with profile + copyable (strategy-only) config.
      const enriched = await Promise.all(top.map(async (e, i) => {
        const [configRaw, profileRaw] = await Promise.all([
          AGENT_KV.get(`agent:config:${e.wallet}`),
          env.LAB_STORE.get(`profile:${e.wallet}`),
        ]);
        const cfg = configRaw ? JSON.parse(configRaw) : null;
        const profile = profileRaw ? JSON.parse(profileRaw) : {};
        const sharedConfig = cfg ? {
          symbols: cfg.symbols, leverage: cfg.leverage, tpPercent: cfg.tpPercent,
          slPercent: cfg.slPercent, maxHoldHours: cfg.maxHoldHours,
          maxTradesPerDay: cfg.maxTradesPerDay, fundingThreshold: cfg.fundingThreshold,
        } : null;
        return {
          rank: i + 1, wallet: e.wallet,
          displayName: profile.displayName || null, pfp: profile.pfp || null,
          trades: e.trades, winRate: e.winRate, netPnl: e.netPnl,
          profitFactor: e.profitFactor, daysActive: e.daysActive, score: e.score,
          config: sharedConfig,
        };
      }));

      return json({ leaderboard: enriched, criteria: { minTrades: MIN_TRADES, minDays: MIN_DAYS } }, request);
    }

    // ── /agents/standing/:address — this agent's own leaderboard standing ──────
    // Tells an owner exactly WHY their agent is / isn't on the board (e.g. "2 of 3
    // criteria met — needs net-positive P&L") so an unranked-but-recording agent
    // reads as a known state, not a bug. Uses the SAME gate as the board.
    if (parts[0] === "agents" && parts[1] === "standing" && parts[2]) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
      const addr = String(parts[2]).toLowerCase();
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return json({ eligible: false, criteria: [], stats: null, criteriaConfig: AGENT_BOARD }, request);
      }
      let rows = [];
      try {
        const res = await fetch(
          `${env.SUPABASE_URL}/rest/v1/agent_trades?select=pnl,closed_at&wallet_address=ilike.${addr}&limit=10000`,
          { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
        );
        if (res.ok) rows = await res.json();
      } catch (e) { console.error("[standing] supabase error:", e); }
      return json({ ...agentStanding(aggregateAgentTrades(rows)), criteriaConfig: AGENT_BOARD }, request);
    }

    // ── /agents/ledger — verifiable, canonical hash of the agent trade ledger ──
    // Anyone can fetch the raw records, recompute the SHA-256 over the canonical
    // serialization, and confirm it matches `ledgerHash`. This makes every number
    // on the leaderboard provably derived from these exact records — no trust in
    // our DB required. Each read also checkpoints the hash into an append-only,
    // prev-linked chain (tamper-evidence over time). Anchor the latest root
    // on-chain (see /agents/ledger/chain) for full trustlessness.
    if (parts[0] === "agents" && parts[1] === "ledger") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
      const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;

      const sha256Hex = async (s) => {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      };

      // GET /agents/ledger/chain — the append-only checkpoint chain
      if (parts[2] === "chain") {
        const chainRaw = await AGENT_KV.get("agent:ledger:chain");
        const chain = chainRaw ? JSON.parse(chainRaw) : [];
        return json({ chain, length: chain.length, note: "Append-only, prev-linked SHA-256 checkpoints. Anchor the latest hash on-chain for full trustlessness." }, request);
      }

      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return json({ ledgerHash: null, count: 0, records: [] }, request);
      }

      let rows = [];
      try {
        const res = await fetch(
          `${env.SUPABASE_URL}/rest/v1/agent_trades?select=id,wallet_address,symbol,direction,entry_price,exit_price,qty,pnl,pnl_percent,reason,opened_at,closed_at&order=id.asc&limit=10000`,
          { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
        );
        if (res.ok) rows = await res.json();
      } catch (e) { console.error("[ledger] supabase error:", e); }

      // Canonical serialization: fixed field order per row, rows ordered by id.
      // Deterministic → any third party recomputes the identical hash.
      const FIELDS = ["id", "wallet_address", "symbol", "direction", "entry_price", "exit_price", "qty", "pnl", "pnl_percent", "reason", "opened_at", "closed_at"];
      const canonical = JSON.stringify(rows.map((r) => FIELDS.map((f) => r[f] ?? null)));
      const ledgerHash = await sha256Hex(canonical);

      // Checkpoint into the prev-linked chain only when the hash changes (dedup
      // so frequent reads don't spam the chain — it grows only as trades settle).
      try {
        const chainRaw = await AGENT_KV.get("agent:ledger:chain");
        const chain = chainRaw ? JSON.parse(chainRaw) : [];
        const last = chain[chain.length - 1];
        if (!last || last.ledgerHash !== ledgerHash) {
          const prevHash = last ? last.ledgerHash : "0".repeat(64);
          const linkHash = await sha256Hex(`${prevHash}:${ledgerHash}:${rows.length}`);
          chain.push({ ts: Date.now(), ledgerHash, prevHash, linkHash, count: rows.length });
          if (chain.length > 500) chain.shift();
          await AGENT_KV.put("agent:ledger:chain", JSON.stringify(chain));
        }
      } catch (e) { console.error("[ledger] chain checkpoint error:", e); }

      // On-chain anchor proof (written by nexus-ledger-anchor). `verified` is true
      // when the latest on-chain root matches the freshly computed ledger hash.
      let onChain = null;
      try {
        const ocRaw = await AGENT_KV.get("agent:ledger:onchain");
        if (ocRaw) {
          const oc = JSON.parse(ocRaw);
          onChain = { ...oc, verified: (oc.root || "").toLowerCase() === `0x${ledgerHash}`.toLowerCase() };
        }
      } catch { /* anchor not set up yet */ }

      return json({
        ledgerHash,
        algorithm: "sha256",
        canonicalForm: "JSON array of rows; each row = [" + FIELDS.join(", ") + "]; rows sorted by id asc",
        count: rows.length,
        generatedAt: Date.now(),
        onChain,
        records: rows,
      }, request);
    }

    // Theses family → routes-theses.mjs (migration rules in shared.mjs).
    {
      const thesesRes = await handleTheses(parts, request, env);
      if (thesesRes) return thesesRes;
    }
    if (parts[0] === "feed" && !parts[1]) {
      if (request.method !== "GET") {
        return json({ error: "method not allowed" }, request, 405);
      }
      // List all LAB_STORE keys, collect public theses across all wallets
      const listed = await env.LAB_STORE.list({ prefix: "lab:" });
      const feedItems = [];

      for (const key of listed.keys) {
        const raw = await env.LAB_STORE.get(key.name);
        if (!raw) continue;
        const data = JSON.parse(raw);
        const address = key.name.replace("lab:", "");

        // Fetch profile for this wallet (pfp + displayName)
        const profileRaw = await env.LAB_STORE.get(`profile:${address}`);
        const profile = profileRaw ? JSON.parse(profileRaw) : {};

        const publicTheses = (data.theses || []).filter((t) => t.isPublic === true);
        for (const thesis of publicTheses) {
          feedItems.push({
            ...thesis,
            wallet: address,
            pfp: profile.pfp || null,
            displayName: profile.displayName || null,
          });
        }
      }

      // Merge autonomous-agent calls (written per-user by nexus-agent-exec to
      // agent:feed:{address}). Gives the public feed a live heartbeat from the
      // bot's real trades instead of looking abandoned. Tagged agent:true under a
      // single "Nexus Agent" identity. Best-effort — never break /feed if the
      // agent namespace is unavailable. NOTE: these are NOT in lab:, so they never
      // leak into /theses/leaderboard or /theses/ledger (those read lab: only).
      try {
        const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
        const agentListed = await AGENT_KV.list({ prefix: "agent:feed:" });
        for (const key of agentListed.keys) {
          const raw = await AGENT_KV.get(key.name);
          if (!raw) continue;
          const items = JSON.parse(raw);
          const address = key.name.replace("agent:feed:", "");
          for (const t of items) {
            if (t.isPublic === false) continue;
            feedItems.push({ ...t, wallet: address, agent: true, pfp: null, displayName: "Nexus Agent" });
          }
        }
      } catch (e) {
        console.error("[feed] agent merge failed:", e);
      }

      // Sort newest first
      feedItems.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json({ feed: feedItems }, request);
    }

    // ── /feed/holders ──────────────────────────────────────
    // $NEXUS Holders Room: theses marked holdersOnly. Server-side gated — the
    // caller must pass ?address=&ts=&sig= — the signature proves wallet
    // ownership (EIP-191), and an on-chain balanceOf read on Base proves the
    // wallet holds the OPERATOR threshold. Signature + fresh timestamp defeats
    // address-spoofing and replay.
    if (parts[0] === "feed" && parts[1] === "holders") {
      if (request.method !== "GET") {
        return json({ error: "method not allowed" }, request, 405);
      }
      const url = new URL(request.url);
      const claimed = (url.searchParams.get("address") || "").toLowerCase();
      const ts = parseInt(url.searchParams.get("ts") || "0", 10);
      const sig = url.searchParams.get("sig") || "";
      if (!/^0x[0-9a-f]{40}$/.test(claimed)) {
        return json({ error: "address required" }, request, 400);
      }
      // 1) Signature must be fresh (10-min window) and recover to the claimed address.
      if (!ts || Math.abs(Date.now() - ts) > 600000) {
        return json({ error: "stale or missing timestamp" }, request, 401);
      }
      const recovered = recoverEthAddress(holdersRoomMessage(claimed, ts), sig);
      if (!recovered || recovered !== claimed) {
        return json({ error: "invalid signature" }, request, 401);
      }
      const NEXUS_TOKEN = "0x3D958634ab725B627919EF8F2Ed59227309fDba3";
      const OPERATOR_MIN = 50000000n * (10n ** 18n); // matches frontend TIER_THRESHOLDS (OPERATOR)
      // eth_call balanceOf(address)
      const callData = "0x70a08231000000000000000000000000" + claimed.slice(2);
      let isHolder = false;
      for (const rpc of ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.llamarpc.com"]) {
        try {
          const res = await fetch(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: NEXUS_TOKEN, data: callData }, "latest"] }),
          });
          const j = await res.json();
          if (j.result) { isHolder = BigInt(j.result) >= OPERATOR_MIN; break; }
        } catch (_) { /* try next rpc */ }
      }
      if (!isHolder) {
        return json({ error: "not a $NEXUS holder", feed: [] }, request, 403);
      }

      const listed = await env.LAB_STORE.list({ prefix: "lab:" });
      const feedItems = [];
      for (const key of listed.keys) {
        const raw = await env.LAB_STORE.get(key.name);
        if (!raw) continue;
        const data = JSON.parse(raw);
        const address = key.name.replace("lab:", "");
        const profileRaw = await env.LAB_STORE.get(`profile:${address}`);
        const profile = profileRaw ? JSON.parse(profileRaw) : {};
        const holderTheses = (data.theses || []).filter((t) => t.holdersOnly === true);
        for (const thesis of holderTheses) {
          feedItems.push({ ...thesis, wallet: address, pfp: profile.pfp || null, displayName: profile.displayName || null });
        }
      }
      feedItems.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json({ feed: feedItems }, request);
    }

    // ── /profile/:address ──────────────────────────────────
    if (parts[0] === "profile") {
      if (!parts[1]) return json({ error: "not found" }, request, 404);
      const address = normalizeAddress(parts[1]);
      const profileKey = `profile:${address}`;

      if (request.method === "GET") {
        const raw = await env.LAB_STORE.get(profileKey);
        if (!raw) return json({ pfp: null, displayName: null }, request);
        return json(JSON.parse(raw), request);
      }

      if (request.method === "PUT") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid json" }, request, 400);
        }
        // Only allow pfp (URL string) and displayName
        const profile = {
          pfp: typeof body.pfp === "string" ? body.pfp.trim().slice(0, 500) : null,
          displayName:
            typeof body.displayName === "string" ? body.displayName.trim().slice(0, 40) : null,
        };
        await env.LAB_STORE.put(profileKey, JSON.stringify(profile));
        return json({ ok: true }, request);
      }

      return json({ error: "method not allowed" }, request, 405);
    }

    // ── /lab/:address ──────────────────────────────────────
    if (parts[0] !== "lab" || !parts[1]) {
      return json({ error: "not found" }, request, 404);
    }

    const address = normalizeAddress(parts[1]);
    const kvKey = `lab:${address}`;

    // ── GET /lab/:address ──────────────────────────────────
    if (request.method === "GET") {
      const raw = await env.LAB_STORE.get(kvKey);
      if (!raw) {
        return json({ theses: [], notes: {} }, request);
      }
      return json(JSON.parse(raw), request);
    }

    // ── PUT /lab/:address ──────────────────────────────────
    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, request, 400);
      }

      if (!Array.isArray(body.theses) || typeof body.notes !== "object") {
        return json({ error: "expected { theses: [], notes: {} }" }, request, 400);
      }

      // Ph27/28: notify original author and increment copyCount when a thesis is copied
      if (body.copiedFromWallet && typeof body.copiedFromWallet === "string") {
        const originalWallet = normalizeAddress(body.copiedFromWallet);
        if (originalWallet !== address) {
          const symbol = typeof body.copiedThesisSymbol === "string"
            ? body.copiedThesisSymbol.replace("PERP_", "").replace("_USDC", "")
            : "unknown";
          const direction = typeof body.copiedThesisDirection === "string" ? ` ${body.copiedThesisDirection}` : "";

          // Ph28: increment copyCount on the original thesis
          if (body.copiedThesisId && typeof body.copiedThesisId === "string") {
            const origRaw = await env.LAB_STORE.get(`lab:${originalWallet}`);
            if (origRaw) {
              const origData = JSON.parse(origRaw);
              const origThesis = (origData.theses || []).find((t) => t.id === body.copiedThesisId);
              if (origThesis) {
                origThesis.copyCount = (origThesis.copyCount || 0) + 1;
                await env.LAB_STORE.put(`lab:${originalWallet}`, JSON.stringify(origData));
              }
            }
          }

          await appendNotification(env, originalWallet, {
            id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            type: "copy",
            message: `Someone copied your ${symbol}${direction} thesis`,
            fromWallet: address,
            createdAt: Date.now(),
          });
        }
      }

      // Strip copy metadata fields before persisting
      const { copiedFromWallet: _cfw, copiedThesisSymbol: _cts, copiedThesisDirection: _ctd, copiedThesisId: _cti, ...dataToSave } = body;
      await env.LAB_STORE.put(kvKey, JSON.stringify(dataToSave));
      return json({ ok: true }, request);
    }

    // ── DELETE /lab/:address/thesis/:id ────────────────────
    if (request.method === "DELETE" && parts[2] === "thesis" && parts[3]) {
      const thesisId = parts[3];
      const raw = await env.LAB_STORE.get(kvKey);
      if (!raw) return json({ ok: true }, request);

      const data = JSON.parse(raw);
      data.theses = (data.theses || []).filter((t) => t.id !== thesisId);
      await env.LAB_STORE.put(kvKey, JSON.stringify(data));
      return json({ ok: true }, request);
    }

    return json({ error: "method not allowed" }, request, 405);
    } catch (topErr) {
      return new Response(JSON.stringify({ error: "worker unhandled exception", detail: String(topErr), stack: topErr?.stack }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }
  },
};
