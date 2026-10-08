/* Compressing one clip to a working copy. Replacing the books' audio is in backups.ts. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runFfmpeg } from "./ffmpeg";

/** At or below this bitrate the output is mono: the presets for speech say so, and
 *  spending bits on a second, identical channel of one voice buys nothing. */
const MONO_AT_OR_BELOW_KBPS = 64;
/** At or below this bitrate LAME sounds better at 22.05 kHz than at 44.1/48 kHz. */
const HALF_RATE_AT_OR_BELOW_KBPS = 32;

/** True when a clip is already at or below the target, so re-encoding it can only lose quality. */
export function isAlreadyCompressed(clipKbps: number, targetKbps: number): boolean {
  return clipKbps > 0 && clipKbps <= targetKbps;
}

/** The size a clip will roughly have at `targetKbps`, for showing before compressing. */
export function estimateBytes(bytes: number, clipKbps: number, targetKbps: number): number {
  if (!clipKbps) return bytes;
  return Math.round(bytes * Math.min(1, targetKbps / clipKbps));
}

export function ffmpegArgs(src: string, dest: string, targetKbps: number): string[] {
  const args = ["-hide_banner", "-nostdin", "-y", "-i", src, "-vn", "-map_metadata", "0"];
  if (targetKbps <= MONO_AT_OR_BELOW_KBPS) args.push("-ac", "1");
  if (targetKbps <= HALF_RATE_AT_OR_BELOW_KBPS) args.push("-ar", "22050");
  args.push("-codec:a", "libmp3lame", "-b:a", `${targetKbps}k`, "-progress", "pipe:1", dest);
  return args;
}

/**
 * Encode `src` to `dest` at `targetKbps`. `onProgress` gets 0..1, computed from the
 * `out_time_us` lines of `-progress pipe:1` against the clip's known duration.
 * Resolves to the size of the new file, or null when aborted.
 */
export async function compressClip(
  ffmpeg: string,
  src: string,
  dest: string,
  targetKbps: number,
  opts: {
    durationSec?: number;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
  } = {},
): Promise<number | null> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const totalUs = (opts.durationSec ?? 0) * 1e6;
  const r = await runFfmpeg(ffmpeg, ffmpegArgs(src, dest, targetKbps), {
    signal: opts.signal,
    onStdout: (chunk) => {
      if (!totalUs || !opts.onProgress) return;
      const m = /out_time_us=(\d+)/g;
      let last: RegExpExecArray | null = null;
      for (let x = m.exec(chunk); x; x = m.exec(chunk)) last = x;
      if (last) opts.onProgress(Math.min(1, Number(last[1]) / totalUs));
    },
  });
  if (r.code === null) {
    await fs.rm(dest, { force: true });
    return null;
  }
  if (r.code !== 0) {
    await fs.rm(dest, { force: true });
    const tail = r.stderr.trim().split("\n").slice(-3).join(" ");
    throw new Error(`ffmpeg failed on ${path.basename(src)}: ${tail}`);
  }
  return (await fs.stat(dest)).size;
}
