/**
 * useThesisRegistry
 *
 * Wraps on-chain interactions with the ThesisRegistry contract on Arbitrum.
 * Uses window.ethereum directly via viem — bypasses wagmi connector
 * since Orderly manages its own wallet connection internally.
 *
 * Contract: 0x2F4EdA890f96a7979d6f26bCB210cEDAD68346Bc (Arbitrum mainnet)
 */

import { useState } from "react";
import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  encodeFunctionData,
} from "viem";
import { arbitrum } from "viem/chains";
import type { ThesisTrade } from "@/pages/lab/types";

// ─── Contract config ──────────────────────────────────────────────────────────

export const THESIS_REGISTRY_ADDRESS = "0x2F4EdA890f96a7979d6f26bCB210cEDAD68346Bc" as const;

const ABI = [
  {
    name: "registerThesis",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "symbol",      type: "string"  },
      { name: "direction",   type: "uint8"   },
      { name: "entryPrice",  type: "uint256" },
      { name: "stopLoss",    type: "uint256" },
      { name: "takeProfit1", type: "uint256" },
      { name: "takeProfit2", type: "uint256" },
      { name: "riskReward",  type: "uint256" },
      { name: "isPublic",    type: "bool"    },
      { name: "notes",       type: "string"  },
    ],
    outputs: [{ name: "thesisId", type: "uint256" }],
  },
  {
    name: "closeThesis",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "thesisId",         type: "uint256" },
      { name: "outcome",          type: "uint8"   },
      { name: "settlementTxHash", type: "string"  },
    ],
    outputs: [],
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scalePrice(price: number): bigint {
  return BigInt(Math.round(price * 1_000_000));
}

function scaleRR(rr: number): bigint {
  return BigInt(Math.round(rr * 10_000));
}

function statusToUint8(status: "HIT_TP" | "STOPPED_OUT" | "INVALIDATED"): number {
  if (status === "HIT_TP")      return 1;
  if (status === "STOPPED_OUT") return 2;
  return 3;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export type RegistryTxState = "idle" | "pending" | "confirming" | "done" | "error";

export function useThesisRegistry() {
  const [txState, setTxState] = useState<RegistryTxState>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  async function getWalletClient() {
    const eth = (window as unknown as { ethereum?: unknown }).ethereum;
    if (!eth) throw new Error("No wallet found — install MetaMask");
    const client = createWalletClient({
      chain: arbitrum,
      transport: custom(eth as Parameters<typeof custom>[0]),
    });
    const [account] = await client.requestAddresses();
    return { client, account };
  }

  /**
   * Register a thesis on-chain when the user makes it public.
   * Triggers a MetaMask popup to sign the transaction.
   */
  async function registerOnChain(thesis: ThesisTrade): Promise<string | null> {
    setTxState("pending");
    setTxError(null);
    try {
      const { client, account } = await getWalletClient();

      // Switch to Arbitrum if needed
      await client.switchChain({ id: arbitrum.id });

      const hash = await client.writeContract({
        address: THESIS_REGISTRY_ADDRESS,
        abi: ABI,
        functionName: "registerThesis",
        account,
        args: [
          thesis.symbol,
          thesis.direction === "LONG" ? 0 : 1,
          scalePrice(thesis.entryPrice),
          scalePrice(thesis.stopLoss),
          scalePrice(thesis.takeProfit1),
          scalePrice(thesis.takeProfit2 ?? 0),
          scaleRR(thesis.riskReward),
          true,
          thesis.notes ?? "",
        ],
        chain: arbitrum,
      });

      console.log("[ThesisRegistry] registerThesis tx:", hash);
      setTxHash(hash);
      setTxState("confirming");
      return hash;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[ThesisRegistry] registerOnChain error:", msg);
      if (
        msg.includes("User rejected") ||
        msg.includes("user rejected") ||
        msg.includes("4001")
      ) {
        setTxState("idle");
        return null;
      }
      setTxError(msg);
      setTxState("error");
      return null;
    }
  }

  /**
   * Close a thesis on-chain with outcome + optional settlement proof.
   */
  async function closeOnChain(
    onChainId: number,
    outcome: "HIT_TP" | "STOPPED_OUT" | "INVALIDATED",
    settlementTxHash = "",
  ): Promise<string | null> {
    setTxState("pending");
    setTxError(null);
    try {
      const { client, account } = await getWalletClient();
      await client.switchChain({ id: arbitrum.id });

      const hash = await client.writeContract({
        address: THESIS_REGISTRY_ADDRESS,
        abi: ABI,
        functionName: "closeThesis",
        account,
        args: [BigInt(onChainId), statusToUint8(outcome), settlementTxHash],
        chain: arbitrum,
      });

      console.log("[ThesisRegistry] closeThesis tx:", hash);
      setTxHash(hash);
      setTxState("confirming");
      return hash;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[ThesisRegistry] closeOnChain error:", msg);
      if (
        msg.includes("User rejected") ||
        msg.includes("user rejected") ||
        msg.includes("4001")
      ) {
        setTxState("idle");
        return null;
      }
      setTxError(msg);
      setTxState("error");
      return null;
    }
  }

  function resetTx() {
    setTxState("idle");
    setTxHash(null);
    setTxError(null);
  }

  return {
    registerOnChain,
    closeOnChain,
    txState,
    txHash,
    txError,
    resetTx,
    contractAddress: THESIS_REGISTRY_ADDRESS,
  };
}
