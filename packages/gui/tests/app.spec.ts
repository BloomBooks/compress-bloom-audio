/* End-to-end: the real UI, the real server, Bloom's real ffmpeg, against a throwaway
   collection (tests/fixture.ts). Each test builds its own collection and opens it the way
   the folder picker would, through POST /api/collection. */
import { test, expect, type Page } from "@playwright/test";
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
});

test("preview encodes one clip and leaves the book alone", async ({ page }) => {
  const before = await hashes(book(MOON));
  await expand(page, MOON);
  const c = clip(page, MOON, "a1.mp3");
  await expect(c).toContainText("~"); // estimated until previewed
  await c.getByRole("button", { name: /preview/i }).click();
  // Once encoded, the After size is the real one, so the estimate's "~" goes.
  await expect(c).not.toContainText("~");
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

  // Every clip got smaller, and nothing was added to the book folders.
  const after = await sizes(book(MOON));
  for (const f of Object.keys(after)) expect(after[f]).toBeLessThan(originalSizes[f]);
  expect((await fs.readdir(book(MOON).folder)).sort()).toEqual([
    "The Moon and the Cap.htm",
    "audio",
    "meta.json",
  ]);
  expect(await fs.readdir(E2E_ENV.COMPRESS_BLOOM_AUDIO_BACKUPS)).toHaveLength(1);

  // The just-compressed clips still show what they were, not "(no change)".
  await expand(page, MOON);
  await expect(clip(page, MOON, "a1.mp3")).not.toContainText("no change");

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

  // A third run at the same setting has nothing to do.
  await compressAll(page, 24, /Nothing to compress: every clip is already at 24 kbps/);
  expect(await sizes(book(MOON))).toEqual(at24);
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
