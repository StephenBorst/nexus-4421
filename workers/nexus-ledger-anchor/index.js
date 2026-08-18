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

// ─── Ops monitoring ────────────────────────────────────────
// Hourly health checks → Telegram. Catches the silent failures: anchor wallet
// out of gas, anchoring stuck, or the signal brain dying.
async function sendTg(env, text) {
  if (!env.TELEGRAM_TOKEN || !env.OPS_TELEGRAM_CHAT_ID) { console.warn("[monitor] telegram not configured"); return; }
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.OPS_TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) { console.error("[monitor] tg send failed:", e.message); }
}

// Debounce: an alert for `key` fires at most once per `everyMs`.
async function shouldAlert(env, key, everyMs) {
  try {
    const k = `ops:alert:${key}`;
    const last = await env.NEXUS_AGENT.get(k);
    if (last && Date.now() - Number(last) < everyMs) return false;
    await env.NEXUS_AGENT.put(k, String(Date.now()));
    return true;
  } catch { return true; }
}

async function runMonitor(env) {
  const rpc = env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
  const issues = [];
  const HOUR = 3600000;

  // 1) Anchor signer gas — the silent killer. No gas → anchoring stops.
  try {
    if (env.ANCHOR_PRIVATE_KEY) {
      const account = privateKeyToAccount(env.ANCHOR_PRIVATE_KEY);
      const pub = createPublicClient({ chain: arbitrum, transport: http(rpc) });
      const bal = await pub.getBalance({ address: account.address });
      const eth = Number(bal) / 1e18;
      if (eth < 0.0004) issues.push({ key: "gas", msg: `⛽ Anchor wallet LOW: <b>${eth.toFixed(5)} ETH</b> on Arbitrum — top up or on-chain anchoring stops.\n<code>${account.address}</code>` });
    }
  } catch (e) { console.error("[monitor] gas:", e.message); }

  // 2) Anchor freshness — ledger drifted from its on-chain root for too long.
  try {
    const ocRaw = await env.NEXUS_AGENT.get("agent:ledger:onchain");
    if (ocRaw) {
      const oc = JSON.parse(ocRaw);
      const ageH = (Date.now() - (oc.ts || 0)) / HOUR;
      const led = await fetch(AGENT_LEDGER_URL).then((r) => r.json()).catch(() => null);
      if (led?.ledgerHash && oc.root && `0x${led.ledgerHash}`.toLowerCase() !== oc.root.toLowerCase() && ageH > 6) {
        issues.push({ key: "anchor", msg: `⚓ Agent ledger has drifted from its on-chain anchor for <b>${ageH.toFixed(1)}h</b> — anchoring may be failing.` });
      }
    }
  } catch (e) { console.error("[monitor] freshness:", e.message); }

  // 3) Brain liveness — via the brain's heartbeat (stamped every completed run,
  // even when no signals are emitted). Avoids false positives when active users
  // simply hold open positions (the brain correctly emits nothing then).
  try {
    const hb = await env.NEXUS_AGENT.get("ops:brain:heartbeat");
    if (hb) {
      const ageMin = (Date.now() - Number(hb)) / 60000;
      if (ageMin > 15) issues.push({ key: "brain", msg: `🧠 Brain down: last run was <b>${ageMin.toFixed(0)} min</b> ago (cron runs every 5 min). Signal pipeline may be down.` });
    }
    // No heartbeat key yet = brain hasn't deployed the heartbeat or never ran;
    // don't alert (avoids a false positive on first rollout).
  } catch (e) { console.error("[monitor] brain:", e.message); }

  // 3b) Exec liveness — the 1-min execution cron stamps ops:exec:heartbeat every
  // tick (whether or not it trades). This distinguishes "agents idle by design"
  // (heartbeat fresh, signal=NONE) from "exec cron actually stopped" (heartbeat
  // stale) — the exact ambiguity that cost us a 27h false-alarm investigation.
  try {
    const hb = await env.NEXUS_AGENT.get("ops:exec:heartbeat");
    if (hb) {
      const ageMin = (Date.now() - Number(hb)) / 60000;
      if (ageMin > 10) issues.push({ key: "exec", msg: `⚙️ Exec down: last tick was <b>${ageMin.toFixed(0)} min</b> ago (cron runs every 1 min). Agents are not being executed/monitored.` });
    }
  } catch (e) { console.error("[monitor] exec:", e.message); }

  // 3c) Carry engine liveness — the sleeve's hourly PAPER cron drives the funding-carry
  // record; a stall means it paused. If armed live, also surface a tripped kill switch or
  // rejected maker orders. HTTP-based (the carry KV is a separate namespace).
  try {
    const base = env.CARRY_HEALTH_URL || "https://nexus-carry-engine.stephenpatrick24.workers.dev";
    const h = await fetch(`${base}/carry/health`).then((r) => r.json()).catch(() => null);
    if (h && h.lastTickAgeSec != null && h.lastTickAgeSec > 5400) {
      issues.push({ key: "carry", msg: `◈ Carry sleeve stalled: last paper tick <b>${(h.lastTickAgeSec / 60).toFixed(0)} min</b> ago (hourly cron). Funding-carry record paused.` });
    }
    const ls = await fetch(`${base}/carry/live/status`).then((r) => r.json()).catch(() => null);
    if (ls?.armed) {
      if (ls.killed) issues.push({ key: "carry_kill", msg: `◈ Carry LIVE kill switch is ON — the maker executor is halted.` });
      const errs = (ls.lastLive?.results || []).filter((r) => r && r.error);
      if (errs.length) issues.push({ key: "carry_orders", msg: `◈ Carry live orders rejected (<b>${errs.length}</b>): <code>${String(errs[0].error || "").slice(0, 80)}</code>` });
    }
  } catch (e) { console.error("[monitor] carry:", e.message); }

  // Alert per-issue, debounced 3h so we don't spam an ongoing problem.
  for (const { key, msg } of issues) {
    if (await shouldAlert(env, key, 3 * HOUR)) await sendTg(env, `🚨 <b>Nexus ops alert</b>\n\n${msg}`);
  }

  // Daily heartbeat so a dead monitor isn't mistaken for "all healthy".
  if (issues.length === 0 && await shouldAlert(env, "heartbeat", 24 * HOUR)) {
    await sendTg(env, "✅ <b>Nexus ops</b> — all healthy. Anchoring live, brain + exec crons ticking, gas OK.");
  }
  return { issues: issues.map((i) => i.key) };
}

export default {
  async scheduled(event, env) {
    try { await runAnchor(env); } catch (e) { console.error("[anchor] fatal:", e.message); }
    try { await runMonitor(env); } catch (e) { console.error("[monitor] fatal:", e.message); }
  },
  // Manual triggers for testing: GET /anchor-now , GET /monitor-now
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/anchor-now") {
      const r = await runAnchor(env).catch((e) => ({ ok: false, error: e.message }));
      return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/monitor-now") {
      const r = await runMonitor(env).catch((e) => ({ ok: false, error: e.message }));
      return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("nexus-ledger-anchor: anchors the ledger root + ops monitoring");
  },
};
