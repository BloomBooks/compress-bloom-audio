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
  findOpusenc,
  isBloomCollection,
  listBook,
  listCollection,
  mapLimit,
  readBook,
  type Book,
  type Clip,
  type Collection,
  type RestoreResult,
  type Target,
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
  /** Why the book couldn't be read. It stays listed, unread, and can't be compressed. */
  error?: string;
}
export interface GuiCollection extends Omit<Collection, "books"> {
  books: GuiBook[];
}

export interface EngineState {
  phase: Phase;
  ffmpeg: string | null;
  /** The Opus encoder, when the app has one (lib/src/opus.ts). */
  opusenc: string | null;
  collection: GuiCollection | null;
  /** Keyed `<bookId>/<file>`. Only clips of books in the running job appear. */
  clips: Record<string, ClipState>;
  job: { bookIds: string[]; target: Target } | null;
  stopped: boolean;
  /** Books with originals that Restore would put back. */
  restorableBookIds: string[];
  /** Size of each preview encoded so far, keyed `<bookId>/<file>@<targetKey>`. */
  previews: Record<string, number>;
  /** The clip being encoded for a preview, keyed `<bookId>/<file>`. */
  encoding: string | null;
  /** The outcome of the last compress, until the next action. */
  lastCompress: {
    target: Target;
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
  /** While books are being read: how many clips have been read, out of how many. `folder`
   *  is the collection they belong to, which is not yet `collection` while it is listed. */
  scanProgress: { folder: string; done: number; total: number } | null;
  error: string | null;
}

/**
 * Working copies and preview encodes live under a folder per server process, named by its
 * pid, so a server that was killed (the desktop app ends its sidecar abruptly) leaves
 * nothing behind for long: each server, on starting, removes the folders of servers that
 * are no longer running. Per process, not shared, because a dev server and the e2e
 * tests' server can run at the same time.
 */
const WORK_PARENT = path.join(os.tmpdir(), "BloomAudioCompressor-work");
const WORK_DIR = path.join(WORK_PARENT, String(process.pid));

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours to signal
  }
}

async function removeLeftovers() {
  let names: string[];
  try {
    names = await fs.readdir(WORK_PARENT);
  } catch {
    return;
  }
  for (const n of names) {
    const pid = Number(n);
    if (Number.isInteger(pid) && pid !== process.pid && !isRunning(pid)) {
      await rmDir(path.join(WORK_PARENT, n));
    }
  }
}
void removeLeftovers();

/** A new, empty folder under this server's work folder. */
async function newWorkFolder(prefix: string): Promise<string> {
  await fs.mkdir(WORK_DIR, { recursive: true });
  return fs.mkdtemp(path.join(WORK_DIR, prefix));
}
const BACKUP_ROOT = process.env.COMPRESS_BLOOM_AUDIO_BACKUPS || defaultBackupRoot();
const PARALLEL = Math.max(1, Math.min(4, os.cpus().length - 1));
/** The end-to-end tests set this to hold each book back before it is read, so they can see
 *  a collection that is listed but not yet read; reading is otherwise too fast to catch. */
const READ_DELAY_MS = Number(process.env.COMPRESS_BLOOM_AUDIO_TEST_READ_DELAY_MS) || 0;

let state: EngineState = {
  phase: "idle",
  ffmpeg: null,
  opusenc: null,
  collection: null,
  clips: {},
  job: null,
  stopped: false,
  restorableBookIds: [],
  previews: {},
  encoding: null,
  lastCompress: null,
  lastRestore: null,
  scanProgress: null,
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

/** A target as a name: "48" for mp3 at 48 kbps, "opus24" for Opus at 24. Mirrored in
 *  src/model.ts, which keys previews the same way. */
export const targetKey = (t: Target) => (t.codec === "opus" ? `opus${t.kbps}` : String(t.kbps));

function requireIdle() {
  if (state.phase !== "idle") throw new Error(`can't do that while ${state.phase}`);
  // A preview encode reads the open collection's originals and writes into its preview
  // folder, so nothing may switch the collection or rewrite its files under it.
  if (state.encoding) throw new Error("can't do that while a preview is encoding");
}

async function rmDir(dir: string | null) {
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function ensureFfmpeg(): Promise<string | null> {
  if (!state.ffmpeg) set({ ffmpeg: await findFfmpeg() });
  if (!state.opusenc) set({ opusenc: findOpusenc() });
  return state.ffmpeg;
}

/** Attach each clip's kept original, if it still applies. */
async function withOriginals(b: Book, s: BackupStore): Promise<GuiBook> {
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
  return { ...b, clips };
}

function showScanProgress(folder: string, done: number, total: number) {
  state = { ...state, scanProgress: { folder, done, total } };
  push();
}

/** Put a book that has just been read in place of its listed (or older) self; null drops it. */
function replaceBook(id: string, book: GuiBook | null) {
  const c = state.collection!;
  const books = book
    ? c.books.map((b) => (b.id === id ? book : b))
    : c.books.filter((b) => b.id !== id);
  state = { ...state, collection: { ...c, books } };
  push();
}

/**
 * Read the open collection's books `bookIds`, showing each one as soon as it is read.
 * `relist` lists each book again first, for books whose files a compress or restore has
 * just changed. A book that can't be read keeps its place, with the reason.
 */
async function readBooks(bookIds: string[], relist: boolean, patch: Partial<EngineState> = {}) {
  const collection = state.collection;
  const ffmpeg = state.ffmpeg;
  const s = store;
  if (!collection || !ffmpeg || !s) return;
  const targets = collection.books.filter((b) => bookIds.includes(b.id));
  const total = targets.reduce((n, b) => n + b.clips.length, 0);
  let done = 0;
  set({ phase: "scanning", scanProgress: { folder: collection.folder, done, total } });
  const onClip = () => showScanProgress(collection.folder, ++done, total);
  await mapLimit(targets, 4, async (b) => {
    let book: GuiBook | null;
    if (READ_DELAY_MS) await new Promise((r) => setTimeout(r, READ_DELAY_MS));
    try {
      const listed = relist ? await listBook(b.folder) : b;
      book = listed && (await withOriginals(await readBook(ffmpeg, listed, onClip), s));
    } catch (e) {
      book = { ...b, read: false, error: (e as Error).message };
    }
    replaceBook(b.id, book);
  });
  set({
    ...patch,
    restorableBookIds: await s.restorableBookIds(state.collection!.books),
    clips: {},
    job: null,
    scanProgress: null,
    phase: "idle",
  });
}

/** Open `folder`: list its books, and return; then read them, showing each as it is read. */
export async function openCollection(folder: string): Promise<void> {
  requireIdle();
  if (!(await isBloomCollection(folder))) {
    throw new Error("That folder isn't a Bloom collection (it has no .bloomCollection file).");
  }
  const ffmpeg = await ensureFfmpeg();
  if (!ffmpeg) throw new Error("Couldn't find Bloom's ffmpeg. Install Bloom, then try again.");
  set({ phase: "scanning", scanProgress: null, error: null });
  let listed: Collection;
  try {
    listed = await listCollection(folder);
  } catch (e) {
    set({ phase: "idle", error: `Couldn't read ${folder}: ${(e as Error).message}` });
    throw e;
  }
  // The new collection's backup store takes over only once the collection is listed: if
  // listing fails, the previous collection stays open, and compressing its books must
  // still keep their originals in its own store.
  store = new BackupStore(BACKUP_ROOT, folder);
  await rmDir(previewDir);
  previewDir = null;
  set({
    collection: listed,
    restorableBookIds: [],
    clips: {},
    job: null,
    stopped: false,
    previews: {},
    lastCompress: null,
    lastRestore: null,
  });
  // Not awaited: callers (the first page load among them) get the listing now, and each
  // book's details arrive as state pushes.
  void readBooks(
    listed.books.map((b) => b.id),
    false,
  ).catch((e) =>
    set({ phase: "idle", scanProgress: null, error: `Couldn't read ${folder}: ${e.message}` }),
  );
}

/**
 * What compressing a clip to `t` means. A clip we have compressed before is worked from
 * its kept original, so quality is never lost twice: "skip" when it is already at the
 * target, "original" when the original is at or below the target's bitrate (so the best
 * result is the original itself). A clip never compressed is skipped when it is already at
 * or below the target's bitrate, or is already Opus (nothing here can decode Opus).
 * Mirrored by `isUnchanged` in src/model.ts.
 */
export function plan(
  clip: GuiClip,
  t: Target,
): { kind: "skip" } | { kind: "original" } | { kind: "encode"; fromOriginal: boolean } {
  if (clip.original) {
    if (clip.original.currentKbps === t.kbps && clip.codec === t.codec) return { kind: "skip" };
    if (clip.original.kbps > 0 && clip.original.kbps <= t.kbps) return { kind: "original" };
    return { kind: "encode", fromOriginal: true };
  }
  if (clip.codec === "opus") return { kind: "skip" };
  if (clip.kbps > 0 && clip.kbps <= t.kbps) return { kind: "skip" };
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
  t: Target,
  dest: string,
  opts: { signal?: AbortSignal; onProgress?: (p: number) => void } = {},
): Promise<number | null> {
  const p = plan(clip, t);
  if (p.kind === "skip") throw new Error("nothing to do");
  if (p.kind === "original") {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(store!.originalPath(book.id, clip.file), dest);
    return (await fs.stat(dest)).size;
  }
  const tools = { ffmpeg: state.ffmpeg!, opusenc: state.opusenc };
  return compressClip(tools, sourceOf(book, clip, p.fromOriginal), dest, t, {
    durationSec: clip.durationSec,
    ...opts,
  });
}

/** Compress the chosen books, then replace their audio, keeping the originals. */
export async function startCompress(bookIds: string[], t: Target): Promise<void> {
  requireIdle();
  if (t.codec === "opus" && !state.opusenc)
    throw new Error("Opus isn't available: opusenc.exe wasn't found");
  const collection = state.collection;
  if (!collection || !state.ffmpeg) throw new Error("no collection open");
  const books = collection.books.filter((b) => b.read && bookIds.includes(b.id));
  await rmDir(workDir);
  workDir = await newWorkFolder("job-");
  abort = new AbortController();
  const signal = abort.signal;

  const clips: Record<string, ClipState> = {};
  const queue: { book: GuiBook; clip: GuiClip }[] = [];
  for (const book of books) {
    for (const clip of book.clips) {
      if (plan(clip, t).kind === "skip") {
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
    job: { bookIds, target: t },
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
        const size = await produce(book, clip, t, path.join(dir, book.id, clip.file), {
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
    .then(() => replaceFinished(books, t, dir))
    .catch((e) =>
      set({ phase: "idle", error: `Replacing the audio failed: ${(e as Error).message}` }),
    )
    .finally(() => {
      abort = null;
      void rmDir(dir);
      if (workDir === dir) workDir = null;
    });
}

/** Put every finished clip into its book, keeping originals; then read those books again. */
async function replaceFinished(books: GuiBook[], t: Target, dir: string) {
  let savedBytes = 0;
  const changed = new Set<string>();
  for (const book of books) {
    for (const clip of book.clips) {
      const s = state.clips[key(book.id, clip.file)];
      if (s?.status !== "done") continue;
      await store!.replace(book, clip.file, path.join(dir, book.id, clip.file), t.kbps, clip.kbps);
      savedBytes += clip.bytes - (s.afterBytes ?? clip.bytes);
      changed.add(book.id);
    }
  }
  await readBooks([...changed], true, {
    lastCompress: {
      target: t,
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

/** Encode one clip as `t` so it can be listened to before compressing anything. */
export async function preview(bookId: string, file: string, t: Target): Promise<void> {
  requireIdle();
  if (t.codec === "opus" && !state.opusenc)
    throw new Error("Opus isn't available: opusenc.exe wasn't found");
  const book = state.collection?.books.find((b) => b.id === bookId);
  const clip = book?.clips.find((c) => c.file === file);
  if (!book || !clip) throw new Error("no such clip");
  const pk = `${key(bookId, file)}@${targetKey(t)}`;
  if (pk in state.previews || plan(clip, t).kind === "skip") return;
  // Claim the encoder before any await, so two requests can't both start one.
  set({ encoding: key(bookId, file) });
  try {
    previewDir ??= await newWorkFolder("preview-");
    const dest = path.join(previewDir, targetKey(t), bookId, file);
    const size = await produce(book, clip, t, dest);
    if (size !== null) state.previews = { ...state.previews, [pk]: size };
  } finally {
    set({ encoding: null });
  }
}

/** Put back the original audio in every book we have compressed in this collection. */
export async function restore(): Promise<void> {
  requireIdle();
  if (!store || !state.collection) throw new Error("no collection open");
  const restoring = state.restorableBookIds;
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
  await readBooks(restoring, true, { lastRestore: result });
}

/**
 * The file behind a clip's listen buttons, or null if there isn't one (yet):
 * - "original": what Bloom recorded — the kept original, or the book's file if this app
 *   never compressed the clip;
 * - "current": the file in the book now;
 * - "after": a clip the running job has finished, before it replaces the book's file;
 * - "preview": the clip encoded as `t`.
 */
export function clipFile(
  bookId: string,
  file: string,
  which: "original" | "current" | "after" | "preview",
  t: Target,
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
  if (plan(clip, t).kind === "skip") return inBook;
  if (!previewDir || !(`${key(bookId, file)}@${targetKey(t)}` in state.previews)) return null;
  return path.join(previewDir, targetKey(t), bookId, file);
}
