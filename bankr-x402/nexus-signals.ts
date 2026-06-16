// Bankr x402 handler — PREMIUM: the Nexus agent's edge, as machine-readable data.
// Returns current funding-extreme + OI-divergence reads per symbol, classified by
// the SAME rules as the autonomous agent (confluence = both rules agree). Bankr
// wraps the payment layer (priced in $NEXUS via bankr.x402.json); this runs after
// settlement. Sold higher than the read-only endpoints because it's the alpha.

const LAB_API = "https://og.nexustradinglabs.com";

export default async function handler(_req: Request): Promise<Response> {
  try {
    const r = await fetch(`${LAB_API}/signals`);
    if (!r.ok) {
      return new Response(JSON.stringify({ error: "upstream_unavailable", status: r.status }), {
        status: 502, headers: { "content-type": "application/json" },
      });
    }
    const data = await r.json();
    return new Response(JSON.stringify({
      source: "Nexus Trading Labs — funding + OI-divergence signals (same engine as the autonomous agent)",
      ...data,
    }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "handler_error", detail: String((e as Error)?.message || e) }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
}
