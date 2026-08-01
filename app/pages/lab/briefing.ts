// ── THE BRIEFING — deterministic intelligence over the trader's own record ───
// The Lab's differentiator isn't another chart; it's synthesis. This module reads
// the user's REAL closed-trade record (plus the live tape + agent state) and ranks
// what actually matters right now into a short, actionable briefing — no LLM, no
// key, works for everyone, instant. The insights nobody else can compute because
// nobody else has your graded record.
//
// Pure + side-effect-free so the logic is testable and can't drift with the UI.
// Design law: green = genuinely positive (profit-adjacent), amber = caution, bone =
// neutral info. Red is reserved for realized loss elsewhere — a risk *warning* is
// amber, not red.

export type InsightTone = "positive" | "caution" | "info";

export interface Insight {
  id: string;
  priority: number;                 // higher ranks first
  tone: InsightTone;
  title: string;                    // short headline
  detail: string;                   // one supporting line
  action?: { label: string; tab?: string }; // jump target inside the Lab
}

export interface BriefingTrade {
  symbol: string;
  direction: "LONG" | "SHORT";
  pnl: number;
  timestamp: number;
}

export interface BriefingInput {
  trades: BriefingTrade[];          // closed trades, any order
  winRate: number;                  // 0-100, overall
  totalPnl: number;
  openPositions: { symbol: string; direction: "LONG" | "SHORT" }[];
  tape: { label: string; score: number } | null; // RISK-ON / NEUTRAL / RISK-OFF
  agent: { active: boolean } | null;
}

// Compute the market TAPE from the public futures rows — same formula as MarketTape
// (breadth 50% / BTC trend 40% / funding crowding 10%). Kept pure here so the
// Briefing can read the tape without mounting the strip. Returns null on no data.
export function computeTape(rows: { symbol: string; "24h_open"?: string | number; "24h_close"?: string | number; last_funding_rate?: string | number }[] | null) {
  if (!rows || !rows.length) return null;
  const pct = (o?: string | number, c?: string | number) => {
    const oo = parseFloat(String(o ?? 0)), cc = parseFloat(String(c ?? 0));
    if (!oo || !cc) return 0;
    const p = ((cc - oo) / oo) * 100;
    return Math.abs(p) > 50 ? 0 : p;
  };
  const changes = rows.map((m) => pct(m["24h_open"], m["24h_close"]));
  const breadth = Math.round((changes.filter((c) => c > 0).length / changes.length) * 100);
  const btc = rows.find((m) => m.symbol === "PERP_BTC_USDC");
  const btcChg = btc ? pct(btc["24h_open"], btc["24h_close"]) : 0;
  const fundings = rows.map((m) => parseFloat(String(m.last_funding_rate ?? 0))).filter((f) => !isNaN(f));
  const fundSkew = fundings.length ? Math.round((fundings.filter((f) => f > 0).length / fundings.length) * 100) : 50;
  const btcScore = Math.max(0, Math.min(100, 50 + btcChg * 6));
  const fundScore = 100 - Math.abs(fundSkew - 50) * 2;
  const score = Math.round(breadth * 0.5 + btcScore * 0.4 + fundScore * 0.1);
  const label = score >= 60 ? "RISK-ON" : score >= 42 ? "NEUTRAL" : "RISK-OFF";
  return { score, label };
}

const ticker = (sym: string) => sym.replace("PERP_", "").replace("_USDC", "");
const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(1)}K` : Math.abs(n).toFixed(2)}`;
const wrOf = (rows: BriefingTrade[]) => (rows.length ? Math.round((rows.filter((t) => t.pnl > 0).length / rows.length) * 1000) / 10 : 0);

// Net P&L by symbol → the single best and single worst market.
function bySymbol(trades: BriefingTrade[]) {
  const m = new Map<string, { net: number; n: number }>();
  for (const t of trades) {
    const k = ticker(t.symbol);
    const cur = m.get(k) || { net: 0, n: 0 };
    cur.net += t.pnl; cur.n += 1; m.set(k, cur);
  }
  const arr = [...m.entries()].filter(([, v]) => v.n >= 2);
  if (!arr.length) return null;
  arr.sort((a, b) => b[1].net - a[1].net);
  return { best: arr[0], worst: arr[arr.length - 1] };
}

/**
 * Build the ranked briefing. Returns [] when there's nothing honest to say
 * (e.g. no trades yet) — the caller renders nothing rather than filler.
 */
export function buildBriefing(input: BriefingInput): Insight[] {
  const { trades, winRate, totalPnl, openPositions, tape, agent } = input;
  const out: Insight[] = [];
  const sorted = [...trades].sort((a, b) => b.timestamp - a.timestamp); // newest first
  const n = sorted.length;

  // 1 — Open position fighting the tape (highest priority: it's live risk NOW).
  if (tape && openPositions.length) {
    for (const p of openPositions) {
      const fights =
        (tape.label === "RISK-OFF" && p.direction === "LONG") ||
        (tape.label === "RISK-ON" && p.direction === "SHORT");
      if (fights) {
        out.push({
          id: `conflict-${ticker(p.symbol)}`,
          priority: 95,
          tone: "caution",
          title: `Your ${p.direction} ${ticker(p.symbol)} is against a ${tape.label} tape`,
          detail: `Broad ${tape.label === "RISK-OFF" ? "weakness" : "strength"} (${tape.score}/100) — tighten the stop or size down unless your thesis is specifically a fade.`,
          action: { label: "Check the tape", tab: "smart" },
        });
      }
    }
  }

  // 2 — Recent streak (behavioral; acts on the last few closes).
  if (n >= 3) {
    const last3 = sorted.slice(0, 3);
    if (last3.every((t) => t.pnl < 0)) {
      out.push({
        id: "streak-cold",
        priority: 85,
        tone: "caution",
        title: "Three straight losses",
        detail: "Cold streaks compound when you press to get even. Size down or step away — the tape will still be here tomorrow.",
        action: { label: "Review the log", tab: "tradelog" },
      });
    } else if (n >= 4 && sorted.slice(0, 4).every((t) => t.pnl > 0)) {
      out.push({
        id: "streak-hot",
        priority: 55,
        tone: "positive",
        title: "Four wins in a row",
        detail: "You're in rhythm. Press the edge, but keep the same risk per trade — streaks end when size creeps.",
        action: { label: "See what's working", tab: "analytics" },
      });
    }
  }

  // 3 — Directional edge (needs a real sample on both sides).
  const longs = trades.filter((t) => t.direction === "LONG");
  const shorts = trades.filter((t) => t.direction === "SHORT");
  if (longs.length >= 4 && shorts.length >= 4) {
    const lw = wrOf(longs), sw = wrOf(shorts);
    if (Math.abs(lw - sw) >= 15) {
      const strong = lw > sw ? "long" : "short";
      const weak = lw > sw ? "short" : "long";
      out.push({
        id: "edge-directional",
        priority: 70,
        tone: "info",
        title: `Your edge is on the ${strong} side`,
        detail: `${lw}% win rate ${strong === "long" ? "long" : "short"} vs ${sw > lw ? sw : Math.min(lw, sw)}% ${weak}. Trade more ${strong}s; be far more selective on ${weak}s.`,
        action: { label: "Full breakdown", tab: "analytics" },
      });
    }
  }

  // 4 — Best / worst market by realized P&L.
  const sym = bySymbol(trades);
  if (sym && sym.best[0] !== sym.worst[0]) {
    const [bName, bV] = sym.best;
    const [wName, wV] = sym.worst;
    if (bV.net > 0 && wV.net < 0) {
      out.push({
        id: "market-spread",
        priority: 60,
        tone: "info",
        title: `${bName} pays you; ${wName} bleeds you`,
        detail: `${bName} ${money(bV.net)} over ${bV.n} trades — ${wName} ${money(wV.net)} over ${wV.n}. Concentrate where you have the read.`,
        action: { label: "By-market stats", tab: "analytics" },
      });
    }
  }

  // 5 — Overtrading: do you win less on your busy days?
  if (n >= 12) {
    const byDay = new Map<string, BriefingTrade[]>();
    for (const t of trades) {
      const d = new Date(t.timestamp); const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      (byDay.get(k) || byDay.set(k, []).get(k)!).push(t);
    }
    const days = [...byDay.values()];
    if (days.length >= 4) {
      const avg = trades.length / days.length;
      const busy = days.filter((d) => d.length > avg).flat();
      const calm = days.filter((d) => d.length <= avg).flat();
      if (busy.length >= 4 && calm.length >= 4) {
        const bw = wrOf(busy), cw = wrOf(calm);
        if (cw - bw >= 12) {
          out.push({
            id: "overtrading",
            priority: 65,
            tone: "caution",
            title: "You win less on high-volume days",
            detail: `${bw}% on busy days vs ${cw}% on selective days. The extra trades are costing you — fewer, better setups.`,
            action: { label: "Open the calendar", tab: "tradelog" },
          });
        }
      }
    }
  }

  // 6 — Proven record, no agent running → automate the edge.
  if (agent && !agent.active && n >= 10 && winRate >= 50 && totalPnl > 0) {
    out.push({
      id: "agent-idle",
      priority: 50,
      tone: "info",
      title: "You have a proven record and no agent running",
      detail: `${winRate.toFixed(0)}% win rate, ${money(totalPnl)} net. Hand a rules version of your edge to the agent and let it work while you don't.`,
      action: { label: "Set up the agent", tab: "agent" },
    });
  }

  // 7 — Record anchor (always something honest to say once there are trades).
  if (n >= 1) {
    out.push({
      id: "record-anchor",
      priority: 20,
      tone: totalPnl >= 0 && winRate >= 50 ? "positive" : "info",
      title: `Your record: ${n} trades · ${winRate.toFixed(0)}% · ${money(totalPnl)}`,
      detail: totalPnl >= 0
        ? "Net-positive and graded from public price — the kind of record you can actually stand behind."
        : "Underwater right now. The log below is where the fix starts — find the pattern, cut it.",
      action: { label: "Prove it / dig in", tab: "analytics" },
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}
