// Heuristic thesis parser — turns a pasted freeform thesis (e.g. a TradingView
// analysis blob) into the Thesis form fields, so a trader doesn't retype what
// they already wrote. Pure + client-side: NO AI, NO cost, NO gating. It is
// deliberately CONSERVATIVE — it only fills a field when a keyword clearly anchors
// a number, drops the full text into `notes`, and leaves the rest for the trader to
// confirm. Pinned by app/lib/thesisParse.test.mjs.

// Quote suffixes we strip to recover the base ticker (ZECUSD -> ZEC, ETH/USDT -> ETH).
const QUOTES = ["USDT", "USDC", "USD", "PERP", "BUSD", "DAI"];

// Keyword windows (lowercased). A price is classified by the nearest keyword that
// precedes it within ~48 chars. Order of the sets below is the tie-break priority.
const KW = {
  stop: ["stop below", "stop-loss", "stop loss", "stoploss", " sl ", "invalidat", "risk below", "protective", "cut below", "stop at", "stop "],
  entry: ["entry", "enter", "buy zone", "buy the", "long entry", "short entry", "trigger", "accumulate", "golden pocket", "reclaim", "scale in", "bid ", "add at", "dca", "get in", "load"],
  target: ["target", "take profit", "take-profit", "tp1", "tp2", "tp3", " tp ", "objective", "first supply", "supply zone", "resistance", "extension", "measured move", "profit at", "aim for"],
};

// Direction signals, weighted. Explicit "<long/short> entry" and net bias win.
const BULL = [/\bnet bullish\b/g, /\blong entry\b/g, /\bgo long\b/g, /\blong\b/g, /\bbullish\b/g, /\bbuy\b/g, /\baccumulat/g, /\bhigher high\b/g];
const BEAR = [/\bnet bearish\b/g, /\bshort entry\b/g, /\bgo short\b/g, /\bshort\b/g, /\bbearish\b/g, /\bsell\b/g, /\bbreakdown\b/g, /\blower low\b/g];

function detectSymbol(text) {
  // A: TICKER + quote (ZECUSD, ETH/USDT, BTC-USD)
  const a = text.match(/\b([A-Z]{2,6})\s*[/\-]?\s*(USDT|USDC|USD|PERP|BUSD|DAI)\b/);
  if (a && !QUOTES.includes(a[1])) return a[1];
  // B: cashtag ($BTC)
  const b = text.match(/\$([A-Za-z]{2,6})\b/);
  if (b && !QUOTES.includes(b[1].toUpperCase()) && !/^\d/.test(b[1])) return b[1].toUpperCase();
  // C: "long|short <TICKER>"
  const c = text.match(/\b(?:long|short|buy|sell)\s+([A-Z]{2,6})\b/i);
  if (c && !QUOTES.includes(c[1].toUpperCase())) return c[1].toUpperCase();
  return null;
}

function detectDirection(text) {
  const t = text.toLowerCase();
  const count = (arr) => arr.reduce((n, re) => n + (t.match(re)?.length || 0), 0);
  // Explicit "net bullish/bearish" or "<x> entry" short-circuits.
  if (/\bnet bearish\b/.test(t) || /\bshort entry\b/.test(t)) return "SHORT";
  if (/\bnet bullish\b/.test(t) || /\blong entry\b/.test(t)) return "LONG";
  const bull = count(BULL), bear = count(BEAR);
  if (bull === 0 && bear === 0) return null;
  if (bull === bear) return null;
  return bull > bear ? "LONG" : "SHORT";
}

// Pull candidate price numbers with their index. Requires a `$` prefix OR proximity
// to a price keyword, so we don't grab percentages, leverage ("3x"), hours ("72h"),
// dates, or ADX/RSI readings.
function extractPrices(text) {
  const out = [];
  const re = /(\$\s*)?(\d[\d,]*(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(text))) {
    const hasDollar = !!m[1];
    const raw = m[2];
    const idx = m.index;
    const end = re.lastIndex;
    const after = text.slice(end, end + 4).toLowerCase();
    // Reject obvious non-prices by a DIRECTLY-attached unit / ordinal / time
    // (no leading space — otherwise "$90 stop" would look like the ordinal "st").
    if (/^(%|x|h|m|d|k|bps|st|nd|rd|th|:)/.test(after)) continue;
    const val = parseFloat(raw.replace(/,/g, ""));
    if (!Number.isFinite(val) || val <= 0) continue;
    // Bare integers < 3 digits with no `$` are too noisy (ADX 21, RSI 11) — skip.
    if (!hasDollar && !raw.includes(".") && val < 100) continue;
    out.push({ val, idx, end });
  }
  return out;
}

// Target names often TRAIL their price ("$624 supply zone", "$685 resistance"),
// unlike entry/stop which are almost always led by the keyword ("stop below $415").
const TRAILING_TARGET = ["supply zone", "supply", "resistance", "target", "objective"];

function classify(text, idx, endIdx) {
  const before = text.slice(Math.max(0, idx - 48), idx).toLowerCase();
  // Nearest PRECEDING keyword wins (score by closeness to the number).
  let best = null, bestPos = -1;
  for (const kind of ["stop", "entry", "target"]) {
    for (const kw of KW[kind]) {
      const p = before.lastIndexOf(kw.trim());
      if (p > bestPos) { bestPos = p; best = kind; }
    }
  }
  if (best) return best;
  // No leading anchor — check a short trailing window for a target name.
  const after = text.slice(endIdx, endIdx + 40).toLowerCase();
  if (TRAILING_TARGET.some((kw) => after.includes(kw))) return "target";
  return null;
}

/**
 * Parse a freeform thesis into partial form fields.
 * @param {string} text
 * @returns {{ symbol: string|null, direction: "LONG"|"SHORT"|null,
 *   entryPrice: string|null, stopLoss: string|null, takeProfit1: string|null,
 *   takeProfit2: string|null, notes: string, filled: string[] }}
 */
export function parseThesis(text) {
  const src = String(text || "");
  const empty = { symbol: null, direction: null, entryPrice: null, stopLoss: null,
    takeProfit1: null, takeProfit2: null, notes: "", filled: [] };
  if (!src.trim()) return empty;

  const symbol = detectSymbol(src);
  const direction = detectDirection(src);

  const prices = extractPrices(src);
  let entry = null, stop = null;
  const targets = [];
  for (const p of prices) {
    const kind = classify(src, p.idx, p.end);
    if (kind === "stop" && stop === null) stop = p.val;
    else if (kind === "entry" && entry === null) entry = p.val;
    else if (kind === "target") targets.push(p.val);
  }

  const num = (v) => (v === null ? null : String(v));
  const filled = [];
  if (symbol) filled.push("symbol");
  if (direction) filled.push("direction");
  if (entry !== null) filled.push("entry");
  if (stop !== null) filled.push("stop");
  if (targets.length) filled.push("target");

  return {
    symbol,
    direction,
    entryPrice: num(entry),
    stopLoss: num(stop),
    takeProfit1: num(targets[0] ?? null),
    takeProfit2: num(targets[1] ?? null),
    notes: src.trim(),
    filled,
  };
}
