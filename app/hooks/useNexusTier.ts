/**
 * useNexusTier
 *
 * Reads a wallet's $NEXUS balance on Base and derives an access tier.
 * $NEXUS is the pure community meme token (zero built-in utility / revenue
 * share). Tiers drive COSMETIC + ACCESS perks inside the Lab only — they
 * confer no financial right and make no promise. Holding unlocks experience,
 * it does not pay you back.
 *
 * Reads on-chain directly via a viem public client (Base), independent of
 * whatever chain the user's wallet is currently on — mirrors the
 * window.ethereum/viem pattern in useThesisRegistry.
 *
 * Token: 0x3D958634ab725B627919EF8F2Ed59227309fDba3 (Base)
 */

import { useEffect, useState } from "react";
import { createPublicClient, http, formatUnits } from "viem";
import { base } from "viem/chains";

export const NEXUS_TOKEN_ADDRESS =
  "0x3D958634ab725B627919EF8F2Ed59227309fDba3" as const;

export type NexusTier = "NONE" | "OPERATOR" | "ARCHITECT" | "ORACLE";

// ⚠️ TUNE THESE: thresholds are in whole $NEXUS tokens.
// Supply is 100,000,000,000 (100B). At ~$79K MC that's ~$0.0000008/token, so
// these defaults map roughly to ~$10 / ~$50 / ~$200 of $NEXUS *at launch MC*.
// As price moves, the dollar value of each tier moves with it — revisit when
// you decide the holder distribution you actually want to gate on.
// Order matters: highest tier first when resolving.
export const TIER_THRESHOLDS: { tier: Exclude<NexusTier, "NONE">; min: number }[] = [
  { tier: "ORACLE", min: 250_000_000 },
  { tier: "ARCHITECT", min: 63_000_000 },
  { tier: "OPERATOR", min: 12_000_000 },
];

// Brand-consistent styling per tier (monospace terminal / green).
export const TIER_META: Record<
  NexusTier,
  { label: string; glyph: string; color: string }
> = {
  ORACLE:    { label: "ORACLE",    glyph: "◆", color: "#00ff88" },
  ARCHITECT: { label: "ARCHITECT", glyph: "◇", color: "#5fd6a0" },
  OPERATOR:  { label: "OPERATOR",  glyph: "▪", color: "#3a8a6a" },
  NONE:      { label: "",          glyph: "",  color: "#2a4a3a" },
};

export function tierForBalance(balance: number): NexusTier {
  for (const { tier, min } of TIER_THRESHOLDS) {
    if (balance >= min) return tier;
  }
  return "NONE";
}

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

const publicClient = createPublicClient({
  chain: base,
  transport: http(),
});

// Module-level cache so repeated profile views don't re-hit the RPC.
const cache = new Map<string, { balance: number; tier: NexusTier }>();

export interface NexusTierState {
  balance: number | null;
  tier: NexusTier;
  isLoading: boolean;
}

export function useNexusTier(address?: string | null): NexusTierState {
  const [state, setState] = useState<NexusTierState>({
    balance: null,
    tier: "NONE",
    isLoading: false,
  });

  useEffect(() => {
    if (!address) {
      setState({ balance: null, tier: "NONE", isLoading: false });
      return;
    }
    const key = address.toLowerCase();
    const cached = cache.get(key);
    if (cached) {
      setState({ balance: cached.balance, tier: cached.tier, isLoading: false });
      return;
    }

    let cancelled = false;
    setState({ balance: null, tier: "NONE", isLoading: true });

    (async () => {
      try {
        const [raw, decimals] = await Promise.all([
          publicClient.readContract({
            address: NEXUS_TOKEN_ADDRESS,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address as `0x${string}`],
          }),
          publicClient.readContract({
            address: NEXUS_TOKEN_ADDRESS,
            abi: ERC20_ABI,
            functionName: "decimals",
          }),
        ]);
        const balance = Number(formatUnits(raw as bigint, Number(decimals)));
        const tier = tierForBalance(balance);
        cache.set(key, { balance, tier });
        if (!cancelled) setState({ balance, tier, isLoading: false });
      } catch {
        // Fail soft: no badge rather than a broken UI.
        if (!cancelled) setState({ balance: null, tier: "NONE", isLoading: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address]);

  return state;
}
