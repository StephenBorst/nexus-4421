/**
 * useLivePrices
 *
 * Polls Orderly's public futures endpoint every 5 seconds and returns
 * a map of symbol → markPrice for the requested symbols.
 *
 * Usage:
 *   const prices = useLivePrices(["PERP_BTC_USDC", "PERP_ETH_USDC"]);
 *   prices["PERP_BTC_USDC"] // → 67500.5 | null
 */

import { useState, useEffect, useRef } from "react";

const ORDERLY_FUTURES_URL = "https://api-evm.orderly.org/v1/public/futures";
const POLL_INTERVAL = 5000; // 5 seconds

export type PriceMap = Record<string, number | null>;

type FuturesRow = {
  symbol: string;
  mark_price: number;
};

type FuturesResponse = {
  data: {
    rows: FuturesRow[];
  };
};

// Module-level cache so multiple components share one fetch
let cachedPrices: PriceMap = {};
let lastFetch = 0;
let fetchPromise: Promise<PriceMap> | null = null;
const listeners = new Set<(prices: PriceMap) => void>();

async function fetchAllPrices(): Promise<PriceMap> {
  const now = Date.now();
  // Return cache if fresh
  if (now - lastFetch < POLL_INTERVAL && Object.keys(cachedPrices).length > 0) {
    return cachedPrices;
  }
  // Deduplicate concurrent fetches
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch(ORDERLY_FUTURES_URL)
    .then((r) => r.json())
    .then((data: FuturesResponse) => {
      const map: PriceMap = {};
      (data?.data?.rows ?? []).forEach((row) => {
        map[row.symbol] = row.mark_price ?? null;
      });
      cachedPrices = map;
      lastFetch = Date.now();
      // Notify all listeners
      listeners.forEach((fn) => fn(map));
      return map;
    })
    .catch(() => cachedPrices)
    .finally(() => {
      fetchPromise = null;
    });

  return fetchPromise;
}

// Start the global poll loop once
let pollStarted = false;
function startPollLoop() {
  if (pollStarted) return;
  pollStarted = true;
  const tick = () => {
    fetchAllPrices().finally(() => {
      setTimeout(tick, POLL_INTERVAL);
    });
  };
  tick();
}

export function useLivePrices(symbols: string[]): PriceMap {
  const [prices, setPrices] = useState<PriceMap>(() => {
    // Seed from cache immediately
    const seed: PriceMap = {};
    symbols.forEach((s) => { seed[s] = cachedPrices[s] ?? null; });
    return seed;
  });

  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;

  useEffect(() => {
    startPollLoop();

    const handleUpdate = (allPrices: PriceMap) => {
      const next: PriceMap = {};
      symbolsRef.current.forEach((s) => { next[s] = allPrices[s] ?? null; });
      setPrices(next);
    };

    listeners.add(handleUpdate);

    // Trigger fetch immediately if cache is stale
    fetchAllPrices().then(handleUpdate);

    return () => {
      listeners.delete(handleUpdate);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return prices;
}

// Utility: calculate unrealized P&L given mark price
export function calcUnrealizedPnl(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  markPrice: number,
  positionSize: number
): { pnl: number; pct: number } {
  if (!entryPrice || !markPrice || !positionSize) return { pnl: 0, pct: 0 };
  const qty = positionSize / entryPrice;
  const priceDelta = direction === "LONG"
    ? markPrice - entryPrice
    : entryPrice - markPrice;
  const pnl = priceDelta * qty;
  const pct = (priceDelta / entryPrice) * 100;
  return { pnl, pct };
}

// Utility: distance from mark price to a level, as %
export function distancePct(markPrice: number, level: number): number {
  if (!markPrice || !level) return 0;
  return Math.abs((level - markPrice) / markPrice) * 100;
}
