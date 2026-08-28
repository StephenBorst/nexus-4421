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

import { deriveSignal, computeRegime, atrPct } from "./logic.mjs";

const ORDERLY_API = "https://api-evm.orderly.org";

// Orderly sits behind Cloudflare bot-management, which intermittently serves an HTML
// 403 challenge to header-light Worker fetches — which would starve the brain of the
// market data it needs to emit signals. Realistic browser headers clear it; a bounded
// retry rides out a transient one. (Mirrors the same fix in nexus-agent-exec.)
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};
async function orderlyPublicGet(url, tries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch {
      lastErr = new Error(`orderly GET ${url} non-JSON (HTTP ${res.status}): ${text.slice(0, 80)}`);
      if (res.status === 403 && attempt < tries - 1) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

export default {
  async scheduled(event, env) {
    try {
      // Core OI history is MARKET DATA, not a per-user artifact — record it every
      // tick BEFORE any early return, so the CONFLUENCE backtest series keeps
      // maturing even when zero agents are active (the "no active users" returns
      // below used to strand it → history only grew while someone was trading).
      // Idempotent within a tick: recordOiSnapshot's 55-min gate no-ops the repeat
      // call for watchlist symbols further down.
      await recordOiForSymbols(["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC"], env);
      // Real OHLC+volume candles (from Orderly's own tv/history) — the SAME market-
      // data-not-per-user rationale as OI above, so it matures with zero active
      // agents. Unlocks true VWAP/ATR + rs_rank quartiles for the harness and the
      // futures-volume-rotation read. Hourly-gated so it only fetches once/hour.
      await recordCandlesForSymbols(["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC"], env);

      const usersRaw = await env.NEXUS_AGENT.get("agent:users");
      if (!usersRaw) { console.log("[brain] no active users"); return; }
      const users = JSON.parse(usersRaw);
      if (users.length === 0) { console.log("[brain] no active users"); return; }

      console.log(`[brain] processing ${users.length} active user(s)`);

      // Load each active user's config up front.
      const userConfigs = {};
      const symbolSet = new Set(); // every symbol any active user watches
      const oiSymbols = new Set(["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC"]); // core + all watchlists
      for (const address of users) {
        const configRaw = await env.NEXUS_AGENT.get(`agent:config:${address}`);
        const stateRaw = await env.NEXUS_AGENT.get(`agent:state:${address}`);
        if (!configRaw || !stateRaw) continue;
        const config = JSON.parse(configRaw);
        const state = JSON.parse(stateRaw);
        for (const sym of config.symbols || []) oiSymbols.add(sym); // record OI regardless of position
        if (!state.active || state.current_position) continue;
        userConfigs[address] = { config, state };
        for (const sym of config.symbols || []) symbolSet.add(sym);
      }

      // Accumulate OI + candle history independent of the (flat-only) signal path.
      await recordOiForSymbols(oiSymbols, env);
      await recordCandlesForSymbols(oiSymbols, env);

      // Evaluate each unique symbol exactly once this cycle → RAW market deltas.
      // Strategy interpretation (mode/thresholds) is applied PER USER below, so a
      // symbol is still fetched once but each user gets their own signal from it.
      // Only compute the funding percentile if some active user opted into the filter.
      const needFundingPct = Object.values(userConfigs).some(({ config }) => (config.fundingPercentileMin ?? 0) > 0);
      // Only fetch candles for ATR when some active user opted into the volatility gate.
      const needVol = Object.values(userConfigs).some(({ config }) => (config.minVolAtrPct ?? 0) > 0 || (config.maxVolAtrPct ?? 0) > 0);
      const rawBySymbol = {};
      for (const symbol of symbolSet) {
        try {
          rawBySymbol[symbol] = await evaluateSymbol(symbol, env, needFundingPct, needVol);
        } catch (e) {
          console.error(`[brain] ${symbol} eval error:`, e.message);
        }
      }

      // Market-wide regime — computed once per tick, only if someone opted in.
      // Gates entries that fight a strong tape for users with respectRegime on.
      let regime = null;
      if (Object.values(userConfigs).some(({ config }) => config.respectRegime)) {
        try {
          const j = await orderlyPublicGet(`${ORDERLY_API}/v1/public/futures`);
          regime = computeRegime(j?.data?.rows || []);
          console.log(`[brain] regime: ${regime ? `${regime.label} (${regime.score})` : "n/a"}`);
        } catch (e) { console.error("[brain] regime fetch error:", e.message); }
      }

      // Smart-money consensus — one KV read per tick, only if someone opted in.
      // Written by lab-api's Smart Money board build (shared NEXUS_AGENT namespace);
      // absent/stale → the gate no-ops (fail-safe). Keyed by bare coin.
      let smartConsensus = null;
      if (Object.values(userConfigs).some(({ config }) => config.respectSmartMoney)) {
        try { const c = await env.NEXUS_AGENT.get("sm:consensus"); smartConsensus = c ? JSON.parse(c) : null; }
        catch (e) { console.error("[brain] consensus fetch error:", e.message); }
      }

      // Assign the best qualifying signal to each user from their watchlist,
      // honoring THEIR strategy config (signalMode + thresholds).
      for (const [address, { config }] of Object.entries(userConfigs)) {
        try {
          let best = { symbol: null, direction: "NONE", funding: 0, oi: 0, confidence: 0, price: 0, reason: "no signal" };
          for (const sym of config.symbols || []) {
            const raw = rawBySymbol[sym];
            if (!raw) continue;
            const coin = sym.replace("PERP_", "").replace("_USDC", "");
            const cons = (config.respectSmartMoney && smartConsensus) ? smartConsensus[coin] : null;
            const sig = deriveSignal(raw, config, config.respectRegime ? regime : null, cons);
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
async function evaluateSymbol(symbol, env, computeFundingPct = false, computeVol = false) {
  const json = await orderlyPublicGet(`${ORDERLY_API}/v1/public/futures/${symbol}`);
  const d = json.data;

  const markPrice = parseFloat(d.mark_price);
  const fundingRate = parseFloat(d.last_funding_rate) || 0;
  const openInterest = parseFloat(d.open_interest) || 0;

  // Recent ATR% for the opt-in volatility gate — one extra fetch, ONLY when a user
  // needs it (mirrors the fundingPct gating). Uses the SAME atrPct formula as the
  // backtest so the live gate matches the validated sim. Undefined on any failure →
  // the gate fail-opens (matches every other opt-in gate).
  let atrPctVal;
  if (computeVol) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const th = await orderlyPublicGet(`${ORDERLY_API}/tv/history?symbol=${symbol}&resolution=60&from=${now - 24 * 3600}&to=${now}`);
      if (th && th.s === "ok" && Array.isArray(th.t) && th.t.length >= 5) {
        const candles = th.t.map((t, i) => ({ o: +th.o[i], h: +th.h[i], l: +th.l[i], c: +th.c[i] }));
        const a = atrPct(candles);
        if (Number.isFinite(a)) atrPctVal = a;
      }
    } catch { /* leave undefined → vol gate stays off for this tick */ }
  }

  // Funding percentile vs Orderly's history — only when a user's config needs it
  // (the fundingPercentileMin filter). Skipped otherwise to avoid extra fetches.
  let fundingPct;
  if (computeFundingPct) {
    try {
      const rates = [];
      for (let page = 1; page <= 2; page++) {
        const fd = await orderlyPublicGet(`${ORDERLY_API}/v1/public/funding_rate_history?symbol=${symbol}&page=${page}&size=100`);
        const rows = fd?.data?.rows || [];
        rates.push(...rows.map((x) => Number(x.funding_rate)).filter(Number.isFinite));
        if (rows.length < 100) break;
      }
      if (rates.length) {
        let atOrBelow = 0;
        for (const v of rates) if (v <= fundingRate) atOrBelow++;
        fundingPct = Math.round((atOrBelow / rates.length) * 100);
      }
    } catch { /* leave undefined → gate stays off for this tick */ }
  }

  // Prior snapshot for this symbol (set last cycle).
  const prevRaw = await env.NEXUS_AGENT.get(`market:prev:${symbol}`);
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  const priceChange = prev && prev.price ? (markPrice - prev.price) / prev.price : 0;
  const oiChange = prev && prev.oi ? (openInterest - prev.oi) / prev.oi : 0;

  // Update the snapshot for next cycle.
  await env.NEXUS_AGENT.put(`market:prev:${symbol}`, JSON.stringify({
    price: markPrice, oi: openInterest, timestamp: Date.now(),
  }));

  return {
    symbol, price: markPrice, oi: openInterest, fundingRate, priceChange, oiChange, hasPrev: !!prev, fundingPct,
    // Regime-conditioning inputs for the opt-in session/vol gates in deriveSignal.
    hourUtc: new Date().getUTCHours(),
    ...(atrPctVal !== undefined ? { atrPct: atrPctVal } : {}),
  };
}

// Snapshot hourly OI for a set of symbols, INDEPENDENT of the signal path (which
// only evaluates symbols for flat users). Orderly has no OI-history endpoint, so
// this accumulates our OWN series → CONFLUENCE becomes backtestable in a few weeks.
// Best-effort; never throws into the caller.
async function recordOiForSymbols(symbols, env) {
  for (const symbol of symbols) {
    try {
      const d = (await orderlyPublicGet(`${ORDERLY_API}/v1/public/futures/${symbol}`)).data;
      await recordOiSnapshot(symbol, env, {
        price: parseFloat(d.mark_price), oi: parseFloat(d.open_interest) || 0, funding: parseFloat(d.last_funding_rate) || 0,
      });
    } catch (e) { console.error(`[brain] oi snapshot ${symbol}:`, e.message); }
  }
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

// Snapshot the last CLOSED hourly OHLC+volume candle for a set of symbols into our
// OWN series candle:hist:{symbol} = [{t,o,h,l,c,v}]. Sourced from Orderly's tv/history
// (real exchange OHLC + base volume), gated to one fetch per symbol per hour so it
// costs a subrequest only when a new candle is actually due. Best-effort; never throws.
async function recordCandlesForSymbols(symbols, env) {
  const now = Date.now();
  for (const symbol of symbols) {
    try {
      const key = `candle:hist:${symbol}`;
      const raw = await env.NEXUS_AGENT.get(key);
      const hist = raw ? JSON.parse(raw) : [];
      const last = hist[hist.length - 1];
      if (last && now - last.t < 55 * 60 * 1000) continue; // hourly — skip the fetch entirely

      const nowSec = Math.floor(now / 1000);
      const th = await orderlyPublicGet(`${ORDERLY_API}/tv/history?symbol=${symbol}&resolution=60&from=${nowSec - 3 * 3600}&to=${nowSec}`);
      if (!th || th.s !== "ok" || !Array.isArray(th.t) || th.t.length === 0) continue;

      // Prefer the last CLOSED candle (bucket start ≤ the current hour boundary) so we
      // never persist a still-forming bar; fall back to the most recent if all are open.
      const hourStartSec = Math.floor(nowSec / 3600) * 3600;
      let idx = th.t.length - 1;
      while (idx > 0 && Number(th.t[idx]) >= hourStartSec) idx--;
      const c = {
        t: Number(th.t[idx]) * 1000,
        o: +th.o[idx], h: +th.h[idx], l: +th.l[idx], c: +th.c[idx],
        v: Array.isArray(th.v) ? +th.v[idx] : 0,
      };
      if (![c.o, c.h, c.l, c.c].every(Number.isFinite)) continue;
      // De-dup: if we already have this bucket (t), skip; the 55-min gate makes this rare.
      if (last && last.t === c.t) continue;
      hist.push(c);
      if (hist.length > 2200) hist.splice(0, hist.length - 2200); // ~90d hourly
      await env.NEXUS_AGENT.put(key, JSON.stringify(hist));
    } catch (e) {
      console.error(`[brain] candle-history ${symbol} failed:`, e.message);
    }
  }
}
