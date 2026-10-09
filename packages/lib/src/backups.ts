/* The original audio, kept outside the collection so it can be put back later — after the
   app has quit — and so books are always compressed from their originals rather than from
   an earlier compressed copy, and the backups are never published, uploaded, or checked in
   to a Team Collection with the book.

   One store per collection:

     <backupRoot>/<collectionKey>/manifest.json
     <backupRoot>/<collectionKey>/<bookId>/<file>     the original, byte for byte

   For every clip we have replaced, the manifest records the hash of the original and the
   hash of the compressed copy now in the book. The book is treated as still holding our
   copy only while its file has that hash, so a clip someone re-recorded since becomes its
   own new original and is never overwritten by a restore. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface StoredClip {
  originalSha256: string;
  originalBytes: number;
  originalKbps: number;
  /** The compressed copy we put in the book. */
  currentSha256: string;
  currentKbps: number;
  /**
   * Set only while a re-compression is replacing the book's file: the copy that was there
   * before. The manifest is saved before the file is replaced, so if the app stops in
   * between, the book still holds this copy. Recognising it keeps that copy from being
   * mistaken for a new recording, which would overwrite the kept original.
   */
  previousSha256?: string;
  previousKbps?: number;
}

export interface StoredBook {
  folder: string;
  title: string;
  clips: Record<string, StoredClip>;
}

interface Manifest {
  collectionFolder: string;
  books: Record<string, StoredBook>;
}

/** `%LOCALAPPDATA%\BloomAudioCompressor\backups` — per user, outside every collection, and
 *  (unlike %TEMP%) not something Windows Storage Sense empties on its own. */
export function defaultBackupRoot(): string {
  const base =
    process.env.LOCALAPPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".local", "share"));
  return path.join(base, "BloomAudioCompressor", "backups");
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** A collection's store folder name: readable, plus a hash of its full path so two
 *  collections with the same name in different places don't share one. Windows paths
 *  compare case-insensitively, so they hash lower-cased. */
function collectionKey(collectionFolder: string): string {
  let p = path.resolve(collectionFolder).replace(/[\\/]+$/, "");
  if (process.platform === "win32") p = p.toLowerCase();
  const hash = createHash("sha256").update(p).digest("hex").slice(0, 10);
  const name = path
    .basename(p)
    .replace(/[^\p{L}\p{N} _-]/gu, "_")
    .slice(0, 40);
  return `${name}-${hash}`;
}

/** Copy `src` over `target` via a temp file beside it, so an interruption leaves either
 *  the old file or the new one, never half of one. */
async function replaceFile(src: string, target: string) {
  const temp = target + ".compressing";
  await fs.copyFile(src, temp);
  await fs.rename(temp, target);
}

/** The originals kept for one collection. */
export class BackupStore {
  readonly dir: string;
  private manifest: Manifest | null = null;

  constructor(
    backupRoot: string,
    readonly collectionFolder: string,
  ) {
    this.dir = path.join(backupRoot, collectionKey(collectionFolder));
  }

  private get manifestPath() {
    return path.join(this.dir, "manifest.json");
  }

  private async load(): Promise<Manifest> {
    if (this.manifest) return this.manifest;
    try {
      this.manifest = JSON.parse(await fs.readFile(this.manifestPath, "utf8")) as Manifest;
    } catch {
      this.manifest = { collectionFolder: this.collectionFolder, books: {} };
    }
    return this.manifest;
  }

  private async save() {
    const m = await this.load();
    for (const [id, b] of Object.entries(m.books))
      if (!Object.keys(b.clips).length) delete m.books[id];
    await fs.mkdir(this.dir, { recursive: true });
    const temp = this.manifestPath + ".tmp";
    await fs.writeFile(temp, JSON.stringify(m, null, 2));
    await fs.rename(temp, this.manifestPath);
  }

  originalPath(bookId: string, file: string): string {
    return path.join(this.dir, bookId, file);
  }

  /**
   * The kept original of a clip, if the book still holds the compressed copy we put
   * there. Null when we never replaced the clip, or it has changed since (re-recorded),
   * in which case the file in the book is the original.
   */
  async validOriginal(
    bookId: string,
    bookFolder: string,
    file: string,
  ): Promise<(StoredClip & { path: string }) | null> {
    const entry = (await this.load()).books[bookId]?.clips[file];
    if (!entry) return null;
    const current = await sha256File(path.join(bookFolder, "audio", file)).catch(() => null);
    const { previousSha256, previousKbps, ...rest } = entry;
    if (current === entry.currentSha256) return { ...rest, path: this.originalPath(bookId, file) };
    // An interrupted re-compression: the book still holds the copy from before it.
    if (previousSha256 && current === previousSha256) {
      return {
        ...rest,
        currentSha256: previousSha256,
        currentKbps: previousKbps ?? rest.currentKbps,
        path: this.originalPath(bookId, file),
      };
    }
    return null;
  }

  /** Every book with at least one clip that Restore would put back. */
  async restorableBookIds(books: { id: string; folder: string }[]): Promise<string[]> {
    const out: string[] = [];
    for (const b of books) {
      const entry = (await this.load()).books[b.id];
      if (!entry) continue;
      for (const file of Object.keys(entry.clips)) {
        if (await this.validOriginal(b.id, b.folder, file)) {
          out.push(b.id);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Put a compressed copy in place of a clip, first keeping the original (unless one we
   * already keep still applies). The manifest is saved before the book is touched.
   */
  async replace(
    book: { id: string; folder: string; title: string },
    file: string,
    compressedPath: string,
    compressedKbps: number,
    currentKbps: number,
  ): Promise<void> {
    const m = await this.load();
    const target = path.join(book.folder, "audio", file);
    const keep = await this.validOriginal(book.id, book.folder, file);
    const [currentSha, newSha] = await Promise.all([
      sha256File(target),
      sha256File(compressedPath),
    ]);
    let entry: StoredClip;
    if (keep) {
      const { path: _path, ...kept } = keep;
      void _path;
      entry = {
        ...kept,
        previousSha256: currentSha,
        previousKbps: keep.currentKbps,
        currentSha256: newSha,
        currentKbps: compressedKbps,
      };
    } else {
      const backup = this.originalPath(book.id, file);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(target, backup);
      entry = {
        originalSha256: currentSha,
        originalBytes: (await fs.stat(target)).size,
        originalKbps: currentKbps,
        currentSha256: newSha,
        currentKbps: compressedKbps,
      };
    }
    if (newSha === entry.originalSha256) {
      // The "compressed" copy is the original itself (the target was at or above the
      // original's bitrate): put it back and stop keeping it.
      await replaceFile(compressedPath, target);
      delete m.books[book.id]?.clips[file];
      await this.save();
      return;
    }
    m.books[book.id] ??= { folder: book.folder, title: book.title, clips: {} };
    m.books[book.id].folder = book.folder;
    m.books[book.id].title = book.title;
    m.books[book.id].clips[file] = entry;
    await this.save();
    await replaceFile(compressedPath, target);
    // The book now holds the new copy; the old one need no longer be recognised.
    delete entry.previousSha256;
    delete entry.previousKbps;
    await this.save();
  }

  /**
   * Put back the original of every clip we have replaced in this collection, then stop
   * keeping those originals. A clip changed since we replaced it is left alone and its
   * entry dropped: the book's file is its new original.
   */
  async restoreAll(): Promise<RestoreResult> {
    const m = await this.load();
    const result: RestoreResult = { restoredBooks: 0, restoredClips: 0, changedSince: [] };
    for (const [bookId, b] of Object.entries(m.books)) {
      let any = false;
      for (const [file, entry] of Object.entries(b.clips)) {
        const target = path.join(b.folder, "audio", file);
        const current = await sha256File(target).catch(() => null);
        if (
          current === entry.currentSha256 ||
          (entry.previousSha256 && current === entry.previousSha256)
        ) {
          await replaceFile(this.originalPath(bookId, file), target);
          result.restoredClips++;
          any = true;
        } else if (current !== entry.originalSha256) {
          result.changedSince.push({ title: b.title, file });
        }
        delete b.clips[file];
        await fs.rm(this.originalPath(bookId, file), { force: true });
      }
      if (any) result.restoredBooks++;
    }
    await this.save();
    return result;
  }
}

export interface RestoreResult {
  restoredBooks: number;
  restoredClips: number;
  /** Clips left as they are because they changed after compressing (e.g. re-recorded). */
  changedSince: { title: string; file: string }[];
}
