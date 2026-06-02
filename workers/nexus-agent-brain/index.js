// ═══════════════════════════════════════════════════════════
// nexus-agent-brain — Multi-User Signal Engine
// Cron: every 5 minutes
// KV binding: NEXUS_AGENT
//
// Reads agent:users → collects every watched symbol → evaluates the
// proven funding + OI-divergence confluence signal ONCE per symbol →
// writes agent:signal:{address} for each active user.
//
// Signal logic ported from the validated single-user bot (Handoff 012):
//   Rule 1 (funding extreme, mean-revert): rate > +thr → SHORT, < -thr → LONG
//   Rule 2 (OI divergence):
//     price↑ + OI↓ → SHORT      price↓ + OI↑ → LONG    (fade weakening)
//     price↑ + OI↑ → LONG       price↓ + OI↓ → SHORT   (follow strong)
//   Entry: BOTH rules must agree (confluence). Single signal = no trade.
// ═══════════════════════════════════════════════════════════

const ORDERLY_API = "https://api-evm.orderly.org";

export default {
  async scheduled(event, env) {
    try {
      const usersRaw = await env.NEXUS_AGENT.get("agent:users");
      if (!usersRaw) { console.log("[brain] no active users"); return; }
      const users = JSON.parse(usersRaw);
      if (users.length === 0) { console.log("[brain] no active users"); return; }

      console.log(`[brain] processing ${users.length} active user(s)`);

      // Load each active user's config up front.
      const userConfigs = {};
      const symbolThresholds = {}; // symbol → smallest funding threshold among watchers
      for (const address of users) {
        const configRaw = await env.NEXUS_AGENT.get(`agent:config:${address}`);
        const stateRaw = await env.NEXUS_AGENT.get(`agent:state:${address}`);
        if (!configRaw || !stateRaw) continue;
        const config = JSON.parse(configRaw);
        const state = JSON.parse(stateRaw);
        if (!state.active || state.current_position) continue;
        userConfigs[address] = { config, state };
        for (const sym of config.symbols || []) {
          const thr = (config.fundingThreshold || 0.01) / 100; // % → decimal
          symbolThresholds[sym] = symbolThresholds[sym] === undefined
            ? thr : Math.min(symbolThresholds[sym], thr);
        }
      }

      // Evaluate each unique symbol exactly once this cycle.
      const signalsBySymbol = {};
      for (const symbol of Object.keys(symbolThresholds)) {
        try {
          signalsBySymbol[symbol] = await evaluateSymbol(symbol, symbolThresholds[symbol], env);
        } catch (e) {
          console.error(`[brain] ${symbol} eval error:`, e.message);
        }
      }

      // Assign the best qualifying signal to each user from their watchlist.
      for (const [address, { config, state }] of Object.entries(userConfigs)) {
        try {
          let best = { symbol: null, direction: "NONE", funding: 0, oi: 0, confidence: 0, price: 0, reason: "no confluence" };
          for (const sym of config.symbols || []) {
            const s = signalsBySymbol[sym];
            // Re-check this user's own threshold (a stricter user shouldn't inherit a looser fire).
            if (s && s.direction !== "NONE" && Math.abs(s.funding) >= (config.fundingThreshold || 0.01) / 100) {
              if (s.confidence > best.confidence) best = s;
            }
          }
          const signalData = { ...best, timestamp: Date.now(), user: address };
          // The brain ONLY owns agent:signal. It must never write agent:state —
          // that key is single-writer-owned by the exec Worker (risk counters,
          // daily reset, position). Writing state here previously raced with the
          // exec's 1-min cycle and clobbered trades_today / daily resets. The UI's
          // "last signal" is now sourced from agent:signal (merged by lab-api).
          await env.NEXUS_AGENT.put(`agent:signal:${address}`, JSON.stringify(signalData));
          console.log(`[brain] ${address.slice(0, 10)} → ${best.symbol || "none"} ${best.direction} conf=${best.confidence}% (${best.reason})`);
        } catch (e) {
          console.error(`[brain] assign error for ${address.slice(0, 10)}:`, e.message);
        }
      }
    } catch (e) {
      console.error("[brain] fatal error:", e.message);
    }
  },
};

// Evaluate one symbol with funding + OI-divergence confluence.
// `prevKey` state is stored per symbol so price/OI deltas are real.
async function evaluateSymbol(symbol, fundingThreshold, env) {
  const res = await fetch(`${ORDERLY_API}/v1/public/futures/${symbol}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = await res.json();
  const d = json.data;

  const markPrice = parseFloat(d.mark_price);
  const fundingRate = parseFloat(d.last_funding_rate) || 0;
  const openInterest = parseFloat(d.open_interest) || 0;

  // Prior snapshot for this symbol (set last cycle).
  const prevRaw = await env.NEXUS_AGENT.get(`market:prev:${symbol}`);
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  const priceChange = prev && prev.price ? (markPrice - prev.price) / prev.price : 0;
  const oiChange = prev && prev.oi ? (openInterest - prev.oi) / prev.oi : 0;

  // Rule 1 — funding extreme (fade the crowd).
  const fundingSignal =
    fundingRate >= fundingThreshold ? "SHORT" :
    fundingRate <= -fundingThreshold ? "LONG" : "NONE";

  // Rule 2 — OI divergence (needs a prior snapshot to compute).
  let oiSignal = "NONE";
  if (prev) {
    if (priceChange > 0 && oiChange < 0) oiSignal = "SHORT";
    else if (priceChange < 0 && oiChange > 0) oiSignal = "LONG";
    else if (priceChange > 0 && oiChange > 0) oiSignal = "LONG";
    else if (priceChange < 0 && oiChange < 0) oiSignal = "SHORT";
  }

  // Confluence: both rules must agree.
  let direction = "NONE";
  let confidence = 0;
  let reason = "no confluence";
  if (fundingSignal !== "NONE" && fundingSignal === oiSignal) {
    direction = fundingSignal;
    confidence = 80;
    reason = `funding=${fundingRate.toFixed(6)} oiChange=${(oiChange * 100).toFixed(3)}% priceChange=${(priceChange * 100).toFixed(3)}%`;
  }

  // Update the snapshot for next cycle.
  await env.NEXUS_AGENT.put(`market:prev:${symbol}`, JSON.stringify({
    price: markPrice, oi: openInterest, timestamp: Date.now(),
  }));

  return { symbol, direction, funding: fundingRate, oi: openInterest, price: markPrice, confidence, reason };
}
