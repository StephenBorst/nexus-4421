// Pure date / formatting helpers for The Lab.
// Extracted from index.tsx (god-file split) — no behavior change.

export function formatPnl(val: number) {
  // ⚠️ The negative branch used to emit "" and then Math.abs() — so a LOSS rendered
  // as "$13.70", sign destroyed, with only colour carrying the meaning. Spotted on
  // prod: Analytics read "$13.70" while the header read "-$13.70". Never let a P&L
  // figure lose its sign; colour is reinforcement, not the source of truth.
  return `${val >= 0 ? "+" : "-"}$${Math.abs(val).toFixed(2)}`;
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
  "og.nexustradinglabs.com", // charts pasted from the clipboard, hosted by our worker
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

/** Max charts per thesis — enough for a multi-timeframe read without becoming a gallery. */
export const MAX_CHARTS = 4;

// Resolves a thesis's charts to a validated, safe list. Accepts the new chartUrls[]
// and transparently upgrades the legacy single chartUrl, so older records keep working.
// Every URL still goes through chartImageSrc(), so this fails closed per-item: one bad
// entry is dropped, the rest still render.
export function chartImageList(t?: { chartUrls?: string[]; chartUrl?: string } | null): string[] {
  if (!t) return [];
  const raw = t.chartUrls?.length ? t.chartUrls : t.chartUrl ? [t.chartUrl] : [];
  return raw.map((u) => chartImageSrc(u)).filter((u): u is string => !!u).slice(0, MAX_CHARTS);
}

// The status a thesis card should DISPLAY: the objective grade (stamped from public
// price by the server) wins over the self-reported status field, so "it grades itself"
// is true on the card, not just on the leaderboard. INVALIDATED is a real user action
// (thesis no longer valid) so it's preserved; otherwise an unresolved call is ACTIVE.
export function effectiveStatus(
  t?: { gradedOutcome?: "WIN" | "LOSS"; status?: string } | null,
): "ACTIVE" | "HIT_TP" | "STOPPED_OUT" | "INVALIDATED" {
  if (t?.gradedOutcome === "WIN") return "HIT_TP";
  if (t?.gradedOutcome === "LOSS") return "STOPPED_OUT";
  if (t?.status === "INVALIDATED") return "INVALIDATED";
  const s = t?.status;
  return s === "HIT_TP" || s === "STOPPED_OUT" || s === "INVALIDATED" ? s : "ACTIVE";
}
