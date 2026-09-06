// ── Spot in-app SWAP EXECUTION (SOLANA · Jupiter · BUY only) ──────────────────────────────────
// The Solana sibling of swapExec.ts (EVM/Fabric). The ONE place the Solana path signs. Deliberately
// narrow and single-purpose:
//
//   • BUY only, same-chain: native SOL → the token's mint (wSOL in, wrapAndUnwrapSol handled by
//     Jupiter). No SELL, no token→token, no LiFi, no bridge.
//   • Signer comes from the EXISTING tree — the app is Privy-based, so a connected Solana wallet is
//     exposed as useWalletConnector().wallet.provider with { signTransaction, sendTransaction,
//     network, rpcUrl }. We add NO second WalletProvider and NO wallet-adapter dep.
//   • The swap transaction is fetched from Jupiter's official API and then VALIDATED HARD before any
//     signature — because a swap tx is opaque bytes, the guards below are the safety, all pre-sign
//     and all merge-blocking:
//       1) quote binding: Jupiter's quoteResponse inputMint/inAmount/outputMint MUST equal what WE
//          asked for (native SOL / our amount / the token's mint).
//       2) slippage cap: slippageBps ≤ MAX_SLIPPAGE_BPS; the quote's otherAmountThreshold (min out) is
//          baked into the tx, so a stale quote can only revert, never fill worse than the floor shown.
//       3) fee-payer / signer MUST equal the connected pubkey (recipient of the bought token).
//       4) program allowlist: every TOP-LEVEL instruction's programId MUST be in ALLOWED_PROGRAMS
//          (ComputeBudget / Jupiter v6 / SPL-Token / Token-2022 / Associated-Token / System / Memo).
//          DEX programs are reached by Jupiter via CPI, so they never appear at the top level.
//       5) simulate: the tx MUST simulate WITHOUT error, and the fee payer's simulated SOL delta MUST
//          NOT exceed the input amount + a small fee/rent budget (the "no stray SOL past the wrap"
//          guard, verified from real simulated balance deltas rather than by parsing lamports).
//   • Freshness: a Solana blockhash expires in ~60-90s, so executeSolBuy RE-FETCHES a fresh swap tx
//     (re-running every guard on the exact bytes it will sign) right before signing — a stale plan is
//     never signed.
//   • A failed/expired confirmation is surfaced as an error, NEVER a fake success.
//
// Nothing auto-executes: planSolBuy validates + returns the modal data; executeSolBuy re-validates on
// fresh bytes and signs only on an explicit confirm. Fail-soft: any miss throws a plain message and
// the honest "Swap via Jupiter" deep-link is always still there.

import { Connection, VersionedTransaction, PublicKey } from "@solana/web3.js";

const JUP_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUP_SWAP = "https://quote-api.jup.ag/v6/swap";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;
export const MAX_SLIPPAGE_BPS = 300; // 3% hard cap — refuse any quote/route asking for more.
// Public Solana RPC fallback if the wallet provider doesn't carry one. The wallet's own rpcUrl is
// preferred (the user's endpoint); this only backstops simulate/confirm.
const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";

// Top-level programs a Jupiter v6 swap legitimately touches. Anything else at the top level → refuse.
const ALLOWED_PROGRAMS = new Set<string>([
  "ComputeBudget111111111111111111111111111111",   // compute unit limit / price
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",     // Jupiter v6 aggregator (routes via CPI)
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",     // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",     // SPL Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",     // Associated Token Account
  "11111111111111111111111111111111",                // System (wrap SOL + ATA rent)
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",     // Memo (Jupiter sometimes tags a route)
]);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// The Privy-exposed Solana wallet provider (from useWalletConnector().wallet.provider). We only ever
// call signTransaction (preferred, so we submit the exact simulated bytes) or sendTransaction.
export type SolProvider = {
  signTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  sendTransaction?: (tx: VersionedTransaction, connection?: Connection) => Promise<string>;
  network?: unknown;
  rpcUrl?: string;
};

export interface SolBuyPlan {
  inputMint: string;         // native SOL (wSOL) — what we spend
  outputMint: string;        // the token's mint — what we receive
  taker: string;             // connected Solana pubkey (fee payer + recipient)
  lamports: number;          // SOL spent, in lamports (the exact bind)
  solIn: number;             // SOL spent (display)
  outAmount: number | null;  // Jupiter quote out (raw token units)
  outDecimals: number | null;
  minOut: number | null;     // otherAmountThreshold (raw token units) — on-chain floor
  priceImpactPct: number | null;
  slippageBps: number;
  router: string;            // "Jupiter"
  rpcUrl: string;            // resolved RPC used for simulate/confirm
  outSym: string;            // display symbol
}

const isSolAddr = (a: unknown): a is string =>
  typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a); // base58, 32-44 chars

function resolveRpc(provider: SolProvider): string {
  const u = typeof provider?.rpcUrl === "string" ? provider.rpcUrl : "";
  return /^https:\/\//.test(u) ? u : FALLBACK_RPC;
}

// Ask Jupiter for a quote + a swap transaction for `taker`, then run every guard on the returned tx.
// Returns the deserialized-and-validated tx PLUS the plan the modal renders. Throws a plain message
// on anything unexpected. Shared by planSolBuy (preview) and executeSolBuy (fresh, right before sign).
async function quoteAndBuildGuarded(args: {
  outputMint: string; lamports: number; taker: string; slippageBps: number; provider: SolProvider;
  outSym: string; outDecimals: number | null;
}): Promise<{ tx: VersionedTransaction; plan: SolBuyPlan }> {
  const { outputMint, lamports, taker, slippageBps, provider, outSym, outDecimals } = args;
  if (!isSolAddr(outputMint)) throw new Error("Bad token mint.");
  if (!isSolAddr(taker)) throw new Error("Connect a Solana wallet to swap in-app.");
  if (outputMint === WSOL_MINT) throw new Error("That's already SOL.");
  if (!(lamports > 0)) throw new Error("Enter an amount of SOL to swap.");
  if (!(slippageBps > 0) || slippageBps > MAX_SLIPPAGE_BPS) throw new Error("Slippage out of range.");

  // 1) Quote — native SOL (wSOL) → the token's mint.
  const qUrl = `${JUP_QUOTE}?inputMint=${WSOL_MINT}&outputMint=${encodeURIComponent(outputMint)}&amount=${lamports}&slippageBps=${slippageBps}&swapMode=ExactIn`;
  const qRes = await fetch(qUrl, { headers: { Accept: "application/json" } });
  const quote = (await qRes.json().catch(() => null)) as {
    inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string;
    otherAmountThreshold?: string; priceImpactPct?: string | number; slippageBps?: number;
  } | null;
  if (!quote || !quote.outAmount) throw new Error("No Jupiter route right now — use the deep-link.");
  // Bind the quote to EXACTLY what we asked for (guard 1).
  if (quote.inputMint !== WSOL_MINT) throw new Error("Quote input isn't SOL — refused.");
  if (quote.outputMint !== outputMint) throw new Error("Quote output mismatch — refused.");
  if (String(quote.inAmount) !== String(lamports)) throw new Error("Quote amount mismatch — refused.");
  // Slippage cap (guard 2) — trust our requested cap, and re-check Jupiter didn't widen it.
  if (typeof quote.slippageBps === "number" && quote.slippageBps > slippageBps) throw new Error("Route widened slippage — refused.");

  // 2) Swap tx — bound to the taker (recipient), Jupiter wraps/unwraps SOL for us.
  const sRes = await fetch(JUP_SWAP, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: taker, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
  });
  const swap = (await sRes.json().catch(() => null)) as { swapTransaction?: string } | null;
  if (!swap?.swapTransaction || typeof swap.swapTransaction !== "string") throw new Error("Jupiter didn't return an executable swap — use the deep-link.");

  // Deserialize the versioned tx from base64.
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Uint8Array.from(atob(swap.swapTransaction), (c) => c.charCodeAt(0))); }
  catch { throw new Error("Couldn't read the swap transaction — refused."); }

  const takerPk = new PublicKey(taker);
  const msg = tx.message;
  const keys = msg.staticAccountKeys;

  // 3) Fee payer / first signer MUST be the connected wallet (recipient of the bought token).
  if (!keys[0] || !keys[0].equals(takerPk)) throw new Error("Transaction isn't payable by your wallet — refused.");

  // 4) Program allowlist — every top-level instruction's program must be known-safe.
  for (const ix of msg.compiledInstructions) {
    const pid = keys[ix.programIdIndex];
    if (!pid || !ALLOWED_PROGRAMS.has(pid.toBase58())) throw new Error("Route touches an unexpected program — refused.");
  }

  const outAmount = quote.outAmount != null ? Number(quote.outAmount) : null;
  const minOut = quote.otherAmountThreshold != null ? Number(quote.otherAmountThreshold) : null;
  const impact = Number(quote.priceImpactPct); // Jupiter returns a fraction (0.012 = 1.2%)

  const plan: SolBuyPlan = {
    inputMint: WSOL_MINT, outputMint, taker, lamports, solIn: lamports / LAMPORTS_PER_SOL,
    outAmount, outDecimals, minOut, priceImpactPct: Number.isFinite(impact) ? impact * 100 : null,
    slippageBps, router: "Jupiter", rpcUrl: resolveRpc(provider), outSym,
  };
  return { tx, plan };
}

// 5) Simulate the tx and assert the fee payer's SOL delta doesn't exceed input + a fee/rent budget —
// the real "no stray SOL past the wrap" guard, from simulated balance deltas (not lamport parsing).
async function simulateGuard(conn: Connection, tx: VersionedTransaction, plan: SolBuyPlan): Promise<void> {
  const takerPk = new PublicKey(plan.taker);
  let pre: number;
  try { pre = await conn.getBalance(takerPk, "processed"); } catch { throw new Error("Couldn't read your SOL balance — try again."); }
  let sim;
  try {
    sim = await conn.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: false, commitment: "processed", accounts: { encoding: "base64", addresses: [plan.taker] } });
  } catch { throw new Error("Simulation failed to run — not signing."); }
  if (sim.value.err) throw new Error("Swap would fail on-chain (simulation reverted) — not signing.");
  // The simulated post-balance of the fee payer. The most it may drop is the SOL we're spending plus
  // a generous fee/rent budget (priority fee + ATA rent ≈ ≤ 0.02 SOL). More than that = a drain → refuse.
  const acct = sim.value.accounts?.[0];
  if (acct && typeof acct.lamports === "number") {
    const post = acct.lamports;
    const drop = pre - post;
    const maxDrop = plan.lamports + 0.02 * LAMPORTS_PER_SOL;
    if (drop > maxDrop) throw new Error("Transaction would move more SOL than the swap — refused.");
  }
}

// Preview plan for the confirm modal — quotes, builds, and runs the static guards (1-4). The heavier
// simulate guard (5) runs at execute time on fresh bytes so the modal opens fast and the simulation is
// against the exact tx we sign. `solIn` is the SOL amount the user typed. Fail-soft: throws → deep-link.
export async function planSolBuy(outputMint: string, outSym: string, solIn: number, taker: string, provider: SolProvider, slippageBps = 100): Promise<SolBuyPlan> {
  if (!(solIn > 0)) throw new Error("Enter an amount of SOL.");
  if (solIn > 1000) throw new Error("Amount too large for the in-app swap.");
  const lamports = Math.round(solIn * LAMPORTS_PER_SOL);
  const cappedBps = Math.min(Math.max(1, Math.round(slippageBps)), MAX_SLIPPAGE_BPS);
  // Best-effort token decimals from the mint (for the modal's "receive" amount) — fail-soft to null;
  // safety (minOut floor, slippage %, simulate) never depends on this display value.
  let outDecimals: number | null = null;
  try {
    const conn = new Connection(resolveRpc(provider), "confirmed");
    const info = await conn.getParsedAccountInfo(new PublicKey(outputMint));
    const d = (info.value?.data as { parsed?: { info?: { decimals?: number } } } | null | undefined)?.parsed?.info?.decimals;
    if (Number.isInteger(d)) outDecimals = d as number;
  } catch { /* modal falls back to slippage %/impact, which are decimals-independent */ }
  const { plan } = await quoteAndBuildGuarded({ outputMint, lamports, taker, slippageBps: cappedBps, provider, outSym, outDecimals });
  return plan;
}

// Human token amount for the modal (out is raw base units).
export function fmtSolTokenAmount(raw: number | null, decimals: number | null): string | null {
  if (raw == null || decimals == null) return null;
  const n = raw / 10 ** decimals;
  if (!Number.isFinite(n)) return null;
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}
export function solSlippagePct(outAmount: number | null, minOut: number | null): number | null {
  if (!outAmount || !minOut || outAmount <= 0) return null;
  return (1 - minOut / outAmount) * 100;
}
export const solscanTx = (sig: string): string => `https://solscan.io/tx/${sig}`;

// Execute the plan: RE-FETCH a fresh swap tx (fresh blockhash) and RE-RUN every guard on the exact
// bytes we will sign, simulate it, then sign + send + confirm. A stale plan is never signed; a
// failed/expired confirmation throws (never a fake success). Returns the signature.
export async function executeSolBuy(provider: SolProvider, plan: SolBuyPlan, onStep: (s: string) => void): Promise<{ sig: string; confirmed: boolean }> {
  if (typeof provider?.signTransaction !== "function" && typeof provider?.sendTransaction !== "function")
    throw new Error("Your wallet can't sign a Solana transaction here — use the deep-link.");
  onStep("refreshing the route…");
  // Fresh tx + all static guards on the bytes we're about to sign (freshness + re-bind).
  const { tx, plan: fresh } = await quoteAndBuildGuarded({
    outputMint: plan.outputMint, lamports: plan.lamports, taker: plan.taker,
    slippageBps: plan.slippageBps, provider, outSym: plan.outSym, outDecimals: plan.outDecimals,
  });
  const conn = new Connection(fresh.rpcUrl, "confirmed");
  onStep("simulating…");
  await simulateGuard(conn, tx, fresh);

  onStep("confirm the swap in your wallet…");
  let sig: string;
  if (typeof provider.signTransaction === "function") {
    // Preferred: we sign, then submit the EXACT simulated bytes ourselves.
    const signed = await provider.signTransaction(tx);
    if (!(signed instanceof VersionedTransaction)) throw new Error("Wallet returned an unexpected object — aborted.");
    // The wallet must not have swapped in a different fee payer.
    if (!signed.message.staticAccountKeys[0]?.equals(new PublicKey(fresh.taker))) throw new Error("Signed transaction changed the payer — aborted.");
    onStep("submitting…");
    sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
  } else {
    onStep("submitting…");
    sig = await provider.sendTransaction!(tx, conn);
  }

  onStep("confirming on-chain…");
  try {
    const res = await conn.confirmTransaction(sig, "confirmed");
    if (res.value.err) throw new Error("Swap failed on-chain — nothing was bought (only network fees).");
    return { sig, confirmed: true };
  } catch (e) {
    // A timeout leaves it pending; surface the sig so the user can watch it. A real error → throw.
    if ((e as Error)?.message?.includes("failed on-chain")) throw e;
    return { sig, confirmed: false };
  }
}
