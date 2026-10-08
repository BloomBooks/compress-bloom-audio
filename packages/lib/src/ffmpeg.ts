/* Finding and running ffmpeg.

   We do not ship ffmpeg. Every machine that has Bloom books to compress has Bloom, and
   Bloom ships an ffmpeg.exe beside Bloom.exe. Bloom 6.x's build is stripped down, but it
   keeps exactly what this app needs: the mp3 decoder and demuxer, the wav demuxer, the
   libmp3lame encoder and the mp3 muxer. It has no ffprobe, which is why probe.ts reads
   `ffmpeg -i` output instead. */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Bloom's per-user install folders, most-used channel first. Each install keeps its
 *  files in `current\` (Velopack, Bloom 6.1+) or `app-<version>\` (Squirrel, older). */
const BLOOM_CHANNELS = [
  "Bloom",
  "BloomBeta",
  "BloomAlpha",
  "BloomReleaseInternal",
  "BloomBetaInternal",
];

function bloomInstallCandidates(): string[] {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const out: string[] = [];
  const channels = [...BLOOM_CHANNELS];
  // Then any other Bloom* channel folder (BloomFAL, BloomEMDC, …).
  try {
    for (const d of fs.readdirSync(local)) {
      if (/^Bloom/i.test(d) && !channels.includes(d)) channels.push(d);
    }
  } catch {
    /* no LOCALAPPDATA listing */
  }
  for (const ch of channels) {
    const root = path.join(local, ch);
    out.push(path.join(root, "current", "ffmpeg.exe"));
    try {
      const apps = fs
        .readdirSync(root)
        .filter((d) => /^app-\d/.test(d))
        .sort()
        .reverse();
      for (const a of apps) out.push(path.join(root, a, "ffmpeg.exe"));
    } catch {
      /* channel folder missing */
    }
  }
  // Machine-wide installs.
  for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (pf) out.push(path.join(pf, "SIL", "Bloom", "ffmpeg.exe"));
  }
  return out;
}

/**
 * Locate an ffmpeg to use: the COMPRESS_BLOOM_AUDIO_FFMPEG env var, else the ffmpeg.exe
 * of an installed Bloom, else `ffmpeg` on PATH (for macOS/Linux dev). Returns null when
 * none exists, so the UI can say "install Bloom" rather than fail mid-compression.
 */
export async function findFfmpeg(): Promise<string | null> {
  const fromEnv = process.env.COMPRESS_BLOOM_AUDIO_FFMPEG;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (process.platform === "win32") {
    for (const c of bloomInstallCandidates()) if (fs.existsSync(c)) return c;
  }
  const onPath = await runFfmpeg("ffmpeg", ["-hide_banner", "-version"]).catch(() => null);
  return onPath && onPath.code === 0 ? "ffmpeg" : null;
}

export interface FfmpegResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run ffmpeg to completion. `onStdout` sees each chunk (used for `-progress pipe:1`).
 *  Aborting `signal` kills the process; the promise then resolves with code null. */
export function runFfmpeg(
  ffmpeg: string,
  args: string[],
  opts: { signal?: AbortSignal; onStdout?: (chunk: string) => void } = {},
): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      opts.onStdout?.(d);
    });
    child.stderr.on("data", (d: string) => {
      stderr = (stderr + d).slice(-20000);
    });
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: opts.signal?.aborted ? null : code, stdout, stderr });
    });
  });
}
