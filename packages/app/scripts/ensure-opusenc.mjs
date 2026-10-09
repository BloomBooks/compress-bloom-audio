/*
 * Make sure opusenc.exe, which encodes Opus, is in packages/app/.cache, and print its path.
 *
 * Bloom's ffmpeg has no Opus encoder, so the app ships Xiph's opusenc beside its node.exe
 * (build-installer.mjs copies it into the installer), and the dev server points the engine
 * at this copy (packages/gui/vite.config.ts). The download is Xiph's official Windows
 * build, pinned by its SHA-256: a different file is refused rather than shipped.
 *
 * Windows only. Prints nothing and exits 0 elsewhere, and the app then offers no Opus.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "opus-tools-0.2-opus-1.3-win64";
const URL = `https://archive.mozilla.org/pub/opus/win64/${NAME}.zip`;
const SHA256 = "a892bd29358e142fa756da6bfcaea2faadc0f82ee1947d9eb2cecd208f1b873f";
export const OPUS_TOOLS_DIR = path.join(APP_DIR, ".cache", NAME);
const OPUSENC = path.join(OPUS_TOOLS_DIR, "opusenc.exe");

export async function ensureOpusenc() {
  if (process.platform !== "win32") return null;
  if (fs.existsSync(OPUSENC)) return OPUSENC;
  console.error(`Fetching ${NAME} (opusenc, about 1.5 MB) from ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`downloading ${URL} failed: HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(zip).digest("hex");
  if (got !== SHA256) throw new Error(`${URL} has SHA-256 ${got}, expected ${SHA256}`);
  const zipPath = `${OPUS_TOOLS_DIR}.zip`;
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, zip);
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${OPUS_TOOLS_DIR}' -Force`,
    ],
    { stdio: "inherit" },
  );
  fs.rmSync(zipPath, { force: true });
  if (r.status !== 0 || !fs.existsSync(OPUSENC)) throw new Error(`couldn't unpack ${zipPath}`);
  return OPUSENC;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureOpusenc().then(
    (p) => p && console.log(p),
    (e) => {
      console.error(String(e.message ?? e));
      process.exit(1);
    },
  );
}
