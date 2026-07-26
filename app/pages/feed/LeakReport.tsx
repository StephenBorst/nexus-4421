// ◇ THE COMMUNITY'S LEAKS — anonymous aggregate of why calls lost, last 30 days.
// Individually a postmortem is coaching; in aggregate it's culture. Publishing that
// "the #1 leak here is oversizing" makes admitting a PROCESS error normal, which is
// the opposite of every feed where everyone only posts wins.
// Anonymous by construction (the API never attaches a wallet to a reason) and
// self-reported, so it is never part of any ranking. Fail-soft, renders nothing
// until the habit actually exists.
import { useEffect, useState } from "react";

const API_BASE = "https://og.nexustradinglabs.com";

type Reason = { key: string; label: string; hint: string };
type Payload = {
  windowDays: number;
  contributors: number;
  taxonomy: Reason[];
  summary: { tagged: number; counts: Record<string, number>; top: { reason: string; count: number; rate: number } } | null;
};

export default function LeakReport() {
  const [data, setData] = useState<Payload | null>(null);

  useEffect(() => {
    let cancel = false;
    fetch(`${API_BASE}/theses/postmortems`)
      .then((r) => r.json())
      .then((d) => { if (!cancel) setData(d); })
      .catch(() => { /* fail-soft */ });
    return () => { cancel = true; };
  }, []);

  const summary = data?.summary;
  if (!summary?.tagged) return null;

  const labelOf = (key: string) => data?.taxonomy?.find((r) => r.key === key)?.label ?? key;
  const rows = Object.entries(summary.counts).sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 1;

  return (
    <div style={{ marginBottom: 24, background: "#0f0f11", border: "1px solid #232327", borderRadius: 6, padding: "14px 16px", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", letterSpacing: "0.04em" }}>◇ WHERE WE ALL LEAK</span>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>
          {summary.tagged} tagged losses · {data?.contributors} traders · {data?.windowDays}d
        </span>
      </div>
      <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12, color: "#a1a1aa", lineHeight: 1.55, marginBottom: 10 }}>
        The most common reason a call lost here is <strong style={{ color: "#ededf0" }}>{labelOf(summary.top.reason).toLowerCase()}</strong> ({summary.top.rate}% of tagged losses). Anonymous, self-reported, and never part of anyone's rank.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {rows.map(([key, count]) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: "0 0 120px", fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labelOf(key)}</span>
            <div style={{ flex: "1 1 0", height: 6, background: "#1a1a1e", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${(count / max) * 100}%`, height: "100%", background: "#33333a", borderRadius: 3 }} />
            </div>
            <span style={{ flex: "0 0 28px", textAlign: "right", fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#52525b" }}>{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
