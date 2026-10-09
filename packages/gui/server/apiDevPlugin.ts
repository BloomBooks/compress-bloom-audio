/* The Vite plugin that mounts the Compress Bloom Audio API on the dev server.
   Deliberately its own file, and deliberately importing NOTHING from `apiPlugin.ts` or
   `@compress-bloom-audio/lib` as a value.

   Why the separation is load-bearing: `vite.config.ts` imports this at config-load time, and
   Vite BUNDLES a config's relative imports while leaving bare specifiers external. So when the
   config reached the API handler through a static `import`, it dragged `apiPlugin.ts` — and
   through it `@compress-bloom-audio/lib` — into the config bundle, where the bare specifier resolved to
   the lib's built **dist**. `resolve.alias` does not help: it governs modules the dev server
   pulls through its SSR graph, which does not exist yet when the config is being loaded.

   The consequence was a bad one to debug. Adding any new export to the lib and importing it as
   a value from server code stopped the dev server booting until someone ran `pnpm build:lib`,
   and the error blamed the wrong file:

     failed to load config from packages/gui/vite.config.ts
     The requested module '.../lib/dist/index.mjs' does not provide an export named 'X'

   It then restart-looped on every save and exited 255, root `vp test run` failed identically
   (the gui test project loads the same config), and the desktop app — whose dev mode points its
   iframe at this server — silently fell back to its built sidecar.


   So: keep this file's imports type-only. `import type` is erased before bundling, so nothing
   here resolves the lib at config-load time, and a stale `dist` can no longer stop the dev
   server from starting. */

import type { Plugin, ViteDevServer } from "vite";
// Type-only, and it must stay that way — see the header. `typeof handleApiRequest` keeps these
// signatures tied to the real exports without creating a value edge to their modules.
import type { handleApiRequest } from "./apiPlugin";
import type { isEngineBusy, broadcast } from "./engine";

/**
 * One generation of the server, held as the PAIR of modules we need.
 *
 * Two loads, not one, because `handleApiRequest` lives in `apiPlugin.ts` while `isEngineBusy`
 * and `broadcast` live in `engine.ts`, and `apiPlugin.ts` does not re-export them. Reading
 * them off the api module alone yields `undefined`, and `undefined()` throws — which the
 * busy-check's `catch` then read as "idle", so the gate swapped on every single change and
 * did exactly nothing. Cost an hour; hence this comment.
 *
 * Loading both through the same SSR graph is what keeps them consistent: `apiPlugin.ts`
 * imports `./engine`, so Vite hands out one evaluated `engine.ts` per generation and the
 * counters we consult are the ones the running job is incrementing.
 */
interface ServerGeneration {
  handleApiRequest: typeof handleApiRequest;
  isEngineBusy: typeof isEngineBusy;
  broadcast: typeof broadcast;
}

/**
 * The API module requests are being served from, whether the source behind it has changed
 * since we loaded it, and whether the user has been told.
 *
 * Why this exists: in dev the handler is re-evaluated on source change, and each
 * re-evaluation is a NEW copy of the engine module — new `runs` map, new counters, new SSE
 * clients. A job already compressing keeps running inside the OLD copy, unreachable
 * from the new one, so the run silently disappears from the UI mid-book. Losing a long
 * compression job because a teammate (or an agent) saved a file is not an acceptable dev loop.
 *
 * So while the engine is busy we keep serving the module that owns the in-flight run and
 * stash the fact that a reload is pending; the GUI shows a toast with a Restart button. Once
 * the queue drains we pick the new code up on the next request without being asked, which is
 * why the toast is rare in practice — it only appears if you edit DURING a compression job.
 *
 * The gate is "do we CALL `ssrLoadModule`", not "compare what it returned". Calling it is
 * what performs the swap, and measurement killed the tidier-looking alternative: after Vite
 * logs `(ssr) page reload server/apiPlugin.ts` the next `ssrLoadModule` hands back an object
 * that is `===` the previous one, so identity can't detect a re-evaluation at all. Hence the
 * watcher-driven `dirty` flag: it tells us a change is waiting WITHOUT us having to load it.
 *
 * Only the SERVER swap is gated. React HMR is untouched and keeps working normally, so the
 * UI can briefly be newer than the engine behind it — the right trade, since a stale button
 * costs a click and a lost job costs the time it took.
 */
let pinned: ServerGeneration | undefined;
/** A watched source file changed since `pinned` was loaded, so a swap is owed. */
let dirty = false;
/** We've told the GUI a swap is being held back (so the toast is raised once, not per request). */
let reloadPending = false;

/**
 * Which changed files mean the server code behind `pinned` is stale: this package's own
 * server directory, and the lib's source (aliased to source in dev, so the engine's real
 * behaviour lives there). A change to the React client is irrelevant — that hot-reloads on
 * its own and never touches a running job, so it must NOT raise the toast.
 */
function affectsServer(file: string): boolean {
  const p = file.replace(/\\/g, "/");
  return /\/packages\/gui\/server\//.test(p) || /\/packages\/lib\/src\//.test(p);
}

/**
 * Mount the shared API handler on the dev server's connect middleware stack (+ the SSE
 * stream at /api/events). Used by the web GUI (`vp dev`), and by the desktop app in dev,
 * which points its window at this server rather than at the built sidecar.
 *
 * The handler is loaded through Vite's SSR graph on every request rather than imported.
 * A static import would resolve `@compress-bloom-audio/lib` to the built dist once and Node would
 * cache it for the life of the process, so a lib edit would never take effect without a
 * restart. `ssrLoadModule` re-evaluates the handler (and its lib import, aliased to source
 * in vite.config) whenever the source changes: editing the engine is live. Vite
 * caches the module between edits, so this only re-runs when something actually changed.
 */
export function compressApiPlugin(): Plugin {
  return {
    name: "compress-bloom-audio-api",
    configureServer(server: ViteDevServer) {
      /* Adopt a newly-evaluated module, telling the page to reload as we go.
         The reload is not cosmetic. SSE clients register themselves in the module that
         served `/api/events` (engine.ts's own `clients` set), so once we point at a new
         instance the open event stream belongs to an instance nothing broadcasts through
         any more: the connection stays up, the UI just stops receiving run updates and
         looks frozen. A page reload re-opens the stream against the live module. The
         message therefore goes out on the OUTGOING module — that is where the clients
         still are — before the pin moves. */
      const swapTo = (fresh: ServerGeneration) => {
        const outgoing = pinned;
        pinned = fresh;
        dirty = false;
        reloadPending = false;
        // EVERY swap must tell the page to reload, not just a deferred one. This used
        // to skip the ordinary path on the assumption that "Vite's own client already
        // reloads" for a server-module change — measured false: lib/engine edits live
        // only in the SSR graph, no full-reload reaches the webview, and every open
        // window keeps an SSE stream registered in the outgoing module's engine. The
        // result was the worst failure shape we have: a UI that looks fine and never
        // updates again (a job "running" forever after it finished).
        // A redundant reload on paths where Vite does also reload costs a flicker.
        if (!outgoing) return;
        try {
          outgoing.broadcast("dev-reload", { pending: false, reload: true });
        } catch {
          /* no clients, or the outgoing module is no longer usable */
        }
      };

      /* The watcher is the only thing that can tell us a change is waiting without us
         loading it — see the `dirty` comment at the top of this file. */
      for (const event of ["change", "add", "unlink"] as const) {
        server.watcher.on(event, (file: string) => {
          if (affectsServer(file)) dirty = true;
        });
      }

      /* The one place the module is chosen. `ssrLoadModule` is cheap when nothing changed
         (Vite caches), so calling it per request is how a lib/engine edit goes live without
         a restart — and gating it here is how an in-flight job survives one. */
      const load = async (): Promise<ServerGeneration> => {
        const api = (await server.ssrLoadModule("/server/apiPlugin.ts")) as Pick<
          ServerGeneration,
          "handleApiRequest"
        >;
        const engine = (await server.ssrLoadModule("/server/engine.ts")) as Pick<
          ServerGeneration,
          "isEngineBusy" | "broadcast"
        >;
        return { ...api, ...engine };
      };

      const currentModule = async (): Promise<ServerGeneration> => {
        if (!pinned) {
          pinned = await load();
          dirty = false;
          return pinned;
        }
        // Nothing changed: return what we have WITHOUT calling ssrLoadModule, since that
        // call is the swap. (It would be cheap, but "cheap" is not "harmless" here.)
        if (!dirty) return pinned;

        // Ask the PINNED module, the one that actually owns the running job. A fresh
        // copy's counters start at zero, so asking it would always answer "idle" and defeat
        // the whole gate.
        // Fail to "busy", not to "idle". Guessing idle discards a job; guessing busy
        // costs a click on the toast. The warning is not decoration — the original version of
        // this defaulted the other way, so a wiring mistake silently disabled the whole gate
        // and every test of it passed.
        let busy = true;
        try {
          busy = pinned.isEngineBusy();
        } catch (err) {
          server.config.logger.warn(
            `[compress-bloom-audio] could not ask the engine whether it is busy (${String(err)}); ` +
              "holding the reload back. The Restart button still works.",
          );
        }
        if (!busy) {
          swapTo(await load());
          return pinned;
        }

        if (!reloadPending) {
          reloadPending = true;
          server.config.logger.info(
            "[compress-bloom-audio] server code changed during a compression job — still serving the " +
              "running one; reload is deferred until it finishes or you click Restart.",
          );
          try {
            pinned.broadcast("dev-reload", { pending: true });
          } catch {
            /* no clients listening */
          }
        }
        return pinned;
      };

      server.middlewares.use(async (req, res, next) => {
        try {
          /* The Restart button. Handled here rather than in the API handler because it has
             to act on the PLUGIN's pin, which the handler's module can't reach — and because
             a request served by the module being replaced can't be the one to replace it. */
          if (req.url?.startsWith("/api/dev-reload") && req.method === "POST") {
            reloadPending = true; // so swapTo knows the page is behind and must reload
            swapTo(await load());
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.url?.startsWith("/api/dev-reload") && req.method === "GET") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ pending: reloadPending }));
            return;
          }
          const mod = await currentModule();
          await mod.handleApiRequest(req, res, next);
        } catch (err) {
          server.ssrFixStacktrace(err as Error);
          next(err);
        }
      });
    },
  };
}
