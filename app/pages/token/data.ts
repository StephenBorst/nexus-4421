// ── Nexus token terminal — data layer ────────────────────────────────────────
// A Definitive-style token page needs four public reads, all CLIENT-SIDE (the same
// reason NexusMarket fetches GeckoTerminal from the browser: GT/CoinGecko 403 datacenter
// IPs, so a worker proxy would be the thing that's blocked, not the browser):
//   1. DexScreener search / token → the header (price, MC/FDV, vol, liq, 24h%, buys/sells,
//      CA, socials) AND pool discovery, in ONE permissive call. This is the source of truth
//      for identity + stats.
//   2. GeckoTerminal pool OHLCV → the candles (DexScreener exposes no OHLC).
//   3. GeckoTerminal pool trades → the live tape (AMT / PRICE / ADDR / AGE).
//   4. Orderly public info → whether this symbol is a Nexus PERP, so the trade CTA can route
//      to real in-venue execution instead of only a deep-link out.
// Everything is fail-soft: a dead source renders its section empty, never blocks the page.

const DS_BASE = "https://api.dexscreener.com/latest/dex";
const GT_BASE = "https://api.geckoterminal.com/api/v2";
const ORDERLY_INFO = "https://api-evm.orderly.org/v1/public/info";

// ── shared: a fetch that can't hang the UI (the watchdog lesson — an unsettled promise
// never runs your .catch, so cap it with an abort) ───────────────────────────────────
async function getJson(url: string, ms = 6000): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// DexScreener chainId → GeckoTerminal network slug. Most align; these are the ones that don't.
const GT_NETWORK: Record<string, string> = {
  ethereum: "eth",
  binance: "bsc",
  bsc: "bsc",
  polygon: "polygon_pos",
  avalanche: "avax",
  arbitrum: "arbitrum",
  optimism: "optimism",
  base: "base",
  solana: "solana",
  sui: "sui",
  ton: "ton",
};
export const gtNetwork = (chainId: string): string => GT_NETWORK[chainId] || chainId;

// ── types (only the fields the terminal reads) ────────────────────────────────
export interface TokenSocial { type: string; url: string }
export interface TokenPair {
  chainId: string;
  dexId: string;
  url: string;                 // DexScreener pair page (fallback trade link)
  pairAddress: string;         // == GeckoTerminal pool address on most chains
  baseSymbol: string;
  baseName: string;
  baseAddress: string;
  quoteSymbol: string;
  priceUsd: number | null;
  priceChange24h: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  marketCap: number | null;
  volume24h: number | null;
  volume1h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  imageUrl: string | null;
  websites: string[];
  socials: TokenSocial[];
  createdAt: number | null;
}
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
export interface Trade { ts: number; kind: "buy" | "sell"; amountUsd: number; priceUsd: number; wallet: string; tx: string }

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPair(p: any): TokenPair | null {
  if (!p || !p.baseToken || !p.chainId) return null;
  const info = p.info || {};
  return {
    chainId: String(p.chainId),
    dexId: String(p.dexId || ""),
    url: String(p.url || ""),
    pairAddress: String(p.pairAddress || ""),
    baseSymbol: String(p.baseToken.symbol || "").toUpperCase(),
    baseName: String(p.baseToken.name || p.baseToken.symbol || ""),
    baseAddress: String(p.baseToken.address || ""),
    quoteSymbol: String(p.quoteToken?.symbol || "USD").toUpperCase(),
    priceUsd: num(p.priceUsd),
    priceChange24h: num(p.priceChange?.h24),
    liquidityUsd: num(p.liquidity?.usd),
    fdv: num(p.fdv),
    marketCap: num(p.marketCap) ?? num(p.fdv),
    volume24h: num(p.volume?.h24),
    volume1h: num(p.volume?.h1),
    buys24h: num(p.txns?.h24?.buys),
    sells24h: num(p.txns?.h24?.sells),
    imageUrl: info.imageUrl || null,
    websites: Array.isArray(info.websites) ? info.websites.map((w: { url: string }) => w.url).filter(Boolean) : [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socials: Array.isArray(info.socials) ? info.socials.map((s: any) => ({ type: String(s.type || s.platform || "link"), url: String(s.url || s.handle || "") })).filter((s: TokenSocial) => s.url) : [],
    createdAt: num(p.pairCreatedAt),
  };
}

// The most LIQUID pair wins — that's the one a trader actually means, and the one with the
// deepest tape + chart. DexScreener returns every pair for a query; we rank by USD liquidity.
function bestPair(pairs: TokenPair[]): TokenPair | null {
  if (!pairs.length) return null;
  return [...pairs].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
}

// Search by symbol, name, or contract address (Definitive's "Search CA or Token"). Returns the
// deepest pair plus the ranked alternates (so the UI can offer "did you mean" for ambiguous
// tickers). A bare EVM/Solana address goes straight to the token endpoint for an exact hit.
export async function searchToken(query: string): Promise<{ best: TokenPair | null; alts: TokenPair[] }> {
  const q = query.trim();
  if (!q) return { best: null, alts: [] };
  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
  const url = isAddress ? `${DS_BASE}/tokens/${encodeURIComponent(q)}` : `${DS_BASE}/search?q=${encodeURIComponent(q)}`;
  const j = (await getJson(url)) as { pairs?: unknown[] } | null;
  const pairs = Array.isArray(j?.pairs) ? j!.pairs!.map(toPair).filter((p): p is TokenPair => !!p) : [];
  const best = bestPair(pairs);
  const alts = pairs
    .filter((p) => p.pairAddress !== best?.pairAddress)
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, 4);
  return { best, alts };
}

// GeckoTerminal OHLCV → candles. timeframe: day | hour | minute (+ aggregate for 5m/15m/4h).
export async function poolCandles(network: string, pool: string, timeframe = "hour", aggregate = 1, limit = 100): Promise<Candle[]> {
  if (!pool) return [];
  const url = `${GT_BASE}/networks/${gtNetwork(network)}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}`;
  const j = (await getJson(url)) as { data?: { attributes?: { ohlcv_list?: number[][] } } } | null;
  const list = j?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  // GT returns newest-first; the chart wants oldest→newest left→right.
  return list
    .map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }))
    .filter((c) => Number.isFinite(c.o) && Number.isFinite(c.c))
    .sort((a, b) => a.t - b.t);
}

// GeckoTerminal recent trades → the live tape.
export async function poolTrades(network: string, pool: string): Promise<Trade[]> {
  if (!pool) return [];
  const url = `${GT_BASE}/networks/${gtNetwork(network)}/pools/${pool}/trades`;
  const j = (await getJson(url)) as { data?: unknown[] } | null;
  if (!Array.isArray(j?.data)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (j!.data as any[])
    .map((d) => {
      const a = d?.attributes || {};
      const kind = a.kind === "sell" ? "sell" : "buy";
      const ts = a.block_timestamp ? Date.parse(a.block_timestamp) : NaN;
      return {
        ts: Number.isFinite(ts) ? ts : Date.now(),
        kind: kind as "buy" | "sell",
        amountUsd: num(a.volume_in_usd) ?? 0,
        priceUsd: num(a.price_to_in_usd) ?? num(a.price_from_in_usd) ?? 0,
        wallet: String(a.tx_from_address || ""),
        tx: String(a.tx_hash || ""),
      };
    })
    .filter((t) => t.amountUsd > 0)
    .slice(0, 40);
}

// Orderly perp base symbols (BTC, ETH, …) so the CTA can route to REAL Nexus execution when
// the token is one we list. Cached module-wide — the set changes rarely and the page mounts often.
let _perpSet: Set<string> | null = null;
let _perpAt = 0;
export async function orderlyPerpSet(): Promise<Set<string>> {
  if (_perpSet && Date.now() - _perpAt < 10 * 60 * 1000) return _perpSet;
  const j = (await getJson(ORDERLY_INFO)) as { data?: { rows?: { symbol: string }[] } } | null;
  const rows = j?.data?.rows;
  const set = new Set<string>();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const m = /^PERP_([A-Z0-9]+)_USDC$/.exec(String(r.symbol || ""));
      if (m) set.add(m[1]);
    }
  }
  if (set.size) { _perpSet = set; _perpAt = Date.now(); }
  return set;
}

// ── formatters (compact, terminal register) ──────────────────────────────────
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  // sub-cent memecoin price — ~4 significant figures, no scientific notation
  return `$${n.toPrecision(4).replace(/e[-+]?\d+$/i, "")}`;
}
export function fmtAge(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
export const shortAddr = (a: string): string => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "—");
