---
name: release
description: Cut a new app release. Commits and pushes any pending changes, then triggers the GitHub Actions release workflow (release.yml), which builds the Windows installer and publishes a GitHub Release — auto-bumping packages/app/package.json's patch version if the current version was already released. Use when the user says "release", "ship a new version", "commit and push a new version", or invokes /release.
---

# Cut a new app release

Releasing no longer happens automatically on push. This skill is the terminal entry
point that drives the **release.yml** workflow; the GitHub "Run workflow" button is the
equivalent web entry point. **CI owns versioning** — it bumps
`packages/app/package.json` if the current version already has an `app-v<version>`
release. So this skill must **not** edit the version itself.

Follow these steps.

## 1. Commit and push any pending work

The release builds from the tip of `master`, so anything you want included must be
pushed first.

- `git status --short`. If there are changes:
  - `git add -A`
  - Commit. Subject = the user's argument text if they passed any, else
    `chore: pre-release`. End the message with the trailer on its own line:
    the Co-Authored-By trailer for the model you are (e.g. `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`)
  - `git push` (set upstream with `git push -u origin <branch>` if needed).
- If the tree is already clean, skip committing.

The repo releases from `master`; stay on the current branch (don't create one) unless
the user is already on a different branch.

## 2. Trigger the release workflow

- `gh workflow run release.yml --ref master`
- Only if the user explicitly asked for a **test build** (no release), pass
  `-f dry_run=true` instead.

## 3. Watch it and report

- Find the run (it takes a few seconds to register):
  `gh run list --workflow=release.yml --branch master --limit 1` → grab the run id/URL.
- Watch to completion: `gh run watch <id> --exit-status`.
- On **success**: report the published version and release URL —
  `gh release list --limit 1` and `gh release view app-v<version> --web` (or print the
  URL). Note that CI may have bumped the version, so read the actual released tag rather
  than assuming it matches the local `package.json`.
- On **failure**: show the failing step with `gh run view <id> --log-failed` and
  summarize what broke.

## Notes

- Do **not** modify `packages/app/package.json` or `neutralino.config.json` — the
  workflow handles the version bump (and the build syncs the config from package.json).
- A bare `git push` never triggers a release anymore; only this workflow does.
- The auto-updater serves whatever the newest `app-v*` GitHub Release is, so a
  successful run here is what actually pushes the update to installed copies.
