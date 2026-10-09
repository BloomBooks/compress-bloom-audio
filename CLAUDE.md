# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

Bloom Audio Compressor shrinks the recorded audio in a Bloom collection. It lists every
book with audio, lets the user preview any clip at the chosen bitrate, then re-encodes the
chosen books' `audio/*.mp3` files and replaces them, keeping the originals so they can be
restored later, even after a restart.

Originals live outside the collection, one store per collection
(`%LOCALAPPDATA%\BloomAudioCompressor\backups\<name>-<hash>\`, see
`packages/lib/src/backups.ts`). Compressing a clip again always starts from its kept
original, so quality is never lost twice. Never put backups inside a book folder: Team
Collections zip the whole book folder on check-in, skipping only files with the Windows
Hidden attribute, so anything there is sent to every teammate.

pnpm workspaces monorepo, with the same toolchain and desktop packaging as BloomBridge:

- `packages/lib` (`@compress-bloom-audio/lib`) — the engine: find ffmpeg, scan a collection,
  label clips from the book's `.htm`, compress a clip, replace a book's audio. Node only,
  no runtime dependencies.
- `packages/gui` (`@compress-bloom-audio/gui`) — React UI plus a Vite-plugin server that runs
  the engine in-process (`server/engine.ts` owns the job; `server/apiPlugin.ts` is the API).
- `packages/app` (`@compress-bloom-audio/app`) — the Neutralino shell that ships the GUI as a
  Windows desktop app, with its Node sidecar, Inno Setup installer and auto-updater.

## ffmpeg comes from the user's Bloom install

We don't ship ffmpeg. `findFfmpeg()` (`packages/lib/src/ffmpeg.ts`) uses
`COMPRESS_BLOOM_AUDIO_FFMPEG` if set, else `%LOCALAPPDATA%\Bloom*\current\ffmpeg.exe` (or an
older `app-*` folder), else `ffmpeg` on PATH. Bloom 6.4's build has the mp3 decoder and
muxer, the wav demuxer and `libmp3lame`, which is all we use. It has **no ffprobe**, so
`probe.ts` parses the stderr of `ffmpeg -i <file>`. Don't add an ffprobe dependency.

## Opus

The Opus switch compresses to Ogg Opus, saved under the clip's own `.mp3` name because that
is how Bloom Player finds a clip. Bloom's ffmpeg can neither encode Opus nor write anything
an Opus encoder reads (no WAV, no raw PCM), so `lib/src/opus.ts` decodes the mp3 with
`mpg123-decoder` (WebAssembly, bundled into the lib's dist) and pipes raw PCM into Xiph's
`opusenc.exe`. The app ships opusenc beside its `node.exe`;
`packages/app/scripts/ensure-opusenc.mjs` fetches it, pinned by SHA-256, into
`packages/app/.cache` for the installer build and the dev server. Nothing here decodes
Opus, so a clip that is already Opus is only ever restored, never re-encoded from itself.

## Toolchain

- **[Vite+](https://viteplus.dev) (`vp`)** — Vite, Vitest, oxfmt, oxlint. Install once
  globally: `npm install -g vite-plus-cli`
- **pnpm**, pinned via `packageManager`. Do not use `npm` or `yarn`.
- **Node.js 22+**.
- **Supply-chain guard** — `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (7 days).

## Commands

```bash
vp install          # deps + pre-commit hook
pnpm build          # lib → gui
vp test run         # all unit tests
vp check            # format + lint + type-check (the pre-commit hook runs this on staged files)
./go.sh             # dev server on http://localhost:5190, lib resolved from source
pnpm app-dev        # desktop window; points at the dev server when it is running
pnpm app-build      # Windows installer (needs Inno Setup)
```

Test imports use `vite-plus/test`, not `vitest`:

```ts
import { describe, it, expect } from "vite-plus/test";
```

## Ports

Dev server **5190**, desktop sidecar **5191**, one higher than BloomBridge's 5180/5181 so
both apps can run at once. `strictPort` is on; don't let Vite fall forward onto 5191.

## Testing against real books

The engine is built for real Bloom books, so check changes against a real collection
(`~/OneDrive/Documents/Bloom/*` or `~/Documents/Bloom/*`). Work on a **copy** of a
collection: Replace overwrites files in the books.
