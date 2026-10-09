/* Auto-updater for the Bloom Audio Compressor desktop app.
 *
 * Why not Neutralino's built-in updater? `Neutralino.updater` only swaps the
 * `resources.neu` bundle (the small web frontend on this page). It does NOT touch the
 * bundled node.exe sidecar or the `app/` directory (the GUI + @compress-bloom-audio/lib), which
 * is the bulk of Bloom Audio Compressor. So it can't update this app.
 *
 * Instead it reads this repo's GitHub Releases. The repo is public, so the releases API
 * answers an unauthenticated caller and the installer asset downloads without a token.
 * release.yml publishes each release with BloomAudioCompressor-Setup-<version>.exe
 * attached, tagged app-v<version>. This module:
 *   1. asks the API for the latest release,
 *   2. compares its tag to the running version (NL_APPVERSION),
 *   3. if newer, asks the user, downloads the installer, runs it, and quits.
 * The unauthenticated API allows 60 requests an hour per IP address; one check per
 * launch stays far below that, and a refusal is just another error the check swallows.
 * The installer upgrades in place (stable AppId GUID) and relaunches the app
 * (RestartApplications in the .iss).
 *
 * Loaded before boot.js; boot.js calls window.CompressBloomAudioUpdater.check() once the app
 * is visible. All failures are non-fatal — the app keeps running on any error.
 */
(function () {
  // The GitHub API's "latest release" endpoint for this repo. Overridable via the
  // UPDATE_URL global in neutralino.config.json (exposed as NL_UPDATE_URL) — point it at
  // a fork's releases to rehearse an update.
  const CHANNEL_URL =
    typeof NL_UPDATE_URL === "string" && NL_UPDATE_URL
      ? NL_UPDATE_URL
      : "https://api.github.com/repos/BloomBooks/compress-bloom-audio/releases/latest";
  const INSTALLER_RE = /BloomAudioCompressor-Setup-.*\.exe$/i;

  function ulog(msg) {
    try {
      Neutralino.debug.log(`[compress-bloom-audio updater] ${msg}`);
    } catch {
      /* debug.log unavailable */
    }
  }

  /** True only in a `neu build --release` bundle — we never trigger updates in dev. */
  function isBundled() {
    return typeof NL_RESMODE !== "undefined" && NL_RESMODE === "bundle";
  }

  function currentVersion() {
    return typeof NL_APPVERSION === "string" ? NL_APPVERSION : "0.0.0";
  }

  /** Parse "1.2.3" → [1,2,3]; ignores any "-prerelease" suffix (we're pre-stable 0.x). */
  function parseVer(v) {
    return String(v)
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  }

  /** Returns >0 if a is newer than b, <0 if older, 0 if equal. */
  function cmpVer(a, b) {
    const pa = parseVer(a);
    const pb = parseVer(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  /* --- small non-blocking toast over the running app --- */
  function toast(msg) {
    let el = document.getElementById("updateToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "updateToast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
    return el;
  }
  function clearToast() {
    const el = document.getElementById("updateToast");
    if (el) el.remove();
  }

  /* --- LOCAL TEST CHANNEL (off by default) ----------------------------------
   * If the file <dataDir>/BloomAudioCompressor/update-source.txt exists and contains a
   * directory path, the updater treats that directory as the release channel instead
   * of GitHub: it picks the highest-versioned BloomAudioCompressor-Setup-*.exe in it, skips the
   * download (runs it in place) and skips the confirmation prompt. This lets the whole
   * update flow (launch installer → kill sidecar → overwrite-in-place → relaunch) run
   * with no network, no release tag, and no user input.
   *
   * It is a ONE-SHOT trigger: the sentinel file is deleted the moment we commit to
   * installing, so the relaunched app falls back to the normal GitHub channel and
   * doesn't loop. Inert unless the sentinel file is present. */
  async function sentinelPath() {
    const dataDir = await Neutralino.os.getPath("data");
    return `${dataDir}/BloomAudioCompressor/update-source.txt`;
  }

  async function localUpdateDir() {
    try {
      const raw = await Neutralino.filesystem.readFile(await sentinelPath());
      return String(raw).trim();
    } catch {
      return ""; // no sentinel → normal GitHub channel
    }
  }

  async function findLatestLocalRelease(dir) {
    const entries = await Neutralino.filesystem.readDirectory(dir);
    let best = null;
    for (const e of entries) {
      if (e.type !== "FILE" || !INSTALLER_RE.test(e.entry)) continue;
      const m = /BloomAudioCompressor-Setup-(.+)\.exe$/i.exec(e.entry);
      const version = m ? m[1] : "0.0.0";
      if (!best || cmpVer(version, best.version) > 0) {
        best = { version, name: e.entry, localPath: `${dir}/${e.entry}` };
      }
    }
    return best;
  }

  /**
   * The newest published version, from the latest GitHub release.
   * Returns { version, downloadUrl, name } (or { version, localPath, name } for the
   * local test channel), or null when the release has no installer attached.
   */
  async function findLatestRelease() {
    const localDir = await localUpdateDir();
    if (localDir) {
      ulog(`LOCAL update channel: ${localDir}`);
      return findLatestLocalRelease(localDir);
    }
    const res = await fetch(CHANNEL_URL, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} (${CHANNEL_URL})`);
    const rel = await res.json();
    const tag = String((rel && rel.tag_name) || "");
    if (!tag.startsWith("app-v")) {
      ulog(`latest release tag isn't an app release: ${tag}`);
      return null;
    }
    // A release whose installer upload failed, or that someone made by hand, shouldn't send
    // us downloading something that isn't an installer.
    const asset = (rel.assets || []).find((a) => INSTALLER_RE.test(a.name));
    if (!asset) {
      ulog(`release ${tag} has no installer attached`);
      return null;
    }
    return {
      version: tag.replace(/^app-v/, ""),
      downloadUrl: asset.browser_download_url,
      name: asset.name,
    };
  }

  /** Quote a string for use inside a single-quoted PowerShell literal. */
  function psQuote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
  }

  /** Download the installer to the temp dir via PowerShell. Returns the local path. */
  async function downloadInstaller(rel) {
    // Local test channel: the installer is already on disk — consume the one-shot
    // sentinel (so the relaunched app won't re-trigger) and run it in place.
    if (rel.localPath) {
      try {
        await Neutralino.filesystem.remove(await sentinelPath());
      } catch {
        /* sentinel already gone — fine */
      }
      const local = rel.localPath.replace(/\//g, "\\");
      ulog(`using local installer (no download): ${local}`);
      return local;
    }
    // getPath("temp") returns a forward-slash path on Windows. Normalize to
    // backslashes: the launch step hands this path to the OS to execute, and the
    // Windows process/shell layer does NOT reliably accept forward-slash separators
    // (you get "Windows cannot find <path>"). Invoke-WebRequest (.NET) is happy with
    // backslashes too, so we use them consistently from download on.
    const tempDir = await Neutralino.os.getPath("temp");
    const dest = `${tempDir}/${rel.name}`.replace(/\//g, "\\");
    const cmd =
      `powershell -NoProfile -NonInteractive -Command ` +
      `"$ProgressPreference='SilentlyContinue'; ` +
      `Invoke-WebRequest -Uri ${psQuote(rel.downloadUrl)} -OutFile ${psQuote(dest)}"`;
    // Retry a few times with a short backoff: the download can hit a transient
    // DNS/connection blip even right after the release-check API call succeeded
    // (we've seen "the remote name could not be resolved: 'github.com'"). One bad
    // moment shouldn't abandon the whole update.
    let lastErr = "download failed";
    for (let attempt = 1; attempt <= 3; attempt++) {
      ulog(`downloading (attempt ${attempt}/3) ${rel.downloadUrl} -> ${dest}`);
      const out = await Neutralino.os.execCommand(cmd);
      if (out.exitCode === 0) return dest;
      lastErr = `download failed (exit ${out.exitCode}): ${out.stdErr || out.stdOut}`;
      ulog(lastErr);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(lastErr);
  }

  /** Launch the installer detached and quit so it can replace files. */
  async function runInstallerAndExit(installerPath) {
    ulog(`launching installer: ${installerPath}`);
    // Run the installer directly — no shell wrapper. `background: true` resolves the
    // Promise immediately, and the spawned process isn't tracked by Neutralino (unlike
    // spawnProcess), so it keeps running after we exit and can replace our files.
    // The path has spaces (…\AppData\Local\Temp\…), so wrap it in double quotes.
    // /VERYSILENT runs with no window or button clicks (the user already consented via
    // the update prompt); /SUPPRESSMSGBOXES auto-answers the Restart-Manager close
    // prompt; /NORESTART means it never reboots the machine. The .iss [Run] entry
    // relaunches Bloom Audio Compressor afterward (skipifsilent removed so this still fires).
    const flags = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART";
    await Neutralino.os.execCommand(`"${installerPath}" ${flags}`, { background: true });
    // Quit via boot.js's shutdown so the node sidecar is killed too — otherwise it
    // stays alive holding file locks in the install dir and the installer can only
    // proceed by having the Restart Manager force-kill it. Fall back to a bare exit
    // if the hook isn't present (e.g. boot.js changed).
    if (typeof window.CompressBloomAudioShutdown === "function") {
      await window.CompressBloomAudioShutdown();
    } else {
      await Neutralino.app.exit();
    }
  }

  /**
   * Check for updates and, if the user agrees, download + install. Safe to call always:
   * it no-ops in dev mode and swallows every error (logs only) so it can never break
   * the running app.
   */
  async function check() {
    if (!isBundled()) {
      ulog("dev mode — skipping update check");
      return;
    }
    try {
      const current = currentVersion();
      const rel = await findLatestRelease();
      if (!rel) {
        ulog("update channel named no installer");
        return;
      }
      if (cmpVer(rel.version, current) <= 0) {
        ulog(`up to date (current ${current}, latest ${rel.version})`);
        return;
      }
      ulog(`update available: ${current} -> ${rel.version}`);

      // The local test channel runs unattended — skip the confirmation dialog (it's
      // itself user input). The normal GitHub channel always asks first.
      if (!rel.localPath) {
        const answer = await Neutralino.os.showMessageBox(
          "Update available",
          `Bloom Audio Compressor ${rel.version} is available (you have ${current}).\n\n` +
            `Download and install it now? Bloom Audio Compressor will close to update, then reopen.`,
          "YES_NO",
          "QUESTION",
        );
        if (answer !== "YES") {
          ulog("user declined update");
          return;
        }
      }

      toast(`Downloading Bloom Audio Compressor ${rel.version}…`);
      let installerPath;
      try {
        installerPath = await downloadInstaller(rel);
      } catch (e) {
        clearToast();
        ulog(`download error: ${(e && e.message) || e}`);
        await Neutralino.os.showMessageBox(
          "Update failed",
          `Couldn't download the update.\n\n${(e && e.message) || e}\n\n` +
            `You can download it manually from:\n${rel.downloadUrl}`,
          "OK",
          "ERROR",
        );
        return;
      }

      toast(`Starting installer…`);
      try {
        await runInstallerAndExit(installerPath);
      } catch (e) {
        clearToast();
        ulog(`launch error: ${(e && e.message) || e}`);
        await Neutralino.os.showMessageBox(
          "Update failed",
          `The update was downloaded but couldn't be started.\n\n${(e && e.message) || e}\n\n` +
            `You can run it manually:\n${installerPath}`,
          "OK",
          "ERROR",
        );
        return;
      }
    } catch (e) {
      clearToast();
      ulog(`check error: ${(e && (e.message || e.code)) || e}`);
    }
  }

  window.CompressBloomAudioUpdater = { check };
})();
