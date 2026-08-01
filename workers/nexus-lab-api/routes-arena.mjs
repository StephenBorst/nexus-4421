// ── Nexus Arena routes — the open proving ground for AI trading agents ──
// Any external agent (a Bankr bot, a LangChain script, someone's Claude loop)
// registers with a wallet and drives trades through the webhook rail. PAPER tier
// is zero-capital: fills are simulated by the exec engine at public mark price,
// so the record is graded by US, never self-reported. Graduating to a funded
// account moves the record onto the real Orderly-order ledger (on-chain anchored).
//
// Registration is walletSig-authed (same personal_sign('nexus-trading-key-v1')
// proof every agent mutation uses) — possession of the sig proves wallet
// ownership, so nobody can squat a roster slot for someone else's address.
// Arena-minted webhook tokens are FREE but scoped to signalMode EXTERNAL (the
// hook route enforces it) so they can't become a ride around the PRO webhook gate.
import { json, normalizeAddress, recoverEthAddress } from "./shared.mjs";
import { validateArenaRegistration, arenaAgentConfig, aggregateAgentTrades, agentScore, ARENA } from "./logic.mjs";

// URL-safe random token — same shape as the PRO webhook mint in index.js.
function randToken(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Shrink a trade-row aggregate into the public stat block the roster ships.
function statBlock(rows) {
  if (!rows || !rows.length) return null;
  const agg = aggregateAgentTrades(rows);
  const { winRate, profitFactor, score } = agentScore(agg);
  return {
    trades: agg.trades,
    wins: agg.wins,
    winRate: Math.round(winRate * 1000) / 10,
    netPnl: Math.round(agg.net * 100) / 100,
    profitFactor: Math.round(Math.min(profitFactor, 99) * 100) / 100,
    score,
    daysActive: agg.daysActive,
  };
}

export async function handleArena(parts, request, env) {
  if (parts[0] !== "arena") return null;
  const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;

  // ── POST /arena/register — open registration for external agents ──────────
  // {name, description?, builder?, config?, walletAddress, walletSig, rotate?}
  if (parts[1] === "register" && !parts[2] && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
    const address = normalizeAddress(String(body.walletAddress || ""));
    if (!/^0x[0-9a-f]{40}$/.test(address)) return json({ error: "walletAddress required" }, request, 400);
    if (!(typeof body.walletSig === "string" && recoverEthAddress("nexus-trading-key-v1", body.walletSig) === address)) {
      return json({ error: "walletSig_required", hint: "walletSig = personal_sign('nexus-trading-key-v1') from the registering wallet." }, request, 401);
    }
    const v = validateArenaRegistration(body);
    if (!v.ok) return json({ error: v.error }, request, 400);

    const profileKey = `arena:profile:${address}`;
    const existingRaw = await AGENT_KV.get(profileKey);
    if (existingRaw && body.rotate !== true) {
      return json({ error: "already_registered", hint: "This wallet already has an Arena agent. Pass rotate:true to update the profile and mint a fresh webhook token (the old one is revoked)." }, request, 409);
    }

    // Agent config + state — mirrors PUT /agent/:address for PAPER (no key, no
    // funds). signalMode EXTERNAL keeps the house brain silent for this agent.
    const config = arenaAgentConfig(body.config || {});
    await AGENT_KV.put(`agent:config:${address}`, JSON.stringify(config));
    const stateRaw = await AGENT_KV.get(`agent:state:${address}`);
    const state = stateRaw ? JSON.parse(stateRaw) : { active: true, daily_pnl: 0, trades_today: 0, last_reset: Date.now(), current_position: null, last_signal: null };
    state.active = true;
    await AGENT_KV.put(`agent:state:${address}`, JSON.stringify(state));
    const usersRaw = await AGENT_KV.get("agent:users");
    const users = usersRaw ? JSON.parse(usersRaw) : [];
    if (!users.includes(address)) { users.push(address); await AGENT_KV.put("agent:users", JSON.stringify(users)); }

    // Mint the webhook (revoking any previous token for this wallet first).
    const prevMetaRaw = await AGENT_KV.get(`agent:webhook_meta:${address}`);
    if (prevMetaRaw) {
      try {
        const pm = JSON.parse(prevMetaRaw);
        if (pm.token) await AGENT_KV.delete(`agent:webhook:${pm.token}`);
      } catch { /* ignore */ }
    }
    const token = randToken(24);
    const passphrase = randToken(9);
    await AGENT_KV.put(`agent:webhook:${token}`, JSON.stringify({ address, passphrase, enabled: true, arena: true, createdAt: Date.now() }));
    await AGENT_KV.put(`agent:webhook_meta:${address}`, JSON.stringify({ token, passphrase, enabled: true, arena: true, createdAt: Date.now() }));

    let createdAt = Date.now();
    if (existingRaw) { try { createdAt = JSON.parse(existingRaw).createdAt || createdAt; } catch { /* ignore */ } }
    await AGENT_KV.put(profileKey, JSON.stringify({ name: v.name, description: v.description, builder: v.builder, wallet: address, createdAt }));
    const rosterRaw = await AGENT_KV.get("arena:roster");
    const roster = rosterRaw ? JSON.parse(rosterRaw) : [];
    if (!roster.includes(address)) {
      roster.push(address);
      while (roster.length > ARENA.rosterCap) roster.shift();
      await AGENT_KV.put("arena:roster", JSON.stringify(roster));
    }

    const base = new URL(request.url).origin;
    return json({
      ok: true,
      wallet: address,
      name: v.name,
      mode: "PAPER",
      signalMode: "EXTERNAL",
      webhook: {
        url: `${base}/agent/hook/${token}`,
        passphrase,
        method: "POST",
        body: { action: "BUY | SELL | CLOSE", symbol: "BTC", passphrase: "<passphrase>" },
      },
      grading: "PAPER fills are simulated by the exec engine at public mark price — never self-reported. Fund the wallet and activate a live mode to move onto the real Orderly-order ledger (on-chain anchored).",
      note: "SAVE the webhook url + passphrase now — they are never returned again (re-register with rotate:true to mint fresh ones).",
      docs: `${base.includes("nexustradinglabs") ? "https://trade.nexustradinglabs.com" : base}/arena`,
    }, request);
  }

  // ── GET /arena/agents — public roster + graded records ─────────────────────
  if (parts[1] === "agents" && !parts[2] && request.method === "GET") {
    const rosterRaw = await AGENT_KV.get("arena:roster");
    const roster = rosterRaw ? JSON.parse(rosterRaw) : [];
    if (!roster.length) return json({ agents: [], count: 0 }, request);

    // One Supabase query for every live record on the roster (not N queries).
    const liveByWallet = new Map();
    if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      try {
        const r = await fetch(
          `${env.SUPABASE_URL}/rest/v1/agent_trades?wallet_address=in.(${roster.join(",")})&order=closed_at.desc&limit=1000`,
          { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
        );
        if (r.ok) {
          for (const row of await r.json()) {
            const w = String(row.wallet_address || "").toLowerCase();
            if (!liveByWallet.has(w)) liveByWallet.set(w, []);
            liveByWallet.get(w).push(row);
          }
        }
      } catch (e) { console.error("[arena] supabase fetch error:", e); }
    }

    const agents = (await Promise.all(roster.map(async (w) => {
      const [profileRaw, configRaw, stateRaw] = await Promise.all([
        AGENT_KV.get(`arena:profile:${w}`),
        AGENT_KV.get(`agent:config:${w}`),
        AGENT_KV.get(`agent:state:${w}`),
      ]);
      if (!profileRaw) return null;
      let profile, config = null, state = null;
      try { profile = JSON.parse(profileRaw); } catch { return null; }
      try { config = configRaw ? JSON.parse(configRaw) : null; } catch { /* ignore */ }
      try { state = stateRaw ? JSON.parse(stateRaw) : null; } catch { /* ignore */ }
      const pos = state?.current_position || null;
      return {
        wallet: w,
        name: profile.name,
        description: profile.description || "",
        builder: profile.builder || "",
        createdAt: profile.createdAt || 0,
        active: !!state?.active,
        mode: config?.mode || "PAPER",
        currentPosition: pos ? { symbol: pos.symbol, direction: pos.direction, paper: !!pos.paper } : null,
        paper: statBlock(state?.paper_trades),
        live: statBlock(liveByWallet.get(w)),
      };
    }))).filter(Boolean);

    // Live records outrank paper; within a tier, engine score decides.
    agents.sort((a, b) =>
      (b.live ? 1 : 0) - (a.live ? 1 : 0) ||
      (b.live?.score ?? 0) - (a.live?.score ?? 0) ||
      (b.paper?.score ?? 0) - (a.paper?.score ?? 0) ||
      b.createdAt - a.createdAt
    );
    return json({ agents, count: agents.length }, request);
  }

  return null;
}
