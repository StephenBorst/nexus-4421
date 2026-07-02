import { useState, useEffect, useRef } from "react";
import {
  fetchComments,
  fetchReactions,
  addComment,
  deleteComment,
  toggleReaction,
} from "@/hooks/useComments";
import type { Comment } from "@/hooks/useComments";

const ALLOWED_EMOJIS = ["🔥", "💎", "📉", "✅", "❌"] as const;
type AllowedEmoji = (typeof ALLOWED_EMOJIS)[number];

interface CommentsPanelProps {
  thesisId: string;
  walletAddress: string | null;
  isOpen: boolean;
  onCountChange?: (count: number) => void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

export default function CommentsPanel({
  thesisId,
  walletAddress,
  isOpen,
  onCountChange,
}: CommentsPanelProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [reactions, setReactions] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const hasLoaded = useRef(false);

  useEffect(() => {
    if (!isOpen || hasLoaded.current) return;
    hasLoaded.current = true;
    setLoading(true);
    Promise.all([fetchComments(thesisId), fetchReactions(thesisId)])
      .then(([c, r]) => {
        setComments(c);
        setReactions(r);
        onCountChange?.(c.length);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen, thesisId, onCountChange]);

  if (!isOpen) return null;

  const walletLower = walletAddress?.toLowerCase() ?? "";

  async function handleReaction(emoji: AllowedEmoji) {
    if (!walletAddress) return;
    try {
      await toggleReaction(thesisId, emoji, walletAddress);
      const updated = await fetchReactions(thesisId);
      setReactions(updated);
    } catch { /* ignore */ }
  }

  async function handleSubmit() {
    if (!walletAddress || !text.trim()) return;
    setSubmitting(true);
    setErr("");
    try {
      await addComment(thesisId, walletAddress, text.trim());
      const updated = await fetchComments(thesisId);
      setComments(updated);
      onCountChange?.(updated.length);
      setText("");
    } catch {
      setErr("failed to post comment");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(commentId: string) {
    if (!walletAddress) return;
    try {
      await deleteComment(thesisId, commentId, walletAddress);
      const filtered = comments.filter((c) => c.id !== commentId);
      setComments(filtered);
      onCountChange?.(filtered.length);
    } catch { /* ignore */ }
  }

  return (
    <div style={{ borderTop: "1px solid #1a2e1a", padding: "12px 16px", background: "#080c08" }}>
      {/* Reaction bar */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {ALLOWED_EMOJIS.map((emoji) => {
          const wallets: string[] = reactions[emoji] ?? [];
          const reacted = walletLower ? wallets.includes(walletLower) : false;
          return (
            <button
              key={emoji}
              onClick={() => handleReaction(emoji)}
              disabled={!walletAddress}
              style={{
                background: reacted ? "#0a1a0a" : "#080c08",
                border: `1px solid ${reacted ? "#00ff88" : "#1a2e1a"}`,
                borderRadius: 20,
                color: reacted ? "#00ff88" : "#8aaa9a",
                fontFamily: "var(--nx-font-mono)",
                fontSize: 13,
                padding: "3px 10px",
                cursor: walletAddress ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              {emoji}
              {wallets.length > 0 && (
                <span style={{ fontSize: 10, color: reacted ? "#00ff88" : "#8aaa9a" }}>
                  {wallets.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Comment list */}
      {loading ? (
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#2a4a3a", paddingBottom: 10 }}>
          loading...
        </div>
      ) : comments.length === 0 ? (
        <div style={{
          fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#2a4a3a",
          textAlign: "center", padding: "8px 0 12px",
        }}>
          No comments yet.
        </div>
      ) : (
        <div style={{
          display: "flex", flexDirection: "column", gap: 6,
          marginBottom: 12, maxHeight: 260, overflowY: "auto",
        }}>
          {comments.map((c) => {
            const isOwn = c.wallet === walletLower;
            return (
              <div key={c.id} style={{
                background: "#0a0e0a",
                border: "1px solid #1a2e1a",
                borderRadius: 3,
                padding: "7px 10px",
              }}>
                <div style={{
                  display: "flex", justifyContent: "space-between",
                  alignItems: "center", marginBottom: 3,
                }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#3a5a4a" }}>
                    {shortWallet(c.wallet)}
                    <span style={{ marginLeft: 8, color: "#2a4a3a" }}>
                      {relativeTime(c.createdAt)}
                    </span>
                  </span>
                  {isOwn && (
                    <button
                      onClick={() => handleDelete(c.id)}
                      title="Delete comment"
                      style={{
                        background: "none", border: "none",
                        color: "#3a5a4a", cursor: "pointer",
                        fontFamily: "var(--nx-font-mono)", fontSize: 10,
                        padding: 0, lineHeight: 1,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div style={{
                  fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#8aaa9a",
                  lineHeight: 1.5, wordBreak: "break-word",
                }}>
                  {c.text}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Comment input — only when wallet connected */}
      {walletAddress && (
        <div>
          <div style={{ position: "relative" }}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 280))}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !submitting && text.trim()) {
                  void handleSubmit();
                }
              }}
              placeholder="Add a comment..."
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: "#0a0e0a",
                border: "1px solid #1a2e1a",
                borderRadius: 3,
                color: "#00ff88",
                fontFamily: "var(--nx-font-mono)",
                fontSize: 11,
                padding: "7px 10px",
                paddingRight: 44,
                resize: "vertical",
                minHeight: 52,
                outline: "none",
              }}
            />
            <span style={{
              position: "absolute", bottom: 6, right: 8,
              fontFamily: "var(--nx-font-mono)", fontSize: 9,
              color: text.length >= 260 ? "#fbbf24" : "#2a4a3a",
              pointerEvents: "none",
            }}>
              {text.length}/280
            </span>
          </div>
          {err && (
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#ff4444", marginTop: 4 }}>
              {err}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <button
              onClick={() => void handleSubmit()}
              disabled={submitting || !text.trim()}
              style={{
                background: text.trim() && !submitting ? "#0a1a0a" : "#080c08",
                border: `1px solid ${text.trim() && !submitting ? "#00ff88" : "#1a2e1a"}`,
                color: text.trim() && !submitting ? "#00ff88" : "#2a4a3a",
                fontFamily: "var(--nx-font-mono)",
                fontSize: 10,
                padding: "5px 14px",
                cursor: text.trim() && !submitting ? "pointer" : "default",
                borderRadius: 3,
                letterSpacing: "0.05em",
              }}
            >
              {submitting ? "sending..." : "SEND →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
