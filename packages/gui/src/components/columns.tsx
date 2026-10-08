/* The book table's column widths: fixed, draggable from the header, and remembered in
   this browser. Spare width goes to an empty last column, so on a wide window the figures
   stay next to the titles instead of spreading across the screen. */
import React from "react";

/** Columns after the checkbox, in order. */
export const COLUMNS = [
  { name: "Book", width: 300, min: 120 },
  { name: "Clips", width: 52, min: 40 },
  { name: "Current", width: 110, min: 80 },
  { name: "After", width: 100, min: 80 },
  { name: "Saved", width: 60, min: 44 },
  { name: "Status", width: 150, min: 80 },
] as const;

const CHECKBOX_COLUMN = 32;
/** Space between columns. The drag handles sit in the middle of it. */
export const COLUMN_GAP = 16;

/** A two-headed arrow with a bar, drawn crisp at any size; Windows' own col-resize cursor
 *  is a small bitmap that looks rough when scaled for a high-DPI screen. */
function resizeCursorSvg(size: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16M3 12h6M15 12h6M6 9l-3 3 3 3M18 9l3 3-3 3" stroke="#fff" stroke-width="4"/><path d="M12 4v16M3 12h6M15 12h6M6 9l-3 3 3 3M18 9l3 3-3 3" stroke="#18242e" stroke-width="1.8"/></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
const RESIZE_CURSOR = `image-set(${resizeCursorSvg(24)} 1x, ${resizeCursorSvg(48)} 2x) 12 12, col-resize`;
// Bump the version when the columns change, so remembered widths from before are ignored.
const STORAGE_KEY = "compress-bloom-audio.columnWidths.v2";

function load(): number[] {
  const defaults = COLUMNS.map((c) => c.width);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (Array.isArray(saved) && saved.length === COLUMNS.length) {
      return saved.map((w, i) =>
        typeof w === "number" ? Math.max(COLUMNS[i].min, w) : defaults[i],
      );
    }
  } catch {
    /* storage unavailable or unreadable: use the defaults */
  }
  return defaults;
}

export function useColumnWidths() {
  const [widths, setWidths] = React.useState<number[]>(load);
  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {
      /* not remembered this time */
    }
  }, [widths]);
  const setWidth = React.useCallback(
    (i: number, w: number) =>
      setWidths((prev) =>
        prev.map((old, j) => (j === i ? Math.max(COLUMNS[i].min, Math.round(w)) : old)),
      ),
    [],
  );
  const reset = React.useCallback((i: number) => setWidth(i, COLUMNS[i].width), [setWidth]);
  /** The CSS grid template every row of the table uses. */
  const template = `${CHECKBOX_COLUMN}px ${widths.map((w) => `${w}px`).join(" ")} minmax(0,1fr)`;
  /** Rows are at least this wide, so a narrow window scrolls sideways rather than
   *  squeezing the cells: checkbox + columns + the gaps between them. */
  const minRowWidth =
    CHECKBOX_COLUMN + widths.reduce((a, w) => a + w, 0) + COLUMN_GAP * widths.length;
  return { widths, setWidth, reset, template, minRowWidth };
}

/** A header cell with a drag handle on its right edge. Double-click the handle to reset. */
export function HeaderCell({
  index,
  widths,
  setWidth,
  reset,
  align = "left",
  style,
  children,
}: {
  index: number;
  widths: number[];
  setWidth: (i: number, w: number) => void;
  reset: (i: number) => void;
  align?: "left" | "right";
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const [dragging, setDragging] = React.useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widths[index];
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => setWidth(index, startW + ev.clientX - startX);
    const up = () => {
      setDragging(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  return (
    <div
      style={{
        position: "relative",
        textAlign: align,
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: align === "right" ? "flex-end" : "flex-start",
        ...style,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {children}
      </span>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${COLUMNS[index].name} column`}
        data-resize={COLUMNS[index].name}
        title="Drag to resize. Double-click to reset."
        onPointerDown={onPointerDown}
        onDoubleClick={() => reset(index)}
        style={{
          position: "absolute",
          top: 6,
          bottom: 6,
          right: -(COLUMN_GAP / 2) - 6,
          width: 12,
          cursor: RESIZE_CURSOR,
          zIndex: 2,
          display: "flex",
          justifyContent: "center",
          touchAction: "none",
        }}
      >
        <div
          style={{
            width: dragging ? 2 : 1,
            height: "100%",
            background: dragging ? "var(--sil-blue)" : "var(--app-border-strong)",
          }}
        />
      </div>
    </div>
  );
}
