import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function writeManifestFiles(manifest: object) {
  const publicPath = join(__dirname, "../public/manifest.json");
  writeFileSync(publicPath, JSON.stringify(manifest, null, 2));
  console.log("✓ Generated: public/manifest.json");

  const buildPath = join(__dirname, "../build/client/manifest.json");
  if (existsSync(join(__dirname, "../build/client"))) {
    writeFileSync(buildPath, JSON.stringify(manifest, null, 2));
    console.log("✓ Generated: build/client/manifest.json");
  }
}

try {
  console.log("\n🔨 Generating PWA manifest...\n");
  const manifest = {
    name: "Nexus Trading Labs",
    short_name: "Nexus",
    description: "A powerful decentralized perpetual trading platform.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0f",
    theme_color: "#38d2c7",
    orientation: "any",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ],
    categories: ["finance", "business"],
    shortcuts: [
      {
        name: "Trading",
        short_name: "Trade",
        description: "Start trading perpetuals",
        url: "/perp",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }]
      },
      {
        name: "Portfolio",
        short_name: "Portfolio",
        description: "View your portfolio",
        url: "/portfolio",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }]
      }
    ],
    screenshots: [],
    related_applications: [],
    prefer_related_applications: false
  };
  writeManifestFiles(manifest);
  console.log("\n✅ Manifest generation complete!\n");
} catch (error) {
  console.error("❌ Error generating manifest:", (error as Error).message);
}
