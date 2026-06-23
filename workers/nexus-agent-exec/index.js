// ═══════════════════════════════════════════════════════════
// nexus-agent-exec — Multi-User Execution Engine
// Cron: every 1 minute
// KV binding: NEXUS_AGENT
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY
//
// Reads agent:users → for each active user:
//   - Checks kill switch
//   - If holding position → monitor TP/SL/timeout
//   - If no position → read signal → execute if conditions met
//   - Logs trades to Supabase
// ═══════════════════════════════════════════════════════════

import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import { snapQty, shouldResetDaily, dailyCapBlocked, computePnl, exitReason, agentThesisLevels, agentCloseStatus, volScaledLevels } from "./logic.mjs";

const ORDERLY_API = "https://api-evm.orderly.org";
const COOLDOWN_MS = 15 * 60 * 1000; // 15 min between trades

// ── Agent → public Feed bridge ────────────────────────────────────────────────
// Surfaces the bot's real autonomous trades on the public feed so it has a live
// heartbeat instead of looking abandoned (cold-start fix). Records are written
// per-user to agent:feed:{address} (single-writer: only this user's processUser
// touches its own key, so no cross-user race). lab-api's /feed merges them.
// Re-enabled: the agent's win rate / track record is already public on the agents
// leaderboard, so withholding entries from the feed wasn't actually hiding the
// performance — it just made the agent look abandoned. The OWNER always sees full
// truth on their dash; this surfaces real autonomous entries/closes publicly again.
const PUBLISH_AGENT_FEED = true;
// Keep simulated PAPER trades OUT of the public feed — the feed is the "these are
// real calls" surface and mixing sims (even labeled) dilutes the trust moat.
const PUBLISH_PAPER_TO_FEED = false;
const AGENT_FEED_CAP = 12; // keep the last N agent calls per user

// Build + store a public feed thesis for a fresh agent entry; returns its id so
// the close path can find and resolve it. Shape matches the human-thesis feed
// record so the existing feed UI renders it unchanged.
async function publishAgentEntry(address, env, { config, signal, markPrice, qty }) {
  const now = Date.now();
  const { stopLoss, takeProfit1, riskReward } = agentThesisLevels({
    entryPrice: markPrice, direction: signal.direction,
    tpPercent: config.tpPercent, slPercent: config.slPercent,
  });
  const record = {
    id: `agent_${address.slice(2, 8)}_${now}`,
    symbol: signal.symbol,
    direction: signal.direction,
    entryPrice: markPrice,
    stopLoss,
    takeProfit1,
    takeProfit2: 0,
    riskReward,
    positionSize: qty * markPrice,
    leverage: config.leverage,
    status: "ACTIVE",
    actualPnl: null,
    createdAt: now,
    notes: `Autonomous agent entry on a funding + OI-divergence confluence signal (confidence ${signal.confidence}%). Plan: TP +${config.tpPercent}% / SL -${config.slPercent}% / ${config.maxHoldHours}h max hold.`,
    isPublic: true,
    agent: true,
  };
  const raw = await env.NEXUS_AGENT.get(`agent:feed:${address}`);
  const list = raw ? JSON.parse(raw) : [];
  list.unshift(record);
  if (list.length > AGENT_FEED_CAP) list.length = AGENT_FEED_CAP;
  await env.NEXUS_AGENT.put(`agent:feed:${address}`, JSON.stringify(list));
  return record.id;
}

// Resolve a published agent thesis when its position closes.
async function publishAgentClose(address, env, feedId, { reason, pnlUsdc, exitPrice }) {
  if (!feedId) return;
  const raw = await env.NEXUS_AGENT.get(`agent:feed:${address}`);
  if (!raw) return;
  const list = JSON.parse(raw);
  const item = list.find((t) => t.id === feedId);
  if (!item) return;
  item.status = agentCloseStatus(reason);
  item.actualPnl = pnlUsdc;
  item.exitPrice = exitPrice;
  item.closedAt = Date.now();
  await env.NEXUS_AGENT.put(`agent:feed:${address}`, JSON.stringify(list));
}

// ── Decrypt the trading key stored at rest (AES-256-GCM, "v1:<iv>:<ct>") ──────
// Legacy plaintext keys (no "v1:" prefix) are passed through for backward compat
// until the user re-activates and the key is re-stored encrypted.
async function decryptTradingKey(stored, env) {
  if (typeof stored !== "string" || !stored.startsWith("v1:")) return stored; // legacy plaintext
  if (!env.AGENT_ENC_KEY) throw new Error("AGENT_ENC_KEY not configured");
  const [, ivB64, ctB64] = stored.split(":");
  const rawKey = Uint8Array.from(atob(env.AGENT_ENC_KEY), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// Sign Orderly API request with a user's delegated trading key.
//
// Proven pattern from the original single-user bot (Session Handoff 012):
//   - Orderly secret keys are 44-char base58-encoded 32-byte ed25519 seeds.
//   - Web Crypto (crypto.subtle) CANNOT sign with raw ed25519 seeds — must use
//     @noble/ed25519 signAsync(), which handles seed expansion internally.
//   - Signatures must be base64URL (not standard base64): +→-, /→_, strip =.
//   - The orderly-key header is the PUBLIC key (ed25519: prefix), derived from
//     the private key — NOT a slice of the secret.
async function orderlyRequest(keyData, method, path, body = null) {
  const timestamp = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : "";
  const secret = keyData.tradingKey.replace(/^ed25519:/, "");
  const privKey = bs58.decode(secret);

  const message = `${timestamp}${method}${path}${bodyStr}`;
  const sig = await ed.signAsync(new TextEncoder().encode(message), privKey);
  const signature = btoa(String.fromCharCode(...sig))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const pubKeyBytes = await ed.getPublicKeyAsync(privKey);
  const orderlyKey = `ed25519:${bs58.encode(pubKeyBytes)}`;

  // Orderly expects application/json for POST/PUT bodies and
  // application/x-www-form-urlencoded for GET (per Handoff 012).
  const contentType = method === "GET"
    ? "application/x-www-form-urlencoded"
    : "application/json";

  const res = await fetch(`${ORDERLY_API}${path}`, {
    method,
    headers: {
      "Content-Type": contentType,
      "orderly-timestamp": timestamp,
      "orderly-account-id": keyData.accountId,
      "orderly-key": orderlyKey,
      "orderly-signature": signature,
    },
    body: body ? bodyStr : undefined,
  });

  return res.json();
}

// Per-invocation mark-price cache. The public futures price is identical for
// every user watching a symbol, so fetch it once per symbol per tick instead of
// once per user. Stores the in-flight promise so concurrent users in a batch
// dedupe onto the same request.
function getMarkPrice(symbol, env, cache) {
  if (!cache.has(symbol)) {
    cache.set(symbol, (async () => {
      const res = await fetch(`${ORDERLY_API}/v1/public/futures/${symbol}`);
      const data = await res.json();
      return parseFloat(data.data.mark_price);
    })());
  }
  return cache.get(symbol);
}

const BATCH_SIZE = 10; // bounded concurrency — fast without hammering the APIs

export default {
  // Read-only health/heartbeat endpoint for ops monitoring.
  async fetch(request, env) {
    let users = 0, lastTick = null;
    try {
      const u = await env.NEXUS_AGENT.get("agent:users");
      users = u ? JSON.parse(u).length : 0;
      lastTick = await env.NEXUS_AGENT.get("ops:exec:heartbeat");
    } catch (e) { return new Response("boot error: " + e.message, { status: 500 }); }
    const tickAgeSec = lastTick ? Math.round((Date.now() - Number(lastTick)) / 1000) : null;
    return new Response(JSON.stringify({ ok: true, users, lastTickAgeSec: tickAgeSec }), { headers: { "content-type": "application/json" } });
  },

  async scheduled(event, env) {
    try {
      // Heartbeat so ops can monitor that the 1-min cron is firing (mirrors the
      // brain's ops:brain:heartbeat). Cheap; lets us distinguish "agent idle by
      // design" from "exec cron actually stopped".
      await env.NEXUS_AGENT.put("ops:exec:heartbeat", String(Date.now()));
      const usersRaw = await env.NEXUS_AGENT.get("agent:users");
      if (!usersRaw) return;
      const users = JSON.parse(usersRaw);
      if (users.length === 0) return;

      // One shared price cache for the whole tick.
      const priceCache = new Map();

      // Process users in bounded-concurrency batches: O(users/BATCH) wall-clock
      // instead of O(users), while the price cache keeps public fetches at
      // O(unique symbols) regardless of user count.
      for (let i = 0; i < users.length; i += BATCH_SIZE) {
        const batch = users.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map((address) =>
            processUser(address, env, priceCache).catch((e) =>
              console.error(`[exec] ${address.slice(0, 10)} error:`, e.message)
            )
          )
        );
      }
    } catch (e) {
      console.error("[exec] fatal:", e.message);
    }
  },
};

async function processUser(address, env, cache) {
  const [stateRaw, killRaw] = await Promise.all([
    env.NEXUS_AGENT.get(`agent:state:${address}`),
    env.NEXUS_AGENT.get(`agent:kill:${address}`),
  ]);
  if (!stateRaw) return;
  const state = JSON.parse(stateRaw);

  // Kill switch — honored via a DEDICATED agent:kill key (set by lab-api) so an
  // emergency stop can never be lost to a state-write race. Legacy in-flight
  // state.kill_requested is still respected for backward compatibility.
  if (killRaw || state.kill_requested) {
    if (state.current_position) {
      await closePosition(address, state, env, "KILLED", cache);
    }
    state.active = false;
    state.kill_requested = false;
    state.current_position = null;
    await env.NEXUS_AGENT.put(`agent:state:${address}`, JSON.stringify(state));
    await env.NEXUS_AGENT.delete(`agent:kill:${address}`); // consume the flag
    console.log(`[exec] ${address.slice(0, 10)} KILLED`);
    return;
  }

  if (!state.active) return;

  // Read config
  const configRaw = await env.NEXUS_AGENT.get(`agent:config:${address}`);
  if (!configRaw) return;
  const config = JSON.parse(configRaw);

  // Daily reset check. Persist immediately when it fires — otherwise the reset
  // only mutates the in-memory state and is lost unless the agent happens to
  // trade this tick, leaving the API/UI showing a stale trades_today/daily_pnl.
  const now = Date.now();
  if (shouldResetDaily(state.last_reset, now)) {
    state.daily_pnl = 0;
    state.trades_today = 0;
    state.last_reset = now;
    await env.NEXUS_AGENT.put(`agent:state:${address}`, JSON.stringify(state));
  }

  // Daily limits check (tested in logic.mjs)
  const cap = dailyCapBlocked(state, config);
  if (cap.blocked) {
    console.log(`[exec] ${address.slice(0, 10)} ${cap.reason}`);
    return;
  }

  // ── HOLDING POSITION ──────────────────────────────────
  if (state.current_position) {
    await monitorPosition(address, state, config, env, cache);
    return;
  }

  // ── NO POSITION — CHECK FOR SIGNAL ────────────────────
  const signalRaw = await env.NEXUS_AGENT.get(`agent:signal:${address}`);
  if (!signalRaw) return;
  const signal = JSON.parse(signalRaw);

  // Signal must be recent (< 10 min old)
  if (now - signal.timestamp > 10 * 60 * 1000) return;
  if (signal.direction === "NONE") return;
  if (signal.confidence < 50) return;

  // Cooldown check
  if (state.last_trade_time && now - state.last_trade_time < COOLDOWN_MS) return;

  // Mode check
  if (config.mode === "ASSISTED") {
    // In assisted mode — generate a thesis for review, don't execute.
    const pendingRaw = await env.NEXUS_AGENT.get(`agent:pending:${address}`);
    const pending = pendingRaw ? JSON.parse(pendingRaw) : [];

    // Dedupe: the exec runs every minute and ASSISTED never sets last_trade_time,
    // so without this the same signal floods the queue. Only add a new thesis if
    // the most recent one differs in symbol/direction OR is older than the cooldown.
    const latest = pending[0];
    const isDuplicate = latest
      && latest.symbol === signal.symbol
      && latest.direction === signal.direction
      && (now - latest.generatedAt) < COOLDOWN_MS;
    if (isDuplicate) {
      console.log(`[exec] ${address.slice(0, 10)} ASSISTED signal unchanged, skipping duplicate thesis`);
      return;
    }

    const thesis = {
      id: `agent_${now}`,
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: signal.price,
      confidence: signal.confidence,
      funding: signal.funding,
      source: "AGENT",
      generatedAt: now,
      status: "PENDING_REVIEW",
    };
    pending.unshift(thesis);
    if (pending.length > 20) pending.pop(); // keep last 20
    await env.NEXUS_AGENT.put(`agent:pending:${address}`, JSON.stringify(pending));
    console.log(`[exec] ${address.slice(0, 10)} ASSISTED thesis generated: ${signal.direction} ${signal.symbol}`);
    return;
  }

  // ── AUTONOMOUS MODE — EXECUTE ─────────────────────────
  await enterPosition(address, state, config, signal, env, cache);
}

async function enterPosition(address, state, config, signal, env, cache) {
  // PAPER mode simulates the full trade lifecycle without ever touching a real
  // trading key or placing a live order. Everything else (sizing, mark price,
  // TP/SL/timeout management, daily limits) runs identically so results are
  // realistic — they're just recorded to a separate paper ledger in state.
  const paper = config.mode === "PAPER";

  const symbol = signal.symbol;
  const side = signal.direction === "SHORT" ? "SELL" : "BUY";

  // Fetch current mark price (shared per-symbol cache) + tick size
  const markPrice = await getMarkPrice(symbol, env, cache);

  // Fetch symbol info for step size + min order constraints
  const infoRes = await fetch(`${ORDERLY_API}/v1/public/info/${symbol}`);
  const infoData = await infoRes.json();
  const info = infoData.data || {};
  const baseTick = info.base_tick || 0.001;
  const baseMin = info.base_min || baseTick;
  const minNotional = info.min_notional || 0;

  // Calculate qty, snapped to base_tick (tested in logic.mjs — guards the
  // -1104 step-size float artifact + base_min / min_notional constraints).
  const snap = snapQty({
    capitalPerTrade: config.capitalPerTrade, leverage: config.leverage,
    markPrice, baseTick, baseMin, minNotional,
  });
  if (!snap.ok) {
    console.error(`[exec] ${address.slice(0, 10)} ${snap.reason} for ${symbol}`);
    return;
  }
  const qty = snap.qty;

  let orderId = null;
  if (!paper) {
    const keyRaw = await env.NEXUS_AGENT.get(`agent:key:${address}`);
    if (!keyRaw) { console.error(`[exec] no key for ${address.slice(0, 10)}`); return; }
    const keyData = JSON.parse(keyRaw);
    keyData.tradingKey = await decryptTradingKey(keyData.tradingKey, env);

    // Set leverage
    await orderlyRequest(keyData, "POST", "/v1/client/leverage", {
      symbol, leverage: config.leverage,
    });

    // Place market order
    const order = await orderlyRequest(keyData, "POST", "/v1/order", {
      symbol,
      order_type: "MARKET",
      side,
      order_quantity: qty,
      broker_id: "nexus_trading",
    });

    if (order.success === false) {
      console.error(`[exec] ${address.slice(0, 10)} order failed:`, JSON.stringify(order));
      return;
    }
    orderId = order.data?.order_id;
  }

  // Effective TP/SL — fixed config %, or volatility-scaled to recent ATR (opt-in
  // config.volScaledStops). Resolved per-entry + stored on the position so the
  // monitor exits on THESE levels, not the flat config %. Computed for paper too,
  // so PAPER validates the exact behavior before anyone goes live with it.
  let effTp = config.tpPercent, effSl = config.slPercent;
  if (config.volScaledStops) {
    const atrPct = await fetchAtrPct(symbol, env);
    const lv = volScaledLevels(atrPct, config);
    effTp = lv.tpPercent; effSl = lv.slPercent;
    console.log(`[exec] ${address.slice(0, 10)} volScaledStops atr%=${atrPct == null ? "n/a" : atrPct.toFixed(2)} → tp=${effTp} sl=${effSl}`);
  }

  // Update state
  state.current_position = {
    symbol,
    direction: signal.direction,
    entry_price: markPrice,
    current_price: markPrice,
    pnl_percent: 0,
    qty,
    opened_at: Date.now(),
    order_id: orderId,
    paper,
    tpPercent: effTp,
    slPercent: effSl,
  };
  state.last_trade_time = Date.now();
  state.trades_today = (state.trades_today || 0) + 1;

  // Publish to the public feed (real trades only by default). Store the feed id
  // on the position so the close path can resolve it. Best-effort — a feed write
  // failure must never block the actual trade lifecycle.
  if (PUBLISH_AGENT_FEED && (!paper || PUBLISH_PAPER_TO_FEED)) {
    try {
      state.current_position.feed_id = await publishAgentEntry(address, env, { config, signal, markPrice, qty });
    } catch (e) {
      console.error(`[exec] ${address.slice(0, 10)} agent feed publish failed:`, e.message);
    }
  }

  await env.NEXUS_AGENT.put(`agent:state:${address}`, JSON.stringify(state));

  console.log(`[exec] ${address.slice(0, 10)} ${paper ? "PAPER " : ""}ENTER ${signal.direction} ${symbol} @ ${markPrice} qty=${qty}`);
}

// ATR as a % of price from recent 1h candles (public /tv/history). Used to scale
// the agent's stop to each symbol's real volatility (opt-in volScaledStops).
async function fetchAtrPct(symbol, env, periods = 14) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - (periods + 5) * 3600;
    const r = await fetch(`https://api-evm.orderly.org/tv/history?symbol=${symbol}&resolution=60&from=${from}&to=${now}`);
    const d = await r.json();
    if (!d || d.s !== "ok" || !Array.isArray(d.t) || d.t.length < 3) return null;
    const { h: H, l: L, c: C, t } = d;
    const n = t.length;
    let trSum = 0, cnt = 0;
    for (let i = Math.max(1, n - periods); i < n; i++) {
      const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
      if (Number.isFinite(tr)) { trSum += tr; cnt++; }
    }
    const lastClose = C[n - 1];
    return cnt && lastClose > 0 ? (trSum / cnt / lastClose) * 100 : null;
  } catch { return null; }
}

async function monitorPosition(address, state, config, env, cache) {
  const pos = state.current_position;
  if (!pos) return;

  // ── Reconcile with the exchange ──────────────────────────
  // The user may have closed this position manually in the UI. The agent tracks
  // positions from KV, so without this it would monitor a ghost and eventually
  // log a bogus trade. Verify the position still exists on Orderly; if the
  // exchange shows flat, clear the stale record and resume scanning (honoring
  // the cooldown). If the check itself fails (API hiccup), fall through and
  // manage on cached data rather than risk discarding a real position.
  // Paper positions have no exchange counterpart — skip reconciliation entirely.
  const keyRaw = pos.paper ? null : await env.NEXUS_AGENT.get(`agent:key:${address}`);
  if (keyRaw) {
    try {
      const keyData = JSON.parse(keyRaw);
      keyData.tradingKey = await decryptTradingKey(keyData.tradingKey, env);
      const posRes = await orderlyRequest(keyData, "GET", `/v1/position/${pos.symbol}`);
      const liveQty = Math.abs(parseFloat(posRes?.data?.position_qty ?? 0));
      if (Number.isFinite(liveQty) && liveQty < 1e-9) {
        console.log(`[exec] ${address.slice(0, 10)} position flat on exchange (manual close?) — clearing stale record`);
        state.current_position = null;
        state.last_trade_time = Date.now(); // respect cooldown before any re-entry
        await env.NEXUS_AGENT.put(`agent:state:${address}`, JSON.stringify(state));
        return;
      }
    } catch (e) {
      console.error(`[exec] ${address.slice(0, 10)} position reconcile failed, managing on cached data:`, e.message);
    }
  }

  // Fetch current price (shared per-symbol cache)
  const currentPrice = await getMarkPrice(pos.symbol, env, cache);

  // Calculate P&L % (tested in logic.mjs)
  const { pnlPct } = computePnl(pos.direction, pos.entry_price, currentPrice, pos.qty);

  // Update current price in state
  pos.current_price = currentPrice;
  pos.pnl_percent = pnlPct;

  // Exit decision: TP → SL → timeout (tested in logic.mjs). Prefer the per-position
  // levels resolved at entry (vol-scaled) over the flat config, falling back to
  // config for positions opened before this field existed.
  const reason = exitReason(pnlPct, Date.now() - pos.opened_at, {
    tpPercent: pos.tpPercent ?? config.tpPercent,
    slPercent: pos.slPercent ?? config.slPercent,
    maxHoldHours: config.maxHoldHours,
  });
  if (reason) {
    await closePosition(address, state, env, reason, cache);
    return;
  }

  // Still holding — save updated state
  await env.NEXUS_AGENT.put(`agent:state:${address}`, JSON.stringify(state));
  console.log(`[exec] ${address.slice(0, 10)} HOLDING ${pos.direction} ${pos.symbol.replace("PERP_","").replace("_USDC","")} pnl=${pnlPct.toFixed(3)}%`);
}

async function closePosition(address, state, env, reason, cache) {
  const pos = state.current_position;
  if (!pos) return;
  const paper = !!pos.paper;
  let closeOrderId = null;

  // Real positions: send a reduce-only market close. Paper positions never
  // touched the exchange, so there's nothing to close — skip straight to P&L.
  if (!paper) {
    const keyRaw = await env.NEXUS_AGENT.get(`agent:key:${address}`);
    // If key was deleted (kill switch), we still try to close with cached data
    // but may fail — that's acceptable, position will auto-liquidate or user closes manually
    if (keyRaw) {
      const keyData = JSON.parse(keyRaw);
      keyData.tradingKey = await decryptTradingKey(keyData.tradingKey, env);
      const closeSide = pos.direction === "LONG" ? "SELL" : "BUY";

      try {
        const closeOrder = await orderlyRequest(keyData, "POST", "/v1/order", {
          symbol: pos.symbol,
          order_type: "MARKET",
          side: closeSide,
          order_quantity: pos.qty,
          reduce_only: true,
          broker_id: "nexus_trading",
        });
        closeOrderId = closeOrder?.data?.order_id ?? null;
      } catch (e) {
        console.error(`[exec] ${address.slice(0, 10)} close order failed:`, e.message);
      }
    }
  }

  // Fetch final price
  let exitPrice = pos.current_price;
  try {
    exitPrice = await getMarkPrice(pos.symbol, env, cache);
  } catch (e) {}

  const { pnlPct, pnlUsdc } = computePnl(pos.direction, pos.entry_price, exitPrice, pos.qty);

  // Update daily P&L
  state.daily_pnl = (state.daily_pnl || 0) + pnlUsdc;
  state.current_position = null;

  const trade = {
    symbol: pos.symbol,
    direction: pos.direction,
    entry_price: pos.entry_price,
    exit_price: exitPrice,
    qty: pos.qty,
    pnl: pnlUsdc,
    pnl_percent: pnlPct,
    reason,
    opened_at: new Date(pos.opened_at).toISOString(),
    closed_at: new Date().toISOString(),
  };
  // Orderly order IDs make every record independently auditable against the
  // exchange (anyone can verify the order existed + its fill). Optional columns.
  const auditable = { ...trade, entry_order_id: pos.order_id ?? null, close_order_id: closeOrderId };

  if (paper) {
    // Paper trades live in state (rides along in the API's state response) so
    // they stay completely separate from the real Supabase track record.
    state.paper_trades = state.paper_trades || [];
    state.paper_trades.unshift({ id: `paper_${Date.now()}`, ...auditable });
    if (state.paper_trades.length > 50) state.paper_trades.pop(); // keep last 50
  } else {
    // Log real trades to Supabase. Writes use the SERVICE key (least privilege:
    // only the exec can insert). Falls back to the anon key if the service key
    // isn't set yet so logging never breaks mid-migration. Pair this with an RLS
    // policy that blocks anon INSERT on agent_trades — then the public anon key
    // (used for reads) cannot forge trade rows.
    const writeKey = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
    const insert = async (payload) => fetch(`${env.SUPABASE_URL}/rest/v1/agent_trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: writeKey, Authorization: `Bearer ${writeKey}` },
      body: JSON.stringify(payload),
    });
    try {
      // Try the auditable row (with order IDs). If the columns aren't migrated
      // yet, PostgREST 400s — fall back to the core row so logging never breaks.
      let res = await insert({ wallet_address: address, ...auditable });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.warn(`[exec] ${address.slice(0, 10)} auditable insert failed (${res.status}) — retrying core row:`, detail.slice(0, 120));
        res = await insert({ wallet_address: address, ...trade });
        if (!res.ok) console.error(`[exec] ${address.slice(0, 10)} core insert also failed (${res.status})`);
      }
    } catch (e) {
      console.error(`[exec] ${address.slice(0, 10)} supabase log failed:`, e.message);
    }
  }

  // Resolve the published feed thesis (if this trade was published on entry).
  if (PUBLISH_AGENT_FEED && pos.feed_id) {
    try {
      await publishAgentClose(address, env, pos.feed_id, { reason, pnlUsdc, exitPrice });
    } catch (e) {
      console.error(`[exec] ${address.slice(0, 10)} agent feed close failed:`, e.message);
    }
  }

  await env.NEXUS_AGENT.put(`agent:state:${address}`, JSON.stringify(state));
  console.log(`[exec] ${address.slice(0, 10)} ${paper ? "PAPER " : ""}CLOSE ${pos.direction} ${pos.symbol} reason=${reason} pnl=$${pnlUsdc.toFixed(4)}`);
}
