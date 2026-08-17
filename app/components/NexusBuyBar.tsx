// ── NexusBuyBar — the slim $NEXUS action row ─────────────────────────────────
// Replaces the bulky 4-stat NexusMarket card at the bottom of the Lab/Feed once
// the live price moved up into the top ticker. Keeps only the actionable bits:
// the GeckoTerminal link-back (their request) + the BUY $NEXUS CTA. One thin row,
// not a card — congruent with the ticker instead of duplicating it.
import { BuyNexusButton } from "@/components/BuyNexusButton";
import { C, MONO } from "@/config/theme";

const NEXUS_TOKEN = "0x3D958634ab725B627919EF8F2Ed59227309fDba3";
const GT_PAGE = `https://www.geckoterminal.com/base/tokens/${NEXUS_TOKEN}`;

export function NexusBuyBar() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontFamily: MONO }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: "0.14em" }}>$NEXUS</span>
      <a
        href={GT_PAGE}
        target="_blank"
        rel="noopener noreferrer"
        title="View $NEXUS on GeckoTerminal"
        style={{ fontSize: 9, color: C.info, textDecoration: "none", letterSpacing: "0.06em", border: `1px solid ${C.border}`, borderRadius: 3, padding: "4px 8px" }}
      >
        GeckoTerminal ↗
      </a>
      <div style={{ marginLeft: "auto" }}>
        <BuyNexusButton size="sm" />
      </div>
    </div>
  );
}

export default NexusBuyBar;
