// ── Call resolution events ──
// A call used to resolve in total silence: the hourly cron stamped gradedOutcome and
// nobody was told. That's the single most engaging moment the product has — "your call
// hit target, +2R, you were right" — and it produced no signal anywhere.
//
// Post → silence is how a social product dies at cold start, so a resolution now fans
// out three ways:
//   1. an in-app notification for the author
//   2. a Telegram DM, if they've linked a chat
//   3. a PUBLIC feed event — free social proof, and the thing that makes an otherwise
//      quiet feed show movement
//
// ⚠️ Dispatch happens only AFTER the wallet's record is successfully written. Notifying
// first would tell someone their call resolved and then lose the stamp on a failed
// put, so the next cron pass would resolve and notify it all over again.
import { appendNotification } from "./shared.mjs";

export const RESOLVED_FEED_KEY = "resolved:feed";
const MAX_FEED = 60;

const bare = (s) => String(s || "").replace("PERP_", "").replace("_USDC", "");

/**
 * The copy for one resolution. Pure so the wording is testable and identical across
 * the in-app notification, the Telegram DM and the feed entry.
 * @returns {{ won:boolean, r:number, title:string, message:string, telegram:string }}
 */
export function resolutionMessage(t, outcome, r) {
  const won = outcome === "WIN";
  const sym = bare(t?.symbol);
  const dir = String(t?.direction || "").toUpperCase();
  const rTxt = `${r > 0 ? "+" : ""}${Math.round(r * 100) / 100}R`;
  const verb = won ? "hit target" : "stopped out";
  return {
    won,
    r,
    title: won ? "Call hit target" : "Call stopped out",
    // Deliberately plain. The grade is a fact about public price — it needs no
    // celebration on a win and no sympathy on a loss; both read as spin.
    message: `${sym} ${dir} ${verb} — ${rTxt}`,
    telegram: [
      `<b>${won ? "✅" : "✖"} ${sym} ${dir} ${verb}</b>`,
      `${rTxt} · graded from public price`,
      t?.entryPrice ? `entry ${t.entryPrice} · ${won ? "target" : "stop"} ${won ? t.takeProfit1 : t.stopLoss}` : "",
    ].filter(Boolean).join("\n"),
  };
}

/** Public feed entry for a resolved call — what makes the feed show movement. */
export function resolutionFeedEntry(wallet, t, outcome, r) {
  const m = resolutionMessage(t, outcome, r);
  return {
    kind: "RESOLUTION",
    wallet,
    thesisId: t?.id ?? null,
    symbol: bare(t?.symbol),
    direction: t?.direction ?? null,
    outcome,
    r: Math.round(r * 100) / 100,
    message: m.message,
    createdAt: Date.now(),
  };
}

/**
 * Fan out one resolution. Every leg is best-effort and independently guarded: a
 * Telegram outage must not cost the author their in-app notification, and neither may
 * break the grading cron that called us.
 */
export async function notifyResolution(env, wallet, t, outcome, r) {
  const m = resolutionMessage(t, outcome, r);

  try {
    await appendNotification(env, String(wallet).toLowerCase(), {
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: "call_resolved",
      message: m.message,
      thesisId: t?.id ?? undefined,
      createdAt: Date.now(),
      read: false,
    }, { telegram: false }); // this fn sends its own richer Telegram DM below
  } catch (e) { console.error("[resolve] notif failed", e.message); }

  try {
    const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
    const chatId = await AGENT_KV.get(`tg:chat:${String(wallet).toLowerCase()}`);
    if (chatId && env.TELEGRAM_TOKEN) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: m.telegram, parse_mode: "HTML", disable_web_page_preview: true }),
      });
    }
  } catch (e) { console.error("[resolve] telegram failed", e.message); }

  try {
    const raw = await env.LAB_STORE.get(RESOLVED_FEED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(resolutionFeedEntry(wallet, t, outcome, r));
    await env.LAB_STORE.put(RESOLVED_FEED_KEY, JSON.stringify(list.slice(0, MAX_FEED)));
  } catch (e) { console.error("[resolve] feed failed", e.message); }
}
