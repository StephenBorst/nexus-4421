// ── Share the Trading Identity card ──
// One source for the tweet copy + share URL so the two entry points (Lab Operator
// Profile, trader page) can't drift. The URL is the crawler-unfurl proxy
// (/share/identity/:wallet) which renders the graded card; posting it is the viral
// loop — a claim only a graded record can make.

const SHARE_BASE = "https://og.nexustradinglabs.com/share/identity";

/**
 * Open an X compose with the identity card link. Copy adapts to the record's depth:
 * an established profile leads with the archetype, a thin one with "building a
 * provable record" — so even a 1-call user has something worth posting.
 */
export function openIdentityShare(wallet: string, opts?: { archetypeLabel?: string | null; established?: boolean }) {
  const w = wallet.toLowerCase();
  const shareUrl = `${SHARE_BASE}/${w}`;
  const text = opts?.established
    ? `my trading identity${opts.archetypeLabel ? ` — ${opts.archetypeLabel.toLowerCase()}` : ""}. every call graded from public price, not self-reported.`
    : "building a provable trading record on Nexus — every call graded from public price, not self-reported.";
  window.open(
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`,
    "_blank",
    "noopener,noreferrer",
  );
}
