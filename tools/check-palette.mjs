#!/usr/bin/env node
// ── Palette drift guard ───────────────────────────────────────────────────────
// The Lab/Feed/Intel accumulated ~100 distinct hexes because every surface typed
// its own colours ("#ff4c6a" instead of the canonical "#f7525f"). Cleaning that up
// once doesn't stop it recurring — this does.
//
// It scans app/ for hex literals and fails on any colour that is NOT:
//   1. derived from app/config/theme.ts (the allowlist is PARSED from the tokens,
//      never re-typed here — otherwise the guard itself would drift), or
//   2. in APPROVED_EXTRAS below (documented, deliberate exceptions), or
//   3. already recorded in tools/palette-baseline.json.
//
// The baseline is a RATCHET: existing legacy colours are grandfathered so the check
// is green today, but any NEW off-palette hex fails. Shrink the baseline over time;
// never grow it without a reason.
//
//   node tools/check-palette.mjs                  # check (exit 1 on new drift)
//   node tools/check-palette.mjs --update-baseline # accept current state
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIR = join(ROOT, "app");
const THEME = join(ROOT, "app/config/theme.ts");
const BASELINE = join(ROOT, "tools/palette-baseline.json");

// Deliberate exceptions — each one needs a reason.
const APPROVED_EXTRAS = {
  "#6cb6ff": "teaching/discussion accent — Coachmark + Telegram ONLY, never data or labels",
  "#ffffff": "pure white — occasional hard contrast",
  "#000000": "pure black",
  "#0a0a0f": "PWA manifest background",
};

const hexes = (s) => (s.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase());

// Allowlist is PARSED from the tokens so it can never disagree with them.
function allowedFromTheme() {
  const src = readFileSync(THEME, "utf8");
  return new Set(hexes(src));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== "node_modules") walk(p, out); }
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

const allowed = allowedFromTheme();
for (const h of Object.keys(APPROVED_EXTRAS)) allowed.add(h);

let baseline = {};
try { baseline = JSON.parse(readFileSync(BASELINE, "utf8")); } catch { /* first run */ }

const found = new Map(); // hex -> [{file,line}]
for (const file of walk(SCAN_DIR)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    for (const h of hexes(line)) {
      if (allowed.has(h)) continue;
      if (!found.has(h)) found.set(h, []);
      found.get(h).push(`${rel}:${i + 1}`);
    }
  });
}

if (process.argv.includes("--update-baseline")) {
  const next = {};
  for (const [h, sites] of [...found].sort()) next[h] = sites.length;
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
  console.log(`baseline updated: ${Object.keys(next).length} legacy colours, ${[...found.values()].flat().length} usages`);
  process.exit(0);
}

// Fail on colours absent from the baseline, or whose usage COUNT grew.
const newHexes = [], grown = [];
for (const [h, sites] of found) {
  if (!(h in baseline)) newHexes.push([h, sites]);
  else if (sites.length > baseline[h]) grown.push([h, sites.length, baseline[h]]);
}

if (!newHexes.length && !grown.length) {
  const legacy = Object.keys(baseline).length;
  console.log(`✓ no new palette drift (${legacy} legacy colours still baselined — shrink me)`);
  process.exit(0);
}

console.error("✗ palette drift detected\n");
for (const [h, sites] of newHexes) {
  console.error(`  NEW off-palette colour ${h}`);
  for (const s of sites.slice(0, 5)) console.error(`      ${s}`);
  if (sites.length > 5) console.error(`      … +${sites.length - 5} more`);
}
for (const [h, now, was] of grown) console.error(`  ${h} usage grew ${was} -> ${now}`);
console.error(`\nUse a token from app/config/theme.ts (C.pos / C.neg / C.warn / C.accent / C.text.*).`);
console.error(`If the colour is genuinely new and intentional, add it to APPROVED_EXTRAS with a reason,`);
console.error(`or run: node tools/check-palette.mjs --update-baseline`);
process.exit(1);
