/*
 * Generate the desktop app icons from the GUI's app.svg.
 *   resources/icons/appIcon.png   — 32x32, used as the Neutralino window icon
 *                                    (title bar + taskbar while running).
 *   resources/icons/appIcon.ico   — multi-size ICO, used by the Inno Setup installer
 *                                    (Setup.exe icon + Start-menu/desktop shortcut icon).
 *
 * Why 32x32 for the window PNG: Neutralino's Windows `setIcon` decodes this PNG and
 * assigns the *single* resulting HICON (at the PNG's native size) to both ICON_SMALL
 * (the title-bar caption, 16px) and ICON_BIG (the running taskbar button, 32px). A
 * 256px source forced Windows to downscale 256->16 for the caption — a 16:1 squeeze
 * that looked blurry. 32px gives the caption a clean 2:1 downscale and an exact-size
 * taskbar icon at 100% DPI. (The runtime path can't carry multiple sizes, so a single
 * well-chosen size is the lever here.)
 *
 * Run once after changing app.svg:  node packages/app/scripts/gen-icons.mjs
 * (The produced PNG/ICO are checked in; the installer build just copies them.)
 */
import sharp from "sharp";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");
const REPO = path.resolve(APP_DIR, "..", "..");
const SVG = path.join(REPO, "packages", "gui", "public", "app.svg");
const ICONS_DIR = path.join(APP_DIR, "resources", "icons");

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// Neutralino's runtime window icon: see header note — a single 32px source serves
// both the title-bar caption (16px) and the running taskbar button (32px) crisply.
const WINDOW_ICON_SIZE = 32;

async function pngAt(size) {
  // density high enough that the 41x41 SVG rasterizes crisply at the largest size.
  return sharp(SVG, { density: 384 }).resize(size, size, { fit: "contain" }).png().toBuffer();
}

/** Pack PNG buffers into a Vista+ ICO (PNG-compressed entries). */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const b = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0); // width (0 => 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1); // height
    dir.writeUInt8(0, b + 2); // palette
    dir.writeUInt8(0, b + 3); // reserved
    dir.writeUInt16LE(1, b + 4); // color planes
    dir.writeUInt16LE(32, b + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, b + 8); // bytes in resource
    dir.writeUInt32LE(offset, b + 12); // offset
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

async function main() {
  if (!fs.existsSync(SVG)) throw new Error(`Source SVG not found: ${SVG}`);
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  fs.writeFileSync(path.join(ICONS_DIR, "appIcon.png"), await pngAt(WINDOW_ICON_SIZE));

  const entries = [];
  for (const size of ICO_SIZES) entries.push({ size, png: await pngAt(size) });
  fs.writeFileSync(path.join(ICONS_DIR, "appIcon.ico"), buildIco(entries));

  process.stdout.write(
    `Wrote appIcon.png + appIcon.ico (${ICO_SIZES.join(",")}) to ${ICONS_DIR}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`gen-icons failed: ${e.message}\n`);
  process.exit(1);
});
