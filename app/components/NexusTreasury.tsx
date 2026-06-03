/**
 * NexusTreasury — public, read-only view of the Nexus DEX treasury Safe.
 *
 * The treasury is a Safe multisig that receives DEX builder fees (USDC on
 * Arbitrum) and funds buyback-and-burn of $NEXUS. This component reads the
 * Safe's USDC balance on-chain and shows it publicly — a transparent "glass jar".
 *
 * ⚠️ Set NEXUS_TREASURY_ADDRESS once the Safe exists. Until then this renders
 * NOTHING (no dead UI). Creating the Safe + routing fees are owner actions done
 * outside the app (app.safe.global + Orderly fee-collector config).
 */

import { useEffect, useState } from "react";
import { createPublicClient, http, fallback, formatUnits } from "viem";
import { arbitrum } from "viem/chains";

// Empty until the public Safe is live. Paste the Safe address here to activate.
export const NEXUS_TREASURY_ADDRESS = "";

// Native USDC on Arbitrum (6 decimals) — how Orderly pays builder fees.
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const publicClient = createPublicClient({
  chain: arbitrum,
  transport: fallback([
    http("https://arb1.arbitrum.io/rpc"),
    http("https://arbitrum-one-rpc.publicnode.com"),
    http(),
  ]),
});

export function NexusTreasury({ compact = false }: { compact?: boolean }) {
  const [usdc, setUsdc] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const configured = /^0x[0-9a-fA-F]{40}$/.test(NEXUS_TREASURY_ADDRESS);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    publicClient
      .readContract({ address: USDC_ARBITRUM, abi: ERC20_ABI, functionName: "balanceOf", args: [NEXUS_TREASURY_ADDRESS as `0x${string}`] })
      .then((raw) => { if (!cancelled) setUsdc(Number(formatUnits(raw as bigint, 6))); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [configured]);

  // No Safe yet, or read failed → render nothing.
  if (!configured || failed) return null;

  const short = `${NEXUS_TREASURY_ADDRESS.slice(0, 6)}…${NEXUS_TREASURY_ADDRESS.slice(-4)}`;
  const bal = usdc != null ? `$${usdc.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: compact ? 12 : 20,
      padding: compact ? "8px 12px" : "12px 16px",
      background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4,
      fontFamily: "monospace",
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 8, letterSpacing: "0.12em", color: "#3a5a4a" }}>🏦 TREASURY (PUBLIC SAFE)</span>
        <span style={{ fontSize: compact ? 14 : 18, fontWeight: "bold", color: "#4a9fff" }}>{bal}</span>
      </div>
      <div style={{ width: 1, alignSelf: "stretch", background: "#1a2e1a" }} />
      <a
        href={`https://app.safe.global/balances?safe=arb1:${NEXUS_TREASURY_ADDRESS}`}
        target="_blank" rel="noopener noreferrer"
        style={{ display: "flex", flexDirection: "column", gap: 2, textDecoration: "none" }}
      >
        <span style={{ fontSize: 8, letterSpacing: "0.12em", color: "#3a5a4a" }}>SAFE ADDRESS ↗</span>
        <span style={{ fontSize: compact ? 11 : 12, color: "#5fd6a0" }}>{short}</span>
      </a>
      {!compact && (
        <div style={{ flex: 1, minWidth: 0, fontSize: 8, color: "#2a4a3a", lineHeight: 1.4, textAlign: "right" }}>
          DEX fees (USDC) → buyback → burn
          <br />
          on-chain · verifiable
        </div>
      )}
    </div>
  );
}
