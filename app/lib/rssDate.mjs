// ── RSS timestamp parsing ──
// Extracted from MarketIntel.tsx so the rule that broke the News tab is pinned by
// tests instead of living inline in a component.
//
// THE BUG THIS EXISTS TO PREVENT: rss2json normalises pubDate to UTC but emits it with
// NO timezone marker ("2026-07-27 10:11:23"). `new Date()` reads that shape as LOCAL
// time, so for any user west of UTC every article was dated hours into the future. The
// age formatter had no negative guard, so `m < 60` matched and rendered "-333m" —
// fresh news looked stale/broken, and it read like a feed or billing problem.
//
// Two independent fixes, both needed:
//   1. parse zone-less timestamps as UTC (the actual cause)
//   2. clamp the age at 0 (defence — a feed with a skewed clock can still be ahead)

/** RSS pubDate → epoch ms. NaN when unparseable. */
export function parseRssDate(s) {
  if (!s || typeof s !== "string") return NaN;
  const t = s.trim();
  // "YYYY-MM-DD HH:MM[:SS]" with no zone → rss2json's UTC shape. Anything carrying a
  // zone (RFC-822 "… GMT", ISO with Z or ±hh:mm) is left to the native parser.
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t);
  return new Date(zoneless ? `${t.replace(" ", "T")}Z` : t).getTime();
}

/**
 * Compact relative age ("now" / "17m" / "20h" / "3d"), or "" when undatable.
 * Never returns a negative value — see the header note.
 */
export function timeAgo(s, now = Date.now()) {
  const t = parseRssDate(s);
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, (now - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}
