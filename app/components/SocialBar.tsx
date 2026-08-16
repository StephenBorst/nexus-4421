// SocialBar — the native, inline social layer for a call (thesis), used on the feed
// AND on trader profiles so engagement looks/behaves identically everywhere. Modelled
// on how real feeds work (X / Instagram):
//   • 🔥 Like is a ONE-TAP toggle (optimistic) — no panel opens.
//   • Comments are INLINE — an always-present "Add a comment…" line + a "view N
//     comments" expander that loads the thread in place. No pop-ups, no modal.
//   • Every action carries a label (Like / Comment / Share / Copy / Message) on every
//     breakpoint — no hover-only meaning, so desktop and phone read the same.
// Initial like/comment counts come from the feed's batched /comments/counts call, so
// the bar shows real numbers immediately; the thread lazy-loads only when expanded.
import { useState, useEffect } from "react";
import { fetchComments, fetchReactions, addComment, deleteComment, toggleReaction, type Comment } from "@/hooks/useComments";

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "now";
}
const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;

// One quiet action button — label always shown (native, no hover-only meaning).
function Action({ icon, label, onClick, active, href }: {
  icon: string; label: string; onClick?: () => void; active?: boolean; href?: string;
}) {
  const style: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "none",
    color: active ? "#ededf0" : "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 11,
    cursor: "pointer", padding: "6px 8px", borderRadius: 6, letterSpacing: "0.02em",
    textDecoration: "none", whiteSpace: "nowrap",
  };
  const body = <><span style={{ fontSize: 13, lineHeight: 1 }}>{icon}</span>{label}</>;
  return href
    ? <a className="nx-btn" href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={style}>{body}</a>
    : <button className="nx-btn" onClick={(e) => { e.stopPropagation(); onClick?.(); }} style={style}>{body}</button>;
}

export function SocialBar({
  thesisId, walletAddress, authorWallet, symbol, direction,
  initialLikes = 0, initialYouLiked = false, initialCommentCount = 0,
  shareHref, onCopy, canCopy, onMessage, canMessage, autoload = false, defaultOpen = false,
}: {
  thesisId: string;
  walletAddress: string | null;
  authorWallet?: string;
  symbol?: string;
  direction?: string;
  initialLikes?: number;
  initialYouLiked?: boolean;
  initialCommentCount?: number;
  shareHref?: string;
  onCopy?: () => void;
  canCopy?: boolean;
  onMessage?: () => void;
  canMessage?: boolean;
  // Surfaces without a batched social fetch (e.g. trader profiles) set this so the bar
  // fetches its own like + comment counts on mount. The feed leaves it off and seeds
  // from the batched /comments/counts call instead (no per-card requests).
  autoload?: boolean;
  // Dedicated pages (a call's permalink) show the thread expanded from the start.
  defaultOpen?: boolean;
}) {
  const [likes, setLikes] = useState(initialLikes);
  const [youLiked, setYouLiked] = useState(initialYouLiked);
  const [count, setCount] = useState(initialCommentCount);
  useEffect(() => { setLikes(initialLikes); setYouLiked(initialYouLiked); }, [initialLikes, initialYouLiked]);
  useEffect(() => { setCount(initialCommentCount); }, [initialCommentCount]);

  const [open, setOpen] = useState(defaultOpen);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const walletLower = walletAddress?.toLowerCase() ?? "";

  // Self-fetch counts when the host surface doesn't batch them (autoload).
  useEffect(() => {
    if (!autoload) return;
    let dead = false;
    Promise.all([fetchComments(thesisId), fetchReactions(thesisId)]).then(([c, r]) => {
      if (dead) return;
      setComments(c); setCount(c.length); setLoaded(true);
      const fire: string[] = Array.isArray(r["🔥"]) ? r["🔥"] : [];
      setLikes(fire.length);
      setYouLiked(walletLower ? fire.some((w) => String(w).toLowerCase() === walletLower) : false);
    }).catch(() => { /* ignore */ });
    return () => { dead = true; };
  }, [autoload, thesisId, walletLower]);

  async function like() {
    if (!walletAddress) return;
    const next = !youLiked;
    setYouLiked(next);                       // optimistic
    setLikes((n) => Math.max(0, n + (next ? 1 : -1)));
    try { await toggleReaction(thesisId, "🔥", walletAddress); }
    catch { setYouLiked(!next); setLikes((n) => Math.max(0, n + (next ? -1 : 1))); }
  }

  async function loadThread() {
    if (loaded) return;
    setLoading(true);
    try { const c = await fetchComments(thesisId); setComments(c); setCount(c.length); setLoaded(true); }
    catch { /* ignore */ } finally { setLoading(false); }
  }

  function toggleThread() {
    const next = !open;
    setOpen(next);
    if (next && !loaded) void loadThread();
  }

  async function submit() {
    if (!walletAddress || !text.trim() || busy) return;
    setBusy(true);
    try {
      await addComment(thesisId, walletAddress, text.trim(), { authorWallet, symbol, direction });
      const c = await fetchComments(thesisId);
      setComments(c); setCount(c.length); setText(""); setOpen(true); setLoaded(true);
    } catch { /* ignore */ } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!walletAddress) return;
    try { await deleteComment(thesisId, id, walletAddress); const c = comments.filter((x) => x.id !== id); setComments(c); setCount(c.length); }
    catch { /* ignore */ }
  }

  return (
    <div style={{ borderTop: "1px solid #232327", marginTop: 8 }}>
      {/* Action bar — labelled, native, always visible */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap", padding: "6px 2px" }}>
        <Action icon="🔥" label={`Like${likes ? ` ${likes}` : ""}`} onClick={like} active={youLiked} />
        <Action icon="💬" label={`Comment${count ? ` ${count}` : ""}`} onClick={toggleThread} active={open} />
        {shareHref && <Action icon="↗" label="Share" href={shareHref} />}
        {canCopy && onCopy && <Action icon="📋" label="Copy" onClick={onCopy} />}
        {canMessage && onMessage && <Action icon="⬡" label="Message" onClick={onMessage} />}
      </div>

      {/* Inline thread — loads in place when expanded, no pop-up */}
      {open && (
        <div style={{ padding: "2px 2px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          {loading && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#52525b" }}>loading…</div>}
          {!loading && comments.length === 0 && (
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#52525b" }}>No comments yet — start the discussion.</div>
          )}
          {comments.map((c) => (
            <div key={c.id} style={{ background: "#0a0a0b", border: "1px solid #232327", borderRadius: 5, padding: "7px 10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>
                  {short(c.wallet)}<span style={{ marginLeft: 8, color: "#33333a" }}>{relTime(c.createdAt)}</span>
                </span>
                {c.wallet === walletLower && (
                  <button onClick={() => remove(c.id)} title="Delete" style={{ background: "none", border: "none", color: "#52525b", cursor: "pointer", fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: 0 }}>✕</button>
                )}
              </div>
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", lineHeight: 1.5, wordBreak: "break-word" }}>{c.text}</div>
            </div>
          ))}
        </div>
      )}

      {/* Compose — always present when connected (Instagram-style), not a pop-up */}
      {walletAddress && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "0 2px 8px" }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 280))}
            onFocus={() => { if (!loaded) void loadThread(); setOpen(true); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }}
            placeholder="Add a comment…"
            style={{
              flex: 1, minWidth: 0, background: "#0a0a0b", border: "1px solid #232327", borderRadius: 20,
              color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 11, padding: "7px 12px", outline: "none",
            }}
          />
          {text.trim() && (
            <button onClick={submit} disabled={busy} style={{
              flexShrink: 0, background: "#1a1a1e", border: "1px solid #ededf0", color: "#ededf0",
              fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "6px 12px", borderRadius: 20,
              cursor: busy ? "wait" : "pointer", letterSpacing: "0.04em",
            }}>{busy ? "…" : "Post"}</button>
          )}
        </div>
      )}
    </div>
  );
}
