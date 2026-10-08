import { describe, it, expect, beforeEach } from "vite-plus/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BackupStore } from "./backups";

// Real files on disk standing in for mp3s: the store works on bytes and hashes, not audio.
let root: string;
let collection: string;
let backups: string;
let work: string;
const book = () => ({ id: "Book A", folder: path.join(collection, "Book A"), title: "Book A" });
const audio = (f: string) => path.join(book().folder, "audio", f);
const read = (f: string) => fs.readFile(audio(f), "utf8");

/** Put `text` in place of clip `file`, as a compress to `kbps` would. */
async function replace(
  store: BackupStore,
  file: string,
  text: string,
  kbps: number,
  currentKbps = 128,
) {
  await fs.mkdir(work, { recursive: true });
  const p = path.join(work, `${kbps}-${file}`);
  await fs.writeFile(p, text);
  await store.replace(book(), file, p, kbps, currentKbps);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cba-test-"));
  collection = path.join(root, "Collection");
  backups = path.join(root, "backups");
  work = path.join(root, "work");
  await fs.mkdir(path.join(book().folder, "audio"), { recursive: true });
  await fs.writeFile(audio("a.mp3"), "original a");
  await fs.writeFile(audio("b.mp3"), "original b");
});

describe("BackupStore", () => {
  it("keeps originals outside the book, and restores them", async () => {
    const store = new BackupStore(backups, collection);
    await replace(store, "a.mp3", "48k a", 48);
    await replace(store, "b.mp3", "48k b", 48);
    expect(await read("a.mp3")).toBe("48k a");
    expect(await fs.readdir(book().folder)).toEqual(["audio"]);
    expect(await store.restorableBookIds([book()])).toEqual(["Book A"]);

    const r = await store.restoreAll();
    expect(r).toEqual({ restoredBooks: 1, restoredClips: 2, changedSince: [] });
    expect(await read("a.mp3")).toBe("original a");
    expect(await read("b.mp3")).toBe("original b");
    expect(await store.restorableBookIds([book()])).toEqual([]);
  });

  it("keeps the first original when a clip is compressed a second time", async () => {
    const store = new BackupStore(backups, collection);
    await replace(store, "a.mp3", "48k a", 48);
    const o = await store.validOriginal("Book A", book().folder, "a.mp3");
    expect(o).toMatchObject({ originalKbps: 128, currentKbps: 48 });
    expect(await fs.readFile(o!.path, "utf8")).toBe("original a");

    await replace(store, "a.mp3", "24k a", 24);
    expect(await store.validOriginal("Book A", book().folder, "a.mp3")).toMatchObject({
      originalKbps: 128,
      currentKbps: 24,
    });
    await store.restoreAll();
    expect(await read("a.mp3")).toBe("original a");
  });

  it("treats a clip recorded again since as its own original", async () => {
    const store = new BackupStore(backups, collection);
    await replace(store, "a.mp3", "48k a", 48);
    await replace(store, "b.mp3", "48k b", 48);
    await fs.writeFile(audio("b.mp3"), "re-recorded b");
    expect(await store.validOriginal("Book A", book().folder, "b.mp3")).toBeNull();

    const r = await store.restoreAll();
    expect(r.restoredClips).toBe(1);
    expect(r.changedSince).toEqual([{ title: "Book A", file: "b.mp3" }]);
    expect(await read("a.mp3")).toBe("original a");
    expect(await read("b.mp3")).toBe("re-recorded b");
  });

  it("stops keeping an original that is put back by compressing", async () => {
    const store = new BackupStore(backups, collection);
    await replace(store, "a.mp3", "48k a", 48);
    // Compressing to a bitrate at or above the original's yields the original itself.
    await replace(store, "a.mp3", "original a", 128);
    expect(await read("a.mp3")).toBe("original a");
    expect(await store.restorableBookIds([book()])).toEqual([]);
  });

  it("survives a restart and keeps collections apart", async () => {
    await replace(new BackupStore(backups, collection), "a.mp3", "48k a", 48);
    const reopened = new BackupStore(backups, collection);
    expect(await reopened.restorableBookIds([book()])).toEqual(["Book A"]);
    expect(
      await new BackupStore(backups, path.join(root, "Other")).restorableBookIds([book()]),
    ).toEqual([]);
  });

  it("keeps the original when a re-compression stops between saving its record and replacing the file", async () => {
    const store = new BackupStore(backups, collection);
    await replace(store, "a.mp3", "48k a", 48);
    // What a 24 kbps run leaves behind if the app stops after saving the manifest but
    // before the book's file is replaced: the record names the 24k copy, the book still
    // holds the 48k one.
    const manifestPath = path.join(store.dir, "manifest.json");
    const m = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const c = m.books["Book A"].clips["a.mp3"];
    Object.assign(c, {
      previousSha256: c.currentSha256,
      previousKbps: 48,
      currentSha256: "hash of a 24k copy that never reached the book",
      currentKbps: 24,
    });
    await fs.writeFile(manifestPath, JSON.stringify(m));

    const reopened = new BackupStore(backups, collection);
    expect(await reopened.validOriginal("Book A", book().folder, "a.mp3")).toMatchObject({
      currentKbps: 48,
    });
    await replace(reopened, "a.mp3", "24k a", 24); // the retry
    await reopened.restoreAll();
    expect(await read("a.mp3")).toBe("original a");
  });
});
