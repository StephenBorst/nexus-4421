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

const ORDERLY_API = "https://api-evm.orderly.org";
const COOLDOWN_MS = 15 * 60 * 1000; // 15 min between trades

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
  async scheduled(event, env) {
    try {
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

  // Daily reset check
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (now - (state.last_reset || 0) > dayMs) {
    state.daily_pnl = 0;
    state.trades_today = 0;
    state.last_reset = now;
  }

  // Daily limits check
  if (state.trades_today >= config.maxTradesPerDay) {
    console.log(`[exec] ${address.slice(0, 10)} max trades reached`);
    return;
  }
  if (Math.abs(state.daily_pnl) >= config.maxDailyLossUsdc && state.daily_pnl < 0) {
    console.log(`[exec] ${address.slice(0, 10)} max daily loss reached`);
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

  // Calculate qty, snapped to base_tick. Format to the tick's decimal places so
  // floating-point artifacts (e.g. 340 * 1e-5 = 0.0034000000000000007) don't
  // produce a value Orderly rejects with -1104 "does not match the step size".
  const notional = config.capitalPerTrade * config.leverage;
  const decimals = Math.max(0, Math.round(-Math.log10(baseTick)));
  const steps = Math.floor((notional / markPrice) / baseTick);
  let qty = parseFloat((steps * baseTick).toFixed(decimals));

  if (qty < baseMin || qty <= 0) {
    console.error(`[exec] ${address.slice(0, 10)} qty ${qty} below base_min ${baseMin} for ${symbol}`);
    return;
  }
  if (minNotional && qty * markPrice < minNotional) {
    console.error(`[exec] ${address.slice(0, 10)} notional ${(qty * markPrice).toFixed(2)} below min ${minNotional} for ${symbol}`);
    return;
  }

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
  };
  state.last_trade_time = Date.now();
  state.trades_today = (state.trades_today || 0) + 1;
  await env.NEXUS_AGENT.put(`agent:state:${address}`, JSON.stringify(state));

  console.log(`[exec] ${address.slice(0, 10)} ${paper ? "PAPER " : ""}ENTER ${signal.direction} ${symbol} @ ${markPrice} qty=${qty}`);
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

  // Calculate P&L %
  const pnlPct = pos.direction === "LONG"
    ? ((currentPrice - pos.entry_price) / pos.entry_price) * 100
    : ((pos.entry_price - currentPrice) / pos.entry_price) * 100;

  // Update current price in state
  pos.current_price = currentPrice;
  pos.pnl_percent = pnlPct;

  const holdTime = Date.now() - pos.opened_at;
  const maxHoldMs = config.maxHoldHours * 60 * 60 * 1000;

  // Check TP
  if (pnlPct >= config.tpPercent) {
    await closePosition(address, state, env, "TP", cache);
    return;
  }

  // Check SL
  if (pnlPct <= -config.slPercent) {
    await closePosition(address, state, env, "SL", cache);
    return;
  }

  // Check timeout
  if (holdTime >= maxHoldMs) {
    await closePosition(address, state, env, "TIMEOUT", cache);
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

  const pnlPct = pos.direction === "LONG"
    ? ((exitPrice - pos.entry_price) / pos.entry_price) * 100
    : ((pos.entry_price - exitPrice) / pos.entry_price) * 100;
  const pnlUsdc = (pnlPct / 100) * pos.qty * pos.entry_price;

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

  await env.NEXUS_AGENT.put(`agent:state:${address}`, JSON.stringify(state));
  console.log(`[exec] ${address.slice(0, 10)} ${paper ? "PAPER " : ""}CLOSE ${pos.direction} ${pos.symbol} reason=${reason} pnl=$${pnlUsdc.toFixed(4)}`);
}
