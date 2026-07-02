// Seed a HOUSE paper agent — a forward-test instrument for the CONFLUENCE flagship.
// CONFLUENCE fires LIVE right now (the brain computes OI-divergence from 5-min
// snapshots), so this builds a real forward-tested paper record starting today —
// independent of the BACKTEST OI history maturing (~mid-July). By the time the
// backtest can validate CONFLUENCE, we'll ALSO have ~2 weeks of forward paper record
// to corroborate it. See docs/confluence-validation-plan.md.
//
// PAPER mode = simulated, no funds, no real orders, no trading key. All it needs is
// a wallet signature to prove ownership. Use a FRESH throwaway house wallet.
//
// Run:  PRIVATE_KEY=0xabc... node tools/seed-paper-agent.mjs
//       (optional) MODE=CONFLUENCE|FUNDING_ONLY  API=https://og.nexustradinglabs.com
import { privateKeyToAccount } from "viem/accounts";

const API = process.env.API || "https://og.nexustradinglabs.com";
const pk = process.env.PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("Set PRIVATE_KEY=0x<64 hex> (a FRESH throwaway house wallet — PAPER needs no funds).");
  process.exit(1);
}

// The forward-test config: the flagship CONFLUENCE signal on the majors, with the
// breakeven risk-free stop. Matches the grid we'll backtest-validate in mid-July.
const CONFIG = {
  signalMode: process.env.MODE || "CONFLUENCE",
  symbols: ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC"],
  fundingThreshold: 0.01,
  oiChangeThreshold: 0,
  leverage: 5,
  capitalPerTrade: 50,
  tpPercent: 1.5,
  slPercent: 0.75,
  breakevenTriggerPct: 1.0,
  maxHoldHours: 4,
  maxTradesPerDay: 10,
  maxDailyLossUsdc: 1000, // soft in PAPER
};

async function main() {
  const account = privateKeyToAccount(pk);
  const addr = account.address.toLowerCase();
  // Same ownership proof the web/mini flows use.
  const walletSig = await account.signMessage({ message: "nexus-trading-key-v1" });

  console.log(`Seeding PAPER agent · ${CONFIG.signalMode} · ${account.address}`);
  const res = await fetch(`${API}/agent/${addr}/bankr/activate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "PAPER", config: CONFIG, walletSig }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) {
    console.log(`✓ Live. mode=${data.mode} · watching ${CONFIG.symbols.map((s) => s.replace("PERP_", "").replace("_USDC", "")).join("/")}`);
    console.log(`  Track it:   ${API}/agent/${addr}`);
    console.log(`  Feed/paper: it will paper-fill the moment funding + OI-divergence agree (CONFLUENCE is strict — expect few, high-conviction entries).`);
  } else {
    console.error("✗ Failed:", data.hint || data.error || JSON.stringify(data));
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
