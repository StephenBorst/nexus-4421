// ═══════════════════════════════════════════════════════════
// Pure, testable logic for nexus-lab-api.
// Imported by index.js so tests cover the real deployed behavior.
// ═══════════════════════════════════════════════════════════

/**
 * Grade a human "call" (thesis) against public OHLC candles, first-touch.
 * Trustless: the outcome is a fact about public price, not self-report.
 * - LONG  wins if a candle high reaches takeProfit1 before a low hits stopLoss
 * - SHORT wins if a candle low reaches takeProfit1 before a high hits stopLoss
 * - Same-candle TP+SL = LOSS (conservative, anti-gaming)
 * - WIN scores +planned R (riskReward, default 1); LOSS = -1R
 *
 * @param {object} t  thesis { direction, entryPrice, stopLoss, takeProfit1, createdAt, riskReward }
 * @param {object} cd candles { t:number[] (sec), h:number[], l:number[] } ascending by t
 * @returns {{ outcome:"WIN"|"LOSS"|"PENDING"|"INVALID", r:number }}
 */
export function gradeCall(t, cd) {
  const { direction, entryPrice, stopLoss, takeProfit1, createdAt, riskReward } = t;
  if (!entryPrice || !stopLoss || !takeProfit1 || !cd) return { outcome: "INVALID", r: 0 };
  const startSec = Math.floor((createdAt || 0) / 1000);
  const R = (typeof riskReward === "number" && riskReward > 0) ? riskReward : 1;
  for (let i = 0; i < cd.t.length; i++) {
    if (cd.t[i] < startSec) continue;
    const hi = cd.h[i], lo = cd.l[i];
    if (direction === "LONG") {
      const tp = hi >= takeProfit1, sl = lo <= stopLoss;
      if (tp && sl) return { outcome: "LOSS", r: -1 };
      if (tp) return { outcome: "WIN", r: R };
      if (sl) return { outcome: "LOSS", r: -1 };
    } else {
      const tp = lo <= takeProfit1, sl = hi >= stopLoss;
      if (tp && sl) return { outcome: "LOSS", r: -1 };
      if (tp) return { outcome: "WIN", r: R };
      if (sl) return { outcome: "LOSS", r: -1 };
    }
  }
  return { outcome: "PENDING", r: 0 };
}

// ── PRO subscription payment verification ───────────────────────────────────
// Pure: given an eth_getTransactionReceipt result, decide whether it contains a
// qualifying ERC-20 (USDC) Transfer to the subscription receiver, and who paid.
// No network here — the caller fetches the receipt and persists the grant.
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function verifyErc20Payment(receipt, { token, receiver, minAmount }) {
  if (!receipt || receipt.status !== "0x1") return { ok: false, reason: "tx not successful" };
  const tokenL = String(token).toLowerCase();
  const recvTopic = "0x" + String(receiver).toLowerCase().slice(2).padStart(64, "0");
  for (const log of receipt.logs || []) {
    if ((log.address || "").toLowerCase() !== tokenL) continue;
    if (!log.topics || log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if ((log.topics[2] || "").toLowerCase() !== recvTopic) continue;
    let amount;
    try { amount = BigInt(log.data); } catch { continue; }
    if (amount >= minAmount) {
      const from = "0x" + (log.topics[1] || "").slice(-40);
      return { ok: true, from: from.toLowerCase(), amount: amount.toString() };
    }
  }
  return { ok: false, reason: "no qualifying transfer to receiver" };
}
