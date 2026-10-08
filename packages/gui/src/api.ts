/* Typed client for the server API, plus the bridge to the desktop shell. */

export type Phase = "idle" | "scanning" | "running" | "restoring";
export type ClipStatus = "pending" | "running" | "done" | "skipped" | "failed";
export type ClipKind = "narration" | "music" | "unused";

export interface Clip {
  file: string;
  label: string;
  kind: ClipKind;
  /** What is in the book now. */
  bytes: number;
  durationSec: number;
  kbps: number;
  channels: number;
  /** The original we keep, when this clip has been compressed by this app. */
  original?: { bytes: number; kbps: number; currentKbps: number };
}
export interface Book {
  id: string;
  folder: string;
  title: string;
  clips: Clip[];
  /** False while only listed: clips have file names and sizes, nothing else yet. */
  read: boolean;
  /** Why the book couldn't be read. */
  error?: string;
}
export interface Collection {
  folder: string;
  name: string;
  books: Book[];
}
export interface ClipState {
  status: ClipStatus;
  progress: number;
  afterBytes?: number;
  error?: string;
}
export interface EngineState {
  phase: Phase;
  ffmpeg: string | null;
  collection: Collection | null;
  clips: Record<string, ClipState>;
  job: { bookIds: string[]; kbps: number } | null;
  stopped: boolean;
  restorableBookIds: string[];
  previews: Record<string, number>;
  encoding: string | null;
  lastCompress: {
    kbps: number;
    books: number;
    savedBytes: number;
    stopped: boolean;
    bookIds: string[];
    jobBookIds: string[];
    finishedAt: string;
  } | null;
  scanProgress: { folder: string; done: number; total: number } | null;
  lastRestore: {
    restoredBooks: number;
    restoredClips: number;
    changedSince: { title: string; file: string }[];
  } | null;
  error: string | null;
}
export type Preset = "speech" | "balanced" | "high" | "custom";
export interface Settings {
  collection: string;
  preset: Preset;
  kbps: number;
}
async function parseOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-json */
  }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data as T;
}
async function post<T = { ok: true }>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return parseOrThrow<T>(res);
}

/** True when we're embedded in the Neutralino desktop shell's <iframe> (vs. running as a
 *  top-level page in a plain browser during dev). The shell can reach native OS dialogs;
 *  we can't from here, so we ask it via postMessage. */
export const inDesktopShell = (): boolean => {
  try {
    return window.parent !== window;
  } catch {
    return true; // cross-origin parent access threw → we're embedded
  }
};

let shellSeq = 0;

/** Ask the Neutralino shell (parent frame) to do something only native code can reach,
 *  and resolve to its reply. The shell ACKs receipt immediately; if no ACK arrives
 *  quickly the bridge isn't there, so we reject and let the caller fall back. Once ACKed
 *  we wait indefinitely — the request may put a modal OS dialog on screen. Replies come
 *  back as `<type>:ack` / `<type>:result`. See packages/app/resources/boot.js. */
function askShell<T>(
  type: string,
  payload: Record<string, unknown>,
  readReply: (d: any) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++shellSeq;
    let acked = false;
    const ackTimer = window.setTimeout(() => {
      if (acked) return;
      window.removeEventListener("message", onMsg);
      reject(new Error(`${type} bridge unavailable`));
    }, 2000);
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.source !== "compress-bloom-audio" || d.id !== id) return;
      if (d.type === `${type}:ack`) {
        acked = true;
        window.clearTimeout(ackTimer);
        return;
      }
      if (d.type === `${type}:result`) {
        window.removeEventListener("message", onMsg);
        resolve(readReply(d));
      }
    };
    window.addEventListener("message", onMsg);
    // The parent is on Neutralino's origin (unknown to us here), so target "*"; these
    // requests are benign and the parent validates our origin before acting.
    window.parent.postMessage({ source: "compress-bloom-audio", type, id, ...payload }, "*");
  });
}

/** Show a native folder dialog; resolves to the chosen path, or null if cancelled. */
export async function pickFolder(initial?: string): Promise<string | null> {
  if (inDesktopShell()) {
    try {
      return await askShell("pickFolder", { initial }, (d) =>
        typeof d.path === "string" && d.path ? d.path : null,
      );
    } catch {
      /* bridge unavailable — fall through to the server picker */
    }
  }
  // Plain browser (dev): the Node backend pops the OS folder dialog for us.
  return (await post<{ path: string | null }>("/api/pick-folder", { initial })).path;
}

export const api = {
  startup: async () =>
    parseOrThrow<{
      settings: Settings;
      version: string;
      /** Documents\Bloom, where Bloom keeps collections; the folder picker opens there. */
      bloomFolder: string | null;
      state: EngineState;
    }>(await fetch("/api/startup")),
  saveSettings: (patch: Partial<Settings>) => post<Settings>("/api/settings", patch),
  openCollection: (folder: string) => post("/api/collection", { folder }),
  compress: (bookIds: string[], kbps: number) => post("/api/compress", { bookIds, kbps }),
  stop: () => post("/api/stop"),
  preview: (book: string, file: string, kbps: number) => post("/api/preview", { book, file, kbps }),
  restore: () => post("/api/restore"),
  /** Dev server only: swap in the changed server code now, abandoning the running job. */
  devReload: () => post("/api/dev-reload"),
  audioUrl: (
    book: string,
    file: string,
    which: "original" | "current" | "after" | "preview",
    kbps: number,
  ) => `/api/audio?${new URLSearchParams({ book, file, which, kbps: String(kbps) })}`,
};
/** Subscribe to the server's state snapshots. Returns an unsubscribe function. */
/** Subscribe to the server's state snapshots. `onReloadPending` hears from the dev server
 *  when it is holding back a code reload until the running job finishes. */
export function subscribeState(
  onState: (s: EngineState) => void,
  onReloadPending?: (pending: boolean) => void,
): () => void {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => onState(JSON.parse((e as MessageEvent).data)));
  // The dev server asks for a reload when its server code was swapped (apiDevPlugin.ts).
  es.addEventListener("dev-reload", (e) => {
    const d = JSON.parse((e as MessageEvent).data);
    if (d.reload) window.location.reload();
    else onReloadPending?.(!!d.pending);
  });
  return () => es.close();
}
