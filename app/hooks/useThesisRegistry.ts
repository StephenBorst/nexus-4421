/**
 * useThesisRegistry
 *
 * Wraps on-chain interactions with the ThesisRegistry contract on Arbitrum.
 * Prices in the contract are stored scaled by 1e6 (6 decimal places).
 * R:R is scaled by 1e4.
 *
 * Contract: 0x2F4EdA890f96a7979d6f26bCB210cEDAD68346Bc (Arbitrum mainnet)
 */

import { useWriteContract } from "wagmi";
import { useState } from "react";
import type { ThesisTrade } from "@/pages/lab/types";

// ─── Contract config ──────────────────────────────────────────────────────────

const CONTRACT_ADDRESS = "0x2F4EdA890f96a7979d6f26bCB210cEDAD68346Bc" as const;

const ABI = [
  {
    name: "registerThesis",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "symbol",      type: "string"  },
      { name: "direction",   type: "uint8"   },  // 0=LONG, 1=SHORT
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
      { name: "outcome",          type: "uint8"   },  // 1=HIT_TP, 2=STOPPED_OUT, 3=INVALIDATED
      { name: "settlementTxHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "setPublic",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "thesisId", type: "uint256" },
      { name: "isPublic", type: "bool"    },
    ],
    outputs: [],
  },
  {
    name: "getTraderTheses",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Scale a USD price to 1e6 integer for the contract */
function scalePrice(price: number): bigint {
  return BigInt(Math.round(price * 1_000_000));
}

/** Scale R:R ratio to 1e4 integer for the contract */
function scaleRR(rr: number): bigint {
  return BigInt(Math.round(rr * 10_000));
}

/** Map ThesisTrade status to contract Status enum uint8 */
function statusToUint8(status: "HIT_TP" | "STOPPED_OUT" | "INVALIDATED"): number {
  if (status === "HIT_TP")      return 1;
  if (status === "STOPPED_OUT") return 2;
  return 3; // INVALIDATED
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export type RegistryTxState = "idle" | "pending" | "confirming" | "done" | "error";

export function useThesisRegistry() {
  const { writeContractAsync } = useWriteContract();
  const [txState, setTxState] = useState<RegistryTxState>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  /**
   * Register a thesis on-chain when the user makes it public.
   * Returns the tx hash on success, or null on failure.
   */
  async function registerOnChain(thesis: ThesisTrade): Promise<string | null> {
    setTxState("pending");
    setTxError(null);
    try {
      const hash = await writeContractAsync({
        address: CONTRACT_ADDRESS,
        abi: ABI,
        functionName: "registerThesis",
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
        chainId: 42161, // Arbitrum mainnet
      });
      setTxHash(hash);
      setTxState("confirming");
      return hash;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[ThesisRegistry] writeContractAsync error:", msg, err);
      // User rejected the transaction — treat as non-error (just cancelled)
      if (msg.includes("User rejected") || msg.includes("user rejected")) {
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
   * onChainId is the uint256 thesisId returned when the thesis was registered.
   */
  async function closeOnChain(
    onChainId: number,
    outcome: "HIT_TP" | "STOPPED_OUT" | "INVALIDATED",
    settlementTxHash = "",
  ): Promise<string | null> {
    setTxState("pending");
    setTxError(null);
    try {
      const hash = await writeContractAsync({
        address: CONTRACT_ADDRESS,
        abi: ABI,
        functionName: "closeThesis",
        args: [BigInt(onChainId), statusToUint8(outcome), settlementTxHash],
        chainId: 42161,
      });
      setTxHash(hash);
      setTxState("confirming");
      return hash;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "transaction failed";
      if (msg.includes("User rejected") || msg.includes("user rejected")) {
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
    contractAddress: CONTRACT_ADDRESS,
  };
}
