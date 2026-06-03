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

const AGENT_LEDGER_URL = "https://og.nexustradinglabs.com/agents/ledger";
const THESES_LEDGER_URL = "https://og.nexustradinglabs.com/theses/ledger";

const ABI = [
  { type: "function", name: "anchor", stateMutability: "nonpayable",
    inputs: [{ name: "root", type: "bytes32" }, { name: "recordCount", type: "uint256" }], outputs: [] },
  { type: "function", name: "latestRoot", stateMutability: "view",
    inputs: [], outputs: [{ type: "bytes32" }] },
];

async function anchorOne(env, label, ledgerUrl, kvKey) {
  const rpc = env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
  const contract = env.LEDGER_ANCHOR_CONTRACT;

  const res = await fetch(ledgerUrl);
  if (!res.ok) { console.error(`[anchor:${label}] ledger fetch failed`, res.status); return { ok: false, reason: "ledger fetch" }; }
  const { ledgerHash, count } = await res.json();
  if (!ledgerHash || !/^[0-9a-f]{64}$/i.test(ledgerHash)) { console.error(`[anchor:${label}] bad ledgerHash`); return { ok: false, reason: "bad hash" }; }
  const root = `0x${ledgerHash}`;

  // Dedup against our last stored proof for THIS ledger (each ledger anchors
  // independently — its own event in the contract log).
  let lastRoot = null;
  try {
    const prev = env.NEXUS_AGENT ? await env.NEXUS_AGENT.get(kvKey) : null;
    if (prev) lastRoot = JSON.parse(prev).root;
  } catch { /* ignore */ }
  if (lastRoot && lastRoot.toLowerCase() === root.toLowerCase()) {
    console.log(`[anchor:${label}] root unchanged, skip`);
    return { ok: true, skipped: true, root };
  }

  const account = privateKeyToAccount(env.ANCHOR_PRIVATE_KEY);
  const wallet = createWalletClient({ account, chain: arbitrum, transport: http(rpc) });
  const txHash = await wallet.writeContract({
    address: contract, abi: ABI, functionName: "anchor", args: [root, BigInt(count || 0)],
  });
  console.log(`[anchor:${label}] committed ${root} (${count}) tx ${txHash}`);

  try {
    if (env.NEXUS_AGENT) {
      await env.NEXUS_AGENT.put(kvKey, JSON.stringify({
        root, txHash, recordCount: count || 0, ts: Date.now(),
        chain: "arbitrum", contract, explorer: `https://arbiscan.io/tx/${txHash}`,
      }));
    }
  } catch (e) { console.error(`[anchor:${label}] kv write failed:`, e.message); }

  return { ok: true, root, txHash };
}

async function runAnchor(env) {
  if (!env.ANCHOR_PRIVATE_KEY || !env.LEDGER_ANCHOR_CONTRACT || env.LEDGER_ANCHOR_CONTRACT.startsWith("0x0000")) {
    console.warn("[anchor] not configured (need ANCHOR_PRIVATE_KEY + LEDGER_ANCHOR_CONTRACT)");
    return { ok: false, reason: "not configured" };
  }
  // Anchor both ledgers — agents (real trades) and theses (public calls) — each
  // as its own committed root + Arbiscan-visible event. Sequential to avoid nonce races.
  const agents = await anchorOne(env, "agents", AGENT_LEDGER_URL, "agent:ledger:onchain").catch((e) => ({ ok: false, error: e.message }));
  const theses = await anchorOne(env, "theses", THESES_LEDGER_URL, "theses:ledger:onchain").catch((e) => ({ ok: false, error: e.message }));
  return { ok: true, agents, theses };
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
