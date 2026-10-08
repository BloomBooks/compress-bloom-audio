/* The Compress Bloom Audio API: /api/* routes plus an SSE stream at /api/events. */
import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import {
  addClient,
  clipFile,
  ensureFfmpeg,
  getState,
  openCollection,
  preview,
  restore,
  startCompress,
  stopCompress,
} from "./engine";
import { getSettings, saveSettings, type Settings } from "./settings";
import { pickFolder } from "./osShell";
import { getAppVersion } from "./appVersion";
import { bloomCollectionsFolder } from "./bloomFolder";

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

/** The loopback names this API is willing to be reached under. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Why this request must not be served, or undefined if it may proceed.
 *
 * The API binds to loopback and has no authentication, on the reasoning that only this
 * machine can reach it — but any web page the user has open is also "this machine", and
 * this API overwrites files in Bloom books. So:
 *
 * - An `Origin` that isn't loopback is another site driving us: refuse.
 * - A `Host` that isn't loopback means we were reached under a hostname that resolves
 *   here — DNS rebinding, which is how a remote page gets a same-origin foothold.
 */
function rejectionReason(req: IncomingMessage): string | undefined {
  const host = (req.headers.host ?? "").toLowerCase();
  // Strip the port, keeping a bracketed IPv6 literal intact.
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return `this API only answers on localhost (got Host: ${req.headers.host ?? "(none)"})`;
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return "the request carried an Origin header we couldn't read";
    }
    if (!LOOPBACK_HOSTS.has(originHost)) {
      return `requests from ${origin} aren't allowed — this API serves only local pages`;
    }
  }
  return undefined;
}

/** Stream an mp3 with Range support, so the <audio> element can seek. */
async function serveAudio(req: IncomingMessage, res: ServerResponse, file: string) {
  const size = (await fsp.stat(file)).size;
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Length", String(size));
  fs.createReadStream(file).pipe(res);
}

const PRESETS = new Set<Settings["preset"]>(["speech", "balanced", "high", "custom"]);

/**
 * The API request handler, written as a connect-style middleware: it handles any `/api/*`
 * request and calls `next()` for everything else. Both the Vite dev plugin
 * ([apiDevPlugin.ts]) and the standalone sidecar ([serve.ts]) mount this same function.
 */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
): Promise<unknown> {
  const url = req.url || "";
  if (!url.startsWith("/api/")) return next();
  // One gate for every route below, including the SSE stream.
  const rejection = rejectionReason(req);
  if (rejection) return send(res, 403, { error: rejection });

  const u = new URL(url, "http://localhost");
  const p = u.pathname;
  const method = (req.method || "GET").toUpperCase();

  try {
    // Readiness probe, used by the desktop boot page.
    if (p === "/api/health" && method === "GET") return send(res, 200, { ok: true });

    if (p === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const unsub = addClient((event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      });
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => {
        clearInterval(heartbeat);
        unsub();
      });
      return;
    }

    if (p === "/api/startup" && method === "GET") {
      // First load: find ffmpeg, and reopen the last collection if there is one.
      const settings = await getSettings();
      const ffmpeg = await ensureFfmpeg();
      if (ffmpeg && settings.collection && !getState().collection && getState().phase === "idle") {
        await openCollection(settings.collection).catch(() => {});
      }
      return send(res, 200, {
        settings,
        version: await getAppVersion(),
        bloomFolder: await bloomCollectionsFolder(),
        state: getState(),
      });
    }

    if (p === "/api/settings" && method === "POST") {
      const b = await readBody(req);
      const patch: Partial<Settings> = {};
      if (PRESETS.has(b.preset)) patch.preset = b.preset;
      if (typeof b.kbps === "number" && b.kbps >= 8 && b.kbps <= 320)
        patch.kbps = Math.round(b.kbps);

      return send(res, 200, await saveSettings(patch));
    }

    if (p === "/api/collection" && method === "POST") {
      const b = await readBody(req);
      const folder = String(b.folder || "");
      if (!folder) return send(res, 400, { error: "folder required" });
      await openCollection(folder);
      await saveSettings({ collection: folder });
      return send(res, 200, { ok: true });
    }

    // Native folder picker for plain-browser dev; the desktop app uses the shell bridge.
    if (p === "/api/pick-folder" && method === "POST") {
      const b = await readBody(req);
      return send(res, 200, {
        path: await pickFolder(typeof b.initial === "string" ? b.initial : undefined),
      });
    }

    if (p === "/api/compress" && method === "POST") {
      const b = await readBody(req);
      const ids = Array.isArray(b.bookIds) ? b.bookIds.map(String) : [];
      const kbps = Number(b.kbps);
      if (!ids.length || !(kbps >= 8 && kbps <= 320))
        return send(res, 400, { error: "bookIds and kbps required" });
      await startCompress(ids, kbps);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/stop" && method === "POST") {
      stopCompress();
      return send(res, 200, { ok: true });
    }
    if (p === "/api/preview" && method === "POST") {
      const b = await readBody(req);
      const kbps = Number(b.kbps);
      if (!(kbps >= 8 && kbps <= 320)) return send(res, 400, { error: "kbps required" });
      await preview(String(b.book ?? ""), String(b.file ?? ""), kbps);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/restore" && method === "POST") {
      await restore();
      return send(res, 200, { ok: true });
    }

    if (p === "/api/audio" && method === "GET") {
      const w = u.searchParams.get("which");
      const which = w === "after" || w === "preview" ? w : "before";
      // clipFile only answers for a book and file the scan found, so these query
      // values can't name an arbitrary path.
      const file = clipFile(
        u.searchParams.get("book") ?? "",
        u.searchParams.get("file") ?? "",
        which,
        Number(u.searchParams.get("kbps")),
      );
      if (!file) return send(res, 404, { error: "no such clip" });
      return await serveAudio(req, res, file);
    }
    return send(res, 404, { error: "not found", path: p });
  } catch (e: any) {
    return send(res, 409, { error: e?.message || String(e) });
  }
}

/* The Vite plugin that mounts `handleApiRequest` on the dev server lives in
   `apiDevPlugin.ts`, NOT here. It has to be reachable from `vite.config.ts` without
   dragging this module (and so `@compress-bloom-audio/lib`) into the config bundle, where
   the lib would resolve to its built dist and a stale dist would stop the dev server
   booting. That file's header has the full story; don't move the plugin back. */
