/* The compression job for one collection: scan it, compress the chosen books (each clip
   from its kept original when we have one, replacing the book's audio as the job
   finishes), preview single clips at a chosen bitrate, and restore the originals. Every
   change is pushed to the GUI as a full state snapshot over SSE (`state` events) — the
   snapshot is small, and a whole snapshot can never leave the client half-updated.
   Server-side only. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  BackupStore,
  compressClip,
  defaultBackupRoot,
  findFfmpeg,
  isBloomCollection,
  scanCollection,
  type Book,
  type Clip,
  type Collection,
  type RestoreResult,
} from "@compress-bloom-audio/lib";

export type Phase = "idle" | "scanning" | "running" | "restoring";
export type ClipStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface ClipState {
  status: ClipStatus;
  progress: number;
  afterBytes?: number;
  error?: string;
}

/** A clip as the GUI sees it: what is in the book now, plus the kept original, if any. */
export interface GuiClip extends Clip {
  original?: { bytes: number; kbps: number; currentKbps: number };
}
export interface GuiBook extends Omit<Book, "clips"> {
  clips: GuiClip[];
}
export interface GuiCollection extends Omit<Collection, "books"> {
  books: GuiBook[];
}

export interface EngineState {
  phase: Phase;
  ffmpeg: string | null;
  collection: GuiCollection | null;
  /** Keyed `<bookId>/<file>`. Only clips of books in the running job appear. */
  clips: Record<string, ClipState>;
  job: { bookIds: string[]; kbps: number } | null;
  stopped: boolean;
  /** Books with originals that Restore would put back. */
  restorableBookIds: string[];
  /** Size of each preview encoded so far, keyed `<bookId>/<file>@<kbps>`. */
  previews: Record<string, number>;
  /** The clip being encoded for a preview, keyed `<bookId>/<file>`. */
  encoding: string | null;
  /** The outcome of the last compress, until the next action. */
  lastCompress: {
    kbps: number;
    books: number;
    savedBytes: number;
    stopped: boolean;
    bookIds: string[];
    /** Every book the run covered, including those with nothing to do. */
    jobBookIds: string[];
    /** When the run finished (ISO); tells one run's result from the next. */
    finishedAt: string;
  } | null;
  /** The outcome of the last Restore, until the next action. */
  lastRestore: RestoreResult | null;
  error: string | null;
}

const WORK_ROOT = path.join(os.tmpdir(), "compress-bloom-audio");
const BACKUP_ROOT = process.env.COMPRESS_BLOOM_AUDIO_BACKUPS || defaultBackupRoot();
const PARALLEL = Math.max(1, Math.min(4, os.cpus().length - 1));

let state: EngineState = {
  phase: "idle",
  ffmpeg: null,
  collection: null,
  clips: {},
  job: null,
  stopped: false,
  restorableBookIds: [],
  previews: {},
  encoding: null,
  lastCompress: null,
  lastRestore: null,
  error: null,
};
let abort: AbortController | null = null;
/** Working copies of the running job; removed once it has replaced the books' audio. */
let workDir: string | null = null;
/** Preview encodes for the open collection; removed when it changes. */
let previewDir: string | null = null;
let store: BackupStore | null = null;

// ---- SSE ------------------------------------------------------------------
type Client = (event: string, data: unknown) => void;
const clients = new Set<Client>();

export function addClient(c: Client): () => void {
  clients.add(c);
  c("state", state);
  return () => clients.delete(c);
}

export function broadcast(event: string, data: unknown): void {
  for (const c of clients) c(event, data);
}

// Progress ticks arrive many times a second per clip; coalesce them to one push per 150ms.
let pushTimer: NodeJS.Timeout | null = null;
function push(now = false) {
  if (now) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
    broadcast("state", state);
    return;
  }
  pushTimer ??= setTimeout(() => {
    pushTimer = null;
    broadcast("state", state);
  }, 150);
}

function set(patch: Partial<EngineState>) {
  state = { ...state, ...patch };
  push(true);
}

export function getState(): EngineState {
  return state;
}

/** Used by the dev server to hold back a code reload while the engine is working. */
export function isEngineBusy(): boolean {
  return state.phase !== "idle" || state.encoding !== null;
}

const key = (bookId: string, file: string) => `${bookId}/${file}`;

function requireIdle() {
  if (state.phase !== "idle") throw new Error(`can't do that while ${state.phase}`);
}

async function rmDir(dir: string | null) {
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function ensureFfmpeg(): Promise<string | null> {
  if (!state.ffmpeg) set({ ffmpeg: await findFfmpeg() });
  return state.ffmpeg;
}

/** Scan the collection and attach each clip's kept original, if it still applies. */
async function scan(ffmpeg: string, folder: string): Promise<GuiCollection> {
  const c = await scanCollection(ffmpeg, folder);
  const s = store!;
  const books: GuiBook[] = [];
  for (const b of c.books) {
    const clips: GuiClip[] = [];
    for (const clip of b.clips) {
      const o = await s.validOriginal(b.id, b.folder, clip.file);
      clips.push(
        o
          ? {
              ...clip,
              original: {
                bytes: o.originalBytes,
                kbps: o.originalKbps,
                currentKbps: o.currentKbps,
              },
            }
          : clip,
      );
    }
    books.push({ ...b, clips });
  }
  return { ...c, books };
}

async function rescan(patch: Partial<EngineState> = {}) {
  const collection = state.collection;
  if (!collection || !state.ffmpeg) return;
  set({ phase: "scanning" });
  const fresh = await scan(state.ffmpeg, collection.folder);
  set({
    ...patch,
    collection: fresh,
    restorableBookIds: await store!.restorableBookIds(fresh.books),
    clips: {},
    job: null,
    phase: "idle",
  });
}

/** Scan `folder` and make it the current collection. */
export async function openCollection(folder: string): Promise<void> {
  requireIdle();
  if (!(await isBloomCollection(folder))) {
    throw new Error("That folder isn't a Bloom collection (it has no .bloomCollection file).");
  }
  const ffmpeg = await ensureFfmpeg();
  if (!ffmpeg) throw new Error("Couldn't find Bloom's ffmpeg. Install Bloom, then try again.");
  await rmDir(previewDir);
  previewDir = null;
  store = new BackupStore(BACKUP_ROOT, folder);
  set({
    phase: "scanning",
    clips: {},
    job: null,
    stopped: false,
    previews: {},
    lastCompress: null,
    lastRestore: null,
    error: null,
  });
  try {
    const collection = await scan(ffmpeg, folder);
    set({
      collection,
      restorableBookIds: await store.restorableBookIds(collection.books),
      phase: "idle",
    });
  } catch (e) {
    set({ phase: "idle", error: `Couldn't read ${folder}: ${(e as Error).message}` });
    throw e;
  }
}

/**
 * What compressing a clip to `kbps` means. A clip we have compressed before is worked from
 * its kept original, so quality is never lost twice: "skip" when it is already at `kbps`,
 * "original" when the original is at or below `kbps` (so the best result is the original
 * itself). A clip never compressed is skipped when it is already at or below `kbps`.
 */
export function plan(
  clip: GuiClip,
  kbps: number,
): { kind: "skip" } | { kind: "original" } | { kind: "encode"; fromOriginal: boolean } {
  if (clip.original) {
    if (clip.original.currentKbps === kbps) return { kind: "skip" };
    if (clip.original.kbps > 0 && clip.original.kbps <= kbps) return { kind: "original" };
    return { kind: "encode", fromOriginal: true };
  }
  if (clip.kbps > 0 && clip.kbps <= kbps) return { kind: "skip" };
  return { kind: "encode", fromOriginal: false };
}

function sourceOf(book: GuiBook, clip: GuiClip, fromOriginal: boolean): string {
  return fromOriginal
    ? store!.originalPath(book.id, clip.file)
    : path.join(book.folder, "audio", clip.file);
}

/** Make the compressed version of one clip at `dest`; resolves to its size, or null if aborted. */
async function produce(
  book: GuiBook,
  clip: GuiClip,
  kbps: number,
  dest: string,
  opts: { signal?: AbortSignal; onProgress?: (p: number) => void } = {},
): Promise<number | null> {
  const p = plan(clip, kbps);
  if (p.kind === "skip") throw new Error("nothing to do");
  if (p.kind === "original") {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(store!.originalPath(book.id, clip.file), dest);
    return (await fs.stat(dest)).size;
  }
  return compressClip(state.ffmpeg!, sourceOf(book, clip, p.fromOriginal), dest, kbps, {
    durationSec: clip.durationSec,
    ...opts,
  });
}

/** Compress the chosen books, then replace their audio, keeping the originals. */
export async function startCompress(bookIds: string[], kbps: number): Promise<void> {
  requireIdle();
  const collection = state.collection;
  if (!collection || !state.ffmpeg) throw new Error("no collection open");
  const books = collection.books.filter((b) => bookIds.includes(b.id));
  await rmDir(workDir);
  workDir = await fs.mkdtemp(path.join(WORK_ROOT + "-"));
  abort = new AbortController();
  const signal = abort.signal;

  const clips: Record<string, ClipState> = {};
  const queue: { book: GuiBook; clip: GuiClip }[] = [];
  for (const book of books) {
    for (const clip of book.clips) {
      if (plan(clip, kbps).kind === "skip") {
        clips[key(book.id, clip.file)] = { status: "skipped", progress: 1, afterBytes: clip.bytes };
      } else {
        clips[key(book.id, clip.file)] = { status: "pending", progress: 0 };
        queue.push({ book, clip });
      }
    }
  }
  set({
    phase: "running",
    clips,
    job: { bookIds, kbps },
    stopped: false,
    lastCompress: null,
    lastRestore: null,
    error: null,
  });

  const dir = workDir;
  let next = 0;
  const worker = async () => {
    while (next < queue.length && !signal.aborted) {
      const { book, clip } = queue[next++];
      const k = key(book.id, clip.file);
      state.clips[k] = { status: "running", progress: 0 };
      push();
      try {
        const size = await produce(book, clip, kbps, path.join(dir, book.id, clip.file), {
          signal,
          onProgress: (p) => {
            state.clips[k] = { ...state.clips[k], progress: p };
            push();
          },
        });
        state.clips[k] =
          size === null
            ? { status: "pending", progress: 0 }
            : { status: "done", progress: 1, afterBytes: size };
      } catch (e) {
        state.clips[k] = { status: "failed", progress: 0, error: (e as Error).message };
      }
      push();
    }
  };
  // Not awaited: the HTTP request returns at once and progress flows over SSE.
  void Promise.all(Array.from({ length: PARALLEL }, worker))
    .then(() => replaceFinished(books, kbps, dir))
    .catch((e) =>
      set({ phase: "idle", error: `Replacing the audio failed: ${(e as Error).message}` }),
    )
    .finally(() => {
      abort = null;
      void rmDir(dir);
      if (workDir === dir) workDir = null;
    });
}

/** Put every finished clip into its book, keeping originals; then rescan. */
async function replaceFinished(books: GuiBook[], kbps: number, dir: string) {
  let savedBytes = 0;
  const changed = new Set<string>();
  for (const book of books) {
    for (const clip of book.clips) {
      const s = state.clips[key(book.id, clip.file)];
      if (s?.status !== "done") continue;
      await store!.replace(book, clip.file, path.join(dir, book.id, clip.file), kbps, clip.kbps);
      savedBytes += clip.bytes - (s.afterBytes ?? clip.bytes);
      changed.add(book.id);
    }
  }
  await rescan({
    lastCompress: {
      kbps,
      books: changed.size,
      savedBytes,
      stopped: state.stopped,
      bookIds: [...changed],
      jobBookIds: books.map((b) => b.id),
      finishedAt: new Date().toISOString(),
    },
  });
}

export function stopCompress(): void {
  if (state.phase !== "running") throw new Error("nothing is compressing");
  state.stopped = true;
  abort?.abort();
}

/** Encode one clip at `kbps` so it can be listened to before compressing anything. */
export async function preview(bookId: string, file: string, kbps: number): Promise<void> {
  requireIdle();
  const book = state.collection?.books.find((b) => b.id === bookId);
  const clip = book?.clips.find((c) => c.file === file);
  if (!book || !clip) throw new Error("no such clip");
  const pk = `${key(bookId, file)}@${kbps}`;
  if (pk in state.previews || plan(clip, kbps).kind === "skip") return;
  if (state.encoding) throw new Error("already encoding a preview");
  previewDir ??= await fs.mkdtemp(path.join(WORK_ROOT + "-preview-"));
  set({ encoding: key(bookId, file) });
  try {
    const size = await produce(book, clip, kbps, path.join(previewDir, String(kbps), bookId, file));
    if (size !== null) state.previews = { ...state.previews, [pk]: size };
  } finally {
    set({ encoding: null });
  }
}

/** Put back the original audio in every book we have compressed in this collection. */
export async function restore(): Promise<void> {
  requireIdle();
  if (!store || !state.collection) throw new Error("no collection open");
  set({ phase: "restoring", lastCompress: null, lastRestore: null, error: null });
  let result: RestoreResult;
  try {
    result = await store.restoreAll();
  } catch (e) {
    set({ phase: "idle", error: `Restoring failed: ${(e as Error).message}` });
    throw e;
  }
  await rmDir(previewDir);
  previewDir = null;
  state.previews = {};
  await rescan({ lastRestore: result });
}

/**
 * The file behind a clip's listen buttons, or null if there isn't one (yet):
 * - "original": what Bloom recorded — the kept original, or the book's file if this app
 *   never compressed the clip;
 * - "current": the file in the book now;
 * - "after": a clip the running job has finished, before it replaces the book's file;
 * - "preview": the clip encoded at `kbps`.
 */
export function clipFile(
  bookId: string,
  file: string,
  which: "original" | "current" | "after" | "preview",
  kbps: number,
): string | null {
  const book = state.collection?.books.find((b) => b.id === bookId);
  const clip = book?.clips.find((c) => c.file === file);
  if (!book || !clip) return null;
  const inBook = path.join(book.folder, "audio", file);
  if (which === "current") return inBook;
  if (which === "original") return clip.original ? store!.originalPath(bookId, file) : inBook;
  if (which === "after") {
    const s = state.clips[key(bookId, file)];
    if (s?.status === "skipped") return inBook;
    if (s?.status !== "done" || !workDir) return null;
    return path.join(workDir, bookId, file);
  }
  if (plan(clip, kbps).kind === "skip") return inBook;
  if (!previewDir || !(`${key(bookId, file)}@${kbps}` in state.previews)) return null;
  return path.join(previewDir, String(kbps), bookId, file);
}
