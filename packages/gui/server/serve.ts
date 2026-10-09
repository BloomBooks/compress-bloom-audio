/* Standalone Node HTTP server for the Compress Bloom Audio app — the desktop (Neutralino)
   app's backend sidecar. It serves the built gui frontend (dist/) plus the exact same
   /api/* routes (and SSE) the Vite dev plugin serves, by mounting the shared
   handleApiRequest from apiPlugin.ts. So the GUI runs identically whether opened in the
   desktop window (this server) or in a browser via `vp dev` (the Vite plugin).

   Run:  node server-dist/serve.cjs --port 5191   (see ../package.json "build:server"). */
import * as http from "node:http";
import * as fsn from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { handleApiRequest } from "./apiPlugin";

// The packaged app stages a version.json next to dist/ and server-dist/ (see
// build-installer.mjs); surface it as COMPRESS_BLOOM_AUDIO_VERSION for appVersion.ts. In dev
// the file doesn't exist and appVersion.ts reads packages/app/package.json instead.
if (!process.env.COMPRESS_BLOOM_AUDIO_VERSION) {
  try {
    const v = JSON.parse(
      fsn.readFileSync(path.resolve(__dirname, "..", "version.json"), "utf-8"),
    ) as { version?: string };
    if (v.version) process.env.COMPRESS_BLOOM_AUDIO_VERSION = v.version;
  } catch {
    /* no staged version.json (dev spawn) */
  }
}

function argPort(): number {
  const i = process.argv.indexOf("--port");
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) ? n : NaN;
}
const PORT = argPort() || Number(process.env.COMPRESS_BLOOM_AUDIO_PORT) || 5191;

// The built frontend. Bundled to <gui>/server-dist/serve.cjs, so __dirname is
// <gui>/server-dist and the Vite build output is the sibling ../dist.
const DIST = path.resolve(__dirname, "..", "dist");

function contentTypeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".css":
      return "text/css";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".map":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

/** Serve a file from the built frontend, with an SPA fallback to index.html. */
async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const urlPath = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  let full = path.resolve(DIST, rel);
  // Never escape the dist root.
  if (full !== DIST && !full.startsWith(DIST + path.sep)) {
    res.statusCode = 403;
    return void res.end("Forbidden");
  }
  try {
    if ((await fsp.stat(full)).isDirectory()) full = path.join(full, "index.html");
  } catch {
    // Unknown path → let the SPA router handle it (serve index.html).
    full = path.join(DIST, "index.html");
  }
  try {
    const buf = await fsp.readFile(full);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeFor(path.extname(full)));
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  // /api/* → the shared handler; anything else → static frontend.
  void handleApiRequest(req, res, () => {
    void serveStatic(req, res);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(
    `[compress-bloom-audio] sidecar listening on http://127.0.0.1:${PORT} (serving ${DIST})`,
  );
});
