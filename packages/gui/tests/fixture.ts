/* A throwaway Bloom collection for the e2e tests: two books with real page markup and real
   128 kbps stereo mp3s (what Bloom records), synthesised here so no one's recordings are
   committed. The mp3s are encoded with the same Bloom ffmpeg the app uses. */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFfmpeg, runFfmpeg } from "../../lib/src/ffmpeg";

/** Everything the test server writes goes under here, never into the user's own files. */
export const E2E_ROOT = path.join(os.tmpdir(), "compress-bloom-audio-e2e");
export const E2E_PORT = 5199;
export const E2E_ENV = {
  COMPRESS_BLOOM_AUDIO_DEV_PORT: String(E2E_PORT),
  COMPRESS_BLOOM_AUDIO_SETTINGS: path.join(E2E_ROOT, "settings.json"),
  COMPRESS_BLOOM_AUDIO_BACKUPS: path.join(E2E_ROOT, "backups"),
  COMPRESS_BLOOM_AUDIO_TEST_READ_DELAY_MS: "800",
};

export interface FixtureBook {
  folder: string;
  title: string;
  /** Audio file name → the label the app should give it. */
  clips: Record<string, string>;
}

/** 16-bit stereo PCM: a few drifting tones, amplitude-modulated so it isn't trivially compressible. */
function wav(seconds: number, seed: number): Buffer {
  const rate = 44100;
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * (2 + seed) * t);
    const v =
      env *
      (0.4 * Math.sin(2 * Math.PI * (180 + 40 * seed) * t) +
        0.25 * Math.sin(2 * Math.PI * (530 + 13 * seed) * t + Math.sin(7 * t)) +
        0.1 * Math.sin(2 * Math.PI * 2100 * t));
    const s = Math.max(-1, Math.min(1, v)) * 32000;
    data.writeInt16LE(s, i * 4);
    data.writeInt16LE(s * 0.9, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(2, 22); // channels
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function page(attrs: string, inner: string) {
  return `<div class="bloom-page ${attrs.includes("data-page-number") ? "numberedPage" : ""}" ${attrs}>${inner}</div>`;
}

const BOOKS = [
  {
    title: "The Moon and the Cap",
    pages: [
      {
        attrs: 'data-xmatter-page="frontCover" data-backgroundaudio="SoundTrack0.mp3"',
        ids: ["t1"],
      },
      { attrs: 'data-page-number="1"', ids: ["a1", "a2"] },
      { attrs: 'data-page-number="2"', ids: ["a3"] },
    ],
    music: ["SoundTrack0.mp3"],
  },
  {
    title: "Counting Goats",
    pages: [{ attrs: 'data-page-number="1"', ids: ["g1", "g2"] }],
    music: [],
  },
];

/** Build a fresh collection at `<E2E_ROOT>/<name>`; returns its folder and books. */
export async function buildCollection(
  name: string,
): Promise<{ folder: string; books: FixtureBook[] }> {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error("e2e tests need Bloom's ffmpeg (install Bloom)");
  const folder = path.join(E2E_ROOT, name);
  await fs.rm(folder, { recursive: true, force: true });
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, `${name}.bloomCollection`), "<Collection/>");
  const books: FixtureBook[] = [];
  let seed = 0;
  for (const b of BOOKS) {
    const bookFolder = path.join(folder, b.title);
    await fs.mkdir(path.join(bookFolder, "audio"), { recursive: true });
    await fs.writeFile(path.join(bookFolder, "meta.json"), JSON.stringify({ title: b.title }));
    const body = b.pages
      .map((p) =>
        page(
          p.attrs,
          p.ids.map((id) => `<span id="${id}" class="audio-sentence">Text ${id}.</span>`).join(""),
        ),
      )
      .join("\n");
    await fs.writeFile(
      path.join(bookFolder, `${b.title}.htm`),
      `<html><body><div id="bloomDataDiv"></div>\n${body}\n</body></html>`,
    );
    const clips: Record<string, string> = {};
    for (const p of b.pages) {
      const pageName = p.attrs.includes("frontCover")
        ? "Front cover"
        : `Page ${/data-page-number="(\d+)"/.exec(p.attrs)![1]}`;
      p.ids.forEach((id, i) => (clips[`${id}.mp3`] = `${pageName} · clip ${i + 1}`));
    }
    for (const m of b.music) clips[m] = "Front cover · background music";
    for (const file of Object.keys(clips)) {
      const w = path.join(E2E_ROOT, `tmp-${seed}.wav`);
      await fs.writeFile(w, wav(clips[file].includes("music") ? 8 : 3 + (seed % 3), seed++));
      const r = await runFfmpeg(ffmpeg, [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        w,
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "128k",
        path.join(bookFolder, "audio", file),
      ]);
      await fs.rm(w, { force: true });
      if (r.code !== 0) throw new Error(`fixture encode failed: ${r.stderr.slice(-300)}`);
    }
    books.push({ folder: bookFolder, title: b.title, clips });
  }
  return { folder, books };
}

export async function hashes(book: FixtureBook): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of Object.keys(book.clips)) {
    out[f] = createHash("sha256")
      .update(await fs.readFile(path.join(book.folder, "audio", f)))
      .digest("hex");
  }
  return out;
}

export async function sizes(book: FixtureBook): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const f of Object.keys(book.clips))
    out[f] = (await fs.stat(path.join(book.folder, "audio", f))).size;
  return out;
}

/** Start each test with no remembered settings and no kept originals. */
export async function resetServerFiles() {
  await fs.rm(E2E_ENV.COMPRESS_BLOOM_AUDIO_BACKUPS, { recursive: true, force: true });
  await fs.rm(E2E_ENV.COMPRESS_BLOOM_AUDIO_SETTINGS, { force: true });
}
