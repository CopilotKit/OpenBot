import { useEffect, useRef, useState } from "react";
import type { Change } from "../src/fakeNative/control";
import type { Box } from "./geometry";
import {
  clippedAndOutside,
  compare,
  snapshot,
  spacingWarnings,
  spinnerWarnings,
  type Snapshot,
  type Warning,
} from "./layoutWatch";

type Viewport = { width: number; height: number; buttons?: Box | null };
function causeOf(change: Change): string {
  switch (change.kind) {
    case "call":
      return `call ${change.call.command}`;
    case "emit":
      return `event ${change.event}`;
    case "answer":
      return `answer ${change.command}`;
    default:
      return `settled ${change.call.command}`;
  }
}
function key(warning: Warning): string {
  return `${warning.kind}|${warning.label}|${warning.kind === "spacing" ? warning.rule : ""}`;
}

/** Current layout problems, checked after page, size, native and API changes on browser time. */
export function useLayoutWatch(
  frame: HTMLIFrameElement | null,
  viewport: Viewport,
): { warnings: Warning[] } {
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  useEffect(() => {
    if (!frame) {
      setWarnings([]);
      return;
    }
    const watch = () => {
      setWarnings([]);
      const win = frame.contentWindow as (Window & typeof globalThis) | null;
      if (!win) return () => {};
      let last: Snapshot | null = null;
      let handle: number | null = null;
      let stopped = false;
      let off: (() => void) | undefined;
      const causes = new Set<string>();
      const check = () => {
        handle = null;
        if (stopped || !frame.contentDocument) return;
        const doc = frame.contentDocument;
        const at = win.performance.now();
        const next = snapshot(doc);
        const moved = last
          ? compare(last, next, at, [...causes].slice(0, 3).join(", "))
          : [];
        last = next;
        causes.clear();
        const { buttons = null, ...size } = viewportRef.current;
        const found = [
          ...moved,
          ...clippedAndOutside(doc, at, size),
          ...spacingWarnings(doc, at, size, buttons),
          ...spinnerWarnings(doc, at),
        ];
        setWarnings([
          ...new Map(found.map((warning) => [key(warning), warning])).values(),
        ]);
      };
      const pend = (cause: string) => {
        causes.add(cause);
        if (!stopped && handle === null)
          handle = win.requestAnimationFrame(check);
      };
      const resized = () => pend("resized");
      const start = () => {
        const mutations = new win.MutationObserver(() => pend("page changed"));
        mutations.observe(win.document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const sizes = new win.ResizeObserver(resized);
        sizes.observe(win.document.documentElement);
        win.addEventListener("resize", resized);
        win.document.addEventListener("scroll", resized, true);
        const offNative = win.__workbench?.onChange((change) =>
          pend(causeOf(change)),
        );
        const offApi = win.__workbenchApi?.onChange(() => pend("request"));
        const offStreams = win.__workbenchStreams?.onChange(() =>
          pend("stream"),
        );
        const offSockets = win.__workbenchSockets?.onChange(() =>
          pend("socket"),
        );
        off = () => {
          mutations.disconnect();
          sizes.disconnect();
          win.removeEventListener("resize", resized);
          win.document.removeEventListener("scroll", resized, true);
          offNative?.();
          offApi?.();
          offStreams?.();
          offSockets?.();
        };
        check();
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = () => {
        if (stopped) return;
        if (win.__workbenchBooted) start();
        else timer = setTimeout(wait, 10);
      };
      wait();
      return () => {
        stopped = true;
        clearTimeout(timer);
        if (handle !== null) win.cancelAnimationFrame(handle);
        off?.();
      };
    };
    let stop = watch();
    const loaded = () => {
      stop();
      stop = watch();
    };
    frame.addEventListener("load", loaded);
    return () => {
      frame.removeEventListener("load", loaded);
      stop();
    };
  }, [frame]);
  return { warnings };
}
