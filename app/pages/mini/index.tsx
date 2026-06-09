/**
 * /mini — Nexus Farcaster Mini App (spike / foundation).
 *
 * A lightweight surface that runs inside Warpcast. This first cut proves the
 * frame loads, identity comes through (sdk.context), and the Farcaster wallet
 * connects (sdk.wallet.getEthereumProvider) — the foundation everything else
 * builds on. Quick Trade / Feed / Buy land on top once Orderly-auth-in-frame
 * is proven (the next spike step).
 *
 * Intentionally NOT wrapped in the heavy OrderlyProvider/app chrome — frames
 * must stay light.
 */

import { useEffect, useState } from "react";
import sdk from "@farcaster/miniapp-sdk";

const bg = "#0a0e0a";
const green = "#00ff88";
const mono = "monospace";

type FUser = { fid?: number; username?: string; displayName?: string; pfpUrl?: string };

export default function MiniApp() {
  const [booted, setBooted] = useState(false);
  const [inFrame, setInFrame] = useState<boolean | null>(null);
  const [user, setUser] = useState<FUser | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const isMini = await sdk.isInMiniApp();
        setInFrame(isMini);
        if (isMini) {
          const ctx = await sdk.context;
          setUser((ctx?.user as FUser) ?? null);
          await sdk.actions.ready(); // dismiss the Warpcast splash
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBooted(true);
      }
    })();
  }, []);

  async function connectWallet() {
    try {
      const provider = await sdk.wallet.getEthereumProvider();
      if (!provider) { setErr("No Farcaster wallet provider"); return; }
      const accts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      setWallet(accts?.[0] ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const shell: React.CSSProperties = { background: bg, color: "#e5e7eb", minHeight: "100dvh", fontFamily: mono, padding: 16, display: "flex", flexDirection: "column", gap: 14 };
  const card: React.CSSProperties = { background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 6, padding: 14 };

  return (
    <div style={shell}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: green, fontWeight: "bold", letterSpacing: "0.25em" }}>//</span>
        <span style={{ color: "#fff", fontWeight: "bold", letterSpacing: "0.2em" }}>NEXUS</span>
        <span style={{ fontSize: 9, color: "#3a5a4a", marginLeft: "auto" }}>mini · v0</span>
      </div>

      {!booted && <div style={{ ...card, color: "#3a6a4a", fontSize: 12 }}>loading…</div>}

      {booted && inFrame === false && (
        <div style={{ ...card, fontSize: 12, color: "#8aaa9a", lineHeight: 1.6 }}>
          This is the Nexus Mini App — open it inside <b style={{ color: green }}>Warpcast</b> to use it.
          <div style={{ marginTop: 10 }}>
            <a href="https://trade.nexustradinglabs.com" style={{ color: green, textDecoration: "none" }}>→ open the full terminal</a>
          </div>
        </div>
      )}

      {booted && inFrame && (
        <>
          {/* Identity */}
          <div style={{ ...card, display: "flex", alignItems: "center", gap: 10 }}>
            {user?.pfpUrl && <img src={user.pfpUrl} alt="" style={{ width: 36, height: 36, borderRadius: "50%", border: "1px solid #1a3a1a" }} />}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: "bold", color: "#fff" }}>{user?.displayName || user?.username || "Farcaster user"}</div>
              <div style={{ fontSize: 10, color: "#3a5a4a" }}>{user?.username ? `@${user.username}` : ""}{user?.fid ? ` · fid ${user.fid}` : ""}</div>
            </div>
            <span style={{ marginLeft: "auto", fontSize: 9, color: green }}>● in frame</span>
          </div>

          {/* Wallet */}
          <div style={{ ...card, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, color: "#3a5a4a", letterSpacing: "0.1em" }}>WALLET</span>
            {wallet ? (
              <span style={{ fontSize: 11, color: green }}>{wallet.slice(0, 6)}…{wallet.slice(-4)}</span>
            ) : (
              <button onClick={connectWallet} style={{ marginLeft: "auto", background: green, color: "#04130c", border: "none", borderRadius: 4, padding: "7px 14px", fontFamily: mono, fontSize: 11, fontWeight: "bold", cursor: "pointer" }}>
                CONNECT
              </button>
            )}
          </div>

          {/* Coming next */}
          <div style={{ ...card, fontSize: 10, color: "#3a6a4a", lineHeight: 1.7 }}>
            <div style={{ color: "#5a8a6a", marginBottom: 6 }}>COMING NEXT</div>
            ⚡ Quick Trade — one-tap perps<br />
            📡 Feed — theses &amp; calls, share to cast<br />
            🪙 Buy $NEXUS
          </div>
        </>
      )}

      {err && <div style={{ ...card, fontSize: 10, color: "#ff4444" }}>{err}</div>}
    </div>
  );
}
