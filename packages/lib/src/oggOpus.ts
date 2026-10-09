/* Reading an Ogg Opus file's duration, bitrate and channels from its own pages. These are
   the clips this app has compressed to Opus; Bloom's ffmpeg can't decode Opus, so it can't
   tell us their duration.

   The first page holds the "OpusHead" packet (channel count, and the pre-skip: samples at
   the start that a player drops). The last page's granule position is the number of 48 kHz
   samples up to the end of the stream. */
import * as fs from "node:fs/promises";
import type { AudioInfo } from "./probe";

async function readAt(fh: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const b = Buffer.alloc(length);
  const { bytesRead } = await fh.read(b, 0, length, position);
  return b.subarray(0, bytesRead);
}

const isPage = (b: Buffer, at: number) =>
  at + 27 <= b.length && b.toString("latin1", at, at + 4) === "OggS" && b[at + 4] === 0;

export async function readOggOpusInfo(file: string): Promise<AudioInfo | null> {
  const fh = await fs.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const head = await readAt(fh, 0, 4096);
    if (!isPage(head, 0)) return null;
    const body = 27 + head[26];
    if (head.toString("latin1", body, body + 8) !== "OpusHead") return null;
    const channels = head[body + 9];
    const preSkip = head.readUInt16LE(body + 10);

    const tailStart = Math.max(0, size - 65536);
    const tail = await readAt(fh, tailStart, size - tailStart);
    let last = tail.lastIndexOf("OggS");
    while (last >= 0 && !isPage(tail, last)) last = tail.lastIndexOf("OggS", last - 1);
    if (last < 0) return null;
    const granule = Number(tail.readBigInt64LE(last + 6));
    const durationSec = (granule - preSkip) / 48000;
    if (!(durationSec > 0)) return null;
    return {
      codec: "opus",
      durationSec,
      kbps: Math.round((size * 8) / durationSec / 1000),
      channels,
      sampleRate: 48000,
    };
  } finally {
    await fh.close();
  }
}
