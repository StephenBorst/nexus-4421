// ── Spot in-app SWAP EXECUTION (EVM / Fabric / BUY-only) ──────────────────────
// The one place in the terminal that signs. Everything else on /token is a read or a
// deep-link; this is the gated, additive path that lets a connected wallet complete a
// USDC→token buy WITHOUT leaving for Uniswap. It is deliberately narrow:
//
//   • BUY only (USDC → token). We never sell a user's token here.
//   • EVM only, and only via Fabric (the one EVM aggregator we proxy). Solana stays
//     the Jupiter deep-link (no wallet wiring), perp names stay on our own book.
//   • The approve is the EXACT sell amount, NEVER infinite — so the blast radius of the
//     swap tx is capped at the dollars the user chose to spend, and nothing lingers.
//   • Hard guards BEFORE any wallet prompt: the token we approve MUST be the USDC we
//     picked (never an arbitrary token Fabric names), the swap tx MUST carry zero native
//     value (a USDC buy sends no ETH — a nonzero value would be draining gas), the wallet
//     MUST be on the token's chain, and Fabric's approve amount MUST equal our sell amount.
//   • minOut (the slippage floor) is baked into Fabric's calldata, so a stale quote can
//     only REVERT, never fill worse than the floor shown in the confirm modal.
//
// Nothing auto-executes: the UI plans (planBuy → shows the modal) then executes only on an
// explicit confirm (executeBuy). Fail-soft: any miss throws a plain message and the honest
// Uniswap deep-link is always still there as the fallback.

const AGENT_API = "https://og.nexustradinglabs.com";

// EIP-1193 provider (Orderly's wallet connector exposes it as `wallet.provider`).
export type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

// ── minimal, hand-rolled ERC-20 ABI encoding (auditable — no dep, no surprises) ──
const SEL = { approve: "0x095ea7b3", allowance: "0xdd62ed3e", decimals: "0x313ce567" };
const strip0x = (h: string): string => (h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h);
const padAddr = (a: string): string => strip0x(a).toLowerCase().padStart(64, "0"); // ABI left-pads a 20-byte address to 32
const padUint = (v: bigint): string => v.toString(16).padStart(64, "0");
const toHexQty = (v: bigint): string => "0x" + v.toString(16);            // eth_sendTransaction quantities are hex
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a);

const encApprove = (spender: string, amount: bigint): string => SEL.approve + padAddr(spender) + padUint(amount);
const encAllowance = (owner: string, spender: string): string => SEL.allowance + padAddr(owner) + padAddr(spender);

// Explorer tx link by chainId — the receipt the user can verify a real swap by.
const EXPLORER: Record<number, string> = {
  1: "https://etherscan.io/tx/", 8453: "https://basescan.org/tx/", 42161: "https://arbiscan.io/tx/",
  10: "https://optimistic.etherscan.io/tx/", 137: "https://polygonscan.com/tx/",
};
export const explorerTx = (chainId: number, hash: string): string | null => (EXPLORER[chainId] ? EXPLORER[chainId] + hash : null);

// A validated, executable buy — everything the modal shows and executeBuy needs. Built only
// after the guards below pass, so by the time this exists it's safe to sign against.
export interface BuyPlan {
  router: string;
  chainId: number;
  usdc: string;             // token we spend (USDC) — what we approve, and ONLY this
  tokenOut: string;         // token we receive
  taker: string;            // recipient = the connected wallet
  sellAmount: bigint;       // USDC base units (6dp) — the exact approve + spend
  usd: number;              // human dollars (for the modal)
  outAmount: bigint | null; // Fabric quote out (raw token units)
  minOut: bigint | null;    // slippage floor (raw token units) — enforced on-chain
  decimals: number | null;  // tokenOut decimals for display (best-effort)
  priceImpactPct: number | null;
  spender: string;          // approve target (router / permit2)
  tx: { to: string; data: string };  // swap tx (value is asserted zero, forced 0x0 on send)
}

// eth_call read through the wallet provider (its own RPC + chain).
async function ethCall(provider: Eip1193, to: string, data: string): Promise<bigint | null> {
  try {
    const hex = (await provider.request({ method: "eth_call", params: [{ to, data }, "latest"] })) as string;
    if (typeof hex !== "string" || strip0x(hex).length === 0) return null;
    return BigInt(hex);
  } catch { return null; }
}

// Best-effort tokenOut decimals (for a human "min received" in the modal). Never fatal —
// the on-chain floor is enforced regardless of what we display.
async function readDecimals(provider: Eip1193, token: string): Promise<number | null> {
  const v = await ethCall(provider, token, SEL.decimals);
  if (v == null) return null;
  const d = Number(v);
  return Number.isInteger(d) && d >= 0 && d <= 36 ? d : null;
}

// USDC by DexScreener chainId → numeric chainId + canonical USDC (the buy input). Mirrors the
// preview map in data.ts; kept here so the executable path never guesses a token address.
export const EVM_USDC: Record<string, { chainId: number; usdc: string }> = {
  base:     { chainId: 8453,  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  ethereum: { chainId: 1,     usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  arbitrum: { chainId: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  optimism: { chainId: 10,    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  polygon:  { chainId: 137,   usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
};

// Ask the worker for an EXECUTABLE Fabric quote (passes `taker` so Fabric binds the recipient
// and returns the approval + swap-tx route), then VALIDATE it hard before returning a plan the
// UI is allowed to sign. Throws a plain message on anything unexpected → caller falls back to
// the deep-link. `dsChain` is the DexScreener slug (base/arbitrum/…); `taker`/`owner` the wallet.
export async function planBuy(dsChain: string, tokenOut: string, usd: number, taker: string, provider: Eip1193): Promise<BuyPlan> {
  const evm = EVM_USDC[dsChain];
  if (!evm) throw new Error("In-app swap isn't available on this chain — use the deep-link.");
  if (!isAddr(tokenOut)) throw new Error("Missing token address.");
  if (!isAddr(taker)) throw new Error("Connect a wallet to swap in-app.");
  if (!(usd >= 1)) throw new Error("Enter at least $1 to swap.");
  if (usd > 100000) throw new Error("Amount too large for the in-app swap.");
  if (tokenOut.toLowerCase() === evm.usdc.toLowerCase()) throw new Error("That's already USDC.");

  const sellAmount = BigInt(Math.round(usd * 1e6)); // USDC = 6 decimals; USD ≈ USDC (a dollar stable)
  const u = `${AGENT_API}/swap/quote?chain=${evm.chainId}&tokenIn=${evm.usdc}&tokenOut=${encodeURIComponent(tokenOut)}&amount=${sellAmount.toString()}&taker=${taker}`;
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  const j = (await res.json().catch(() => null)) as {
    ok?: boolean; router?: string; outAmount?: string | number; priceImpact?: unknown;
    approval?: { token?: string; amount?: string | number; spender?: string } | null;
    tx?: { to?: string; data?: string; value?: string | number } | null; minOut?: string | number | null;
  } | null;
  if (!j || !j.ok) throw new Error("No in-app route right now — use the deep-link.");
  if (!j.approval || !j.tx || !j.tx.to || !j.tx.data) throw new Error("Route isn't executable — use the deep-link.");

  // ── the guards (all BEFORE any signature) ──
  // 1) We approve ONLY the USDC we chose. If Fabric names any other token to approve, refuse.
  if (!isAddr(j.approval.token) || j.approval.token!.toLowerCase() !== evm.usdc.toLowerCase())
    throw new Error("Route wants to spend an unexpected token — refused.");
  // 2) Fabric's approve amount must equal our exact sell amount (no widening).
  let fabApprove: bigint;
  try { fabApprove = BigInt(String(j.approval.amount ?? "0")); } catch { throw new Error("Bad approve amount — refused."); }
  if (fabApprove !== sellAmount) throw new Error("Quote amount mismatch — refused.");
  // 3) A USDC buy sends NO native value. A nonzero value here would be spending ETH — refuse.
  let txValue: bigint;
  try { txValue = BigInt(String(j.tx.value ?? "0")); } catch { throw new Error("Bad tx value — refused."); }
  if (txValue !== 0n) throw new Error("Route unexpectedly wants native value — refused.");
  // 4) A sane spender + swap target.
  if (!isAddr(j.approval.spender)) throw new Error("Bad approval target — refused.");
  if (!isAddr(j.tx.to)) throw new Error("Bad swap target — refused.");
  if (!/^0x[0-9a-fA-F]+$/.test(j.tx.data)) throw new Error("Bad swap data — refused.");

  const outAmount = j.outAmount != null ? safeBig(j.outAmount) : null;
  const minOut = j.minOut != null ? safeBig(j.minOut) : null;
  const decimals = await readDecimals(provider, tokenOut);
  const impact = Number(j.priceImpact);

  return {
    router: j.router || "Fabric", chainId: evm.chainId, usdc: evm.usdc, tokenOut, taker,
    sellAmount, usd, outAmount, minOut, decimals,
    priceImpactPct: Number.isFinite(impact) ? impact : null,
    spender: j.approval.spender!, tx: { to: j.tx.to!, data: j.tx.data! },
  };
}

function safeBig(v: string | number): bigint | null {
  try { return BigInt(String(v).split(".")[0]); } catch { return null; }
}

// Make sure the wallet is on the plan's chain before sending chain-specific calldata. Mirrors
// the mini-app's HARD guard: a declined switch must abort, never fire the tx on the wrong chain.
async function ensureChain(provider: Eip1193, chainId: number): Promise<void> {
  const want = toHexQty(BigInt(chainId));
  const cur = (await provider.request({ method: "eth_chainId" })) as string;
  if (typeof cur === "string" && cur.toLowerCase() === want.toLowerCase()) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch {
    throw new Error("Switch your wallet to the token's network to swap in-app.");
  }
  const after = (await provider.request({ method: "eth_chainId" })) as string;
  if (typeof after !== "string" || after.toLowerCase() !== want.toLowerCase())
    throw new Error("Wrong network — switch to complete the swap.");
}

// Poll for the receipt. Returns it (so the caller can check status = success vs revert), or
// null if it hasn't been mined within the window — null means "still pending", NOT "succeeded".
async function waitForReceipt(provider: Eip1193, hash: string): Promise<{ status?: string } | null> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (r) return r as { status?: string };
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}
// A receipt status of 0x0 = the tx reverted on-chain. Unknown/absent status → treat as pending.
const reverted = (r: { status?: string } | null): boolean => {
  if (!r || r.status == null) return false;
  try { return BigInt(r.status) === 0n; } catch { return false; }
};
// A receipt status of 0x1 = the tx succeeded on-chain. Only then does the caller remember the
// bought token (spec: append to recents on status=1 only); a timeout (null) stays "pending".
const succeeded = (r: { status?: string } | null): boolean => {
  if (!r || r.status == null) return false;
  try { return BigInt(r.status) === 1n; } catch { return false; }
};

// Execute the validated plan: ensure chain → (approve EXACT sellAmount only if the current
// allowance is short) → send the swap. `onStep` narrates for the modal. Returns the swap tx
// hash. The two wallet prompts (approve, swap) are the only side effects; the approve is the
// exact amount, so nothing is left standing after.
export async function executeBuy(
  provider: Eip1193, owner: string, plan: BuyPlan, onStep: (s: string) => void,
): Promise<{ swapHash: string; approveHash: string | null; confirmed: boolean }> {
  if (!isAddr(owner) || owner.toLowerCase() !== plan.taker.toLowerCase())
    throw new Error("Wallet changed — re-open the swap.");
  await ensureChain(provider, plan.chainId);

  // Only approve if the existing allowance is short — and then EXACTLY the sell amount.
  let approveHash: string | null = null;
  const current = await ethCall(provider, plan.usdc, encAllowance(owner, plan.spender));
  if (current == null || current < plan.sellAmount) {
    onStep("approve USDC in your wallet…");
    approveHash = (await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: owner, to: plan.usdc, data: encApprove(plan.spender, plan.sellAmount), value: "0x0" }],
    })) as string;
    onStep("waiting for the approval…");
    if (reverted(await waitForReceipt(provider, approveHash))) throw new Error("The USDC approval failed on-chain — nothing was swapped.");
  }

  onStep("confirm the swap in your wallet…");
  const swapHash = (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: owner, to: plan.tx.to, data: plan.tx.data, value: "0x0" }],
  })) as string;
  onStep("swap sent — confirming on-chain…");
  // A revert here means the price moved past the min-received floor; the swap didn't fill (only
  // gas was spent). Surface it honestly instead of claiming a successful buy. A timeout (null)
  // is left as "pending" (confirmed:false) — the caller shows the hash so the user can watch it
  // confirm, and holds off remembering the token until it's actually mined (status=1).
  const rc = await waitForReceipt(provider, swapHash);
  if (reverted(rc)) throw new Error("Swap reverted on-chain (price moved past the min received). Nothing was spent beyond gas — try again.");
  return { swapHash, approveHash, confirmed: succeeded(rc) };
}

// Human "min received" / "quote out" for the modal, using the decimals we read. Returns null when
// decimals are unknown (a rare failed read) so the modal shows a clean "—" rather than a scary
// 20-plus-digit raw integer — the on-chain floor (and the decimals-independent slippage %) still
// carry the safety story regardless.
export function fmtTokenAmount(raw: bigint | null, decimals: number | null): string | null {
  if (raw == null || decimals == null) return null;
  const d = BigInt(10) ** BigInt(decimals);
  const whole = raw / d, frac = raw % d;
  const n = Number(whole) + Number(frac) / Number(d);
  if (!Number.isFinite(n)) return null;
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

// Slippage the modal shows = (quoteOut − minOut) / quoteOut. Decimals-independent (a ratio of
// raw units), so it's honest even when the decimals read missed.
export function slippagePct(outAmount: bigint | null, minOut: bigint | null): number | null {
  if (!outAmount || !minOut || outAmount <= 0n) return null;
  return (1 - Number(minOut) / Number(outAmount)) * 100;
}
