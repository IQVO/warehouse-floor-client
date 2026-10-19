import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Plugin } from "vite";

/**
 * Stamps the app-shell file list into dist/sw.js after the bundle (and
 * public/) has been written.
 *
 * public/sw.js is a hand-written service worker (no Workbox, no
 * vite-plugin-pwa -- see README) that declares `const PRECACHE = [];` and a
 * `CACHE_VERSION`. Vite content-hashes asset names, so the list can only be
 * known after the build; this plugin is the one place that bridges the two.
 *
 * Only the app shell is listed: index.html, the manifest, icons and the
 * hashed /assets/* bundle. Never an /api/ path.
 */
export function precacheManifest(): Plugin {
  let outDir = "dist";
  return {
    name: "floor-precache-manifest",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const root = outDir;
      const files = walk(root)
        .map((f) => "/" + relative(root, f).split(sep).join("/"))
        .filter((f) => f !== "/sw.js" && !f.startsWith("/api/"))
        .sort();
      const shell = ["/", ...files];
      const hash = createHash("sha256");
      for (const f of files) hash.update(f).update(readFileSync(join(root, f)));
      const version = hash.digest("hex").slice(0, 12);
      const swPath = join(root, "sw.js");
      const src = readFileSync(swPath, "utf8");
      if (!src.includes("__PRECACHE__") || !src.includes("__CACHE_VERSION__")) {
        throw new Error("public/sw.js is missing its __PRECACHE__/__CACHE_VERSION__ placeholders");
      }
      writeFileSync(
        swPath,
        src.replace("__PRECACHE__", JSON.stringify(shell)).replace("__CACHE_VERSION__", version),
      );
    },
  };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
