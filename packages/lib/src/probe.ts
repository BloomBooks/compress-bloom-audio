/* Reading an audio file's duration, bitrate and channel count. An mp3's own headers
   usually give all three (mp3Header.ts). Otherwise, since Bloom's ffmpeg has no ffprobe,
   we run `ffmpeg -i <file>` with no output and read the summary it prints to stderr
   before complaining that no output file was given:

     Duration: 00:03:24.79, start: 0.000000, bitrate: 128 kb/s
     Stream #0:0: Audio: mp3 (mp3float), 48000 Hz, stereo, fltp, 128 kb/s */
import { runFfmpeg } from "./ffmpeg";
import { readMp3Info } from "./mp3Header";

export interface AudioInfo {
  durationSec: number;
  /** Total bitrate in kbps (all channels), as ffmpeg reports it. */
  kbps: number;
  channels: number;
  sampleRate: number;
}

/** Parse the stderr of `ffmpeg -i <file>`. Returns null if it names no audio stream. */
export function parseFfmpegInfo(stderr: string): AudioInfo | null {
  const audio = /Stream #\d+:\d+[^:]*: Audio: ([^\n]*)/.exec(stderr);
  if (!audio) return null;
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const streamKbps = /(\d+) kb\/s/.exec(audio[1]);
  const totalKbps = /bitrate: (\d+) kb\/s/.exec(stderr);
  const kbps = Number(streamKbps?.[1] ?? totalKbps?.[1] ?? 0);
  const rate = /(\d+) Hz/.exec(audio[1]);
  const layout = /Hz, ([^,]+)/.exec(audio[1])?.[1]?.trim() ?? "";
  const channels =
    layout === "mono"
      ? 1
      : layout === "stereo"
        ? 2
        : Number(/(\d+) channels/.exec(layout)?.[1] ?? 2);
  return { durationSec, kbps, channels, sampleRate: Number(rate?.[1] ?? 0) };
}

/** Reads an mp3's own headers when it can, and asks ffmpeg otherwise. */
export async function probeAudio(ffmpeg: string, file: string): Promise<AudioInfo | null> {
  if (file.toLowerCase().endsWith(".mp3")) {
    const info = await readMp3Info(file).catch(() => null);
    if (info) return info;
  }
  const r = await runFfmpeg(ffmpeg, ["-hide_banner", "-nostdin", "-i", file]);
  return parseFfmpegInfo(r.stderr);
}
