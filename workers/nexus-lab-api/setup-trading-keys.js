/**
 * One-time setup: generate ed25519 keypair and register with Orderly
 * Run: node setup-trading-keys.js
 *
 * No extra dependencies needed — uses Node.js built-in crypto (v15+).
 * After running, paste the 3 wrangler secret put commands it outputs.
 */

import crypto from "crypto";

const ORDERLY_BASE = "https://api.orderly.org";
const ACCOUNT_ID = process.env.ORDERLY_ACCOUNT_ID ||
  "0x3b9986c6410a4b7649abd071c5ba367862578d8aafd8d4794060fbb91f592ae2";

// Generate ed25519 keypair using Node built-in crypto
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

// Export raw bytes
const privBytes = privateKey.export({ type: "pkcs8", format: "der" }).slice(-32); // last 32 bytes = seed
const pubBytes  = publicKey.export({ type: "spki", format: "der" }).slice(-32);   // last 32 bytes = public

// Base58 encode public key (Orderly format)
const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function toBase58(buf) {
  let n = BigInt("0x" + buf.toString("hex"));
  let result = "";
  while (n > 0n) {
    result = BASE58_CHARS[Number(n % 58n)] + result;
    n /= 58n;
  }
  for (const byte of buf) { if (byte === 0) result = "1" + result; else break; }
  return result;
}

const privB64      = privBytes.toString("base64");
const pubB58       = toBase58(pubBytes);
const orderlyKey   = `ed25519:${pubB58}`;

console.log("\n=== Generated Keypair ===");
console.log("orderly-key (public):", orderlyKey);

// Sign a message with ed25519
function sign(message) {
  const sig = crypto.sign(null, Buffer.from(message, "utf8"), privateKey);
  return sig.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function getHeaders(method, path, body = "") {
  const timestamp = Date.now();
  const msg = `${timestamp}${method.toUpperCase()}${path}${body}`;
  return {
    "Content-Type": "application/json",
    "orderly-timestamp": timestamp.toString(),
    "orderly-account-id": ACCOUNT_ID,
    "orderly-key": orderlyKey,
    "orderly-signature": sign(msg),
  };
}

async function registerKey() {
  const expiry = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year
  const payload = { public_key: orderlyKey, scope: "read,trading", expiration: expiry };
  const bodyStr = JSON.stringify(payload);

  console.log("\nRegistering key with Orderly...");
  const res = await fetch(`${ORDERLY_BASE}/v1/client/key_pair`, {
    method: "POST",
    headers: getHeaders("POST", "/v1/client/key_pair", bodyStr),
    body: bodyStr,
  });
  const data = await res.json();
  console.log("Response:", JSON.stringify(data, null, 2));

  if (data.success || data.data) {
    console.log("\n✅ Key registered! Run these commands:\n");
    console.log(`npx wrangler secret put ORDERLY_API_SECRET`);
    console.log(`  → paste: ${privB64}\n`);
    console.log(`npx wrangler secret put ORDERLY_API_KEY`);
    console.log(`  → paste: ${orderlyKey}\n`);
    console.log(`npx wrangler secret put ORDERLY_ACCOUNT_ID`);
    console.log(`  → paste: ${ACCOUNT_ID}\n`);
  } else {
    console.error("\n❌ Registration failed. Check your ACCOUNT_ID and that wallet-register was run first.");
  }
}

registerKey().catch(console.error);
