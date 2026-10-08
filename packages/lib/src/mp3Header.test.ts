import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFfmpeg, runFfmpeg } from "./ffmpeg";
import { parseFfmpegInfo } from "./probe";
import { readMp3Info } from "./mp3Header";

/** 16-bit mono PCM: two tones, so the encoder has something to spend bits on. */
function wav(seconds: number): Buffer {
  const rate = 44100;
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v =
      0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 1870 * t * (1 + t));
    data.writeInt16LE(Math.round(v * 32000), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const ffmpeg = await findFfmpeg();
let dir = "";

// Each the way something we meet encodes: Bloom's recorder, this app's output at speech
// bitrates, a variable-bitrate file, and one with no frame-count header at all.
const VARIANTS: Record<string, string[]> = {
  "constant 128 kbps stereo": ["-ac", "2", "-b:a", "128k"],
  "constant 24 kbps mono 22 kHz": ["-ac", "1", "-ar", "22050", "-b:a", "24k"],
  "variable bitrate": ["-ac", "1", "-q:a", "6"],
  "no Xing/Info header": ["-ac", "1", "-b:a", "48k", "-write_xing", "0"],
};

describe.skipIf(!ffmpeg)("readMp3Info", () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mp3header-"));
    await fs.writeFile(path.join(dir, "in.wav"), wav(4.3));
  });
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  for (const [name, args] of Object.entries(VARIANTS)) {
    it(`agrees with ffmpeg: ${name}`, async () => {
      const out = path.join(dir, `${name.replace(/\W+/g, "-")}.mp3`);
      const enc = ["-y", "-hide_banner", "-nostdin", "-i", path.join(dir, "in.wav")];
      await runFfmpeg(ffmpeg!, [...enc, "-c:a", "libmp3lame", ...args, out]);
      const theirs = parseFfmpegInfo(
        (await runFfmpeg(ffmpeg!, ["-hide_banner", "-i", out])).stderr,
      );
      const ours = await readMp3Info(out);
      expect(ours).not.toBeNull();
      expect(theirs).not.toBeNull();
      expect(ours!.kbps).toBe(theirs!.kbps);
      expect(ours!.channels).toBe(theirs!.channels);
      expect(ours!.sampleRate).toBe(theirs!.sampleRate);
      expect(Math.abs(ours!.durationSec - theirs!.durationSec)).toBeLessThan(0.03);
    });
  }

  it("leaves a variable bitrate with no frame count to ffmpeg", async () => {
    const out = path.join(dir, "vbr-no-xing.mp3");
    const enc = ["-y", "-hide_banner", "-nostdin", "-i", path.join(dir, "in.wav")];
    await runFfmpeg(ffmpeg!, [...enc, "-c:a", "libmp3lame", "-q:a", "6", "-write_xing", "0", out]);
    expect(await readMp3Info(out)).toBeNull();
  });

  it("gives up on a file that isn't an mp3", async () => {
    const f = path.join(dir, "not.mp3");
    await fs.writeFile(f, wav(0.2));
    expect(await readMp3Info(f)).toBeNull();
  });
});
