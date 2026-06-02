/**
 * Lightweight unread-tracking for XMTP DMs.
 *
 * We persist a per-conversation "last read" timestamp (ms) in localStorage.
 * A conversation is unread when its most recent *inbound* message is newer
 * than that timestamp. The Messages page calls markConvoRead() when a thread
 * is opened; the nav envelope badge listens for UNREAD_EVENT to refresh.
 */

const LAST_READ_PREFIX = "xmtp_lastread_";
export const UNREAD_EVENT = "xmtp-unread-changed";

export function getLastRead(convoId: string): number {
  if (typeof window === "undefined") return 0;
  const v = window.localStorage.getItem(LAST_READ_PREFIX + convoId);
  return v ? Number(v) : 0;
}

export function markConvoRead(convoId: string, ts: number = Date.now()): void {
  if (typeof window === "undefined" || !convoId) return;
  window.localStorage.setItem(LAST_READ_PREFIX + convoId, String(ts));
  window.dispatchEvent(new Event(UNREAD_EVENT));
}

/** Convert an XMTP bigint nanosecond timestamp to milliseconds. */
export function nsToMs(sentAtNs: bigint | null | undefined): number {
  if (sentAtNs == null) return 0;
  return Number(sentAtNs / 1_000_000n);
}
