/// <reference types="vite-plus/test" />
import { defineConfig } from "vite-plus";
import dts from "vite-plugin-dts";
import { builtinModules } from "node:module";

export default defineConfig({
  plugins: [
    // Declarations build from tsconfig.build.json (tests excluded there); the main
    // tsconfig.json INCLUDES tests so the pre-commit staged type-check sees them
    // inside a project with node globals.
    dts({ tsconfigPath: "./tsconfig.build.json" }) as any,
  ],
  build: {
    lib: {
      entry: "src/index.ts",
      name: "CompressBloomAudio",
      formats: ["es", "cjs"],
      fileName: (format) => `index.${format === "es" ? "mjs" : "cjs"}`,
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    },
    sourcemap: true,
    minify: false,
  },
  test: {
    globals: true,
    environment: "node",
  },
});
