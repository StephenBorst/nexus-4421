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

export function deriveSignal(raw, config = {}, regime = null) {
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
    case "CONFLUENCE":
    default:
      if (fundingSignal !== "NONE" && fundingSignal === oiSignal) { direction = fundingSignal; confidence = 80; why = "confluence"; }
      break;
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

  const reason = direction === "NONE"
    ? why
    : `${why} funding=${fundingRate.toFixed(6)} oiΔ=${(oiChange * 100).toFixed(3)}% priceΔ=${(priceChange * 100).toFixed(3)}%`;

  return { direction, confidence, reason };
}
