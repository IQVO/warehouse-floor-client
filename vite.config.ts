import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { precacheManifest } from "./build/precacheManifest.ts";

// warehouse-floor-client: a scan-first PWA. It talks ONLY to Kong at the
// page's own origin (`/api/<context>/...`). There is no BFF, no per-service
// URL and no runtime config file: a relative path is the whole contract.
//
// In dev, Vite plays the part of the edge: /api is proxied to FLOOR_API_TARGET.
// Default is Kong's host port in the kind cluster (http://localhost:8000; the
// web gateway on :80 serves HTML only and has no /api route). Point it at the
// bundled stub (`make stub-api`, http://localhost:8787) to work with no cluster.
const apiTarget = process.env.FLOOR_API_TARGET ?? "http://localhost:8000";

// A plain object, not a ({ command }) => ({...}) callback: vitest.config.ts
// does mergeConfig(viteConfig, ...) and Vite refuses to merge a function.
export default defineConfig({
  base: "/",
  plugins: [react(), precacheManifest()],
  resolve: {
    // @warehouse/ui-kit is a `file:` sibling with its own node_modules/react;
    // without dedupe the bundle (and vitest) would carry two Reacts.
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    target: "esnext",
  },
});
