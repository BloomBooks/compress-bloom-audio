import type { ConfigEnv, UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
// From apiDevPlugin, not apiPlugin: this import is bundled into the config, so it must not
// reach @compress-bloom-audio/lib as a value — that would resolve the lib to its built dist,
// and a stale dist would stop the dev server from starting. See that file's header.
import { compressApiPlugin } from "./server/apiDevPlugin";

// The backend API + live SSE are served by Vite itself via compressApiPlugin (no Express,
// no separate server).
//
// Dev (`vp dev`, http://localhost:5190): @compress-bloom-audio/lib resolves to its
// TypeScript SOURCE instead of the built dist, and the API plugin loads its request handler
// through Vite's SSR graph, so editing packages/lib is live in the running server. Only the
// server imports the lib (the React client talks to it over /api), so aliasing to source
// can't pull Node-only code into the browser bundle. Gated to `serve`: the production build
// keeps importing the built dist.
const libSource = fileURLToPath(new URL("../lib/src/index.ts", import.meta.url));

/**
 * Annotated and declared separately rather than written inline in `defineConfig(...)`.
 * Inline, TypeScript infers this whole object and then structurally compares it against
 * `ViteUserConfigFnObject`, and gives up with `TS2321: Excessive stack depth comparing
 * types` — which fails `vp check` and so the pre-commit hook. Naming the return type gives
 * the comparison a fixed target, and `...react()` keeps the plugin array assignable to
 * `PluginOption[]`.
 */
function guiConfig({ command }: ConfigEnv): UserConfig {
  const dev = command === "serve";
  return {
    plugins: [...react(), compressApiPlugin()],
    resolve: dev ? { alias: { "@compress-bloom-audio/lib": libSource } } : {},
    // The aliased path is outside node_modules, so Vite's SSR pipeline transforms the
    // lib (rather than externalizing it) — which is what lets its edits hot-reload.
    ssr: { noExternal: dev ? ["@compress-bloom-audio/lib"] : [] },
    server: {
      // The e2e tests run their own server on another port (playwright.config.ts).
      port: Number(process.env.COMPRESS_BLOOM_AUDIO_DEV_PORT) || 5190,
      // Fail rather than fall forward to the next free port: 5191 is the desktop app's
      // BACKEND_PORT (packages/app/neutralino.config.json), and `pnpm dev` starts this dev
      // server alongside the app. Stealing 5191 leaves the app's sidecar unable to bind.
      strictPort: true,
      open: !process.env.COMPRESS_BLOOM_AUDIO_DEV_PORT,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: true,
    },
  };
}

/* Exported directly rather than wrapped in `defineConfig`: that helper is identity at
   runtime, and passing anything to it re-triggers the TS2321 deep comparison the
   annotation above avoids. */
export default guiConfig;
