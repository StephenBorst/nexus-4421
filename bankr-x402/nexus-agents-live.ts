// Bankr x402 handler — Nexus LIVE NOW positions as a machine API. Currently-open
// agent + opted-in human positions with uPnL recomputed from PUBLIC mark price
// (never self-reported). Bankr wraps the payment layer (priced in $NEXUS).

const LAB_API = "https://og.nexustradinglabs.com";

export default async function handler(_req: Request): Promise<Response> {
  try {
    const r = await fetch(`${LAB_API}/agents/live`);
    if (!r.ok) {
      return new Response(JSON.stringify({ error: "upstream_unavailable", status: r.status }), {
        status: 502, headers: { "content-type": "application/json" },
      });
    }
    const data = await r.json();
    return new Response(JSON.stringify({
      source: "Nexus Trading Labs — LIVE NOW open positions, uPnL from public mark price",
      generated_at: new Date().toISOString(),
      ...data,
    }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "handler_error", detail: String((e as Error)?.message || e) }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
}
