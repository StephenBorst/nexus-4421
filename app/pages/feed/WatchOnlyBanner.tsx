// 👁 Watch-only banner — shown to disconnected visitors so the public surfaces
// (LIVE NOW, ranks, desks, calls) read as an open "explore before you connect"
// experience instead of a wall. Kills cold-start friction: you see the value
// first, connect only when you want to act (trade / copy / join a desk).
// Dismissible (remembered), and the connect CTA defers to the app's own connect.
import { useState } from "react";
import { useWalletConnector } from "@orderly.network/hooks";

const DISMISS_KEY = "nexus_watch_dismissed";

export default function WatchOnlyBanner() {
  const [hidden, setHidden] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "1");
  // The banner told people to "connect" but gave them no button — the connect
  // affordance lived only in the nav. This is the conversion moment for share-loop
  // traffic, so the CTA acts right here (triggers the app's own wallet modal).
  const { connect } = useWalletConnector();
  if (hidden) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#141416", border: "1px solid #232327", borderRadius: 6, padding: "9px 12px", marginBottom: 12, fontFamily: "var(--nx-font-mono)", flexWrap: "wrap", rowGap: 8 }}>
      <span style={{ fontSize: 14 }}>👁</span>
      <div style={{ flex: 1, minWidth: 160 }}>
        <div style={{ fontSize: 11, color: "#f4f4f5", fontWeight: "bold" }}>Watch-only — you&apos;re exploring without a wallet.</div>
        <div style={{ fontSize: 9, color: "#a1a1aa", marginTop: 2 }}>Live positions, verified callers &amp; desks are open to everyone. Connect to trade, copy &amp; join a desk.</div>
      </div>
      <button
        onClick={() => { try { connect(); } catch { /* SDK not ready */ } }}
        style={{ flexShrink: 0, background: "#ededf0", border: "1px solid #ededf0", color: "#0a0a0b", cursor: "pointer", fontFamily: "var(--nx-font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", padding: "7px 14px", borderRadius: 6 }}
      >CONNECT →</button>
      <button
        onClick={() => { setHidden(true); try { window.localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ } }}
        style={{ flexShrink: 0, background: "none", border: "none", color: "#52525b", cursor: "pointer", fontSize: 13 }}
        title="dismiss"
      >✕</button>
    </div>
  );
}
