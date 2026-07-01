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

import { deriveSignal, computeRegime } from "./logic.mjs";

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
      const symbolSet = new Set(); // every symbol any active user watches
      for (const address of users) {
        const configRaw = await env.NEXUS_AGENT.get(`agent:config:${address}`);
        const stateRaw = await env.NEXUS_AGENT.get(`agent:state:${address}`);
        if (!configRaw || !stateRaw) continue;
        const config = JSON.parse(configRaw);
        const state = JSON.parse(stateRaw);
        if (!state.active || state.current_position) continue;
        userConfigs[address] = { config, state };
        for (const sym of config.symbols || []) symbolSet.add(sym);
      }

      // Evaluate each unique symbol exactly once this cycle → RAW market deltas.
      // Strategy interpretation (mode/thresholds) is applied PER USER below, so a
      // symbol is still fetched once but each user gets their own signal from it.
      const rawBySymbol = {};
      for (const symbol of symbolSet) {
        try {
          rawBySymbol[symbol] = await evaluateSymbol(symbol, env);
        } catch (e) {
          console.error(`[brain] ${symbol} eval error:`, e.message);
        }
      }

      // Market-wide regime — computed once per tick, only if someone opted in.
      // Gates entries that fight a strong tape for users with respectRegime on.
      let regime = null;
      if (Object.values(userConfigs).some(({ config }) => config.respectRegime)) {
        try {
          const res = await fetch(`${ORDERLY_API}/v1/public/futures`);
          if (res.ok) { const j = await res.json(); regime = computeRegime(j?.data?.rows || []); }
          console.log(`[brain] regime: ${regime ? `${regime.label} (${regime.score})` : "n/a"}`);
        } catch (e) { console.error("[brain] regime fetch error:", e.message); }
      }

      // Assign the best qualifying signal to each user from their watchlist,
      // honoring THEIR strategy config (signalMode + thresholds).
      for (const [address, { config }] of Object.entries(userConfigs)) {
        try {
          let best = { symbol: null, direction: "NONE", funding: 0, oi: 0, confidence: 0, price: 0, reason: "no signal" };
          for (const sym of config.symbols || []) {
            const raw = rawBySymbol[sym];
            if (!raw) continue;
            const sig = deriveSignal(raw, config, config.respectRegime ? regime : null);
            if (sig.direction !== "NONE" && sig.confidence > best.confidence) {
              best = { symbol: sym, direction: sig.direction, funding: raw.fundingRate, oi: raw.oi, price: raw.price, confidence: sig.confidence, reason: sig.reason };
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
    } finally {
      // Liveness heartbeat — stamps every completed run regardless of whether
      // any signals were emitted (e.g. all active users hold open positions, so
      // the brain correctly emits nothing). The ops monitor watches this.
      try { await env.NEXUS_AGENT.put("ops:brain:heartbeat", String(Date.now())); } catch {}
    }
  },
};

// Fetch one symbol's market data and compute RAW deltas vs last cycle.
// No strategy interpretation here — deriveSignal() applies each user's mode +
// thresholds. `market:prev:{symbol}` is stored so price/OI deltas are real.
async function evaluateSymbol(symbol, env) {
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

  // Update the snapshot for next cycle.
  await env.NEXUS_AGENT.put(`market:prev:${symbol}`, JSON.stringify({
    price: markPrice, oi: openInterest, timestamp: Date.now(),
  }));

  // Build our OWN open-interest history. Orderly exposes only CURRENT OI (no
  // historical series), so the CONFLUENCE (funding + OI-divergence) flagship can't
  // be backtested from their API. Snapshotting OI hourly here means that in a few
  // weeks we can backtest confluence against a real OI series we recorded. Cheap
  // (the data's already fetched) and best-effort — must never break signal gen.
  await recordOiSnapshot(symbol, env, { price: markPrice, oi: openInterest, funding: fundingRate });

  return { symbol, price: markPrice, oi: openInterest, fundingRate, priceChange, oiChange, hasPrev: !!prev };
}

// Append an hourly {t, price, oi, funding} point to oi:hist:{symbol}. The brain
// runs every ~5 min, so we only append when the last point is ≥55 min old →
// an hourly series. Capped to ~90 days.
async function recordOiSnapshot(symbol, env, { price, oi, funding }) {
  try {
    const key = `oi:hist:${symbol}`;
    const raw = await env.NEXUS_AGENT.get(key);
    const hist = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    const last = hist[hist.length - 1];
    if (last && now - last.t < 55 * 60 * 1000) return; // keep it hourly
    hist.push({ t: now, price, oi, funding });
    if (hist.length > 2200) hist.splice(0, hist.length - 2200); // ~90d hourly
    await env.NEXUS_AGENT.put(key, JSON.stringify(hist));
  } catch (e) {
    console.error(`[brain] oi-history ${symbol} failed:`, e.message);
  }
}
