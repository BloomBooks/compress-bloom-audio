/* Scanning a Bloom collection for the audio in each of its books. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  findBookHtml,
  labelClips,
  listAudioFiles,
  readBookTitle,
  type ClipKind,
} from "./bookAudio";
import { probeAudio, type Codec } from "./probe";

export interface Clip {
  /** File name inside the book's audio folder. */
  file: string;
  label: string;
  kind: ClipKind;
  codec: Codec;
  bytes: number;
  durationSec: number;
  kbps: number;
  channels: number;
}

export interface Book {
  /** The book's folder name — unique within its collection, so it doubles as the id. */
  id: string;
  folder: string;
  title: string;
  clips: Clip[];
  /** False while the book is only listed: its clips have their file names and sizes, but
   *  no labels, bitrates or durations yet. */
  read: boolean;
}

export interface Collection {
  folder: string;
  name: string;
  books: Book[];
}

/** True when `folder` holds a `.bloomCollection` file. */
export async function isBloomCollection(folder: string): Promise<boolean> {
  try {
    return (await fs.readdir(folder)).some((n) => n.toLowerCase().endsWith(".bloomcollection"));
  } catch {
    return false;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A book's audio files and their sizes, without reading the files or the book's page
 *  markup. Null when the book has no audio. */
export async function listBook(bookFolder: string): Promise<Book | null> {
  const files = await listAudioFiles(bookFolder);
  if (!files.length) return null;
  const clips = await mapLimit(files, 8, async (file): Promise<Clip> => {
    const { size } = await fs.stat(path.join(bookFolder, "audio", file));
    return {
      file,
      label: file,
      kind: "narration",
      codec: "mp3",
      bytes: size,
      durationSec: 0,
      kbps: 0,
      channels: 0,
    };
  });
  return {
    id: path.basename(bookFolder),
    folder: bookFolder,
    title: await readBookTitle(bookFolder),
    clips,
    read: false,
  };
}

/** Fill in a listed book: label its clips from the page markup, read each clip's bitrate,
 *  channels and duration, and put the clips in reading order. `onClip` is called after
 *  each clip is read. */
export async function readBook(ffmpeg: string, book: Book, onClip?: () => void): Promise<Book> {
  const files = book.clips.map((c) => c.file);
  const htmlPath = await findBookHtml(book.folder);
  const html = htmlPath ? await fs.readFile(htmlPath, "utf8").catch(() => "") : "";
  const labels = labelClips(html, files);
  const clips = await mapLimit(files, 4, async (file): Promise<Clip> => {
    const full = path.join(book.folder, "audio", file);
    const [stat, info] = await Promise.all([fs.stat(full), probeAudio(ffmpeg, full)]);
    const l = labels.get(file);
    onClip?.();
    return {
      file,
      label: l?.label ?? file,
      kind: l?.kind ?? "narration",
      codec: info?.codec ?? "mp3",
      bytes: stat.size,
      durationSec: info?.durationSec ?? 0,
      kbps: info?.kbps ?? 0,
      channels: info?.channels ?? 0,
    };
  });
  const order = (c: Clip) => labels.get(c.file)?.order ?? Infinity;
  clips.sort((a, b) => order(a) - order(b) || a.file.localeCompare(b.file));
  return { ...book, clips, read: true };
}

/** List a book, then read it. */
export async function scanBook(
  ffmpeg: string,
  bookFolder: string,
  onClip?: () => void,
): Promise<Book | null> {
  const book = await listBook(bookFolder);
  return book && readBook(ffmpeg, book, onClip);
}

/** Every book in the collection that has audio, sorted by title, listed but not read. */
export async function listCollection(folder: string): Promise<Collection> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(folder, e.name));
  const books = (await mapLimit(dirs, 8, listBook)).filter((b): b is Book => b !== null);
  books.sort((a, b) => a.title.localeCompare(b.title));
  return { folder, name: path.basename(folder), books };
}

/** Every book in the collection that has audio, sorted by title, and read. `onProgress`
 *  hears how many clips have been read out of how many the collection has. */
export async function scanCollection(
  ffmpeg: string,
  folder: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Collection> {
  const c = await listCollection(folder);
  const total = c.books.reduce((n, b) => n + b.clips.length, 0);
  let done = 0;
  onProgress?.(0, total);
  const books = await mapLimit(c.books, 4, (b) =>
    readBook(ffmpeg, b, () => onProgress?.(++done, total)),
  );
  return { ...c, books };
}
