/**
 * NexusPro — the PRO upgrade / pricing surface.
 *
 * PRO users see a compact "active" confirmation; free users see the upsell with
 * the paths to PRO. Holder-unlock works today (Buy $NEXUS → hold → unlock); the
 * USDC subscribe + pay-in-$NEXUS paths show "soon" until PAYMENTS_LIVE.
 */

import { useState, useEffect } from "react";
import { useSubscription } from "@/hooks/useSubscription";
import { useNexusTier, TIER_META, TIER_THRESHOLDS } from "@/hooks/useNexusTier";
import {
  PRO_FEATURES, PRO_MONTHLY_USDC, NEXUS_PAY_DISCOUNT_PCT, PRO_HOLDER_TIER,
  PAYMENTS_LIVE, nexusDiscountedPrice, SUBSCRIPTION_RECEIVER, NEXUS_BASE_TOKEN, TIER_NAME,
} from "@/config/subscription";
import { NexusTierBadge } from "@/components/NexusTierBadge";
import { BuyNexusButton } from "@/components/BuyNexusButton";

const card: React.CSSProperties = { background: "#141416", border: "1px solid #33333a", borderRadius: 6, padding: 16 };
const mono = "var(--nx-font-mono)";

const DISMISS_KEY = "nexus_pro_dismissed";
const API_BASE = "https://og.nexustradinglabs.com";

export function NexusPro({ walletAddress }: { walletAddress: string | null }) {
  const { isPro, via } = useSubscription(walletAddress);
  const { tier } = useNexusTier(walletAddress);
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "1"
  );
  const holderMin = TIER_THRESHOLDS.find((t) => t.tier === PRO_HOLDER_TIER)?.min ?? 0;

  // Subscribe flow: pick method → send tokens → paste tx hash → verify → 30 days.
  const [subOpen, setSubOpen] = useState(false);
  const [method, setMethod] = useState<"usdc" | "nexus">("usdc");
  const [txHash, setTxHash] = useState("");
  const [subStatus, setSubStatus] = useState<"idle" | "verifying" | "ok" | "err">("idle");
  const [subMsg, setSubMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [nexusAmt, setNexusAmt] = useState<string | null>(null);
  // PRO conversion count (public counts-only aggregate) — social proof when it's meaningful; the
  // raw number (active/total/payments) is always at GET /sub/stats for founder visibility.
  const [proCount, setProCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/sub/stats`).then((r) => r.json())
      .then((d) => { if (alive && typeof d?.activePro === "number") setProCount(d.activePro); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const proProof = proCount != null && proCount >= 5
    ? <span style={{ fontFamily: mono, fontSize: 9, color: "#3ecf8e", border: "1px solid #3ecf8e44", borderRadius: 3, padding: "2px 7px", letterSpacing: "0.04em" }}>◆ {proCount.toLocaleString()} on {TIER_NAME}</span>
    : null;

  // Live $NEXUS quote (client-side DexScreener) → required tokens with a small buffer
  // so the user clears the worker's tolerance band. The worker re-prices on verify.
  useEffect(() => {
    if (!subOpen || method !== "nexus") return;
    let alive = true;
    setNexusAmt(null);
    fetch(`https://api.dexscreener.com/latest/dex/tokens/${NEXUS_BASE_TOKEN}`)
      .then((r) => r.json())
      .then((j) => {
        const pairs = (j?.pairs || []).filter((p: { chainId?: string }) => String(p.chainId || "").toLowerCase() === "base");
        const best = pairs.sort((a: { liquidity?: { usd?: number } }, b: { liquidity?: { usd?: number } }) => ((b.liquidity?.usd) || 0) - ((a.liquidity?.usd) || 0))[0];
        const price = best && parseFloat(best.priceUsd);
        if (alive && price > 0) setNexusAmt(Math.ceil((nexusDiscountedPrice() / price) * 1.08).toLocaleString());
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [subOpen, method]);

  const copyReceiver = () => {
    navigator.clipboard?.writeText(SUBSCRIPTION_RECEIVER).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const verifyPayment = async () => {
    const tx = txHash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) { setSubStatus("err"); setSubMsg("Enter a valid 0x… transaction hash."); return; }
    setSubStatus("verifying"); setSubMsg("");
    try {
      const r = await fetch(`${API_BASE}/sub/verify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: tx, chain: method === "nexus" ? "base" : "arbitrum" }),
      });
      const d = await r.json();
      if (r.ok && d.ok) {
        setSubStatus("ok");
        setSubMsg(`${TIER_NAME} activated for 30 days. Reloading…`);
        setTimeout(() => window.location.reload(), 1800);
      } else {
        setSubStatus("err");
        setSubMsg(d.error || "Verification failed.");
      }
    } catch {
      setSubStatus("err"); setSubMsg("Network error — try again.");
    }
  };

  const dismiss = () => {
    if (typeof window !== "undefined") window.localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  // Dismissed (free users only — keep showing the PRO/ACTIVE badge for subscribers).
  if (dismissed && !isPro) return null;

  // Active PRO → compact confirmation.
  if (isPro) {
    return (
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: mono, fontSize: 12, fontWeight: "bold", color: "#ededf0", letterSpacing: "0.08em" }}>◆ {TIER_NAME.toUpperCase()} · ACTIVE</span>
        <NexusTierBadge tier={tier} size="md" />
        {proProof}
        <span style={{ fontFamily: mono, fontSize: 10, color: "#a1a1aa", marginLeft: "auto" }}>
          {via === "holder" ? "unlocked via $NEXUS holdings" : "subscription active"}
        </span>
      </div>
    );
  }

  return (
    <div style={{ ...card }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: mono, fontSize: 13, fontWeight: "bold", color: "#ededf0", letterSpacing: "0.1em" }}>◆ {TIER_NAME.toUpperCase()}</span>
        <span style={{ fontFamily: mono, fontSize: 10, color: "#a1a1aa" }}>the operator tier — unlock the full terminal</span>
        {proProof}
        <button
          onClick={dismiss}
          style={{
            marginLeft: "auto", background: "none", border: "1px solid #232327", borderRadius: 3,
            color: "#52525b", fontFamily: mono, fontSize: 9, padding: "3px 10px",
            cursor: "pointer", letterSpacing: "0.05em", alignSelf: "center",
          }}
        >
          DISMISS
        </button>
      </div>

      {/* Benefits */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginBottom: 14 }}>
        {PRO_FEATURES.map((f) => (
          <div key={f.key} style={{ background: "#0a0a0b", border: "1px solid #232327", borderRadius: 4, padding: "8px 10px" }}>
            <div style={{ fontFamily: mono, fontSize: 10, color: "#ededf0", marginBottom: 2 }}>◇ {f.label}</div>
            <div style={{ fontFamily: mono, fontSize: 8, color: "#a1a1aa", lineHeight: 1.4 }}>{f.desc}</div>
          </div>
        ))}
      </div>

      {/* Paths to PRO */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        {/* Path 1 — hold (live today) */}
        <div style={{ border: "1px solid #33333a", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: "#fff", fontWeight: "bold" }}>
            HOLD <span style={{ color: TIER_META[PRO_HOLDER_TIER].color }}>{TIER_META[PRO_HOLDER_TIER].glyph} {PRO_HOLDER_TIER}</span>
          </div>
          <div style={{ fontFamily: mono, fontSize: 9, color: "#a1a1aa" }}>
            Hold {holderMin.toLocaleString()} $NEXUS → PRO unlocked, free. <span style={{ color: "#ededf0" }}>Live now.</span>
          </div>
          <BuyNexusButton size="sm" />
        </div>

        {/* Path 2 — subscribe USDC */}
        <div style={{ border: "1px solid #232327", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8, opacity: PAYMENTS_LIVE ? 1 : 0.7 }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: "#fff", fontWeight: "bold" }}>SUBSCRIBE</div>
          <div style={{ fontFamily: mono, fontSize: 9, color: "#a1a1aa" }}>
            <span style={{ color: "#fff", fontSize: 13, fontWeight: "bold" }}>${PRO_MONTHLY_USDC}</span>/mo in USDC.
            Pay in $NEXUS → <span style={{ color: "#ededf0" }}>${nexusDiscountedPrice()}/mo ({NEXUS_PAY_DISCOUNT_PCT}% off)</span>.
          </div>
          {!PAYMENTS_LIVE ? (
            <div style={{ fontFamily: mono, fontSize: 9, color: "#71717a", border: "1px solid #232327", borderRadius: 3, padding: "5px 10px", textAlign: "center" }}>coming soon</div>
          ) : !subOpen ? (
            <button onClick={() => setSubOpen(true)} style={{ fontFamily: mono, fontSize: 10, color: "#141416", background: "#ededf0", border: "none", borderRadius: 3, padding: "7px 10px", cursor: "pointer", fontWeight: "bold", letterSpacing: "0.06em" }}>SUBSCRIBE — USDC</button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", gap: 4 }}>
                {([["usdc", `$${PRO_MONTHLY_USDC} USDC`], ["nexus", `$${nexusDiscountedPrice()} $NEXUS`]] as const).map(([m, lbl]) => (
                  <button key={m} onClick={() => { setMethod(m); setSubStatus("idle"); setSubMsg(""); }}
                    style={{ flex: 1, fontFamily: mono, fontSize: 8.5, cursor: "pointer", borderRadius: 3, padding: "4px 6px",
                      background: method === m ? "#ededf015" : "#0a0a0b", border: `1px solid ${method === m ? "#ededf0" : "#232327"}`,
                      color: method === m ? "#ededf0" : "#a1a1aa" }}>{lbl}{m === "nexus" ? " · 25% off" : ""}</button>
                ))}
              </div>
              <div style={{ fontFamily: mono, fontSize: 8.5, color: "#a1a1aa", lineHeight: 1.5 }}>
                {method === "usdc"
                  ? <>1. Send <span style={{ color: "#fff" }}>${PRO_MONTHLY_USDC} USDC on Arbitrum</span> to:</>
                  : <>1. Send <span style={{ color: "#fff" }}>{nexusAmt ? `~${nexusAmt}` : "…"} $NEXUS on Base</span> to:</>}
              </div>
              <button onClick={copyReceiver} title="Copy" style={{ fontFamily: mono, fontSize: 8.5, color: "#ededf0", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3, padding: "6px 8px", cursor: "pointer", textAlign: "left", wordBreak: "break-all" }}>
                {SUBSCRIPTION_RECEIVER} {copied ? "✓ copied" : "⧉"}
              </button>
              <div style={{ fontFamily: mono, fontSize: 8.5, color: "#a1a1aa" }}>2. Paste the transaction hash:</div>
              <input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="0x…" spellCheck={false}
                style={{ fontFamily: mono, fontSize: 9, color: "#fff", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3, padding: "6px 8px", outline: "none" }} />
              <button onClick={verifyPayment} disabled={subStatus === "verifying" || subStatus === "ok"}
                style={{ fontFamily: mono, fontSize: 10, color: "#141416", background: subStatus === "ok" ? "#33333a" : "#ededf0", border: "none", borderRadius: 3, padding: "7px 10px", cursor: subStatus === "verifying" ? "default" : "pointer", fontWeight: "bold", opacity: subStatus === "verifying" ? 0.6 : 1 }}>
                {subStatus === "verifying" ? "VERIFYING…" : subStatus === "ok" ? "✓ ACTIVATED" : `ACTIVATE ${TIER_NAME.toUpperCase()}`}
              </button>
              {subMsg && <div style={{ fontFamily: mono, fontSize: 8.5, color: subStatus === "ok" ? "#ededf0" : "#f7525f", lineHeight: 1.4 }}>{subMsg}</div>}
            </div>
          )}
        </div>
      </div>

      <div style={{ fontFamily: mono, fontSize: 8, color: "#33333a", marginTop: 10, lineHeight: 1.4 }}>
        {TIER_NAME} is a software subscription. $NEXUS pays for it (consumptive use) or unlocks it by holdings (access) — no revenue share, no yield.
      </div>
    </div>
  );
}
