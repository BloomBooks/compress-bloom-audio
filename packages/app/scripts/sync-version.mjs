/*
 * Sync the desktop app version into neutralino.config.json from package.json.
 *
 * package.json is the single source of truth for the version (see RELEASING.md).
 * Neutralino, however, reads its own `version` field from neutralino.config.json
 * and exposes it to the webview as the NL_APPVERSION global — which boot.js uses to
 * render the version in the window title / splash and the updater uses to decide
 * whether a newer release exists. This keeps the two in lockstep.
 *
 * Idempotent: only rewrites the config when the version actually differs. Run before
 * `neu run` (dev) and before `neu build` (installer) — wired into both.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");
const PKG = path.join(APP_DIR, "package.json");
const CONFIG = path.join(APP_DIR, "neutralino.config.json");

const version = JSON.parse(fs.readFileSync(PKG, "utf-8")).version;
const config = JSON.parse(fs.readFileSync(CONFIG, "utf-8"));

if (config.version === version) {
  process.stdout.write(`neutralino.config.json version already ${version}\n`);
} else {
  const old = config.version;
  config.version = version;
  // Preserve 2-space formatting + trailing newline (matches the rest of the repo).
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n");
  process.stdout.write(`neutralino.config.json version ${old} -> ${version}\n`);
}
