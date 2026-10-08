/* The one screen: layout "1a" of the design (settings sidebar + data table).
   The server owns the job (scan → compress, replacing the audio and keeping originals →
   restore) and pushes its state; this component owns only what the user is choosing right
   now — ticked books, quality, expanded rows, the clip playing. */
import React from "react";
import { api, pickFolder, subscribeState, type Book, type EngineState, type Settings } from "./api";
import { Button, Checkbox, Chevron } from "./components/primitives";
import {
  PRESETS,
  TONE_COLOR,
  bookRow,
  clipAfter,
  fmtBytes,
  fmtDuration,
  isUnchanged,
  justCompressedBefore,
  plural,
  type BookRow,
} from "./model";

const COLS = "32px minmax(0,1fr) 52px 80px 88px 60px 140px 132px";
const PLAY = "M7 4 L19 12 L7 20 Z";
const STOP = "M6 6 H18 V18 H6 Z";

type Which = "before" | "after" | "preview";

interface Playing {
  key: string;
  which: Which;
  t: number;
  dur: number;
}

function useAudioPlayer() {
  const audio = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState<Playing | null>(null);
  const stop = React.useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  }, []);
  /** Play a clip, or stop it if it is the one already playing. */
  const toggle = React.useCallback(
    (book: Book, file: string, which: Which, kbps: number, dur: number) => {
      const key = `${book.id}/${file}`;
      const same = playing && playing.key === key && playing.which === which;
      audio.current?.pause();
      audio.current = null;
      if (same) return setPlaying(null);
      const a = new Audio(api.audioUrl(book.id, file, which, kbps));
      audio.current = a;
      setPlaying({ key, which, t: 0, dur });
      a.ontimeupdate = () =>
        setPlaying((p) => (p && audio.current === a ? { ...p, t: a.currentTime } : p));
      a.onended = () => audio.current === a && stop();
      a.onerror = () => audio.current === a && stop();
      void a.play().catch(stop);
    },
    [playing, stop],
  );
  React.useEffect(() => stop, [stop]);
  return { playing, toggle, stop };
}

export function App() {
  const [state, setState] = React.useState<EngineState | null>(null);
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [bloomFolder, setBloomFolder] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [advanced, setAdvanced] = React.useState(false);
  const [askRestore, setAskRestore] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const player = useAudioPlayer();
  const stopPlayer = player.stop;
  const lastFolder = React.useRef<string | null>(null);
  const lastPhase = React.useRef<string | null>(null);

  React.useEffect(() => {
    void api
      .startup()
      .then((r) => {
        setSettings(r.settings);
        setBloomFolder(r.bloomFolder);
        setState(r.state);
      })
      .catch((e) => setActionError(String(e.message || e)));
    return subscribeState(setState);
  }, []);

  // A newly opened collection starts with every book ticked.
  React.useEffect(() => {
    const c = state?.collection;
    if (!c || c.folder === lastFolder.current) return;
    lastFolder.current = c.folder;
    setSelected(new Set(c.books.map((b) => b.id)));
    setExpanded(new Set());
  }, [state?.collection]);

  // Whatever is playing belongs to files that a compress or restore is about to replace.
  React.useEffect(() => {
    if (!state) return;
    if (state.phase !== lastPhase.current) stopPlayer();
    lastPhase.current = state.phase;
  }, [state, stopPlayer]);

  if (!state || !settings) {
    return <Centered>{actionError ?? "Starting…"}</Centered>;
  }

  const ph = state.phase;
  const locked = ph !== "idle";
  const kbps = settings.kbps;
  const books = state.collection?.books ?? [];

  const run = (p: Promise<unknown>) => {
    setActionError(null);
    p.catch((e) => setActionError(String(e?.message || e)));
  };
  const updateSettings = (patch: Partial<Settings>) => {
    setSettings({ ...settings, ...patch });
    void api.saveSettings(patch).catch(() => {});
  };
  const chooseCollection = () =>
    run(
      pickFolder(bloomFolder ?? undefined).then((folder) => {
        if (folder) return api.openCollection(folder);
      }),
    );
  const pickKbps = (patch: Partial<Settings>) => {
    if (locked) return;
    stopPlayer();
    updateSettings(patch);
  };

  const rows: BookRow[] = books.map((b) => bookRow(b, state, selected.has(b.id), kbps));
  const totalRows = rows.filter((r) =>
    state.job ? state.job.bookIds.includes(r.book.id) : selected.has(r.book.id),
  );
  const tb = totalRows.reduce((a, r) => a + r.before, 0);
  const ta = totalRows.reduce((a, r) => a + r.after, 0);
  const tc = totalRows.reduce((a, r) => a + r.book.clips.length, 0);
  const estimated = totalRows.some((r) => !r.actual);
  const prog = totalRows.reduce((a, r) => a + r.before * r.progress, 0);
  const pct = tb ? Math.round((prog / tb) * 100) : 0;
  const nSel = selected.size;
  const nRestorable = state.restorableBookIds.length;
  const canRestore = nRestorable > 0 && ph === "idle";
  const allSelected = books.length > 0 && books.every((b) => selected.has(b.id));
  const toggleIn = (setter: typeof setSelected, id: string) =>
    setter((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--app-surface)",
      }}
    >
      {/* Collection header */}
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 20px",
          borderBottom: "1px solid var(--app-border)",
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--app-text-muted)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>
            {state.collection?.name ?? "No collection chosen"}
          </span>
          <span
            style={{
              fontFamily: "var(--app-font-mono)",
              fontSize: 12,
              color: "var(--app-text-subtle)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {state.collection?.folder ?? "Choose the folder of a Bloom collection to see its books"}
          </span>
        </div>
        <Button variant="secondary" onClick={chooseCollection} disabled={locked}>
          {state.collection ? "Change collection…" : "Choose collection…"}
        </Button>
      </div>

      {(actionError || state.error || !state.ffmpeg) && (
        <div
          role="alert"
          style={{
            flex: "none",
            padding: "10px 20px",
            background: "var(--sil-red-10)",
            color: "var(--sil-red-dark)",
            fontSize: 13,
            borderBottom: "1px solid var(--app-border)",
          }}
        >
          {actionError ??
            state.error ??
            "Couldn't find Bloom's ffmpeg. This app uses the ffmpeg that comes with Bloom, so install Bloom and restart."}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "260px minmax(0,1fr)",
        }}
      >
        {/* Settings sidebar */}
        <div
          style={{
            borderRight: "1px solid var(--app-border)",
            background: "var(--app-surface-2)",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 22,
            overflow: "auto",
            opacity: locked ? 0.55 : 1,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionLabel>Quality</SectionLabel>
            {PRESETS.map((p) => {
              const on = settings.preset === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => pickKbps({ preset: p.id, kbps: p.kbps })}
                  disabled={locked}
                  aria-pressed={on}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: "var(--app-radius-sm)",
                    border: `1px solid ${on ? "var(--sil-blue)" : "var(--app-border-strong)"}`,
                    background: on ? "var(--sil-blue-05)" : "var(--app-surface)",
                    fontFamily: "var(--app-font)",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      flex: "none",
                      border: `2px solid ${on ? "var(--sil-blue)" : "var(--app-border-strong)"}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: on ? "var(--sil-blue)" : "transparent",
                      }}
                    />
                  </span>
                  <span style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--app-text)" }}>
                      {p.label}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--app-text-muted)" }}>{p.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button
              onClick={() => setAdvanced(!advanced)}
              aria-expanded={advanced || settings.preset === "custom"}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontFamily: "var(--app-font)",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--sil-blue)",
                cursor: "pointer",
              }}
            >
              <Chevron open={advanced || settings.preset === "custom"} size={14} />
              Custom bitrate
            </button>
            {(advanced || settings.preset === "custom") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <label htmlFor="kbps" style={{ color: "var(--app-text-muted)" }}>
                    Bitrate
                  </label>
                  <span style={{ fontWeight: 600 }}>{kbps} kbps</span>
                </div>
                <input
                  id="kbps"
                  type="range"
                  min={16}
                  max={128}
                  step={8}
                  value={kbps}
                  disabled={locked}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    pickKbps({
                      kbps: v,
                      preset: PRESETS.find((p) => p.kbps === v)?.id ?? "custom",
                    });
                  }}
                  style={{ width: "100%", accentColor: "var(--sil-blue)" }}
                />
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 11,
                    color: "var(--app-text-subtle)",
                  }}
                >
                  <span>16 · smaller</span>
                  <span>128 · clearer</span>
                </div>
              </div>
            )}
          </div>

          {/* Restore, pinned to the bottom of the sidebar */}
          <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {canRestore && !askRestore && <RestoreLink onClick={() => setAskRestore(true)} />}
            {canRestore && askRestore && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  fontSize: 13,
                  color: "var(--app-text)",
                }}
              >
                <span style={{ textWrap: "pretty" } as React.CSSProperties}>
                  Put back the original recordings in {plural(nRestorable, "book")}?
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button variant="ghost" onClick={() => setAskRestore(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setAskRestore(false);
                      run(api.restore());
                    }}
                  >
                    Restore
                  </Button>
                </div>
              </div>
            )}
            {ph === "restoring" && (
              <span style={{ fontSize: 13, color: "var(--app-text-muted)" }}>Restoring…</span>
            )}
            {state.lastRestore && ph === "idle" && !askRestore && (
              <span style={{ fontSize: 13, color: "var(--sil-green-dark)" }}>
                Original audio restored in {plural(state.lastRestore.restoredBooks, "book")}
                {state.lastRestore.changedSince.length > 0 && (
                  <span style={{ display: "block", color: "var(--app-text-muted)", marginTop: 4 }}>
                    {plural(state.lastRestore.changedSince.length, "clip")} recorded again since
                    compressing {state.lastRestore.changedSince.length === 1 ? "was" : "were"} left
                    as {state.lastRestore.changedSince.length === 1 ? "it is" : "they are"}.
                  </span>
                )}
              </span>
            )}
          </div>
        </div>

        {/* Book table */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div
            style={{
              flex: "none",
              display: "grid",
              gridTemplateColumns: COLS,
              alignItems: "center",
              padding: "0 20px",
              height: 36,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--app-text-muted)",
              borderBottom: "1px solid var(--app-border)",
              background: "var(--app-surface-2)",
            }}
          >
            <Checkbox
              id="all"
              checked={allSelected}
              disabled={locked || !books.length}
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(books.map((b) => b.id)))
              }
            />
            <div>Book</div>
            <div style={{ textAlign: "right" }}>Clips</div>
            <div style={{ textAlign: "right" }}>Before</div>
            <div style={{ textAlign: "right" }}>After</div>
            <div style={{ textAlign: "right" }}>Saved</div>
            <div style={{ paddingLeft: 16 }}>Listen</div>
            <div>Status</div>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {ph === "scanning" && !books.length && (
              <Centered>Reading the books in this collection…</Centered>
            )}
            {ph !== "scanning" && state.collection && !books.length && (
              <Centered>None of the books in this collection have recorded audio.</Centered>
            )}
            {!state.collection && ph !== "scanning" && (
              <Centered>
                <Button onClick={chooseCollection}>Choose collection…</Button>
              </Centered>
            )}
            {rows.map((r) => {
              const b = r.book;
              const isOpen = expanded.has(b.id);
              const inJob = !!state.job?.bookIds.includes(b.id);
              const showAfter = selected.has(b.id) || inJob;
              const k = inJob ? state.job!.kbps : kbps;
              return (
                <div key={b.id} data-book={b.id}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: COLS,
                      alignItems: "center",
                      padding: "0 20px",
                      height: 44,
                      fontSize: 14,
                      borderBottom: "1px solid var(--app-border)",
                      background: r.running ? "#F2FAFE" : "transparent",
                    }}
                  >
                    <Checkbox
                      id={`b-${b.id}`}
                      checked={selected.has(b.id)}
                      disabled={locked}
                      onChange={() => toggleIn(setSelected, b.id)}
                    />
                    <button
                      title={b.folder}
                      aria-expanded={isOpen}
                      onClick={() => toggleIn(setExpanded, b.id)}
                      style={{
                        border: "none",
                        background: "none",
                        padding: "8px 0",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        minWidth: 0,
                        cursor: "pointer",
                        fontFamily: "var(--app-font)",
                        fontSize: 14,
                        textAlign: "left",
                        color: selected.has(b.id) ? "var(--app-text)" : "var(--app-text-muted)",
                      }}
                    >
                      <span
                        style={{ flex: "none", display: "flex", color: "var(--app-text-subtle)" }}
                      >
                        <Chevron open={isOpen} size={14} />
                      </span>
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {b.title}
                      </span>
                    </button>
                    <div style={{ textAlign: "right", color: "var(--app-text-muted)" }}>
                      {b.clips.length}
                    </div>
                    <Num>{fmtBytes(r.before)}</Num>
                    <Num color={r.actual && inJob ? "var(--app-text)" : "var(--app-text-muted)"}>
                      {showAfter ? (r.actual ? "" : "~") + fmtBytes(r.after) : "—"}
                    </Num>
                    <Num color="var(--sil-green-dark)">
                      {showAfter && r.after < r.before
                        ? "−" + Math.round((1 - r.after / r.before) * 100) + "%"
                        : ""}
                    </Num>
                    <div />
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 13,
                        color: TONE_COLOR[r.statusTone],
                      }}
                    >
                      {ph === "running" && r.statusTone === "text" && (
                        <div
                          style={{
                            flex: 1,
                            height: 6,
                            background: "var(--app-border)",
                            borderRadius: 3,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              background: "var(--sil-light-blue)",
                              width: Math.round(r.progress * 100) + "%",
                            }}
                          />
                        </div>
                      )}
                      <span style={{ whiteSpace: "nowrap" }}>{r.status}</span>
                    </div>
                  </div>
                  {isOpen && (
                    <div
                      style={{
                        background: "var(--app-surface-2)",
                        borderBottom: "1px solid var(--app-border)",
                        padding: "4px 0",
                      }}
                    >
                      {b.clips.map((c) => {
                        const key = `${b.id}/${c.file}`;
                        const s = inJob ? state.clips[key] : undefined;
                        // Set when the last run replaced this clip: its size before that run.
                        const before = justCompressedBefore(state, b.id, c.file, kbps);
                        const done =
                          s?.status === "done" || s?.status === "skipped" || before !== undefined;
                        const unchanged = isUnchanged(c, k);
                        const previewBytes = state.previews[`${key}@${k}`];
                        const a = clipAfter(c, s, k, previewBytes);
                        const encoding = state.encoding === key;
                        const canSecond = (done || ph === "idle") && !encoding && !state.encoding;
                        const p = player.playing?.key === key ? player.playing : null;
                        const second: Which = done ? "after" : "preview";
                        const afterText =
                          before !== undefined
                            ? fmtBytes(c.bytes)
                            : s?.status === "failed"
                              ? "Failed"
                              : done
                                ? fmtBytes(a.bytes)
                                : unchanged
                                  ? fmtBytes(c.bytes)
                                  : (a.actual ? "" : "~") + fmtBytes(a.bytes);
                        const playSecond = () => {
                          if (!canSecond) return;
                          if (done || unchanged || previewBytes !== undefined) {
                            player.toggle(b, c.file, second, k, c.durationSec);
                            return;
                          }
                          player.stop();
                          run(
                            api
                              .preview(b.id, c.file, k)
                              .then(() => player.toggle(b, c.file, "preview", k, c.durationSec)),
                          );
                        };
                        return (
                          <div
                            key={c.file}
                            data-clip={c.file}
                            title={s?.error ?? c.file}
                            style={{
                              display: "grid",
                              gridTemplateColumns: COLS,
                              alignItems: "center",
                              padding: "0 20px",
                              height: 36,
                              fontSize: 13,
                              color: "var(--app-text-muted)",
                            }}
                          >
                            <div />
                            <div
                              style={{
                                paddingLeft: 20,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {c.label}
                            </div>
                            <div style={{ textAlign: "right" }}>{fmtDuration(c.durationSec)}</div>
                            <Num cell="before">{fmtBytes(before ?? c.bytes)}</Num>
                            <Num
                              cell="after"
                              color={s?.status === "failed" ? "var(--sil-red)" : undefined}
                            >
                              {afterText}
                            </Num>
                            <div />
                            <div
                              style={{
                                paddingLeft: 16,
                                gridColumn: "span 2",
                                display: "flex",
                                gap: 6,
                              }}
                            >
                              <PlayButton
                                label="Before"
                                active={p?.which === "before"}
                                time={
                                  p?.which === "before"
                                    ? `${fmtDuration(p.t)} / ${fmtDuration(p.dur)}`
                                    : null
                                }
                                disabled={ph === "restoring"}
                                onClick={() => player.toggle(b, c.file, "before", k, c.durationSec)}
                              />
                              <PlayButton
                                label={encoding ? "Encoding…" : done ? "After" : "Preview"}
                                active={!!p && p.which !== "before"}
                                busy={encoding}
                                time={
                                  p && p.which !== "before"
                                    ? `${fmtDuration(p.t)} / ${fmtDuration(p.dur)}`
                                    : null
                                }
                                disabled={!canSecond && !encoding}
                                onClick={playSecond}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          flex: "none",
          borderTop: "1px solid var(--app-border)",
          padding: "14px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          background: "var(--app-surface)",
        }}
      >
        {ph === "running" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Compressing… {pct}%</span>
            </div>
            <div
              style={{
                height: 8,
                background: "var(--app-border)",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  background: "var(--sil-light-blue)",
                  width: pct + "%",
                  transition: "width 200ms cubic-bezier(0.4,0,0.2,1)",
                }}
              />
            </div>
          </div>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 20,
          }}
        >
          <div style={{ display: "flex", gap: 28, alignItems: "baseline" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 12, color: "var(--app-text-muted)" }}>
                {plural(totalRows.length, "book")} · {plural(tc, "clip")}
              </span>
              <span style={{ fontSize: 20, fontWeight: 600 }}>
                {fmtBytes(tb)}{" "}
                <span style={{ color: "var(--app-text-subtle)", fontWeight: 400 }}>→</span>{" "}
                <span style={{ color: "var(--sil-blue)" }}>
                  {(estimated ? "~" : "") + fmtBytes(ta)}
                </span>
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 12, color: "var(--app-text-muted)" }}>
                {estimated ? "Estimated saving" : "Saving"}
              </span>
              <span style={{ fontSize: 20, fontWeight: 600, color: "var(--sil-green-dark)" }}>
                {fmtBytes(Math.max(0, tb - ta))}{" "}
                {tb > 0 && (
                  <span style={{ fontSize: 14, fontWeight: 400 }}>
                    ({Math.round((1 - ta / tb) * 100)}% smaller)
                  </span>
                )}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {state.lastCompress && ph === "idle" && (
              <span
                role="status"
                style={{ fontSize: 13, color: "var(--app-text-muted)", textAlign: "right" }}
              >
                {state.lastCompress.books === 0
                  ? `Nothing to compress: every clip is already at ${state.lastCompress.kbps} kbps or smaller.`
                  : `${state.lastCompress.stopped ? "Stopped. " : ""}Compressed ${plural(state.lastCompress.books, "book")}, saved ${fmtBytes(state.lastCompress.savedBytes)}.`}
              </span>
            )}
            {ph !== "running" && (
              <Button
                disabled={!nSel || ph !== "idle" || !state.ffmpeg || !!state.encoding}
                onClick={() => run(api.compress([...selected], kbps))}
              >
                Compress {plural(nSel, "book")}
              </Button>
            )}
            {ph === "running" && (
              <Button variant="secondary" onClick={() => run(api.stop())}>
                Stop
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--app-text-muted)",
      }}
    >
      {children}
    </div>
  );
}

function RestoreLink({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div style={{ display: "flex" }}>
      <button
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          border: "none",
          background: "none",
          padding: "4px 2px",
          fontFamily: "var(--app-font)",
          fontSize: 13,
          color: hover ? "var(--sil-blue)" : "var(--app-text-muted)",
          textDecoration: "underline",
          textUnderlineOffset: 3,
          cursor: "pointer",
        }}
      >
        Restore original audio…
      </button>
    </div>
  );
}

function Num({
  children,
  color,
  cell,
}: {
  children: React.ReactNode;
  color?: string;
  cell?: string;
}) {
  return (
    <div
      data-cell={cell}
      style={{
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        overflow: "hidden",
        color,
      }}
    >
      {children}
    </div>
  );
}
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        minHeight: 160,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        color: "var(--app-text-muted)",
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}

function PlayButton({
  label,
  active,
  busy = false,
  time,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  busy?: boolean;
  time: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const lit = active || busy;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={busy ? label : `${active ? "Stop" : "Play"} ${label.toLowerCase()}`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        height: 24,
        padding: "0 8px",
        border: `1px solid ${lit ? "var(--sil-blue)" : "var(--app-border-strong)"}`,
        borderRadius: "var(--app-radius-sm)",
        background: active
          ? "var(--sil-blue-10)"
          : busy
            ? "var(--sil-blue-05)"
            : "var(--app-surface)",
        color: lit ? "var(--sil-blue)" : "var(--app-text)",
        fontFamily: "var(--app-font)",
        fontSize: 12,
        cursor: "pointer",
        opacity: disabled ? 0.4 : 1,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d={active ? STOP : PLAY} />
      </svg>
      {time ?? label}
    </button>
  );
}
