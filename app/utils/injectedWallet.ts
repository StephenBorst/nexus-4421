// Shared helper for signing with the injected (EIP-1193) wallet.
//
// Several features (agent control, Holders Room access, Desks membership) prove
// wallet ownership by personal_sign'ing a message and having the backend ecrecover
// it. They all grabbed raw `window.ethereum` and called viem's signMessage with a
// hardcoded address — but if the injected provider exists yet has no active account
// THIS session (extension re-locked, or the Orderly session connected via another
// path), viem throws the opaque "Wallet is not initialized". This centralizes the
// fix: wake/authorize the provider, then sign with the account it actually returns.

import { createWalletClient, custom } from "viem";

type EthProvider = {
  request?: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function getProvider(): EthProvider {
  const eth = (window as unknown as { ethereum?: EthProvider }).ethereum;
  if (!eth?.request) {
    throw new Error("No wallet found — connect your wallet to continue");
  }
  return eth;
}

/**
 * Ensure the injected provider is authorized this session and return the active
 * account, verified to equal `expected`. Throws a user-readable error otherwise.
 * eth_requestAccounts is a no-op prompt if the wallet is already authorized.
 */
export async function ensureInjectedAccount(expected: string): Promise<`0x${string}`> {
  const eth = getProvider();
  let accounts: string[] = [];
  try {
    accounts = (await eth.request!({ method: "eth_requestAccounts" })) as string[];
  } catch {
    throw new Error("Wallet connection rejected — approve the connection to continue");
  }
  if (!accounts?.length) throw new Error("Wallet is locked — unlock it in your wallet and try again");
  const active = accounts.find((a) => a.toLowerCase() === expected.toLowerCase());
  if (!active) {
    throw new Error(
      `Connected wallet ${accounts[0].slice(0, 6)}…${accounts[0].slice(-4)} doesn't match ${expected.slice(0, 6)}…${expected.slice(-4)} — switch to that wallet in your extension.`,
    );
  }
  return active as `0x${string}`;
}

/**
 * Personal-sign `message` as `expected`, initializing the injected provider first.
 * Returns the 0x signature.
 */
export async function signWithInjected(expected: string, message: string): Promise<string> {
  const account = await ensureInjectedAccount(expected);
  const eth = getProvider();
  const client = createWalletClient({ transport: custom(eth as Parameters<typeof custom>[0]) });
  return client.signMessage({ account, message });
}
