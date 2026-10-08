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
import { probeAudio } from "./probe";

export interface Clip {
  /** File name inside the book's audio folder. */
  file: string;
  label: string;
  kind: ClipKind;
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

/** `onClip` is called after each clip is read. */
export async function scanBook(
  ffmpeg: string,
  bookFolder: string,
  onClip?: () => void,
  files?: string[],
): Promise<Book | null> {
  files ??= await listAudioFiles(bookFolder);
  if (!files.length) return null;
  const htmlPath = await findBookHtml(bookFolder);
  const html = htmlPath ? await fs.readFile(htmlPath, "utf8").catch(() => "") : "";
  const labels = labelClips(html, files);
  const clips = await mapLimit(files, 4, async (file): Promise<Clip> => {
    const full = path.join(bookFolder, "audio", file);
    const [stat, info] = await Promise.all([fs.stat(full), probeAudio(ffmpeg, full)]);
    const l = labels.get(file);
    onClip?.();
    return {
      file,
      label: l?.label ?? file,
      kind: l?.kind ?? "narration",
      bytes: stat.size,
      durationSec: info?.durationSec ?? 0,
      kbps: info?.kbps ?? 0,
      channels: info?.channels ?? 0,
    };
  });
  const order = (c: Clip) => labels.get(c.file)?.order ?? Infinity;
  clips.sort((a, b) => order(a) - order(b) || a.file.localeCompare(b.file));
  return {
    id: path.basename(bookFolder),
    folder: bookFolder,
    title: await readBookTitle(bookFolder),
    clips,
  };
}

/** Every book in the collection that has audio, sorted by title. `onProgress` hears how
 *  many clips have been read out of how many the collection has. */
export async function scanCollection(
  ffmpeg: string,
  folder: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Collection> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(folder, e.name));
  const files = await mapLimit(dirs, 8, listAudioFiles);
  const total = files.reduce((n, f) => n + f.length, 0);
  let done = 0;
  onProgress?.(0, total);
  const onClip = () => onProgress?.(++done, total);
  const books = (
    await mapLimit(dirs, 4, (d) => scanBook(ffmpeg, d, onClip, files[dirs.indexOf(d)]))
  ).filter((b): b is Book => b !== null);
  books.sort((a, b) => a.title.localeCompare(b.title));
  return { folder, name: path.basename(folder), books };
}
