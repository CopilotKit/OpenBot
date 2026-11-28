import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ASK_CHOICES,
  ASK_LABELS,
  type AskFor,
  type AskFrame,
  buildAskPrompt,
  isAskFor,
} from "./askPrompt";
import { copyText } from "./clipboard";
import type { CommentContext, CommentTarget } from "./commentPrompt";
import type { Box } from "./geometry";
import { Measurement, measure, type Reading } from "./Inspector";
import { pickArea, pickElement } from "./pickElement";
import { resolveTarget } from "./sourceLines";
import type { WindowSettings } from "./urlState";
import { readPref, writePref } from "./viewerPrefs";

export type CommentLayerProps = {
  frame: HTMLIFrameElement | null;
  scene: { id: string; title: string };
  window: WindowSettings;
  /** Set for an app scene: the live route of the app frame and where the app runs. */
  app?: CommentContext["app"];
  gridStep?: number;
  /** The kind and the layout warnings of the loaded window, for an impeccable prompt. */
  frameInfo?: AskFrame;
};

/** Where the last "Ask for" choice is kept, for this viewer. */
const ASK_PREF = "commentAsk";

function isAskPref(value: unknown): value is AskFor {
  return typeof value === "string" && isAskFor(value);
}

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

/** What the "Ask for" list shows for each choice. */
function askLabel(choice: AskFor): string {
  return choice === "change"
    ? ASK_LABELS[choice]
    : `${ASK_LABELS[choice]} (impeccable)`;
}

function describeTarget(target: CommentTarget): string {
  if (target.kind === "element") return target.element.label;
  const n = target.elements.length;
  return `Area with ${n} ${n === 1 ? "element" : "elements"}`;
}

/**
 * Comment mode over the window: the element under the pointer has an outline, a click picks it,
 * and a drag picks an area. A box next to the pick (the app's Popover, anchored to the pick's
 * outline) takes the comment and copies a prompt for a coding agent. Clicks do not reach the window
 * while this layer shows. The box and its list are portals on the page's body, so they show above
 * the window and the overlays, and a click in them never reaches the window.
 */
export function CommentLayer({
  frame,
  scene,
  window: settings,
  app,
  gridStep = 4,
  frameInfo,
}: CommentLayerProps) {
  const [ask, setAsk] = useState<AskFor>(
    () => readPref(ASK_PREF, isAskPref) ?? "change",
  );
  const [hover, setHover] = useState<Reading | null>(null);
  const [drag, setDrag] = useState<Box | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const anchorId = useId();
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

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = async () => {
    if (!selection) return;
    const target = await selection.resolved;
    const text = buildAskPrompt(
      ask,
      target,
      {
        comment,
        scene,
        window: settings,
        link: window.location.href,
        app,
      },
      frameInfo ?? { kind: app ? "app" : "desktop", warnings: [] },
    );
    try {
      await copyText(text);
      setStatus("Copied.");
    } catch {
      setStatus("The workbench cannot write to the clipboard.");
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus(null), COPIED_MS);
  };

  return (
    <div
      data-workbench-comment
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: settings.width,
        height: settings.height,
        pointerEvents: "none",
      }}
    >
      {hover && !drag && !selection && <Measurement reading={hover} />}
      {drag && (
        <div
          data-workbench-comment-drag
          aria-hidden="true"
          className="border border-dashed border-ring bg-ring/10"
          style={{
            position: "absolute",
            left: drag.x,
            top: drag.y,
            width: drag.width,
            height: drag.height,
          }}
        />
      )}
      <Popover
        open={selection !== null}
        triggerId={anchorId}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        {selection && (
          // The pick's outline is the box's anchor. It takes no pointer (the layer has none), so
          // it never opens or closes the box itself.
          <PopoverTrigger
            id={anchorId}
            nativeButton={false}
            render={<div />}
            tabIndex={-1}
            data-workbench-comment-selected
            aria-hidden="true"
            className={
              selection.target.kind === "area"
                ? "outline-2 outline-ring outline-dashed bg-ring/10"
                : "outline-2 outline-ring outline-solid"
            }
            style={{
              position: "absolute",
              left: selection.box.x,
              top: selection.box.y,
              width: selection.box.width,
              height: selection.box.height,
            }}
          />
        )}
        {selection && (
          <PopoverContent
            data-workbench-comment-popover
            aria-label="Comment"
            side="right"
            align="start"
            sideOffset={8}
            initialFocus={textRef}
            finalFocus={false}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void copy();
              }
            }}
          >
            <div className="truncate text-xs text-muted-foreground">
              {describeTarget(selection.target)}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`${anchorId}-ask`}>Ask for</Label>
              <Select
                value={ask}
                onValueChange={(next) => {
                  if (!isAskFor(String(next))) return;
                  setAsk(next as AskFor);
                  writePref(ASK_PREF, next);
                }}
              >
                <SelectTrigger
                  id={`${anchorId}-ask`}
                  size="sm"
                  aria-label="Ask for"
                  className="min-w-0 flex-1"
                >
                  <SelectValue>{askLabel(ask)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ASK_CHOICES.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {askLabel(choice)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${anchorId}-text`}>
                {ask === "change"
                  ? "What do you want to change?"
                  : "Anything to add? (optional)"}
              </Label>
              <Textarea
                id={`${anchorId}-text`}
                ref={textRef}
                value={comment}
                rows={4}
                onChange={(event) => setComment(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={ask === "change" && comment.trim() === ""}
                onClick={() => void copy()}
              >
                Copy as prompt
              </Button>
              <Button variant="outline" size="sm" onClick={cancel}>
                Cancel
              </Button>
              {status && (
                <span role="status" className="text-xs text-muted-foreground">
                  {status}
                </span>
              )}
            </div>
          </PopoverContent>
        )}
      </Popover>
    </div>
  );
}
