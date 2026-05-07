/**
 * useLabStorage
 *
 * Persists LAB data (theses + calendar notes) to Cloudflare KV via nexus-lab-api,
 * with localStorage as instant local cache.
 *
 * Usage:
 *   const { theses, notes, saveTheses, saveNote, syncing } = useLabStorage(walletAddress);
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { ThesisTrade } from "@/pages/lab/types";

const API_BASE = "https://og.nexustradinglabs.com";
const LOCAL_THESIS_KEY = "lab_thesis_trades";
const LOCAL_NOTES_PREFIX = "lab_note_";

type LabData = {
  theses: ThesisTrade[];
  notes: Record<string, string>;
};

function readLocalTheses(): ThesisTrade[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_THESIS_KEY) || "[]");
    return raw.map((t: ThesisTrade) => ({
      ...t,
      status: (t.status ?? "ACTIVE") as ThesisTrade["status"],
      actualPnl: t.actualPnl ?? null,
    }));
  } catch {
    return [];
  }
}

function readLocalNotes(): Record<string, string> {
  const notes: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(LOCAL_NOTES_PREFIX)) {
      const dayKey = key.slice(LOCAL_NOTES_PREFIX.length);
      notes[dayKey] = localStorage.getItem(key) || "";
    }
  }
  return notes;
}

function writeLocalTheses(theses: ThesisTrade[]) {
  localStorage.setItem(LOCAL_THESIS_KEY, JSON.stringify(theses));
}

function writeLocalNote(dayKey: string, note: string) {
  localStorage.setItem(`${LOCAL_NOTES_PREFIX}${dayKey}`, note);
}

export function useLabStorage(walletAddress?: string | null) {
  const [theses, setTheses] = useState<ThesisTrade[]>(readLocalTheses);
  const [notes, setNotes] = useState<Record<string, string>>(readLocalNotes);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFetchedRef = useRef(false);

  const addr = walletAddress?.toLowerCase().trim();

  // ── On wallet connect: fetch from KV and merge ──────────
  useEffect(() => {
    if (!addr || hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    setSyncing(true);
    fetch(`${API_BASE}/lab/${addr}`)
      .then((r) => r.json())
      .then((remote: LabData) => {
        // Merge: remote takes priority, but keep any local items not in remote
        const remoteIds = new Set(remote.theses.map((t) => t.id));
        const localOnly = readLocalTheses().filter((t) => !remoteIds.has(t.id));
        const merged = [...remote.theses, ...localOnly];

        const mergedNotes = { ...readLocalNotes(), ...remote.notes };

        setTheses(merged);
        setNotes(mergedNotes);
        writeLocalTheses(merged);
        Object.entries(mergedNotes).forEach(([k, v]) => writeLocalNote(k, v));

        setSynced(true);
      })
      .catch(() => {
        // Network error — fall back to localStorage silently
      })
      .finally(() => setSyncing(false));
  }, [addr]);

  // ── Debounced push to KV ─────────────────────────────────
  const pushToKV = useCallback(
    (updatedTheses: ThesisTrade[], updatedNotes: Record<string, string>) => {
      if (!addr) return;
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = setTimeout(() => {
        fetch(`${API_BASE}/lab/${addr}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theses: updatedTheses, notes: updatedNotes }),
        }).catch(() => {
          // Silent fail — localStorage already has the data
        });
      }, 1000); // 1s debounce
    },
    [addr]
  );

  // ── Save theses ──────────────────────────────────────────
  const saveTheses = useCallback(
    (updated: ThesisTrade[]) => {
      setTheses(updated);
      writeLocalTheses(updated);
      pushToKV(updated, notes);
    },
    [notes, pushToKV]
  );

  // ── Save a single calendar note ──────────────────────────
  const saveNote = useCallback(
    (dayKey: string, note: string) => {
      const updatedNotes = { ...notes, [dayKey]: note };
      setNotes(updatedNotes);
      writeLocalNote(dayKey, note);
      pushToKV(theses, updatedNotes);
    },
    [theses, notes, pushToKV]
  );

  return { theses, notes, saveTheses, saveNote, syncing, synced };
}
