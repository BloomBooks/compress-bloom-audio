/*
 * Build a self-contained Windows-x64 installer for the Bloom Audio Compressor app.
 *
 * Pipeline:
 *   1. Build lib + gui frontend + gui sidecar bundle.
 *   2. Ensure Neutralino binaries/client, then `neu build --release`.
 *   3. Download + cache a portable node.exe, and Xiph's opusenc.exe (ensure-opusenc.mjs).
 *   4. Assemble stage/ — the exact install image (see plan / README).
 *   5. Compile installer/bloom-audio-compressor.iss with Inno Setup (ISCC) → installer-out/.
 *
 * Windows-only: the installer is Inno Setup, and the app finds its ffmpeg in the user's
 * Bloom install, which is Windows-only.
 * Run via:  pnpm --filter @compress-bloom-audio/app build:win
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { ensureOpusenc, OPUS_TOOLS_DIR } from "./ensure-opusenc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, ".."); // packages/app
const REPO = path.resolve(APP_DIR, "..", ".."); // repo root
const GUI = path.join(REPO, "packages", "gui");
const LIB = path.join(REPO, "packages", "lib");

const STAGE = path.join(APP_DIR, "stage");
const CACHE = path.join(APP_DIR, ".cache");
const OUT = path.join(APP_DIR, "installer-out");

// Pinned portable Node for the bundled sidecar runtime.
const NODE_VERSION = "22.11.0";
const NODE_DIRNAME = `node-v${NODE_VERSION}-win-x64`;
const NODE_ZIP_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIRNAME}.zip`;

function log(msg) {
  process.stdout.write(`\n=== ${msg} ===\n`);
}

/**
 * Run a command, inheriting stdio; throw on non-zero exit.
 * Pass `shell: true` for Windows `.cmd` shims (pnpm/npx/npm) — they can't be spawned
 * directly. Real `.exe`s (node, powershell, ISCC) run with shell:false so their
 * quoted args aren't re-parsed by cmd.exe.
 */
function run(cmd, args, opts = {}) {
  const display = `${cmd} ${args.join(" ")}`;
  process.stdout.write(`$ ${display}\n`);
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd || REPO,
    shell: !!opts.shell,
    env: { ...process.env, ...opts.env },
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (exit ${res.status}): ${display}`);
  }
}

/** Run a `.cmd` shim (pnpm/npx/npm) — needs a shell on Windows. */
function runShim(cmd, args, opts = {}) {
  run(cmd, args, { ...opts, shell: true });
}

/** PowerShell helper (used for the portable-Node download + unzip). */
function powershell(script) {
  run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  await fsp.cp(src, dest, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// ---------------------------------------------------------------------------

async function buildPackages() {
  log("Building lib + gui frontend + sidecar");
  runShim("pnpm", ["--filter", "@compress-bloom-audio/lib", "build"]);
  runShim("pnpm", ["--filter", "@compress-bloom-audio/gui", "build"]);
  runShim("pnpm", ["--filter", "@compress-bloom-audio/gui", "build:server"]);
}

function syncVersion() {
  log("Syncing version into neutralino.config.json");
  run("node", [path.join(APP_DIR, "scripts", "sync-version.mjs")]);
}

function neuBuild() {
  log("Neutralino: ensure binaries + build --release");
  const haveBins = fs.existsSync(path.join(APP_DIR, "bin"));
  const haveClient = fs.existsSync(path.join(APP_DIR, "resources", "js", "neutralino.js"));
  if (!haveBins || !haveClient) {
    runShim("npx", ["--yes", "@neutralinojs/neu@latest", "update"], { cwd: APP_DIR });
  }
  runShim("npx", ["--yes", "@neutralinojs/neu@latest", "build", "--release"], { cwd: APP_DIR });
}

async function ensurePortableNode() {
  log(`Portable Node v${NODE_VERSION}`);
  const nodeExe = path.join(CACHE, NODE_DIRNAME, "node.exe");
  if (fs.existsSync(nodeExe)) {
    process.stdout.write(`cached: ${nodeExe}\n`);
    return nodeExe;
  }
  await fsp.mkdir(CACHE, { recursive: true });
  const zip = path.join(CACHE, `${NODE_DIRNAME}.zip`);
  // Download (PowerShell Invoke-WebRequest avoids extra deps and works on CI).
  powershell(
    `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${NODE_ZIP_URL}' -OutFile '${zip}'`,
  );
  // Extract just the versioned folder (it contains node.exe at its root).
  powershell(`Expand-Archive -Path '${zip}' -DestinationPath '${CACHE}' -Force`);
  if (!fs.existsSync(nodeExe)) {
    throw new Error(`node.exe not found after extracting ${zip}`);
  }
  await fsp.rm(zip, { force: true });
  return nodeExe;
}

/** Find the neu build output for win_x64: the exe + resources.neu (+ WebView2Loader.dll). */
function findNeuArtifacts() {
  const distRoot = path.join(APP_DIR, "dist");
  // neu build writes dist/<binaryName>/...
  const candidates = fs.existsSync(distRoot)
    ? fs
        .readdirSync(distRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(distRoot, d.name))
    : [];
  for (const dir of candidates) {
    const files = fs.readdirSync(dir);
    const exe = files.find((f) => /win_x64.*\.exe$/i.test(f));
    const neu =
      files.find((f) => /\.resources\.neu$/i.test(f)) ||
      (files.includes("resources.neu") ? "resources.neu" : undefined);
    if (exe && neu) {
      return {
        dir,
        exe,
        neu,
        webview2: files.find((f) => /^WebView2Loader\.dll$/i.test(f)),
      };
    }
  }
  throw new Error(
    `Could not find neu build win_x64 artifacts under ${distRoot}. Did 'neu build --release' succeed?`,
  );
}

async function assembleStage(nodeExe) {
  log("Assembling stage/");
  await rmrf(STAGE);
  await fsp.mkdir(STAGE, { recursive: true });

  // (a) Neutralino app binary + bundled resources.
  const a = findNeuArtifacts();
  await fsp.copyFile(path.join(a.dir, a.exe), path.join(STAGE, a.exe));
  await fsp.copyFile(path.join(a.dir, a.neu), path.join(STAGE, a.neu));
  if (a.webview2) {
    await fsp.copyFile(path.join(a.dir, a.webview2), path.join(STAGE, a.webview2));
  }

  // (b) Portable Node.
  await fsp.copyFile(nodeExe, path.join(STAGE, "node.exe"));

  // (b1) opusenc, beside node.exe, where the engine looks for it (lib/src/opus.ts), with
  //      its BSD licence.
  log("opusenc");
  const opusenc = await ensureOpusenc();
  await fsp.copyFile(opusenc, path.join(STAGE, "opusenc.exe"));
  await fsp.copyFile(
    path.join(OPUS_TOOLS_DIR, "LICENSE"),
    path.join(STAGE, "opus-tools-LICENSE.txt"),
  );

  // (b2) App icon (.ico) for the installer + shortcuts (the .iss references {app}\appIcon.ico).
  await fsp.copyFile(
    path.join(APP_DIR, "resources", "icons", "appIcon.ico"),
    path.join(STAGE, "appIcon.ico"),
  );

  // (c) The sidecar runtime under stage/app (mirrors the dev gui layout so serve.cjs
  //     resolves ../dist and ../node_modules unchanged).
  const appDir = path.join(STAGE, "app");
  await fsp.mkdir(path.join(appDir, "server-dist"), { recursive: true });
  await fsp.copyFile(
    path.join(GUI, "server-dist", "serve.cjs"),
    path.join(appDir, "server-dist", "serve.cjs"),
  );
  await copyDir(path.join(GUI, "dist"), path.join(appDir, "dist"));

  // (c2) The product version, for the sidecar (serve.cjs reads ../version.json into
  //      COMPRESS_BLOOM_AUDIO_VERSION).
  const appVersion = readJson(path.join(APP_DIR, "package.json")).version;
  await fsp.writeFile(
    path.join(appDir, "version.json"),
    JSON.stringify({ version: appVersion }, null, 2),
  );

  // (d) node_modules holds only the built lib: the lib's build bundles its one runtime
  //     dependency (the mp3 decoder) into its dist, externalizing only Node's built-ins,
  //     and the sidecar bundle marks every package external, so this is all serve.cjs
  //     needs to resolve.
  const libPkg = readJson(path.join(LIB, "package.json"));
  const libDest = path.join(appDir, "node_modules", "@compress-bloom-audio", "lib");
  await fsp.mkdir(libDest, { recursive: true });
  await copyDir(path.join(LIB, "dist"), path.join(libDest, "dist"));
  await fsp.writeFile(
    path.join(libDest, "package.json"),
    JSON.stringify(
      {
        name: "@compress-bloom-audio/lib",
        version: libPkg.version,
        main: "dist/index.cjs",
        module: "dist/index.mjs",
        types: "dist/index.d.ts",
        exports: libPkg.exports,
      },
      null,
      2,
    ),
  );

  return { appExe: a.exe };
}

function findIscc() {
  if (process.env.ISCC) return process.env.ISCC;
  const guesses = [
    "C:/Program Files (x86)/Inno Setup 6/ISCC.exe",
    "C:/Program Files/Inno Setup 6/ISCC.exe",
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return "ISCC"; // hope it's on PATH
}

function compileInstaller(appExe) {
  log("Compiling installer (Inno Setup)");
  const pkg = readJson(path.join(APP_DIR, "package.json"));
  const version = pkg.version;
  const iss = path.join(APP_DIR, "installer", "bloom-audio-compressor.iss");
  const iscc = findIscc();
  run(iscc, [
    `/DAppVersion=${version}`,
    `/DAppExe=${appExe}`,
    `/DStageDir=${STAGE}`,
    `/DOutDir=${OUT}`,
    iss,
  ]);
  const out = path.join(OUT, `BloomAudioCompressor-Setup-${version}.exe`);
  log(`Installer: ${out}`);
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error(
      "build-installer.mjs is Windows-only (Inno Setup, and the app relies on Bloom for Windows).",
    );
  }
  await buildPackages();
  syncVersion();
  neuBuild();
  const nodeExe = await ensurePortableNode();
  const { appExe } = await assembleStage(nodeExe);
  compileInstaller(appExe);
  log("Done");
}

main().catch((e) => {
  process.stderr.write(`\nbuild-installer failed: ${e.message}\n`);
  process.exit(1);
});
