/* Encoding a clip as Opus.

   Bloom's ffmpeg has no Opus encoder, and it can write nothing that an Opus encoder reads
   (no WAV, no raw PCM: only mp3 and a few video formats). So the mp3 is decoded here, by
   mpg123 compiled to WebAssembly, and its samples are piped as raw PCM into Xiph's
   opusenc.exe, which the app ships beside its node.exe.

   The result is an Ogg Opus file saved under the clip's own .mp3 name, because Bloom
   Player finds a clip's audio by that name. Players that tell formats apart by the bytes
   (Chromium, so Bloom and Bloom Reader, and Firefox) play it. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { MPEGDecoder } from "mpg123-decoder";

/** At or below this bitrate the output is mono, as for mp3 (see compress.ts). */
const MONO_AT_OR_BELOW_KBPS = 32;

/**
 * Locate opusenc: the COMPRESS_BLOOM_AUDIO_OPUSENC env var (the dev server sets it to the
 * copy packages/app/scripts/ensure-opusenc.mjs fetches), else the one installed beside the
 * app's node.exe. Null when there is none, and the GUI then offers no Opus.
 */
export function findOpusenc(): string | null {
  const candidates = [
    process.env.COMPRESS_BLOOM_AUDIO_OPUSENC,
    path.join(path.dirname(process.execPath), "opusenc.exe"),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

/** 16-bit little-endian PCM from the decoder's float channels: interleaved, or averaged to one. */
function pcm16(channels: Float32Array[], samples: number, mono: boolean): Buffer {
  const out = mono ? 1 : channels.length;
  const b = Buffer.alloc(samples * out * 2);
  let o = 0;
  for (let i = 0; i < samples; i++) {
    if (mono) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      b.writeInt16LE(toInt16(v / channels.length), o);
      o += 2;
    } else {
      for (const ch of channels) {
        b.writeInt16LE(toInt16(ch[i]), o);
        o += 2;
      }
    }
  }
  return b;
}

const toInt16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));

/**
 * Encode the mp3 `src` as Opus at `kbps`, written to `dest`. `onProgress` gets 0..1, the
 * share of the source read so far. Resolves to the size of the new file, or null when
 * aborted.
 */
export async function encodeOpus(
  opusenc: string,
  src: string,
  dest: string,
  kbps: number,
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<number | null> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const size = (await fsp.stat(src)).size;
  const mono = kbps <= MONO_AT_OR_BELOW_KBPS;
  const decoder = new MPEGDecoder();
  await decoder.ready;
  let proc: ChildProcess | null = null;
  let exit: Promise<unknown> | null = null;
  let stderr = "";
  const kill = () => proc?.kill();
  opts.signal?.addEventListener("abort", kill);
  try {
    let read = 0;
    for await (const chunk of fs.createReadStream(src, { highWaterMark: 64 * 1024 })) {
      if (opts.signal?.aborted) break;
      read += (chunk as Buffer).length;
      const { channelData, samplesDecoded, sampleRate } = decoder.decode(chunk as Buffer);
      if (samplesDecoded) {
        // The channel count and rate are known once the first frames have decoded.
        if (!proc) {
          const p = spawn(
            opusenc,
            [
              "--quiet",
              "--raw",
              "--raw-bits",
              "16",
              "--raw-rate",
              String(sampleRate),
              "--raw-chan",
              String(mono ? 1 : channelData.length),
              "--bitrate",
              String(kbps),
              "-",
              dest,
            ],
            { windowsHide: true },
          );
          p.stderr.on("data", (d) => (stderr += d));
          p.stdin.on("error", () => {}); // opusenc gone; its exit code says why
          exit = once(p, "close");
          proc = p;
        }
        const p = proc;
        if (!p.stdin!.write(pcm16(channelData, samplesDecoded, mono))) {
          await Promise.race([once(p.stdin!, "drain"), exit]);
        }
      }
      opts.onProgress?.(read / size);
    }
    if (opts.signal?.aborted) {
      kill();
      if (exit) await exit;
      await fsp.rm(dest, { force: true });
      return null;
    }
    if (!proc) throw new Error(`couldn't decode ${path.basename(src)} as mp3`);
    const p: ChildProcess = proc;
    p.stdin!.end();
    await exit;
    if (p.exitCode !== 0) {
      await fsp.rm(dest, { force: true });
      throw new Error(`opusenc failed on ${path.basename(src)}: ${stderr.trim() || p.exitCode}`);
    }
    return (await fsp.stat(dest)).size;
  } finally {
    opts.signal?.removeEventListener("abort", kill);
    decoder.free();
  }
}
