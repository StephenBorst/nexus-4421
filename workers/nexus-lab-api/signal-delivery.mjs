// ── Server-side signal delivery — signals reach you when the app is CLOSED ────
// The proactive layer, off-device: an hourly cron computes the SAME signals the global
// ◆ SIGNALS bell shows (shared `buildSignals` from app/lib — one engine, zero drift) and
// DMs the single highest-conviction one to opted-in Telegram subscribers, throttled and
// deduped so it never spams. Opt-in via the bot `/signals on`. Requires TELEGRAM_TOKEN.
import { confluenceSignal, consensusBySymbol, classifyRegime, fundingStretched, readVerdict } from "./logic.mjs";
import { gatherStanceEntries } from "./grading.mjs";
import { buildSignals } from "../../app/lib/signals.mjs";

const SIGNAL_SYMS = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_ARB_USDC", "PERP_HYPE_USDC", "PERP_XRP_USDC", "PERP_DOGE_USDC"];

// Final EMA value over a close series (SMA-seeded). The levels traders actually watch —
// so a momentum signal can say "pulled back to the 4H EMA8 ($X), the retest of the trend"
// instead of just "it's trending". Null when there aren't enough candles.
function emaLast(vals, period) {
  if (!Array.isArray(vals) || vals.length < period) return null;
  const k = 2 / (period + 1);
  let ema = vals.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < vals.length; i++) ema = vals[i] * k + ema * (1 - k);
  return ema;
}

// The MOMENTUM signal source. A trend read per core symbol, classified from 1h OHLC by
// the SAME classifyRegime that grades a caller's align edge — so "ride the trend" (a
// momentum setup) and "your align edge is WITH the trend" (the user's class) speak one
// language. Cached in KV so the /signals hot path only does a cheap read, not an OHLC
// fetch. Run on the hourly cron. Returns how many symbols were classified.
export async function snapshotTrendRegimes(env) {
  const KV = env.NEXUS_AGENT || env.LAB_STORE;
  const now = Math.floor(Date.now() / 1000);
  const from = now - 80 * 3600; // ~80 candles ≥ the 48-candle lookback
  let stored = 0;
  await Promise.all(SIGNAL_SYMS.map(async (sym) => {
    try {
      const d = await (await fetch(`https://api-evm.orderly.org/tv/history?symbol=${sym}&resolution=60&from=${from}&to=${now}`)).json();
      if (!d || d.s !== "ok" || !Array.isArray(d.t) || !d.t.length) return;
      const cd = { t: d.t, h: d.h, l: d.l, c: d.c };
      const reg = classifyRegime(cd, cd.t[cd.t.length - 1]);
      if (!reg) return;
      const bare = sym.replace("PERP_", "").replace("_USDC", "");
      // OI-confirmation: rising open interest in a trend = new money committing (real
      // conviction) vs flat/bleeding OI = a squeeze or exhaustion (fakeout risk). Compute
      // the ~hourly OI delta vs the PRIOR regime snapshot, using the brain's market:prev
      // OI reading (no extra fetch). Null on the first run until two snapshots accrue.
      const prevMkt = JSON.parse((await KV.get(`market:prev:${sym}`)) || "null");
      const curOi = Number(prevMkt?.oi) || null;
      const priorReg = JSON.parse((await KV.get(`regime:${bare}`)) || "null");
      const oiChangePct = (priorReg?.oi && curOi) ? Number((((curOi - priorReg.oi) / priorReg.oi) * 100).toFixed(2)) : null;
      // 4H EMA8/EMA21 — the trend levels traders retest to. One extra fetch per symbol,
      // hourly. Rounded to sensible precision for the price magnitude.
      let ema8 = null, ema21 = null;
      try {
        const d4 = await (await fetch(`https://api-evm.orderly.org/tv/history?symbol=${sym}&resolution=240&from=${now - 240 * 3600}&to=${now}`)).json();
        if (d4 && d4.s === "ok" && Array.isArray(d4.c) && d4.c.length >= 8) {
          const c4 = d4.c.map(Number).filter(Number.isFinite);
          const r8 = emaLast(c4, 8), r21 = emaLast(c4, 21);
          const dp = c4[c4.length - 1] >= 1000 ? 0 : c4[c4.length - 1] >= 1 ? 2 : 5;
          ema8 = r8 != null ? Number(r8.toFixed(dp)) : null;
          ema21 = r21 != null ? Number(r21.toFixed(dp)) : null;
        }
      } catch { /* no levels this run */ }
      await KV.put(`regime:${bare}`, JSON.stringify({ trend: reg.trend, vol: reg.vol, movePct: reg.movePct, oi: curOi, oiChangePct, ema8, ema21, t: Date.now() }), { expirationTtl: 6 * 3600 });
      stored++;
    } catch { /* skip this symbol */ }
  }));
  return stored;
}
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
      const bare = sym.replace("PERP_", "").replace("_USDC", "");
      const reg = JSON.parse((await KV.get(`regime:${bare}`)) || "null"); // cached trend read
      // ── THE ONE VERDICT (Grok): the SAME funding-fade read the ticket + share card use,
      // computed once here so The Board speaks their language. The fade side = the funding
      // sign; FADE only when funding is STRETCHED vs its own p25–p75 range (pierce test on
      // oi:hist), else WATCH. Funding annualized (×1095) to match the ticket's %/yr.
      const histRaw = await KV.get(`oi:hist:${sym}`);
      const fs = histRaw ? (JSON.parse(histRaw) || []).map((h) => Number(h.funding)).filter(Number.isFinite) : [];
      const stretched = fundingStretched(fs);
      const fadeDir = funding > 0 ? "SHORT" : funding < 0 ? "LONG" : "NONE";
      const fundingAnnualPct = Number((funding * 1095 * 100).toFixed(2));
      const verdict = readVerdict(fadeDir, stretched, fundingAnnualPct); // FADE only if pierce AND |annual| ≥ floor
      return {
        symbol: bare,
        mark_price: mark, funding_rate_8h: funding, open_interest: oi,
        funding_annual_pct: fundingAnnualPct,
        fade_dir: fadeDir, verdict, stretched,
        price_change_pct: Number((priceChange * 100).toFixed(3)),
        oi_change_pct: Number((oiChange * 100).toFixed(3)),
        funding_signal: sig.fundingSignal, oi_signal: sig.oiSignal, confluence: sig.confluence,
        trend: reg?.trend ?? null, trend_move_pct: reg?.movePct ?? null, trend_oi_pct: reg?.oiChangePct ?? null,
        ema8_4h: reg?.ema8 ?? null, ema21_4h: reg?.ema21 ?? null,
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
export async function deliverSignals(env, opts = {}) {
  const dryRun = !!opts.dryRun;
  const KV = env.NEXUS_AGENT || env.LAB_STORE;
  const last = JSON.parse((await KV.get(BROADCAST_KEY)) || "null") || { id: null, ts: 0 };
  const hasToken = !!env.TELEGRAM_TOKEN;

  const [signals, consensus, evRaw] = await Promise.all([
    computeSignalRows(env),
    (async () => { try { const { entries } = await gatherStanceEntries(env); return consensusBySymbol(entries); } catch { return null; } })(),
    KV.get("xray:events"),
  ]);
  const built = buildSignals({ signals, consensus, xrayEvents: evRaw ? JSON.parse(evRaw) : [] });
  const top = built.find((s) => s.kind === "FADE_ALIGN" || s.kind === "DIVERGENCE" || s.kind === "MOMENTUM");
  const subs = await KV.list({ prefix: "signals:sub:" });
  // Ops-visible diagnostic so `/signals/deliver-now` shows WHY it did or didn't fire.
  const diag = { hasToken, built: built.length, top: top ? { id: top.id, kind: top.kind, title: top.title } : null, subscribers: subs.keys.length, last, throttleMs: MIN_BROADCAST_MS };

  if (!hasToken) return { sent: 0, reason: "no_token", ...diag };
  if (!top) return { sent: 0, reason: "no_high_conviction_signal", ...diag };
  if (top.id === last.id) return { sent: 0, reason: "unchanged", ...diag };
  if (Date.now() - (last.ts || 0) < MIN_BROADCAST_MS) return { sent: 0, reason: "throttled", wouldSend: top.id, ...diag };
  if (!subs.keys.length) { if (!dryRun) await KV.put(BROADCAST_KEY, JSON.stringify({ id: top.id, ts: Date.now() })); return { sent: 0, reason: "no_subscribers", wouldSend: top.id, ...diag }; }
  if (dryRun) return { sent: 0, reason: "dry_run", wouldSend: top.id, ...diag };

  const text = `◆ <b>Nexus signal</b>\n${top.title}\n${top.detail}\n\n<a href="https://trade.nexustradinglabs.com/lab?tab=${top.tab}">Open the Lab →</a>\n<i>Send /signals off to stop.</i>`;
  let sent = 0;
  for (const k of subs.keys) {
    const chatId = k.name.slice("signals:sub:".length);
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (r.ok) sent++;
      else console.error(`[signals] send failed chat=${chatId} status=${r.status}`);
    } catch (e) { console.error(`[signals] send error chat=${chatId}: ${e.message}`); }
  }
  await KV.put(BROADCAST_KEY, JSON.stringify({ id: top.id, ts: Date.now() }));
  return { sent, id: top.id, ...diag };
}
