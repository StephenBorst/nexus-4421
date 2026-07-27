// ── Orderly delegated-key readers + agent ownership proof ──
// Extracted from AgentView.tsx (god-file split). No JSX, no React — these are the
// money-path primitives the agent surfaces depend on, so they're isolated here where
// they can be read (and tested) without loading a 2.4k-line component.
//
// ⚠️ Behavior is byte-for-byte what shipped in AgentView; this move is mechanical.
// Do not "tidy" the localStorage key shapes — they're written by the Orderly SDK, not
// by us, and the fallback scan exists because the per-address blob isn't always
// present under the key we'd expect.
import { signWithInjected } from "@/utils/injectedWallet";

export function getOrderlyNetworkId(): string {
  return (localStorage.getItem("orderly_networkId") as string) || "mainnet";
}

export function getOrderlyKeyStore(): { tradingKey: string; accountId: string } | null {
  const networkId = getOrderlyNetworkId();
  const address = localStorage.getItem(`orderly_${networkId}_address`);
  const tryParse = (raw: string | null) => {
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.orderlyKey === "string" && obj.orderlyKey.length > 20) {
        return { tradingKey: obj.orderlyKey as string, accountId: (obj.accountId as string) || "" };
      }
    } catch {
      // not the JSON blob we want
    }
    return null;
  };

  // Preferred: the exact per-address blob
  if (address) {
    const direct = tryParse(localStorage.getItem(`orderly_${networkId}_${address}`));
    if (direct) return direct;
  }

  // Fallback: scan for any orderly_{network}_0x... blob containing an orderlyKey
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !/^orderly_[a-z]+_0x[0-9a-fA-F]+$/.test(key)) continue;
    const parsed = tryParse(localStorage.getItem(key));
    if (parsed) return parsed;
  }
  return null;
}

export function findOrderlyTradingKey(): string | null {
  return getOrderlyKeyStore()?.tradingKey ?? null;
}

export function getWalletAddress(): string | null {
  const networkId = getOrderlyNetworkId();
  return localStorage.getItem(`orderly_${networkId}_address`);
}

// Ownership proof for agent control ops. Backend ecrecovers a personal_sign of
// "nexus-trading-key-v1" and requires the recovered address to equal the agent's
// wallet — so kill/deactivate/config can't be triggered by anyone but the owner.
// Deterministic message → cache the sig per session (same sig the Orderly key
// derives from). Signs via the injected wallet (same pattern as Holders Room).
export async function getAgentSig(address: string): Promise<string> {
  const key = `nexus_agent_sig_${address.toLowerCase()}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) || "null");
    if (cached && typeof cached.sig === "string") return cached.sig;
  } catch { /* ignore */ }
  const sig = await signWithInjected(address, "nexus-trading-key-v1");
  try { sessionStorage.setItem(key, JSON.stringify({ sig })); } catch { /* ignore */ }
  return sig;
}

export function formatAgentTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}
