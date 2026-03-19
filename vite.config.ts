import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { cjsInterop } from "vite-plugin-cjs-interop";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import fs from "fs";
import path from "path";

function loadConfigTitle(): string {
  try {
    const configPath = path.join(__dirname, "public/config.js");
    if (!fs.existsSync(configPath)) {
      return "Orderly Network";
    }

    const configText = fs.readFileSync(configPath, "utf-8");
    const jsonText = configText
      .replace(/window\.__RUNTIME_CONFIG__\s*=\s*/, "")
      .replace(/;$/, "")
      .trim();

    const config = JSON.parse(jsonText);
    return config.VITE_ORDERLY_BROKER_NAME || "Orderly Network";
  } catch (error) {
    console.warn("Failed to load title from config.js:", error);
    return "Orderly Network";
  }
}

function htmlTitlePlugin(): Plugin {
  const title = loadConfigTitle();
  console.log(`Using title from config.js: ${title}`);

  return {
    name: "html-title-transform",
    transformIndexHtml(html) {
      return html
  .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
  .replace(/<\/title>/, `</title>
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="Perp DEX on Orderly + Arbitrum" />
    <meta property="og:image" content="https://nexustradinglabs.com/preview.png" />
    <meta property="og:url" content="https://nexustradinglabs.com" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="Perp DEX on Orderly + Arbitrum" />
    <meta name="twitter:image" content="https://nexustradinglabs.com/preview.png" />`);
    },
  };
}

export default defineConfig(() => {
  const basePath = process.env.PUBLIC_PATH || "/";

  return {
    server: {
      open: true,
      host: true,
    },
    base: basePath,
    plugins: [
      react(),
      tsconfigPaths(),
      htmlTitlePlugin(),
      cjsInterop({
        dependencies: ["bs58", "@coral-xyz/anchor", "lodash"],
      }),
      nodePolyfills({
        include: ["buffer", "crypto", "stream"],
      }),
    ],
    build: {
      outDir: "build/client",
    },
    optimizeDeps: {
      include: ["react", "react-dom", "react-router-dom"],
    },
  };
});
