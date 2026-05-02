/**
 * nexus-lab-alerts — Cloudflare Worker
 *
 * Two responsibilities:
 *  1. Cron (every 1 min): scan active theses, check live prices, fire Telegram alerts
 *  2. HTTP webhook: handle Telegram /start command to register wallet → chatId
 *
 * KV bindings (set in wrangler.toml):
 *   LAB_STORE   — shared with nexus-lab-api (same namespace ID)
 *   ALERT_STORE — separate namespace for wallet→chatId mappings
 *
 * Secrets (set via: npx wrangler secret put TELEGRAM_TOKEN):
 *   TELEGRAM_TOKEN
 */

const ORDERLY_API = "https://api-evm.orderly.org/v1/public/futures";
const TG_API = (token) => `https://api.telegram.org/bot${token}`;

// ── Telegram helpers ──────────────────────────────────────

async function sendMessage(token, chatId, text) {
  await fetch(`${TG_API(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
}

// ── Price fetching ────────────────────────────────────────

async function fetchMarkPrices() {
  try {
    const res = await fetch(ORDERLY_API);
    const json = await res.json();
    const rows = json?.data?.rows ?? [];
    const prices = {};
    for (const row of rows) {
      // symbol format: PERP_BTC_USDC → key: BTC
      const sym = row.symbol?.replace("PERP_", "").replace("_USDC", "");
      if (sym && row.mark_price) {
        prices[sym] = parseFloat(row.mark_price);
      }
    }
    return prices;
  } catch {
    return {};
  }
}

// ── Alert message builder ─────────────────────────────────

function buildAlertMessage(thesis, triggerType, markPrice) {
  const dir = thesis.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const emoji = triggerType === "TP" ? "✅" : "🛑";
  const label = triggerType === "TP" ? "TAKE PROFIT HIT" : "STOP LOSS HIT";

  return (
    `${emoji} <b>NEXUS LAB ALERT — ${label}</b>\n\n` +
    `<b>${thesis.symbol}</b> ${dir}\n` +
    `Entry: $${thesis.entryPrice.toLocaleString()}\n` +
    `Mark Price: $${markPrice.toLocaleString()}\n` +
    (triggerType === "TP"
      ? `TP: $${thesis.takeProfit1.toLocaleString()}`
      : `SL: $${thesis.stopLoss.toLocaleString()}`) +
    `\n\n<i>R:R was ${thesis.riskReward?.toFixed(2) ?? "—"}x</i>\n` +
    `<a href="https://trade.nexustradinglabs.com">→ Open Nexus</a>`
  );
}

// ── Cron: scan all theses ─────────────────────────────────

async function runAlertScan(env) {
  const prices = await fetchMarkPrices();
  if (!Object.keys(prices).length) return;

  // List all lab keys in KV
  const list = await env.LAB_STORE.list({ prefix: "lab:" });

  for (const key of list.keys) {
    const walletAddress = key.name.replace("lab:", "");
    const raw = await env.LAB_STORE.get(key.name);
    if (!raw) continue;

    let data;
    try { data = JSON.parse(raw); } catch { continue; }

    const theses = data.theses ?? [];
    const activeTheses = theses.filter((t) => t.status === "ACTIVE");
    if (!activeTheses.length) continue;

    // Look up chatId for this wallet
    const chatId = await env.ALERT_STORE.get(`tg:${walletAddress}`);
    if (!chatId) continue; // user hasn't registered for alerts

    let updated = false;

    for (const thesis of activeTheses) {
      const sym = thesis.symbol?.replace("PERP_", "").replace("_USDC", "").toUpperCase();
      const price = prices[sym];
      if (!price) continue;

      let triggerType = null;

      if (thesis.direction === "LONG") {
        if (price >= thesis.takeProfit1) triggerType = "TP";
        else if (price <= thesis.stopLoss) triggerType = "SL";
      } else {
        // SHORT
        if (price <= thesis.takeProfit1) triggerType = "TP";
        else if (price >= thesis.stopLoss) triggerType = "SL";
      }

      if (triggerType) {
        // Send Telegram alert
        await sendMessage(
          env.TELEGRAM_TOKEN,
          chatId,
          buildAlertMessage(thesis, triggerType, price)
        );

        // Update thesis status in data
        thesis.status = triggerType === "TP" ? "HIT_TP" : "STOPPED_OUT";
        updated = true;
      }
    }

    // Write back if anything changed
    if (updated) {
      await env.LAB_STORE.put(key.name, JSON.stringify(data));
    }
  }
}

// ── HTTP: Telegram webhook (/start <walletAddress>) ───────

async function handleWebhook(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response("ok"); }

  const message = body?.message;
  if (!message) return new Response("ok");

  const chatId = String(message.chat?.id ?? "");
  const text = (message.text ?? "").trim();

  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const wallet = parts[1]?.toLowerCase().trim();

    if (wallet && wallet.startsWith("0x")) {
      // Store wallet → chatId
      await env.ALERT_STORE.put(`tg:${wallet}`, chatId);

      await sendMessage(
        env.TELEGRAM_TOKEN,
        chatId,
        `✅ <b>Nexus Lab Alerts enabled!</b>\n\nYour wallet <code>${wallet.slice(0, 6)}...${wallet.slice(-4)}</code> is now linked.\n\nYou'll get a message here whenever a thesis hits TP or SL.\n\n<a href="https://trade.nexustradinglabs.com/lab">→ Open The Lab</a>`
      );
    } else {
      await sendMessage(
        env.TELEGRAM_TOKEN,
        chatId,
        `👋 Welcome to Nexus Lab Alerts!\n\nTo enable alerts, click the <b>Enable Alerts</b> button inside The Lab on Nexus Trading Labs.`
      );
    }
  }

  return new Response("ok");
}

// ── Entry point ───────────────────────────────────────────

export default {
  // Cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlertScan(env));
  },

  // HTTP (Telegram webhook)
  async fetch(request, env) {
    if (request.method === "POST") {
      return handleWebhook(request, env);
    }
    return new Response("nexus-lab-alerts ok", { status: 200 });
  },
};
