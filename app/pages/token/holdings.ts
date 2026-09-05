// ── Spot holdings — read-only wallet balances (NO txs, no signing) ────────────
// Grok's spec: connected wallet only, native + ERC-20s visible via PUBLIC RPC, priced off the
// same DexScreener feed the terminal already uses. Deliberately NO indexer (Alchemy/Covalent =
// the SaaS bill we skip until /token takes a fee): without one we can't enumerate arbitrary
// memecoins, so we balanceOf a small CURATED set per chain — the assets you'd actually swap FROM
// (native + USDC + WETH + $NEXUS). Nonzero rows only. The signing pass reads this later for an
// exact-amount MAX. Fail-soft everywhere: an RPC miss drops that chain, never throws to the UI.
import { createPublicClient, http, fallback, formatUnits } from "viem";
import { base, arbitrum } from "viem/chains";
import { fmtUsd } from "./data";

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;

// CORS-friendly public RPCs (the useNexusTier list) — chain default is rate-limited from a browser.
const baseClient = createPublicClient({ chain: base, transport: fallback([
  http("https://base.llamarpc.com"), http("https://base-rpc.publicnode.com"), http("https://base.drpc.org"), http(),
]) });
const arbClient = createPublicClient({ chain: arbitrum, transport: fallback([
  http("https://arbitrum.llamarpc.com"), http("https://arbitrum-one-rpc.publicnode.com"), http("https://arbitrum.drpc.org"), http(),
]) });

type Tok = { sym: string; addr: `0x${string}` | null; decimals: number; stable?: boolean };
// base and arbitrum clients have distinct viem chain types; the two calls we make are identical, so
// pin a shared minimal shape (avoids a client union that TS won't let us call methods on).
type BalanceClient = {
  getBalance: (args: { address: `0x${string}` }) => Promise<bigint>;
  readContract: (args: { address: `0x${string}`; abi: typeof ERC20_ABI; functionName: "balanceOf" | "decimals"; args: readonly unknown[] }) => Promise<bigint>;
};
// dsChain = the DexScreener chain slug the terminal links + prices with.
const CHAINS: { chainId: number; dsChain: string; client: BalanceClient; native: string; nativePriceVia: `0x${string}`; tokens: Tok[] }[] = [
  {
    chainId: 8453, dsChain: "base", client: baseClient as unknown as BalanceClient, native: "ETH",
    nativePriceVia: "0x4200000000000000000000000000000000000006", // WETH on Base (for ETH price)
    tokens: [
      { sym: "USDC", addr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, stable: true },
      { sym: "WETH", addr: "0x4200000000000000000000000000000000000006", decimals: 18 },
      { sym: "NEXUS", addr: "0x3D958634ab725B627919EF8F2Ed59227309fDba3", decimals: 18 },
    ],
  },
  {
    chainId: 42161, dsChain: "arbitrum", client: arbClient as unknown as BalanceClient, native: "ETH",
    nativePriceVia: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH on Arbitrum
    tokens: [
      { sym: "USDC", addr: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, stable: true },
      { sym: "WETH", addr: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
    ],
  },
];

export interface Holding {
  sym: string;
  chain: string;          // DexScreener slug (base / arbitrum) — shown as the chain badge
  amount: number;
  usd: number | null;
  address: string | null; // null for native; the /token link target when present
  amountLabel: string;
  usdLabel: string;
}

// ── recents ("watched") — tokens the wallet actually bought in-app ────────────
// The curated set can't enumerate arbitrary tokens (no indexer), so a token you just
// bought (BNKR) would never show. Recents patches exactly that gap WITHOUT an indexer:
// after a confirmed swap the bought token's CA is remembered (per-wallet, localStorage),
// and folded into the balance sweep below so its LIVE balance shows like any curated row.
// Identity only (CA/sym/chain/decimals) — the amount is always read fresh on-chain, never
// stored. Keyed by wallet so switching accounts never shows another wallet's tokens.
export interface RecentToken { ca: string; sym: string; chain: string; decimals: number }
const RECENTS_KEY = (addr: string): string => `nexus_spot_recents_${addr.toLowerCase()}`;
const RECENTS_CAP = 12;
const isCa = (s: unknown): s is string => typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);

export function getRecents(address: string): RecentToken[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY(address));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((r): r is RecentToken =>
      r && isCa(r.ca) && typeof r.sym === "string" && typeof r.chain === "string" && Number.isInteger(r.decimals));
  } catch { return []; }
}

// Remember a bought token (call ONLY after a confirmed status=1 swap). Newest first,
// deduped by CA, capped. Fail-soft — a private-mode localStorage throw never bubbles.
export function addRecent(address: string, token: RecentToken): void {
  if (!isCa(address) || !isCa(token.ca) || !Number.isInteger(token.decimals)) return;
  try {
    const ca = token.ca.toLowerCase();
    const next = [{ ...token, ca }, ...getRecents(address).filter((r) => r.ca.toLowerCase() !== ca)].slice(0, RECENTS_CAP);
    localStorage.setItem(RECENTS_KEY(address), JSON.stringify(next));
  } catch { /* ignore */ }
}

// Auto-hydrate probe (Order 0): does `address` hold a nonzero balance of `ca` on `dsChain`, and
// what are its decimals? Called when a connected wallet VIEWS a token's Spot page — if it holds
// the token, we remember it so the chip self-heals across browsers/devices WITHOUT a re-buy (the
// localStorage jar no longer has to be the one that made the purchase). Read-only, no signing.
// null = chain we can't read / no balance / a read miss — so it never hydrates a token you don't
// actually hold, and never throws to the UI.
export async function probeHeldToken(address: string, dsChain: string, ca: string): Promise<{ decimals: number } | null> {
  if (!isCa(address) || !isCa(ca)) return null;
  const c = CHAINS.find((x) => x.dsChain === dsChain);
  if (!c) return null; // no public client for this chain → can't read, skip
  try {
    const [raw, dec] = await Promise.all([
      c.client.readContract({ address: ca as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [address as `0x${string}`] }),
      c.client.readContract({ address: ca as `0x${string}`, abi: ERC20_ABI, functionName: "decimals", args: [] }),
    ]);
    if (!((raw as bigint) > 0n)) return null; // don't hold it → nothing to hydrate
    const decimals = Number(dec);
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? { decimals } : null;
  } catch { return null; }
}

// Price a held token off DexScreener (the terminal's own feed) — stables are $1, native/others by
// contract address. Cached per address for the session; fail-soft → null (row shows amount, no USD).
const priceCache = new Map<string, number | null>();
async function priceUsd(addr: string | null, stable?: boolean): Promise<number | null> {
  if (stable) return 1;
  if (!addr) return null;
  const key = addr.toLowerCase();
  if (priceCache.has(key)) return priceCache.get(key)!;
  let px: number | null = null;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const j = (await r.json()) as { pairs?: { priceUsd?: string; liquidity?: { usd?: number } }[] };
      const best = (j.pairs || []).filter((p) => Number(p.priceUsd) > 0).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (best) px = Number(best.priceUsd);
    }
  } catch { /* price stays null */ }
  priceCache.set(key, Number.isFinite(px as number) ? px : null);
  return priceCache.get(key)!;
}

const fmtAmount = (n: number): string =>
  n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 })
  : n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 3 })
  : n.toLocaleString("en-US", { maximumFractionDigits: 6 });

// Build a Holding row from a just-filled swap (the OPTIMISTIC chip shown the instant a swap
// confirms, before the on-chain refetch reconciles it). Amount = the raw token units Fabric
// quoted; USD priced off the page's own priceUsd. Label formatting stays here so the strip
// never renders a hand-built row that formats differently from the swept ones.
export function optimisticHolding(sym: string, chain: string, address: string, rawAmount: bigint, decimals: number, priceUsd: number | null): Holding {
  const amount = Number(formatUnits(rawAmount, decimals));
  const usd = priceUsd != null && Number.isFinite(priceUsd) ? amount * priceUsd : null;
  return { sym, chain, amount, usd, address, amountLabel: fmtAmount(amount), usdLabel: usd != null ? fmtUsd(usd) : "—" };
}

// Read the connected EVM wallet's spot balances (curated ∪ this wallet's recents) across
// supported chains. Read-only — no txs, no signing.
export async function fetchHoldings(address: string): Promise<Holding[]> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return [];
  const addr = address as `0x${string}`;
  const recents = getRecents(address);
  const perChain = await Promise.all(CHAINS.map(async (c) => {
    const rows: Holding[] = [];
    // native
    try {
      const wei = await c.client.getBalance({ address: addr });
      const amount = Number(formatUnits(wei, 18));
      if (amount > 0) {
        const px = await priceUsd(c.nativePriceVia);
        const usd = px != null ? amount * px : null;
        rows.push({ sym: c.native, chain: c.dsChain, amount, usd, address: null, amountLabel: fmtAmount(amount), usdLabel: usd != null ? fmtUsd(usd) : "—" });
      }
    } catch { /* skip native on this chain */ }
    // curated ERC-20s + this wallet's recents on this chain (deduped by CA vs curated).
    // Recents carry no `stable` flag, so they price by contract address off DexScreener —
    // exactly how an arbitrary bought token (BNKR) gets a USD value without an indexer.
    const curatedCas = new Set(c.tokens.map((t) => t.addr?.toLowerCase()).filter(Boolean));
    const recentToks: Tok[] = recents
      .filter((r) => r.chain === c.dsChain && !curatedCas.has(r.ca.toLowerCase()))
      .map((r) => ({ sym: r.sym, addr: r.ca as `0x${string}`, decimals: r.decimals }));
    await Promise.all([...c.tokens, ...recentToks].map(async (t) => {
      if (!t.addr) return;
      try {
        const raw = await c.client.readContract({ address: t.addr, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] });
        const amount = Number(formatUnits(raw as bigint, t.decimals));
        if (amount <= 0) return;
        const px = await priceUsd(t.addr, t.stable);
        const usd = px != null ? amount * px : null;
        rows.push({ sym: t.sym, chain: c.dsChain, amount, usd, address: t.addr, amountLabel: fmtAmount(amount), usdLabel: usd != null ? fmtUsd(usd) : "—" });
      } catch { /* skip this token */ }
    }));
    return rows;
  }));
  // Flatten; biggest USD first (dust/native w/o price sinks below).
  return perChain.flat().sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
}
