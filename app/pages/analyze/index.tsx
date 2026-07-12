// Public "Wallet X-Ray" — paste any Hyperliquid wallet, get the full Nexus Lab
// analytics on its perp trade history. No login, no wallet connect required.
// Acquisition wedge: grade a trader who's never touched our DEX, then convert.
//
// ⚠️ This page deliberately uses NO Orderly private hooks — it only hits
// Hyperliquid's public /info API and renders the pure <AnalyticsView>. Keep it
// that way (see the SWR-key-collision incident).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AnalyticsView } from "@/pages/lab/AnalyticsView";
import type { ProcessedTrade } from "@/pages/lab/types";

const GREEN = "#ededf0";
const mono = "var(--nx-font-mono)";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (addr: string) => {
    if (!isAddress(addr)) { setError("Enter a valid 0x… wallet address"); return; }
    setLoading(true); setError(null); setTrades(null);
    try {
      const fills = await fetchHLFills(addr);
      const t = fillsToTrades(fills);
      setTrades(t);
      if (!t.length) setError("No closed perp trades found for this wallet on Hyperliquid.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch from Hyperliquid");
    } finally {
      setLoading(false);
    }
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
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px 80px", fontFamily: mono, color: "#e8f0ea" }}>
      <div style={{ marginBottom: 6, fontSize: 11, letterSpacing: "0.15em", color: GREEN }}>// WALLET X-RAY</div>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 8px", letterSpacing: "-0.01em" }}>
        X-ray any trader. <span style={{ color: GREEN }}>Grade the tape.</span>
      </h1>
      <p style={{ fontSize: 13, color: "#a1a1aa", maxWidth: 620, lineHeight: 1.6, margin: "0 0 20px" }}>
        Paste any Hyperliquid wallet and get the full Nexus trading breakdown — score, risk-adjusted
        ratios, hold-time, leverage, timing, and per-asset edge. No login. Then bring your own edge to
        Nexus and prove it on-chain.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="0x… Hyperliquid wallet address"
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
        <div style={{ fontSize: 12, color: "#a1a1aa", fontFamily: mono }}>$ ./xray.sh --wallet {address?.slice(0, 8)}… <span style={{ color: GREEN }}>fetching fills…</span></div>
      )}

      {trades && trades.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "#a1a1aa", fontFamily: mono, marginBottom: 10 }}>
            <span style={{ color: GREEN }}>{trades.length}</span> closed perp trades · source: Hyperliquid · {address?.slice(0, 6)}…{address?.slice(-4)}
          </div>
          <AnalyticsView orders={trades} totalPnl={totalPnl} winRate={winRate} collateral={0} />
          <div style={{ marginTop: 24, padding: "16px 18px", border: `1px solid #232327`, borderRadius: 8, background: "#141416", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 13, color: "#e8f0ea" }}>Like what you see? Build a track record nobody can fake.</div>
            <a href="/lab" style={{ background: GREEN, color: "#141416", textDecoration: "none", borderRadius: 6, padding: "10px 20px", fontFamily: mono, fontWeight: 700, fontSize: 12, letterSpacing: "0.06em" }}>OPEN THE LAB →</a>
          </div>
        </>
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
