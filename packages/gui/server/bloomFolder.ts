/* Where Bloom keeps its collections: the "Bloom" folder in the user's Documents.
   Server-side only. */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** The real Documents folder on Windows, which is often redirected (into OneDrive, or
 *  elsewhere). Read from the "Personal" user shell folder rather than guessed from the
 *  OneDrive environment variable, which can name a different OneDrive than the one
 *  Documents lives in. */
function windowsDocuments(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
        "/v",
        "Personal",
      ],
      { windowsHide: true },
      (err, stdout) => {
        const m = !err && /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(stdout);
        if (!m) return resolve(null);
        resolve(m[1].trim().replace(/%([^%]+)%/g, (_, v: string) => process.env[v] ?? `%${v}%`));
      },
    );
  });
}

/** The user's Documents\Bloom folder, or null if there isn't one. */
export async function bloomCollectionsFolder(): Promise<string | null> {
  const docs = process.platform === "win32" ? await windowsDocuments() : null;
  const candidates = [
    docs && path.join(docs, "Bloom"),
    path.join(os.homedir(), "Documents", "Bloom"),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    try {
      if ((await fs.stat(p)).isDirectory()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}
