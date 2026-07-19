// Public "Wallet X-Ray" — paste any wallet, get its perp record. No login, no
// wallet connect. Acquisition wedge: grade a trader who's never touched our DEX.
//
// TWO SOURCES, DELIBERATELY DIFFERENT DEPTH:
//  • Hyperliquid — public /info `userFills` returns a per-TRADE tape, so we can
//    render the full <AnalyticsView> (hold time, timing, streaks, per-trade P&L).
//  • Orderly (incl. OUR venue) — the public dashboard indexer is keyed by
//    account_id and only exposes per-SYMBOL aggregates; /trades is hash-encoded
//    and /events_v2 is empty. So Orderly gets a venue/market breakdown, NOT the
//    per-trade analytics. Don't "upgrade" it to AnalyticsView — the data isn't there.
//
// ⚠️ This page deliberately uses NO Orderly private hooks — only public APIs and
// our own worker proxy. Keep it that way (see the SWR-key-collision incident).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { AnalyticsView } from "@/pages/lab/AnalyticsView";
import type { ProcessedTrade } from "@/pages/lab/types";
import { deployDirectiveFromThesis } from "@/utils/agentPrefill";
import { THESIS_DRAFT_KEY } from "@/config/assistantTools";

const GREEN = "#ededf0";
const mono = "var(--nx-font-mono)";
const AGENT_API = "https://og.nexustradinglabs.com";
const POS = "#3ecf8e", NEG = "#f7525f";

type XraySymbol = {
  sym: string; realized: number; unrealized: number;
  open: boolean; side: "LONG" | "SHORT" | null; szUsd: number; entry: number;
};
type XrayVenue = {
  brokerId: string; accountId: string; isNexus: boolean;
  realized: number; unrealized: number; markets: number; wins: number; losses: number;
  profitableMarketsPct: number; openPositions: number; bySymbol: XraySymbol[];
};
type XrayResult = {
  address: string; venues: XrayVenue[];
  totalRealized: number; totalUnrealized: number; markets: number; brokersChecked: number;
};

const usd = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(2);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Shared with the Lab's Smart Money watchlist, ON PURPOSE — starring a wallet
// here makes it show up (and alert) over there. Same key, one list.
const WATCH_KEY = "nexus_sm_watchlist";
const loadWatch = (): string[] => { try { return JSON.parse(localStorage.getItem(WATCH_KEY) || "[]"); } catch { return []; } };

// Orderly-network record for a wallet, across every broker we probe (ours first).
async function fetchOrderlyXray(address: string): Promise<XrayResult> {
  const res = await fetch(`${AGENT_API}/smart/xray?address=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`Orderly x-ray ${res.status}`);
  return res.json();
}

type HLFill = {
  coin: string; px: string; sz: string; side: string; time: number;
  dir: string; closedPnl: string; fee: string;
};

const isAddress = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(s.trim());

function fillsToTrades(fills: HLFill[]): ProcessedTrade[] {
  return fills
    .filter((f) => /^Close/.test(f.dir) || parseFloat(f.closedPnl || "0") !== 0)
    .map((f) => {
      const pnl = parseFloat(f.closedPnl || "0") - Math.abs(parseFloat(f.fee || "0"));
      const direction: "LONG" | "SHORT" = /Long/.test(f.dir) ? "LONG" : "SHORT";
      return {
        symbol: f.coin,
        direction,
        side: f.side,
        pnl,
        qty: parseFloat(f.sz || "0"),
        price: parseFloat(f.px || "0"),
        timestamp: f.time,
      } as ProcessedTrade;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchHLFills(address: string): Promise<HLFill[]> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "userFills", user: address.trim().toLowerCase() }),
  });
  if (!res.ok) throw new Error(`Hyperliquid API ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Unexpected response from Hyperliquid");
  return data as HLFill[];
}

export default function AnalyzePage() {
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get("address") ?? "");
  const [address, setAddress] = useState<string | null>(params.get("address"));
  const [trades, setTrades] = useState<ProcessedTrade[] | null>(null);
  const [orderly, setOrderly] = useState<XrayResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watch, setWatch] = useState<string[]>(loadWatch);
  const navigate = useNavigate();

  const toggleWatch = (addr: string) => {
    setWatch((prev) => {
      const next = prev.includes(addr) ? prev.filter((a) => a !== addr) : [...prev, addr];
      try { localStorage.setItem(WATCH_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // ⚡ Copy an OPEN position into an agent directive. Same bridge Smart Money uses,
  // so the agent honors the direction verbatim and manages the exit. Default stop
  // 3% / target 6% off the observed entry — the user reviews + edits before arming.
  const copyPosition = (s: XraySymbol, from: string) => {
    const p = s.entry > 0 ? s.entry : 0;
    const isLong = s.side === "LONG";
    deployDirectiveFromThesis({
      symbol: s.sym,
      direction: s.side === "SHORT" ? "SHORT" : "LONG",
      entryPrice: p,
      stopLoss: p > 0 ? (isLong ? p * 0.97 : p * 1.03) : 0,
      takeProfit1: p > 0 ? (isLong ? p * 1.06 : p * 0.94) : 0,
      source: `XRAY ${short(from)}`,
    }, navigate);
  };

  // ◆ Draft a thesis from the position instead — plan it yourself before automating.
  const draftThesis = (s: XraySymbol, from: string) => {
    const p = s.entry > 0 ? s.entry : 0;
    const isLong = s.side === "LONG";
    try {
      localStorage.setItem(THESIS_DRAFT_KEY, JSON.stringify({
        symbol: s.sym,
        direction: s.side,
        entryPrice: p || undefined,
        stopLoss: p > 0 ? Number((isLong ? p * 0.97 : p * 1.03).toFixed(6)) : undefined,
        takeProfit1: p > 0 ? Number((isLong ? p * 1.06 : p * 0.94).toFixed(6)) : undefined,
        notes: `${short(from)} holds ${s.side} ${s.sym} (${usd(s.szUsd)} open) — seen via wallet x-ray.`,
      }));
    } catch { /* ignore */ }
    navigate("/lab?tab=thesis");
  };

  // Both venues in parallel — one failing must never hide the other, so this uses
  // allSettled and only surfaces an error when NEITHER source returned anything.
  const run = useCallback(async (addr: string) => {
    if (!isAddress(addr)) { setError("Enter a valid 0x… wallet address"); return; }
    setLoading(true); setError(null); setTrades(null); setOrderly(null);
    const [hl, ord] = await Promise.allSettled([fetchHLFills(addr), fetchOrderlyXray(addr)]);

    const t = hl.status === "fulfilled" ? fillsToTrades(hl.value) : [];
    setTrades(t);
    const ox = ord.status === "fulfilled" ? ord.value : null;
    setOrderly(ox);

    const hasHL = t.length > 0;
    const hasOrderly = !!ox && ox.venues.length > 0;
    if (!hasHL && !hasOrderly) {
      setError(
        hl.status === "rejected" && ord.status === "rejected"
          ? "Couldn't reach Hyperliquid or Orderly. Try again."
          : "No perp trading history found for this wallet on Hyperliquid or the Orderly network.",
      );
    }
    setLoading(false);
  }, []);

  // Auto-run from a shared ?address= link.
  useEffect(() => { if (address && isAddress(address)) run(address); }, [address, run]);

  const submit = () => {
    const addr = input.trim();
    if (!isAddress(addr)) { setError("Enter a valid 0x… wallet address"); return; }
    setAddress(addr);
    setParams({ address: addr });
  };

  const { totalPnl, winRate } = useMemo(() => {
    if (!trades || !trades.length) return { totalPnl: 0, winRate: 0 };
    const wins = trades.filter((t) => t.pnl > 0).length;
    return {
      totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
      winRate: (wins / trades.length) * 100,
    };
  }, [trades]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px 80px", fontFamily: mono, color: "#f4f4f5" }}>
      <div style={{ marginBottom: 6, fontSize: 11, letterSpacing: "0.15em", color: GREEN }}>// WALLET X-RAY</div>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 8px", letterSpacing: "-0.01em" }}>
        X-ray any trader. <span style={{ color: GREEN }}>Grade the tape.</span>
      </h1>
      <p style={{ fontSize: 13, color: "#a1a1aa", maxWidth: 660, lineHeight: 1.6, margin: "0 0 20px" }}>
        Paste any wallet. We read its perp record from <b style={{ color: "#d4d4d8" }}>Hyperliquid</b> and
        from the <b style={{ color: "#d4d4d8" }}>Orderly network</b> — including Nexus — straight off
        public data. No login. Then bring your own edge here and prove it on-chain.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="0x… any wallet address"
          spellCheck={false}
          style={{
            flex: "1 1 360px", background: "#0a0a0b", border: `1px solid ${isAddress(input) ? GREEN : "#232327"}`,
            borderRadius: 6, padding: "12px 14px", color: "#fff", fontFamily: mono, fontSize: 13, outline: "none",
          }}
        />
        <button
          onClick={submit}
          disabled={loading}
          style={{
            background: GREEN, color: "#141416", border: "none", borderRadius: 6, padding: "12px 24px",
            fontFamily: mono, fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? "ANALYZING…" : "ANALYZE →"}
        </button>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "#ff6a6a", fontFamily: mono, marginBottom: 16 }}>{error}</div>
      )}

      {loading && (
        <div style={{ fontSize: 12, color: "#a1a1aa", fontFamily: mono }}>$ ./xray.sh --wallet {address?.slice(0, 8)}… <span style={{ color: GREEN }}>reading hyperliquid + orderly…</span></div>
      )}

      {trades && trades.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "#a1a1aa", fontFamily: mono, marginBottom: 10 }}>
            <span style={{ color: GREEN }}>{trades.length}</span> closed perp trades · source: Hyperliquid · {address?.slice(0, 6)}…{address?.slice(-4)}
          </div>
          <AnalyticsView orders={trades} totalPnl={totalPnl} winRate={winRate} collateral={0} />
          <div style={{ marginTop: 24, padding: "16px 18px", border: `1px solid #232327`, borderRadius: 8, background: "#141416", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 13, color: "#f4f4f5" }}>Like what you see? Build a track record nobody can fake.</div>
            <a href="/lab" style={{ background: GREEN, color: "#141416", textDecoration: "none", borderRadius: 6, padding: "10px 20px", fontFamily: mono, fontWeight: 700, fontSize: 12, letterSpacing: "0.06em" }}>OPEN THE LAB →</a>
          </div>
        </>
      )}

      {/* ── ORDERLY NETWORK RECORD ─────────────────────────────────────────────
          Per-market aggregates from the public dashboard indexer, resolved by a
          DERIVED account_id per broker (see worker /smart/xray). Deliberately not
          fed into <AnalyticsView>: there's no per-trade tape behind it. */}
      {orderly && orderly.venues.length > 0 && (
        <div style={{ marginTop: trades && trades.length ? 28 : 0 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.15em", color: "#71717a", marginBottom: 8 }}>// ORDERLY NETWORK RECORD</div>
          <p style={{ fontSize: 12, color: "#71717a", lineHeight: 1.6, margin: "0 0 14px", maxWidth: 680 }}>
            Settled on-chain, read from Orderly&apos;s public indexer — found on{" "}
            <b style={{ color: "#d4d4d8" }}>{orderly.venues.length}</b> of {orderly.brokersChecked} venues probed.
            These are per-market totals; Orderly doesn&apos;t publish a per-trade tape, so the
            hold-time and timing analytics above stay Hyperliquid-only.
          </p>

          {orderly.venues.map((v) => (
            <div key={v.brokerId} style={{ border: `1px solid ${v.isNexus ? "#3a3a42" : "#232327"}`, borderRadius: 8, background: "#141416", padding: "14px 16px", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                <span style={{ fontSize: 13, color: "#f4f4f5", fontWeight: 700, letterSpacing: "0.04em" }}>{v.brokerId}</span>
                {v.isNexus && (
                  <span style={{ fontSize: 8, letterSpacing: "0.1em", color: "#0a0a0b", background: GREEN, borderRadius: 3, padding: "2px 6px", fontWeight: 700 }}>THIS IS NEXUS</span>
                )}
                <span title={v.accountId} style={{ fontSize: 9, color: "#52525b", marginLeft: "auto" }}>
                  acct {v.accountId.slice(0, 10)}…{v.accountId.slice(-6)}
                </span>
                <button
                  onClick={() => toggleWatch(orderly.address)}
                  title={watch.includes(orderly.address) ? "Remove from your Smart Money watchlist" : "Track this wallet in Smart Money"}
                  style={{ background: "none", border: `1px solid ${watch.includes(orderly.address) ? "#33333a" : "#232327"}`, borderRadius: 3, cursor: "pointer", fontFamily: mono, fontSize: 9, letterSpacing: "0.05em", padding: "3px 8px", color: watch.includes(orderly.address) ? "#ededf0" : "#71717a" }}
                >
                  {watch.includes(orderly.address) ? "★ WATCHING" : "☆ WATCH"}
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, marginBottom: 12 }}>
                {[
                  { l: "REALIZED", v: usd(v.realized), c: v.realized >= 0 ? POS : NEG },
                  { l: "UNREALIZED", v: v.unrealized ? usd(v.unrealized) : "—", c: v.unrealized === 0 ? "#52525b" : v.unrealized > 0 ? POS : NEG },
                  { l: "MARKETS", v: String(v.markets), c: "#f4f4f5" },
                  { l: "PROFITABLE MKTS", v: `${v.profitableMarketsPct}%`, c: "#f4f4f5" },
                  { l: "OPEN NOW", v: String(v.openPositions), c: v.openPositions ? "#f4f4f5" : "#52525b" },
                ].map(({ l, v: val, c }) => (
                  <div key={l}>
                    <div style={{ fontSize: 8, color: "#52525b", letterSpacing: "0.12em" }}>{l}</div>
                    <div style={{ fontSize: 15, color: c, fontWeight: 600, marginTop: 2 }}>{val}</div>
                  </div>
                ))}
              </div>

              <div style={{ borderTop: "1px solid #232327", paddingTop: 8 }}>
                {v.bySymbol.slice(0, 12).map((s) => (
                  <div key={s.sym} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", fontSize: 11 }}>
                    <span style={{ color: "#e4e4e7", flex: "1 1 70px", minWidth: 70 }}>{s.sym}</span>
                    <span style={{ color: s.realized >= 0 ? POS : NEG, flex: "1 1 90px", minWidth: 90, textAlign: "right" }}>{usd(s.realized)}</span>
                    <span style={{ color: "#52525b", flex: "1 1 120px", minWidth: 120, textAlign: "right" }}>
                      {s.open && s.side ? `${s.side === "LONG" ? "↑" : "↓"} ${usd(s.szUsd)} open` : ""}
                    </span>
                    <span style={{ color: s.open ? (s.unrealized >= 0 ? POS : NEG) : "#3f3f46", flex: "1 1 90px", minWidth: 90, textAlign: "right" }}>
                      {s.open && s.unrealized ? `${s.unrealized >= 0 ? "+" : ""}${usd(s.unrealized)}` : ""}
                    </span>
                    {/* Actions only on LIVE positions — a closed market has nothing to copy. */}
                    <span style={{ display: "flex", gap: 5, flexShrink: 0, minWidth: 104, justifyContent: "flex-end" }}>
                      {s.open && s.side && (
                        <>
                          <button onClick={() => draftThesis(s, orderly.address)} title="Draft a thesis from this position"
                            style={{ background: "none", border: "1px solid #232327", borderRadius: 3, color: "#71717a", fontFamily: mono, fontSize: 9, padding: "2px 7px", cursor: "pointer" }}>◆</button>
                          <button onClick={() => copyPosition(s, orderly.address)} title="Copy this position — the agent enters your direction, manages the exit, and grades it on-chain"
                            style={{ background: "none", border: "1px solid #33333a", borderRadius: 3, color: GREEN, fontFamily: mono, fontSize: 9, letterSpacing: "0.04em", padding: "2px 7px", cursor: "pointer", whiteSpace: "nowrap" }}>⚡ COPY</button>
                        </>
                      )}
                    </span>
                  </div>
                ))}
                {v.bySymbol.length > 12 && (
                  <div style={{ fontSize: 10, color: "#52525b", paddingTop: 6 }}>+{v.bySymbol.length - 12} more markets</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cross-verify on Orderly — the trustless bridge. Shows for any valid address
          (even with no Hyperliquid history), deep-linking the wallet into Orderly's
          official explorer (trades, deposits/withdrawals, liquidations, PnL). */}
      {address && isAddress(address) && !loading && (
        <div style={{ marginTop: trades && trades.length ? 16 : 24, padding: "16px 18px", border: "1px solid #15324a", borderRadius: 8, background: "#1a1a1e" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.15em", color: "#d4d4d8", marginBottom: 8 }}>// CROSS-VERIFY ON ORDERLY</div>
          <p style={{ fontSize: 12.5, color: "#8aa6c0", lineHeight: 1.6, margin: "0 0 12px", maxWidth: 640 }}>
            Nexus runs on <b style={{ color: "#cfe0f0" }}>Orderly Network</b>&apos;s omnichain liquidity. Don&apos;t trust our
            numbers — independently verify this wallet&apos;s on-chain trading (executed trades, deposits &amp;
            withdrawals, liquidations, realized PnL) on Orderly&apos;s official explorer.
          </p>
          <a
            href={`https://orderly-dashboard.orderly.network/explorer?q=${address}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-block", background: "#1a1a1e", color: "#d4d4d8", border: "1px solid #1f4a6e", textDecoration: "none", borderRadius: 6, padding: "10px 18px", fontFamily: mono, fontWeight: 700, fontSize: 12, letterSpacing: "0.06em" }}
          >
            VERIFY {address.slice(0, 6)}…{address.slice(-4)} ON ORDERLY ↗
          </a>
        </div>
      )}
    </div>
  );
}
