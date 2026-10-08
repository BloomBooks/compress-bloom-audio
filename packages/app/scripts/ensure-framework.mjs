/*
 * Make sure the Neutralino framework binaries and client library are present.
 *
 * `bin/`, `resources/js/` and `extensions/` are fetched by `neu update` and are
 * gitignored (see ../.gitignore), so a fresh clone — or a new git worktree — has
 * none of them. Without `bin/neutralino-win_x64.exe`, `neu run` dies with a bare
 * "The system cannot find the path specified." and no window ever appears, which
 * reads like the app is broken rather than merely un-set-up.
 *
 * So: check, and run the setup for the developer if it's missing. Idempotent and
 * offline-safe once the binaries are there — the download only happens on the
 * first run in a given checkout.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const binaryForPlatform = {
  win32: "neutralino-win_x64.exe",
  darwin: "neutralino-mac_universal",
  linux: "neutralino-linux_x64",
}[process.platform];

const required = [
  path.join(APP_DIR, "bin", binaryForPlatform ?? "neutralino-win_x64.exe"),
  path.join(APP_DIR, "resources", "js", "neutralino.js"),
];

const missing = required.filter((p) => !fs.existsSync(p));
if (missing.length === 0) process.exit(0);

console.log(
  `Neutralino framework not found in this checkout (${missing
    .map((p) => path.relative(APP_DIR, p).replaceAll("\\", "/"))
    .join(", ")}) — downloading it now. This needs network, and happens once per checkout.`,
);

const result = spawnSync("npx", ["--yes", "@neutralinojs/neu@latest", "update"], {
  cwd: APP_DIR,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  console.error(
    "\nFailed to download the Neutralino framework. Run `pnpm run app-setup` from the repo root once you have network.",
  );
  process.exit(result.status ?? 1);
}
