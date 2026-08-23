// ── OKX fetch helper — one retry to harden the flaky CF→OKX egress ───────────
// The OKX public endpoints (tickers, trades, books, liquidation-orders, candles) occasionally
// hiccup when called from a Cloudflare Worker (shared egress), returning a non-"0" code or
// throwing — which intermittently blanked basis/CVD/order-book/liq reads in THE READ. A single
// fast retry catches the vast majority of those transients. Returns the parsed JSON (caller
// still checks `code === "0"`); on total failure returns the last response so callers fail soft.
export async function okxJson(url, tries = 2) {
  let last = { code: "err" };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (j && j.code === "0") return j;
      last = j || last;
    } catch (e) {
      last = { code: "err", msg: String(e && e.message || e) };
    }
  }
  return last;
}
