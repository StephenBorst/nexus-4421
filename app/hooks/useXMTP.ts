import { useState, useCallback, useEffect } from "react";
import { useAccount } from "@orderly.network/hooks";
import { Client, IdentifierKind } from "@xmtp/browser-sdk";
import type { Conversation, DecodedMessage } from "@xmtp/browser-sdk";

// Module-level cache so the client survives re-renders without re-signing
const clientCache = new Map<string, Client>();

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(Math.floor(h.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function strToHex(str: string): string {
  return "0x" + Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type EIP1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function getProvider(): EIP1193Provider | null {
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null;
}

export type { Conversation, DecodedMessage };

export function useXMTP() {
  const { state: accountState } = useAccount();
  const walletAddress =
    ((accountState as { address?: string })?.address ?? "").toLowerCase() || null;

  // xmtpAddress is the MetaMask account used for XMTP signing — may differ from walletAddress
  const [xmtpAddress, setXmtpAddress] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore ready state if client is already cached (e.g. after re-render)
  useEffect(() => {
    if (!walletAddress) { setReady(false); setXmtpAddress(null); return; }
    // Check if any cache entry's inboxId matches — or just check walletAddress
    const cached = clientCache.get(walletAddress);
    if (cached) { setXmtpAddress(walletAddress); setReady(true); }
  }, [walletAddress]);

  const getClient = useCallback((): Client | null => {
    if (!xmtpAddress) return null;
    return clientCache.get(xmtpAddress) ?? null;
  }, [xmtpAddress]);

  const myInboxId = ready && xmtpAddress
    ? (clientCache.get(xmtpAddress)?.inboxId ?? null)
    : null;

  const init = useCallback(async () => {
    if (!walletAddress) { setError("no wallet connected"); return; }
    if (initializing) return;

    const provider = getProvider();
    if (!provider) { setError("no EIP-1193 provider (window.ethereum) found"); return; }

    setInitializing(true);
    setError(null);
    try {
      // Request accounts — triggers connect popup if MetaMask isn't already authorized
      const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
      const signerAddr = accounts[0]?.toLowerCase();
      if (!signerAddr) throw new Error("no accounts available from wallet");

      if (clientCache.has(signerAddr)) {
        setXmtpAddress(signerAddr);
        setReady(true);
        return;
      }

      const sign = async (msg: string): Promise<string> =>
        provider.request({
          method: "personal_sign",
          params: [strToHex(msg), signerAddr],
        }) as Promise<string>;

      // Derive deterministic 32-byte DB encryption key — same every session
      const encSig = await sign("nexus-xmtp-db-key-v1");
      const encryptionKey = hexToBytes(encSig).slice(0, 32);

      const identifier = { identifier: signerAddr, identifierKind: IdentifierKind.Ethereum };
      const signMessage = async (msg: string): Promise<Uint8Array> => hexToBytes(await sign(msg));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = { env: "production", dbEncryptionKey: encryptionKey };

      let client: Client;
      try {
        // Try EOA first — works for standard wallets with no prior XMTP state
        client = await Client.create({ type: "EOA", getIdentifier: () => identifier, signMessage }, opts);
      } catch (eoaErr) {
        const eoaMsg = eoaErr instanceof Error ? eoaErr.message : JSON.stringify(eoaErr);
        if (!eoaMsg.includes("Wrong chain id") && !eoaMsg.includes("chain")) throw eoaErr;
        // Wallet has a prior SCW identity — retry with chain ID declared
        const chainHex = await provider.request({ method: "eth_chainId" }) as string;
        const chainId = BigInt(chainHex);
        client = await Client.create({
          type: "SCW",
          getIdentifier: () => identifier,
          signMessage,
          getChainId: () => chainId,
        }, opts);
      }

      clientCache.set(signerAddr, client);
      setXmtpAddress(signerAddr);
      setReady(true);
    } catch (e) {
      console.error("[XMTP] init error:", e);
      setError(e instanceof Error ? e.message : (JSON.stringify(e) ?? String(e)));
    } finally {
      setInitializing(false);
    }
  }, [walletAddress, initializing]);

  const sendDM = useCallback(async (peerAddress: string, text: string) => {
    const client = getClient();
    if (!client) throw new Error("XMTP not initialized");
    const convo = await client.conversations.createDmWithIdentifier({
      identifier: peerAddress.toLowerCase(),
      identifierKind: IdentifierKind.Ethereum,
    });
    await convo.sendText(text);
  }, [getClient]);

  const openDM = useCallback(async (peerAddress: string): Promise<Conversation> => {
    const client = getClient();
    if (!client) throw new Error("XMTP not initialized");
    return client.conversations.createDmWithIdentifier({
      identifier: peerAddress.toLowerCase(),
      identifierKind: IdentifierKind.Ethereum,
    });
  }, [getClient]);

  const getConversations = useCallback(async (): Promise<Conversation[]> => {
    const client = getClient();
    if (!client) return [];
    await client.conversations.sync();
    return client.conversations.list() as Promise<Conversation[]>;
  }, [getClient]);

  const getMessages = useCallback(async (convo: Conversation): Promise<DecodedMessage[]> => {
    await convo.sync();
    return convo.messages();
  }, []);

  const canMessage = useCallback(async (accountAddress: string): Promise<boolean> => {
    const client = getClient();
    if (!client) return false;
    try {
      const identifier = {
        identifier: accountAddress.toLowerCase(),
        identifierKind: IdentifierKind.Ethereum,
      };
      const result = await client.canMessage([identifier]);
      return result.get(accountAddress.toLowerCase()) ?? false;
    } catch {
      return false;
    }
  }, [getClient]);

  return {
    ready, initializing, error,
    init, sendDM, openDM, getConversations, getMessages, canMessage,
    getClient, myAddress: xmtpAddress ?? walletAddress, myInboxId,
  };
}
