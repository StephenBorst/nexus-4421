// First-run welcome + onboarding checklist. Extracted from index.tsx.
import { useState } from "react";
import { cardStyle, navBtnStyle } from "./styles";

// ─── First-run Welcome (disconnected) ────────────────────
export function LabWelcome() {
  const features = [
    { icon: "◈", title: "NEXUS THESIS ENGINE", desc: "Plan every trade — position sizing, R:R, funding cost, live P&L tracking, on-chain proof." },
    { icon: "⬢", title: "AUTO AGENT", desc: "Run a preset or your own strategy hands-free. Scale-out & trailing exits, DCA, TradingView signals. Hard risk caps, kill switch, order-only keys." },
    { icon: "◆", title: "STRATEGY WORKBENCH", desc: "Build a strategy by trading style, backtest it on real history, then publish it — every result graded on-chain. Verify, don't trust." },
    { icon: "▣", title: "ANALYTICS", desc: "Trading score, win-rate breakdowns, hold-time & leverage analysis — grade yourself like a desk." },
    { icon: "▤", title: "TRADE LOG", desc: "Full journal of every closed day with notes, filters, and a calendar heatmap." },
  ];
  return (
    <div style={{ padding: "32px 8px" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#00ff88", letterSpacing: "0.3em", marginBottom: 12, textShadow: "0 0 12px rgba(0,255,136,0.5)" }}>// THE LAB</div>
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 28, color: "#fff", fontWeight: "bold", marginBottom: 12, lineHeight: 1.25 }}>
          The trading terminal that<br />makes you a better trader.
        </div>
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#8aaa9a", maxWidth: 580, margin: "0 auto", lineHeight: 1.6 }}>
          Plan it, automate it, grade it. Most apps just let you trade — The Lab turns every
          position into a repeatable process. Connect your wallet to load your data and unlock every tool.
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, maxWidth: 760, margin: "0 auto 28px" }}>
        {features.map((f) => (
          <div key={f.title} style={{ ...cardStyle, padding: "16px 18px" }}>
            <div style={{ fontSize: 20, color: "#2f7a52", marginBottom: 8 }}>{f.icon}</div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#fff", fontWeight: "bold", letterSpacing: "0.08em", marginBottom: 6 }}>{f.title}</div>
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#8aaa9a", lineHeight: 1.5 }}>{f.desc}</div>
          </div>
        ))}
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#3a5a4a", border: "1px solid #1a2e1a", borderRadius: 4, padding: "10px 18px", background: "#0a0e0a" }}>
          <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#fbbf24", boxShadow: "0 0 8px #fbbf24", animation: "pulse 2s infinite" }} />
          Connect your wallet (top right) to load your trades and activate The Lab
        </div>
      </div>
    </div>
  );
}

// ─── Onboarding Activation Checklist ─────────────────────
export function OnboardingChecklist({
  hasThesis,
  hasTrade,
  onGoThesis,
  onGoAnalytics,
}: {
  hasThesis: boolean;
  hasTrade: boolean;
  onGoThesis: () => void;
  onGoAnalytics: () => void;
}) {
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem("lab_onboard_dismissed") === "1"
  );
  if (dismissed) return null;

  const steps = [
    { key: "connect", label: "Connect your wallet", hint: "Your data is loading — you're in.", done: true, action: null },
    { key: "thesis",  label: "Plan your first thesis", hint: "Size a trade with R:R, stops & funding in the Nexus Thesis Engine.", done: hasThesis, action: onGoThesis, cta: "OPEN NEXUS THESIS ENGINE" },
    { key: "trade",   label: "Place your first trade", hint: "Trade anywhere on Nexus — it flows back here automatically.", done: hasTrade, action: null },
    { key: "grade",   label: "Grade your performance", hint: "See your trading score, breakdowns & journal.", done: hasTrade, action: onGoAnalytics, cta: "VIEW ANALYTICS" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  const pct = Math.round((doneCount / steps.length) * 100);

  const dismiss = () => {
    window.localStorage.setItem("lab_onboard_dismissed", "1");
    setDismissed(true);
  };

  return (
    <div style={{ ...cardStyle, marginBottom: 16, borderColor: allDone ? "#1a4a2a" : "#1a3a2a" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#00ff88", letterSpacing: "0.12em" }}>
            {allDone ? "🎉 YOU'RE SET UP" : "// GET STARTED"}
          </span>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#3a5a4a" }}>{doneCount}/{steps.length}</span>
        </div>
        <button onClick={dismiss} style={{ ...navBtnStyle, fontSize: 9, padding: "3px 10px", color: "#3a5a4a" }}>
          {allDone ? "DISMISS" : "SKIP"}
        </button>
      </div>
      <div style={{ height: 4, background: "#0a0e0a", borderRadius: 2, marginBottom: 14, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: "#00ff88", transition: "width 0.4s", boxShadow: "0 0 8px rgba(0,255,136,0.5)" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.map((s) => (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{
              width: 18, height: 18, borderRadius: "50%", flexShrink: 0,
              border: `1px solid ${s.done ? "#00ff88" : "#2a4a3a"}`,
              background: s.done ? "#00ff8820" : "transparent",
              color: s.done ? "#00ff88" : "#2a4a3a",
              fontFamily: "var(--nx-font-mono)", fontSize: 11, textAlign: "center", lineHeight: "17px",
            }}>{s.done ? "✓" : ""}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: s.done ? "#8aaa9a" : "#fff", textDecoration: s.done ? "line-through" : "none" }}>{s.label}</div>
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#3a5a4a", marginTop: 1 }}>{s.hint}</div>
            </div>
            {!s.done && s.action && (
              <button onClick={s.action} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 12px", color: "#00ff88", borderColor: "#1a4a2a", flexShrink: 0 }}>
                {s.cta}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

