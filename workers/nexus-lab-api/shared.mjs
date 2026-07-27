// ── Shared HTTP + crypto primitives for nexus-lab-api ──
//
// nexus-lab-api grew to ~5.7k lines and 74 route blocks inside a single fetch()
// handler. CLAUDE.md's rule was "split only if it starts hurting" — it now hurts, so
// routes are being lifted into route modules one FAMILY at a time.
//
// ⚠️ This is the MONEY-PATH backend (trade / deposit / withdraw / agent control /
// subscriptions). A big-bang rewrite is how a live payment rail breaks. The rule for
// this migration:
//   1. One route family per commit, verified before the next.
//   2. Byte-identical logic — moves only, no "while I'm here" improvements.
//   3. Read-only families first; anything that moves funds goes last, if at all.
//
// This module holds the primitives EVERY route needs, so a route module never has to
// import from index.js (which would be circular).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes, bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export const ALLOWED_ORIGINS = [
  "https://trade.nexustradinglabs.com",
  "http://localhost:5173",
  "http://localhost:3000",
];

export function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export function json(data, request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(request) },
  });
}

export function normalizeAddress(addr) {
  return addr.toLowerCase().trim();
}

/**
 * Recover the signer address from an EIP-191 personal_sign signature.
 *
 * ⚠️ Security-critical: this is the ecrecover behind every owner-authed mutation
 * (agent kill/config, holders gate, desks, live publish). It returns null rather
 * than throwing on a malformed signature — callers MUST treat null as "not
 * authorized" and never as "skip the check".
 */
export function recoverEthAddress(message, sigHex) {
  const msgBytes = utf8ToBytes(message);
  const prefix = utf8ToBytes("\x19Ethereum Signed Message:\n" + msgBytes.length);
  const digest = keccak_256(new Uint8Array([...prefix, ...msgBytes]));
  const sb = hexToBytes(sigHex.replace(/^0x/, ""));
  if (sb.length !== 65) return null;
  const r = sb.slice(0, 32), s = sb.slice(32, 64);
  let v = sb[64]; if (v >= 27) v -= 27;
  try {
    const sig = secp256k1.Signature
      .fromHex(bytesToHex(new Uint8Array([...r, ...s])))
      .addRecoveryBit(v);
    const pub = sig.recoverPublicKey(digest).toBytes(false).slice(1);
    return ("0x" + bytesToHex(keccak_256(pub).slice(-20))).toLowerCase();
  } catch (_) {
    return null;
  }
}
