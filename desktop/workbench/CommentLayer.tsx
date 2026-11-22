import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { buildPrompt, type CommentTarget } from "./commentPrompt";
import type { Box } from "./geometry";
import { Measurement, measure, type Reading } from "./Inspector";
import { pickArea, pickElement } from "./pickElement";
import { resolveTarget } from "./sourceLines";
import type { WindowSettings } from "./urlState";

export type CommentLayerProps = {
  frame: HTMLIFrameElement | null;
  scene: { id: string; title: string };
  /** Seconds from the scene start, on the window's clock. */
  atSeconds: number;
  window: WindowSettings;
  gridStep?: number;
};

/** `resolved` is the target with source lines, read from the source maps after the pick. */
type Selection = {
  target: CommentTarget;
  box: Box;
  resolved: Promise<CommentTarget>;
};

function selectionOf(target: CommentTarget, box: Box): Selection {
  return {
    target,
    box,
    resolved: resolveTarget(target).catch(() => target),
  };
}
type Start = { x: number; y: number; target: Element | null };

/** A move of more than this many pixels with the button down draws an area. */
const DRAG_PX = 4;
const POPOVER_WIDTH = 288;
const MARGIN = 8;
const SELECTED = "#3d7dff";
const COPIED_MS = 2000;

/** Events that must not reach the window while Comment mode is on. */
const BLOCKED = [
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "pointerup",
  "touchstart",
  "touchend",
] as const;

function areaOf(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

/** Next to the box: right, else left, else under, else over; always inside the window. */
export function popoverPlace(
  box: Box,
  size: { width: number; height: number },
  bounds: { width: number; height: number },
): { x: number; y: number } {
  const { width, height } = size;
  let x: number;
  let y = box.y;
  if (box.x + box.width + MARGIN + width + MARGIN <= bounds.width) {
    x = box.x + box.width + MARGIN;
  } else if (box.x - MARGIN - width >= MARGIN) {
    x = box.x - MARGIN - width;
  } else {
    x = box.x;
    y =
      box.y + box.height + MARGIN + height + MARGIN <= bounds.height
        ? box.y + box.height + MARGIN
        : box.y - MARGIN - height;
  }
  return {
    x: clamp(x, MARGIN, Math.max(MARGIN, bounds.width - width - MARGIN)),
    y: clamp(y, MARGIN, Math.max(MARGIN, bounds.height - height - MARGIN)),
  };
}

function describeTarget(target: CommentTarget): string {
  if (target.kind === "element") return target.element.label;
  const n = target.elements.length;
  return `Area with ${n} ${n === 1 ? "element" : "elements"}`;
}

/**
 * Comment mode over the window: the element under the pointer has an outline, a click picks it,
 * and a drag picks an area. A box next to the pick takes the comment and copies a prompt for a
 * coding agent. Clicks do not reach the window while this layer shows.
 */
export function CommentLayer({
  frame,
  scene,
  atSeconds,
  window: settings,
  gridStep = 4,
}: CommentLayerProps) {
  const [hover, setHover] = useState<Reading | null>(null);
  const [drag, setDrag] = useState<Box | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [popoverHeight, setPopoverHeight] = useState(180);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => {
    setSelection(null);
    setComment("");
    setStatus(null);
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    if (!frame) return;
    let detach: (() => void) | null = null;

    const attach = () => {
      detach?.();
      detach = null;
      const doc = frame.contentDocument;
      const win = frame.contentWindow;
      if (!doc || !win) return;
      let raf = 0;
      let last: Element | null = null;
      let start: Start | null = null;
      let dragging = false;

      const block = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      const onDown = (event: PointerEvent) => {
        block(event);
        if (event.button !== 0) return;
        const target = event.target as Element | null;
        start = {
          x: event.clientX,
          y: event.clientY,
          target: target?.nodeType === 1 ? target : null,
        };
        dragging = false;
      };
      const onMove = (event: PointerEvent) => {
        if (start) {
          const moved = Math.hypot(
            event.clientX - start.x,
            event.clientY - start.y,
          );
          if (dragging || moved > DRAG_PX) {
            dragging = true;
            setHover(null);
            setDrag(areaOf(start, { x: event.clientX, y: event.clientY }));
          }
          return;
        }
        if (selectionRef.current) return;
        const target = event.target as Element | null;
        if (target?.nodeType !== 1) return;
        last = target;
        if (raf) return;
        raf = win.requestAnimationFrame(() => {
          raf = 0;
          if (last && !selectionRef.current) {
            setHover(measure(last, gridStep, doc));
          }
        });
      };
      const onUp = (event: PointerEvent) => {
        block(event);
        const from = start;
        start = null;
        if (!from) return;
        setHover(null);
        setDrag(null);
        setComment("");
        setStatus(null);
        if (dragging) {
          dragging = false;
          const area = areaOf(from, { x: event.clientX, y: event.clientY });
          setSelection(
            selectionOf(
              { kind: "area", area, elements: pickArea(area, doc, gridStep) },
              area,
            ),
          );
          return;
        }
        if (!from.target) return;
        const element = pickElement(from.target, doc, gridStep);
        setSelection(selectionOf({ kind: "element", element }, element.box));
      };
      const onCancel = () => {
        start = null;
        dragging = false;
        setDrag(null);
      };
      const onLeave = () => {
        last = null;
        setHover(null);
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") cancelRef.current();
      };

      doc.addEventListener("pointerdown", onDown, true);
      doc.addEventListener("pointermove", onMove, true);
      doc.addEventListener("pointerup", onUp, true);
      doc.addEventListener("pointercancel", onCancel, true);
      for (const type of BLOCKED) {
        if (type !== "pointerup") doc.addEventListener(type, block, true);
      }
      doc.addEventListener("mouseleave", onLeave);
      doc.addEventListener("keydown", onKey, true);
      detach = () => {
        if (raf) win.cancelAnimationFrame(raf);
        doc.removeEventListener("pointerdown", onDown, true);
        doc.removeEventListener("pointermove", onMove, true);
        doc.removeEventListener("pointerup", onUp, true);
        doc.removeEventListener("pointercancel", onCancel, true);
        for (const type of BLOCKED) {
          if (type !== "pointerup") doc.removeEventListener(type, block, true);
        }
        doc.removeEventListener("mouseleave", onLeave);
        doc.removeEventListener("keydown", onKey, true);
      };
    };

    attach();
    frame.addEventListener("load", attach);
    return () => {
      frame.removeEventListener("load", attach);
      detach?.();
      setHover(null);
      setDrag(null);
    };
  }, [frame, gridStep]);

  // Escape in the workbench page cancels too.
  useEffect(() => {
    if (!selection) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  useEffect(() => {
    if (selection) textRef.current?.focus();
  }, [selection]);

  useLayoutEffect(() => {
    if (!selection) return;
    const height = popoverRef.current?.offsetHeight;
    if (height && height !== popoverHeight) setPopoverHeight(height);
  });

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = async () => {
    if (!selection) return;
    const target = await selection.resolved;
    const text = buildPrompt(target, {
      comment,
      scene,
      atSeconds,
      window: settings,
      link: window.location.href,
    });
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied.");
    } catch {
      setStatus("The workbench cannot write to the clipboard.");
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus(null), COPIED_MS);
  };

  const bounds = { width: settings.width, height: settings.height };
  const place = selection
    ? popoverPlace(
        selection.box,
        { width: POPOVER_WIDTH, height: popoverHeight },
        bounds,
      )
    : null;

  return (
    <div
      data-workbench-comment
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: bounds.width,
        height: bounds.height,
        pointerEvents: "none",
      }}
    >
      {hover && !drag && !selection && <Measurement reading={hover} />}
      {drag && (
        <div
          data-workbench-comment-drag
          aria-hidden="true"
          style={{
            position: "absolute",
            left: drag.x,
            top: drag.y,
            width: drag.width,
            height: drag.height,
            border: `1px dashed ${SELECTED}`,
            background: "rgb(61 125 255 / 0.12)",
          }}
        />
      )}
      {selection && (
        <div
          data-workbench-comment-selected
          aria-hidden="true"
          style={{
            position: "absolute",
            left: selection.box.x,
            top: selection.box.y,
            width: selection.box.width,
            height: selection.box.height,
            outline: `2px ${selection.target.kind === "area" ? "dashed" : "solid"} ${SELECTED}`,
            outlineOffset: 0,
            background:
              selection.target.kind === "area"
                ? "rgb(61 125 255 / 0.08)"
                : undefined,
          }}
        />
      )}
      {selection && place && (
        <div
          ref={popoverRef}
          data-workbench-comment-popover
          role="dialog"
          aria-label="Comment"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              cancel();
            } else if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              void copy();
            }
          }}
          style={{
            position: "absolute",
            left: place.x,
            top: place.y,
            width: POPOVER_WIDTH,
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 12,
            pointerEvents: "auto",
            background: "var(--wb-panel, #fff)",
            color: "var(--wb-text, #1c1c1e)",
            border: "1px solid var(--wb-border, #d4d4d8)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgb(0 0 0 / 0.3)",
            font: "13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif",
          }}
        >
          <div
            style={{
              color: "var(--wb-muted, #6b6b70)",
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {describeTarget(selection.target)}
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            What do you want to change?
            <textarea
              ref={textRef}
              value={comment}
              rows={4}
              onChange={(event) => setComment(event.target.value)}
              style={{
                font: "inherit",
                color: "inherit",
                background: "transparent",
                border: "1px solid var(--wb-border, #d4d4d8)",
                borderRadius: 4,
                padding: 8,
                resize: "vertical",
              }}
            />
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              disabled={comment.trim() === ""}
              onClick={() => void copy()}
              style={buttonStyle}
            >
              Copy as prompt
            </button>
            <button type="button" onClick={cancel} style={buttonStyle}>
              Cancel
            </button>
            {status && (
              <span role="status" style={{ fontSize: 12 }}>
                {status}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  font: "inherit",
  color: "inherit",
  background: "var(--wb-panel, #fff)",
  border: "1px solid var(--wb-border, #d4d4d8)",
  borderRadius: 4,
  padding: "4px 8px",
  cursor: "pointer",
};
