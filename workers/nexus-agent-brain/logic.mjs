// Pure strategy logic for the agent brain. Extracted so tests cover the REAL
// deployed code (index.js imports this). Given raw per-symbol market deltas and
// a user's strategy config, derive that user's signal.
//
// Customization: signalMode lets users choose how funding + OI-divergence combine.
//   CONFLUENCE (default, validated) — both rules must AGREE. Strictest, highest quality.
//   FUNDING_ONLY                    — fade funding extremes only.
//   OI_ONLY                         — OI-divergence only.
// Thresholds (per user): fundingThreshold (%), oiChangeThreshold (% min OI move to count).
// Guardrails (loss cap, max trades, kill switch, order-only keys) live in exec and
// are NOT tunable here — users tune the STRATEGY, never the seatbelts.

export function deriveSignal(raw, config = {}) {
  const fundingRate = raw.fundingRate || 0;
  const priceChange = raw.priceChange || 0;
  const oiChange = raw.oiChange || 0;
  const hasPrev = !!raw.hasPrev;

  const fundingThreshold = (config.fundingThreshold ?? 0.01) / 100; // % → decimal
  const oiChangeThreshold = (config.oiChangeThreshold ?? 0) / 100;   // % → decimal
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
    case "CONFLUENCE":
    default:
      if (fundingSignal !== "NONE" && fundingSignal === oiSignal) { direction = fundingSignal; confidence = 80; why = "confluence"; }
      break;
  }

  const reason = direction === "NONE"
    ? why
    : `${why} funding=${fundingRate.toFixed(6)} oiΔ=${(oiChange * 100).toFixed(3)}% priceΔ=${(priceChange * 100).toFixed(3)}%`;

  return { direction, confidence, reason };
}
