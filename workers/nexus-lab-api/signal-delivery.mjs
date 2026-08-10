// ── Server-side signal delivery — signals reach you when the app is CLOSED ────
// The proactive layer, off-device: an hourly cron computes the SAME signals the global
// ◆ SIGNALS bell shows (shared `buildSignals` from app/lib — one engine, zero drift) and
// DMs the single highest-conviction one to opted-in Telegram subscribers, throttled and
// deduped so it never spams. Opt-in via the bot `/signals on`. Requires TELEGRAM_TOKEN.
import { confluenceSignal, consensusBySymbol } from "./logic.mjs";
import { gatherStanceEntries } from "./grading.mjs";
import { buildSignals } from "../../app/lib/signals.mjs";

const SIGNAL_SYMS = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_ARB_USDC", "PERP_HYPE_USDC", "PERP_XRP_USDC", "PERP_DOGE_USDC"];
const BROADCAST_KEY = "signals:broadcast";     // { id, ts } of the last DM'd signal
const MIN_BROADCAST_MS = 3 * 3600 * 1000;      // at most one push / 3h, however hot the tape

// The current funding + OI-divergence + confluence reads, classified by the SAME rules
// as the autonomous agent (confluenceSignal). Shared by the /signals route and delivery
// so the public API and the push can never disagree.
export async function computeSignalRows(env) {
  const KV = env.NEXUS_AGENT || env.LAB_STORE;
  const rows = await Promise.all(SIGNAL_SYMS.map(async (sym) => {
    try {
      const d = (await (await fetch(`https://api-evm.orderly.org/v1/public/futures/${sym}`)).json())?.data;
      if (!d || !d.mark_price) return null;
      const mark = Number(d.mark_price), funding = Number(d.last_funding_rate) || 0, oi = Number(d.open_interest) || 0;
      const prev = JSON.parse((await KV.get(`market:prev:${sym}`)) || "null");
      const priceChange = prev?.price ? (mark - prev.price) / prev.price : 0;
      const oiChange = prev?.oi ? (oi - prev.oi) / prev.oi : 0;
      const sig = confluenceSignal({ fundingRate: funding, priceChange, oiChange, hasPrev: !!prev });
      return {
        symbol: sym.replace("PERP_", "").replace("_USDC", ""),
        mark_price: mark, funding_rate_8h: funding, open_interest: oi,
        price_change_pct: Number((priceChange * 100).toFixed(3)),
        oi_change_pct: Number((oiChange * 100).toFixed(3)),
        funding_signal: sig.fundingSignal, oi_signal: sig.oiSignal, confluence: sig.confluence,
      };
    } catch { return null; }
  }));
  return rows.filter(Boolean).sort(
    (a, b) => (b.confluence !== "NONE") - (a.confluence !== "NONE") || Math.abs(b.funding_rate_8h) - Math.abs(a.funding_rate_8h)
  );
}

// Cron: build signals, pick the single highest-conviction push-worthy one (a fade where
// signal+crowd agree, or a real signal-vs-callers divergence), and DM opted-in chats —
// only when it's genuinely NEW and outside the throttle. Best-effort + fail-soft.
export async function deliverSignals(env) {
  if (!env.TELEGRAM_TOKEN) return { skipped: "no_token" };
  const KV = env.NEXUS_AGENT || env.LAB_STORE;
  const last = JSON.parse((await KV.get(BROADCAST_KEY)) || "null") || { id: null, ts: 0 };

  const [signals, consensus, evRaw] = await Promise.all([
    computeSignalRows(env),
    (async () => { try { const { entries } = await gatherStanceEntries(env); return consensusBySymbol(entries); } catch { return null; } })(),
    KV.get("xray:events"),
  ]);
  const built = buildSignals({ signals, consensus, xrayEvents: evRaw ? JSON.parse(evRaw) : [] });
  const top = built.find((s) => s.kind === "FADE_ALIGN" || s.kind === "DIVERGENCE");
  if (!top) return { sent: 0, reason: "no_high_conviction_signal" };
  if (top.id === last.id) return { sent: 0, reason: "unchanged" };
  if (Date.now() - (last.ts || 0) < MIN_BROADCAST_MS) return { sent: 0, reason: "throttled" };

  const subs = await KV.list({ prefix: "signals:sub:" });
  if (!subs.keys.length) { await KV.put(BROADCAST_KEY, JSON.stringify({ id: top.id, ts: Date.now() })); return { sent: 0, reason: "no_subscribers" }; }

  const text = `◆ <b>Nexus signal</b>\n${top.title}\n${top.detail}\n\n<a href="https://trade.nexustradinglabs.com/lab?tab=${top.tab}">Open the Lab →</a>\n<i>Send /signals off to stop.</i>`;
  let sent = 0;
  for (const k of subs.keys) {
    const chatId = k.name.slice("signals:sub:".length);
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      sent++;
    } catch { /* skip this chat */ }
  }
  await KV.put(BROADCAST_KEY, JSON.stringify({ id: top.id, ts: Date.now() }));
  return { sent, id: top.id };
}
