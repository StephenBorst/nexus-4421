// ◆ DESKS — teams ("clans") ranked by their COMBINED verifiable record.
// A desk's score = the aggregate of its members' public-price-graded calls (same
// trustless grading as the caller board) — so a desk can't fake its rank either.
// Create / join / leave are wallet-signed; one desk per wallet (enforced server-side).
// Reuses the cached `nexus_agent_sig_{addr}` session signature (no extra prompt if
// the user already signed for the agent).
import { useEffect, useState } from "react";
import { signWithInjected } from "@/utils/injectedWallet";

const API_BASE = "https://og.nexustradinglabs.com";
const green = "#00ff88";

type Desk = {
  id: string; name: string; rank: number; members: number;
  calls: number; hitRate: number; avgR: number; totalR: number; score: number;
};

async function getSig(address: string): Promise<string> {
  const key = `nexus_agent_sig_${address.toLowerCase()}`;
  try { const c = JSON.parse(sessionStorage.getItem(key) || "null"); if (c?.sig) return c.sig; } catch { /* ignore */ }
  const sig = await signWithInjected(address, "nexus-trading-key-v1");
  try { sessionStorage.setItem(key, JSON.stringify({ sig })); } catch { /* ignore */ }
  return sig;
}

export default function Desks({ walletAddress }: { walletAddress: string | null }) {
  const [desks, setDesks] = useState<Desk[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [myDeskId, setMyDeskId] = useState<string | null>(null);

  const load = () =>
    fetch(`${API_BASE}/desks`).then((r) => r.json())
      .then((d) => setDesks(Array.isArray(d?.desks) ? d.desks : []))
      .catch(() => setDesks([]));
  useEffect(() => { load(); }, []);

  async function act(fn: () => Promise<Response>, okMsg: string) {
    if (!walletAddress) { setMsg("connect your wallet first"); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fn();
      const d = await res.json();
      if (res.ok && d.ok) { setMsg(okMsg); setMyDeskId(d?.desk?.id ?? myDeskId); setName(""); await load(); }
      else if (d.error === "already_in_desk") { setMyDeskId(d.deskId || null); setMsg("You're already in a desk — leave it first."); }
      else setMsg(d.message || d.error || "action failed");
    } catch (e) { setMsg((e as Error)?.message || "error"); }
    finally { setBusy(false); }
  }

  const sigBody = async (extra: Record<string, unknown> = {}) => {
    const sig = await getSig(walletAddress as string);
    return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletAddress, walletSig: sig, ...extra }) };
  };

  const create = () => name.trim() && act(async () => fetch(`${API_BASE}/desks`, await sigBody({ name: name.trim() })), `Created “${name.trim()}” — recruit your desk.`);
  const join = (id: string) => act(async () => fetch(`${API_BASE}/desks/${id}/join`, await sigBody()), "Joined the desk.");
  const leave = (id: string) => act(async () => fetch(`${API_BASE}/desks/${id}/leave`, await sigBody()), "Left the desk.");

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: "bold", color: green, letterSpacing: "0.1em" }}>◆ DESKS</span>
        <span style={{ fontFamily: "monospace", fontSize: 9, color: "#3a5a4a" }}>teams ranked by combined verified record</span>
      </div>

      {/* Create */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <input
          className="nx-input"
          value={name} onChange={(e) => setName(e.target.value)} placeholder="name your desk…" maxLength={40}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="nx-btn nx-btn-primary" onClick={create} disabled={busy || !name.trim()} style={{ flexShrink: 0 }}>+ CREATE</button>
      </div>
      {msg && <div style={{ fontFamily: "monospace", fontSize: 9, color: "#fbbf24", marginBottom: 8 }}>{msg}</div>}

      {/* Leaderboard */}
      {desks === null && <div style={{ fontFamily: "monospace", fontSize: 11, color: "#2a4a3a" }}>loading desks…</div>}
      {desks && desks.length === 0 && <div style={{ fontFamily: "monospace", fontSize: 11, color: "#2a4a3a" }}>no desks yet — start one and recruit 🟢</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {desks?.map((d) => (
          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#0a0e0a", border: "1px solid #1a2e1a", borderRadius: 5, padding: "8px 10px", overflowX: "auto" }}>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "#3a5a4a", flexShrink: 0, width: 22 }}>#{d.rank}</span>
            <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: "bold", color: "#fff", flexShrink: 0 }}>{d.name}</span>
            <span style={{ fontFamily: "monospace", fontSize: 9, color: "#4a7a5a", flexShrink: 0 }}>{d.members}👤</span>
            <span style={{ fontFamily: "monospace", fontSize: 9, color: "#8aaa9a", flexShrink: 0 }}>{d.calls} calls · {d.hitRate}% · {d.totalR >= 0 ? "+" : ""}{d.totalR}R</span>
            <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 13, fontWeight: "bold", color: d.score > 0 ? green : "#3a5a4a", flexShrink: 0 }}>{d.score || "—"}</span>
            {myDeskId === d.id
              ? <button onClick={() => leave(d.id)} disabled={busy} style={{ flexShrink: 0, background: "#1a0a0a", color: "#ff4444", border: "1px solid #4a1a1a55", borderRadius: 4, padding: "5px 9px", fontFamily: "monospace", fontSize: 9, fontWeight: "bold", cursor: "pointer" }}>LEAVE</button>
              : <button onClick={() => join(d.id)} disabled={busy} style={{ flexShrink: 0, background: "#0a1a0a", color: green, border: "1px solid #1a4a2a", borderRadius: 4, padding: "5px 9px", fontFamily: "monospace", fontSize: 9, fontWeight: "bold", cursor: "pointer" }}>JOIN</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
