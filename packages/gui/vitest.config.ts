/// <reference types="vite-plus/test" />
import { defineConfig } from "vite-plus";

// The GUI's vitest unit tests live beside the code they cover, under `src/`. `tests/`
// is a different thing entirely — a Playwright e2e spec, run by playwright.config.ts
// against an already-running dev server on 5190 — and vitest must keep out of it.
//
// Under the old toolchain (vite-plus 0.1.24) that spec was never discovered; vitest
// 4.1.10 widened discovery, picked up tests/app.spec.ts, and failed the whole suite with
// "Playwright Test did not expect test() to be called here" — Playwright's `test()`
// blowing up because it was imported by a vitest worker rather than a Playwright run.
export default defineConfig({
  test: {
    exclude: ["tests/**", "**/node_modules/**", "**/dist/**"],
  },
});
