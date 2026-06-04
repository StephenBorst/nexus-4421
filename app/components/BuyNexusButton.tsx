/**
 * BuyNexusButton — "Buy $NEXUS" CTA (v1, ship-now).
 *
 * $NEXUS liquidity lives in a Uniswap v4 Nexus/WETH pool on Base. Most swap
 * aggregators (LiFi, etc.) don't route v4 yet, so we deeplink to Uniswap — the
 * pool's native interface — prefilled with NEXUS on Base. Reliable routing today;
 * an embedded in-app swap (v4 routing) is the planned v2 upgrade.
 */

const NEXUS_TOKEN = "0x3D958634ab725B627919EF8F2Ed59227309fDba3";
// Uniswap prefilled: Base chain, ETH in (auto-wraps to WETH for the v4 pool), NEXUS out.
const UNISWAP_URL = `https://app.uniswap.org/swap?chain=base&inputCurrency=ETH&outputCurrency=${NEXUS_TOKEN}`;

export function BuyNexusButton({ size = "md" }: { size?: "sm" | "md" }) {
  const pad = size === "sm" ? "5px 10px" : "8px 14px";
  const fontSize = size === "sm" ? 10 : 12;
  return (
    <a
      href={UNISWAP_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="Buy $NEXUS on Uniswap (Base)"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "monospace",
        fontSize,
        fontWeight: "bold",
        letterSpacing: "0.06em",
        color: "#04130c",
        background: "#00ff88",
        border: "1px solid #00ff88",
        borderRadius: 3,
        padding: pad,
        textDecoration: "none",
        whiteSpace: "nowrap",
        boxShadow: "0 0 12px rgba(0,255,136,0.25)",
      }}
    >
      BUY $NEXUS ↗
    </a>
  );
}
