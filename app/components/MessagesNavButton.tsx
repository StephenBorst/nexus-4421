import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useXMTP } from "@/hooks/useXMTP";
import { getLastRead, nsToMs, UNREAD_EVENT } from "@/utils/xmtpUnread";

/**
 * Top-right envelope icon with an unread badge.
 *
 * Only computes unread when the XMTP client is already cached/ready — it never
 * triggers a wallet signature prompt just to render a badge. When ready, it
 * polls conversations every 45s (and on visibility/return) and counts threads
 * whose latest inbound message is newer than the stored "last read" time.
 */
export default function MessagesNavButton() {
  const { ready, getConversations, getMessages, streamAllMessages, myInboxId } = useXMTP();
  const [unread, setUnread] = useState(0);

  const compute = useCallback(async () => {
    if (!ready || (typeof document !== "undefined" && document.hidden)) return;
    try {
      const convos = await getConversations();
      let count = 0;
      // Cap to keep the poll cheap on accounts with many threads
      for (const c of convos.slice(0, 20)) {
        let msgs;
        try {
          msgs = await getMessages(c);
        } catch {
          continue;
        }
        // Find the most recent inbound (not-mine) message
        let lastInboundNs: bigint | null = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].senderInboxId !== myInboxId) {
            lastInboundNs = msgs[i].sentAtNs;
            break;
          }
        }
        if (lastInboundNs == null) continue;
        if (nsToMs(lastInboundNs) > getLastRead(c.id)) count++;
      }
      setUnread(count);
    } catch {
      /* ignore — transient sync errors */
    }
  }, [ready, getConversations, getMessages, myInboxId]);

  useEffect(() => {
    if (!ready) {
      setUnread(0);
      return;
    }
    compute();
    // Slow safety-net poll — the live stream below drives instant updates.
    const interval = setInterval(compute, 120_000);
    const onChange = () => compute();
    window.addEventListener(UNREAD_EVENT, onChange);
    document.addEventListener("visibilitychange", onChange);

    // Live stream: recompute the badge the instant any DM lands app-wide.
    let cancelled = false;
    let closer: (() => void) | null = null;
    streamAllMessages((msg) => {
      // Ignore our own outbound messages — they don't make a thread unread
      if (msg && (msg as { senderInboxId?: string }).senderInboxId === myInboxId) return;
      compute();
    })
      .then((c) => { if (cancelled) c(); else closer = c; })
      .catch(() => { /* stream unavailable — poll covers it */ });

    return () => {
      cancelled = true;
      if (closer) closer();
      clearInterval(interval);
      window.removeEventListener(UNREAD_EVENT, onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, [ready, compute, streamAllMessages, myInboxId]);

  return (
    <Link
      to="/messages"
      title="Messages"
      aria-label={unread > 0 ? `Messages, ${unread} unread` : "Messages"}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        color: "var(--oui-color-base-contrast-54, #b0b8b0)",
        textDecoration: "none",
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
        <path d="M3 6l9 7 9-7" />
      </svg>
      {unread > 0 && (
        <span
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            minWidth: 15,
            height: 15,
            padding: "0 4px",
            borderRadius: 8,
            background: "#ff4444",
            boxShadow: "0 0 6px rgba(255,68,68,0.7)",
            color: "#fff",
            fontFamily: "var(--nx-font-mono)",
            fontSize: 9,
            fontWeight: "bold",
            lineHeight: "15px",
            textAlign: "center",
            boxSizing: "border-box",
          }}
        >
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Link>
  );
}
