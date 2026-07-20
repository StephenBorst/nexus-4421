/**
 * NexusMarket — live $NEXUS market data (price / MC / 24h vol / liquidity).
 *
 * Source: GeckoTerminal public API, fetched CLIENT-SIDE on purpose. CoinGecko/
 * GeckoTerminal block datacenter IPs (Cloudflare Workers get 403'd without a
 * key); the browser uses the user's real IP and CORS is allowed, so this dodges
 * both the key requirement and the cloud-IP block. Fails soft — renders nothing
 * if the API hiccups. Also carries the GeckoTerminal link-back (their request).
 */

import { useEffect, useState } from "react";
import { BuyNexusButton } from "@/components/BuyNexusButton";
import { C } from "@/config/theme";

const NEXUS_TOKEN = "0x3D958634ab725B627919EF8F2Ed59227309fDba3";
const GT_API = `https://api.geckoterminal.com/api/v2/networks/base/tokens/${NEXUS_TOKEN}`;
const GT_PAGE = `https://www.geckoterminal.com/base/tokens/${NEXUS_TOKEN}`;

interface Market {
  price: number | null;
  marketCap: number | null;
  volume24h: number | null;
  liquidity: number | null;
}

function usd(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function price(n: number | null): string {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  // small memecoin price — ~3 significant figures, NO scientific notation
  const decimals = Math.min(18, Math.max(2, 2 - Math.floor(Math.log10(n))));
  return `$${n.toFixed(decimals)}`;
}

// Stats GROW to share the strip's width. Without this they cluster hard-left and the
// actions group's marginLeft:auto opened a ~1250px void on wide screens — on every Lab
// and Feed tab, since this strip is global. minWidth keeps them legible when wrapped.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 90px", minWidth: 70 }}>
      <span style={{ fontSize: 8, letterSpacing: "0.12em", color: C.text.faint }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: "bold", color: C.text.bright }}>{value}</span>
    </div>
  );
}

export function NexusMarket() {
  const [m, setM] = useState<Market | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(GT_API, { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((j) => {
        const a = j?.data?.attributes;
        if (!a || cancelled) return;
        const num = (v: unknown) => (v == null ? null : Number(v));
        setM({
          price: num(a.price_usd),
          marketCap: num(a.market_cap_usd) ?? num(a.fdv_usd),
          volume24h: num(a.volume_usd?.h24),
          liquidity: num(a.total_reserve_in_usd),
        });
      })
      .catch(() => { /* fail soft */ });
    return () => { cancelled = true; };
  }, []);

  if (!m) return null;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap",
      padding: "12px 16px", background: C.surfaceAlt, border: `1px solid ${C.border}`,
      borderRadius: 4, fontFamily: "var(--nx-font-mono)",
    }}>
      <span style={{ fontSize: 11, fontWeight: "bold", color: C.accent, letterSpacing: "0.1em" }}>$NEXUS</span>
      <Stat label="PRICE" value={price(m.price)} />
      <Stat label="MARKET CAP" value={usd(m.marketCap)} />
      <Stat label="24H VOL" value={usd(m.volume24h)} />
      <Stat label="LIQUIDITY" value={usd(m.liquidity)} />
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 10 }}>
        <a
          href={GT_PAGE}
          target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 9, color: C.info, textDecoration: "none", letterSpacing: "0.06em", border: `1px solid ${C.border}`, borderRadius: 3, padding: "4px 8px" }}
          title="View $NEXUS on GeckoTerminal"
        >
          GeckoTerminal ↗
        </a>
        <BuyNexusButton size="sm" />
      </div>
    </div>
  );
}
