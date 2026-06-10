/**
 * /mini — Nexus Farcaster Mini App (v1, zero-auth surface).
 *
 * Lightweight, runs inside Warpcast. v1 needs NO Orderly account / no funds:
 *  - Identity from sdk.context (free)
 *  - LIVE CALLS feed (read-only, from our public API)
 *  - Buy $NEXUS natively via sdk.actions.swapToken (Warpcast does the swap)
 *  - Share to cast via sdk.actions.composeCast (the viral loop)
 * In-frame Orderly trading is the next phase (the frame wallet / verified wallet
 * can trade — proven — but enable+deposit is higher friction, so it lands later).
 *
 * NOT wrapped in OrderlyProvider/app chrome — frames must stay light.
 */

import { useEffect, useState } from "react";
import sdk from "@farcaster/miniapp-sdk";

const bg = "#0a0e0a";
const green = "#00ff88";
const mono = "monospace";
const APP = "https://trade.nexustradinglabs.com";
const API = "https://og.nexustradinglabs.com";
const NEXUS = "0x3D958634ab725B627919EF8F2Ed59227309fDba3";
const NEXUS_CAIP19 = `eip155:8453/erc20:${NEXUS}`;

type FUser = { fid?: number; username?: string; displayName?: string; pfpUrl?: string };
type Thesis = {
  id: string; symbol: string; direction: "LONG" | "SHORT"; riskReward: number;
  status: string; wallet: string; displayName: string | null; agent?: boolean;
};

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "#4a9fff", HIT_TP: "#00ff88", STOPPED_OUT: "#ff4444", INVALIDATED: "#fbbf24", CLOSED: "#8aaa9a",
};
const tk = (s: string) => s.replace("PERP_", "").replace("_USDC", "");

export default function MiniApp() {
  const [booted, setBooted] = useState(false);
  const [inFrame, setInFrame] = useState<boolean | null>(null);
  const [user, setUser] = useState<FUser | null>(null);
  const [feed, setFeed] = useState<Thesis[] | null>(null);
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const isMini = await sdk.isInMiniApp();
        setInFrame(isMini);
        if (isMini) {
          const ctx = await sdk.context;
          setUser((ctx?.user as FUser) ?? null);
          await sdk.actions.ready();
        }
      } catch { /* ignore */ }
      finally { setBooted(true); }
    })();
  }, []);

  useEffect(() => {
    fetch(`${API}/feed`).then((r) => r.json())
      .then((d: { feed?: Thesis[] }) => setFeed((d.feed ?? []).slice(0, 12)))
      .catch(() => setFeed([]));
  }, []);

  async function buyNexus() {
    // Lead with the native $NEXUS token page (viewToken) — it ALWAYS opens (the
    // Buy/Swap controls live there). swapToken is flaky for $NEXUS because the v4
    // pool isn't aggregator-routable, so it's only a fallback. Guard re-entrancy.
    if (buying) return;
    setBuying(true);
    try {
      await sdk.actions.viewToken({ token: NEXUS_CAIP19 });
    } catch {
      try { await sdk.actions.swapToken({ buyToken: NEXUS_CAIP19 }); } catch { /* ignore */ }
    } finally {
      setBuying(false);
    }
  }

  async function shareApp() {
    try {
      await sdk.actions.composeCast({
        text: "trading on Nexus — one-tap perps, autonomous agents, and track records you can actually verify on-chain 🟢",
        embeds: [`${APP}/mini`],
      });
    } catch { /* ignore */ }
  }

  async function shareThesis(t: Thesis) {
    try {
      await sdk.actions.composeCast({
        text: `${tk(t.symbol)} ${t.direction} — ${t.displayName || "a trader"}'s call on Nexus. graded on-chain, not vibes 🟢`,
        embeds: [`${APP}/feed/thesis/${t.wallet}/${t.id}`],
      });
    } catch { /* ignore */ }
  }

  const shell: React.CSSProperties = { background: bg, color: "#e5e7eb", minHeight: "100dvh", fontFamily: mono, padding: 14, display: "flex", flexDirection: "column", gap: 12 };
  const card: React.CSSProperties = { background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 6, padding: 12 };

  return (
    <div style={shell}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: green, fontWeight: "bold", letterSpacing: "0.25em" }}>//</span>
        <span style={{ color: "#fff", fontWeight: "bold", letterSpacing: "0.2em" }}>NEXUS</span>
        <span style={{ fontSize: 9, color: "#3a5a4a", marginLeft: "auto" }}>mini · v1</span>
      </div>

      {!booted && <div style={{ ...card, color: "#3a6a4a", fontSize: 12 }}>loading…</div>}

      {booted && inFrame === false && (
        <div style={{ ...card, fontSize: 12, color: "#8aaa9a", lineHeight: 1.6 }}>
          Open this inside <b style={{ color: green }}>Warpcast</b> to use it.
          <div style={{ marginTop: 8 }}><a href={APP} style={{ color: green, textDecoration: "none" }}>→ open the full terminal</a></div>
        </div>
      )}

      {/* Identity */}
      {booted && inFrame && user && (
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 10 }}>
          {user.pfpUrl && <img src={user.pfpUrl} alt="" style={{ width: 32, height: 32, borderRadius: "50%", border: "1px solid #1a3a1a" }} />}
          <div style={{ fontSize: 12, color: "#fff", fontWeight: "bold" }}>{user.displayName || user.username || "you"}</div>
          <span style={{ marginLeft: "auto", fontSize: 9, color: green }}>● in frame</span>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button onClick={buyNexus} disabled={buying} style={{ background: green, color: "#04130c", border: "none", borderRadius: 5, padding: "11px 0", fontFamily: mono, fontSize: 12, fontWeight: "bold", cursor: buying ? "wait" : "pointer", letterSpacing: "0.04em", opacity: buying ? 0.6 : 1 }}>{buying ? "OPENING…" : "🪙 BUY $NEXUS"}</button>
        <button onClick={shareApp} style={{ background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 5, padding: "11px 0", fontFamily: mono, fontSize: 12, fontWeight: "bold", cursor: "pointer", letterSpacing: "0.04em" }}>↗ SHARE NEXUS</button>
      </div>

      {/* Live calls feed */}
      <div style={{ fontSize: 9, color: "#3a6a4a", letterSpacing: "0.12em", marginTop: 2 }}>📡 LIVE CALLS</div>
      {feed === null && <div style={{ ...card, color: "#3a6a4a", fontSize: 11 }}>loading feed…</div>}
      {feed && feed.length === 0 && <div style={{ ...card, color: "#3a6a4a", fontSize: 11 }}>no calls yet — be the first 🟢</div>}
      {feed && feed.map((t) => {
        const sc = STATUS_COLOR[t.status] ?? "#8aaa9a";
        return (
          <div key={t.id} style={{ ...card, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: "bold", color: "#fff", minWidth: 48 }}>{tk(t.symbol)}</span>
            <span style={{ fontSize: 10, color: t.direction === "LONG" ? green : "#ff4444" }}>{t.direction === "LONG" ? "↑" : "↓"} {t.direction}</span>
            <span style={{ fontSize: 10, color: t.riskReward >= 2 ? green : "#fbbf24" }}>1:{t.riskReward?.toFixed?.(2) ?? "—"}</span>
            <span style={{ fontSize: 9, color: sc, border: `1px solid ${sc}33`, borderRadius: 3, padding: "1px 6px" }}>{t.status}</span>
            <button onClick={() => shareThesis(t)} title="Share to cast" style={{ marginLeft: "auto", background: "none", border: "1px solid #1a2e1a", borderRadius: 3, color: "#5a8a6a", fontFamily: mono, fontSize: 11, padding: "3px 8px", cursor: "pointer" }}>↗</button>
          </div>
        );
      })}

      <div style={{ fontSize: 8, color: "#2a4a3a", textAlign: "center", marginTop: 4, lineHeight: 1.5 }}>
        the terminal that makes you a better trader
        <br />
        <a href={APP} style={{ color: "#3a6a4a", textDecoration: "none" }}>full terminal ↗</a>
      </div>
    </div>
  );
}
