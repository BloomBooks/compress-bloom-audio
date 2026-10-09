/* Reading an mp3's bitrate, channels and duration from its own headers, without
   starting ffmpeg. Starting ffmpeg costs about 30 ms a file on Windows, which is most of
   a minute for a collection with a few thousand clips; this reads a few kilobytes.

   It handles MPEG Layer III only, which is what Bloom records and what we write. For
   anything it can't read with confidence it returns null, and the caller asks ffmpeg. */
import * as fs from "node:fs/promises";
import type { AudioInfo } from "./probe";

const KBPS_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES_MPEG1 = [44100, 48000, 32000];

interface FrameHeader {
  mpeg1: boolean;
  kbps: number;
  sampleRate: number;
  channels: number;
  samplesPerFrame: number;
  frameBytes: number;
  /** Bytes of side information between the header and a Xing/Info tag. */
  sideInfo: number;
}

function frameHeader(b: Buffer, at: number): FrameHeader | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1] >> 3) & 3; // 0 = MPEG 2.5, 2 = MPEG 2, 3 = MPEG 1
  const layer = (b[at + 1] >> 1) & 3; // 1 = Layer III
  const bitrateIndex = b[at + 2] >> 4;
  const rateIndex = (b[at + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15) return null;
  if (rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const kbps = (mpeg1 ? KBPS_MPEG1 : KBPS_MPEG2)[bitrateIndex];
  const sampleRate = RATES_MPEG1[rateIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const padding = (b[at + 2] >> 1) & 1;
  const channels = b[at + 3] >> 6 === 3 ? 1 : 2;
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  return {
    mpeg1,
    kbps,
    sampleRate,
    channels,
    samplesPerFrame,
    frameBytes: Math.floor(((samplesPerFrame / 8) * kbps * 1000) / sampleRate) + padding,
    sideInfo: mpeg1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17,
  };
}

/** The first offset before `limit` where a frame starts and another follows it, or -1. */
function firstFrame(b: Buffer, limit: number): number {
  for (let at = 0; at < limit; at++) {
    const h = frameHeader(b, at);
    if (h && frameHeader(b, at + h.frameBytes)) return at;
  }
  return -1;
}

/** Every whole frame in `b` from `at` on is at `kbps`. */
function framesMatch(b: Buffer, at: number, kbps: number): boolean {
  for (let h = frameHeader(b, at); h && at + h.frameBytes <= b.length; h = frameHeader(b, at)) {
    if (h.kbps !== kbps) return false;
    at += h.frameBytes;
  }
  return true;
}

/** Where the audio starts: after an ID3v2 tag, if the file has one. */
function id3v2Length(b: Buffer): number {
  if (b.length < 10 || b.toString("latin1", 0, 3) !== "ID3") return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size + (b[5] & 0x10 ? 10 : 0);
}

async function readAt(fh: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const b = Buffer.alloc(length);
  const { bytesRead } = await fh.read(b, 0, length, position);
  return b.subarray(0, bytesRead);
}

export async function readMp3Info(file: string): Promise<AudioInfo | null> {
  const fh = await fs.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const start = id3v2Length(await readAt(fh, 0, 10));
    const b = await readAt(fh, start, 16384);
    // The first frame must be right where the tag ends (or within a little padding), and
    // the frame after it must also look like a frame, or this isn't a file we understand.
    let at = 0;
    while (at < 2048 && !frameHeader(b, at)) at++;
    const h = frameHeader(b, at);
    if (!h) return null;
    const next = at + h.frameBytes;
    if (next + 4 <= b.length && !frameHeader(b, next)) return null;

    const tail = await readAt(fh, Math.max(0, size - 128), 128);
    const id3v1 = tail.length === 128 && tail.toString("latin1", 0, 3) === "TAG" ? 128 : 0;
    const info = {
      codec: "mp3" as const,
      kbps: h.kbps,
      channels: h.channels,
      sampleRate: h.sampleRate,
    };

    // A Xing ("Xing" for variable bitrate, "Info" for constant) or VBRI tag in the first
    // frame counts the frames, which gives the exact duration.
    const tagAt = at + 4 + h.sideInfo;
    const tag = b.toString("latin1", tagAt, tagAt + 4);
    let frames = 0;
    let streamBytes = 0;
    // Samples of silence the encoder added at the start and end, from LAME's own tag.
    let gapSamples = 0;
    if (tag === "Xing" || tag === "Info") {
      const flags = b.readUInt32BE(tagAt + 4);
      let p = tagAt + 8;
      if (flags & 1) {
        frames = b.readUInt32BE(p);
        p += 4;
      }
      if (flags & 2) {
        streamBytes = b.readUInt32BE(p);
        p += 4;
      }
      if (flags & 4) p += 100;
      if (flags & 8) p += 4;
      // LAME writes "LAME" here; ffmpeg, which wrote every file this app compressed,
      // writes the same tag with "Lavc".
      const encoder = b.toString("latin1", p, p + 4);
      if (p + 24 <= b.length && (encoder === "LAME" || encoder === "Lavc")) {
        const d = b.readUIntBE(p + 21, 3);
        gapSamples = (d >> 12) + (d & 0xfff);
      }
    } else if (b.toString("latin1", at + 36, at + 40) === "VBRI") {
      streamBytes = b.readUInt32BE(at + 36 + 10);
      frames = b.readUInt32BE(at + 36 + 14);
    }
    if (frames > 0) {
      const samples = frames * h.samplesPerFrame;
      // For a variable bitrate, ffmpeg reports the average over every frame's samples,
      // rounded down, and that is the number the rest of the app compares bitrates against.
      // For a constant one, the tag's own frame can be coded at a higher bitrate than the
      // audio (to fit the tag), so read the audio's from the frame after it.
      if (tag === "Info") info.kbps = frameHeader(b, next)?.kbps ?? h.kbps;
      else if (streamBytes)
        info.kbps = Math.floor((streamBytes * 8 * h.sampleRate) / samples / 1000);
      // A variable bitrate with no byte count: the first frame's says nothing about the rest.
      else return null;
      return { ...info, durationSec: (samples - gapSamples) / h.sampleRate };
    }
    if (tag === "Xing" || tag === "Info") return null;
    // No frame count, so the bitrate has to be constant for the first frame's to stand for
    // the file: every frame at the start, and a run in the middle, must match it.
    if (!framesMatch(b, at, h.kbps)) return null;
    const middle = await readAt(fh, Math.floor(size / 2), 16384);
    const m = firstFrame(middle, 4096);
    if (m < 0 || !framesMatch(middle, m, h.kbps)) return null;
    const audioBytes = size - start - at - id3v1;
    return { ...info, durationSec: (audioBytes * 8) / (h.kbps * 1000) };
  } finally {
    await fh.close();
  }
}
