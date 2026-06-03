// ═══════════════════════════════════════════════════════════
// nexus-ledger-anchor — commits the agent trade ledger root on-chain
// Cron: hourly. Reads the canonical SHA-256 ledgerHash from the public
// /agents/ledger endpoint and, when it has changed, writes it to the
// NexusLedgerAnchor contract on Arbitrum. Dedupes so it only spends gas
// when new trades have actually settled.
//
// Secrets:  ANCHOR_PRIVATE_KEY (0x… — DEDICATED hot wallet, gas only)
// Vars:     LEDGER_ANCHOR_CONTRACT (0x…), ARBITRUM_RPC_URL (optional)
// KV:       NEXUS_AGENT (writes agent:ledger:onchain for the verify UI)
// ═══════════════════════════════════════════════════════════

import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const LEDGER_URL = "https://og.nexustradinglabs.com/agents/ledger";

const ABI = [
  { type: "function", name: "anchor", stateMutability: "nonpayable",
    inputs: [{ name: "root", type: "bytes32" }, { name: "recordCount", type: "uint256" }], outputs: [] },
  { type: "function", name: "latestRoot", stateMutability: "view",
    inputs: [], outputs: [{ type: "bytes32" }] },
];

async function runAnchor(env) {
  if (!env.ANCHOR_PRIVATE_KEY || !env.LEDGER_ANCHOR_CONTRACT || env.LEDGER_ANCHOR_CONTRACT.startsWith("0x0000")) {
    console.warn("[anchor] not configured (need ANCHOR_PRIVATE_KEY + LEDGER_ANCHOR_CONTRACT)");
    return { ok: false, reason: "not configured" };
  }
  const rpc = env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";

  // 1) Pull the current canonical ledger hash.
  const res = await fetch(LEDGER_URL);
  if (!res.ok) { console.error("[anchor] ledger fetch failed", res.status); return { ok: false, reason: "ledger fetch" }; }
  const { ledgerHash, count } = await res.json();
  if (!ledgerHash || !/^[0-9a-f]{64}$/i.test(ledgerHash)) { console.error("[anchor] bad ledgerHash"); return { ok: false, reason: "bad hash" }; }
  const root = `0x${ledgerHash}`;

  const account = privateKeyToAccount(env.ANCHOR_PRIVATE_KEY);
  const contract = env.LEDGER_ANCHOR_CONTRACT;

  // 2) Read the on-chain root — authoritative dedup. Skip if unchanged.
  const pub = createPublicClient({ chain: arbitrum, transport: http(rpc) });
  let onchainRoot = null;
  try {
    onchainRoot = await pub.readContract({ address: contract, abi: ABI, functionName: "latestRoot" });
  } catch (e) {
    console.error("[anchor] readContract failed (continuing to write):", e.message);
  }
  if (onchainRoot && onchainRoot.toLowerCase() === root.toLowerCase()) {
    console.log("[anchor] root unchanged, skip:", root);
    return { ok: true, skipped: true, root };
  }

  // 3) Commit the new root.
  const wallet = createWalletClient({ account, chain: arbitrum, transport: http(rpc) });
  const txHash = await wallet.writeContract({
    address: contract, abi: ABI, functionName: "anchor", args: [root, BigInt(count || 0)],
  });
  console.log(`[anchor] committed root ${root} (${count} records) tx ${txHash}`);

  // 4) Record the proof for the verify UI (lab-api /agents/ledger reads this).
  try {
    if (env.NEXUS_AGENT) {
      await env.NEXUS_AGENT.put("agent:ledger:onchain", JSON.stringify({
        root, txHash, recordCount: count || 0, ts: Date.now(),
        chain: "arbitrum", contract,
        explorer: `https://arbiscan.io/tx/${txHash}`,
      }));
    }
  } catch (e) { console.error("[anchor] kv write failed:", e.message); }

  return { ok: true, root, txHash };
}

export default {
  async scheduled(event, env) {
    try { await runAnchor(env); }
    catch (e) { console.error("[anchor] fatal:", e.message); }
  },
  // Manual trigger for testing: GET /anchor-now
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/anchor-now") {
      const r = await runAnchor(env).catch((e) => ({ ok: false, error: e.message }));
      return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("nexus-ledger-anchor: cron commits the ledger root to Arbitrum");
  },
};
