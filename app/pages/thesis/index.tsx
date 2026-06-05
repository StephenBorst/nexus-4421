/**
 * /feed/thesis/:wallet/:id — Thesis Permalink
 *
 * Ph22: Shareable thesis detail page.
 *   - Full thesis card with levels, live price, notes
 *   - Dynamic OG meta tags (og.nexustradinglabs.com/og/thesis/:wallet/:id)
 *   - Share button (copy link)
 * Ph25: "Verify Outcome" button for closed theses — CoinGecko OHLC cross-check
 */

import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useLivePrices, calcUnrealizedPnl, distancePct } from "@/hooks/useLivePrices";

const API_BASE = "https://og.nexustradinglabs.com";
const OG_BASE  = "https://og.nexustradinglabs.com";

type FeedThesis = {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward: number;
  positionSize: number;
  leverage: number;
  status: "ACTIVE" | "HIT_TP" | "STOPPED_OUT" | "INVALIDATED" | "CLOSED";
  actualPnl: number | null;
  createdAt: number;
  notes: string;
  wallet: string;
  pfp: string | null;
  displayName: string | null;
  onChainId?: number;
  onChainTxHash?: string;
};

type VerifyResult = {
  verified: boolean;
  hitTP: boolean;
  hitSL: boolean;
  status: string;
  method: string;
  candlesChecked: number;
  error?: string;
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  ACTIVE:      { label: "ACTIVE",      color: "#4a9fff", bg: "#0a1a2a", border: "#1a3a5a" },
  HIT_TP:      { label: "HIT TP",      color: "#00ff88", bg: "#0a2a0a", border: "#1a4a2a" },
  STOPPED_OUT: { label: "STOPPED OUT", color: "#ff4444", bg: "#2a0a0a", border: "#4a1a1a" },
  INVALIDATED: { label: "INVALIDATED", color: "#fbbf24", bg: "#2a1a00", border: "#4a3a00" },
  CLOSED:      { label: "CLOSED",      color: "#8aaa9a", bg: "#12161a", border: "#2a3a4a" },
  PENDING:     { label: "PENDING",     color: "#8aaa9a", bg: "#0d120d", border: "#2a4a3a" },
};

// Neutral fallback for any unrecognized / future status value so the page never crashes.
const STATUS_FALLBACK = { label: "UNKNOWN", color: "#8aaa9a", bg: "#0d120d", border: "#2a4a3a" };

function setMeta(property: string, content: string) {
  let el = document.querySelector(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function WalletIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="14" rx="2" />
      <path d="M16 12h4" />
      <circle cx="18" cy="12" r="1" fill="currentColor" />
      <path d="M6 2h8a2 2 0 0 1 2 2v2H4V4a2 2 0 0 1 2-2z" />
    </svg>
  );
}

function Avatar({ pfp, displayName, size = 40 }: { pfp: string | null; displayName: string | null; size?: number }) {
  const [err, setErr] = useState(false);
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      border: "1px solid #1a3a1a", background: "#0d120d",
      overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
      color: "#3a5a4a", flexShrink: 0,
    }}>
      {pfp && !err ? (
        <img src={pfp} alt={displayName ?? ""} onError={() => setErr(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : <WalletIcon />}
    </div>
  );
}

export default function ThesisPage() {
  const { wallet, id } = useParams<{ wallet: string; id: string }>();
  const navigate = useNavigate();

  const [thesis, setThesis] = useState<FeedThesis | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Ph25: price verification
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  // Share / copy state
  const [copied, setCopied] = useState(false);

  // Live price (for ACTIVE theses)
  const activeSymbols = thesis?.status === "ACTIVE" ? [thesis.symbol] : [];
  const livePrices = useLivePrices(activeSymbols);

  // ── Fetch thesis ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!wallet || !id) return;
    setLoading(true);
    setNotFound(false);
    setVerifyResult(null);
    fetch(`${API_BASE}/thesis/${wallet}/${id}`)
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data) => {
        if (data?.thesis) setThesis(data.thesis);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [wallet, id]);

  // ── OG meta tags ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!thesis || !wallet || !id) return;
    const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
    const name = thesis.displayName ?? `${thesis.wallet.slice(0, 6)}…${thesis.wallet.slice(-4)}`;
    const title = `${ticker} ${thesis.direction} by ${name}`;
    const desc = `Entry: $${thesis.entryPrice.toFixed(2)} | SL: $${thesis.stopLoss.toFixed(2)} | TP: $${thesis.takeProfit1.toFixed(2)} | R:R 1:${thesis.riskReward.toFixed(2)}`;
    const ogImg = `${OG_BASE}/og/thesis/${wallet}/${id}`;
    const ogImgPng = `${OG_BASE}/og/thesis/${wallet}/${id}.png`;
    const pageUrl = window.location.href;

    document.title = title;
    setMeta("og:title", title);
    setMeta("og:description", desc);
    setMeta("og:image", ogImg);
    setMeta("og:url", pageUrl);
    setMeta("og:type", "article");
    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:title", title);
    setMeta("twitter:description", desc);
    setMeta("twitter:image", ogImgPng);

    return () => {
      document.title = "Nexus Trading Labs";
      setMeta("og:title", "Nexus Trading Labs");
      setMeta("og:description", "Non-custodial Perpetual DEX on Arbitrum");
      setMeta("og:image", "https://nexustradinglabs.com/og.png");
      setMeta("og:url", "https://trade.nexustradinglabs.com");
      setMeta("og:type", "website");
      setMeta("twitter:card", "summary_large_image");
      setMeta("twitter:title", "Nexus Trading Labs");
      setMeta("twitter:description", "Non-custodial Perpetual DEX on Arbitrum");
      setMeta("twitter:image", "https://nexustradinglabs.com/og.png");
    };
  }, [thesis, wallet, id]);

  // ── Ph25: Verify outcome ─────────────────────────────────────────────────────
  async function handleVerify() {
    if (!wallet || !id) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const r = await fetch(`${API_BASE}/verify/${wallet}/${id}`);
      const data = await r.json();
      setVerifyResult(data);
    } catch {
      setVerifyResult({ verified: false, hitTP: false, hitSL: false, status: "", method: "", candlesChecked: 0, error: "request failed" });
    } finally {
      setVerifying(false);
    }
  }

  // ── Share ────────────────────────────────────────────────────────────────────
  function handleShare() {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  // ── Render helpers ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ background: "#0a0e0a", minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontFamily: "monospace", fontSize: 12, color: "#2a4a3a" }}>loading thesis...</div>
      </div>
    );
  }

  if (notFound || !thesis) {
    return (
      <div style={{ background: "#0a0e0a", minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
        <div style={{ fontSize: 24, color: "#2a4a3a" }}>◆</div>
        <div style={{ fontFamily: "monospace", fontSize: 12, color: "#2a4a3a" }}>thesis not found or not public</div>
        <button
          onClick={() => navigate("/feed")}
          style={{ background: "none", border: "1px solid #1a2e1a", borderRadius: 3, color: "#3a5a4a", fontFamily: "monospace", fontSize: 10, padding: "6px 14px", cursor: "pointer" }}
        >← BACK TO FEED</button>
      </div>
    );
  }

  const cfg = STATUS_CONFIG[thesis.status] ?? STATUS_FALLBACK;
  const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
  const shortAddr = `${thesis.wallet.slice(0, 6)}…${thesis.wallet.slice(-4)}`;
  const traderName = thesis.displayName ?? shortAddr;
  const timeAgo = (() => {
    const diff = Date.now() - thesis.createdAt;
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    return "just now";
  })();

  const markPrice = livePrices[thesis.symbol] ?? null;
  const isClosed = thesis.status === "HIT_TP" || thesis.status === "STOPPED_OUT";

  // Outbound share — pre-filled X / Farcaster posts that pull external eyes back
  // into the feed. The page already emits rich OG cards, so the link unfurls.
  const shareUrl = typeof window !== "undefined" ? window.location.href : "";
  const shareText =
    `📡 ${ticker} ${thesis.direction} ${thesis.leverage.toFixed(1)}x\n\n` +
    `Entry $${thesis.entryPrice.toFixed(2)} · Stop $${thesis.stopLoss.toFixed(2)} · TP $${thesis.takeProfit1.toFixed(2)} (R:R 1:${thesis.riskReward.toFixed(2)})\n\n` +
    `Graded on-chain vs public price on Nexus Trading Labs 👇`;
  const shareX = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`;
  const shareFc = `https://warpcast.com/~/compose?text=${encodeURIComponent(shareText + "\n\n" + shareUrl)}&embeds[]=${encodeURIComponent(shareUrl)}`;

  return (
    <div style={{ background: "#0a0e0a", minHeight: "100dvh", padding: 0 }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderBottom: "1px solid #1a2e1a", background: "#080c08" }}>
        <button
          onClick={() => navigate(-1)}
          style={{ background: "none", border: "1px solid #1a2e1a", borderRadius: 3, color: "#3a5a4a", fontFamily: "monospace", fontSize: 9, padding: "4px 10px", cursor: "pointer" }}
        >← BACK</button>
        <div style={{ flex: 1 }} />
        {/* Outbound share — X / Farcaster / copy link */}
        <a
          href={shareX} target="_blank" rel="noopener noreferrer"
          title="Share on X"
          style={{ textDecoration: "none", border: "1px solid #1a2e1a", borderRadius: 3, color: "#8aaa9a", fontFamily: "monospace", fontSize: 9, padding: "4px 9px", letterSpacing: "0.05em" }}
        >𝕏 SHARE</a>
        <a
          href={shareFc} target="_blank" rel="noopener noreferrer"
          title="Share on Farcaster"
          style={{ textDecoration: "none", border: "1px solid #1a2e1a", borderRadius: 3, color: "#8a7aff", fontFamily: "monospace", fontSize: 9, padding: "4px 9px", letterSpacing: "0.05em" }}
        >✦ CAST</a>
        <button
          onClick={handleShare}
          title="Copy link"
          style={{
            background: copied ? "#0a1a0a" : "none",
            border: `1px solid ${copied ? "#00ff88" : "#1a2e1a"}`,
            borderRadius: 3, color: copied ? "#00ff88" : "#3a5a4a",
            fontFamily: "monospace", fontSize: 9, padding: "4px 10px", cursor: "pointer", letterSpacing: "0.05em",
          }}
        >{copied ? "✓ COPIED" : "⧉ LINK"}</button>
      </div>

      <div style={{ padding: 16, maxWidth: 720, margin: "0 auto" }}>

        {/* Thesis card */}
        <div style={{ background: "#0d120d", border: `1px solid ${cfg.border}`, borderRadius: 4, padding: "20px 24px", marginBottom: 12 }}>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
            <Avatar pfp={thesis.pfp} displayName={thesis.displayName} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <button
                onClick={() => navigate(`/feed/trader/${thesis.wallet}`)}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
              >
                <div style={{ fontFamily: "monospace", fontSize: 13, color: "#8aaa9a" }}>{traderName}</div>
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a" }}>{shortAddr}</div>
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {thesis.onChainTxHash ? (
                <a href={`https://arbiscan.io/tx/${thesis.onChainTxHash}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, textDecoration: "none" }} title="on-chain verified">⛓</a>
              ) : thesis.onChainId !== undefined ? (
                <span style={{ fontSize: 14 }} title="on-chain verified">⛓</span>
              ) : null}
              <div style={{ fontFamily: "monospace", fontSize: 9, color: "#2a4a3a" }}>{timeAgo}</div>
              <div style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "0.08em", padding: "3px 8px", borderRadius: 3, background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }}>
                {cfg.label}
              </div>
            </div>
          </div>

          {/* Symbol + direction */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 20 }}>
            <span style={{ fontFamily: "monospace", fontSize: 36, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
            <span style={{ fontFamily: "monospace", fontSize: 16, color: thesis.direction === "LONG" ? "#00ff88" : "#ff4444" }}>
              {thesis.direction === "LONG" ? "↑" : "↓"} {thesis.direction} · {thesis.leverage.toFixed(1)}x
            </span>
          </div>

          {/* Key levels */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "10px 16px", marginBottom: 16, padding: 14, background: "#080c08", borderRadius: 4, border: "1px solid #1a2e1a" }}>
            {[
              { label: "ENTRY", val: `$${thesis.entryPrice.toFixed(2)}`,   color: "#8aaa9a" },
              { label: "STOP",  val: `$${thesis.stopLoss.toFixed(2)}`,      color: "#ff4444" },
              { label: "TP1",   val: `$${thesis.takeProfit1.toFixed(2)}`,   color: "#00ff88" },
              { label: "R:R",   val: `1:${thesis.riskReward.toFixed(2)}`,   color: thesis.riskReward >= 2 ? "#00ff88" : "#fbbf24" },
              { label: "SIZE",  val: `$${thesis.positionSize.toFixed(0)}`,  color: "#8aaa9a" },
            ].map(({ label, val, color }) => (
              <div key={label}>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</div>
                <div style={{ fontSize: 14, color, fontFamily: "monospace", fontWeight: "bold" }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Live P&L — active theses */}
          {thesis.status === "ACTIVE" && markPrice != null && (() => {
            const { pnl, pct } = calcUnrealizedPnl(thesis.direction, thesis.entryPrice, markPrice, thesis.positionSize);
            const toSL = distancePct(markPrice, thesis.stopLoss);
            const toTP = distancePct(markPrice, thesis.takeProfit1);
            return (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "10px 16px", marginBottom: 16, padding: 14, background: "#080c08", borderRadius: 4, border: "1px solid #1a3a5a" }}>
                {[
                  { label: "MARK",       val: `$${markPrice.toFixed(markPrice < 10 ? 4 : 2)}`, color: "#fff" },
                  { label: "UNREALIZED", val: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`, color: pnl >= 0 ? "#00ff88" : "#ff4444" },
                  { label: "TO SL",      val: `${toSL.toFixed(2)}%`, color: "#ff4444" },
                  { label: "TO TP1",     val: `${toTP.toFixed(2)}%`, color: "#00ff88" },
                ].map(({ label, val, color }) => (
                  <div key={label}>
                    <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</div>
                    <div style={{ fontSize: 13, color, fontFamily: "monospace", fontWeight: "bold" }}>{val}</div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Actual PnL if closed */}
          {thesis.actualPnl !== null && thesis.status !== "ACTIVE" && (
            <div style={{ fontFamily: "monospace", fontSize: 14, color: thesis.actualPnl >= 0 ? "#00ff88" : "#ff4444", marginBottom: 12 }}>
              ACTUAL PnL: {thesis.actualPnl >= 0 ? "+" : ""}${thesis.actualPnl.toFixed(2)}
            </div>
          )}

          {/* Notes */}
          {thesis.notes && (
            <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5a8a6a", borderTop: "1px solid #1a2e1a", paddingTop: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {thesis.notes}
            </div>
          )}
        </div>

        {/* Ph25: Verify Outcome — only for closed theses */}
        {isClosed && (
          <div style={{ background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4, padding: "16px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "monospace", fontSize: 10, color: "#3a5a4a", letterSpacing: "0.05em" }}>PRICE VERIFICATION</div>
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#2a4a3a", marginTop: 2 }}>
                  Cross-check recorded outcome against CoinGecko OHLC data
                </div>
              </div>
              {!verifyResult && (
                <button
                  onClick={handleVerify}
                  disabled={verifying}
                  style={{
                    background: "none", border: "1px solid #1a3a1a", borderRadius: 3,
                    color: verifying ? "#2a4a3a" : "#3a6a4a",
                    fontFamily: "monospace", fontSize: 9, padding: "5px 12px",
                    cursor: verifying ? "default" : "pointer", letterSpacing: "0.05em",
                  }}
                >{verifying ? "verifying..." : "VERIFY OUTCOME →"}</button>
              )}
            </div>

            {verifyResult && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #1a2e1a" }}>
                {verifyResult.error ? (
                  <div style={{ fontFamily: "monospace", fontSize: 10, color: "#ff4444" }}>
                    error: {verifyResult.error}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{
                        fontFamily: "monospace", fontSize: 18, fontWeight: "bold",
                        color: verifyResult.verified ? "#00ff88" : "#ff4444",
                      }}>
                        {verifyResult.verified ? "✓ VERIFIED" : "✗ DISPUTED"}
                      </div>
                      <div style={{ fontFamily: "monospace", fontSize: 9, color: "#2a4a3a" }}>
                        via {verifyResult.method} · {verifyResult.candlesChecked} candles
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 16 }}>
                      <div>
                        <div style={{ fontFamily: "monospace", fontSize: 8, color: "#3a5a4a" }}>TP HIT IN DATA</div>
                        <div style={{ fontFamily: "monospace", fontSize: 11, color: verifyResult.hitTP ? "#00ff88" : "#3a5a4a" }}>
                          {verifyResult.hitTP ? "yes" : "no"}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontFamily: "monospace", fontSize: 8, color: "#3a5a4a" }}>SL HIT IN DATA</div>
                        <div style={{ fontFamily: "monospace", fontSize: 11, color: verifyResult.hitSL ? "#ff4444" : "#3a5a4a" }}>
                          {verifyResult.hitSL ? "yes" : "no"}
                        </div>
                      </div>
                    </div>
                    {!verifyResult.verified && (
                      <div style={{ fontFamily: "monospace", fontSize: 9, color: "#5a3a1a" }}>
                        price data does not confirm recorded outcome — outcome may have been manually set
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer: link to full trader profile */}
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <button
            onClick={() => navigate(`/feed/trader/${thesis.wallet}`)}
            style={{
              background: "none", border: "1px solid #1a2e1a", borderRadius: 3,
              color: "#3a5a4a", fontFamily: "monospace", fontSize: 9,
              padding: "6px 14px", cursor: "pointer", letterSpacing: "0.05em",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#00ff88"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#00ff88"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#3a5a4a"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a2e1a"; }}
          >VIEW {traderName.toUpperCase()} PROFILE →</button>
        </div>
      </div>
    </div>
  );
}
