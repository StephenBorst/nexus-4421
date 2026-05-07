/**
 * useProfile
 *
 * Fetches and saves wallet profile data { pfp, displayName } from
 * nexus-lab-api /profile/:address endpoint (backed by KV).
 *
 * Usage:
 *   const { pfp, displayName, saveProfile, loading } = useProfile(walletAddress);
 */

import { useState, useEffect, useCallback } from "react";

const API_BASE = "https://og.nexustradinglabs.com";

export type Profile = {
  pfp: string | null;
  displayName: string | null;
};

const profileCache: Record<string, Profile> = {};

export function useProfile(walletAddress?: string | null) {
  const addr = walletAddress?.toLowerCase().trim() || null;

  const [profile, setProfile] = useState<Profile>(() => {
    if (!addr) return { pfp: null, displayName: null };
    return profileCache[addr] ?? { pfp: null, displayName: null };
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Fetch profile on wallet connect ──────────────────────
  useEffect(() => {
    if (!addr) return;
    if (profileCache[addr]) {
      setProfile(profileCache[addr]);
      return;
    }

    setLoading(true);
    fetch(`${API_BASE}/profile/${addr}`)
      .then((r) => r.json())
      .then((data: Profile) => {
        profileCache[addr] = data;
        setProfile(data);
      })
      .catch(() => {
        // Network error — keep defaults
      })
      .finally(() => setLoading(false));
  }, [addr]);

  // ── Save profile ──────────────────────────────────────────
  const saveProfile = useCallback(
    async (updates: Partial<Profile>) => {
      if (!addr) return;
      const next: Profile = { ...profile, ...updates };
      // Optimistic update
      setProfile(next);
      profileCache[addr] = next;

      setSaving(true);
      try {
        await fetch(`${API_BASE}/profile/${addr}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
      } catch {
        // Silent fail — optimistic state stays
      } finally {
        setSaving(false);
      }
    },
    [addr, profile]
  );

  return {
    pfp: profile.pfp,
    displayName: profile.displayName,
    saveProfile,
    loading,
    saving,
  };
}

// Utility: fetch a profile for any wallet (for feed display, no hook needed)
export async function fetchProfile(address: string): Promise<Profile> {
  const addr = address.toLowerCase().trim();
  if (profileCache[addr]) return profileCache[addr];
  try {
    const r = await fetch(`${API_BASE}/profile/${addr}`);
    const data: Profile = await r.json();
    profileCache[addr] = data;
    return data;
  } catch {
    return { pfp: null, displayName: null };
  }
}
