// ── nexus-carry-engine · ORDERLY SIGNING + API (ported, proven) ───────────────
// Ed25519 request signing + the order/position/orderbook calls the live executor uses.
// PORTED VERBATIM from the validated nexus-agent-exec signing (Session Handoff 012) — do
// NOT reinvent it: Web Crypto can't sign raw ed25519 seeds; @noble signAsync + base64URL
// sig + derived-pubkey orderly-key header are the ground truth. keyData = {tradingKey,
// accountId}; an ORDER-ONLY key (cannot withdraw) — blast radius is trading only.
import * as ed from "@noble/ed25519";
import bs58 from "bs58";

const ORDERLY_API = "https://api-evm.orderly.org";
const BROKER_ID = "nexus_trading";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

export async function orderlyRequest(keyData, method, path, body = null) {
  const bodyStr = body ? JSON.stringify(body) : "";
  const secret = keyData.tradingKey.replace(/^ed25519:/, "");
  const privKey = bs58.decode(secret);
  const pubKeyBytes = await ed.getPublicKeyAsync(privKey);
  const orderlyKey = `ed25519:${bs58.encode(pubKeyBytes)}`;
  const contentType = method === "GET" ? "application/x-www-form-urlencoded" : "application/json";

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const timestamp = Date.now().toString();
    const message = `${timestamp}${method}${path}${bodyStr}`;
    const sig = await ed.signAsync(new TextEncoder().encode(message), privKey);
    const signature = btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await fetch(`${ORDERLY_API}${path}`, {
      method,
      headers: {
        ...BROWSER_HEADERS, "Content-Type": contentType,
        "orderly-timestamp": timestamp, "orderly-account-id": keyData.accountId,
        "orderly-key": orderlyKey, "orderly-signature": signature,
      },
      body: body ? bodyStr : undefined,
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch {
      lastErr = new Error(`orderly ${method} ${path} non-JSON (HTTP ${res.status}): ${text.slice(0, 80)}`);
      if (res.status === 403 && attempt < 2) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

// Public info (base_tick / base_min / min_notional live here, NOT on /futures).
export async function publicInfo(symbol) {
  const d = await fetch(`${ORDERLY_API}/v1/public/info/${symbol}`, { headers: BROWSER_HEADERS }).then((r) => r.json()).catch(() => null);
  const r = d?.data;
  if (!r) return null;
  return { baseTick: Number(r.base_tick), baseMin: Number(r.base_min), minNotional: Number(r.min_notional), baseImr: Number(r.base_imr) };
}

// Top-of-book best bid/ask for maker pricing (authed orderbook).
export async function bookTop(keyData, symbol) {
  const d = await orderlyRequest(keyData, "GET", `/v1/orderbook/${symbol}?max_level=1`);
  const b = d?.data;
  const bestBid = Number(b?.bids?.[0]?.price);
  const bestAsk = Number(b?.asks?.[0]?.price);
  return { bestBid, bestAsk };
}

export async function getPositions(keyData) {
  const d = await orderlyRequest(keyData, "GET", "/v1/positions");
  return d?.data?.rows || [];
}
export async function getOpenOrders(keyData) {
  const d = await orderlyRequest(keyData, "GET", "/v1/orders?status=INCOMPLETE&size=200");
  return d?.data?.rows || [];
}
export async function cancelOrder(keyData, symbol, orderId) {
  return orderlyRequest(keyData, "DELETE", `/v1/order?order_id=${orderId}&symbol=${symbol}`);
}
export async function setLeverage(keyData, leverage) {
  return orderlyRequest(keyData, "POST", "/v1/client/leverage", { leverage });
}

// Place ONE POST_ONLY (maker) order. Returns { ok, orderId?, code?, message? }.
export async function placePostOnly(keyData, spec) {
  const body = {
    symbol: `PERP_${spec.symbol}_USDC`,
    order_type: "POST_ONLY",
    side: spec.side,                 // BUY | SELL
    order_price: spec.price,
    order_quantity: spec.qty,
    reduce_only: !!spec.reduceOnly,
    broker_id: BROKER_ID,
  };
  const r = await orderlyRequest(keyData, "POST", "/v1/order", body);
  if (r && r.success) return { ok: true, orderId: r.data?.order_id, spec };
  return { ok: false, code: r?.code, message: r?.message || "order rejected", spec };
}
