import { useState, useRef, useEffect } from "react";
import { useAccount } from "@orderly.network/hooks";
import { useNotifications, type Notification } from "@/hooks/useNotifications";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function typeIcon(type: Notification["type"]): string {
  if (type === "follow") return "👥";
  if (type === "copy") return "📋";
  if (type === "thesis_closed") return "✅";
  return "🔔";
}

export default function NotificationBell() {
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const { notifications, unreadCount, markAllRead, deleteNotification } =
    useNotifications(walletAddress);

  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!walletAddress) return null;

  return (
    <div
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
    >
      {/* Bell button */}
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          border: open ? "2px solid #ededf0" : "2px solid #232327",
          background: "#141416",
          cursor: "pointer",
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "border-color 0.15s",
          flexShrink: 0,
          position: "relative",
        }}
      >
        <span style={{ fontSize: 15, lineHeight: 1 }}>🔔</span>
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: -3,
              right: -3,
              background: "#f7525f",
              color: "#fff",
              borderRadius: "50%",
              minWidth: 16,
              height: 16,
              fontSize: 9,
              fontFamily: "var(--nx-font-mono)",
              fontWeight: "bold",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 3px",
              lineHeight: 1,
              boxSizing: "border-box",
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={panelRef}
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 9999,
            background: "#141416",
            border: "1px solid #232327",
            borderRadius: 6,
            width: 300,
            boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid #232327",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span
              style={{
                fontFamily: "var(--nx-font-mono)",
                fontSize: 9,
                letterSpacing: "0.12em",
                color: "#52525b",
              }}
            >
              ■ NOTIFICATIONS
            </span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                style={{
                  background: "none",
                  border: "none",
                  color: "#ededf0",
                  fontFamily: "var(--nx-font-mono)",
                  fontSize: 9,
                  cursor: "pointer",
                  letterSpacing: "0.08em",
                  padding: 0,
                }}
              >
                MARK ALL READ
              </button>
            )}
          </div>

          {/* List */}
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {notifications.length === 0 ? (
              <div
                style={{
                  padding: "20px 14px",
                  fontFamily: "var(--nx-font-mono)",
                  fontSize: 11,
                  color: "#52525b",
                  textAlign: "center",
                }}
              >
                no notifications
              </div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid #141416",
                    background: n.readAt ? "transparent" : "#1a1a1e",
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                  }}
                >
                  <span
                    style={{ fontSize: 14, lineHeight: 1.3, flexShrink: 0 }}
                  >
                    {typeIcon(n.type)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: "var(--nx-font-mono)",
                        fontSize: 11,
                        color: n.readAt ? "#a1a1aa" : "#a1a1aa",
                        lineHeight: 1.4,
                        wordBreak: "break-word",
                      }}
                    >
                      {n.message}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--nx-font-mono)",
                        fontSize: 9,
                        color: "#33333a",
                        marginTop: 3,
                      }}
                    >
                      {relativeTime(n.createdAt)}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteNotification(n.id)}
                    title="Dismiss"
                    style={{
                      background: "none",
                      border: "none",
                      color: "#33333a",
                      cursor: "pointer",
                      fontSize: 11,
                      padding: "0 0 0 4px",
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
