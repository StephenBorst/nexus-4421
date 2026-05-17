/**
 * /messages — XMTP encrypted wallet-to-wallet DMs
 *
 * URL: /messages          — inbox (conversation list)
 * URL: /messages?dm=0x…   — auto-opens a DM with that wallet address
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useAccount } from "@orderly.network/hooks";
import { useXMTP } from "@/hooks/useXMTP";
import type { Conversation, DecodedMessage } from "@/hooks/useXMTP";

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
    background: "#0a0e0a",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    padding: "8px 16px",
    borderBottom: "1px solid #1a2e1a",
    background: "#080c08",
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  headerLabel: {
    fontFamily: "monospace",
    fontSize: 9,
    letterSpacing: "0.12em",
    color: "#3a5a4a",
  },
  body: {
    flex: 1,
    display: "flex",
    overflow: "hidden",
    height: "calc(100vh - 42px)",
  },
  sidebar: {
    width: 260,
    borderRight: "1px solid #1a2e1a",
    display: "flex",
    flexDirection: "column" as const,
    background: "#080c08",
    flexShrink: 0,
  },
  sidebarHeader: {
    padding: "10px 14px",
    borderBottom: "1px solid #1a2e1a",
    fontFamily: "monospace",
    fontSize: 9,
    letterSpacing: "0.1em",
    color: "#3a5a4a",
  },
  convoList: {
    flex: 1,
    overflowY: "auto" as const,
  },
  convoItem: (active: boolean): React.CSSProperties => ({
    padding: "12px 14px",
    borderBottom: "1px solid #0f1a0f",
    cursor: "pointer",
    background: active ? "#0a1a0a" : "transparent",
    borderLeft: active ? "2px solid #00ff88" : "2px solid transparent",
  }),
  convoName: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#8aaa9a",
    marginBottom: 2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  convoPreview: {
    fontFamily: "monospace",
    fontSize: 9,
    color: "#3a5a4a",
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
    borderBottom: "1px solid #1a2e1a",
    background: "#080c08",
    fontFamily: "monospace",
    fontSize: 11,
    color: "#8aaa9a",
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
    background: isMine ? "#0a1a0a" : "#080c08",
    border: `1px solid ${isMine ? "#1a4a2a" : "#1a2e1a"}`,
    borderRadius: isMine ? "8px 8px 0 8px" : "8px 8px 8px 0",
    padding: "8px 12px",
  }),
  bubbleText: (isMine: boolean): React.CSSProperties => ({
    fontFamily: "monospace",
    fontSize: 11,
    color: isMine ? "#00ff88" : "#8aaa9a",
    lineHeight: 1.5,
    wordBreak: "break-word" as const,
  }),
  bubbleTime: {
    fontFamily: "monospace",
    fontSize: 8,
    color: "#2a4a3a",
    marginTop: 4,
    textAlign: "right" as const,
  },
  compose: {
    padding: "10px 16px",
    borderTop: "1px solid #1a2e1a",
    background: "#080c08",
    display: "flex",
    gap: 8,
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    background: "#0d120d",
    border: "1px solid #1a2e1a",
    borderRadius: 4,
    color: "#00ff88",
    fontFamily: "monospace",
    fontSize: 11,
    padding: "8px 10px",
    outline: "none",
    resize: "none" as const,
    minHeight: 38,
    maxHeight: 120,
  },
  sendBtn: (disabled: boolean): React.CSSProperties => ({
    background: disabled ? "#080c08" : "#0a1a0a",
    border: `1px solid ${disabled ? "#1a2e1a" : "#00ff88"}`,
    borderRadius: 4,
    color: disabled ? "#2a4a3a" : "#00ff88",
    fontFamily: "monospace",
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
    fontFamily: "monospace",
    fontSize: 11,
    color: "#3a5a4a",
    textAlign: "center" as const,
    lineHeight: 1.6,
    maxWidth: 320,
  },
  enableBtn: {
    background: "#0a1a0a",
    border: "1px solid #00ff88",
    borderRadius: 4,
    color: "#00ff88",
    fontFamily: "monospace",
    fontSize: 10,
    letterSpacing: "0.1em",
    padding: "10px 24px",
    cursor: "pointer",
  },
  errText: {
    fontFamily: "monospace",
    fontSize: 9,
    color: "#ff4444",
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
  peerAddressHint,
}: {
  convo: Conversation;
  myInboxId: string | null;
  getMessages: (c: Conversation) => Promise<DecodedMessage[]>;
  peerAddressHint?: string;
}) {
  const [messages, setMessages] = useState<DecodedMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
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
    pollRef.current = setInterval(loadMessages, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await convo.sendText(trimmed);
      setText("");
      await loadMessages();
    } catch {
      // keep text so user can retry
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
        <span style={{ color: "#00ff88", fontSize: 10 }}>⬡</span>
        {peerDisplay}
        <span style={{ fontFamily: "monospace", fontSize: 8, color: "#2a4a3a", marginLeft: "auto" }}>
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
  const dmParam = searchParams.get("dm");

  const xmtp = useXMTP();
  const { ready, initializing, error, init, getConversations, getMessages, myInboxId } = xmtp;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvo, setActiveConvo] = useState<Conversation | null>(null);
  const [activePeerHint, setActivePeerHint] = useState<string | undefined>(undefined);
  const [loadingConvos, setLoadingConvos] = useState(false);
  const [dmAddress, setDmAddress] = useState("");
  const [openingDM, setOpeningDM] = useState(false);

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
    setOpeningDM(true);
    try {
      const convo = await xmtp.openDM(addr);
      setActiveConvo(convo);
      setActivePeerHint(addr);
      setConversations((prev) => {
        const already = prev.find((c) => c.id === convo.id);
        return already ? prev : [convo, ...prev];
      });
      setDmAddress("");
    } catch {
      // address not on XMTP — could show a toast here
    } finally {
      setOpeningDM(false);
    }
  }

  if (!walletAddress) {
    return (
      <div style={S.page}>
        <div style={S.header}>
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
          <span style={S.headerLabel}>■ MESSAGES</span>
        </div>
        <div style={S.center}>
          <div style={{ fontSize: 24, color: "#1a3a1a" }}>⬡</div>
          <div style={S.centerLabel}>
            wallet-to-wallet encrypted DMs powered by XMTP
            <br />
            <span style={{ color: "#2a4a3a", fontSize: 9 }}>
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
        <span style={S.headerLabel}>■ MESSAGES</span>
        <span style={{ fontFamily: "monospace", fontSize: 8, color: "#1a4a2a", marginLeft: "auto" }}>
          ⬡ XMTP · end-to-end encrypted
        </span>
      </div>

      <div style={S.body}>
        {/* Sidebar — conversation list */}
        <div style={S.sidebar}>
          <div style={S.sidebarHeader}>CONVERSATIONS</div>

          {/* New DM input */}
          <div style={{ padding: "8px 10px", borderBottom: "1px solid #1a2e1a", display: "flex", gap: 6 }}>
            <input
              style={{
                flex: 1, background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 3,
                color: "#00ff88", fontFamily: "monospace", fontSize: 9, padding: "5px 7px", outline: "none",
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
                background: "none", border: "1px solid #1a3a1a", borderRadius: 3,
                color: "#3a6a4a", fontFamily: "monospace", fontSize: 9,
                padding: "4px 8px", cursor: "pointer",
              }}
            >
              {openingDM ? "…" : "+"}
            </button>
          </div>

          <div style={S.convoList}>
            {loadingConvos && (
              <div style={{ padding: 14, fontFamily: "monospace", fontSize: 9, color: "#2a4a3a" }}>
                loading...
              </div>
            )}
            {!loadingConvos && conversations.length === 0 && (
              <div style={{ padding: 14, fontFamily: "monospace", fontSize: 9, color: "#2a4a3a", lineHeight: 1.6 }}>
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

        {/* Thread panel */}
        <div style={S.thread}>
          {activeConvo ? (
            <ThreadView
              key={activeConvo.id}
              convo={activeConvo}
              myInboxId={myInboxId}
              getMessages={getMessages}
              peerAddressHint={activePeerHint}
            />
          ) : (
            <div style={S.center}>
              <div style={{ fontSize: 28, color: "#1a2e1a" }}>⬡</div>
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
