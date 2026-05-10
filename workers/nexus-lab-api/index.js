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

const ALLOWED_ORIGINS = [
  "https://trade.nexustradinglabs.com",
  "http://localhost:5173",
  "http://localhost:3000",
];

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(request) },
  });
}

function normalizeAddress(addr) {
  return addr.toLowerCase().trim();
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
function buildThesisOgSvg({ displayName, wallet, ticker, direction, entryPrice, stopLoss, takeProfit1, riskReward, status, notes, fontFamily = "'Courier New', Courier, monospace" }) {
  const shortAddr = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  const name = esc(displayName || shortAddr);
  const dirColor = direction === "LONG" ? "#00ff88" : "#ff4444";
  const dirArrow = direction === "LONG" ? "↑" : "↓";
  const rrColor = parseFloat(riskReward) >= 2 ? "#00ff88" : "#fbbf24";
  const statusMap = { HIT_TP: "HIT TP ✓", STOPPED_OUT: "STOPPED OUT", ACTIVE: "ACTIVE", INVALIDATED: "INVALIDATED" };
  const statusColorMap = { HIT_TP: "#00ff88", STOPPED_OUT: "#ff4444", ACTIVE: "#4a9fff", INVALIDATED: "#fbbf24" };
  const statusLabel = statusMap[status] || status;
  const statusColor = statusColorMap[status] || "#8aaa9a";
  const notesLine = notes ? esc(String(notes).slice(0, 90)) : "";

  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs><style>text { font-family: ${fontFamily}; }</style></defs>
  <rect width="1200" height="630" fill="#0a0e0a"/>
  <rect width="1200" height="3" fill="#00ff88" opacity="0.5"/>
  <rect y="627" width="1200" height="3" fill="#1a3a1a"/>
  <text x="48" y="54" fill="#2a4a3a" font-size="13" letter-spacing="3">NEXUS TRADING LABS</text>
  <text x="1152" y="54" fill="#2a4a3a" font-size="13" text-anchor="end">trade.nexustradinglabs.com</text>
  <text x="48" y="180" fill="#ffffff" font-size="86" font-weight="bold">${esc(ticker)}</text>
  <text x="48" y="232" fill="${dirColor}" font-size="32" font-weight="bold">${dirArrow} ${esc(direction)}</text>
  <text x="1152" y="180" fill="${statusColor}" font-size="22" font-weight="bold" text-anchor="end">${statusLabel}</text>
  <text x="1152" y="214" fill="#3a5a4a" font-size="14" text-anchor="end">${name}</text>
  <text x="1152" y="234" fill="#2a4a3a" font-size="12" text-anchor="end">${esc(shortAddr)}</text>
  <line x1="48" y1="270" x2="1152" y2="270" stroke="#1a2e1a" stroke-width="1"/>
  <text x="60" y="312" fill="#3a5a4a" font-size="12" letter-spacing="3">ENTRY</text>
  <text x="60" y="374" fill="#8aaa9a" font-size="52" font-weight="bold">$${parseFloat(entryPrice).toFixed(2)}</text>
  <text x="360" y="312" fill="#3a5a4a" font-size="12" letter-spacing="3">STOP</text>
  <text x="360" y="374" fill="#ff4444" font-size="52" font-weight="bold">$${parseFloat(stopLoss).toFixed(2)}</text>
  <text x="660" y="312" fill="#3a5a4a" font-size="12" letter-spacing="3">TP1</text>
  <text x="660" y="374" fill="#00ff88" font-size="52" font-weight="bold">$${parseFloat(takeProfit1).toFixed(2)}</text>
  <text x="960" y="312" fill="#3a5a4a" font-size="12" letter-spacing="3">R:R</text>
  <text x="960" y="374" fill="${rrColor}" font-size="52" font-weight="bold">1:${parseFloat(riskReward).toFixed(2)}</text>
  <line x1="48" y1="420" x2="1152" y2="420" stroke="#1a2e1a" stroke-width="1"/>
  ${notesLine ? `<text x="48" y="464" fill="#5a8a6a" font-size="16" font-style="italic">"${notesLine}"</text>` : ""}
  <line x1="48" y1="530" x2="1152" y2="530" stroke="#1a2e1a" stroke-width="1"/>
  <text x="48" y="572" fill="#2a4a3a" font-size="13" letter-spacing="1">on-chain thesis · arbitrum</text>
  <text x="1152" y="572" fill="#1a3a1a" font-size="13" text-anchor="end">${esc(wallet)}</text>
</svg>`;
}

// ── Ph17: On-chain wallet discovery ──────────────────────────────────────────
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
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
  async fetch(request, env) {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(request) });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

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
            font: { loadSystemFonts: false, fontFiles: [font] },
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
      const payload = {
        displayName: profile.displayName || null, wallet, ticker,
        direction: thesis.direction, entryPrice: thesis.entryPrice,
        stopLoss: thesis.stopLoss, takeProfit1: thesis.takeProfit1,
        riskReward: thesis.riskReward, status: thesis.status, notes: thesis.notes || "",
      };
      if (isPng) {
        try {
          await ensureResvg();
          const font = await getMonoFont();
          const svg = buildThesisOgSvg({ ...payload, fontFamily: "'JetBrains Mono'" });
          const resvg = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: [font] } });
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
      return json({ thesis: { ...thesis, wallet, pfp: profile.pfp || null, displayName: profile.displayName || null } }, request);
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

      const daysSince = Math.min(Math.ceil((Date.now() - thesis.createdAt) / 86400000) + 1, 365);
      try {
        const cgResp = await fetch(
          `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${daysSince}`,
          { headers: { Accept: "application/json" } }
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
      const { side, notional, leverage = 1, orderType = "MARKET", walletSig, walletAddress, stopLoss, takeProfit } = body;

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

        const qtyStep       = futuresInfo.base_tick ?? futuresInfo.qty_step ?? futuresInfo.base_min ?? 0.01;
        const minNotional   = futuresInfo.min_notional ?? futuresInfo.notional_step ?? 1;
        const validNotional = minNotional > 1 ? Math.floor(notional / minNotional) * minNotional : notional;
        const quantity      = Math.floor((validNotional / markPrice) * Math.round(1 / qtyStep)) / Math.round(1 / qtyStep);

        const authCheck = await orderlyRequest("GET", "/v1/client/holding", null);
        if (!authCheck.success) {
          return json({ error: "auth failed", detail: authCheck, hint: "key/secret mismatch" }, request, 401);
        }

        const lev            = Math.max(1, Number(leverage) || 1);
        const leverageResult = await orderlyRequest("POST", "/v1/client/leverage", { leverage: lev });
        const orderResult    = await orderlyRequest("POST", "/v1/order", {
          symbol, order_type: orderType.toUpperCase(), side: side.toUpperCase(), order_quantity: quantity,
        });

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
            trigger_price_type: "MARK_PRICE",
            child_orders: childOrders,
          };
          slTpResult = await orderlyRequest("POST", "/v1/algo/order", algoBody);
        }

        return json({
          ok: true, symbol, side: side.toUpperCase(), markPrice, qtyStep, minNotional,
          validNotional, quantity, notional, leverage: lev, leverageResult, order: orderResult,
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
      let closeSide2 = "BUY"; // default; overridden by actual position below
      try {
        const pd = await req2("GET", "/v1/positions", null);
        const pos2 = (pd?.data?.rows || []).find(p => p.symbol === sym2);
        if (pos2) {
          const rawQty = Number(pos2.position_qty);
          posQty = Math.abs(rawQty);
          // positive qty = LONG → close with SELL; negative qty = SHORT → close with BUY
          closeSide2 = rawQty >= 0 ? "SELL" : "BUY";
        }
      } catch (_) {}
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
        trigger_price_type: "MARK_PRICE",
        child_orders: childOrders2,
      };
      const algoRes = await req2("POST", "/v1/algo/order", algoB);
      return json({ ok: algoRes?.success ?? false, symbol: sym2, stopLoss: sl, takeProfit: tp, quantity: posQty, closeSide: closeSide2, raw: algoRes }, request);
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
    // Accepts walletSig as query param ?wallet=&sig= or POST body { walletAddress, walletSig }
    if ((parts[0] === "positions" || parts[0] === "balance") && (request.method === "GET" || request.method === "POST")) {
      const qp = new URL(request.url).searchParams;
      let wAddr = qp.get("wallet");
      let wSig  = qp.get("sig");
      if (request.method === "POST") {
        let pb; try { pb = await request.json(); } catch { pb = {}; }
        wAddr = wAddr || pb.walletAddress;
        wSig  = wSig  || pb.walletSig;
      }
      if (!wAddr || !wSig) return json({ error: "wallet and sig required" }, request, 400);
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

      const { wallet, amount, accountId } = body;
      if (!wallet || !amount || !accountId) {
        return json({ error: "wallet, amount (USDC), and accountId required" }, request, 400);
      }

      // Orderly vault constants (Arbitrum One)
      const VAULT    = "0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9";
      const USDC     = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
      const ARB_RPC  = "https://arb1.arbitrum.io/rpc";

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
        const VC_W           = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
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
        // NOTE: verifyingContract must NOT be in the POST body — only in the EIP-712 domain for signing
        const withdrawRes = await oReq("POST", "/v1/withdraw_request", {
          message: withdrawMsg,
          signature: wSignData.signature,
          userAddress: walletNorm,
        });

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
          await env.LAB_STORE.put("user:" + walletNorm, JSON.stringify({
            accountId, orderlyKey, registeredAt: Date.now(),
          }));
          return json({ ok: true, walletAddress: walletNorm, orderlyKey, accountId }, request);
        } else {
          return json({ error: "Orderly registration failed", detail: regData }, request, 400);
        }
      } catch (e) {
        return json({ error: "registration failed", detail: String(e) }, request, 500);
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

    // ── /feed ──────────────────────────────────────────────
    if (parts[0] === "feed") {
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

      // Sort newest first
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
  },
};
