// SocialBar — the native, inline social layer for a call (thesis), used on the feed,
// trader profiles, and call permalinks so engagement looks/behaves identically. Real-
// feed behaviour (X / Instagram / Slack), no pop-ups:
//   • 🔥 Like is a ONE-TAP optimistic toggle. Extra reactions (💎 📉 ✅ ❌) live as
//     Slack-style inline chips + a 😀 add-picker — one tap each, no panel.
//   • Comments are INLINE — a "view N comments" expander + an "Add a comment…" line.
//     Your own comment appears INSTANTLY (optimistic) before the round-trip.
//   • A "· N new" nudge pulses on the Comment action when the count rises while you're
//     looking (live polling feeds it), so live actually feels live.
//   • Every action is LABELLED on every breakpoint — no hover-only meaning.
// Counts come from the feed's batched /comments/counts call (or a self-fetch when the
// host surface doesn't batch — `autoload`). Open threads poll for live updates.
import { useState, useEffect, useRef } from "react";
import { fetchComments, fetchReactions, addComment, deleteComment, toggleReaction, type Comment } from "@/hooks/useComments";

const LIKE = "🔥";
const EXTRA = ["💎", "📉", "✅", "❌"]; // secondary reactions (the 🔥 like has its own button)

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "now";
}
const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;

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
  initialReactions, initialYouReacted, initialCommentCount = 0,
  shareHref, onCopy, canCopy, onMessage, canMessage, autoload = false, defaultOpen = false,
}: {
  thesisId: string;
  walletAddress: string | null;
  authorWallet?: string;
  symbol?: string;
  direction?: string;
  initialReactions?: Record<string, number>;
  initialYouReacted?: string[];
  initialCommentCount?: number;
  shareHref?: string;
  onCopy?: () => void;
  canCopy?: boolean;
  onMessage?: () => void;
  canMessage?: boolean;
  // Surfaces without a batched social fetch (trader profiles) set this so the bar fetches
  // its own reactions + comments on mount. The feed leaves it off and seeds from the
  // batched /comments/counts call instead (no per-card requests).
  autoload?: boolean;
  // Dedicated pages (a call's permalink) show the thread expanded from the start.
  defaultOpen?: boolean;
}) {
  const [reactions, setReactions] = useState<Record<string, number>>(initialReactions ?? {});
  const [youReacted, setYouReacted] = useState<string[]>(initialYouReacted ?? []);
  const [count, setCount] = useState(initialCommentCount);
  const [open, setOpen] = useState(defaultOpen);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [palette, setPalette] = useState(false);
  const [seen, setSeen] = useState(initialCommentCount);

  const walletLower = walletAddress?.toLowerCase() ?? "";

  // Once you tap a reaction, your local state is authoritative — a live poll landing
  // mid-flight must not stomp the optimistic toggle back. Comment count syncs live
  // regardless (it isn't affected by the reaction race).
  const interacted = useRef(false);
  useEffect(() => {
    if (!interacted.current) { setReactions(initialReactions ?? {}); setYouReacted(initialYouReacted ?? []); }
  }, [initialReactions, initialYouReacted]);
  useEffect(() => { setCount(initialCommentCount); }, [initialCommentCount]);

  // While the thread is open you've "seen" everything, so the nudge tracks the count;
  // once closed, new comments arriving (via polling) push count past `seen` → "· N new".
  useEffect(() => { if (open) setSeen(count); }, [open, count]);
  const newN = !open ? Math.max(0, count - seen) : 0;

  // Self-fetch reactions + comments when the host surface doesn't batch them.
  useEffect(() => {
    if (!autoload) return;
    let dead = false;
    Promise.all([fetchComments(thesisId), fetchReactions(thesisId)]).then(([c, r]) => {
      if (dead) return;
      setComments(c); setCount(c.length); setSeen(c.length); setLoaded(true);
      if (interacted.current) return;
      const counts: Record<string, number> = {}; const you: string[] = [];
      for (const [emoji, list] of Object.entries(r)) {
        const arr = Array.isArray(list) ? list : [];
        if (arr.length) counts[emoji] = arr.length;
        if (walletLower && arr.some((w) => String(w).toLowerCase() === walletLower)) you.push(emoji);
      }
      setReactions(counts); setYouReacted(you);
    }).catch(() => { /* ignore */ });
    return () => { dead = true; };
  }, [autoload, thesisId, walletLower]);

  // Live thread — while comments are open, poll for new ones so the discussion updates
  // in place with no manual refresh. Pauses while the tab is hidden.
  useEffect(() => {
    if (!open) return;
    const iv = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchComments(thesisId).then((c) => { setComments(c); setCount(c.length); }).catch(() => { /* ignore */ });
    }, 12000);
    return () => clearInterval(iv);
  }, [open, thesisId]);

  async function react(emoji: string) {
    if (!walletAddress) return;
    interacted.current = true;
    setPalette(false);
    const has = youReacted.includes(emoji);
    setYouReacted((y) => (has ? y.filter((e) => e !== emoji) : [...y, emoji]));       // optimistic
    setReactions((r) => ({ ...r, [emoji]: Math.max(0, (r[emoji] || 0) + (has ? -1 : 1)) }));
    try { await toggleReaction(thesisId, emoji, walletAddress, { authorWallet, symbol, direction }); }
    catch {
      setYouReacted((y) => (has ? [...y, emoji] : y.filter((e) => e !== emoji)));
      setReactions((r) => ({ ...r, [emoji]: Math.max(0, (r[emoji] || 0) + (has ? 1 : -1)) }));
    }
  }

  async function loadThread() {
    if (loaded) return;
    setLoading(true);
    try { const c = await fetchComments(thesisId); setComments(c); setCount(c.length); setLoaded(true); }
    catch { /* ignore */ } finally { setLoading(false); }
  }
  function toggleThread() { const next = !open; setOpen(next); if (next && !loaded) void loadThread(); }

  async function submit() {
    if (!walletAddress || !text.trim() || busy) return;
    const bodyText = text.trim();
    const temp: Comment = { id: `temp_${Date.now()}`, wallet: walletLower, text: bodyText, createdAt: Date.now() };
    setComments((cs) => [temp, ...cs]);   // optimistic — your comment appears instantly (newest-first)
    setCount((n) => n + 1);
    setText(""); setOpen(true); setLoaded(true); setBusy(true);
    try {
      await addComment(thesisId, walletAddress, bodyText, { authorWallet, symbol, direction });
      const c = await fetchComments(thesisId); setComments(c); setCount(c.length);   // reconcile
    } catch {
      setComments((cs) => cs.filter((x) => x.id !== temp.id)); setCount((n) => Math.max(0, n - 1)); setText(bodyText);
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!walletAddress) return;
    try { await deleteComment(thesisId, id, walletAddress); const c = comments.filter((x) => x.id !== id); setComments(c); setCount(c.length); }
    catch { /* ignore */ }
  }

  const likeCount = reactions[LIKE] || 0;
  const chips = EXTRA.filter((e) => (reactions[e] || 0) > 0);

  return (
    <div style={{ borderTop: "1px solid #232327", marginTop: 8 }}>
      {/* Action bar — labelled, native, always visible */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap", padding: "6px 2px" }}>
        <Action icon="🔥" label={`Like${likeCount ? ` ${likeCount}` : ""}`} onClick={() => react(LIKE)} active={youReacted.includes(LIKE)} />
        <Action icon="💬" label={`Comment${count ? ` ${count}` : ""}${newN ? ` · ${newN} new` : ""}`} onClick={toggleThread} active={open || newN > 0} />
        {shareHref && <Action icon="↗" label="Share" href={shareHref} />}
        {canCopy && onCopy && <Action icon="📋" label="Copy" onClick={onCopy} />}
        {canMessage && onMessage && <Action icon="⬡" label="Message" onClick={onMessage} />}
        {walletAddress && <Action icon="😀" label="React" onClick={() => setPalette((p) => !p)} active={palette} />}
      </div>

      {/* Reaction chips (Slack-style) + the add-a-reaction palette */}
      {(chips.length > 0 || palette) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "0 4px 6px" }}>
          {chips.map((e) => {
            const mine = youReacted.includes(e);
            return (
              <button key={e} onClick={(ev) => { ev.stopPropagation(); react(e); }} title={mine ? "Remove reaction" : "React"}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, background: mine ? "#1a1a1e" : "#0a0a0b", border: `1px solid ${mine ? "#ededf0" : "#232327"}`, borderRadius: 20, color: mine ? "#ededf0" : "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 12, padding: "3px 9px", cursor: "pointer" }}>
                {e}<span style={{ fontSize: 10 }}>{reactions[e]}</span>
              </button>
            );
          })}
          {palette && EXTRA.map((e) => (
            <button key={e} onClick={(ev) => { ev.stopPropagation(); react(e); }} title="React"
              style={{ background: "none", border: "1px dashed #33333a", borderRadius: 20, fontSize: 14, padding: "2px 8px", cursor: "pointer", opacity: youReacted.includes(e) ? 1 : 0.7 }}>
              {e}
            </button>
          ))}
        </div>
      )}

      {/* Inline thread — loads in place when expanded, no pop-up */}
      {open && (
        <div style={{ padding: "2px 2px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          {loading && <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#52525b" }}>loading…</div>}
          {!loading && comments.length === 0 && (
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#52525b" }}>No comments yet — start the discussion.</div>
          )}
          {comments.map((c) => {
            const pending = c.id.startsWith("temp_");
            return (
              <div key={c.id} style={{ background: "#0a0a0b", border: "1px solid #232327", borderRadius: 5, padding: "7px 10px", opacity: pending ? 0.6 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>
                    {short(c.wallet)}<span style={{ marginLeft: 8, color: "#33333a" }}>{pending ? "sending…" : relTime(c.createdAt)}</span>
                  </span>
                  {!pending && c.wallet === walletLower && (
                    <button onClick={() => remove(c.id)} title="Delete" style={{ background: "none", border: "none", color: "#52525b", cursor: "pointer", fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: 0 }}>✕</button>
                  )}
                </div>
                <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", lineHeight: 1.5, wordBreak: "break-word" }}>{c.text}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Compose — inline when comments are open (keeps a dense feed clean), not a pop-up */}
      {walletAddress && open && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "0 2px 8px" }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 280))}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }}
            placeholder="Add a comment…"
            style={{ flex: 1, minWidth: 0, background: "#0a0a0b", border: "1px solid #232327", borderRadius: 20, color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 11, padding: "7px 12px", outline: "none" }}
          />
          {text.trim() && (
            <button onClick={submit} disabled={busy} style={{ flexShrink: 0, background: "#1a1a1e", border: "1px solid #ededf0", color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "6px 12px", borderRadius: 20, cursor: busy ? "wait" : "pointer", letterSpacing: "0.04em" }}>{busy ? "…" : "Post"}</button>
          )}
        </div>
      )}
    </div>
  );
}
