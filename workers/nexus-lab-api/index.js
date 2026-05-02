/**
 * nexus-lab-api — Cloudflare Worker
 *
 * KV namespace binding: LAB_STORE  (set in Cloudflare dashboard)
 *
 * Routes:
 *   GET    /lab/:address              → fetch all LAB data for wallet
 *   PUT    /lab/:address              → save all LAB data for wallet
 *   DELETE /lab/:address/thesis/:id   → remove one thesis
 *   GET    /profile/:address          → fetch profile { pfp, displayName }
 *   PUT    /profile/:address          → save profile { pfp, displayName }
 *   GET    /feed                      → public theses feed (all wallets, isPublic=true)
 */

const ALLOWED_ORIGINS = [
  "https://trade.nexustradinglabs.com",
  "http://localhost:5173",
  "http://localhost:3000",
];

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(request) },
  });
}

function normalizeAddress(addr) {
  return addr.toLowerCase().trim();
}

export default {
  async fetch(request, env) {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(request) });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // ── /feed ──────────────────────────────────────────────
    if (parts[0] === "feed") {
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

      // Sort newest first
      feedItems.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json({ feed: feedItems }, request);
    }

    // ── /profile/:address ──────────────────────────────────
    if (parts[0] === "profile") {
      if (!parts[1]) return json({ error: "not found" }, request, 404);
      const address = normalizeAddress(parts[1]);
      const profileKey = `profile:${address}`;

      if (request.method === "GET") {
        const raw = await env.LAB_STORE.get(profileKey);
        if (!raw) return json({ pfp: null, displayName: null }, request);
        return json(JSON.parse(raw), request);
      }

      if (request.method === "PUT") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid json" }, request, 400);
        }
        // Only allow pfp (URL string) and displayName
        const profile = {
          pfp: typeof body.pfp === "string" ? body.pfp.trim().slice(0, 500) : null,
          displayName: typeof body.displayName === "string" ? body.displayName.trim().slice(0, 40) : null,
        };
        await env.LAB_STORE.put(profileKey, JSON.stringify(profile));
        return json({ ok: true }, request);
      }

      return json({ error: "method not allowed" }, request, 405);
    }

    // ── /lab/:address ──────────────────────────────────────
    if (parts[0] !== "lab" || !parts[1]) {
      return json({ error: "not found" }, request, 404);
    }

    const address = normalizeAddress(parts[1]);
    const kvKey = `lab:${address}`;

    // ── GET /lab/:address ──────────────────────────────────
    if (request.method === "GET") {
      const raw = await env.LAB_STORE.get(kvKey);
      if (!raw) {
        return json({ theses: [], notes: {} }, request);
      }
      return json(JSON.parse(raw), request);
    }

    // ── PUT /lab/:address ──────────────────────────────────
    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, request, 400);
      }

      if (!Array.isArray(body.theses) || typeof body.notes !== "object") {
        return json({ error: "expected { theses: [], notes: {} }" }, request, 400);
      }

      await env.LAB_STORE.put(kvKey, JSON.stringify(body));
      return json({ ok: true }, request);
    }

    // ── DELETE /lab/:address/thesis/:id ────────────────────
    if (request.method === "DELETE" && parts[2] === "thesis" && parts[3]) {
      const thesisId = parts[3];
      const raw = await env.LAB_STORE.get(kvKey);
      if (!raw) return json({ ok: true }, request);

      const data = JSON.parse(raw);
      data.theses = (data.theses || []).filter((t) => t.id !== thesisId);
      await env.LAB_STORE.put(kvKey, JSON.stringify(data));
      return json({ ok: true }, request);
    }

    return json({ error: "method not allowed" }, request, 405);
  },
};
