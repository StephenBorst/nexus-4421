// Pure date / formatting helpers for The Lab.
// Extracted from index.tsx (god-file split) — no behavior change.

export function formatPnl(val: number) {
  return `${val >= 0 ? "+" : ""}$${Math.abs(val).toFixed(2)}`;
}

export function getDayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function daysInMonth(month: number, year: number) {
  return new Date(year, month + 1, 0).getDate();
}

export function firstDayOfMonth(month: number, year: number) {
  return new Date(year, month, 1).getDay();
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ─── Chart images on theses ───────────────────────────────────────────────────
// A thesis chartUrl is USER-SUPPLIED and is rendered on other people's screens via
// the public feed. Validating only at input time is not enough: anything written
// straight to KV (or an older record) would still render for everyone. So this is
// the RENDER-TIME gate — call it at every display site and it fails closed.
//
// The risk isn't script execution (it's an <img src>) — it's that an arbitrary host
// sees every viewer's IP/User-Agent, and that we'd be proxying unvetted content.
// Hence an explicit host allowlist plus https-only. Render with
// referrerPolicy="no-referrer" so we never leak the viewer's page either.
const CHART_HOSTS = [
  "s3.tradingview.com",   // TradingView snapshot images (the camera icon)
  "www.tradingview.com",
  "tradingview.com",
  "i.imgur.com",
  "imgur.com",
  "pbs.twimg.com",        // images lifted from an X post
];

/** Returns the URL only if it's a safe, allowlisted chart image — otherwise null. */
export function chartImageSrc(raw?: string | null): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;              // no http, no data:, no javascript:
  const host = u.hostname.toLowerCase();
  const ok = CHART_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return ok ? u.toString() : null;
}

/** Hosts we accept, for user-facing hint text. Keep in sync with CHART_HOSTS. */
export const CHART_HOST_HINT = "TradingView snapshot, imgur, or an X image URL";
