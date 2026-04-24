import { useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

const MARKETS_KEY = "orderly_markets";

export function useWatchlistSync(walletAddress: string | null | undefined) {
  const hasSynced = useRef(false);
  const lastSaved = useRef<string>("");

  // On wallet connect — load from Supabase into localStorage
  useEffect(() => {
    if (!walletAddress || hasSynced.current) return;

    const loadFromCloud = async () => {
      const { data, error } = await supabase
        .from("watchlists")
        .select("*")
        .eq("wallet_address", walletAddress.toLowerCase())
        .single();

      if (error || !data || !data.favorites) return;

      // Merge cloud favorites into existing orderly_markets
      const existing = JSON.parse(localStorage.getItem(MARKETS_KEY) || "{}");
      const merged = {
        ...existing,
        favorites: data.favorites,
        favoriteTabs: data.favorite_tabs || existing.favoriteTabs || [],
        selectedFavoriteTab: data.last_selected_tab || existing.selectedFavoriteTab || {},
      };

      localStorage.setItem(MARKETS_KEY, JSON.stringify(merged));
      hasSynced.current = true;
      console.log("✅ Loaded watchlist from Supabase");
    };

    loadFromCloud();
  }, [walletAddress]);

  // Reset on disconnect
  useEffect(() => {
    if (!walletAddress) {
      hasSynced.current = false;
      lastSaved.current = "";
    }
  }, [walletAddress]);

  // Poll every 5 seconds and save if data changed
  useEffect(() => {
    if (!walletAddress) return;

    console.log("🟢 WatchlistSync active for:", walletAddress);

    const poll = setInterval(async () => {
      const raw = localStorage.getItem(MARKETS_KEY);
      if (!raw) return;

      const markets = JSON.parse(raw);
      const favorites = markets.favorites || [];
      const favoriteTabs = markets.favoriteTabs || [];
      const lastSelectedTab = markets.selectedFavoriteTab || {};

      const snapshot = JSON.stringify({ favorites, favoriteTabs, lastSelectedTab });
      if (snapshot === lastSaved.current) return;
      lastSaved.current = snapshot;

      console.log("💾 Saving to Supabase...", favorites.length, "favorites");

      const { error } = await supabase.from("watchlists").upsert({
        wallet_address: walletAddress.toLowerCase(),
        favorites,
        favorite_tabs: favoriteTabs,
        last_selected_tab: lastSelectedTab,
        updated_at: new Date().toISOString(),
      });

      if (error) console.log("❌ Supabase error:", error);
      else console.log("✅ Saved successfully");
    }, 5000);

    return () => clearInterval(poll);
  }, [walletAddress]);
}