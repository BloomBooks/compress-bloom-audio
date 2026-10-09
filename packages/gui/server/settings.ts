/* The user's remembered choices: last collection and quality.
   Stored in ~/.compress-bloom-audio/settings.json. Server-side only. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface Settings {
  collection: string;
  preset: "speech" | "balanced" | "high" | "custom";
  /** Compress to Opus (in files still named .mp3) rather than mp3. */
  opus: boolean;
  /** The bitrate for the chosen codec. */
  kbps: number;
}

const DEFAULTS: Settings = {
  collection: "",
  preset: "balanced",
  opus: false,
  kbps: 48,
};

const FILE =
  process.env.COMPRESS_BLOOM_AUDIO_SETTINGS ||
  path.join(os.homedir(), ".compress-bloom-audio", "settings.json");

export async function getSettings(): Promise<Settings> {
  try {
    return { ...DEFAULTS, ...JSON.parse(await fs.readFile(FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Saves run one at a time, in the order they arrive. Each reads the file, merges its
 *  patch and writes it back, so two overlapping saves would otherwise both read the old
 *  file, and the slower one would put back a choice the user had already changed. */
let queue: Promise<unknown> = Promise.resolve();
let writes = 0;

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = async () => {
    const next = { ...(await getSettings()), ...patch };
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    const temp = `${FILE}.${process.pid}.${++writes}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2));
    await fs.rename(temp, FILE);
    return next;
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}
