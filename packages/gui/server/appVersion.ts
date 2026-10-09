/* The product version, as seen from the GUI server. The version lives in
   packages/app/package.json (the release workflow bumps it); the packaged app can't
   read that, so the installer stages a version.json that serve.ts loads into
   COMPRESS_BLOOM_AUDIO_VERSION at startup. Server-side only. */
import * as fs from "node:fs/promises";

let cached: string | null = null;

/**
 * Resolve the product version: the COMPRESS_BLOOM_AUDIO_VERSION env var (set by the
 * packaged sidecar from the installer's version.json), else packages/app/package.json
 * read relative to this source file (the dev server), else "unknown".
 */
export async function getAppVersion(): Promise<string> {
  if (cached) return cached;
  if (process.env.COMPRESS_BLOOM_AUDIO_VERSION)
    return (cached = process.env.COMPRESS_BLOOM_AUDIO_VERSION);
  try {
    // In the bundled sidecar import.meta.url is unavailable and this throws — that
    // build sets the env var above instead, so this path is dev-only by construction.
    const pkgUrl = new URL("../../app/package.json", import.meta.url);
    const pkg = JSON.parse(await fs.readFile(pkgUrl, "utf-8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version) return (cached = pkg.version);
  } catch {
    /* fall through */
  }
  return (cached = "unknown");
}
