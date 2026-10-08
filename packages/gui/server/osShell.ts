/* Asking the OS to open something, and asking it for a folder. Both spawn a child
   process, so both are written to keep a filename from becoming a command.
   Server-side only. */
import * as path from "node:path";

/**
 * Open a path with the OS: "file" = default app for the type, "folder" = file
 * manager opening that folder, "reveal" = file manager opening the containing folder
 * with the file selected, "vscode" = VS Code. Callers must validate the path (we
 * restrict to workspace / recent folders).
 *
 * On macOS and Linux the command is an argv array with no shell, so a filename holding
 * `$(…)` or a backtick is just a filename rather than something sh would execute.
 * Windows keeps a cmd string: `start` is a cmd builtin and `explorer /select,<path>`
 * wants its path glued to the switch, and cmd.exe has no command substitution to abuse.
 * Callers must still validate the path — this is defence in depth, not the gate.
 */
export async function osOpen(
  target: string,
  mode: "file" | "folder" | "reveal" | "vscode",
): Promise<void> {
  const { spawn } = await import("node:child_process");
  const run = (command: string, args: string[]) =>
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();

  if (process.platform === "win32") {
    // cmd has no way to pass a quote through, so a path containing one can't be opened;
    // dropping it is what this has always done.
    const q = (s: string) => '"' + s.replace(/"/g, "") + '"';
    const cmd =
      mode === "vscode"
        ? `code ${q(target)}`
        : mode === "reveal"
          ? `explorer /select,${q(target)}`
          : mode === "folder"
            ? `explorer ${q(target)}`
            : `start "" ${q(target)}`;
    spawn(cmd, { detached: true, stdio: "ignore", shell: true }).unref();
    return;
  }
  if (mode === "vscode") return run("code", [target]);
  if (process.platform === "darwin") {
    return run("open", mode === "reveal" ? ["-R", target] : [target]);
  }
  // No portable "reveal" on Linux — open the containing directory instead.
  return run("xdg-open", [mode === "reveal" ? path.dirname(target) : target]);
}

/**
 * Show a native OS folder-picker and resolve to the chosen absolute path, or null if
 * the user cancelled. Only used in browser/dev mode (the shipped desktop app shows the
 * dialog through the Neutralino bridge instead — see packages/gui/src/api.ts and
 * packages/app/resources/boot.js). Browser dev is developer-only, so spawning a
 * PowerShell dialog on Windows here is acceptable.
 */
export async function pickFolder(initial?: string): Promise<string | null> {
  const { spawn } = await import("node:child_process");
  let cmd: string;
  let args: string[];
  if (process.platform === "win32") {
    // -STA is required for FolderBrowserDialog; pwsh defaults to MTA. The dialog is
    // spawned by the (background) dev server, so by default it opens BEHIND the browser
    // (Windows won't let a background process foreground a window) — making the button
    // look dead. Fix: parent the dialog to a *visible, on-screen, TopMost* owner form.
    // A background process CAN make its own window topmost (pure z-order, not a
    // foreground change), and an owned dialog renders above its owner — so the dialog
    // lands above the browser. An off-screen owner does NOT work; the owner must be
    // visible and on-screen, so it's centered (the dialog opens over it and covers it).
    // PowerShell 7 (.NET 8) shows the modern Explorer-style picker and can open IN a
    // folder (InitialDirectory). Windows PowerShell 5.1 (.NET Framework) only has the old
    // tree dialog, and given a SelectedPath it often fills in just that one branch, hiding
    // the folder's siblings — so pwsh is tried first.
    const q = initial ? `'${initial.replace(/'/g, "")}'` : "";
    const start = initial
      ? `if ($d.PSObject.Properties['InitialDirectory']) { $d.InitialDirectory = ${q} } else { $d.SelectedPath = ${q} }`
      : "";
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(120, 40)
$owner.FormBorderStyle = 'FixedToolWindow'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Show(); $owner.Activate(); $owner.BringToFront()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose a Bloom collection'
$d.ShowNewFolderButton = $false
${start}
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`;
    cmd = "pwsh";
    args = ["-NoProfile", "-STA", "-Command", ps];
  } else if (process.platform === "darwin") {
    const loc = initial ? ` default location (POSIX file "${initial.replace(/"/g, "")}")` : "";
    cmd = "osascript";
    args = ["-e", `POSIX path of (choose folder with prompt "Choose a Bloom collection"${loc})`];
  } else {
    cmd = "zenity";
    args = ["--file-selection", "--directory", "--title=Choose a Bloom collection"];
    if (initial) args.push(`--filename=${initial.replace(/\/?$/, "/")}`);
  }
  const tryRun = (command: string): Promise<string | null> =>
    new Promise((resolve) => {
      let out = "";
      try {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
        child.stdout.on("data", (b) => (out += b.toString()));
        // Not installed: fall back from pwsh to Windows PowerShell.
        child.on("error", () => resolve(command === "pwsh" ? tryRun("powershell") : null));
        // 'error' (not installed) fires before 'close', so the fallback above wins.
        child.on("close", () => resolve(out.trim() || null));
      } catch {
        resolve(null);
      }
    });
  return tryRun(cmd);
}
