import { useEffect, type CSSProperties } from "react";
import { useMarketPulse } from "@/hooks/useMarketPulse";

// ── Ambient texture (data-reactive) + cursor spotlight host ──────────────────
// Two "the terminal responds" behaviors mounted once, app-wide:
//  1. DATA-REACTIVITY — the market pulse (0–100) subtly modulates the ambient
//     grid/scan intensity: livelier when risk-on, calmer when risk-off. Stays
//     MONOCHROME (green is profit-only) — only intensity + scan speed move.
//  2. CURSOR SPOTLIGHT — a global pointermove sets --mx/--my on the hovered
//     .nx-spotlight element, which renders a faint highlight that tracks the
//     cursor (the Linear/Vercel card sheen). Pure CSS paint, passive listener.
export default function AmbientTexture() {
  const score = useMarketPulse(); // 0–100, null until it resolves

  // Cursor spotlight: cheap, one global passive listener; the CSS does the paint.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const el = (e.target as HTMLElement)?.closest?.(".nx-spotlight") as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // Map pulse → subtle intensity. Neutral default (t=0.5) holds until data loads.
  const t = score == null ? 0.5 : Math.max(0, Math.min(1, score / 100));
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const style: CSSProperties | undefined = score == null ? undefined : {
    // Range tuned against the WHITE hairline (see .nx-ambient in index.css) — the
    // old 0.07–0.115 was calibrated for a dark line and rendered invisible on prod.
    ["--nx-grid-op" as string]: lerp(0.025, 0.055).toFixed(3),
    ["--nx-scan-op" as string]: lerp(0.03, 0.06).toFixed(3),
    ["--nx-scan-dur" as string]: `${Math.round(lerp(30, 15))}s`,
  } as CSSProperties;

  const regime = score == null ? undefined : score >= 60 ? "on" : score >= 42 ? "neutral" : "off";
  return <div className="nx-ambient" aria-hidden="true" style={style} data-regime={regime} />;
}
