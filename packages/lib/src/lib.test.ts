import { describe, it, expect } from "vite-plus/test";
import { parseFfmpegInfo } from "./probe";
import { labelClips } from "./bookAudio";
import { estimateBytes, ffmpegArgs, isAlreadyCompressed } from "./compress";

describe("parseFfmpegInfo", () => {
  it("reads duration, bitrate and channels from Bloom's ffmpeg -i output", () => {
    // Verbatim from Bloom 6.4's ffmpeg on Cakchiquel Books/139 Jesus’ Triumphant Entry.
    const stderr = `[mp3 @ 00000262f9c6de80] Estimating duration from bitrate, this may be inaccurate
Input #0, mp3, from 'SoundTrack0.mp3':
  Metadata:
    genre           : Other
  Duration: 00:03:24.79, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 48000 Hz, stereo, fltp, 128 kb/s
At least one output file must be specified`;
    expect(parseFfmpegInfo(stderr)).toEqual({
      codec: "mp3",
      durationSec: 204.79,
      kbps: 128,
      channels: 2,
      sampleRate: 48000,
    });
  });

  it("returns null when there is no audio stream", () => {
    expect(parseFfmpegInfo("whatever.mp3: Invalid data found when processing input")).toBeNull();
  });
});

describe("labelClips", () => {
  const html = `
    <div id="bloomDataDiv"><div data-book="coverImage">x</div><span id="a1">copy</span></div>
    <div class="bloom-page cover" data-xmatter-page="frontCover" data-backgroundaudio="SoundTrack0.mp3"><span id="t1" class="audio-sentence">Title</span></div>
    <div class="bloom-page numberedPage" data-page-number="1">
      <span id="a1" class="audio-sentence">One.</span><span id="a2" class="audio-sentence">Two.</span>
    </div>
    <div class="bloom-page numberedPage" data-page-number="2"><div id="a3" class="audio-sentence">Three.</div></div>`;

  it("numbers clips per page in reading order, skipping the data-div copy", () => {
    const l = labelClips(html, ["a2.mp3", "a1.mp3", "a3.mp3", "t1.mp3"]);
    expect(l.get("a1.mp3")?.label).toBe("Page 1 · clip 1");
    expect(l.get("a2.mp3")?.label).toBe("Page 1 · clip 2");
    expect(l.get("a3.mp3")?.label).toBe("Page 2 · clip 1");
    expect(l.get("t1.mp3")?.label).toBe("Front cover · clip 1");
  });

  it("tells background music and leftover files apart from narration", () => {
    const l = labelClips(html, ["SoundTrack0.mp3", "old-take.mp3"]);
    expect(l.get("SoundTrack0.mp3")).toMatchObject({
      kind: "music",
      label: "Front cover · background music",
    });
    expect(l.get("old-take.mp3")).toMatchObject({ kind: "unused", label: "Not used in the book" });
  });

  it("finds single-quoted ids and names with unusual characters", () => {
    const page = `<div class="bloom-page" data-page-number="4"><span id='b1'>x</span><span id="my take (2)">y</span></div>`;
    const l = labelClips(page, ["b1.mp3", "my take (2).mp3"]);
    expect(l.get("b1.mp3")?.label).toBe("Page 4 · clip 1");
    expect(l.get("my take (2).mp3")?.label).toBe("Page 4 · clip 2");
  });

  it("falls back to 'not used' for everything when there is no markup", () => {
    expect(labelClips("", ["a1.mp3"]).get("a1.mp3")?.kind).toBe("unused");
  });
});

describe("compression settings", () => {
  it("goes mono at speech bitrates and halves the sample rate at the lowest", () => {
    expect(ffmpegArgs("in.mp3", "out.mp3", 24)).toEqual(
      expect.arrayContaining(["-ac", "1", "-ar", "22050"]),
    );
    const balanced = ffmpegArgs("in.mp3", "out.mp3", 48);
    expect(balanced).toContain("-ac");
    expect(balanced).not.toContain("-ar");
    expect(ffmpegArgs("in.mp3", "out.mp3", 96)).not.toContain("-ac");
  });

  it("estimates by bitrate ratio and never grows a file", () => {
    expect(estimateBytes(128_000, 128, 48)).toBe(48_000);
    expect(estimateBytes(32_000, 32, 48)).toBe(32_000);
    expect(isAlreadyCompressed(32, 48)).toBe(true);
    expect(isAlreadyCompressed(128, 48)).toBe(false);
  });
});
