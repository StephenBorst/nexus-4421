/**
 * /messages — XMTP encrypted wallet-to-wallet DMs
 *
 * URL: /messages          — inbox (conversation list)
 * URL: /messages?dm=0x…   — auto-opens a DM with that wallet address
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useAccount } from "@orderly.network/hooks";
import { useXMTP } from "@/hooks/useXMTP";
import type { Conversation, DecodedMessage } from "@/hooks/useXMTP";
import { markConvoRead } from "@/utils/xmtpUnread";

// ─── Responsive hook ───────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  if (addr.length === 42 && addr.startsWith("0x")) {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }
  return `${addr.slice(0, 8)}…`;
}

function relativeTime(sentAtNs: bigint | null | undefined): string {
  if (sentAtNs == null) return "";
  const ms = Number(sentAtNs / 1_000_000n);
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function msgText(msg: DecodedMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return "[unsupported content]";
}

// Resolve peer wallet address from conversation members
async function resolvePeer(convo: Conversation, myInboxId: string | null): Promise<string | null> {
  try {
    const members = await convo.members();
    const peer = members.find((m) => m.inboxId !== myInboxId);
    return peer?.accountIdentifiers?.[0]?.identifier ?? null;
  } catch {
    return null;
  }
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const S = {
  page: {
    background: "#0a0a0b",
    minHeight: "100svh",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    padding: "8px 16px",
    borderBottom: "1px solid #232327",
    background: "#0f0f11",
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  headerLabel: {
    fontFamily: "var(--nx-font-mono)",
    fontSize: 9,
    letterSpacing: "0.12em",
    color: "#52525b",
  },
  backBtn: {
    background: "none",
    border: "none",
    color: "#ededf0",
    fontFamily: "var(--nx-font-mono)",
    fontSize: 18,
    lineHeight: 1,
    cursor: "pointer",
    padding: "2px 8px 2px 0",
    marginRight: 2,
  },
  body: {
    flex: 1,
    display: "flex",
    overflow: "hidden",
    height: "calc(100dvh - 42px)",
  },
  sidebar: {
    width: 260,
    borderRight: "1px solid #232327",
    display: "flex",
    flexDirection: "column" as const,
    background: "#0f0f11",
    flexShrink: 0,
  },
  sidebarHeader: {
    padding: "10px 14px",
    borderBottom: "1px solid #232327",
    fontFamily: "var(--nx-font-mono)",
    fontSize: 9,
    letterSpacing: "0.1em",
    color: "#52525b",
  },
  convoList: {
    flex: 1,
    overflowY: "auto" as const,
  },
  convoItem: (active: boolean): React.CSSProperties => ({
    padding: "12px 14px",
    borderBottom: "1px solid #141416",
    cursor: "pointer",
    background: active ? "#1a1a1e" : "transparent",
    borderLeft: active ? "2px solid #ededf0" : "2px solid transparent",
  }),
  convoName: {
    fontFamily: "var(--nx-font-mono)",
    fontSize: 11,
    color: "#a1a1aa",
    marginBottom: 2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  convoPreview: {
    fontFamily: "var(--nx-font-mono)",
    fontSize: 9,
    color: "#52525b",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  thread: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
  },
  threadHeader: {
    padding: "10px 16px",
    borderBottom: "1px solid #232327",
    background: "#0f0f11",
    fontFamily: "var(--nx-font-mono)",
    fontSize: 11,
    color: "#a1a1aa",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  messages: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  bubble: (isMine: boolean): React.CSSProperties => ({
    maxWidth: "72%",
    alignSelf: isMine ? "flex-end" : "flex-start",
    background: isMine ? "#1a1a1e" : "#0f0f11",
    border: `1px solid ${isMine ? "#33333a" : "#232327"}`,
    borderRadius: isMine ? "8px 8px 0 8px" : "8px 8px 8px 0",
    padding: "8px 12px",
  }),
  bubbleText: (isMine: boolean): React.CSSProperties => ({
    fontFamily: "var(--nx-font-mono)",
    fontSize: 11,
    color: isMine ? "#ededf0" : "#a1a1aa",
    lineHeight: 1.5,
    wordBreak: "break-word" as const,
  }),
  bubbleTime: {
    fontFamily: "var(--nx-font-mono)",
    fontSize: 8,
    color: "#33333a",
    marginTop: 4,
    textAlign: "right" as const,
  },
  compose: {
    padding: "10px 16px",
    borderTop: "1px solid #232327",
    background: "#0f0f11",
    display: "flex",
    gap: 8,
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    background: "#141416",
    border: "1px solid #232327",
    borderRadius: 4,
    color: "#ededf0",
    fontFamily: "var(--nx-font-mono)",
    fontSize: 11,
    padding: "8px 10px",
    outline: "none",
    resize: "none" as const,
    minHeight: 38,
    maxHeight: 120,
  },
  sendBtn: (disabled: boolean): React.CSSProperties => ({
    background: disabled ? "#0f0f11" : "#1a1a1e",
    border: `1px solid ${disabled ? "#232327" : "#ededf0"}`,
    borderRadius: 4,
    color: disabled ? "#33333a" : "#ededf0",
    fontFamily: "var(--nx-font-mono)",
    fontSize: 9,
    letterSpacing: "0.08em",
    padding: "8px 14px",
    cursor: disabled ? "default" : "pointer",
    flexShrink: 0,
    alignSelf: "flex-end",
  }),
  center: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    gap: 12,
    padding: 32,
  },
  centerLabel: {
    fontFamily: "var(--nx-font-mono)",
    fontSize: 11,
    color: "#52525b",
    textAlign: "center" as const,
    lineHeight: 1.6,
    maxWidth: 320,
  },
  enableBtn: {
    background: "#1a1a1e",
    border: "1px solid #ededf0",
    borderRadius: 4,
    color: "#ededf0",
    fontFamily: "var(--nx-font-mono)",
    fontSize: 10,
    letterSpacing: "0.1em",
    padding: "10px 24px",
    cursor: "pointer",
  },
  errText: {
    fontFamily: "var(--nx-font-mono)",
    fontSize: 9,
    color: "#f7525f",
    textAlign: "center" as const,
    maxWidth: 320,
  },
};

// ─── Conversation Item ────────────────────────────────────────────────────────

function ConvoItem({
  convo,
  active,
  myInboxId,
  onClick,
}: {
  convo: Conversation;
  active: boolean;
  myInboxId: string | null;
  onClick: () => void;
}) {
  const [lastMsg, setLastMsg] = useState<DecodedMessage | null>(null);
  const [peerDisplay, setPeerDisplay] = useState<string>(shortAddr(convo.id));

  useEffect(() => {
    // Last message preview
    convo.messages({ limit: 1n }).then((msgs) => {
      if (msgs.length > 0) setLastMsg(msgs[msgs.length - 1]);
    }).catch(() => {});
    // Resolve peer wallet address from conversation members
    resolvePeer(convo, myInboxId).then((addr) => {
      if (addr) setPeerDisplay(shortAddr(addr));
    });
  }, [convo, myInboxId]);

  return (
    <div style={S.convoItem(active)} onClick={onClick}>
      <div style={S.convoName}>{peerDisplay}</div>
      {lastMsg && (
        <div style={S.convoPreview}>
          {msgText(lastMsg).slice(0, 48)}{msgText(lastMsg).length > 48 ? "…" : ""}
        </div>
      )}
    </div>
  );
}

// ─── Thread View ──────────────────────────────────────────────────────────────

function ThreadView({
  convo,
  myInboxId,
  getMessages,
  streamMessages,
  peerAddressHint,
}: {
  convo: Conversation;
  myInboxId: string | null;
  getMessages: (c: Conversation) => Promise<DecodedMessage[]>;
  streamMessages: (c: Conversation, onMessage: (msg: DecodedMessage) => void) => Promise<() => void>;
  peerAddressHint?: string;
}) {
  const [messages, setMessages] = useState<DecodedMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [peerDisplay, setPeerDisplay] = useState<string>(
    peerAddressHint ? shortAddr(peerAddressHint) : shortAddr(convo.id)
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!peerAddressHint) {
      resolvePeer(convo, myInboxId).then((addr) => {
        if (addr) setPeerDisplay(shortAddr(addr));
      });
    }
  }, [convo, myInboxId, peerAddressHint]);

  const loadMessages = useCallback(async () => {
    try {
      const msgs = await getMessages(convo);
      setMessages(msgs);
    } catch {
      // silent — stale state is fine
    }
  }, [convo, getMessages]);

  useEffect(() => {
    loadMessages();
    // Slow safety-net poll — the live stream below handles real-time delivery,
    // this just reconciles if the stream ever drops.
    pollRef.current = setInterval(loadMessages, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadMessages]);

  // Real-time message stream — near-instant inbound, no polling delay.
  useEffect(() => {
    let cancelled = false;
    let closer: (() => void) | null = null;
    streamMessages(convo, (msg) => {
      setMessages((prev) => {
        const mid = (msg as { id?: string }).id;
        // Drop optimistic placeholders and skip if we already have this id
        const base = prev.filter((m) => !String((m as { id?: string }).id ?? "").startsWith("optimistic_"));
        if (mid && base.some((m) => (m as { id?: string }).id === mid)) return base;
        return [...base, msg];
      });
    })
      .then((c) => { if (cancelled) c(); else closer = c; })
      .catch(() => { /* stream unavailable — safety-net poll covers it */ });
    return () => { cancelled = true; if (closer) closer(); };
  }, [convo, streamMessages]);

  // Mark this thread read while it's open (clears the nav unread badge)
  useEffect(() => {
    markConvoRead(convo.id);
  }, [convo.id, messages.length]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setSendError(null);

    // Optimistic render — show the message instantly, reconcile on next load.
    const optimistic = {
      id: `optimistic_${Date.now()}`,
      senderInboxId: myInboxId,
      content: trimmed,
      sentAtNs: BigInt(Date.now()) * 1_000_000n,
    } as unknown as DecodedMessage;
    setMessages((prev) => [...prev, optimistic]);
    setText("");

    try {
      await convo.sendText(trimmed);
      await loadMessages();
    } catch (e) {
      // Roll back the optimistic bubble and let the user retry
      setMessages((prev) => prev.filter((m) => (m as { id?: string }).id !== optimistic.id));
      setText(trimmed);
      setSendError(e instanceof Error ? e.message : "Message failed to send. Try again.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      <div style={S.threadHeader}>
        <span style={{ color: "#ededf0", fontSize: 10 }}>⬡</span>
        {peerDisplay}
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#33333a", marginLeft: "auto" }}>
          end-to-end encrypted · XMTP
        </span>
      </div>

      <div style={S.messages}>
        {messages.length === 0 && (
          <div style={{ ...S.centerLabel, alignSelf: "center", marginTop: 40 }}>
            no messages yet — say something
          </div>
        )}
        {messages.map((msg, i) => {
          const isMine = msg.senderInboxId === myInboxId;
          return (
            <div key={i} style={S.bubble(isMine)}>
              <div style={S.bubbleText(isMine)}>{msgText(msg)}</div>
              <div style={S.bubbleTime}>{relativeTime(msg.sentAtNs)}</div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {sendError && (
        <div style={{ padding: "5px 12px", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#f7525f" }}>
          {sendError}
        </div>
      )}
      <div style={S.compose}>
        <textarea
          style={S.input}
          placeholder="message... (enter to send)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
        />
        <button
          style={S.sendBtn(!text.trim() || sending)}
          onClick={send}
          disabled={!text.trim() || sending}
        >
          {sending ? "..." : "SEND →"}
        </button>
      </div>
    </>
  );
}

// ─── Messages Page ────────────────────────────────────────────────────────────

export default function MessagesPage() {
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // Reliable back: step out of an open thread first; else history; else home feed.
  const goBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) navigate(-1);
    else navigate("/feed");
  }, [navigate]);
  const dmParam = searchParams.get("dm");

  const xmtp = useXMTP();
  const { ready, initializing, error, init, getConversations, getMessages, streamMessages, myInboxId } = xmtp;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvo, setActiveConvo] = useState<Conversation | null>(null);
  const isMobile = useIsMobile();
  const [activePeerHint, setActivePeerHint] = useState<string | undefined>(undefined);
  const [loadingConvos, setLoadingConvos] = useState(false);
  const [dmAddress, setDmAddress] = useState("");
  const [openingDM, setOpeningDM] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  const [inviteAddr, setInviteAddr] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  // Load conversations once XMTP is ready
  useEffect(() => {
    if (!ready) return;
    setLoadingConvos(true);
    getConversations()
      .then(async (convos) => {
        setConversations(convos);
        // Auto-open ?dm= conversation
        if (dmParam) {
          // Check if a convo with this peer already exists
          let found: Conversation | null = null;
          for (const c of convos) {
            const peer = await resolvePeer(c, myInboxId);
            if (peer?.toLowerCase() === dmParam.toLowerCase()) {
              found = c;
              break;
            }
          }
          if (found) {
            setActiveConvo(found);
            setActivePeerHint(dmParam);
          } else {
            // Create a new DM
            xmtp.openDM(dmParam)
              .then((convo) => {
                setActiveConvo(convo);
                setActivePeerHint(dmParam);
                setConversations((prev) => [convo, ...prev]);
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoadingConvos(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  async function startDM() {
    const addr = dmAddress.trim();
    if (!addr || openingDM) return;
    setDmError(null);
    setInviteAddr(null);

    // Validate address shape before hitting the network
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      setDmError("Enter a valid 0x wallet address (42 chars).");
      return;
    }
    if (addr.toLowerCase() === (xmtp.myAddress ?? "").toLowerCase()) {
      setDmError("That's your own address — pick a different wallet.");
      return;
    }

    setOpeningDM(true);
    try {
      // XMTP can only message wallets that have registered an XMTP identity.
      // Check first so we can offer an invite instead of failing silently.
      const reachable = await xmtp.canMessage(addr);
      if (!reachable) {
        setInviteAddr(addr);
        return;
      }
      const convo = await xmtp.openDM(addr);
      setActiveConvo(convo);
      setActivePeerHint(addr);
      setConversations((prev) => {
        const already = prev.find((c) => c.id === convo.id);
        return already ? prev : [convo, ...prev];
      });
      setDmAddress("");
    } catch (e) {
      setDmError(e instanceof Error ? e.message : "Couldn't start that conversation. Try again.");
    } finally {
      setOpeningDM(false);
    }
  }

  if (!walletAddress) {
    return (
      <div style={S.page}>
        <div style={S.header}>
          <button onClick={goBack} style={S.backBtn} aria-label="Back" title="Back">‹</button>
          <span style={S.headerLabel}>■ MESSAGES</span>
        </div>
        <div style={S.center}>
          <div style={S.centerLabel}>connect your wallet to use encrypted messaging</div>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div style={S.page}>
        <div style={S.header}>
          <button onClick={goBack} style={S.backBtn} aria-label="Back" title="Back">‹</button>
          <span style={S.headerLabel}>■ MESSAGES</span>
        </div>
        <div style={S.center}>
          <div style={{ fontSize: 24, color: "#232327" }}>⬡</div>
          <div style={S.centerLabel}>
            wallet-to-wallet encrypted DMs powered by XMTP
            <br />
            <span style={{ color: "#33333a", fontSize: 9 }}>
              you'll sign twice — once for the encryption key, once to register
            </span>
          </div>
          {error && <div style={S.errText}>{error}</div>}
          <button style={S.enableBtn} onClick={init} disabled={initializing}>
            {initializing ? "enabling..." : "ENABLE MESSAGING"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <div style={S.header}>
        <button onClick={goBack} style={S.backBtn} aria-label="Back" title="Back">‹</button>
        <span style={S.headerLabel}>■ MESSAGES</span>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#33333a", marginLeft: "auto" }}>
          ⬡ XMTP · end-to-end encrypted
        </span>
      </div>

      <div style={S.body}>
        {/* Sidebar — conversation list (full-width on mobile, hidden when a thread is open) */}
        <div style={{ ...S.sidebar, ...(isMobile ? { width: "100%", borderRight: "none", display: activeConvo ? "none" : "flex" } : {}) }}>
          <div style={S.sidebarHeader}>CONVERSATIONS</div>

          {/* New DM input */}
          <div style={{ padding: "8px 10px", borderBottom: "1px solid #232327", display: "flex", gap: 6 }}>
            <input
              style={{
                flex: 1, background: "#141416", border: "1px solid #232327", borderRadius: 3,
                color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "5px 7px", outline: "none",
              }}
              placeholder="0x… new DM"
              value={dmAddress}
              onChange={(e) => setDmAddress(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") startDM(); }}
            />
            <button
              onClick={startDM}
              disabled={!dmAddress.trim() || openingDM}
              style={{
                background: "none", border: "1px solid #232327", borderRadius: 3,
                color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 9,
                padding: "4px 8px", cursor: "pointer",
              }}
            >
              {openingDM ? "…" : "+"}
            </button>
          </div>
          {dmError && (
            <div style={{ padding: "6px 10px", borderBottom: "1px solid #232327", fontFamily: "var(--nx-font-ui)", fontSize: 9, color: "#f7525f", lineHeight: 1.5 }}>
              {dmError}
            </div>
          )}
          {inviteAddr && (() => {
            const inviteLink = `${window.location.origin}/messages?dm=${(xmtp.myAddress ?? "").toLowerCase()}`;
            const copy = async () => {
              try {
                await navigator.clipboard.writeText(inviteLink);
                setInviteCopied(true);
                setTimeout(() => setInviteCopied(false), 2000);
              } catch { /* clipboard blocked — user can select manually */ }
            };
            return (
              <div style={{ padding: "8px 10px", borderBottom: "1px solid #232327", background: "#1a1a1e" }}>
                <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 9, color: "#d4d4d8", lineHeight: 1.5, marginBottom: 6 }}>
                  {shortAddr(inviteAddr)} isn’t on XMTP yet. Send them this link — it opens Messages and pre-fills a DM back to you:
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    readOnly
                    value={inviteLink}
                    onFocus={(e) => e.currentTarget.select()}
                    style={{ flex: 1, background: "#141416", border: "1px solid #33333a", borderRadius: 3, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 8, padding: "5px 7px", outline: "none" }}
                  />
                  <button
                    onClick={copy}
                    style={{ background: "none", border: "1px solid #33333a", borderRadius: 3, color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "4px 8px", cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    {inviteCopied ? "COPIED ✓" : "COPY"}
                  </button>
                </div>
                <button
                  onClick={() => { setInviteAddr(null); setDmAddress(""); }}
                  style={{ marginTop: 6, background: "none", border: "none", color: "#52525b", fontFamily: "var(--nx-font-mono)", fontSize: 8, cursor: "pointer", padding: 0 }}
                >
                  dismiss
                </button>
              </div>
            );
          })()}

          <div style={S.convoList}>
            {loadingConvos && (
              <div style={{ padding: 14, fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#33333a" }}>
                loading...
              </div>
            )}
            {!loadingConvos && conversations.length === 0 && (
              <div style={{ padding: 14, fontFamily: "var(--nx-font-ui)", fontSize: 9, color: "#33333a", lineHeight: 1.6 }}>
                no conversations yet
                <br />paste a wallet address above
              </div>
            )}
            {conversations.map((convo) => (
              <ConvoItem
                key={convo.id}
                convo={convo}
                active={activeConvo?.id === convo.id}
                myInboxId={myInboxId}
                onClick={() => {
                  setActiveConvo(convo);
                  setActivePeerHint(undefined);
                }}
              />
            ))}
          </div>
        </div>

        {/* Thread panel (hidden on mobile until a conversation is selected) */}
        <div style={{ ...S.thread, ...(isMobile && !activeConvo ? { display: "none" } : {}) }}>
          {activeConvo ? (
            <>
              {isMobile && (
                <button
                  onClick={() => setActiveConvo(null)}
                  style={{ background: "none", border: "none", borderBottom: "1px solid #232327", color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 11, padding: "10px 14px", cursor: "pointer", textAlign: "left", width: "100%" }}
                >
                  ← conversations
                </button>
              )}
              <ThreadView
                key={activeConvo.id}
                convo={activeConvo}
                myInboxId={myInboxId}
                getMessages={getMessages}
                streamMessages={streamMessages}
                peerAddressHint={activePeerHint}
              />
            </>
          ) : (
            <div style={S.center}>
              <div style={{ fontSize: 28, color: "#232327" }}>⬡</div>
              <div style={S.centerLabel}>
                select a conversation or paste a wallet address to start a new DM
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
