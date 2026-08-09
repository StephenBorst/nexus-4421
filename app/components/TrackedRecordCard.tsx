// The graded, accruing wallet record — ONE reusable surface so every place a wallet
// appears (Smart Money detail, the /analyze full x-ray, a public trader profile)
// shows the SAME thing and can never drift. Renders three self-contained cards:
//   • Tracked Record — realized-PnL consistency over time (Operator Score + tier)
//   • You vs this wallet — same methodology, side by side (only if myAddress given)
//   • Copied on Nexus — did copying this wallet actually make money (graded closes)
// All read-only public reads; the history read self-seeds the record server-side.
import { useEffect, useState } from "react";

const AGENT_API = "https://og.nexustradinglabs.com";

const usd = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : `${a.toFixed(0)}`;
  return `${n < 0 ? "-" : ""}$${s}`;
};
const fmtSigned = (n?: number) => `${(n || 0) >= 0 ? "+" : ""}${usd(n || 0)}`;
const pct = (n?: number | null) => (n == null ? "—" : `${n}%`);
const numOrDash = (n?: number | null) => (n == null ? "—" : String(n));
// Which side "wins" a metric (higher = better); null defers to the number.
const cmp = (mine?: number | null, theirs?: number | null): boolean | null => {
  const a = mine ?? null, b = theirs ?? null;
  if (a == null && b == null) return null;
  if (a == null) return false;
  if (b == null) return true;
  return a === b ? null : a > b;
};

export interface XrayTrack {
  points: number; building: boolean; scored?: boolean;
  daysTracked?: number; netRealized?: number; windows?: number;
  gradedWindows?: number; gapWindows?: number;
  winWindowRate?: number | null; maxDrawdown?: number; curve?: number[];
  trend?: "UP" | "DOWN" | "FLAT"; operatorScore?: number | null;
  tier?: { tier: string; title: string; glyph: string } | null;
}
interface CopyRec { available: boolean; trades: number; net: number; winRatePct: number | null; copiers: number; }

const label = { fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase" as const, marginBottom: 3 };
const statVal = (n: number) => ({ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: n >= 0 ? "#3ecf8e" : "#f7525f" });
const card = { border: "1px solid #232327", borderRadius: 8, padding: 12, marginBottom: 16 } as const;

// Dependency-free equity sparkline of the tracked realized-PnL window.
function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  if (!data || data.length < 2) return null;
  const w = 260, h = 44, pad = 3;
  const min = Math.min(0, ...data), max = Math.max(0, ...data);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / range) * (h - 2 * pad);
  const path = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  const color = positive ? "#3ecf8e" : "#f7525f";
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <line x1={pad} x2={w - pad} y1={zeroY} y2={zeroY} stroke="#33333a" strokeWidth="1" strokeDasharray="2 3" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function TrackedRecordCard({ address, myAddress }: { address: string; myAddress?: string }) {
  const [track, setTrack] = useState<XrayTrack | null>(null);
  const [myTrack, setMyTrack] = useState<XrayTrack | null>(null);
  const [copyRec, setCopyRec] = useState<CopyRec | null>(null);

  // The accruing Tracked Record — self-seeds the first snapshot on read.
  useEffect(() => {
    if (!address) return;
    let cancel = false;
    fetch(`${AGENT_API}/smart/xray/history?address=${address}`)
      .then((r) => r.json())
      .then((x) => { if (!cancel && x && x.track) setTrack(x.track); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [address]);

  // Did copying THIS wallet on Nexus actually work? Graded from real agent closes.
  useEffect(() => {
    if (!address) return;
    let cancel = false;
    fetch(`${AGENT_API}/agents/copy-record/${address}`)
      .then((r) => r.json())
      .then((x) => { if (!cancel && x && !x.error) setCopyRec(x); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [address]);

  // My own record — apples-to-apples "you vs this wallet" (hidden if no distinct wallet).
  useEffect(() => {
    const me = (myAddress || "").toLowerCase();
    if (!me || me === address.toLowerCase()) { setMyTrack(null); return; }
    let cancel = false;
    fetch(`${AGENT_API}/smart/xray/history?address=${me}`)
      .then((r) => r.json())
      .then((x) => { if (!cancel && x && x.track) setMyTrack(x.track); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [myAddress, address]);

  if (!track) return null;

  return (
    <>
      {/* Tracked Record — the accruing, self-grading monitor */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase" }}>Tracked Record</span>
          {track.tier && (
            <span title={`${track.tier.title} — earned from ${track.gradedWindows} graded daily windows`} style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#3ecf8e", border: "1px solid #33333a", borderRadius: 3, padding: "1px 5px" }}>{track.tier.glyph} {track.tier.title.toUpperCase()}</span>
          )}
          {typeof track.operatorScore === "number" && (
            <span style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a" }}>OPERATOR SCORE <span style={{ color: "#ededf0", fontWeight: 700, fontSize: 12 }}>{track.operatorScore}</span></span>
          )}
        </div>

        {track.building ? (
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#71717a", lineHeight: 1.6, padding: "6px 0" }}>
            Tracking started. A graded record accrues each day this wallet is watched — realized-PnL trend, consistency and drawdown, computed from public settlement. Check back.
          </div>
        ) : (
          <>
            {track.curve && track.curve.length >= 2 && (
              <div style={{ marginBottom: 10 }}><Sparkline data={track.curve} positive={(track.netRealized || 0) >= 0} /></div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: 10 }}>
              <div><div style={label}>Net (tracked)</div><div style={statVal(track.netRealized || 0)}>{(track.netRealized || 0) >= 0 ? "+" : ""}{usd(track.netRealized || 0)}</div></div>
              <div><div style={label}>Days Tracked</div><div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#ededf0" }}>{track.daysTracked}</div></div>
              <div><div style={label}>Green Days</div><div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#ededf0" }}>{track.winWindowRate == null ? "—" : `${track.winWindowRate}%`}</div></div>
              <div><div style={label}>Max Drawdown</div><div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#f7525f" }}>-{usd(track.maxDrawdown || 0)}</div></div>
            </div>
            {!track.scored && (
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", marginTop: 8, lineHeight: 1.5 }}>
                Consistency score unlocks after ~4 days of daily snapshots{track.gapWindows ? " — sparse gaps in watching don't count toward it" : ""}. The net total above is already real.
              </div>
            )}
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 8, lineHeight: 1.5 }}>
              Graded from the change in realized PnL between daily snapshots — the P&amp;L earned while watched, not lifetime history.{track.gapWindows ? " Long gaps between snapshots are excluded from the consistency read so a month can't pose as a green day." : " Score is earned from a track length, so a short streak can't inflate it."}
            </div>
          </>
        )}
      </div>

      {/* You vs this wallet — same graded methodology, side by side */}
      {myTrack && !myTrack.building && !track.building && (() => {
        const rows = [
          { k: "Net (tracked)", me: fmtSigned(myTrack.netRealized), them: fmtSigned(track.netRealized), meWin: cmp(myTrack.netRealized, track.netRealized) },
          { k: "Green Days", me: pct(myTrack.winWindowRate), them: pct(track.winWindowRate), meWin: cmp(myTrack.winWindowRate, track.winWindowRate) },
          { k: "Operator Score", me: numOrDash(myTrack.operatorScore), them: numOrDash(track.operatorScore), meWin: cmp(myTrack.operatorScore, track.operatorScore) },
        ];
        return (
          <div style={card}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 72px 72px", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase" }}>You vs this wallet</span>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#ededf0", textAlign: "right" }}>YOU</span>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", textAlign: "right" }}>THEM</span>
            </div>
            {rows.map((r) => (
              <div key={r.k} style={{ display: "grid", gridTemplateColumns: "1fr 72px 72px", gap: 6, alignItems: "center", padding: "5px 0", borderTop: "1px solid #1a1a1e" }}>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa" }}>{r.k}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700, textAlign: "right", color: r.meWin === true ? "#3ecf8e" : "#d4d4d8" }}>{r.me}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600, textAlign: "right", color: r.meWin === false ? "#ededf0" : "#71717a" }}>{r.them}</span>
              </div>
            ))}
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 8, lineHeight: 1.5 }}>
              Both graded the same way — realized-PnL consistency over the days each was tracked. A dash means not enough daily data yet.
            </div>
          </div>
        );
      })()}

      {/* Copied on Nexus — did copying this wallet actually make money */}
      {copyRec && copyRec.available && copyRec.trades > 0 && (
        <div style={card}>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase", marginBottom: 8 }}>Copied on Nexus</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(80px, 1fr))", gap: 10 }}>
            <div><div style={label}>Net (copiers)</div><div style={statVal(copyRec.net)}>{copyRec.net >= 0 ? "+" : ""}{usd(copyRec.net)}</div></div>
            <div><div style={label}>Graded Closes</div><div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#ededf0" }}>{copyRec.trades}</div></div>
            <div><div style={label}>Win Rate</div><div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#ededf0" }}>{copyRec.winRatePct == null ? "—" : `${copyRec.winRatePct}%`}</div></div>
            <div><div style={label}>Copiers</div><div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#ededf0" }}>{copyRec.copiers}</div></div>
          </div>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 8, lineHeight: 1.5 }}>
            Realized P&amp;L of Nexus agent trades that copied this wallet — graded from on-chain-auditable closes, not their self-reported number. The agent manages every exit.
          </div>
        </div>
      )}
    </>
  );
}
