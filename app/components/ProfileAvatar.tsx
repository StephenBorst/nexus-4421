/**
 * ProfileAvatar
 *
 * Displays the connected wallet's PFP (or a fallback icon) in the top nav.
 * On click, shows a small popover to paste a PFP URL + set a display name.
 */

import { useState, useRef, useEffect } from "react";
import { useAccount } from "@orderly.network/hooks";
import { useProfile } from "@/hooks/useProfile";

function WalletIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="14" rx="2" />
      <path d="M16 12h4" />
      <circle cx="18" cy="12" r="1" fill="currentColor" />
      <path d="M6 2h8a2 2 0 0 1 2 2v2H4V4a2 2 0 0 1 2-2z" />
    </svg>
  );
}

export default function ProfileAvatar() {
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const { pfp, displayName, saveProfile, saving } = useProfile(walletAddress);

  const [open, setOpen] = useState(false);
  const [pfpInput, setPfpInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [imgError, setImgError] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Sync inputs when profile loads
  useEffect(() => {
    setPfpInput(pfp ?? "");
    setNameInput(displayName ?? "");
    setImgError(false);
  }, [pfp, displayName]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSave = async () => {
    await saveProfile({
      pfp: pfpInput.trim() || null,
      displayName: nameInput.trim() || null,
    });
    setOpen(false);
  };

  if (!walletAddress) return null;

  const shortAddr = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
  const showPfp = pfp && !imgError;

  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        title={displayName ?? shortAddr}
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          border: open ? "2px solid #ededf0" : "2px solid #232327",
          background: showPfp ? "transparent" : "#141416",
          cursor: "pointer",
          padding: 0,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#71717a",
          transition: "border-color 0.15s",
          flexShrink: 0,
        }}
      >
        {showPfp ? (
          <img
            src={pfp!}
            alt={displayName ?? shortAddr}
            onError={() => setImgError(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
          />
        ) : (
          <WalletIcon />
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 9999,
            background: "#141416",
            border: "1px solid #232327",
            borderRadius: 6,
            padding: 16,
            width: 260,
            boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
          }}
        >
          {/* Header */}
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.12em", color: "#52525b", marginBottom: 12 }}>
            ■ PROFILE
          </div>

          {/* PFP preview */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <div style={{
              width: 44, height: 44, borderRadius: "50%",
              border: "2px solid #232327",
              background: "#0f0f11",
              overflow: "hidden",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#52525b", flexShrink: 0,
            }}>
              {pfpInput && !imgError ? (
                <img
                  src={pfpInput}
                  alt="preview"
                  onError={() => setImgError(true)}
                  style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
                />
              ) : (
                <WalletIcon />
              )}
            </div>
            <div>
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa" }}>
                {nameInput || shortAddr}
              </div>
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 2 }}>{shortAddr}</div>
            </div>
          </div>

          {/* Display name input */}
          <label style={{ display: "block", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.1em", marginBottom: 4 }}>
            DISPLAY NAME
          </label>
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="e.g. degen.eth"
            maxLength={40}
            style={{
              width: "100%",
              background: "#0f0f11",
              border: "1px solid #232327",
              borderRadius: 3,
              color: "#ededf0",
              fontFamily: "var(--nx-font-mono)",
              fontSize: 11,
              padding: "6px 8px",
              outline: "none",
              boxSizing: "border-box",
              marginBottom: 10,
            }}
          />

          {/* PFP URL input */}
          <label style={{ display: "block", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.1em", marginBottom: 4 }}>
            PFP IMAGE URL
          </label>
          <input
            type="url"
            value={pfpInput}
            onChange={(e) => { setPfpInput(e.target.value); setImgError(false); }}
            placeholder="https://..."
            style={{
              width: "100%",
              background: "#0f0f11",
              border: "1px solid #232327",
              borderRadius: 3,
              color: "#ededf0",
              fontFamily: "var(--nx-font-mono)",
              fontSize: 11,
              padding: "6px 8px",
              outline: "none",
              boxSizing: "border-box",
              marginBottom: 12,
            }}
          />

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                flex: 1,
                background: "#0c1f18",
                border: "1px solid #33333a",
                color: saving ? "#52525b" : "#ededf0",
                fontFamily: "var(--nx-font-mono)",
                fontSize: 10,
                padding: "7px 0",
                cursor: saving ? "default" : "pointer",
                borderRadius: 3,
                letterSpacing: "0.06em",
              }}
            >
              {saving ? "SAVING..." : "SAVE"}
            </button>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: "none",
                border: "1px solid #232327",
                color: "#71717a",
                fontFamily: "var(--nx-font-mono)",
                fontSize: 10,
                padding: "7px 12px",
                cursor: "pointer",
                borderRadius: 3,
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
