# @compress-bloom-audio/app

The Windows desktop app for Bloom Audio Compressor (`@compress-bloom-audio/gui`).

## How it works

Uses [Neutralino](https://neutralino.js.org) for the window and runs a Node backend as a
**sidecar process**:

```
Neutralino window
 └─ resources/index.html (boot page, Neutralino origin)
      ├─ spawns:  node ../gui/server-dist/serve.cjs --port 5191
      ├─ waits for the sidecar's port to come up
      ├─ shows:   <iframe src="http://127.0.0.1:5191/">  (the GUI, same-origin inside)
      └─ on windowClose: kills the sidecar, then exits
```

The sidecar spawns ffmpeg from the user's Bloom install (see `findFfmpeg` in
`packages/lib/src/ffmpeg.ts`), so the installer carries no ffmpeg of its own.

### Dev mode points the iframe at the Vite dev server instead

The sidecar is a build artifact, so nothing behind it hot-reloads. The Vite dev server
(`./go.sh`, port 5190) resolves `@compress-bloom-audio/lib` to its TypeScript source and
reloads the API handler on change. So in dev (`neu run`) `resources/boot.js` waits up to
12 s for `http://localhost:5190` and, if it answers, points the iframe there and never
spawns the sidecar:

```
dev, dev server up      → iframe → http://localhost:5190  (HMR + live engine)
dev, no dev server      → iframe → http://127.0.0.1:5191  (built sidecar, spawned)
release bundle          → iframe → http://127.0.0.1:5191  (built sidecar, never probes 5190)
```

The dev-server host must be the **name** `localhost`, not `127.0.0.1`: Vite binds to
whatever Node resolves `localhost` to, which on Windows is often `::1` only, and an IPv4
literal would silently fall back to the sidecar.

Use **`dev:built`** to exercise the real shipping path (built sidecar, no hot reload)
before cutting a release.

### Remembered window state

`resources/boot.js` polls the window geometry and writes it to
`<OS data dir>/BloomAudioCompressor/window-state.json`, restoring it on next launch.

## First-time setup (downloads the Neutralino framework binaries — needs network)

```bash
pnpm app-setup
```

`bin/`, `resources/js/` and `extensions/` are gitignored. Both `dev` and `build:win` fetch
them automatically when missing ([scripts/ensure-framework.mjs](scripts/ensure-framework.mjs)).

## Run

```bash
pnpm app-dev
```

Run it alongside the dev server (`./go.sh`) for hot reload. Without a dev server it
falls back to the built sidecar, which `pnpm run dev:built` produces; Node must be on `PATH`.

## Icons

`resources/icons/appIcon.png` (window) and `appIcon.ico` (installer, shortcuts) are
generated from `packages/gui/public/app.svg` and checked in:

```bash
pnpm --filter @compress-bloom-audio/app gen-icons
```

## Building the Windows installer

```bash
pnpm app-build
```

[scripts/build-installer.mjs](scripts/build-installer.mjs) builds lib + gui + sidecar,
runs `neu build --release`, downloads a pinned portable `node.exe`, assembles the install
image under `stage/`, and compiles it with Inno Setup
([installer/bloom-audio-compressor.iss](installer/bloom-audio-compressor.iss)) into
`installer-out/BloomAudioCompressor-Setup-<version>.exe`.

It installs per-user into `%LOCALAPPDATA%\BloomAudioCompressor` (no admin). The installer
is **unsigned**, so SmartScreen shows an "unknown publisher" prompt on first run.

Building locally needs Inno Setup 6 (`winget install JRSoftware.InnoSetup`, or set the
`ISCC` env var to `ISCC.exe`). CI installs it automatically.

## Auto-update

On startup (release builds only), the app asks GitHub for the latest release and, if it
is newer than the running one, offers to download and install it.

```
boot.js (app shown)
 └─ updater.js: window.CompressBloomAudioUpdater.check()
      ├─ GET api.github.com/repos/BloomBooks/compress-bloom-audio/releases/latest
      ├─ compare its app-v<version> tag to NL_APPVERSION
      ├─ if newer: prompt → download BloomAudioCompressor-Setup-<v>.exe to %TEMP%
      └─ launch the installer detached, then exit. Inno Setup upgrades in place
         (stable AppId) and relaunches the app.
```

- **Why not Neutralino's built-in updater?** `Neutralino.updater` only swaps the small
  `resources.neu` bundle; it can't update the bundled `node.exe` or the `app/` directory.
- The endpoint is the `UPDATE_URL` global in [neutralino.config.json](neutralino.config.json).
- A local test channel (`<data dir>/BloomAudioCompressor/update-source.txt` naming a folder
  of installers) rehearses the whole update with no network; see `updater.js`.
- The check no-ops in `neu run` dev mode and swallows all errors.

## Scope

Windows x64 only for now.
