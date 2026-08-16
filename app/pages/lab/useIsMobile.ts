import { useState, useEffect } from "react";

// A PHYSICAL phone, even in "Desktop site" mode — where window.innerWidth reports a
// desktop width so useIsMobile() is false. screen.width is the real device width,
// immune to desktop-site zoom, and Math.min(w,h) makes it orientation-independent.
// Use for touch AFFORDANCES (label icon buttons since there's no hover tooltip,
// bigger hit targets) — NOT for layout, where the user's desktop-view choice stands.
export function useIsPhone() {
  const [isPhone] = useState(() =>
    typeof window !== "undefined" &&
    Math.min(window.screen?.width ?? 9999, window.screen?.height ?? 9999) < 768
  );
  return isPhone;
}

// Shared responsive hook for The Lab (inline styles can't use CSS media queries).
export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
}
