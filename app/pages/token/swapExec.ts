// ── Spot in-app SWAP EXECUTION (EVM · Fabric · BUY + SELL) ────────────────────
// The one place in the terminal that signs. Everything else on /token is a read or a
// deep-link; this is the gated, additive path that lets a connected wallet complete a
// swap WITHOUT leaving for Uniswap. It is deliberately narrow and ONE audited path for
// both directions:
//
//   • BUY  = USDC → token (approve USDC).   SELL = token → USDC (approve the token).
//     Token↔token is intentionally out of scope here (a separate reviewed pass).
//   • EVM only, and only via Fabric (the one EVM aggregator we proxy). Solana stays
//     the Jupiter deep-link (no wallet wiring), perp names keep their own book.
//   • The approve is the EXACT amount we spend, NEVER infinite — so the blast radius of
//     the swap tx is capped at what the user chose, and nothing lingers.
//   • Hard guards BEFORE any wallet prompt: the token we approve MUST equal the INPUT
//     token WE chose (USDC for a buy, the exact token for a sell — never an arbitrary
//     token Fabric names), the swap tx MUST carry zero native value (an ERC-20-in swap
//     sends no ETH — a nonzero value would be draining gas), the wallet MUST be on the
//     token's chain, and Fabric's approve amount MUST equal our spend amount.
//   • A SELL's amount is derived from the FRESH on-chain balance (balanceOf at plan time),
//     in integer base units — MAX sells the exact whole balance, never a float that
//     overshoots and reverts, and never more than is held.
//   • minOut (the slippage floor) is baked into Fabric's calldata, so a stale quote can
//     only REVERT, never fill worse than the floor shown in the confirm modal.
//
// Nothing auto-executes: the UI plans (planBuy/planSell → shows the modal) then executes
// only on an explicit confirm (executeSwap). Fail-soft: any miss throws a plain message
// and the honest Uniswap/Jupiter deep-link is always still there as the fallback.

const AGENT_API = "https://og.nexustradinglabs.com";

// EIP-1193 provider (Orderly's wallet connector exposes it as `wallet.provider`).
export type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

// ── minimal, hand-rolled ERC-20 ABI encoding (auditable — no dep, no surprises) ──
const SEL = { approve: "0x095ea7b3", allowance: "0xdd62ed3e", decimals: "0x313ce567", balanceOf: "0x70a08231" };
const strip0x = (h: string): string => (h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h);
const padAddr = (a: string): string => strip0x(a).toLowerCase().padStart(64, "0"); // ABI left-pads a 20-byte address to 32
const padUint = (v: bigint): string => v.toString(16).padStart(64, "0");
const toHexQty = (v: bigint): string => "0x" + v.toString(16);            // eth_sendTransaction quantities are hex
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a);

const encApprove = (spender: string, amount: bigint): string => SEL.approve + padAddr(spender) + padUint(amount);
const encAllowance = (owner: string, spender: string): string => SEL.allowance + padAddr(owner) + padAddr(spender);
const encBalanceOf = (owner: string): string => SEL.balanceOf + padAddr(owner);

// Explorer tx link by chainId — the receipt the user can verify a real swap by.
const EXPLORER: Record<number, string> = {
  1: "https://etherscan.io/tx/", 8453: "https://basescan.org/tx/", 42161: "https://arbiscan.io/tx/",
  10: "https://optimistic.etherscan.io/tx/", 137: "https://polygonscan.com/tx/",
};
export const explorerTx = (chainId: number, hash: string): string | null => (EXPLORER[chainId] ? EXPLORER[chainId] + hash : null);

export type SwapDir = "buy" | "sell";

// A validated, executable swap — everything the modal shows and executeSwap needs. Built only
// after the guards below pass, so by the time this exists it's safe to sign against.
export interface SwapPlan {
  dir: SwapDir;
  router: string;
  chainId: number;
  tokenIn: string;          // token we SPEND — what we approve, and ONLY this (USDC for buy, the token for sell)
  tokenOut: string;         // token we RECEIVE (the token for buy, USDC for sell)
  taker: string;            // recipient = the connected wallet
  amountIn: bigint;         // tokenIn base units — the exact approve + spend
  decimalsIn: number | null;  // tokenIn decimals (for the "you pay / you sell" line)
  outAmount: bigint | null; // Fabric quote out (raw tokenOut units)
  minOut: bigint | null;    // slippage floor (raw tokenOut units) — enforced on-chain
  decimalsOut: number | null; // tokenOut decimals for display (best-effort)
  usd: number | null;       // buy: the USD input; sell: est. USD received (display only)
  priceImpactPct: number | null;
  feeBps: number;           // Nexus fee in bps disclosed in the modal (0 = none). Taken INSIDE
                            // Fabric's swap tx, so the approve is unchanged.
  spender: string;          // approve target (router / permit2)
  tx: { to: string; data: string };  // swap tx (value is asserted zero, forced 0x0 on send)
}
// Back-compat alias — the earlier BUY-only type name.
export type BuyPlan = SwapPlan;

// eth_call read through the wallet provider (its own RPC + chain).
async function ethCall(provider: Eip1193, to: string, data: string): Promise<bigint | null> {
  try {
    const hex = (await provider.request({ method: "eth_call", params: [{ to, data }, "latest"] })) as string;
    if (typeof hex !== "string" || strip0x(hex).length === 0) return null;
    return BigInt(hex);
  } catch { return null; }
}

// Best-effort token decimals (for a human amount in the modal). Never fatal for a BUY (the
// on-chain floor is enforced regardless) — but a SELL REQUIRES it to size the amount safely,
// so planSell treats a null here as a hard stop.
async function readDecimals(provider: Eip1193, token: string): Promise<number | null> {
  const v = await ethCall(provider, token, SEL.decimals);
  if (v == null) return null;
  const d = Number(v);
  return Number.isInteger(d) && d >= 0 && d <= 36 ? d : null;
}

// Fresh on-chain balance of `token` held by `owner` — the truth a SELL sizes against (never a
// cached float). Null on a failed read → planSell refuses rather than guess.
async function readBalanceOf(provider: Eip1193, token: string, owner: string): Promise<bigint | null> {
  return ethCall(provider, token, encBalanceOf(owner));
}

// USDC by DexScreener chainId → numeric chainId + canonical USDC. Mirrors the preview map in
// data.ts; kept here so the executable path never guesses a token address. USDC is the input of
// a BUY and the OUTPUT of a SELL.
export const EVM_USDC: Record<string, { chainId: number; usdc: string }> = {
  base:     { chainId: 8453,  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  ethereum: { chainId: 1,     usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  arbitrum: { chainId: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  optimism: { chainId: 10,    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  polygon:  { chainId: 137,   usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
};

function safeBig(v: string | number): bigint | null {
  try { return BigInt(String(v).split(".")[0]); } catch { return null; }
}

// ── the shared, audited core ──────────────────────────────────────────────────
// Ask the worker for an EXECUTABLE Fabric quote (passes `taker` so Fabric binds the recipient
// and returns the approval + swap-tx route), then VALIDATE it hard before returning a plan the
// UI is allowed to sign. Throws a plain message on anything unexpected → caller falls back to
// the deep-link. The ONE guard that makes this safe: the token Fabric asks us to approve MUST
// equal `tokenIn` — the input token WE chose (never a token Fabric names).
async function quoteAndGuard(args: {
  dir: SwapDir; chainId: number; tokenIn: string; tokenOut: string; amountIn: bigint; taker: string;
  provider: Eip1193; decimalsIn: number | null; decimalsOut: number | null;
}): Promise<SwapPlan> {
  const { dir, chainId, tokenIn, tokenOut, amountIn, taker, provider, decimalsIn, decimalsOut } = args;
  const u = `${AGENT_API}/swap/quote?chain=${chainId}&tokenIn=${encodeURIComponent(tokenIn)}&tokenOut=${encodeURIComponent(tokenOut)}&amount=${amountIn.toString()}&taker=${taker}`;
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  const j = (await res.json().catch(() => null)) as {
    ok?: boolean; router?: string; outAmount?: string | number; priceImpact?: unknown; feeBps?: number;
    approval?: { token?: string; amount?: string | number; spender?: string } | null;
    tx?: { to?: string; data?: string; value?: string | number } | null; minOut?: string | number | null;
  } | null;
  if (!j || !j.ok) throw new Error("No in-app route right now — use the deep-link.");
  if (!j.approval || !j.tx || !j.tx.to || !j.tx.data) throw new Error("Route isn't executable — use the deep-link.");

  // ── the guards (all BEFORE any signature) ──
  // 1) We approve ONLY the input token WE chose. If Fabric names any other token, refuse.
  if (!isAddr(j.approval.token) || j.approval.token!.toLowerCase() !== tokenIn.toLowerCase())
    throw new Error("Route wants to spend an unexpected token — refused.");
  // 2) Fabric's approve amount must equal our exact spend amount (no widening).
  let fabApprove: bigint;
  try { fabApprove = BigInt(String(j.approval.amount ?? "0")); } catch { throw new Error("Bad approve amount — refused."); }
  if (fabApprove !== amountIn) throw new Error("Quote amount mismatch — refused.");
  // 3) An ERC-20-in swap sends NO native value. A nonzero value here would be spending ETH — refuse.
  let txValue: bigint;
  try { txValue = BigInt(String(j.tx.value ?? "0")); } catch { throw new Error("Bad tx value — refused."); }
  if (txValue !== 0n) throw new Error("Route unexpectedly wants native value — refused.");
  // 4) A sane spender + swap target.
  if (!isAddr(j.approval.spender)) throw new Error("Bad approval target — refused.");
  if (!isAddr(j.tx.to)) throw new Error("Bad swap target — refused.");
  if (!/^0x[0-9a-fA-F]+$/.test(j.tx.data)) throw new Error("Bad swap data — refused.");

  const outAmount = j.outAmount != null ? safeBig(j.outAmount) : null;
  const minOut = j.minOut != null ? safeBig(j.minOut) : null;
  const impact = Number(j.priceImpact);
  const feeBps = Number.isInteger(j.feeBps) && (j.feeBps as number) > 0 ? (j.feeBps as number) : 0;

  return {
    dir, router: j.router || "Fabric", chainId, tokenIn, tokenOut, taker,
    amountIn, decimalsIn, outAmount, minOut, decimalsOut,
    usd: null, priceImpactPct: Number.isFinite(impact) ? impact : null, feeBps,
    spender: j.approval.spender!, tx: { to: j.tx.to!, data: j.tx.data! },
  };
}

// BUY: USDC → token. `dsChain` is the DexScreener slug (base/arbitrum/…); `taker` the wallet.
export async function planBuy(dsChain: string, tokenOut: string, usd: number, taker: string, provider: Eip1193): Promise<SwapPlan> {
  const evm = EVM_USDC[dsChain];
  if (!evm) throw new Error("In-app swap isn't available on this chain — use the deep-link.");
  if (!isAddr(tokenOut)) throw new Error("Missing token address.");
  if (!isAddr(taker)) throw new Error("Connect a wallet to swap in-app.");
  if (!(usd >= 1)) throw new Error("Enter at least $1 to swap.");
  if (usd > 100000) throw new Error("Amount too large for the in-app swap.");
  if (tokenOut.toLowerCase() === evm.usdc.toLowerCase()) throw new Error("That's already USDC.");

  const amountIn = BigInt(Math.round(usd * 1e6)); // USDC = 6 decimals; USD ≈ USDC (a dollar stable)
  const decimalsOut = await readDecimals(provider, tokenOut);
  const plan = await quoteAndGuard({
    dir: "buy", chainId: evm.chainId, tokenIn: evm.usdc, tokenOut, amountIn, taker, provider,
    decimalsIn: 6, decimalsOut,
  });
  plan.usd = usd;
  return plan;
}

// Parse a human token amount (e.g. "16251.7231") to base units WITHOUT float — pad/truncate the
// fractional part to `dec` digits and read as a BigInt. Null on a malformed string.
function parseTokenUnits(s: string, dec: number): bigint | null {
  const t = (s || "").trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  const frac = (f + "0".repeat(dec)).slice(0, dec);
  try { return BigInt(((w || "0") + frac).replace(/^0+(?=\d)/, "")); } catch { return null; }
}

// SELL: token → USDC. `req` is either an exact `pct` (1–100) of the fresh on-chain balance (100 =
// the whole balance) OR a typed `amountStr` in tokens (parsed to base units, CLAMPED to the balance
// so "sell whatever" can never oversell). `priceUsd` only powers a soft notional cap — the real
// safety is the exact-amount approve + on-chain minOut. Refuses if decimals/balance can't be read.
export async function planSell(dsChain: string, tokenIn: string, req: { pct?: number; amountStr?: string }, taker: string, provider: Eip1193, priceUsd: number | null): Promise<SwapPlan> {
  const evm = EVM_USDC[dsChain];
  if (!evm) throw new Error("In-app swap isn't available on this chain — use the deep-link.");
  if (!isAddr(tokenIn)) throw new Error("Missing token address.");
  if (!isAddr(taker)) throw new Error("Connect a wallet to swap in-app.");
  if (tokenIn.toLowerCase() === evm.usdc.toLowerCase()) throw new Error("That's already USDC.");

  // Decimals + balance are read FRESH on-chain — a SELL is sized off the chain, never a cached float.
  const decimalsIn = await readDecimals(provider, tokenIn);
  if (decimalsIn == null) throw new Error("Couldn't read this token — sell via the deep-link.");
  const balance = await readBalanceOf(provider, tokenIn, taker);
  if (balance == null) throw new Error("Couldn't read your balance — try again or use the deep-link.");
  if (balance <= 0n) throw new Error("You don't hold this token to sell.");

  // Integer math only, ALWAYS bounded by the live balance. A % floors down; a typed amount is
  // clamped to the balance; 100% / an over-balance amount sells the EXACT whole balance.
  let amountIn: bigint;
  if (req.pct != null) {
    const p = Math.round(req.pct);
    if (!(p >= 1 && p <= 100)) throw new Error("Pick how much to sell.");
    amountIn = p >= 100 ? balance : (balance * BigInt(p)) / 100n;
  } else if (req.amountStr != null) {
    const wanted = parseTokenUnits(req.amountStr, decimalsIn);
    if (wanted == null || wanted <= 0n) throw new Error("Enter an amount to sell.");
    amountIn = wanted > balance ? balance : wanted;
  } else {
    throw new Error("Pick how much to sell.");
  }
  if (amountIn <= 0n) throw new Error("That amount rounds to zero — enter a larger amount.");

  // Soft notional cap (mirrors the buy's $100k ceiling) when we have a price. Never fatal to safety.
  if (priceUsd && priceUsd > 0) {
    const tokens = Number(amountIn) / 10 ** decimalsIn;
    if (Number.isFinite(tokens) && tokens * priceUsd > 100000) throw new Error("Amount too large for the in-app swap.");
  }

  const plan = await quoteAndGuard({
    dir: "sell", chainId: evm.chainId, tokenIn, tokenOut: evm.usdc, amountIn, taker, provider,
    decimalsIn, decimalsOut: 6,
  });
  plan.usd = plan.outAmount != null ? Number(plan.outAmount) / 1e6 : null; // est. USDC received
  return plan;
}

// Make sure the wallet is on the plan's chain before sending chain-specific calldata. A declined
// switch must abort, never fire the tx on the wrong chain.
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
// A receipt status of 0x1 = the tx succeeded on-chain. Only then does the caller update holdings.
const succeeded = (r: { status?: string } | null): boolean => {
  if (!r || r.status == null) return false;
  try { return BigInt(r.status) === 1n; } catch { return false; }
};

// Execute the validated plan: ensure chain → (approve EXACT amountIn of tokenIn only if the
// current allowance is short) → send the swap. `onStep` narrates for the modal. Returns the swap
// tx hash. The two wallet prompts (approve, swap) are the only side effects; the approve is the
// exact amount, so nothing is left standing after.
export async function executeSwap(
  provider: Eip1193, owner: string, plan: SwapPlan, onStep: (s: string) => void,
): Promise<{ swapHash: string; approveHash: string | null; confirmed: boolean }> {
  if (!isAddr(owner) || owner.toLowerCase() !== plan.taker.toLowerCase())
    throw new Error("Wallet changed — re-open the swap.");
  await ensureChain(provider, plan.chainId);

  const label = plan.dir === "buy" ? "USDC" : "the token";
  // Only approve if the existing allowance is short — and then EXACTLY the spend amount.
  let approveHash: string | null = null;
  const current = await ethCall(provider, plan.tokenIn, encAllowance(owner, plan.spender));
  if (current == null || current < plan.amountIn) {
    onStep(`approve ${label} in your wallet…`);
    approveHash = (await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: owner, to: plan.tokenIn, data: encApprove(plan.spender, plan.amountIn), value: "0x0" }],
    })) as string;
    onStep("waiting for the approval…");
    if (reverted(await waitForReceipt(provider, approveHash))) throw new Error(`The ${label} approval failed on-chain — nothing was swapped.`);
  }

  onStep("confirm the swap in your wallet…");
  const swapHash = (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: owner, to: plan.tx.to, data: plan.tx.data, value: "0x0" }],
  })) as string;
  onStep("swap sent — confirming on-chain…");
  // A revert here means the price moved past the min-received floor; the swap didn't fill (only
  // gas was spent). Surface it honestly instead of claiming success. A timeout (null) is left as
  // "pending" (confirmed:false) — the caller shows the hash so the user can watch it confirm.
  const rc = await waitForReceipt(provider, swapHash);
  if (reverted(rc)) throw new Error("Swap reverted on-chain (price moved past the min received). Nothing was spent beyond gas — try again.");
  return { swapHash, approveHash, confirmed: succeeded(rc) };
}

// Back-compat alias — the earlier BUY-only executor name.
export const executeBuy = executeSwap;

// Human amount for the modal, using the decimals we read. Returns null when decimals are unknown
// (a rare failed read) so the modal shows a clean "—" rather than a scary raw integer — the
// on-chain floor (and the decimals-independent slippage %) still carry the safety story.
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
