/**
 * NexusTreasury — public, read-only view of the Nexus DEX treasury Safe.
 *
 * The treasury is a Safe multisig (1/1) on Arbitrum + Base that receives swept
 * DEX builder fees + PRO subs (USDC) and discretionarily accumulates $NEXUS on
 * the open market and HOLDS it (war chest; funds retroactive Seasons). NOT
 * buyback-and-burn. This component reads the Safe's USDC balance ACROSS BOTH
 * CHAINS and shows the sum publicly — a transparent "glass jar".
 *
 * ⚠️ NEXUS_TREASURY_ADDRESS is the verified deployed Safe — DON'T edit it (a
 * one-char-off look-alike permanently ate a test send). Funds can land on either
 * chain, so we read Base + Arbitrum and sum; if one RPC fails we still show the
 * other (only render nothing if BOTH fail or the address is unset).
 */

import { useEffect, useState } from "react";
import { createPublicClient, http, fallback, formatUnits } from "viem";
import { arbitrum, base } from "viem/chains";
import { C } from "@/config/theme";

// Nexus Trading Labs Treasury — Safe (1/1), deployed + activated on Arbitrum + Base 2026-06-08.
// Receives swept USDC (broker fees + PRO subs) and $NEXUS; funds the war chest + Seasons.
export const NEXUS_TREASURY_ADDRESS = "0x4Fe2c01bbeFaFFa35706C994646a3F8493B1C733";

// Native USDC (6 decimals) on each chain the treasury holds on.
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const arbClient = createPublicClient({
  chain: arbitrum,
  transport: fallback([
    http("https://arb1.arbitrum.io/rpc"),
    http("https://arbitrum-one-rpc.publicnode.com"),
    http(),
  ]),
});
const baseClient = createPublicClient({
  chain: base,
  transport: fallback([
    http("https://mainnet.base.org"),
    http("https://base-rpc.publicnode.com"),
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
    const addr = NEXUS_TREASURY_ADDRESS as `0x${string}`;
    // Sum USDC across both chains; tolerate a single-chain RPC failure.
    Promise.allSettled([
      baseClient.readContract({ address: USDC_BASE, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] }) as Promise<bigint>,
      arbClient.readContract({ address: USDC_ARBITRUM, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] }) as Promise<bigint>,
    ])
      .then((results) => {
        if (cancelled) return;
        const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<bigint>[];
        if (!ok.length) { setFailed(true); return; }
        const total = ok.reduce((sum, r) => sum + Number(formatUnits(r.value, 6)), 0);
        setUsdc(total);
      });
    return () => { cancelled = true; };
  }, [configured]);

  // No Safe yet, or read failed → render nothing.
  if (!configured || failed) return null;

  const short = `${NEXUS_TREASURY_ADDRESS.slice(0, 6)}…${NEXUS_TREASURY_ADDRESS.slice(-4)}`;
  // Show cents while the jar is small so an early balance doesn't read as "$0".
  const bal = usdc != null
    ? `$${usdc.toLocaleString(undefined, { maximumFractionDigits: usdc < 1000 ? 2 : 0 })}`
    : "—";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: compact ? 12 : 20,
      padding: compact ? "8px 12px" : "12px 16px",
      background: "#141416", border: "1px solid #232327", borderRadius: 4,
      fontFamily: "var(--nx-font-mono)",
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 8, letterSpacing: "0.12em", color: C.text.faint }}>🏦 TREASURY (PUBLIC SAFE)</span>
        <span style={{ fontSize: compact ? 14 : 18, fontWeight: "bold", color: C.text.bright }}>{bal}</span>
      </div>
      <div style={{ width: 1, alignSelf: "stretch", background: C.border }} />
      <a
        href={`https://app.safe.global/balances?safe=base:${NEXUS_TREASURY_ADDRESS}`}
        target="_blank" rel="noopener noreferrer"
        style={{ display: "flex", flexDirection: "column", gap: 2, textDecoration: "none" }}
      >
        <span style={{ fontSize: 8, letterSpacing: "0.12em", color: C.text.faint }}>SAFE ADDRESS ↗</span>
        <span style={{ fontSize: compact ? 11 : 12, color: C.info }}>{short}</span>
      </a>
      {!compact && (
        <div style={{ flex: 1, minWidth: 0, fontSize: 8, color: "#33333a", lineHeight: 1.4, textAlign: "right" }}>
          fees → treasury → $NEXUS war chest
          <br />
          on-chain · verifiable
        </div>
      )}
    </div>
  );
}
