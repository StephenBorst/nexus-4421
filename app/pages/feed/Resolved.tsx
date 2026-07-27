// ── JUST RESOLVED — the moment the product exists to produce ──
// A call hitting its target or stop is the single most interesting event here, and it
// used to be completely invisible: the hourly cron stamped the grade and nothing said
// so. The author found out by scrolling their own profile, if ever.
//
// Rendered as a strip rather than interleaved into the thesis list: a resolution isn't
// thesis-shaped (no levels, no status), so mixing it into FeedCard's input would break
// the card and skew the "N traders" counts. It also reads better as a ticker.
import { C, MONO, RADIUS } from "@/config/theme";

export type ResolutionEvent = {
  kind: "RESOLUTION";
  wallet: string;
  thesisId: string | null;
  symbol: string;
  direction: "LONG" | "SHORT" | null;
  outcome: "WIN" | "LOSS";
  r: number;
  message: string;
  createdAt: number;
};

const shortAddr = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const ago = (ms: number) => {
  const m = Math.max(0, (Date.now() - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export default function Resolved({ events }: { events: ResolutionEvent[] }) {
  if (!events?.length) return null;
  const shown = events.slice(0, 8);

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 13, color: C.text.bright, letterSpacing: "0.04em" }}>◧ JUST RESOLVED</span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.text.faint }}>graded from public price — not self-reported</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {shown.map((e, i) => {
          // Green/red here is P&L, which is the one place chroma is allowed.
          const tone = e.outcome === "WIN" ? C.pos : C.neg;
          return (
            <a
              key={`${e.wallet}-${e.thesisId ?? i}`}
              href={`/trader/${e.wallet}`}
              style={{ textDecoration: "none" }}
            >
              <div style={{
                display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                padding: "8px 11px", background: C.surfaceAlt, border: `1px solid ${C.border}`,
                borderLeft: `2px solid ${tone}`, borderRadius: RADIUS.sm,
              }}>
                <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 11, fontWeight: 700, color: C.text.bright }}>
                  {e.symbol}
                </span>
                <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 10, color: C.text.faint }}>{e.direction}</span>
                <span style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12, color: C.text.fog, minWidth: 0 }}>
                  {e.outcome === "WIN" ? "hit target" : "stopped out"}
                </span>
                <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 12, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums" }}>
                  {e.r > 0 ? "+" : ""}{e.r}R
                </span>
                <span style={{ marginLeft: "auto", flexShrink: 0, fontFamily: MONO, fontSize: 9, color: C.text.faint }}>
                  {shortAddr(e.wallet)} · {ago(e.createdAt)}
                </span>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
