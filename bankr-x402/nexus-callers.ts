// Bankr x402 handler — paid machine API for Nexus's verified-caller data.
// Bankr wraps the payment layer (priced in $NEXUS via bankr.x402.json); this is
// just the plain Request → Response handler that runs AFTER payment is settled.
//
// Returns the trustless caller leaderboard — calls graded from PUBLIC price
// (first-touch TP-vs-SL) and anchored on-chain, so the numbers are recomputable
// and unfakeable. That's the thing worth paying for: provably-real signal data,
// not self-reported PnL. The free web board stays free for humans; this is the
// machine-consumable, pay-per-call API for agents.
//
// ⚠️ Handler signature follows the documented "plain Request → Response (+ ctx)"
// model. If chat-deploying, Bankr writes this for you — keep this as the spec.

const LAB_API = "https://og.nexustradinglabs.com";

export default async function handler(_req: Request): Promise<Response> {
  try {
    const r = await fetch(`${LAB_API}/theses/leaderboard`);
    if (!r.ok) {
      return new Response(JSON.stringify({ error: "upstream_unavailable", status: r.status }), {
        status: 502, headers: { "content-type": "application/json" },
      });
    }
    const data = await r.json();
    return new Response(JSON.stringify({
      source: "Nexus Trading Labs — verified callers, graded from public price + anchored on-chain",
      verify: `${LAB_API}/theses/ledger`,
      generated_at: new Date().toISOString(),
      ...data,
    }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "handler_error", detail: String((e as Error)?.message || e) }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
}
