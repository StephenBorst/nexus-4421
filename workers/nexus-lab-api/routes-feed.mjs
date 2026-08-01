// ── Feed / comments / reactions routes ──
// The public thesis feed, the $NEXUS holders-only feed (signature + on-chain balance
// gated), and per-thesis comments and reactions.
//
// Fourth and FINAL family in this migration (rules in shared.mjs). Everything left in
// index.js after this either moves funds (trade / deposit / withdraw / sub) or is
// wallet-authed agent control — those stay put deliberately: they're only reachable
// through live wallet flows that can't be exercised from a dev machine, so the
// line-count win is not worth the risk without a staging environment.
//
// ⚠️ Pure move — logic byte-identical to what shipped.
import { json, normalizeAddress, recoverEthAddress, holdersRoomMessage, appendNotification } from "./shared.mjs";
import { safeChartUrl } from "./logic.mjs";
import { RESOLVED_FEED_KEY } from "./resolutions.mjs";

export async function handleFeed(parts, request, env) {
  if (!["feed", "comments", "reactions"].includes(parts[0])) return null;
  const url = new URL(request.url);

  if (parts[0] === "feed" && !parts[1]) {
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, request, 405);
    }
    // List all LAB_STORE keys, collect public theses across all wallets
    const listed = await env.LAB_STORE.list({ prefix: "lab:" });
    const feedItems = [];

    for (const key of listed.keys) {
      const raw = await env.LAB_STORE.get(key.name);
      if (!raw) continue;
      const data = JSON.parse(raw);
      const address = key.name.replace("lab:", "");

      // Fetch profile for this wallet (pfp + displayName)
      const profileRaw = await env.LAB_STORE.get(`profile:${address}`);
      const profile = profileRaw ? JSON.parse(profileRaw) : {};

      const publicTheses = (data.theses || []).filter((t) => t.isPublic === true);
      for (const thesis of publicTheses) {
        feedItems.push({
          ...thesis,
          wallet: address,
          pfp: profile.pfp || null,
          displayName: profile.displayName || null,
        });
      }
    }

    // Merge autonomous-agent calls (written per-user by nexus-agent-exec to
    // agent:feed:{address}). Gives the public feed a live heartbeat from the
    // bot's real trades instead of looking abandoned. Tagged agent:true under a
    // single "Nexus Agent" identity. Best-effort — never break /feed if the
    // agent namespace is unavailable. NOTE: these are NOT in lab:, so they never
    // leak into /theses/leaderboard or /theses/ledger (those read lab: only).
    try {
      const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
      const agentListed = await AGENT_KV.list({ prefix: "agent:feed:" });
      for (const key of agentListed.keys) {
        const raw = await AGENT_KV.get(key.name);
        if (!raw) continue;
        const items = JSON.parse(raw);
        const address = key.name.replace("agent:feed:", "");
        for (const t of items) {
          if (t.isPublic === false) continue;
          feedItems.push({ ...t, wallet: address, agent: true, pfp: null, displayName: "Nexus Agent" });
        }
      }
    } catch (e) {
      console.error("[feed] agent merge failed:", e);
    }

    // Merge RESOLUTION events — a call hitting its target or stop is the most
    // interesting thing that happens here, and it used to be invisible: the cron
    // stamped the grade silently and the feed showed nothing. These are outcomes of
    // calls already public, so they expose nothing new. Best-effort.
    try {
      const rraw = await env.LAB_STORE.get(RESOLVED_FEED_KEY);
      for (const ev of (rraw ? JSON.parse(rraw) : [])) feedItems.push({ ...ev, resolution: true });
    } catch (e) {
      console.error("[feed] resolution merge failed:", e);
    }

    // Sort newest first
    feedItems.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json({ feed: feedItems }, request);
  }

  // ── /feed/holders ──────────────────────────────────────
  // $NEXUS Holders Room: theses marked holdersOnly. Server-side gated — the
  // caller must pass ?address=&ts=&sig= — the signature proves wallet
  // ownership (EIP-191), and an on-chain balanceOf read on Base proves the
  // wallet holds the OPERATOR threshold. Signature + fresh timestamp defeats
  // address-spoofing and replay.
  if (parts[0] === "feed" && parts[1] === "holders") {
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, request, 405);
    }
    const url = new URL(request.url);
    const claimed = (url.searchParams.get("address") || "").toLowerCase();
    const ts = parseInt(url.searchParams.get("ts") || "0", 10);
    const sig = url.searchParams.get("sig") || "";
    if (!/^0x[0-9a-f]{40}$/.test(claimed)) {
      return json({ error: "address required" }, request, 400);
    }
    // 1) Signature must be fresh (10-min window) and recover to the claimed address.
    if (!ts || Math.abs(Date.now() - ts) > 600000) {
      return json({ error: "stale or missing timestamp" }, request, 401);
    }
    const recovered = recoverEthAddress(holdersRoomMessage(claimed, ts), sig);
    if (!recovered || recovered !== claimed) {
      return json({ error: "invalid signature" }, request, 401);
    }
    const NEXUS_TOKEN = "0x3D958634ab725B627919EF8F2Ed59227309fDba3";
    const OPERATOR_MIN = 50000000n * (10n ** 18n); // matches frontend TIER_THRESHOLDS (OPERATOR)
    // eth_call balanceOf(address)
    const callData = "0x70a08231000000000000000000000000" + claimed.slice(2);
    let isHolder = false;
    for (const rpc of ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.llamarpc.com"]) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: NEXUS_TOKEN, data: callData }, "latest"] }),
        });
        const j = await res.json();
        if (j.result) { isHolder = BigInt(j.result) >= OPERATOR_MIN; break; }
      } catch (_) { /* try next rpc */ }
    }
    if (!isHolder) {
      return json({ error: "not a $NEXUS holder", feed: [] }, request, 403);
    }

    const listed = await env.LAB_STORE.list({ prefix: "lab:" });
    const feedItems = [];
    for (const key of listed.keys) {
      const raw = await env.LAB_STORE.get(key.name);
      if (!raw) continue;
      const data = JSON.parse(raw);
      const address = key.name.replace("lab:", "");
      const profileRaw = await env.LAB_STORE.get(`profile:${address}`);
      const profile = profileRaw ? JSON.parse(profileRaw) : {};
      const holderTheses = (data.theses || []).filter((t) => t.holdersOnly === true);
      for (const thesis of holderTheses) {
        feedItems.push({ ...thesis, wallet: address, pfp: profile.pfp || null, displayName: profile.displayName || null });
      }
    }
    feedItems.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json({ feed: feedItems }, request);
  }

  // ── /profile/:address ──────────────────────────────────

  // ── Ph29: /comments/:thesisId ─────────────────────────
  if (parts[0] === "comments" && parts[1]) {
    const thesisId = parts[1];
    const commentKey = `comments:${thesisId}`;

    if (request.method === "GET" && parts.length === 2) {
      const raw = await env.LAB_STORE.get(commentKey);
      return json(raw ? JSON.parse(raw) : [], request);
    }

    if (request.method === "POST" && parts.length === 2) {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const wallet = typeof body.wallet === "string" ? body.wallet.toLowerCase().trim() : null;
      const text = typeof body.text === "string" ? body.text.trim().slice(0, 280) : null;
      if (!wallet || !text) return json({ error: "missing wallet or text" }, request, 400);
      const raw = await env.LAB_STORE.get(commentKey);
      const list = raw ? JSON.parse(raw) : [];
      list.unshift({
        id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        wallet,
        text,
        createdAt: Date.now(),
      });
      await env.LAB_STORE.put(commentKey, JSON.stringify(list.slice(0, 50)));
      // Lifecycle notify: tell the call's author someone is discussing it (skip self).
      // authorWallet/symbol/direction ride along from the client, which knows the call.
      const authorWallet = typeof body.authorWallet === "string" ? body.authorWallet.toLowerCase().trim() : null;
      if (authorWallet && authorWallet !== wallet) {
        const sym = typeof body.symbol === "string" ? body.symbol.replace("PERP_", "").replace("_USDC", "") : "";
        const dir = typeof body.direction === "string" ? ` ${body.direction}` : "";
        await appendNotification(env, authorWallet, {
          id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: "comment",
          message: sym ? `New comment on your ${sym}${dir} call` : "New comment on your call",
          fromWallet: wallet,
          thesisId,
          createdAt: Date.now(),
        });
      }
      return json({ ok: true }, request);
    }

    if (request.method === "DELETE" && parts.length === 3) {
      const commentId = parts[2];
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const wallet = typeof body.wallet === "string" ? body.wallet.toLowerCase().trim() : null;
      if (!wallet) return json({ error: "missing wallet" }, request, 400);
      const raw = await env.LAB_STORE.get(commentKey);
      if (!raw) return json({ ok: true }, request);
      const list = JSON.parse(raw);
      const target = list.find((c) => c.id === commentId);
      if (!target) return json({ error: "not found" }, request, 404);
      if (target.wallet !== wallet) return json({ error: "forbidden" }, request, 403);
      await env.LAB_STORE.put(commentKey, JSON.stringify(list.filter((c) => c.id !== commentId)));
      return json({ ok: true }, request);
    }

    return json({ error: "method not allowed" }, request, 405);
  }

  // ── Ph29: /reactions/:thesisId ────────────────────────
  if (parts[0] === "reactions" && parts[1]) {
    const thesisId = parts[1];
    const reactionKey = `reactions:${thesisId}`;
    const ALLOWED_EMOJIS = ["🔥", "💎", "📉", "✅", "❌"];

    if (request.method === "GET" && parts.length === 2) {
      const raw = await env.LAB_STORE.get(reactionKey);
      return json(raw ? JSON.parse(raw) : {}, request);
    }

    if (request.method === "PUT" && parts.length === 3) {
      const emoji = decodeURIComponent(parts[2]);
      if (!ALLOWED_EMOJIS.includes(emoji)) return json({ error: "emoji not allowed" }, request, 400);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, request, 400); }
      const wallet = typeof body.wallet === "string" ? body.wallet.toLowerCase().trim() : null;
      if (!wallet) return json({ error: "missing wallet" }, request, 400);
      const raw = await env.LAB_STORE.get(reactionKey);
      const reactions = raw ? JSON.parse(raw) : {};
      const reactors = reactions[emoji] ?? [];
      const idx = reactors.indexOf(wallet);
      if (idx >= 0) reactors.splice(idx, 1);
      else reactors.push(wallet);
      reactions[emoji] = reactors;
      await env.LAB_STORE.put(reactionKey, JSON.stringify(reactions));
      return json({ ok: true }, request);
    }

    return json({ error: "method not allowed" }, request, 405);
  }

  // ── Ph27: /notifications/:wallet ──────────────────────

  return null; // a feed/comments/reactions path we don't serve → fall through
}
