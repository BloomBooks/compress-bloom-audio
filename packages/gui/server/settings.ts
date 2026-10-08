/* The user's remembered choices: last collection and quality.
   Stored in ~/.compress-bloom-audio/settings.json. Server-side only. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface Settings {
  collection: string;
  preset: "speech" | "balanced" | "high" | "custom";
  kbps: number;
}

const DEFAULTS: Settings = {
  collection: "",
  preset: "balanced",
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

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const temp = FILE + ".tmp";
  await fs.writeFile(temp, JSON.stringify(next, null, 2));
  await fs.rename(temp, FILE);
  return next;
}
