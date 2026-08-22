// ── Agent STRATEGY LIBRARY + COMMUNITY board ──
// Extracted from AgentView.tsx (god-file split). Save/load/share composed configs,
// and browse what others have published ranked by the author's GRADED record (not by
// backtest — discovery stays on the trustless moat).
//
// Not the money path: these mutate saved-strategy records, never orders or agent
// state. Mutations are still owner-authed server-side; the handlers stay in AgentView
// because they own the wallet signature.
//
// ⚠️ Mechanical move: markup unchanged. `any` on the strategy shapes is inherited
// from the original state declarations.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { deriveStyle } from "@/config/agentStyles";
import { agentCardStyle, agentLabelStyle, agentInputStyle, btnPrimary, navBtnStyle } from "./styles";

export function AgentStrategyLibrary({
  stratName, setStratName, saving, strategies, saveStrategy, loadStrategy,
  deleteStrategy, togglePublish, community, communityStyle, loadCommunity, copyStrategy,
}: {
  stratName: string;
  setStratName: (v: string) => void;
  saving: boolean;
  strategies: any[];
  saveStrategy: () => void;
  loadStrategy: (s: any) => void;
  deleteStrategy: (id: string) => void;
  togglePublish: (s: any) => void;
  community: any[] | null;
  communityStyle: string;
  loadCommunity: (style: string) => void;
  copyStrategy: (s: any) => void;
}) {
  // ── STRATEGY LIBRARY — save / load composed configs (free) ──
  return (
    <>
      <div style={agentCardStyle}>
        <div style={agentLabelStyle}>STRATEGY LIBRARY</div>
        <div style={{ color: "#71717a", fontFamily: "var(--nx-font-ui)", fontSize: 10, marginTop: 6, marginBottom: 10, lineHeight: 1.5 }}>
          Save the config above as a named strategy, then load it back anytime. Build → test → save your best.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={stratName}
            onChange={(e) => setStratName(e.target.value)}
            placeholder="name this strategy…"
            maxLength={40}
            style={{ ...agentInputStyle, flex: 1, minWidth: 160 }}
          />
          <button onClick={saveStrategy} disabled={saving || !stratName.trim()} style={{ ...btnPrimary, fontSize: 10, padding: "6px 16px", opacity: (saving || !stratName.trim()) ? 0.5 : 1 }}>
            💾 SAVE
          </button>
        </div>
        {strategies.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            {strategies.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "8px 10px", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
                  <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 9, marginTop: 2 }}>
                    <span style={{ color: "#d4d4d8" }}>{deriveStyle(s.config)}</span> · {s.config.signalMode} · {s.config.mode} · {s.config.leverage}x · TP{s.config.tpPercent}/SL{s.config.slPercent}
                    {s.config.dcaEnabled ? " · DCA" : ""}
                    {s.stats ? <span style={{ color: s.stats.netUsd >= 0 ? "#3ecf8e" : "#f7525f" }}>{`  ·  60d ${s.stats.netUsd >= 0 ? "+" : ""}$${s.stats.netUsd}`}</span> : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button onClick={() => togglePublish(s)} title={s.public ? "Public — click to make private" : "Share to the community board"} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 10px", color: s.public ? "#ededf0" : "#a1a1aa", borderColor: s.public ? "#ededf050" : "#232327" }}>{s.public ? "🌐 PUBLIC" : "SHARE"}</button>
                  <button onClick={() => loadStrategy(s)} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 12px" }}>LOAD</button>
                  <button onClick={() => deleteStrategy(s.id)} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 10px", color: "#f7525f", borderColor: "#f7525f50" }}>✕</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── COMMUNITY STRATEGIES — browse shared configs, ranked by author's graded record ── */}
      <div style={agentCardStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={agentLabelStyle}>COMMUNITY STRATEGIES</div>
          <div style={{ display: "flex", gap: 6 }}>
            {[{ k: "", l: "ALL" }, { k: "DAY", l: "DAY" }, { k: "SWING", l: "SWING" }].map(({ k, l }) => (
              <button key={l} onClick={() => loadCommunity(k)} style={{ ...navBtnStyle, fontSize: 9, padding: "4px 10px", ...(community !== null && communityStyle === k ? { color: "#ededf0", borderColor: "#ededf050" } : {}) }}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ color: "#71717a", fontFamily: "var(--nx-font-ui)", fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
          Strategies shared by the community, ranked by the author's <strong style={{ color: "#a1a1aa" }}>graded live/paper record</strong> — not backtest (shown only as a hypothesis). Copy one to your editor and make it yours.
        </div>
        {community === null ? (
          <button onClick={() => loadCommunity("")} style={{ ...btnPrimary, fontSize: 10, padding: "6px 16px", marginTop: 10 }}>▤ BROWSE STRATEGIES</button>
        ) : community.length === 0 ? (
          <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 11, marginTop: 10 }}>No public strategies{communityStyle ? ` for ${communityStyle}` : ""} yet — publish one from your library to seed the board.</div>
        ) : (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            {community.map((s) => (
              <div key={s.owner + s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "8px 10px", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "#d4d4d8", fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {s.name} <span style={{ color: "#d4d4d8", fontSize: 9 }}>{s.style}</span>
                    {(() => {
                      const v = s.validation;
                      if (!v) return null;
                      if (v.status === "validating") return <span title="Walk-forward validation running" style={{ fontSize: 8, color: "#a1a1aa", border: "1px solid #232327", borderRadius: 3, padding: "1px 5px" }}>⏳ VALIDATING</span>;
                      if (v.status === "pending_oi") return <span title="Awaiting OI history to validate the confluence signal" style={{ fontSize: 8, color: "#d4d4d8", border: "1px solid #33333a", borderRadius: 3, padding: "1px 5px" }}>⏳ OI PENDING</span>;
                      if (v.status !== "done") return null;
                      const vc = v.verdict === "ROBUST" ? "#3ecf8e" : v.verdict === "FRAGILE" ? "#fbbf24" : "#f7525f";
                      const lbl = v.verdict === "ROBUST" ? "✅ ROBUST" : v.verdict === "FRAGILE" ? "🟨 FRAGILE" : "❌ NOT ROBUST";
                      return <span title={`Walk-forward: net-positive on ${v.posSymbols}/${v.totalSymbols} markets, ${v.foldConsistency}% of folds`} style={{ fontSize: 8, color: vc, border: `1px solid ${vc}55`, borderRadius: 3, padding: "1px 5px" }}>{lbl}</span>;
                    })()}
                  </div>
                  <div style={{ color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 9, marginTop: 2 }}>
                    by {s.owner.slice(0, 6)}…{s.owner.slice(-4)} · {s.config.signalMode} · {s.config.leverage}x
                    {s.author && s.author.trades > 0
                      ? <span style={{ color: s.author.netPnl >= 0 ? "#3ecf8e" : "#f7525f" }}>{`  ·  graded ${s.author.winRate}% win, ${s.author.netPnl >= 0 ? "+" : ""}$${s.author.netPnl} (${s.author.trades}t)`}</span>
                      : <span style={{ color: "#71717a" }}>  ·  author unproven</span>}
                    {s.backtest ? <span style={{ color: "#71717a" }}>{`  ·  bt ${s.backtest.netUsd >= 0 ? "+" : ""}$${s.backtest.netUsd}*`}</span> : ""}
                  </div>
                </div>
                <button onClick={() => copyStrategy(s)} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 14px", flexShrink: 0 }}>COPY</button>
              </div>
            ))}
            <div style={{ color: "#52525b", fontFamily: "var(--nx-font-mono)", fontSize: 9, marginTop: 4 }}>*bt = backtest hypothesis; ranking uses the author's real graded record. Badge = our walk-forward verdict (net-positive across markets + time). ✅ is rare by design.</div>
          </div>
        )}
      </div>
    </>
  );
}
