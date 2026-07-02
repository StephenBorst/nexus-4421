/**
 * NexusTierBadge
 *
 * Renders a wallet's $NEXUS access tier as a compact terminal-style chip.
 * Cosmetic / status only — see useNexusTier for the "no utility" framing.
 * Pass an `address` to look it up, or a resolved `tier` directly (e.g. when
 * the caller already has the hook state).
 *
 * Renders nothing for NONE-tier / non-holders, so it's safe to drop anywhere.
 */

import { useNexusTier, TIER_META, type NexusTier } from "@/hooks/useNexusTier";

interface NexusTierBadgeProps {
  address?: string | null;
  tier?: NexusTier;
  size?: "sm" | "md";
}

export function NexusTierBadge({ address, tier, size = "sm" }: NexusTierBadgeProps) {
  const looked = useNexusTier(tier ? null : address);
  const resolved = tier ?? looked.tier;

  if (resolved === "NONE") return null;

  const meta = TIER_META[resolved];
  const fontSize = size === "md" ? 10 : 8;
  const pad = size === "md" ? "3px 8px" : "2px 6px";

  return (
    <span
      title={`$NEXUS ${meta.label} — Lab access tier`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: "var(--nx-font-mono)",
        fontSize,
        fontWeight: "bold",
        letterSpacing: "0.08em",
        color: meta.color,
        border: `1px solid ${meta.color}44`,
        background: `${meta.color}11`,
        borderRadius: 3,
        padding: pad,
        verticalAlign: "middle",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden>{meta.glyph}</span>
      {meta.label}
    </span>
  );
}
