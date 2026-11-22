import { useEffect, useState } from "react";
import { type Box, gaps, offGrid } from "./geometry";

export type InspectorProps = {
  frame: HTMLIFrameElement | null;
  gridStep?: number;
};

type Reading = {
  box: Box;
  gaps: ReturnType<typeof gaps>;
  off: { x: number; y: number };
};

const COLOR = "#ff3d81";

function toBox(rect: DOMRect): Box {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function measure(
  target: Element,
  gridStep: number,
  doc: Document,
): Reading | null {
  const rect = target.getBoundingClientRect();
  const box = toBox(rect);
  const others: Box[] = [];
  for (const el of doc.body?.querySelectorAll("*") ?? []) {
    if (el === target || el.contains(target) || target.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = doc.defaultView?.getComputedStyle(el);
    if (
      style &&
      (style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0")
    ) {
      continue;
    }
    others.push(toBox(r));
  }
  return { box, gaps: gaps(box, others), off: offGrid(box, gridStep) };
}

/** Shows the box, size, gaps to neighbours and distance from the grid for the element under the pointer in a same-origin frame. */
export function Inspector({ frame, gridStep = 4 }: InspectorProps) {
  const [reading, setReading] = useState<Reading | null>(null);

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
      const onMove = (event: MouseEvent) => {
        const target = event.target as Element | null;
        if (target?.nodeType !== 1) return;
        last = target;
        if (raf) return;
        raf = win.requestAnimationFrame(() => {
          raf = 0;
          if (last) setReading(measure(last, gridStep, doc));
        });
      };
      const onLeave = () => {
        last = null;
        setReading(null);
      };
      doc.addEventListener("mousemove", onMove);
      doc.addEventListener("mouseleave", onLeave);
      detach = () => {
        if (raf) win.cancelAnimationFrame(raf);
        doc.removeEventListener("mousemove", onMove);
        doc.removeEventListener("mouseleave", onLeave);
      };
    };

    attach();
    frame.addEventListener("load", attach);
    return () => {
      frame.removeEventListener("load", attach);
      detach?.();
      setReading(null);
    };
  }, [frame, gridStep]);

  if (!reading) return null;
  const { box, gaps: g, off } = reading;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const label: React.CSSProperties = {
    position: "absolute",
    background: COLOR,
    color: "#fff",
    font: "10px/1.4 ui-monospace, monospace",
    padding: "0 4px",
    borderRadius: 2,
    whiteSpace: "nowrap",
  };
  const line = (style: React.CSSProperties): React.CSSProperties => ({
    position: "absolute",
    background: COLOR,
    ...style,
  });

  return (
    <div
      data-workbench-inspector
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          outline: `1px solid ${COLOR}`,
          outlineOffset: -1,
        }}
      />
      <div style={{ ...label, left: box.x, top: box.y + box.height + 2 }}>
        {round(box.width)} × {round(box.height)}
        {(off.x !== 0 || off.y !== 0) &&
          ` · Off grid ${round(off.x)}, ${round(off.y)}`}
      </div>
      {g.top !== null && (
        <>
          <div
            style={line({
              left: cx,
              top: box.y - g.top,
              width: 1,
              height: g.top,
            })}
          />
          <div style={{ ...label, left: cx + 3, top: box.y - g.top / 2 - 7 }}>
            {round(g.top)}
          </div>
        </>
      )}
      {g.bottom !== null && (
        <>
          <div
            style={line({
              left: cx,
              top: box.y + box.height,
              width: 1,
              height: g.bottom,
            })}
          />
          <div
            style={{
              ...label,
              left: cx + 3,
              top: box.y + box.height + g.bottom / 2 - 7,
            }}
          >
            {round(g.bottom)}
          </div>
        </>
      )}
      {g.left !== null && (
        <>
          <div
            style={line({
              left: box.x - g.left,
              top: cy,
              width: g.left,
              height: 1,
            })}
          />
          <div style={{ ...label, left: box.x - g.left / 2 - 8, top: cy + 3 }}>
            {round(g.left)}
          </div>
        </>
      )}
      {g.right !== null && (
        <>
          <div
            style={line({
              left: box.x + box.width,
              top: cy,
              width: g.right,
              height: 1,
            })}
          />
          <div
            style={{
              ...label,
              left: box.x + box.width + g.right / 2 - 8,
              top: cy + 3,
            }}
          >
            {round(g.right)}
          </div>
        </>
      )}
    </div>
  );
}
