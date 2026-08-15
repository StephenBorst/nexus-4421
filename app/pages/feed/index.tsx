/**
 * /feed — Public Thesis Feed
 *
 * Shows all theses marked isPublic=true across all wallets.
 * Phase 6: COPY button — pre-fills a modal so any trader can copy a thesis into their LAB.
 * Phase 7: RANKS view — thesis leaderboard aggregated from feed data.
 */

import { useState, useEffect, useMemo } from "react";
import { useAccount } from "@orderly.network/hooks";
import { useNavigate } from "react-router-dom";
import { useLivePrices, calcUnrealizedPnl, distancePct } from "@/hooks/useLivePrices";
import { fetchOnChainRepScore } from "@/hooks/useThesisRegistry";
import { NexusTierBadge } from "@/components/NexusTierBadge";
import { MessageTraderButton } from "@/components/MessageTraderButton";
import { NexusTreasuryStack } from "@/components/NexusTreasuryStack";
import { NexusMarket } from "@/components/NexusMarket";
import type { ThesisTrade } from "@/pages/lab/types";
import CommentsPanel from "@/components/CommentsPanel";
import { useIsMobile } from "@/pages/lab/useIsMobile";
import { Sparkline, SectionHeader } from "@/pages/lab/components";
import { getAgentSig } from "@/pages/lab/agentKeys";
import { chartImageList, effectiveStatus } from "@/pages/lab/helpers";
import LiveNow from "./LiveNow";
import Contested from "./Contested";
import Contrarians from "./Contrarians";
import Resolved, { type ResolutionEvent } from "./Resolved";
import LeakReport from "./LeakReport";
import { lifecycleState, describeUpdate, updateKind } from "@/lib/lifecycle.mjs";
import Desks from "./Desks";
import ArenaStrip from "./ArenaStrip";
import WatchOnlyBanner from "./WatchOnlyBanner";

const API_BASE = "https://og.nexustradinglabs.com";

// Regime buckets → the trader's own words. Server keys are stable; labels aren't.
const REGIME_LABEL: Record<string, string> = {
  "trend:TREND_UP": "uptrends",
  "trend:TREND_DOWN": "downtrends",
  "trend:CHOP": "chop",
  "align:WITH_TREND": "trend-following",
  "align:AGAINST_TREND": "fading moves",
  "align:CHOP": "rangebound tape",
  "vol:CALM": "calm tape",
  "vol:NORMAL": "normal vol",
  "vol:VOLATILE": "volatile tape",
};

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
  gradedOutcome?: "WIN" | "LOSS"; // trustless price-grade (cron-stamped); absent = not yet graded
  actualPnl: number | null;
  createdAt: number;
  notes: string;
  chartUrls?: string[];  // optional charts — render via chartImageList()
  chartUrl?: string;     // legacy single-chart field, still honoured
  wallet: string;
  pfp: string | null;
  displayName: string | null;
  fundingCost72h?: number;
  riskPercent?: number;
  accountSize?: number;
  onChainId?: number;
  onChainTxHash?: string;
  copyCount?: number;
  agent?: boolean; // autonomous-agent call (surfaced from agent:feed:* by lab-api)
  // Append-only lifecycle timeline (app/lib/lifecycle.mjs). Rides the feed payload
  // via the wholesale thesis spread. Narrative only — never affects the grade.
  updates?: { at: number; kind: string; price?: number; sizePct?: number; note?: string }[];
};

const STATUS_CONFIG = {
  ACTIVE:      { label: "ACTIVE",      color: "#d4d4d8", bg: "#1a1a1e", border: "#33333a" },
  HIT_TP:      { label: "HIT TP",      color: "#ededf0", bg: "#1a1a1e", border: "#33333a" },
  STOPPED_OUT: { label: "STOPPED OUT", color: "#f7525f", bg: "#241012", border: "#4a1e22" },
  INVALIDATED: { label: "INVALIDATED", color: "#fbbf24", bg: "#2a1a00", border: "#4a3a00" },
  CLOSED:      { label: "CLOSED",      color: "#a1a1aa", bg: "#1a1a1e", border: "#33333a" },
};

// ─── Calc helper (mirrors lab/index.tsx calcThesis) ─────────────────────────
function calcCopy(
  entry: number,
  sl: number,
  tp1: number,
  accountSize: number,
  riskPct: number,
  fundingRate: number,
  direction: "LONG" | "SHORT",
) {
  if (!entry || !sl || !tp1 || !accountSize || !riskPct) return null;
  const stopDistancePct = Math.abs(entry - sl) / entry;
  const rewardDistance = Math.abs(tp1 - entry) / entry;
  if (stopDistancePct === 0) return null;
  const riskAmount = accountSize * (riskPct / 100);
  const positionSize = Math.min(riskAmount / stopDistancePct, accountSize * 100);
  const leverage = positionSize / accountSize;
  const riskReward = rewardDistance / stopDistancePct;
  const fundingPerPeriod = positionSize * (Math.abs(fundingRate) / 100);
  return { positionSize, leverage, riskReward, riskAmount, fundingPerPeriod };
}

const COPY_PREFS_KEY = "nexus-copy-prefs";

// ─── Copy Modal ──────────────────────────────────────────────────────────────
function CopyModal({
  thesis,
  walletAddress,
  onClose,
}: {
  thesis: FeedThesis;
  walletAddress: string;
  onClose: () => void;
}) {
  const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
  const traderName = thesis.displayName ?? `${thesis.wallet.slice(0, 6)}…${thesis.wallet.slice(-4)}`;

  const [accountSize, setAccountSize] = useState(() => {
    try { return JSON.parse(localStorage.getItem(COPY_PREFS_KEY) ?? "{}").accountSize ?? ""; }
    catch { return ""; }
  });
  const [riskPct, setRiskPct] = useState(() => {
    try { return JSON.parse(localStorage.getItem(COPY_PREFS_KEY) ?? "{}").riskPct ?? "1.5"; }
    catch { return "1.5"; }
  });
  const [fundingRate, setFundingRate] = useState("0.01");
  const [extraNotes, setExtraNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  // Persist prefs on change
  useEffect(() => {
    try { localStorage.setItem(COPY_PREFS_KEY, JSON.stringify({ accountSize, riskPct })); }
    catch { /* ignore */ }
  }, [accountSize, riskPct]);

  const accNum = parseFloat(accountSize);
  const riskNum = parseFloat(riskPct);
  const accErr = accountSize !== "" && (isNaN(accNum) || accNum <= 0) ? "must be > 0" : "";
  const riskErr = riskPct !== "" && (isNaN(riskNum) || riskNum < 0.1 || riskNum > 100) ? "must be 0.1–100" : "";
  const hasValidationErr = !!accErr || !!riskErr;

  const calc = useMemo(() => {
    if (hasValidationErr) return null;
    const acc = parseFloat(accountSize);
    const risk = parseFloat(riskPct);
    const fund = parseFloat(fundingRate);
    if (!acc || !risk) return null;
    return calcCopy(
      thesis.entryPrice, thesis.stopLoss, thesis.takeProfit1,
      acc, risk, fund, thesis.direction,
    );
  }, [accountSize, riskPct, fundingRate, thesis, hasValidationErr]);

  const inputStyle: React.CSSProperties = {
    background: "#0f0f11",
    border: "1px solid #232327",
    borderRadius: 3,
    color: "#ededf0",
    fontFamily: "var(--nx-font-mono)",
    fontSize: 11,
    padding: "6px 8px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 8,
    color: "#52525b",
    fontFamily: "var(--nx-font-mono)",
    marginBottom: 4,
    letterSpacing: "0.05em",
  };

  async function handleSave() {
    if (!calc || hasValidationErr) { setErr("check inputs"); return; }
    setSaving(true);
    setErr("");
    try {
      const resp = await fetch(`${API_BASE}/lab/${walletAddress}`);
      const existing = resp.ok ? await resp.json() : { theses: [], notes: {} };
      const existingTheses: ThesisTrade[] = existing.theses ?? [];

      const attribution = `📋 Copied from ${traderName}${thesis.notes ? `\n\n${thesis.notes}` : ""}${extraNotes ? `\n\n${extraNotes}` : ""}`;

      const newThesis: ThesisTrade = {
        id: `copy_${Date.now()}`,
        symbol: thesis.symbol,
        direction: thesis.direction,
        entryPrice: thesis.entryPrice,
        stopLoss: thesis.stopLoss,
        takeProfit1: thesis.takeProfit1,
        takeProfit2: thesis.takeProfit2,
        riskPercent: parseFloat(riskPct),
        accountSize: parseFloat(accountSize),
        fundingRate: parseFloat(fundingRate),
        positionSize: calc.positionSize,
        leverage: calc.leverage,
        riskReward: calc.riskReward,
        fundingCost8h: calc.fundingPerPeriod,
        fundingCost24h: calc.fundingPerPeriod * 3,
        fundingCost72h: calc.fundingPerPeriod * 9,
        notes: attribution,
        createdAt: Date.now(),
        status: "ACTIVE",
        actualPnl: null,
        isPublic: false,
        copiedFromWallet: thesis.wallet,
      };

      const updated = [newThesis, ...existingTheses];
      await fetch(`${API_BASE}/lab/${walletAddress}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theses: updated,
          notes: existing.notes ?? {},
          copiedFromWallet: thesis.wallet,
          copiedThesisSymbol: thesis.symbol,
          copiedThesisDirection: thesis.direction,
          copiedThesisId: thesis.id,
        }),
      });

      setSaved(true);
      setTimeout(onClose, 1200);
    } catch {
      setErr("failed to save — check connection");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.75)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
    >
      <div style={{
        background: "#141416",
        border: "1px solid #232327",
        borderRadius: 6,
        padding: 20,
        width: "100%",
        maxWidth: 420,
        maxHeight: "90vh",
        overflowY: "auto",
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 16, fontWeight: "bold", color: "#fff" }}>
              {ticker}
              <span style={{ fontSize: 11, marginLeft: 8, color: thesis.direction === "LONG" ? "#3ecf8e" : "#f7525f" }}>
                {thesis.direction === "LONG" ? "↑" : "↓"} {thesis.direction}
              </span>
            </div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 2 }}>
              📋 copying from {traderName}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#52525b", cursor: "pointer", fontSize: 16, padding: 0 }}
          >✕</button>
        </div>

        {/* Original levels (read-only) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(70px, 1fr))", gap: "8px 12px", marginBottom: 16, padding: 10, background: "#0f0f11", borderRadius: 4, border: "1px solid #232327" }}>
          {[
            { label: "ENTRY", val: `$${thesis.entryPrice.toFixed(2)}`, color: "#a1a1aa" },
            { label: "STOP",  val: `$${thesis.stopLoss.toFixed(2)}`,   color: "#f7525f" },
            { label: "TP1",   val: `$${thesis.takeProfit1.toFixed(2)}`, color: "#ededf0" },
            { label: "R:R",   val: `1:${thesis.riskReward.toFixed(2)}`, color: thesis.riskReward >= 2 ? "#ededf0" : "#fbbf24" },
          ].map(({ label, val, color }) => (
            <div key={label}>
              <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{label}</div>
              <div style={{ fontSize: 11, color, fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Editable: account size + risk + funding */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 10, marginBottom: 4 }}>
          <div>
            <div style={labelStyle}>ACCOUNT SIZE ($)</div>
            <input
              style={{ ...inputStyle, borderColor: accErr ? "#4a1e22" : "#232327" }}
              type="number"
              placeholder="10000"
              value={accountSize}
              onChange={(e) => setAccountSize(e.target.value)}
            />
            {accErr && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#f7525f", marginTop: 3 }}>{accErr}</div>}
          </div>
          <div>
            <div style={labelStyle}>RISK %</div>
            <input
              style={{ ...inputStyle, borderColor: riskErr ? "#4a1e22" : "#232327" }}
              type="number"
              placeholder="1.5"
              step="0.1"
              value={riskPct}
              onChange={(e) => setRiskPct(e.target.value)}
            />
            {riskErr && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#f7525f", marginTop: 3 }}>{riskErr}</div>}
          </div>
          <div>
            <div style={labelStyle}>FUNDING %</div>
            <input
              style={inputStyle}
              type="number"
              placeholder="0.01"
              step="0.001"
              value={fundingRate}
              onChange={(e) => setFundingRate(e.target.value)}
            />
          </div>
        </div>

        {/* Live calc output */}
        <div style={{ marginBottom: 12, marginTop: 10 }}>
          {calc ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(70px, 1fr))", gap: "8px 10px", padding: 10, background: "#1a1a1e", borderRadius: 4, border: "1px solid #232327" }}>
              <div>
                <div style={labelStyle}>YOUR SIZE</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#ededf0", fontWeight: "bold" }}>${calc.positionSize.toFixed(0)}</div>
              </div>
              <div>
                <div style={labelStyle}>LEVERAGE</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: "bold", color: calc.leverage > 25 ? "#f7525f" : calc.leverage > 10 ? "#fbbf24" : "#3ecf8e" }}>
                  {calc.leverage.toFixed(1)}x
                </div>
              </div>
              <div>
                <div style={labelStyle}>R:R</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: "bold", color: calc.riskReward >= 2 ? "#ededf0" : "#fbbf24" }}>
                  1:{calc.riskReward.toFixed(2)}
                </div>
              </div>
              <div>
                <div style={labelStyle}>MAX LOSS</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#f7525f", fontWeight: "bold" }}>${calc.riskAmount.toFixed(2)}</div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 10, background: "#0f0f11", borderRadius: 4, border: "1px solid #232327", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#33333a", textAlign: "center" }}>
              enter account size + risk % to calculate your position
            </div>
          )}
        </div>

        {/* Additional notes */}
        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>ADDITIONAL NOTES (optional)</div>
          <textarea
            style={{ ...inputStyle, resize: "vertical", minHeight: 60 }}
            placeholder="your thoughts on this trade..."
            value={extraNotes}
            onChange={(e) => setExtraNotes(e.target.value)}
          />
        </div>

        {/* Attribution preview */}
        <div style={{ marginBottom: 14, padding: 8, background: "#0f0f11", borderRadius: 3, border: "1px solid #232327" }}>
          <div style={labelStyle}>ATTRIBUTION (auto-added to notes)</div>
          <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9, color: "#a1a1aa", lineHeight: 1.5 }}>
            📋 Copied from {traderName}
          </div>
        </div>

        {/* Error */}
        {err && (
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#f7525f", marginBottom: 10 }}>{err}</div>
        )}

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving || saved || !calc || hasValidationErr}
          style={{
            width: "100%",
            background: saved ? "#1a1a1e" : calc && !hasValidationErr ? "#1a1a1e" : "#0f0f11",
            border: `1px solid ${saved ? "#ededf0" : calc && !hasValidationErr ? "#ededf0" : "#232327"}`,
            color: saved ? "#ededf0" : calc && !hasValidationErr ? "#ededf0" : "#33333a",
            fontFamily: "var(--nx-font-mono)",
            fontSize: 11,
            letterSpacing: "0.1em",
            padding: "10px 0",
            borderRadius: 4,
            cursor: calc && !saving && !saved && !hasValidationErr ? "pointer" : "default",
          }}
        >
          {saved ? "✓ SAVED TO LAB" : saving ? "saving..." : "SAVE TO LAB →"}
        </button>
      </div>
    </div>
  );
}

// ─── Avatar ──────────────────────────────────────────────────────────────────
function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="14" rx="2" />
      <path d="M16 12h4" />
      <circle cx="18" cy="12" r="1" fill="currentColor" />
      <path d="M6 2h8a2 2 0 0 1 2 2v2H4V4a2 2 0 0 1 2-2z" />
    </svg>
  );
}

function Avatar({ pfp, displayName, size = 32 }: { pfp: string | null; displayName: string | null; size?: number }) {
  const [err, setErr] = useState(false);
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      border: "1px solid #232327", background: "#141416",
      overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
      color: "#52525b", flexShrink: 0,
    }}>
      {pfp && !err ? (
        <img src={pfp} alt={displayName ?? ""} onError={() => setErr(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <WalletIcon />
      )}
    </div>
  );
}

// ─── Feed Card ───────────────────────────────────────────────────────────────
function FeedCard({
  thesis,
  markPrice,
  walletAddress,
  onCopy,
  following,
  onFollowToggle,
}: {
  thesis: FeedThesis;
  markPrice?: number | null;
  walletAddress: string | null;
  onCopy: (t: FeedThesis) => void;
  following: Set<string>;
  onFollowToggle: (wallet: string) => void;
}) {
  const cfg = STATUS_CONFIG[effectiveStatus(thesis)] ?? STATUS_CONFIG.ACTIVE;
  const shortAddr = `${thesis.wallet.slice(0, 6)}…${thesis.wallet.slice(-4)}`;
  const ticker = thesis.symbol.replace("PERP_", "").replace("_USDC", "");
  const isOwnThesis = walletAddress?.toLowerCase() === thesis.wallet.toLowerCase();
  const isFollowing = following.has(thesis.wallet.toLowerCase());
  const navigate = useNavigate();
  const timeAgo = (() => {
    const diff = Date.now() - thesis.createdAt;
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    return "just now";
  })();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentCount, setCommentCount] = useState(0);

  return (
    <div style={{
      background: "#141416",
      border: `1px solid ${cfg.border}`,
      borderRadius: 4,
      overflow: "hidden",
      opacity: thesis.status === "INVALIDATED" ? 0.65 : 1,
    }}>
      <div style={{ padding: "14px 16px" }}>
      {/* Header: avatar + identity + status + time + copy. Wraps on narrow
          screens so the status badge/buttons drop to a second line instead of
          overlapping the identity. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, rowGap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        <Avatar pfp={thesis.pfp} displayName={thesis.displayName} size={34} />
        <div style={{ flex: 1, minWidth: 120 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
              {thesis.agent ? "Nexus Agent" : (thesis.displayName ?? shortAddr)}
            </span>
            {thesis.agent ? (
              <span style={{ flexShrink: 0, fontSize: 8, letterSpacing: "0.08em", padding: "2px 5px", borderRadius: 3, background: "#1a1a1e", border: "1px solid #33333a", color: "#d4d4d8" }}>🤖 AGENT</span>
            ) : (
              <span style={{ flexShrink: 0 }}><NexusTierBadge address={thesis.wallet} /></span>
            )}
          </div>
          {!thesis.agent && thesis.displayName && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>{shortAddr}</div>}
          {thesis.agent && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>autonomous · funding-edge bot</div>}
        </div>
        <div style={{
          fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.08em",
          padding: "3px 8px", borderRadius: 3,
          background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
          flexShrink: 0,
        }}>
          {cfg.label}
        </div>
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#33333a", flexShrink: 0 }}>{timeAgo}</div>
        {/* On-chain verified badge */}
        {thesis.onChainId !== undefined && (
          thesis.onChainTxHash ? (
            <a
              href={`https://arbiscan.io/tx/${thesis.onChainTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`On-chain verified · thesis #${thesis.onChainId}`}
              style={{ fontSize: 12, textDecoration: "none", flexShrink: 0 }}
              onClick={(e) => e.stopPropagation()}
            >⛓</a>
          ) : (
            <span title={`On-chain verified · thesis #${thesis.onChainId}`} style={{ fontSize: 12, flexShrink: 0 }}>⛓</span>
          )
        )}
        {/* Card actions — quiet by default (accent rationed), with real hover/focus/
            motion from the .nx-* CSS layer instead of hand-rolled handlers. */}
        <button
          className="nx-btn nx-btn-icon"
          onClick={() => navigate(`/feed/thesis/${thesis.wallet}/${thesis.id}`)}
          title="View thesis permalink"
          style={{ flexShrink: 0 }}
        >↗</button>
        {walletAddress && !isOwnThesis && (
          <button
            className={`nx-btn nx-btn-icon${isFollowing ? " is-active" : ""}`}
            onClick={() => onFollowToggle(thesis.wallet.toLowerCase())}
            title={isFollowing ? "Unfollow trader" : "Follow trader"}
            style={{ flexShrink: 0 }}
          >{isFollowing ? "✓" : "+"}</button>
        )}
        <MessageTraderButton
          wallet={thesis.wallet}
          myWallet={walletAddress}
          variant="icon"
          context={{ symbol: thesis.symbol, direction: thesis.direction }}
        />
        {walletAddress && !isOwnThesis && (
          <button
            className="nx-btn nx-btn-icon"
            onClick={() => onCopy(thesis)}
            title="Copy this thesis to your LAB"
            style={{ flexShrink: 0 }}
          >COPY</button>
        )}
        <button
          className={`nx-btn nx-btn-icon${commentsOpen ? " is-active" : ""}`}
          onClick={() => setCommentsOpen((o) => !o)}
          title="Comments"
          style={{ flexShrink: 0 }}
        >💬 {commentCount}</button>
      </div>

      {/* Symbol + direction */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
        <span style={{
          fontFamily: "var(--nx-font-mono)", fontSize: 11,
          color: thesis.direction === "LONG" ? "#3ecf8e" : "#f7525f",
        }}>
          {thesis.direction === "LONG" ? "↑" : "↓"} {thesis.direction} · {thesis.leverage.toFixed(1)}x
        </span>
        {(thesis.copyCount ?? 0) > 0 && (
          <span style={{
            fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#a1a1aa",
            background: "#1a1a1e", border: "1px solid #232327",
            borderRadius: 3, padding: "2px 6px",
          }}>
            📋 {thesis.copyCount} {thesis.copyCount === 1 ? "copy" : "copies"}
          </span>
        )}
        {(thesis.copyCount ?? 0) >= 3 && (
          <span style={{
            fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#fbbf24",
            background: "#2a1a00", border: "1px solid #4a3a00",
            borderRadius: 3, padding: "2px 6px",
          }}>
            🔥 HOT
          </span>
        )}
      </div>

      {/* Key levels grid — auto-fit so the 5 $-value columns reflow (don't clip the
          last column off-card) on narrow phones; unchanged at desktop width. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(70px, 1fr))", gap: "8px 12px", marginBottom: 10 }}>
        {[
          { label: "ENTRY", val: `$${thesis.entryPrice.toFixed(2)}`, color: undefined },
          { label: "STOP",  val: `$${thesis.stopLoss.toFixed(2)}`,   color: "#f7525f" },
          { label: "TP1",   val: `$${thesis.takeProfit1.toFixed(2)}`, color: "#ededf0" },
          { label: "R:R",   val: `1:${thesis.riskReward.toFixed(2)}`, color: thesis.riskReward >= 2 ? "#ededf0" : "#fbbf24" },
          { label: "SIZE",  val: `$${thesis.positionSize.toFixed(0)}`, color: undefined },
        ].map(({ label, val, color }) => (
          <div key={label}>
            <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{label}</div>
            <div style={{ fontSize: 12, color: color ?? "#a1a1aa", fontFamily: "var(--nx-font-mono)" }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Live P&L — active theses with mark price */}
      {thesis.status === "ACTIVE" && markPrice != null && (() => {
        const { pnl, pct } = calcUnrealizedPnl(thesis.direction, thesis.entryPrice, markPrice, thesis.positionSize);
        const toSL = distancePct(markPrice, thesis.stopLoss);
        const toTP = distancePct(markPrice, thesis.takeProfit1);
        const isWinning = pnl >= 0;
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(70px, 1fr))", gap: "8px 12px", marginBottom: 10, paddingTop: 10, borderTop: "1px solid #232327" }}>
            <div>
              <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>MARK</div>
              <div style={{ fontSize: 12, color: "#fff", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>
                ${markPrice.toFixed(markPrice < 10 ? 4 : 2)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>UNREALIZED</div>
              <div style={{ fontSize: 12, fontFamily: "var(--nx-font-mono)", fontWeight: "bold", color: isWinning ? "#3ecf8e" : "#f7525f" }}>
                {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.7 }}>({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>TO SL</div>
              <div style={{ fontSize: 12, color: "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{toSL.toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>TO TP1</div>
              <div style={{ fontSize: 12, color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{toTP.toFixed(2)}%</div>
            </div>
          </div>
        );
      })()}

      {/* Actual PnL (if closed) */}
      {thesis.actualPnl !== null && thesis.status !== "ACTIVE" && (
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: thesis.actualPnl >= 0 ? "#3ecf8e" : "#f7525f", marginBottom: 8 }}>
          ACTUAL PnL: {thesis.actualPnl >= 0 ? "+" : ""}${thesis.actualPnl.toFixed(2)}
        </div>
      )}

      {/* Charts — user-supplied, so ALWAYS through chartImageList (fails closed per item). */}
      {(() => {
        const charts = chartImageList(thesis);
        if (!charts.length) return null;
        return (
          <div style={{ display: "grid", gridTemplateColumns: charts.length === 1 ? "1fr" : "1fr 1fr", gap: 6, marginTop: 8 }}>
            {charts.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noopener noreferrer"
                 onClick={(e) => e.stopPropagation()} style={{ display: "block" }}>
                <img
                  src={src} alt={`${thesis.symbol} chart ${i + 1}`} loading="lazy" referrerPolicy="no-referrer"
                  style={{ width: "100%", maxHeight: charts.length === 1 ? 260 : 170, objectFit: "contain", borderRadius: 3, border: "1px solid #232327", background: "#0a0a0b" }}
                />
              </a>
            ))}
          </div>
        );
      })()}

      {/* Notes */}
      {thesis.notes && (
        <div style={{
          fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#a1a1aa",
          borderTop: "1px solid #232327", paddingTop: 8, marginTop: 4,
          lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {thesis.notes}
        </div>
      )}

      {/* ── LIVE UPDATES — the call as an unfolding story, not a frozen post.
          Shows the most recent couple of updates + how much is still on. This is
          also the cheapest cold-start content: one call yields many posts.
          Self-reported narrative — the graded outcome still comes from the
          originally-posted levels. */}
      {(() => {
        const st = lifecycleState(thesis as unknown as Record<string, unknown>);
        if (!st.count) return null;
        const recent = st.timeline.slice(-2);
        return (
          <div style={{ borderTop: "1px solid #232327", paddingTop: 8, marginTop: 6 }}>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#52525b", letterSpacing: "0.1em", marginBottom: 5 }}>
              UPDATES · {st.count}{!st.closed && <span style={{ color: "#33333a" }}> · {st.size}% still on</span>}{st.closed && <span style={{ color: "#33333a" }}> · closed</span>}
            </div>
            {recent.map((u: { at: number; kind: string; note?: string }, i: number) => (
              <div key={`${u.at}-${i}`} style={{ display: "flex", gap: 6, alignItems: "baseline", marginBottom: 2 }}>
                <span style={{ flexShrink: 0, fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a" }}>{updateKind(u.kind)?.glyph}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#d4d4d8" }}>{describeUpdate(u)}</span>
                {u.note && <span style={{ fontFamily: "var(--nx-font-ui)", fontSize: 10, color: "#a1a1aa", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>— {u.note}</span>}
              </div>
            ))}
          </div>
        );
      })()}
      </div>
      <CommentsPanel
        thesisId={thesis.id}
        walletAddress={walletAddress}
        isOpen={commentsOpen}
        onCountChange={setCommentCount}
        authorWallet={thesis.wallet}
        symbol={thesis.symbol}
        direction={thesis.direction}
      />
    </div>
  );
}

// ─── Rep Score ───────────────────────────────────────────────────────────────
function calcRepScore(wins: number, losses: number, avgRR: number): number {
  const closed = wins + losses;
  const winRate = closed > 0 ? (wins / closed) * 100 : 0;
  const rrBonus = Math.min(avgRR * 10, 20);
  const samplePenalty = Math.max(0, 10 - closed) * 2;
  return Math.max(0, Math.min(100, Math.round(winRate + rrBonus - samplePenalty)));
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────
type TraderStats = {
  wallet: string;
  displayName: string | null;
  pfp: string | null;
  total: number;
  wins: number;
  losses: number;
  active: number;
  invalidated: number;
  winRate: number;
  avgRR: number;
  bestRR: number;
  bestTicker: string;
};

function buildLeaderboard(feed: FeedThesis[]): TraderStats[] {
  const map = new Map<string, TraderStats>();

  for (const t of feed) {
    const key = t.wallet.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        wallet: t.wallet,
        displayName: t.displayName,
        pfp: t.pfp,
        total: 0, wins: 0, losses: 0, active: 0, invalidated: 0,
        winRate: 0, avgRR: 0, bestRR: 0, bestTicker: "",
      });
    }
    const s = map.get(key)!;
    s.total++;
    if (t.status === "ACTIVE") s.active++;
    else if (t.status === "HIT_TP") s.wins++;
    else if (t.status === "STOPPED_OUT") s.losses++;
    else if (t.status === "INVALIDATED") s.invalidated++;

    if (t.riskReward > s.bestRR) {
      s.bestRR = t.riskReward;
      s.bestTicker = t.symbol.replace("PERP_", "").replace("_USDC", "");
    }
  }

  // Compute derived stats
  for (const s of map.values()) {
    const closed = s.wins + s.losses;
    s.winRate = closed > 0 ? (s.wins / closed) * 100 : 0;

    // Avg R:R from all theses for this wallet
    const walletTheses = feed.filter(t => t.wallet.toLowerCase() === s.wallet.toLowerCase());
    s.avgRR = walletTheses.length > 0
      ? walletTheses.reduce((sum, t) => sum + t.riskReward, 0) / walletTheses.length
      : 0;
  }

  // Ph18: sort by Rep Score (composite: winRate + R:R bonus - sample penalty)
  return [...map.values()].sort((a, b) => {
    const aRep = calcRepScore(a.wins, a.losses, a.avgRR);
    const bRep = calcRepScore(b.wins, b.losses, b.avgRR);
    if (bRep !== aRep) return bRep - aRep;
    return b.total - a.total;
  });
}

const RANK_MEDALS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

function LeaderboardView({ feed, walletAddress, onCopy }: {
  feed: FeedThesis[];
  walletAddress: string | null;
  onCopy: (t: FeedThesis) => void;
}) {
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);
  const board = useMemo(() => buildLeaderboard(feed), [feed]);
  const navigate = useNavigate();

  // Ph12/26 -- trustless on-chain stats + Rep Score from NexusRepScore contract
  const [onChainStats, setOnChainStats] = useState<Map<string, { wins: number; losses: number; active: number; repScore: number; avgRR: number }>>(new Map());
  const [onChainLoading, setOnChainLoading] = useState(false);

  // ⚡ Autocopy a verified caller — your agent mirrors their next public call at your
  // own risk (backend reads config.autocopy.leaders → caller:latest). Load who you
  // already copy from your agent config; toggle by GET→merge→PUT (owner-authed).
  const [copyLeaders, setCopyLeaders] = useState<Set<string>>(new Set());
  const [copyBusy, setCopyBusy] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!walletAddress) { setCopyLeaders(new Set()); return; }
    let dead = false;
    fetch(`${API_BASE}/agent/${walletAddress}`).then((r) => r.json())
      .then((d) => { if (!dead) setCopyLeaders(new Set((d?.config?.autocopy?.leaders || []).map((w: string) => w.toLowerCase()))); })
      .catch(() => { /* no agent yet */ });
    return () => { dead = true; };
  }, [walletAddress]);
  async function toggleCopyCaller(callerWallet: string) {
    if (!walletAddress) return;
    const lw = callerWallet.toLowerCase();
    setCopyBusy(lw); setCopyMsg(null);
    try {
      const cur = await fetch(`${API_BASE}/agent/${walletAddress}`).then((r) => r.json()).catch(() => null);
      const config = cur?.config;
      if (!config) { setCopyMsg("Set up your agent in the Lab first — Autocopy runs through it."); return; }
      const leaders = (config.autocopy?.leaders || []).map((w: string) => w.toLowerCase());
      const following = leaders.includes(lw);
      const next = following ? leaders.filter((w: string) => w !== lw) : [...leaders, lw];
      const sig = await getAgentSig(walletAddress);
      const res = await fetch(`${API_BASE}/agent/${walletAddress}/config`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { ...config, autocopy: { enabled: next.length > 0, leaders: next } }, walletSig: sig }),
      });
      if (!res.ok) throw new Error();
      setCopyLeaders(new Set(next));
      setCopyMsg(following ? "Stopped copying" : cur?.state?.active ? "Autocopying — your agent will mirror their next call" : "Autocopy set — activate your agent to start");
      setTimeout(() => setCopyMsg(null), 3500);
    } catch { setCopyMsg("Couldn't update autocopy"); } finally { setCopyBusy(null); }
  }

  useEffect(() => {
    if (board.length === 0) return;
    setOnChainLoading(true);
    Promise.all(
      board.map(async (trader) => {
        try {
          const stats = await fetchOnChainRepScore(trader.wallet);
          return { wallet: trader.wallet.toLowerCase(), stats };
        } catch {
          return { wallet: trader.wallet.toLowerCase(), stats: null };
        }
      })
    ).then((results) => {
      const map = new Map<string, { wins: number; losses: number; active: number; repScore: number; avgRR: number }>();
      for (const { wallet, stats } of results) {
        if (stats && (stats.wins + stats.losses + stats.active + stats.invalidated) > 0) {
          map.set(wallet, { wins: stats.wins, losses: stats.losses, active: stats.active, repScore: stats.repScore, avgRR: stats.avgRR });
        }
      }
      setOnChainStats(map);
      setOnChainLoading(false);
    });
  }, [board.length]);

  // Trustless call grades (public-price graded, on-chain anchored) keyed by wallet.
  const [graded, setGraded] = useState<Map<string, { hitRate: number; avgR: number; calls: number; score: number; meritRank: { tier: string; title: string; glyph: string } | null; rSeries: number[]; discipline: { score: number; scored: number } | null; regimeEdge: { best: { bucket: string; avgR: number } } | null; calibration: { calibrated: boolean; inverted: boolean; gap: number } | null; contrarian: { calls: number; avgR: number; edge: number; score: number } | null }>>(new Map());
  const [emerging, setEmerging] = useState<Map<string, { calls: number; toQualify: number }>>(new Map());
  const [callLedger, setCallLedger] = useState<{ ledgerHash?: string; onChain?: { verified?: boolean; explorer?: string } | null } | null>(null);
  useEffect(() => {
    let cancel = false;
    Promise.all([
      fetch(`${API_BASE}/theses/leaderboard`).then((r) => r.json()).catch(() => null),
      fetch(`${API_BASE}/theses/ledger`).then((r) => r.json()).catch(() => null),
    ]).then(([lb, led]) => {
      if (cancel) return;
      const m = new Map<string, { hitRate: number; avgR: number; calls: number; score: number; meritRank: { tier: string; title: string; glyph: string } | null; rSeries: number[]; discipline: { score: number; scored: number } | null; regimeEdge: { best: { bucket: string; avgR: number } } | null; calibration: { calibrated: boolean; inverted: boolean; gap: number } | null; contrarian: { calls: number; avgR: number; edge: number; score: number } | null }>();
      for (const e of (lb?.leaderboard || [])) {
        if (e.wallet) m.set(e.wallet.toLowerCase(), { hitRate: e.hitRate, avgR: e.avgR, calls: e.calls, score: e.score, meritRank: e.meritRank ?? null, rSeries: Array.isArray(e.rSeries) ? e.rSeries : [], discipline: e.discipline ?? null, regimeEdge: e.regimeEdge ?? null, calibration: e.calibration ?? null, contrarian: e.contrarian ?? null });
      }
      setGraded(m);
      const em = new Map<string, { calls: number; toQualify: number }>();
      for (const e of (lb?.emerging || [])) {
        if (e.wallet) em.set(e.wallet.toLowerCase(), { calls: e.calls, toQualify: e.callsToQualify });
      }
      setEmerging(em);
      setCallLedger(led || null);
    });
    return () => { cancel = true; };
  }, []);

  // Re-rank: VERIFIED CALLERS (public-price graded) float to the top by graded
  // score; everyone else falls back to on-chain Rep Score, then JS score.
  const sortedBoard = useMemo(() => {
    return [...board]
      .map((trader) => {
        const g = graded.get(trader.wallet.toLowerCase()) || null;
        const oc = onChainStats.get(trader.wallet.toLowerCase());
        if (!oc) return { ...trader, onChainRepScore: null as number | null, graded: g };
        const closed = oc.wins + oc.losses;
        return {
          ...trader,
          wins: oc.wins,
          losses: oc.losses,
          active: oc.active,
          avgRR: oc.avgRR,
          winRate: closed > 0 ? (oc.wins / closed) * 100 : 0,
          onChainRepScore: oc.repScore,
          graded: g,
        };
      })
      .sort((a, b) => {
        // Verified callers first, ranked by trustless graded score.
        if (a.graded && b.graded) return b.graded.score - a.graded.score;
        if (a.graded && !b.graded) return -1;
        if (!a.graded && b.graded) return 1;
        const aRep = a.onChainRepScore ?? calcRepScore(a.wins, a.losses, a.avgRR);
        const bRep = b.onChainRepScore ?? calcRepScore(b.wins, b.losses, b.avgRR);
        if (bRep !== aRep) return bRep - aRep;
        return b.total - a.total;
      });
  }, [board, onChainStats, graded]);

  if (board.length === 0) {
    return <FeedEmptyState variant="ranks" />;
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, paddingLeft: 2 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: onChainLoading ? "#fbbf24" : graded.size > 0 ? "#ededf0" : emerging.size > 0 ? "#fbbf24" : onChainStats.size > 0 ? "#ededf0" : "#52525b" }} />
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>
          {graded.size > 0 ? `✓ ${graded.size} VERIFIED CALLER${graded.size !== 1 ? "S" : ""} · graded from public price` : emerging.size > 0 ? `◆ ${emerging.size} EMERGING CALLER${emerging.size !== 1 ? "S" : ""} · building toward verification (5 graded calls)` : onChainLoading ? "VERIFYING ON-CHAIN STATS..." : onChainStats.size > 0 ? `⛓ ${onChainStats.size} TRADER${onChainStats.size !== 1 ? "S" : ""} VERIFIED ON-CHAIN` : "RANKED BY KV DATA"}
        </span>
      </div>
      {callLedger?.ledgerHash && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10, paddingLeft: 2 }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#ededf0" }}>🔗 CALL LEDGER</span>
          <code style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#a1a1aa", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3, padding: "2px 6px" }}>
            {callLedger.ledgerHash.slice(0, 10)}…{callLedger.ledgerHash.slice(-8)}
          </code>
          <a href={`${API_BASE}/theses/ledger`} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#d4d4d8", textDecoration: "none" }}>verify ↗</a>
          {callLedger.onChain?.verified && (
            <a href={callLedger.onChain.explorer || "#"} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#ededf0", textDecoration: "none", border: "1px solid #33333a", borderRadius: 3, padding: "2px 6px", background: "#1a1a1e" }}>⛓ ANCHORED ON-CHAIN ↗</a>
          )}
        </div>
      )}
    {copyMsg && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#ededf0", marginBottom: 8, paddingLeft: 2 }}>⚡ {copyMsg}</div>}
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {sortedBoard.map((trader, i) => {
        const rank = i + 1;
        const isOnChainVerified = onChainStats.has(trader.wallet.toLowerCase());
        const closed = trader.wins + trader.losses;
        const shortAddr = `${trader.wallet.slice(0, 6)}…${trader.wallet.slice(-4)}`;
        const isExpanded = expandedWallet === trader.wallet.toLowerCase();
        const traderTheses = feed.filter(t => t.wallet.toLowerCase() === trader.wallet.toLowerCase());
        const isOwn = walletAddress?.toLowerCase() === trader.wallet.toLowerCase();

        return (
          <div key={trader.wallet} style={{
            background: "#141416",
            border: `1px solid ${rank === 1 ? "#33333a" : "#232327"}`,
            borderRadius: 4,
            overflow: "hidden",
          }}>
            {/* Trader row */}
            <div
              onClick={() => setExpandedWallet(isExpanded ? null : trader.wallet.toLowerCase())}
              style={{ padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, overflowX: "auto" }}
            >
              {/* Rank */}
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: RANK_MEDALS[rank] ? 16 : 12, minWidth: 28, flexShrink: 0, textAlign: "center", color: "#52525b" }}>
                {RANK_MEDALS[rank] ?? `#${rank}`}
              </div>

              {/* Avatar */}
              <Avatar pfp={trader.pfp} displayName={trader.displayName} size={32} />

              {/* Identity */}
              <div style={{ flexGrow: 1, flexShrink: 0, flexBasis: 150, minWidth: 150, maxWidth: 280 }}>
                {/* Name line — name truncates with ellipsis, YOU stays put */}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {trader.displayName ?? shortAddr}
                  </span>
                  {isOwn && <span style={{ color: "#ededf0", fontSize: 9, flexShrink: 0 }}>YOU</span>}
                </div>
                {/* Badge line — never clipped, wraps if needed */}
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                  {trader.graded && <span title="Calls graded from public price — trustless" style={{ fontSize: 8, color: "#ededf0", border: "1px solid #33333a", borderRadius: 2, padding: "1px 4px", background: "#1a1a1e" }}>✓ VERIFIED</span>}
                  {trader.graded?.meritRank && <span title={`${trader.graded.meritRank.title} — merit rank earned from your graded calls (not bought)`} style={{ fontSize: 8, color: "#141416", fontWeight: "bold", border: "1px solid #ededf0", borderRadius: 2, padding: "1px 5px", background: "#ededf0", letterSpacing: "0.04em" }}>{trader.graded.meritRank.glyph} {trader.graded.meritRank.title.toUpperCase()}</span>}
                  {/* CALIBRATED — earned: their bigger-conviction calls genuinely
                      did better. Sizing skill, invisible in hit rate or P&L. */}
                  {trader.graded?.calibration?.calibrated && <span title={`Calibrated — higher-conviction calls average +${trader.graded.calibration.gap}R more than smaller ones. Sizes up on the right ideas.`} style={{ fontSize: 8, color: "#3ecf8e", border: "1px solid #33333a", borderRadius: 2, padding: "1px 4px", background: "#1a1a1e" }}>◎ CALIBRATED</span>}
                  {!trader.graded && emerging.has(trader.wallet.toLowerCase()) && (
                    <span title="Resolved public-price-graded calls — 5 needed to become a Verified Caller" style={{ fontSize: 8, color: "#fbbf24", border: "1px solid #4a3a00", borderRadius: 2, padding: "1px 4px", background: "#2a1a00" }}>
                      ◆ EMERGING · {emerging.get(trader.wallet.toLowerCase())!.toQualify} to verify
                    </span>
                  )}
                  {/* PLAN — process alongside outcome. Were the calls well-formed
                      when posted (obtainable entry, real stop, honest R:R)? Scored
                      from the same public candles as the grade, so it's verifiable
                      by anyone. Amber below 70 = caution, never decoration. */}
                  {trader.graded?.discipline && (
                    <span
                      title={`Plan quality ${trader.graded.discipline.score}/100 across ${trader.graded.discipline.scored} calls — scored at post time from public price: obtainable entry, a stop outside the noise, R:R matching the posted levels. Reported, not ranked on.`}
                      style={{ fontSize: 8, color: trader.graded.discipline.score >= 70 ? "#a1a1aa" : "#fbbf24", border: `1px solid ${trader.graded.discipline.score >= 70 ? "#33333a" : "#4a3a00"}`, borderRadius: 2, padding: "1px 4px", background: trader.graded.discipline.score >= 70 ? "#1a1a1e" : "#2a1a00" }}
                    >
                      PLAN {trader.graded.discipline.score}
                    </span>
                  )}
                  {/* ⚡ FADER — proven right against the crowd. Shown only when their
                      contrarian avg-R is net-positive (the meaningful signal); the
                      record is graded from stance snapshots joined at post time. */}
                  {trader.graded?.contrarian && trader.graded.contrarian.avgR > 0 && (
                    <span
                      title={`Right when fading the crowd: +${trader.graded.contrarian.avgR}R avg over ${trader.graded.contrarian.calls} contrarian calls (made against the consensus lean that preceded them), ${trader.graded.contrarian.edge >= 0 ? "+" : ""}${trader.graded.contrarian.edge}R better than their with-crowd calls.`}
                      style={{ fontSize: 8, color: "#3ecf8e", border: "1px solid #33333a", borderRadius: 2, padding: "1px 4px", background: "#1a1a1e", letterSpacing: "0.04em" }}
                    >
                      &#9889; FADER +{trader.graded.contrarian.avgR}R
                    </span>
                  )}
                  <NexusTierBadge address={trader.wallet} />
                </div>
                {trader.graded ? (
                  <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", marginTop: 2 }}>
                    {trader.graded.hitRate.toFixed(0)}% hit · {trader.graded.avgR > 0 ? "+" : ""}{trader.graded.avgR.toFixed(2)}R · {trader.graded.calls} graded calls
                    {trader.graded.regimeEdge && (
                      <span title="The market this caller's graded record is actually strongest in — classified from the candles before each call.">
                        {" "}· best in {REGIME_LABEL[trader.graded.regimeEdge.best.bucket] ?? trader.graded.regimeEdge.best.bucket}
                      </span>
                    )}
                  </div>
                ) : (
                  <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 2 }}>{shortAddr}</div>
                )}
              </div>

              {/* Cumulative-R equity curve — the trustless track record as a shape,
                  not just a number. Only for graded callers with ≥2 resolved calls. */}
              {trader.graded && trader.graded.rSeries.length >= 2 && (
                <div style={{ flex: "1 1 72px", minWidth: 72, textAlign: "center" }}>
                  <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginBottom: 2 }}>R CURVE</div>
                  <Sparkline points={trader.graded.rSeries} width={72} height={22} />
                </div>
              )}

              {/* Win rate — hero stat */}
              <div style={{ textAlign: "center", flex: "1 1 60px", minWidth: 60 }}>
                <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>WIN RATE</div>
                <div style={{
                  fontFamily: "var(--nx-font-mono)", fontSize: 16, fontWeight: "bold",
                  color: closed === 0 ? "#52525b" : trader.winRate >= 60 ? "#3ecf8e" : trader.winRate >= 40 ? "#fbbf24" : "#f7525f",
                }}>
                  {closed === 0 ? "—" : `${trader.winRate.toFixed(0)}%`}
                </div>
              </div>

              {/* W / L */}
              <div style={{ textAlign: "center", flex: "1 1 44px", minWidth: 44 }}>
                <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>W / L</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>
                  <span style={{ color: "#ededf0" }}>{trader.wins}</span>
                  <span style={{ color: "#52525b" }}> / </span>
                  <span style={{ color: "#f7525f" }}>{trader.losses}</span>
                </div>
              </div>

              {/* Avg R:R */}
              <div style={{ textAlign: "center", flex: "1 1 50px", minWidth: 50 }}>
                <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>AVG R:R</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: trader.avgRR >= 2 ? "#ededf0" : "#fbbf24" }}>
                  1:{trader.avgRR.toFixed(1)}
                </div>
              </div>

              {/* Active */}
              <div style={{ textAlign: "center", flex: "1 1 40px", minWidth: 40 }}>
                <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>ACTIVE</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: trader.active > 0 ? "#d4d4d8" : "#52525b" }}>
                  {trader.active}
                </div>
              </div>

              {/* Rep Score — Ph26: on-chain value when available */}
              {(() => {
                const onChain = (trader as typeof trader & { onChainRepScore?: number | null }).onChainRepScore;
                const rep = onChain ?? calcRepScore(trader.wins, trader.losses, trader.avgRR);
                const isOnChain = onChain != null;
                return (
                  <div style={{ textAlign: "center", flex: "1 1 44px", minWidth: 44 }}>
                    <div style={{ fontSize: 8, color: isOnChain ? "#ededf0" : "#52525b", fontFamily: "var(--nx-font-mono)" }}>
                      {isOnChain ? "⛓REP" : "REP"}
                    </div>
                    <div style={{
                      fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: "bold",
                      color: closed === 0 ? "#52525b" : rep >= 70 ? "#3ecf8e" : rep >= 40 ? "#fbbf24" : "#f7525f",
                    }}>
                      {closed === 0 ? "—" : rep}
                    </div>
                  </div>
                );
              })()}

              {/* ⚡ Autocopy this caller — your agent mirrors their next public call */}
              {walletAddress && !isOwn && (
                <button
                  onClick={(e) => { e.stopPropagation(); toggleCopyCaller(trader.wallet); }}
                  disabled={copyBusy === trader.wallet.toLowerCase()}
                  title="Your agent mirrors this caller's next public call — at your own size, mode & guardrails"
                  style={{
                    flexShrink: 0, fontFamily: "var(--nx-font-mono)", fontSize: 9, fontWeight: 600, letterSpacing: "0.03em",
                    background: copyLeaders.has(trader.wallet.toLowerCase()) ? "#ededf0" : "#ededf015",
                    color: copyLeaders.has(trader.wallet.toLowerCase()) ? "#0a0a0b" : "#ededf0",
                    border: "1px solid #ededf0", borderRadius: 4, padding: "6px 9px", cursor: "pointer", whiteSpace: "nowrap",
                  }}
                >
                  {copyLeaders.has(trader.wallet.toLowerCase()) ? "⚡ COPYING" : "⚡ AUTOCOPY"}
                </button>
              )}

              {/* Expand chevron */}
              <div style={{ color: "#33333a", fontSize: 10, fontFamily: "var(--nx-font-mono)", flexShrink: 0, paddingLeft: 4 }}>
                {isExpanded ? "▲" : "▼"}
              </div>
            </div>

            {/* Expanded: trader's theses */}
            {isExpanded && (
              <div style={{ borderTop: "1px solid #232327", padding: "10px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Profile link */}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 4 }}>
                  {/* Message this caller — wrapped so it doesn't toggle the row */}
                  <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}>
                    <MessageTraderButton wallet={trader.wallet} myWallet={walletAddress} variant="icon" />
                  </span>
                  {/* Verify the caller's real venue record before copying them. */}
                  <a
                    href={`/analyze?address=${trader.wallet}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="X-ray this wallet's actual perp record on Hyperliquid + Orderly"
                    className="nx-btn nx-btn-icon"
                    style={{ textDecoration: "none" }}
                  >
                    ⌕ X-RAY ↗
                  </a>
                  <button
                    className="nx-btn nx-btn-icon"
                    onClick={(e) => { e.stopPropagation(); navigate(`/feed/trader/${trader.wallet}`); }}
                  >
                    VIEW PROFILE →
                  </button>
                </div>
                {traderTheses.length === 0 ? (
                  <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#33333a" }}>no theses</div>
                ) : traderTheses.map((t) => {
                  const cfg = STATUS_CONFIG[effectiveStatus(t)] ?? STATUS_CONFIG.ACTIVE;
                  const ticker = t.symbol.replace("PERP_", "").replace("_USDC", "");
                  return (
                    <div key={t.id} style={{
                      background: "#0f0f11", border: `1px solid ${cfg.border}`,
                      borderRadius: 3, padding: "10px 12px",
                      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                    }}>
                      <div style={{ flex: 1, minWidth: 120 }}>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, marginLeft: 8, color: t.direction === "LONG" ? "#3ecf8e" : "#f7525f" }}>
                          {t.direction === "LONG" ? "↑" : "↓"} {t.direction}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 16 }}>
                        {[
                          { label: "ENTRY", val: `$${t.entryPrice.toFixed(2)}`, color: "#a1a1aa" },
                          { label: "R:R",   val: `1:${t.riskReward.toFixed(2)}`, color: t.riskReward >= 2 ? "#ededf0" : "#fbbf24" },
                        ].map(({ label, val, color }) => (
                          <div key={label}>
                            <div style={{ fontSize: 7, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{label}</div>
                            <div style={{ fontSize: 11, color, fontFamily: "var(--nx-font-mono)" }}>{val}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{
                        fontFamily: "var(--nx-font-mono)", fontSize: 8, padding: "2px 6px",
                        borderRadius: 2, background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
                      }}>{cfg.label}</div>
                      {walletAddress && !isOwn && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onCopy(t); }}
                          style={{
                            background: "none", border: "1px solid #232327", borderRadius: 3,
                            color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 8,
                            padding: "2px 6px", cursor: "pointer",
                          }}
                        >COPY</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
    </>
  );
}

// ─── Cold-start empty state ──────────────────────────────────────────────────
// A recruit landing on an empty feed should see an invitation, not a dead app.
function FeedEmptyState({ variant }: { variant: "feed" | "ranks" }) {
  const navigate = useNavigate();
  const isRanks = variant === "ranks";
  const steps = [
    { n: "01", title: "Plan a thesis", desc: "Size a trade in the Nexus Thesis Engine — entry, stop, targets, R:R." },
    { n: "02", title: "Publish it", desc: "Hit 📡 to push it live here, registered on-chain." },
    { n: "03", title: "Build your rep", desc: "Others follow, copy, and grade it — your track record compounds." },
  ];
  return (
    <div style={{ textAlign: "center", padding: "48px 16px", maxWidth: 620, margin: "0 auto" }}>
      <div style={{ fontSize: 30, color: "#ededf0", marginBottom: 12, textShadow: "0 0 16px rgba(237,237,240,0.4)" }}>
        {isRanks ? "◆" : "⬡"}
      </div>
      <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 20, color: "#fff", fontWeight: "bold", marginBottom: 8, letterSpacing: "0.02em" }}>
        {isRanks ? "The leaderboard is wide open." : "The signal starts here."}
      </div>
      <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12, color: "#a1a1aa", lineHeight: 1.6, marginBottom: 26 }}>
        {isRanks
          ? "No traders ranked yet — rankings build as theses get published and closed out. Publish yours and claim rank #1."
          : "No public theses yet. Publish one from your Lab and it lands in the live feed — others can follow, copy, and grade it. Be the first signal."}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 26, textAlign: "left" }}>
        {steps.map((s) => (
          <div key={s.n} style={{ background: "#0a0a0b", border: "1px solid #232327", borderRadius: 4, padding: "12px 14px" }}>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#ededf0", marginBottom: 6 }}>{s.n}</div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#fff", fontWeight: "bold", marginBottom: 4 }}>{s.title}</div>
            <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 10, color: "#52525b", lineHeight: 1.5 }}>{s.desc}</div>
          </div>
        ))}
      </div>
      <button
        onClick={() => navigate("/lab")}
        style={{
          background: "#ededf015", border: "1px solid #ededf0", borderRadius: 4,
          color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: "bold",
          padding: "10px 22px", cursor: "pointer", letterSpacing: "0.05em",
        }}
      >
        → OPEN THE LAB &amp; PUBLISH
      </button>
    </div>
  );
}

// ─── Thin-feed contribute prompt ─────────────────────────────────────────────
// Shown when the feed has a few theses but is still sparse — converts "looks
// quiet" into "be one of the first" instead of letting a recruit bounce.
function ContributePrompt({ prominent = false }: { prominent?: boolean }) {
  const navigate = useNavigate();
  return (
    <div style={{
      background: "linear-gradient(180deg,#1a1a1e,#0a0a0b)", border: `1px solid ${prominent ? "#ededf0" : "#33333a"}`,
      borderRadius: 6, padding: prominent ? "18px 20px" : "16px 18px", display: "flex", alignItems: "center",
      gap: 14, flexWrap: "wrap", marginBottom: prominent ? 12 : 0, marginTop: prominent ? 0 : 4,
      boxShadow: prominent ? "0 0 0 1px #ededf030, 0 8px 24px -12px #ededf040" : undefined,
    }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: prominent ? 14 : 12, color: "#ededf0", fontWeight: "bold", marginBottom: 4 }}>
          {prominent ? "📡 Be the first verified caller on Nexus" : "📡 The feed's still early — claim your spot"}
        </div>
        <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: prominent ? 11 : 10, color: "#a1a1aa", lineHeight: 1.6 }}>
          {prominent
            ? "Post a call (symbol · direction · entry/stop/target) — it's graded against public price on-chain, not self-reported. 5 graded calls = Verified Caller. Get in before the board fills up."
            : "Publish a thesis and it's graded against public price, on-chain. Early callers build rep fastest — get to 5 graded calls and you're a Verified Caller."}
        </div>
      </div>
      <button
        onClick={() => navigate("/lab?tab=thesis")}
        style={{
          background: prominent ? "#ededf0" : "#ededf015", border: "1px solid #ededf0", borderRadius: 4,
          color: prominent ? "#141416" : "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold",
          padding: prominent ? "11px 18px" : "9px 16px", cursor: "pointer", letterSpacing: "0.05em", flexShrink: 0,
        }}
      >
        → POST YOUR FIRST CALL
      </button>
    </div>
  );
}

// ─── Autonomous agent track-record card ──────────────────────────────────────
// Surfaces the bot's REAL, trustless-anchored closed-trade history as social
// proof on the default feed — "this platform runs a working autonomous agent".
function AgentTrackRecord() {
  const navigate = useNavigate();
  const [s, setS] = useState<{ trades: number; winRate: number; net: number; anchored: boolean } | null>(null);
  useEffect(() => {
    let cancel = false;
    fetch(`${API_BASE}/agents/ledger`).then((r) => r.json()).then((d) => {
      if (cancel) return;
      const recs: { pnl?: number }[] = d?.records || [];
      if (!recs.length) return;
      const wins = recs.filter((r) => Number(r.pnl) > 0).length;
      const net = recs.reduce((a, r) => a + Number(r.pnl || 0), 0);
      setS({ trades: recs.length, winRate: Math.round((wins / recs.length) * 100), net, anchored: !!d?.onChain?.verified });
    }).catch(() => {});
    return () => { cancel = true; };
  }, []);
  if (!s) return null;
  return (
    <div
      onClick={() => navigate("/lab?tab=agent")}
      style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", padding: "12px 16px", background: "linear-gradient(180deg,#141416,#0a0a0b)", border: "1px solid #33333a", borderRadius: 6, marginBottom: 14 }}
    >
      <div style={{ flexShrink: 0 }}>
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", fontWeight: "bold" }}>🤖 NEXUS AUTONOMOUS AGENT</div>
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8.5, color: "#71717a", marginTop: 2 }}>
          {s.anchored ? "⛓ trustless · on-chain-anchored track record" : "trustless · publicly graded track record"}
        </div>
      </div>
      <div style={{ display: "flex", gap: 16, marginLeft: "auto", flexWrap: "wrap" }}>
        {[
          { label: "TRADES", val: String(s.trades), color: "#fff" },
          { label: "WIN RATE", val: `${s.winRate}%`, color: s.winRate >= 50 ? "#ededf0" : "#fbbf24" },
          { label: "NET P&L", val: `${s.net >= 0 ? "+" : "-"}$${Math.abs(s.net).toFixed(2)}`, color: s.net >= 0 ? "#3ecf8e" : "#f7525f" },
        ].map((x) => (
          <div key={x.label} style={{ textAlign: "right", lineHeight: 1.25 }}>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 14, fontWeight: "bold", color: x.color }}>{x.val}</div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 7.5, color: "#52525b", letterSpacing: "0.06em" }}>{x.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Live pulse strip ────────────────────────────────────────────────────────
// At-a-glance activity so even a thin feed reads as a living system, not a ghost
// town. Derived entirely from the already-loaded feed — no extra fetch.
function FeedPulse({ feed }: { feed: FeedThesis[] }) {
  if (feed.length === 0) return null;
  const callers = new Set(feed.filter((t) => !t.agent).map((t) => t.wallet.toLowerCase())).size;
  // "Live" = open AND not yet price-graded. A call whose price already touched TP/SL is
  // decided even if the author never manually flipped its status, so it belongs in
  // GRADED, not LIVE — otherwise the same call is counted in both.
  const live = feed.filter((t) => t.status === "ACTIVE" && t.gradedOutcome !== "WIN" && t.gradedOutcome !== "LOSS").length;
  // ⚠️ GRADED, not self-reported. The old counter tallied HIT_TP/STOPPED_OUT — statuses
  // the author sets by hand — and displayed a big number of exactly the thing the moat
  // says not to trust (11 self-reported while only 3 were price-graded). Count the
  // trustless gradedOutcome so this agrees with the leaderboard's "graded call" language.
  const graded = feed.filter((t) => t.gradedOutcome === "WIN" || t.gradedOutcome === "LOSS").length;
  const agents = feed.filter((t) => t.agent).length;
  const newest = Math.max(...feed.map((t) => t.createdAt || 0));
  const ageStr = (() => {
    const d = Date.now() - newest, h = Math.floor(d / 3600000), dd = Math.floor(h / 24);
    if (dd > 0) return `${dd}d ago`;
    if (h > 0) return `${h}h ago`;
    const m = Math.floor(d / 60000);
    return m > 0 ? `${m}m ago` : "just now";
  })();
  const stats: { label: string; val: string; color?: string }[] = [
    { label: "CALLERS", val: String(callers) },
    { label: "PUBLIC CALLS", val: String(feed.length) },
    { label: "LIVE", val: String(live), color: "#d4d4d8" },
    { label: "GRADED", val: String(graded) },
    ...(agents > 0 ? [{ label: "🤖 AGENT", val: String(agents), color: "#ededf0" }] : []),
    { label: "LAST CALL", val: ageStr },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", padding: "10px 14px", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 6, marginBottom: 14 }}>
      <style>{`@keyframes feedPulse{0%,100%{opacity:1;box-shadow:0 0 8px #ededf0}50%{opacity:0.4;box-shadow:0 0 2px #ededf0}}`}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#ededf0", animation: "feedPulse 2s infinite" }} />
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#ededf0", fontWeight: "bold", letterSpacing: "0.1em" }}>LIVE</span>
      </div>
      {stats.map((s) => (
        <div key={s.label} style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: "bold", color: s.color || "#fff" }}>{s.val}</span>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 7.5, color: "#52525b", letterSpacing: "0.06em" }}>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Feed Page ───────────────────────────────────────────────────────────────
type FilterStatus = "ALL" | "ACTIVE" | "HIT_TP" | "STOPPED_OUT" | "INVALIDATED";
type DirFilter = "ALL" | "LONG" | "SHORT";

export default function FeedPage() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [feed, setFeed] = useState<FeedThesis[]>([]);
  // Resolution events ride in the same /feed payload but are NOT thesis-shaped — they
  // carry no levels or status. Split out so FeedCard never sees one and so they can't
  // skew the trader/thesis counts derived from `feed`.
  const [resolutions, setResolutions] = useState<ResolutionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<FilterStatus>("ALL");
  // Ph23: direction filter
  const [dirFilter, setDirFilter] = useState<DirFilter>("ALL");
  const [search, setSearch] = useState("");
  // Two full rows of chips pushed the actual feed below the fold and read as noise.
  // Collapsed by default; the trigger carries a summary so an active filter is still
  // obvious while hidden.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [copyTarget, setCopyTarget] = useState<FeedThesis | null>(null);
  const [view, setView] = useState<"feed" | "ranks" | "following">("feed");
  const [sortMode, setSortMode] = useState<"latest" | "trending">("latest");
  // Ph19: on-chain trader count (trustless roster from ThesisRegistered logs)
  const [onChainCount, setOnChainCount] = useState<number | null>(null);
  // Ph24: follow graph
  const [following, setFollowing] = useState<Set<string>>(new Set());

  // Get connected wallet address
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;

  // Ph19: fetch on-chain wallet roster in parallel with feed
  useEffect(() => {
    fetch(`${API_BASE}/wallets/onchain`)
      .then((r) => r.json())
      .then((data: { wallets?: string[] }) => {
        setOnChainCount((data.wallets ?? []).length);
      })
      .catch(() => {});
  }, []);

  // Ph24: load follow graph when wallet connects
  useEffect(() => {
    if (!walletAddress) { setFollowing(new Set()); return; }
    fetch(`${API_BASE}/follows/${walletAddress}`)
      .then((r) => r.json())
      .then((data: { following?: string[] }) => {
        setFollowing(new Set((data.following ?? []).map((a: string) => a.toLowerCase())));
      })
      .catch(() => {});
  }, [walletAddress]);

  // Ph24: follow/unfollow handler
  async function handleFollowToggle(targetWallet: string) {
    if (!walletAddress) return;
    const lower = targetWallet.toLowerCase();
    const next = new Set(following);
    if (next.has(lower)) next.delete(lower);
    else next.add(lower);
    setFollowing(next);
    // persist
    try {
      await fetch(`${API_BASE}/follows/${walletAddress}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ following: [...next] }),
      });
    } catch { /* revert on failure would be nice but not critical */ }
  }

  useEffect(() => {
    setLoading(true);
    setError(false);
    fetch(`${API_BASE}/feed`)
      .then((r) => r.json())
      .then((data: { feed: (FeedThesis & { resolution?: boolean })[] }) => {
        const all = data.feed ?? [];
        setFeed(all.filter((t) => !t.resolution) as FeedThesis[]);
        setResolutions(all.filter((t) => t.resolution) as unknown as ResolutionEvent[]);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  // Live prices for all active feed theses
  const activeSymbols = useMemo(
    () => [...new Set(feed.filter((t) => t.status === "ACTIVE").map((t) => t.symbol))],
    [feed]
  );
  const livePrices = useLivePrices(activeSymbols);

  // Ph24: following feed is the full feed filtered to followed wallets
  const followingFeed = feed.filter((t) => following.has(t.wallet.toLowerCase()));

  const baseForFilter = view === "following" ? followingFeed : feed;
  const filtered = baseForFilter.filter((t) => {
    if (filter !== "ALL" && t.status !== filter) return false;
    if (dirFilter !== "ALL" && t.direction !== dirFilter) return false; // Ph23
    if (search) {
      const q = search.toLowerCase();
      const ticker = t.symbol.replace("PERP_", "").replace("_USDC", "").toLowerCase();
      const name = (t.displayName ?? "").toLowerCase();
      const addr = t.wallet.toLowerCase();
      if (!ticker.includes(q) && !name.includes(q) && !addr.includes(q)) return false;
    }
    return true;
  });

  const sortedFiltered = sortMode === "trending"
    ? [...filtered].sort((a, b) => {
        const diff = (b.copyCount ?? 0) - (a.copyCount ?? 0);
        return diff !== 0 ? diff : b.createdAt - a.createdAt;
      })
    : [...filtered].sort((a, b) => b.createdAt - a.createdAt);

  const navBtnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? "#1a1a1e" : "none",
    border: `1px solid ${active ? "#ededf0" : "#232327"}`,
    color: active ? "#ededf0" : "#71717a",
    fontFamily: "var(--nx-font-mono)",
    fontSize: 10,
    padding: "5px 10px",
    cursor: "pointer",
    borderRadius: 3,
    letterSpacing: "0.05em",
  });

  // ⚠️ On DESKTOP the $NEXUS/treasury strip leads; on MOBILE it ate the entire first
  // screen and buried the calls (same problem the Lab had — promo chrome above the
  // fold). Rendered once, placed differently per breakpoint: top on desktop, foot on
  // mobile so the feed content leads.
  const flywheel = (
    <div style={{ padding: isMobile ? "10px 12px" : "10px 16px", maxWidth: 860, margin: "0 auto", width: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 8 }}>
      <NexusMarket />
      <NexusTreasuryStack />
    </div>
  );

  // Editorial header — same signature system as Proof / Arena / the x-ray (mono
  // eyebrow → serif headline → fading bone rule). The eyebrow is stable brand;
  // the headline tracks the active view so the page reads as one place.
  const feedHead = {
    feed:      { eyebrow: "// THE FEED", title: "Every call, graded by the tape" },
    ranks:     { eyebrow: "// THE FEED", title: "Verified callers, ranked" },
    following: { eyebrow: "// THE FEED", title: "Traders you follow" },
  }[view];

  return (
    <div style={{ background: "#0a0a0b", minHeight: "100svh", padding: 0 }}>
      {/* Copy modal */}
      {copyTarget && walletAddress && (
        <CopyModal
          thesis={copyTarget}
          walletAddress={walletAddress}
          onClose={() => setCopyTarget(null)}
        />
      )}

      {/* Editorial header — leads the page; tabs below act as sub-nav. */}
      <div style={{ maxWidth: 860, margin: "0 auto", padding: isMobile ? "18px 16px 2px" : "26px 16px 4px" }}>
        <SectionHeader eyebrow={feedHead.eyebrow} title={feedHead.title} />
      </div>

      {/* Tab bar / header */}
      <div style={{ display: "flex", gap: 8, padding: "8px 16px", borderBottom: "1px solid #232327", background: "#0f0f11", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", rowGap: 8 }}>
        <div style={{ display: "flex", gap: isMobile ? 4 : 6, flexWrap: isMobile ? "nowrap" : "wrap", rowGap: 6, width: isMobile ? "100%" : undefined }}>
          <button
            onClick={() => setView("feed")}
            style={{
              background: view === "feed" ? "#1a1a1e" : "none",
              border: `1px solid ${view === "feed" ? "#ededf0" : "#232327"}`,
              color: view === "feed" ? "#ededf0" : "#71717a",
              fontFamily: "var(--nx-font-mono)", fontSize: 10,
              padding: isMobile ? "6px 4px" : "4px 10px", cursor: "pointer", borderRadius: 3, letterSpacing: "0.08em",
              flex: isMobile ? 1 : undefined, textAlign: "center",
            }}
          >{isMobile ? "FEED" : "■ FEED"}</button>
          <button
            onClick={() => setView("ranks")}
            style={{
              background: view === "ranks" ? "#1a1a1e" : "none",
              border: `1px solid ${view === "ranks" ? "#ededf0" : "#232327"}`,
              color: view === "ranks" ? "#ededf0" : "#71717a",
              fontFamily: "var(--nx-font-mono)", fontSize: 10,
              padding: isMobile ? "6px 4px" : "4px 10px", cursor: "pointer", borderRadius: 3, letterSpacing: "0.08em",
              flex: isMobile ? 1 : undefined, textAlign: "center",
            }}
          >{isMobile ? "RANKS" : "◆ RANKS"}</button>
          {/* Ph24: following tab — only when connected */}
          {walletAddress && (
            <button
              onClick={() => setView("following")}
              style={{
                background: view === "following" ? "#1a1a1e" : "none",
                border: `1px solid ${view === "following" ? "#d4d4d8" : "#232327"}`,
                color: view === "following" ? "#d4d4d8" : "#71717a",
                fontFamily: "var(--nx-font-mono)", fontSize: 10,
                padding: isMobile ? "6px 4px" : "4px 10px", cursor: "pointer", borderRadius: 3, letterSpacing: "0.08em",
                flex: isMobile ? 1 : undefined, textAlign: "center",
              }}
            >{isMobile ? "FOLLOW" : "◈ FOLLOWING"}{following.size > 0 ? ` (${following.size})` : ""}</button>
          )}
          {view !== "ranks" && (
            <>
              <div style={{ width: 1, height: 18, background: "#232327", alignSelf: "center", display: isMobile ? "none" : "block" }} />
              {(["latest", "trending"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setSortMode(mode)}
                  style={{
                    background: sortMode === mode ? "#1a1a1e" : "none",
                    border: `1px solid ${sortMode === mode ? "#ededf0" : "#232327"}`,
                    color: sortMode === mode ? "#ededf0" : "#71717a",
                    fontFamily: "var(--nx-font-mono)", fontSize: 10,
                    padding: isMobile ? "6px 4px" : "4px 10px", cursor: "pointer", borderRadius: 3, letterSpacing: "0.08em",
                    flex: isMobile ? 1 : undefined, textAlign: "center",
                  }}
                >
                  {mode === "latest" ? "LATEST" : "TRENDING"}
                </button>
              ))}
            </>
          )}
        </div>
        <div style={{ display: isMobile ? "none" : "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <div style={{ fontSize: 9, fontFamily: "var(--nx-font-mono)", color: "#52525b" }}>
            {loading ? "loading..." : view === "ranks"
              ? `${feed.length > 0 ? [...new Set(feed.map(t => t.wallet.toLowerCase()))].length : 0} trader${[...new Set(feed.map(t => t.wallet.toLowerCase()))].length !== 1 ? "s" : ""}`
              : `${filtered.length} thesis${filtered.length !== 1 ? "es" : ""}`}
          </div>
          {/* Ph19: on-chain trader count from ThesisRegistered event log scan */}
          {onChainCount !== null && onChainCount > 0 && (
            <div style={{ fontSize: 8, fontFamily: "var(--nx-font-mono)", color: "#33333a" }}>
              ⛓ {onChainCount} on-chain
            </div>
          )}
          {!loading && view === "feed" && feed.length > 0 && (() => {
            const verifiedCount = feed.filter(t => t.onChainId !== undefined).length;
            if (verifiedCount === 0) return null;
            return (
              <div style={{ fontSize: 8, fontFamily: "var(--nx-font-mono)", color: "#33333a" }}>
                {verifiedCount}/{feed.length} theses verified
              </div>
            );
          })()}
        </div>
      </div>

      {/* $NEXUS flywheel — top on desktop, moved below the feed on mobile. */}
      {!isMobile && flywheel}

      <div className="nx-stagger" style={{ padding: 16, maxWidth: 860, margin: "0 auto" }}>

        {/* 👁 Watch-only framing for disconnected visitors (cold-start friction) */}
        {!walletAddress && <WatchOnlyBanner />}

        {/* ◆ LIVE NOW — open positions (agents + opted-in humans, live & verifiable) */}
        {view === "feed" && <LiveNow />}

        {/* Cold-start: when the feed is sparse, put the "post the first call" CTA up top
            so every visitor sees it immediately (not buried at the bottom). */}
        {view === "feed" && !loading && feed.length < 3 && <ContributePrompt prominent />}

        {/* ── FOLLOWING VIEW ── */}
        {view === "following" && (
          <>
            {following.size === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0" }}>
                <div style={{ fontSize: 20, color: "#33333a", marginBottom: 8 }}>◈</div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#33333a" }}>
                  not following anyone yet — hit + on a trader card to follow them
                </div>
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0" }}>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#33333a" }}>
                  no public theses from traders you follow
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {sortedFiltered.map((t) => (
                  <FeedCard
                    key={`${t.wallet}-${t.id}`}
                    thesis={t}
                    markPrice={livePrices[t.symbol] ?? null}
                    walletAddress={walletAddress}
                    onCopy={setCopyTarget}
                    following={following}
                    onFollowToggle={handleFollowToggle}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── RANKS VIEW ── */}
        {view === "ranks" && (
          <>
            {loading && (
              <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#33333a" }}>
                loading rankings...
              </div>
            )}
            {error && !loading && (
              <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#f7525f" }}>
                failed to load feed — check connection
              </div>
            )}
            {/* Bridge to the unified Proof hub — these boards are the social slice;
                /proof is every trustless record (callers, agents, arena, desks) under
                the on-chain ledger, in one place. */}
            {!loading && !error && (
              <div onClick={() => navigate("/proof")} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "#0f0f11", border: "1px solid #232327", borderLeft: "2px solid #ededf0", borderRadius: 6, padding: "10px 12px", marginBottom: 14, cursor: "pointer" }}>
                <span style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: 12, color: "#a1a1aa", lineHeight: 1.5 }}>
                  <b style={{ color: "#f4f4f5" }}>The Proof</b> — every track record on Nexus (callers, agents, Arena, desks) under the on-chain ledger, in one place.
                </span>
                <span style={{ flexShrink: 0, fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.06em", color: "#ededf0", background: "#1a1a1e", border: "1px solid #33333a", borderRadius: 4, padding: "5px 10px" }}>OPEN PROOF →</span>
              </div>
            )}
            {!loading && !error && <Contested />}
            {!loading && !error && <Contrarians />}
            {!loading && !error && (
              <LeaderboardView feed={feed} walletAddress={walletAddress} onCopy={setCopyTarget} />
            )}
            {!loading && !error && <Desks walletAddress={walletAddress} />}
            {!loading && !error && <ArenaStrip />}
            {!loading && !error && <LeakReport />}
          </>
        )}

        {/* ── FEED VIEW ── */}
        {view === "feed" && (
          <>
            {!loading && !error && <FeedPulse feed={feed} />}
            {/* AgentTrackRecord hidden: paper-strat backtest shows the live agent's
                edge is net-negative/breakeven — don't surface it as social proof
                until a proven edge returns. Component kept for easy re-enable. */}
            {/* Filters — one-click disclosure. Search stays visible (it's the most-used
                control); the chip rows hide until asked for. */}
            {(() => {
              const activeBits = [
                filter !== "ALL" ? STATUS_CONFIG[filter].label : null,
                dirFilter !== "ALL" ? dirFilter : null,
              ].filter(Boolean) as string[];
              return (
                <>
                  <div style={{ display: "flex", gap: 8, marginBottom: filtersOpen ? 8 : 16, flexWrap: "wrap", alignItems: "center" }}>
                    <button
                      onClick={() => setFiltersOpen((v) => !v)}
                      title={filtersOpen ? "Hide filters" : "Filter by status or direction"}
                      style={{ ...navBtnStyle(activeBits.length > 0 || filtersOpen), display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <span style={{ opacity: 0.7 }}>{filtersOpen ? "▾" : "▸"}</span>
                      FILTERS
                      {activeBits.length > 0 && (
                        <span style={{ color: "#ededf0" }}>· {activeBits.join(" · ")}</span>
                      )}
                    </button>
                    {activeBits.length > 0 && (
                      <button
                        onClick={() => { setFilter("ALL"); setDirFilter("ALL"); }}
                        title="Clear filters"
                        style={{ ...navBtnStyle(false), color: "#71717a" }}
                      >
                        ✕ CLEAR
                      </button>
                    )}
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="search symbol / trader..."
                      style={{
                        marginLeft: "auto",
                        background: "#0f0f11",
                        border: "1px solid #232327",
                        borderRadius: 3,
                        color: "#ededf0",
                        fontFamily: "var(--nx-font-mono)",
                        fontSize: 10,
                        padding: "5px 10px",
                        outline: "none",
                        width: 200,
                      }}
                    />
                  </div>
                  {filtersOpen && (
                    <div className="nx-fade-in" style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
                      {(["ALL", "ACTIVE", "HIT_TP", "STOPPED_OUT", "INVALIDATED"] as FilterStatus[]).map((f) => (
                        <button key={f} onClick={() => setFilter(f)} style={navBtnStyle(filter === f)}>
                          {f === "ALL" ? "ALL" : STATUS_CONFIG[f].label}
                        </button>
                      ))}
                      <div style={{ width: 1, height: 18, background: "#232327", margin: "0 2px" }} />
                      {(["ALL", "LONG", "SHORT"] as DirFilter[]).map((d) => (
                        <button
                          key={d}
                          onClick={() => setDirFilter(d)}
                          style={{
                            ...navBtnStyle(dirFilter === d),
                            color: dirFilter === d ? (d === "LONG" ? "#3ecf8e" : d === "SHORT" ? "#f7525f" : "#ededf0") : "#71717a",
                            borderColor: dirFilter === d ? (d === "LONG" ? "#3ecf8e" : d === "SHORT" ? "#f7525f" : "#ededf0") : "#232327",
                          }}
                        >
                          {d === "ALL" ? "L+S" : d === "LONG" ? "↑ LONG" : "↓ SHORT"}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}

            {loading && (
              <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#33333a" }}>
                loading feed...
              </div>
            )}

            {error && !loading && (
              <div style={{ textAlign: "center", padding: "60px 0", fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#f7525f" }}>
                failed to load feed — check connection
              </div>
            )}

            {!loading && !error && filtered.length === 0 && (
              feed.length === 0
                ? <FeedEmptyState variant="feed" />
                : (
                  <div style={{ textAlign: "center", padding: "60px 0" }}>
                    <div style={{ fontSize: 20, color: "#33333a", marginBottom: 8 }}>■</div>
                    <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#33333a" }}>
                      no results for this filter
                    </div>
                  </div>
                )
            )}

            {!loading && !error && <Resolved events={resolutions} />}

            {!loading && !error && filtered.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {sortedFiltered.map((t) => (
                  <FeedCard
                    key={`${t.wallet}-${t.id}`}
                    thesis={t}
                    markPrice={livePrices[t.symbol] ?? null}
                    walletAddress={walletAddress}
                    onCopy={setCopyTarget}
                    following={following}
                    onFollowToggle={handleFollowToggle}
                  />
                ))}
                {/* Thin feed → invite contribution instead of just trailing off.
                    (Skip when very sparse — the prominent top nudge already shows.) */}
                {feed.length >= 3 && feed.length < 12 && <ContributePrompt />}
              </div>
            )}
          </>
        )}
      </div>

      {/* Flywheel at the foot on mobile — the calls lead, the token chrome follows. */}
      {isMobile && flywheel}
    </div>
  );
}
