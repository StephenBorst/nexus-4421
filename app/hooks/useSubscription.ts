/**
 * useSubscription — resolves a wallet's Nexus PRO access.
 *
 * Two paths to PRO:
 *   1. HOLDER unlock — hold ≥ PRO_HOLDER_TIER worth of $NEXUS (works today,
 *      reuses the on-chain tier read; no payment infra needed).
 *   2. PAID subscription — a USDC subscription record (server-side). Deferred
 *      until PAYMENTS_LIVE; the read path is here so flipping it on is wiring,
 *      not a rewrite.
 *
 * Fail-soft: any error → FREE (never accidentally grants PRO).
 */

import { useEffect, useState } from "react";
import { useNexusTier } from "@/hooks/useNexusTier";
import { PRO_HOLDER_TIER, TIER_RANK, PAYMENTS_LIVE } from "@/config/subscription";

const API_BASE = "https://og.nexustradinglabs.com";

export type SubVia = "holder" | "paid" | "none";

export interface SubscriptionState {
  isPro: boolean;
  via: SubVia;
  expiresAt: number | null; // for paid subs
  isLoading: boolean;
}

export function useSubscription(address?: string | null): SubscriptionState {
  const { tier, isLoading: tierLoading } = useNexusTier(address);
  const [paid, setPaid] = useState<{ active: boolean; expiresAt: number | null }>({ active: false, expiresAt: null });
  const [paidLoading, setPaidLoading] = useState(false);

  const holderUnlock = TIER_RANK[tier] >= TIER_RANK[PRO_HOLDER_TIER];

  useEffect(() => {
    if (!PAYMENTS_LIVE || !address) return;
    setPaidLoading(true);
    fetch(`${API_BASE}/sub/${address.toLowerCase()}`)
      .then((r) => r.json())
      .then((d: { expiresAt?: number }) => {
        const exp = d?.expiresAt ?? 0;
        setPaid({ active: exp > Date.now(), expiresAt: exp || null });
      })
      .catch(() => setPaid({ active: false, expiresAt: null }))
      .finally(() => setPaidLoading(false));
  }, [address]);

  const isPro = holderUnlock || paid.active;
  const via: SubVia = paid.active ? "paid" : holderUnlock ? "holder" : "none";

  return { isPro, via, expiresAt: paid.expiresAt, isLoading: tierLoading || paidLoading };
}
