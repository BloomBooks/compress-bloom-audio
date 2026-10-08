/* End-to-end: the real UI, the real server, Bloom's real ffmpeg, against a throwaway
   collection (tests/fixture.ts). Each test builds its own collection and opens it the way
   the folder picker would, through POST /api/collection. */
import { test, expect, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  buildCollection,
  hashes,
  resetServerFiles,
  sizes,
  E2E_ENV,
  type FixtureBook,
} from "./fixture";

const MOON = "The Moon and the Cap";
const GOATS = "Counting Goats";

let books: FixtureBook[];
const book = (title: string) => books.find((b) => b.title === title)!;

test.beforeEach(async ({ page, request }, info) => {
  await resetServerFiles();
  const c = await buildCollection(
    `Collection ${info.title
      .replace(/[^\w]+/g, " ")
      .trim()
      .slice(0, 30)}`,
  );
  books = c.books;
  const r = await request.post("/api/collection", { data: { folder: c.folder } });
  expect(r.ok(), await r.text()).toBe(true);
  await page.goto("/");
  await expect(page.locator(`[data-book="${MOON}"]`)).toBeVisible();
});

const row = (page: Page, title: string) => page.locator(`[data-book="${title}"]`);
const clip = (page: Page, title: string, file: string) =>
  row(page, title).locator(`[data-clip="${file}"]`);

/** Click a clip's play button and return the size of the audio the page fetched for it. */
async function playedBytes(page: Page, clipRow: Locator, button: string, which: string) {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/audio") && r.url().includes(`which=${which}`),
    ),
    clipRow.getByRole("button", { name: button }).click(),
  ]);
  expect(res.status()).toBeLessThan(300);
  const range = res.headers()["content-range"]; // "bytes 0-1234/5678" when the player asks for a range
  if (range) return Number(range.split("/")[1]);
  return Number(res.headers()["content-length"]);
}

/** No Before/After cell overflows into its neighbour (they are nowrap, so overflow shows as overlap). */
async function expectSizesFit(page: Page) {
  const overflowing = await page
    .locator("[data-cell]")
    .evaluateAll((els) =>
      els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
    );
  expect(overflowing).toEqual([]);
}

const ticked = (page: Page, title: string) => row(page, title).getByRole("checkbox");

/** Tick every book (the header checkbox; its input is visually hidden, so click its label). */
async function tickAll(page: Page) {
  await page.locator('label[for="all"]').click();
  for (const t of [MOON, GOATS]) await expect(ticked(page, t)).toBeChecked();
}

async function expand(page: Page, title: string) {
  await row(page, title).getByRole("button", { name: title }).click();
}

/** Click Compress and wait until the server has finished that run at `kbps`. Waiting on the
 *  on-screen "Compressed N books, saved …" alone is not enough: the previous run's message
 *  can still be showing when the click lands, and reads the same. */
async function compressAll(
  page: Page,
  kbps: number,
  message: RegExp = /Compressed \d+ books?, saved/,
) {
  const started = Date.now();
  await page.getByRole("button", { name: /^Compress \d+ books?$/ }).click();
  await expect
    .poll(
      async () => {
        const s = (await (await page.request.get("/api/startup")).json()).state;
        return s.phase === "idle" && s.lastCompress?.kbps === kbps && Date.now() - started > 0;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect(page.getByRole("status").filter({ hasText: message })).toBeVisible();
}

test("lists the books and names each clip after its page", async ({ page }) => {
  await expect(row(page, MOON)).toContainText("Ready");
  await expand(page, MOON);
  for (const [file, label] of Object.entries(book(MOON).clips)) {
    await expect(clip(page, MOON, file)).toContainText(label);
  }
  await expectSizesFit(page);
});

test("preview encodes one clip and leaves the book alone", async ({ page }) => {
  const before = await hashes(book(MOON));
  await expand(page, MOON);
  const c = clip(page, MOON, "a1.mp3");
  await c.getByRole("button", { name: /preview/i }).click();
  // Once encoded, the After size is the preview's real size.
  const key = `${MOON}/a1.mp3@48`;
  await expect
    .poll(async () => (await (await page.request.get("/api/startup")).json()).state.previews[key])
    .toBeGreaterThan(0);
  const bytes = (await (await page.request.get("/api/startup")).json()).state.previews[key];
  await expect(c.locator("[data-cell=after]")).toHaveText(
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`,
  );
  expect(await hashes(book(MOON))).toEqual(before);
});

test("compress replaces the audio, keeps originals outside the books, and restore puts them back", async ({
  page,
}) => {
  const original = { moon: await hashes(book(MOON)), goats: await hashes(book(GOATS)) };
  const originalSizes = await sizes(book(MOON));

  await compressAll(page, 48);
  await expect(row(page, MOON)).toContainText("Compressed");
  await expect(row(page, GOATS)).toContainText("Compressed");
  // A finished run unticks its books. Their Current size is now the compressed one, with
  // the original's size shown under it.
  await expect(ticked(page, MOON)).not.toBeChecked();
  await expect(ticked(page, GOATS)).not.toBeChecked();
  await expect(row(page, MOON).locator("[data-cell=current]").first()).toContainText("was ");
  await expect(page.getByRole("button", { name: "Compress 0 books" })).toBeDisabled();

  // Every clip got smaller, and nothing was added to the book folders.
  const after = await sizes(book(MOON));
  for (const f of Object.keys(after)) expect(after[f]).toBeLessThan(originalSizes[f]);
  expect((await fs.readdir(book(MOON).folder)).sort()).toEqual([
    "The Moon and the Cap.htm",
    "audio",
    "meta.json",
  ]);
  expect(await fs.readdir(E2E_ENV.COMPRESS_BLOOM_AUDIO_BACKUPS)).toHaveLength(1);

  // A compressed clip: Current is the compressed size, "was" the original's. Original and
  // Current play exactly those two files. Compressing again at this setting would change
  // nothing, so there is no Preview.
  await expand(page, MOON);
  const a1 = clip(page, MOON, "a1.mp3");
  await expect(a1.locator("[data-cell=current]")).toContainText("was ");
  await expectSizesFit(page);
  await expect(a1.getByRole("button", { name: /preview/i })).toHaveCount(0);
  expect(await playedBytes(page, a1, "Play current", "current")).toBe(after["a1.mp3"]);
  expect(await playedBytes(page, a1, "Play original", "original")).toBe(originalSizes["a1.mp3"]);

  // Pick another setting and Preview comes back, alongside Original and Current.
  await page.getByRole("button", { name: /High quality/ }).click();
  await expect(a1.getByRole("button", { name: /preview/i })).toBeVisible();
  await expect(a1.getByRole("button", { name: "Play current" })).toBeVisible();
  await page.getByRole("button", { name: /Balanced/ }).click();
  await page.getByRole("button", { name: "Restore original audio…" }).click();
  await expect(page.getByText("Put back the original recordings in 2 books?")).toBeVisible();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("Original audio restored in 2 books")).toBeVisible();

  expect(await hashes(book(MOON))).toEqual(original.moon);
  expect(await hashes(book(GOATS))).toEqual(original.goats);
  await expect(page.getByRole("button", { name: "Restore original audio…" })).toHaveCount(0);
});

test("compressing again at another setting starts from the originals", async ({ page }) => {
  const originalSizes = await sizes(book(MOON));
  await compressAll(page, 48); // Balanced
  const at48 = await sizes(book(MOON));

  await page.getByRole("button", { name: /Speech/ }).click();
  await tickAll(page);
  await expect(row(page, MOON)).toContainText("Ready · from originals");
  await compressAll(page, 24);
  const at24 = await sizes(book(MOON));

  // From the 128 kbps originals, 24 kbps is about 24/128 of the original size. From the
  // 48 kbps copies it would be about half of those instead; the two are far enough apart
  // to tell which file the encode started from.
  for (const f of Object.keys(at24)) {
    expect(at24[f]).toBeLessThan(at48[f]);
    expect(at24[f] / originalSizes[f]).toBeLessThan(0.3);
  }

  // A third run at the same setting has nothing to do. Re-ticked books stay ticked through
  // later updates from the server (here, a preview) until a new run finishes.
  await tickAll(page);
  // A preview at another bitrate makes the server push new state snapshots.
  await page.request.post("/api/preview", { data: { book: GOATS, file: "g1.mp3", kbps: 96 } });
  await expect
    .poll(async () =>
      Object.keys((await (await page.request.get("/api/startup")).json()).state.previews),
    )
    .toContain(`${GOATS}/g1.mp3@96`);
  await expect(ticked(page, MOON)).toBeChecked();
  await compressAll(page, 24, /Nothing to compress: every clip is already at 24 kbps/);
  expect(await sizes(book(MOON))).toEqual(at24);
  // Every clip now reads "already at the target"; its sizes must still fit their columns.
  await expand(page, MOON);
  await expect(clip(page, MOON, "a1.mp3")).toBeVisible();
  await expectSizesFit(page);
});

test("restore leaves a clip alone that was recorded again after compressing", async ({ page }) => {
  const original = await hashes(book(GOATS));
  await compressAll(page, 48);
  const rerecorded = "not really an mp3, but a stand-in for a new recording";
  await fs.writeFile(path.join(book(GOATS).folder, "audio", "g2.mp3"), rerecorded);

  await page.getByRole("button", { name: "Restore original audio…" }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.getByText(/1 clip recorded again since compressing was left as it is/),
  ).toBeVisible();

  expect((await hashes(book(GOATS)))["g1.mp3"]).toBe(original["g1.mp3"]);
  expect(await fs.readFile(path.join(book(GOATS).folder, "audio", "g2.mp3"), "utf8")).toBe(
    rerecorded,
  );
});

test("columns can be dragged wider, and keep their width after a reload", async ({ page }) => {
  const title = row(page, MOON).getByRole("button", { name: MOON });
  const clips = page.getByText("Clips", { exact: true });
  const widthBefore = (await title.boundingBox())!.width;
  const clipsXBefore = (await clips.boundingBox())!.x;

  const handle = page.locator('[data-resize="Book"]');
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 120, h.y + h.height / 2, { steps: 6 });
  await page.mouse.up();

  // The Book column grew by the drag, and the columns after it moved right with it.
  expect((await clips.boundingBox())!.x - clipsXBefore).toBeCloseTo(120, -1);
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(widthBefore);

  await page.reload();
  expect(
    (await page.getByText("Clips", { exact: true }).boundingBox())!.x - clipsXBefore,
  ).toBeCloseTo(120, -1);

  // Double-clicking the handle puts the default back.
  await page.locator('[data-resize="Book"]').dblclick();
  expect((await page.getByText("Clips", { exact: true }).boundingBox())!.x).toBeCloseTo(
    clipsXBefore,
    -1,
  );
});
