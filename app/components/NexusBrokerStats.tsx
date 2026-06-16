/**
 * NexusBrokerStats — third-party-verified Nexus network stats from Orderly's own
 * public dashboard API. Trust play: our broker's REAL volume/fees, sourced from
 * Orderly (not self-reported), with a deep-link to Orderly's official dashboard.
 *
 * ⚠️ The query-service blocks datacenter IPs (like CoinGecko) → this MUST be a
 * CLIENT-SIDE fetch (runs fine in the user's browser). Fail-soft: if the number
 * can't be fetched/parsed, we still render the "verify on Orderly ↗" link so the
 * trust bridge is always present. Field names are read defensively (the API shape
 * isn't publicly documented) + range-sanity-checked so a raw/odd value can't show.
 */

import { useEffect, useState } from "react";

const BROKER_ID = "nexus_trading";
const QUERY = "https://orderly-dashboard-query-service.orderly.network/orderly/api/v1/dashboard/orderly/by-broker?exclude_zero_volume=true";
const DASHBOARD = "https://orderly-dashboard.orderly.network/";

const fmtUsd = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;

// Pull the first plausible USD number from a set of candidate field names.
function pickNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = Number(row[k]);
    if (Number.isFinite(v) && v > 0 && v < 1e15) return v; // sanity: positive, not raw garbage
  }
  return null;
}

export function NexusBrokerStats({ compact = false }: { compact?: boolean }) {
  const [vol, setVol] = useState<number | null>(null);
  const [fees, setFees] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetch(QUERY, { headers: { Accept: "application/json" } }).then((r) => r.json());
        // Response shape isn't documented — dig out the array of broker rows.
        const rows: Record<string, unknown>[] =
          (Array.isArray(d) && d) ||
          (Array.isArray(d?.data) && d.data) ||
          (Array.isArray(d?.rows) && d.rows) ||
          (Array.isArray(d?.data?.rows) && d.data.rows) ||
          [];
        const row = rows.find((r) => {
          const id = String(r.broker_id ?? r.brokerId ?? "").toLowerCase();
          const nm = String(r.broker_name ?? r.brokerName ?? "").toLowerCase();
          return id === BROKER_ID || nm.includes("nexus");
        });
        if (!row || cancelled) return;
        setVol(pickNum(row, ["perp_volume", "perp_volume_usd", "volume", "total_volume", "volume_usd", "perp_trading_volume"]));
        setFees(pickNum(row, ["broker_fee", "total_fee", "fee", "broker_fee_usd", "net_fee"]));
      } catch { /* fail-soft → just the verify link */ }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <a
      href={DASHBOARD}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex", alignItems: "center", gap: compact ? 12 : 18,
        padding: compact ? "8px 12px" : "12px 16px",
        background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4,
        fontFamily: "monospace", textDecoration: "none",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 8, letterSpacing: "0.12em", color: "#3a5a4a" }}>📊 NEXUS ON ORDERLY</span>
        <span style={{ fontSize: compact ? 12 : 13, color: "#8aaa9a" }}>
          {vol != null ? <>vol <b style={{ color: "#fff" }}>{fmtUsd(vol)}</b></> : <span style={{ color: "#5fd6a0" }}>network stats</span>}
          {fees != null && <> · fees <b style={{ color: "#fff" }}>{fmtUsd(fees)}</b></>}
        </span>
      </div>
      <div style={{ width: 1, alignSelf: "stretch", background: "#1a2e1a" }} />
      <span style={{ fontSize: compact ? 10 : 11, color: "#5fd6a0", whiteSpace: "nowrap" }}>verify on Orderly ↗</span>
      {!compact && (
        <div style={{ flex: 1, minWidth: 0, fontSize: 8, color: "#2a4a3a", lineHeight: 1.4, textAlign: "right" }}>
          third-party-verified
          <br />
          Orderly Network dashboard
        </div>
      )}
    </a>
  );
}
