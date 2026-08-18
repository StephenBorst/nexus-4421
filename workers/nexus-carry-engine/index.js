// ── nexus-carry-engine · WORKER SHELL (Phase 3, PAPER) ────────────────────────
// Cron worker that runs the sector-neutral funding-carry basket in PAPER and serves
// its live, verifiable track record. Every tick: fetch Orderly public futures → build
// the { funding, mark } snapshot → stepPaper() → persist to KV. Read-only endpoints
// expose the book + equity curve so the sleeve proves itself in the open.
//
// PAPER ONLY. There is no key, no order, no money-path here. The live maker executor
// (Phase 3b) is a separate, security-reviewed switch that reuses the SAME engine — it
// is intentionally NOT in this file. Do not add order placement here.
import { freshState, stepPaper, summarize } from "./carryPaper.mjs";
import { snapshotFromFutures, coverage } from "./carryLive.mjs";
import { runLive } from "./carryLiveExec.mjs";

const ORDERLY = "https://api-evm.orderly.org";
const STATE_KEY = "carry:state";

function defaultConfig(env) {
  return {
    capital: num(env.CARRY_CAPITAL, 1000),
    perSide: num(env.CARRY_PERSIDE, 1),
    rebalanceHours: num(env.CARRY_REBAL_H, 24),
    makerFeeBps: env.CARRY_MAKER_BPS != null ? Number(env.CARRY_MAKER_BPS) : -0.1,
    minFundingSpread: env.CARRY_MIN_SPREAD != null ? Number(env.CARRY_MIN_SPREAD) : 0,
  };
}
const num = (v, d) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

async function loadState(env) {
  const raw = await env.CARRY.get(STATE_KEY);
  if (raw) { try { return JSON.parse(raw); } catch { /* fall through to fresh */ } }
  return freshState(defaultConfig(env));
}
async function saveState(env, s) { await env.CARRY.put(STATE_KEY, JSON.stringify(s)); }

async function fetchSnapshot() {
  const d = await fetch(`${ORDERLY}/v1/public/futures`).then((r) => r.json());
  return snapshotFromFutures(d?.data?.rows || []);
}

async function runTick(env, snap) {
  const state = await loadState(env);
  snap = snap || await fetchSnapshot();
  const cov = coverage(snap);
  // guard: don't rebalance on a thin/broken data pull (would churn the book wrongly)
  if (cov.tradableSectors < 2) return { skipped: "thin_snapshot", coverage: cov };
  const { state: next, tick } = stepPaper(state, snap, Date.now(), defaultConfig(env));
  next.lastCoverage = cov;
  await saveState(env, next);
  return { tick, coverage: cov, summary: summarize(next) };
}

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
});
const authed = (req, env) => {
  const need = env.CARRY_ADMIN_TOKEN || "";
  return !need || req.headers.get("x-carry-token") === need;
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const snap = await fetchSnapshot();
        const cov = coverage(snap);
        if (cov.tradableSectors < 2) { console.log("carry skip thin", JSON.stringify(cov)); return; }
        const paper = await runTick(env, snap);
        env.CARRY?.put("ops:carry:heartbeat", String(Date.now()));
        console.log("carry paper", JSON.stringify(paper.tick || paper.skipped));
        // Live executor — shares the SAME snapshot as paper; no-ops unless CARRY_LIVE=true + key + not killed.
        if (env.CARRY_LIVE === "true") {
          const live = await runLive(env, snap);
          console.log("carry live", JSON.stringify(live));
        }
      } catch (e) { console.error("carry tick error", e && e.stack || e); }
    })());
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/carry/health") {
        const s = await loadState(env);
        const ageSec = s.lastTickTs ? Math.round((Date.now() - s.lastTickTs) / 1000) : null;
        return json({ ok: true, mode: env.CARRY_MODE || "paper", legs: s.book.legs.length, rebalances: s.rebalances, lastTickAgeSec: ageSec });
      }
      if (url.pathname === "/carry/status") {
        const s = await loadState(env);
        return json({ mode: env.CARRY_MODE || "paper", config: s.config, book: s.book.legs, coverage: s.lastCoverage || null, summary: summarize(s) });
      }
      if (url.pathname === "/carry/record") {
        const s = await loadState(env);
        return json({ mode: env.CARRY_MODE || "paper", summary: summarize(s), equityCurve: s.equityCurve || [] });
      }
      if (url.pathname === "/carry/tick" && req.method === "POST") {
        if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
        return json(await runTick(env));
      }
      if (url.pathname === "/carry/live/status") {
        const armed = env.CARRY_LIVE === "true";
        const hasKey = !!(env.CARRY_TRADING_KEY && env.CARRY_ACCOUNT_ID);
        const killed = !!(await env.CARRY.get("carry:kill"));
        const raw = await env.CARRY.get("carry:live:state");
        return json({ armed, hasKey, killed, liveCapital: Number(env.CARRY_LIVE_CAPITAL || env.CARRY_CAPITAL || 1000), lastLive: raw ? JSON.parse(raw) : null });
      }
      if (url.pathname === "/carry/live/tick" && req.method === "POST") {
        if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
        return json(await runLive(env, await fetchSnapshot()));
      }
      if (url.pathname === "/carry/kill" && req.method === "POST") {
        if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
        await env.CARRY.put("carry:kill", "1");
        return json({ ok: true, killed: true });
      }
      if (url.pathname === "/carry/unkill" && req.method === "POST") {
        if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
        await env.CARRY.delete("carry:kill");
        return json({ ok: true, killed: false });
      }
      if (url.pathname === "/carry/reset" && req.method === "POST") {
        if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
        await saveState(env, freshState(defaultConfig(env)));
        return json({ ok: true, reset: true });
      }
      return json({ error: "not_found", routes: ["/carry/health", "/carry/status", "/carry/record", "/carry/live/status", "POST /carry/tick", "POST /carry/reset", "POST /carry/live/tick", "POST /carry/kill", "POST /carry/unkill"] }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
