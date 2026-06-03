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
