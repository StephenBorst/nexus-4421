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
    if (parts[0] === "trade" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }

      const { symbol, side, notional, leverage = 1, orderType = "MARKET" } = body;
      if (!symbol || !side || !notional) {
        return json({ error: "symbol, side, and notional (USDC) required" }, request, 400);
      }
      // Debug: surface which secrets are missing without exposing values
      const secretDebug = {
        ORDERLY_API_SECRET: typeof env.ORDERLY_API_SECRET === "string" ? `set(${env.ORDERLY_API_SECRET.length}chars)` : String(env.ORDERLY_API_SECRET),
        ORDERLY_API_KEY:    typeof env.ORDERLY_API_KEY    === "string" ? `set(${env.ORDERLY_API_KEY.length}chars)`    : String(env.ORDERLY_API_KEY),
        ORDERLY_ACCOUNT_ID: typeof env.ORDERLY_ACCOUNT_ID === "string" ? `set(${env.ORDERLY_ACCOUNT_ID.length}chars)` : String(env.ORDERLY_ACCOUNT_ID),
      };
      if (!env.ORDERLY_API_SECRET || !env.ORDERLY_API_KEY || !env.ORDERLY_ACCOUNT_ID) {
        return json({ error: "Orderly credentials not configured", debug: secretDebug }, request, 500);
      }

      const ORDERLY_BASE = "https://api-evm.orderly.org";
      const accountId = env.ORDERLY_ACCOUNT_ID;

      // Ed25519 sign using Web Crypto API (native in CF Workers)
      async function orderlySign(method, path, bodyStr) {
        const timestamp = Date.now();
        const message = `${timestamp}${method.toUpperCase()}${path}${bodyStr || ""}`;
        const msgBytes = new TextEncoder().encode(message);

        // Private key — supports both raw 32-byte seed and full 48-byte PKCS8
        let pkcs8Bytes = Uint8Array.from(atob(env.ORDERLY_API_SECRET), c => c.charCodeAt(0));
        if (pkcs8Bytes.length === 32) {
          // Wrap raw seed into PKCS8 DER: 16-byte header + 32-byte seed
          const hdr = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
          const full = new Uint8Array(48);
          full.set(hdr, 0);
          full.set(pkcs8Bytes, 16);
          pkcs8Bytes = full;
        }
        const key = await crypto.subtle.importKey("pkcs8", pkcs8Bytes, { name: "Ed25519" }, false, ["sign"]);
        const sigBytes = new Uint8Array(await crypto.subtle.sign("Ed25519", key, msgBytes));

        // Base64url encode signature
        const sig = btoa(String.fromCharCode(...sigBytes))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

        return {
          "Content-Type": "application/json",
          "orderly-timestamp": timestamp.toString(),
          "orderly-account-id": accountId,
          "orderly-key": env.ORDERLY_API_KEY,   // format: ed25519:base58pubkey
          "orderly-signature": sig,
        };
      }

      async function orderlyRequest(method, path, data) {
        const bodyStr = data ? JSON.stringify(data) : undefined;
        const headers = await orderlySign(method, path, bodyStr);
        const res = await fetch(`${ORDERLY_BASE}${path}`, { method, headers, body: bodyStr });
        return res.json();
      }

      try {
        // 1. Get mark price + instrument info (public endpoint)
        const priceRes = await fetch(`${ORDERLY_BASE}/v1/public/futures/${symbol}`);
        const priceData = await priceRes.json();
        const futuresInfo = priceData?.data || {};
        const markPrice  = futuresInfo.mark_price;
        if (!markPrice) return json({ error: "failed to fetch mark price", symbol, raw: priceData }, request, 502);

        // qty_step: try known field names, fallback to 0.01
        const qtyStep = futuresInfo.base_tick ?? futuresInfo.qty_step ?? futuresInfo.base_min ?? 0.01;

        // min_notional: Orderly enforces notional steps per symbol (e.g. $15 for SOL)
        // Round notional DOWN to nearest valid step
        const minNotional = futuresInfo.min_notional ?? futuresInfo.notional_step ?? 1;
        const validNotional = minNotional > 1
          ? Math.floor(notional / minNotional) * minNotional
          : notional;

        // 2. Compute quantity rounded to symbol's qty step
        const rawQty = validNotional / markPrice;
        const stepDivisor = Math.round(1 / qtyStep);
        const quantity = Math.floor(rawQty * stepDivisor) / stepDivisor;

        // 3. Verify auth — GET /v1/client/holding (read-only, signed)
        const authCheck = await orderlyRequest("GET", "/v1/client/holding", null);
        if (!authCheck.success) {
          return json({ error: "auth failed", detail: authCheck, hint: "check ORDERLY_API_KEY/SECRET match" }, request, 401);
        }

        // 4. Set leverage — Orderly EVM uses /v1/client/leverage (account-level)
        const lev = Math.max(1, Number(leverage) || 1);
        let leverageResult = await orderlyRequest("POST", "/v1/client/leverage", {
          leverage: lev,
        });

        // 5. Place order
        const orderPayload = {
          symbol,
          order_type: orderType.toUpperCase(),
          side: side.toUpperCase(),
          order_quantity: quantity,
        };

        const orderResult = await orderlyRequest("POST", "/v1/order", orderPayload);

        return json({
          ok: true,
          symbol,
          side: side.toUpperCase(),
          markPrice,
          qtyStep,
          minNotional,
          validNotional,
          quantity,
          notional,
          leverage: lev,
          leverageResult,
          order: orderResult,
        }, request);

      } catch (e) {
        return json({ error: "trade execution failed", detail: String(e) }, request, 500);
      }
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

    // ── /proxy/register-key — server-side proxy to Orderly (avoids browser CORS) ──
    if (parts[0] === "proxy" && parts[1] === "register-key" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }

      // Correct Orderly EVM endpoint (verified from @orderly.network/core source)
      const ACCOUNT_ID_HDR = "0x3b9986c6410a4b7649abd071c5ba367862578d8aafd8d4794060fbb91f592ae2";
      try {
        const r = await fetch("https://api-evm.orderly.org/v1/orderly_key", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Account-Id": ACCOUNT_ID_HDR,
          },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        return new Response(JSON.stringify(d), {
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

    // ── /register-orderly-key — browser-based Orderly key registration ───────
    if (parts[0] === "register-orderly-key" && request.method === "GET") {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nexus — Register Orderly Trading Key</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{max-width:660px;width:100%}
h1{color:#00ff88;font-size:1.1rem;letter-spacing:2px;margin-bottom:4px}
p.sub{color:#555;font-size:.75rem;margin-bottom:20px}
.card{background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin:12px 0}
.label{color:#555;font-size:.7rem;letter-spacing:2px;margin-bottom:6px;text-transform:uppercase}
.value{color:#00ff88;word-break:break-all;font-size:.82rem;line-height:1.5}
.secret{color:#ff9966;word-break:break-all;font-size:.82rem;line-height:1.5}
button{width:100%;background:#00ff88;color:#000;border:none;padding:13px;border-radius:6px;font-family:monospace;font-size:.9rem;font-weight:bold;cursor:pointer;margin:8px 0;letter-spacing:1px;transition:opacity .2s}
button:disabled{opacity:.3;cursor:not-allowed}
.status{padding:12px 14px;border-radius:6px;font-size:.82rem;margin:8px 0;line-height:1.5}
.ok{background:#001a0e;border:1px solid #00ff88;color:#00ff88}
.err{background:#1a0000;border:1px solid #ff4444;color:#ff4444}
.cmd{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:6px;padding:12px 14px;margin:6px 0;color:#ffcc00;font-size:.78rem;word-break:break-all;line-height:1.6}
.step{color:#555;font-size:.72rem;letter-spacing:1px;margin:16px 0 4px}
</style>
</head>
<body>
<div class="wrap">
  <h1>⚡ NEXUS — REGISTER ORDERLY TRADING KEY</h1>
  <p class="sub">Generates an ed25519 keypair in-browser. Private key never leaves this page. Registers with MetaMask signature.</p>

  <div class="card" id="keypair-card">
    <div class="label">Status</div>
    <div class="value" id="gen-status">Generating keypair…</div>
  </div>

  <div id="keys-section" style="display:none">
    <div class="card">
      <div class="label">Orderly Key — Public (safe to share)</div>
      <textarea id="pub-key" readonly onclick="this.select()" style="width:100%;background:#0d0d0d;border:none;color:#00ff88;font-family:monospace;font-size:.82rem;resize:none;padding:4px;outline:none;cursor:pointer;line-height:1.5" rows="2"></textarea>
      <button onclick="navigator.clipboard.writeText(document.getElementById('pub-key').value)" style="width:auto;padding:6px 16px;font-size:.75rem;margin:4px 0 0">Copy Public Key</button>
    </div>
    <div class="card">
      <div class="label">⚠️ Private Key — Base64 (secret — copy this BEFORE signing)</div>
      <textarea id="priv-key" readonly onclick="this.select()" style="width:100%;background:#0d0d0d;border:none;color:#ff9966;font-family:monospace;font-size:.82rem;resize:none;padding:4px;outline:none;cursor:pointer;line-height:1.5" rows="2"></textarea>
      <button onclick="navigator.clipboard.writeText(document.getElementById('priv-key').value)" style="width:auto;padding:6px 16px;font-size:.75rem;margin:4px 0 0">Copy Private Key</button>
    </div>
  </div>

  <button id="register-btn" disabled>Connect MetaMask &amp; Register</button>

  <div id="status-area"></div>

  <div id="commands-area" style="display:none">
    <div class="step">RUN THESE 3 COMMANDS IN YOUR TERMINAL (nexus-lab-api dir):</div>
    <div class="cmd" id="cmd1"></div>
    <div class="cmd" id="cmd2"></div>
    <div class="cmd" id="cmd3"></div>
    <div class="cmd" id="cmd4" style="margin-top:12px;border-color:#00ff88">npx wrangler deploy</div>
  </div>
</div>

<script>
const ORDERLY_BASE   = "https://api-evm.orderly.org";
const BROKER_ID      = "nexus_trading";
const CHAIN_ID       = 42161;
const ACCOUNT_ID     = "0x3b9986c6410a4b7649abd071c5ba367862578d8aafd8d4794060fbb91f592ae2";
const VERIFYING_CONTRACT = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function toBase58(buf){
  const bytes = new Uint8Array(buf);
  let n = BigInt("0x"+[...bytes].map(b=>b.toString(16).padStart(2,"0")).join(""));
  let r=""; while(n>0n){r=B58[Number(n%58n)]+r;n=n/58n;}
  for(const b of bytes){if(b===0)r="1"+r;else break;}
  return r;
}
function toB64(buf){ return btoa(String.fromCharCode(...new Uint8Array(buf))); }

let privKeyB64="", orderlyKey="", _privCryptoKey;

async function gen(){
  try{
    const kp = await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]);
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
    const raw   = await crypto.subtle.exportKey("raw",   kp.publicKey);
    // Store full PKCS8 (48 bytes) — CF Workers requires pkcs8 format for Ed25519 signing
    privKeyB64 = toB64(pkcs8);
    orderlyKey = "ed25519:" + toBase58(raw);
    _privCryptoKey = kp.privateKey;
    document.getElementById("gen-status").textContent = "✅ Keypair ready — copy your private key before signing!";
    document.getElementById("keys-section").style.display="block";
    document.getElementById("pub-key").value = orderlyKey;
    document.getElementById("priv-key").value = privKeyB64;
    document.getElementById("register-btn").disabled = false;
  }catch(e){
    document.getElementById("gen-status").textContent = "❌ "+e.message;
  }
}

async function register(){
  const btn = document.getElementById("register-btn");
  btn.disabled=true; btn.textContent="Connecting…";
  try{
    if(!window.ethereum) throw new Error("MetaMask not found — open this page in a browser with MetaMask installed");
    const accounts = await ethereum.request({method:"eth_requestAccounts"});
    const wallet = accounts[0];

    // Switch to Arbitrum if needed
    try{ await ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:"0xa4b1"}]}); }catch(_){}

    btn.textContent="Sign with MetaMask…";
    const ts  = Date.now();
    const exp = ts + 365*24*60*60*1000;
    const message = {brokerId:BROKER_ID,chainId:CHAIN_ID,orderlyKey:orderlyKey,scope:"read,trading",timestamp:ts,expiration:exp};
    const typedData = {
      types:{
        EIP712Domain:[{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}],
        AddOrderlyKey:[
          {name:"brokerId",type:"string"},{name:"chainId",type:"uint256"},{name:"orderlyKey",type:"string"},
          {name:"scope",type:"string"},{name:"timestamp",type:"uint64"},{name:"expiration",type:"uint64"}
        ]
      },
      primaryType:"AddOrderlyKey",
      domain:{name:"Orderly",version:"1",chainId:CHAIN_ID,verifyingContract:VERIFYING_CONTRACT},
      message
    };
    const sig = await ethereum.request({method:"eth_signTypedData_v4",params:[wallet,JSON.stringify(typedData)]});

    btn.textContent="Registering with Orderly…";
    const res = await fetch("/proxy/register-key",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message,signature:sig,userAddress:wallet})
    });
    const data = await res.json();
    console.log("Orderly response:",data);

    if(data.success||data.data){
      document.getElementById("status-area").innerHTML='<div class="status ok">✅ Key registered with Orderly! Run the commands below.</div>';
      document.getElementById("commands-area").style.display="block";
      document.getElementById("cmd1").textContent="npx wrangler secret put ORDERLY_API_SECRET\\n  → paste: "+privKeyB64;
      document.getElementById("cmd2").textContent="npx wrangler secret put ORDERLY_API_KEY\\n  → paste: "+orderlyKey;
      document.getElementById("cmd3").textContent="npx wrangler secret put ORDERLY_ACCOUNT_ID\\n  → paste: "+ACCOUNT_ID;
      btn.textContent="✅ Registered";
    } else {
      throw new Error(JSON.stringify(data));
    }
  }catch(e){
    document.getElementById("status-area").innerHTML='<div class="status err">❌ '+e.message+'</div>';
    btn.disabled=false; btn.textContent="Retry";
  }
}

gen();
document.getElementById("register-btn").addEventListener("click",register);
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
