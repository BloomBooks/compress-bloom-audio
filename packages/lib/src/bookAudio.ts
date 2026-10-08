/* Which audio files a Bloom book has, and what to call each one.

   The audio files themselves come from listing `<book>/audio/` — that list alone is all
   compression needs. The book's .htm is read only to LABEL them: a narration clip's file
   name is the id of the element it was recorded for (`audio/<id>.mp3`), so finding that
   id in the page markup tells us which page it is on. Background music is named instead
   by a `data-backgroundaudio="<file>"` attribute. A file the markup never mentions is one
   Bloom left behind from an earlier recording. If the .htm is missing or unreadable the
   labels fall back to file names and nothing else changes. */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ClipKind = "narration" | "music" | "unused";

export interface ClipLabel {
  label: string;
  kind: ClipKind;
  /** For sorting: position of the first reference in the book, or Infinity. */
  order: number;
}

const AUDIO_EXTENSIONS = new Set([".mp3"]);

/** The audio file names (not paths) in a book's audio folder. */
export async function listAudioFiles(bookFolder: string): Promise<string[]> {
  try {
    const names = await fs.readdir(path.join(bookFolder, "audio"));
    return names.filter((n) => AUDIO_EXTENSIONS.has(path.extname(n).toLowerCase())).sort();
  } catch {
    return [];
  }
}

interface PageStart {
  index: number;
  name: string;
}

const XMATTER_NAMES: Record<string, string> = {
  frontCover: "Front cover",
  credits: "Credits page",
  titlePage: "Title page",
  insideFrontCover: "Inside front cover",
  insideBackCover: "Inside back cover",
  outsideBackCover: "Back cover",
};

function pageName(openTag: string): string {
  const num = /\bdata-page-number="(\d+)"/.exec(openTag)?.[1];
  if (num) return `Page ${num}`;
  const x = /\bdata-xmatter-page="([^"]+)"/.exec(openTag)?.[1];
  if (x) return XMATTER_NAMES[x] ?? x;
  return "Page";
}

function pageStarts(html: string): PageStart[] {
  const out: PageStart[] = [];
  const re = /<div\b[^>]*\bclass="[^"]*\bbloom-page\b[^"]*"[^>]*>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    out.push({ index: m.index, name: pageName(m[0]) });
  }
  return out;
}

function pageAt(pages: PageStart[], index: number): PageStart | undefined {
  let found: PageStart | undefined;
  for (const p of pages) {
    if (p.index > index) break;
    found = p;
  }
  return found;
}

/** First index, at or after `from`, where `needle` appears as a whole attribute value. */
function findAttrValue(html: string, needle: string, from: number): number {
  for (const q of ['"', "'"]) {
    const i = html.indexOf(q + needle + q, from);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Label each audio file from the book's markup. Narration clips become "Page 3 · clip 2"
 * (clips numbered in the order they appear on their page); background music becomes
 * "Page 3 · background music"; files the markup never mentions become "Not used in the book".
 */
export function labelClips(html: string, files: string[]): Map<string, ClipLabel> {
  const pages = pageStarts(html);
  const firstPage = pages[0]?.index ?? 0;
  const found: { file: string; index: number; music: boolean }[] = [];
  const out = new Map<string, ClipLabel>();

  for (const file of files) {
    const id = file.replace(/\.[^.]+$/, "");
    // Search from the first page so the data-div copy of a reference doesn't win.
    let index = findAttrValue(html, id, firstPage);
    let music = false;
    const bg = findAttrValue(html, file, firstPage);
    if (bg >= 0 && html.slice(Math.max(0, bg - 21), bg).endsWith("data-backgroundaudio=")) {
      index = bg;
      music = true;
    }
    if (index < 0 || !pageAt(pages, index)) {
      out.set(file, { label: "Not used in the book", kind: "unused", order: Infinity });
    } else {
      found.push({ file, index, music });
    }
  }

  found.sort((a, b) => a.index - b.index);
  const perPage = new Map<number, number>();
  for (const f of found) {
    const page = pageAt(pages, f.index)!;
    if (f.music) {
      out.set(f.file, { label: `${page.name} · background music`, kind: "music", order: f.index });
      continue;
    }
    const n = (perPage.get(page.index) ?? 0) + 1;
    perPage.set(page.index, n);
    out.set(f.file, { label: `${page.name} · clip ${n}`, kind: "narration", order: f.index });
  }
  return out;
}

/** The book's main .htm: the one named after the folder, else the only/first .htm. */
export async function findBookHtml(bookFolder: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await fs.readdir(bookFolder)).filter((n) => n.toLowerCase().endsWith(".htm"));
  } catch {
    return null;
  }
  const preferred = names.find((n) => n === path.basename(bookFolder) + ".htm") ?? names[0];
  return preferred ? path.join(bookFolder, preferred) : null;
}

/** The book's title from meta.json, else the folder name. */
export async function readBookTitle(bookFolder: string): Promise<string> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(bookFolder, "meta.json"), "utf8"));
    if (typeof meta.title === "string" && meta.title.trim()) return meta.title.trim();
  } catch {
    /* no or bad meta.json */
  }
  return path.basename(bookFolder);
}
