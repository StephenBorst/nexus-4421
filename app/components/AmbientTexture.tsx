import { useEffect } from "react";

// ── Cursor spotlight host ────────────────────────────────────────────────────
// A global pointermove sets --mx/--my on the hovered .nx-spotlight element, which
// renders a faint highlight that tracks the cursor (the Linear/Vercel card sheen).
// Pure CSS paint, passive listener, no DOM of its own.
// NOTE: the fixed ambient GRID + scan-glow texture was removed — the background is
// clean terminal-black, congruent with the landing hero.
export default function AmbientTexture() {
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
  return null;
}
