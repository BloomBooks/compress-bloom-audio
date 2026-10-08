/* What the screen shows, computed from the server's state plus the choices the user is
   making on this screen (which books are ticked, the target bitrate). Pure, so it can be
   tested without a DOM. The wording follows the design's prototype. */
import type { Book, Clip, ClipState, EngineState } from "./api";

export const PRESETS: {
  id: "speech" | "balanced" | "high";
  label: string;
  hint: string;
  kbps: number;
}[] = [
  { id: "speech", label: "Speech", hint: "24 kbps · mono · smallest", kbps: 24 },
  { id: "balanced", label: "Balanced", hint: "48 kbps · mono · recommended", kbps: 48 },
  { id: "high", label: "High quality", hint: "96 kbps · music and singing", kbps: 96 },
];

export function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (bytes <= 0) return "0 KB";
  return mb >= 1 ? mb.toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
}

export function fmtDuration(sec: number): string {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Compressing this clip to `kbps` would change nothing. Mirrors `plan` in server/engine.ts. */
export function isUnchanged(c: Clip, kbps: number): boolean {
  if (c.original) return c.original.currentKbps === kbps;
  return c.kbps > 0 && c.kbps <= kbps;
}

/** The clip's size at `kbps`, estimated from its original when we keep one. */
export function estimateAfter(c: Clip, kbps: number): number {
  if (isUnchanged(c, kbps)) return c.bytes;
  const base = c.original ?? { bytes: c.bytes, kbps: c.kbps };
  if (!base.kbps || base.kbps <= kbps) return base.bytes;
  return Math.round((base.bytes * kbps) / base.kbps);
}

/** The clip's size after compressing: actual once compressed, else a preview's, else estimated. */
export function clipAfter(
  c: Clip,
  s: ClipState | undefined,
  kbps: number,
  previewBytes: number | undefined,
): { bytes: number; actual: boolean } {
  if (s?.status === "done" || s?.status === "skipped")
    return { bytes: s.afterBytes ?? c.bytes, actual: true };
  if (s?.status === "failed") return { bytes: c.bytes, actual: true };
  if (isUnchanged(c, kbps)) return { bytes: c.bytes, actual: true };
  if (previewBytes !== undefined) return { bytes: previewBytes, actual: true };
  return { bytes: estimateAfter(c, kbps), actual: false };
}

/** The last run covered this book at this bitrate: its row says "Compressed". */
export function wasJustCompressed(st: EngineState, bookId: string, kbps: number): boolean {
  const lc = st.lastCompress;
  return !!lc && st.phase !== "running" && lc.kbps === kbps && lc.bookIds.includes(bookId);
}

const finished = (s: ClipState | undefined) =>
  !!s && s.status !== "pending" && s.status !== "running";

export interface BookRow {
  book: Book;
  /** What is in the book now. */
  current: number;
  /** What Bloom recorded: the kept originals, plus the clips never compressed. */
  original: number;
  /** Some clip in the book has been compressed by this app (so has a kept original). */
  compressed: boolean;
  /** At the chosen setting. */
  after: number;
  /** Every clip's after-size is known, not estimated. */
  actual: boolean;
  running: boolean;
  /** 0..1 of this book's bytes processed so far. */
  progress: number;
  status: string;
  statusTone: "muted" | "subtle" | "text" | "green" | "red";
}

export function bookRow(book: Book, st: EngineState, selected: boolean, kbps: number): BookRow {
  const inJob = !!st.job?.bookIds.includes(book.id);
  const k = inJob ? st.job!.kbps : kbps;
  let current = 0;
  let original = 0;
  let after = 0;
  let done = 0;
  let actual = true;
  let anyFailed = false;
  let running = false;
  const just = wasJustCompressed(st, book.id, kbps);
  for (const c of book.clips) {
    const s = inJob ? st.clips[`${book.id}/${c.file}`] : undefined;
    const a = clipAfter(c, s, k, st.previews[`${book.id}/${c.file}@${k}`]);
    current += c.bytes;
    original += c.original?.bytes ?? c.bytes;
    after += a.bytes;
    actual &&= a.actual;
    anyFailed ||= s?.status === "failed";
    running ||= s?.status === "running";
    done += finished(s) ? c.bytes : s?.status === "running" ? c.bytes * s.progress : 0;
  }
  const allUnchanged = book.clips.every((c) => isUnchanged(c, k));
  const wasCompressed = book.clips.some((c) => c.original);
  const unchangedLabel = wasCompressed ? `Already at ${k} kbps` : "Already small";
  const progress = current ? done / current : 0;
  let status: string;
  let statusTone: BookRow["statusTone"] = "muted";

  if (just) {
    status = "Compressed";
    statusTone = "green";
  } else if (st.phase !== "running") {
    status = !selected
      ? "Not selected"
      : allUnchanged
        ? unchangedLabel
        : wasCompressed
          ? "Ready · from originals"
          : "Ready";
    if (!selected || allUnchanged) statusTone = "subtle";
  } else if (!inJob) {
    status = "—";
    statusTone = "subtle";
  } else if (book.clips.every((c) => finished(st.clips[`${book.id}/${c.file}`]))) {
    status = anyFailed ? "Some clips failed" : allUnchanged ? unchangedLabel : "Compressed";
    statusTone = anyFailed ? "red" : "green";
  } else if (running || done > 0) {
    status = Math.round(progress * 100) + "%";
    statusTone = "text";
  } else {
    status = "Waiting";
  }
  return {
    book,
    current,
    original,
    compressed: wasCompressed,
    after,
    actual,
    running,
    progress,
    status,
    statusTone,
  };
}

export const TONE_COLOR: Record<BookRow["statusTone"], string> = {
  muted: "var(--app-text-muted)",
  subtle: "var(--app-text-subtle)",
  text: "var(--app-text)",
  green: "var(--sil-green-dark)",
  red: "var(--sil-red)",
};
