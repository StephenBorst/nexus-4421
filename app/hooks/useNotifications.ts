import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = "https://og.nexustradinglabs.com";

export interface Notification {
  id: string;
  type: "follow" | "copy" | "thesis_closed" | "call_resolved" | "comment" | "challenge" | "reaction";
  message: string;
  fromWallet?: string;
  thesisId?: string;
  // Owner of thesisId when it isn't the recipient's own call (e.g. a challenge links to
  // the challenger's thesis). Defaults to the recipient in the bell's navigation.
  thesisWallet?: string;
  createdAt: number;
  readAt?: number;
}

export function useNotifications(walletAddress?: string | null) {
  const addr = walletAddress?.toLowerCase().trim() || null;
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchNotifications = useCallback(async () => {
    if (!addr) return;
    try {
      const r = await fetch(`${API_BASE}/notifications/${addr}`);
      if (!r.ok) return;
      const data: Notification[] = await r.json();
      setNotifications(data);
    } catch {
      // silent — stale state is fine
    }
  }, [addr]);

  useEffect(() => {
    if (!addr) {
      setNotifications([]);
      return;
    }
    fetchNotifications();
    intervalRef.current = setInterval(fetchNotifications, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [addr, fetchNotifications]);

  const markAllRead = useCallback(async () => {
    if (!addr) return;
    const now = Date.now();
    setNotifications((prev) =>
      prev.map((n) => (n.readAt ? n : { ...n, readAt: now }))
    );
    try {
      await fetch(`${API_BASE}/notifications/${addr}/read`, { method: "PUT" });
    } catch {
      // silent
    }
  }, [addr]);

  const deleteNotification = useCallback(
    async (id: string) => {
      if (!addr) return;
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      try {
        await fetch(`${API_BASE}/notifications/${addr}/${id}`, {
          method: "DELETE",
        });
      } catch {
        // silent
      }
    },
    [addr]
  );

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  return { notifications, unreadCount, markAllRead, deleteNotification };
}
