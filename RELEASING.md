# Branching, versioning & releasing

This is a small utility, so the process is deliberately light.

## Branching

Trunk-based on `master`:

- Commit small changes straight to `master`.
- Use a short-lived branch + PR only when you want review or want CI to vet something
  risky. No long-lived or release branches.
- `master` is always releasable.

## Versioning

One version for the desktop app, `MAJOR.MINOR.PATCH`, starting at **0.1.0** (`0.x` means
pre-stable):

- **PATCH** for fixes, **MINOR** for features.
- The single source of truth is the `version` field in
  [`packages/app/package.json`](packages/app/package.json). The installer filename, the
  in-app version, and the release tag are all derived from it.

## Continuous integration

| Workflow                                       | Runs on                                    | Does                                                                                     |
| ---------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [`ci.yml`](.github/workflows/ci.yml)           | every push to `master` + every PR (Ubuntu) | `pnpm build` + `vp test run` + `vp check`. Fast, non-blocking.                           |
| [`release.yml`](.github/workflows/release.yml) | manual only (Windows)                      | Builds the installer, bumping the version if it was already released, then publishes it. |

## Cutting a release

Run the `/release` skill, or Actions → "Build & Release Windows Installer" → "Run
workflow". The workflow:

1. Bumps the patch digit of `packages/app/package.json` (and commits that) if the current
   version already has an `app-v<version>` release. Bump MINOR yourself before running it
   when a release adds features.
2. Builds `BloomAudioCompressor-Setup-<version>.exe` on a Windows runner.
3. Publishes a GitHub Release tagged **`app-v<version>`** with the installer attached and
   auto-generated notes. Installed copies see it on their next launch.

Users install per-user, no admin. The installer is unsigned, so SmartScreen shows an
"unknown publisher" prompt on first run.

### Test builds without releasing

Run the release workflow with `dry_run` ticked (or ask `/release` for a test build). It
builds the installer and uploads it as a workflow artifact kept for one day, and does
**not** bump the version or publish a Release.

## Notes

- Building locally: `pnpm app-build` (Windows + Inno Setup).
  See [`packages/app/README.md`](packages/app/README.md).
- Code signing is not set up yet; `release.yml` is structured so a `signtool` step can be
  slotted in later.
