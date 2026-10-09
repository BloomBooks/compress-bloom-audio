import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFfmpeg, runFfmpeg } from "./ffmpeg";
import { encodeOpus } from "./opus";
import { readOggOpusInfo } from "./oggOpus";
import { parseFfmpegInfo, probeAudio } from "./probe";

// The copy packages/app/scripts/ensure-opusenc.mjs fetches (the dev server fetches it too).
const opusenc =
  process.env.COMPRESS_BLOOM_AUDIO_OPUSENC ??
  path.resolve(__dirname, "../../app/.cache/opus-tools-0.2-opus-1.3-win64/opusenc.exe");
const ffmpeg = await findFfmpeg();
const ready = !!ffmpeg && fs.existsSync(opusenc);

/** 16-bit stereo PCM: a different tone in each channel. */
function wav(seconds: number): Buffer {
  const rate = 44100;
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    data.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 220 * t)), i * 4);
    data.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 330 * t)), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let dir = "";
let mp3 = "";

describe.skipIf(!ready)("encodeOpus", () => {
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opus-"));
    await fsp.writeFile(path.join(dir, "in.wav"), wav(6.5));
    mp3 = path.join(dir, "in.mp3");
    const enc = ["-y", "-hide_banner", "-nostdin", "-i", path.join(dir, "in.wav")];
    await runFfmpeg(ffmpeg!, [...enc, "-c:a", "libmp3lame", "-b:a", "128k", mp3]);
  });
  afterAll(() => fsp.rm(dir, { recursive: true, force: true }));

  it("writes Ogg Opus under the .mp3 name, mono at speech bitrates", async () => {
    const out = path.join(dir, "speech.mp3");
    const fractions: number[] = [];
    const bytes = await encodeOpus(opusenc, mp3, out, 24, { onProgress: (f) => fractions.push(f) });
    expect(bytes).toBe(fs.statSync(out).size);
    expect(fs.readFileSync(out).toString("latin1", 0, 4)).toBe("OggS");
    expect(fractions.at(-1)).toBe(1);

    const info = await readOggOpusInfo(out);
    expect(info).toMatchObject({ codec: "opus", channels: 1, sampleRate: 48000 });
    expect(Math.abs(info!.durationSec - 6.5)).toBeLessThan(0.05);
    expect(info!.kbps).toBeGreaterThan(12);
    expect(info!.kbps).toBeLessThan(36);
    // probeAudio reads it the same way, and Bloom's ffmpeg (which can read Ogg, though
    // not decode Opus) agrees on the duration.
    expect(await probeAudio(ffmpeg!, out)).toEqual(info);
    const theirs = parseFfmpegInfo((await runFfmpeg(ffmpeg!, ["-hide_banner", "-i", out])).stderr);
    expect(theirs?.codec).toBe("opus");
    expect(Math.abs(theirs!.durationSec - info!.durationSec)).toBeLessThan(0.02);
  });

  it("keeps stereo at higher bitrates", async () => {
    const out = path.join(dir, "high.mp3");
    await encodeOpus(opusenc, mp3, out, 48);
    expect((await readOggOpusInfo(out))?.channels).toBe(2);
  });

  it("leaves no file behind when stopped", async () => {
    const out = path.join(dir, "stopped.mp3");
    const ac = new AbortController();
    ac.abort();
    expect(await encodeOpus(opusenc, mp3, out, 24, { signal: ac.signal })).toBeNull();
    expect(fs.existsSync(out)).toBe(false);
  });

  it("isn't fooled by an mp3", async () => {
    expect(await readOggOpusInfo(mp3)).toBeNull();
    expect((await probeAudio(ffmpeg!, mp3))?.codec).toBe("mp3");
  });
});
