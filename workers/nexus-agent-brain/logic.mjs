// Pure strategy logic for the agent brain. Extracted so tests cover the REAL
// deployed code (index.js imports this). Given raw per-symbol market deltas and
// a user's strategy config, derive that user's signal.
//
// Customization: signalMode lets users choose how funding + OI-divergence combine.
//   CONFLUENCE (default, validated) — both funding + OI rules must AGREE. Strictest.
//   FUNDING_ONLY                    — fade funding extremes only.
//   OI_ONLY                         — OI-divergence only.
//   MOMENTUM                        — trade WITH a tick price move > priceChangeThreshold (trend-follow).
//   MEAN_REVERSION                  — FADE a tick price move > priceChangeThreshold (buy dip / sell rip).
// Thresholds (per user): fundingThreshold (%), oiChangeThreshold (% min OI move to count).
// Guardrails (loss cap, max trades, kill switch, order-only keys) live in exec and
// are NOT tunable here — users tune the STRATEGY, never the seatbelts.

// Market-wide regime from a full futures snapshot (all symbols). Pure + testable.
// Mirrors the frontend MarketRegime: breadth (50%) + BTC trend (40%) + funding
// crowding (10%) → 0-100 score → RISK_ON / NEUTRAL / RISK_OFF. Used ONLY to gate
// new entries for users who opt into respectRegime (it never flips direction).
export function computeRegime(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const chg = (m) => {
    const o = parseFloat(m["24h_open"]); const c = parseFloat(m["24h_close"]);
    if (!o || !c) return 0;
    const p = ((c - o) / o) * 100;
    return Math.abs(p) > 50 ? 0 : p; // guard bad ticks
  };
  const changes = rows.map(chg);
  const up = changes.filter((c) => c > 0).length;
  const breadth = (up / changes.length) * 100;
  const btc = rows.find((m) => m.symbol === "PERP_BTC_USDC");
  const btcChg = btc ? chg(btc) : 0;
  const fundings = rows.map((m) => parseFloat(m.last_funding_rate)).filter((f) => !isNaN(f));
  const fundPos = fundings.filter((f) => f > 0).length;
  const fundSkew = fundings.length ? (fundPos / fundings.length) * 100 : 50;
  const btcScore = Math.max(0, Math.min(100, 50 + btcChg * 6));
  const fundScore = 100 - Math.abs(fundSkew - 50) * 2;
  const score = Math.round(breadth * 0.5 + btcScore * 0.4 + fundScore * 0.1);
  const label = score >= 60 ? "RISK_ON" : score >= 42 ? "NEUTRAL" : "RISK_OFF";
  return { score, label };
}

// ATR as a % of price over the most recent `periods` completed candles ({o,h,l,c}
// ascending). This is the SAME formula the backtest's atrPctAt uses (TR = max of
// range / gap-up / gap-down, averaged, ÷ last close) — kept here so the live vol gate
// matches the validated sim exactly. Returns null when there isn't enough history.
export function atrPct(candles, periods = 14) {
  if (!Array.isArray(candles) || candles.length < 4) return null;
  const c = candles.slice(-(periods + 1)); // `periods` TRs need one extra bar for prevClose
  let trSum = 0, cnt = 0;
  for (let k = 1; k < c.length; k++) {
    const tr = Math.max(c[k].h - c[k].l, Math.abs(c[k].h - c[k - 1].c), Math.abs(c[k].l - c[k - 1].c));
    if (Number.isFinite(tr)) { trSum += tr; cnt++; }
  }
  const lastClose = c[c.length - 1].c;
  return cnt && lastClose > 0 ? (trSum / cnt / lastClose) * 100 : null;
}

export function deriveSignal(raw, config = {}, regime = null, smartConsensus = null) {
  const fundingRate = raw.fundingRate || 0;
  const priceChange = raw.priceChange || 0;
  const oiChange = raw.oiChange || 0;
  const hasPrev = !!raw.hasPrev;

  const fundingThreshold = (config.fundingThreshold ?? 0.01) / 100;     // % → decimal
  const oiChangeThreshold = (config.oiChangeThreshold ?? 0) / 100;       // % → decimal
  const priceChangeThreshold = (config.priceChangeThreshold ?? 0.5) / 100; // % → decimal
  const mode = config.signalMode || "CONFLUENCE";

  // Rule 1 — funding extreme (fade the crowd).
  const fundingSignal =
    fundingRate >= fundingThreshold ? "SHORT" :
    fundingRate <= -fundingThreshold ? "LONG" : "NONE";

  // Rule 2 — OI divergence (needs a prior snapshot + a minimum OI move).
  let oiSignal = "NONE";
  if (hasPrev && Math.abs(oiChange) >= oiChangeThreshold && oiChange !== 0) {
    if (priceChange > 0 && oiChange < 0) oiSignal = "SHORT";       // price up, OI down → fade
    else if (priceChange < 0 && oiChange > 0) oiSignal = "LONG";   // price down, OI up → fade
    else if (priceChange > 0 && oiChange > 0) oiSignal = "LONG";   // strong up → follow
    else if (priceChange < 0 && oiChange < 0) oiSignal = "SHORT";  // strong down → follow
  }

  let direction = "NONE";
  let confidence = 0;
  let why = "no signal";

  switch (mode) {
    case "FUNDING_ONLY":
      if (fundingSignal !== "NONE") { direction = fundingSignal; confidence = 65; why = "funding-only"; }
      break;
    case "OI_ONLY":
      if (oiSignal !== "NONE") { direction = oiSignal; confidence = 65; why = "oi-only"; }
      break;
    case "MOMENTUM":
      if (hasPrev && Math.abs(priceChange) >= priceChangeThreshold) {
        direction = priceChange > 0 ? "LONG" : "SHORT"; confidence = 60; why = "momentum";
      }
      break;
    case "MEAN_REVERSION":
      if (hasPrev && Math.abs(priceChange) >= priceChangeThreshold) {
        direction = priceChange > 0 ? "SHORT" : "LONG"; confidence = 60; why = "mean-reversion";
      }
      break;
    case "EXTERNAL":
      // Arena / bring-your-own-brain — the house brain stays silent for this agent;
      // entries come ONLY from its own webhook intents. Explicit case so it can
      // never fall through to the CONFLUENCE default and fire house signals.
      break;
    case "CONFLUENCE":
    default:
      if (fundingSignal !== "NONE" && fundingSignal === oiSignal) { direction = fundingSignal; confidence = 80; why = "confluence"; }
      break;
  }

  // Opt-in funding-PERCENTILE filter — fade the crowd only when funding is genuinely
  // EXTREME vs its own history (context beats a fixed threshold). Applies only to
  // funding-driven fades (FUNDING_ONLY / CONFLUENCE); raw.fundingPct is 0-100 (the
  // brain supplies it). Off when fundingPercentileMin is 0/unset or pct is absent —
  // so existing agents are unchanged.
  if (direction !== "NONE" && (config.fundingPercentileMin ?? 0) > 0 &&
      (mode === "FUNDING_ONLY" || mode === "CONFLUENCE") && fundingSignal !== "NONE" &&
      Number.isFinite(raw.fundingPct)) {
    const min = config.fundingPercentileMin;
    const extreme = direction === "SHORT" ? raw.fundingPct >= min : raw.fundingPct <= (100 - min);
    if (!extreme) {
      return { direction: "NONE", confidence: 0, reason: `funding not extreme (${raw.fundingPct}th pct, need ${direction === "SHORT" ? `≥${min}` : `≤${100 - min}`})` };
    }
  }

  // Opt-in regime filter — skip NEW entries that fight a STRONG tape. It never
  // flips direction or touches open positions; it only suppresses a fresh entry.
  if (direction !== "NONE" && config.respectRegime && regime && regime.label !== "NEUTRAL") {
    const fightsTape =
      (regime.label === "RISK_OFF" && direction === "LONG") ||
      (regime.label === "RISK_ON" && direction === "SHORT");
    if (fightsTape) {
      return { direction: "NONE", confidence: 0, reason: `regime-gated (${regime.label} vs ${direction})` };
    }
  }

  // Opt-in smart-money filter — skip a NEW entry that fights a STRONG consensus of
  // top on-chain traders on this symbol. Fail-safe: no consensus data → no gating.
  // (Smart money is often early AND often wrong — this is a guardrail, not a signal.)
  if (direction !== "NONE" && config.respectSmartMoney && smartConsensus && smartConsensus.count >= 3
      && smartConsensus.side !== direction) {
    return { direction: "NONE", confidence: 0, reason: `smart-money-gated (${smartConsensus.count} traders ${smartConsensus.side})` };
  }

  // ── Opt-in REGIME CONDITIONING (backtest-validated: the edge is in WHEN a signal
  //    fires, not the signal). Both default OFF, so existing agents are unchanged. The
  //    caller (brain live + backtest) supplies raw.hourUtc + raw.atrPct so the SAME gate
  //    runs in sim and in prod — no drift. ──
  // SESSION: only enter during selected UTC sessions (ASIA <8h · EUROPE 8-15h · US 15-24h).
  // Backtest finding: Asia is where funding fades bleed; excluding it lifts win rate.
  if (direction !== "NONE" && Array.isArray(config.tradeSessions) && config.tradeSessions.length && Number.isFinite(raw.hourUtc)) {
    const sess = raw.hourUtc < 8 ? "ASIA" : raw.hourUtc < 15 ? "EUROPE" : "US";
    if (!config.tradeSessions.includes(sess)) {
      return { direction: "NONE", confidence: 0, reason: `session-gated (${sess} not in [${config.tradeSessions.join(",")}])` };
    }
  }
  // VOLATILITY: only enter when recent ATR% is in [minVolAtrPct, maxVolAtrPct]. Finding:
  // fades (invert-confluence) want HIGH vol (a min); mean-reversion wants CALM (a max).
  if (direction !== "NONE" && Number.isFinite(raw.atrPct)) {
    if ((config.minVolAtrPct ?? 0) > 0 && raw.atrPct < config.minVolAtrPct) {
      return { direction: "NONE", confidence: 0, reason: `vol-gated (atr ${raw.atrPct.toFixed(2)}% < min ${config.minVolAtrPct}%)` };
    }
    if ((config.maxVolAtrPct ?? 0) > 0 && raw.atrPct > config.maxVolAtrPct) {
      return { direction: "NONE", confidence: 0, reason: `vol-gated (atr ${raw.atrPct.toFixed(2)}% > max ${config.maxVolAtrPct}%)` };
    }
  }

  // ── INVERT (fade your own signal) ──────────────────────────────────────────
  // If a signal is SYSTEMATICALLY wrong (net-negative in the direction it fires),
  // then the edge is the OPPOSITE trade — short when it says long. This flips the
  // final direction so the whole pipeline (feed, exec, and crucially the BACKTEST)
  // reflects the faded call, letting you PROVE whether inverting is actually +EV for
  // a given config rather than guessing. No-op on NONE. Off by default.
  if (config.invertSignal && (direction === "LONG" || direction === "SHORT")) {
    direction = direction === "LONG" ? "SHORT" : "LONG";
  }

  const reason = direction === "NONE"
    ? why
    : `${config.invertSignal ? "↺ inverted · " : ""}${why} funding=${fundingRate.toFixed(6)} oiΔ=${(oiChange * 100).toFixed(3)}% priceΔ=${(priceChange * 100).toFixed(3)}%`;

  return { direction, confidence, reason };
}
