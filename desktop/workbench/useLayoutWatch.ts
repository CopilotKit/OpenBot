import { useCallback, useEffect, useRef, useState } from "react";
import type { Change } from "../src/fakeNative/control";
import {
  clippedAndOutside,
  compare,
  type Snapshot,
  snapshot,
  type Warning,
} from "./layoutWatch";

type Viewport = { width: number; height: number };

/** How many changes name the cause of a check. */
const MAX_CAUSES = 3;

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

/** The key that says a clipped or outside warning is the same one as before. */
function stillKey(warning: Warning): string {
  return `${warning.kind}|${warning.label}`;
}

/**
 * Watches the layout of a loaded window. After each change of the fake native side or of the
 * clock, one frame later, it compares the window with how it was before, and finds text that is
 * cut off and elements outside the window. While `hold(true)` is in force (a seek walks the
 * clock), it checks only when `flush` is called: at each stop of the walk, where a frame may not
 * come between two moves of the clock, and where the window is the same each time.
 */
export function useLayoutWatch(
  frame: HTMLIFrameElement | null,
  viewport: Viewport,
): {
  warnings: Warning[];
  /**
   * The clock time of this window's last check, in ms: 0 for a new window. `warnings` holds what
   * this window's checks found up to this time, so a warning from an earlier window that is not in
   * `warnings` and is earlier than this time is gone from the run. It is the time of the window the
   * warnings come from: the page's own clock state lags a new window (a seek back) by a render.
   */
  checkedAt: number;
  flush(): void;
  hold(on: boolean): void;
} {
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [checkedAt, setCheckedAt] = useState(0);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const flushRef = useRef<() => void>(() => {});
  const heldRef = useRef(false);

  useEffect(() => {
    /** Watches the window the iframe holds now, from no warnings and time 0. Gives the stop. */
    const watch = (frame: HTMLIFrameElement): (() => void) => {
      setWarnings([]);
      setCheckedAt(0);
      const win = frame.contentWindow as (Window & typeof globalThis) | null;
      if (!win) return () => {};
      let stopped = false;
      let off: (() => void) | null = null;
      let last: Snapshot | null = null;
      let active = new Set<string>();
      let causes: string[] = [];
      let handle: number | null = null;
      let dirty = false;

      const check = () => {
        if (handle !== null) win.cancelAnimationFrame(handle);
        handle = null;
        dirty = false;
        const clock = win.__workbenchClock;
        const doc = frame.contentDocument;
        if (stopped || !clock || !doc) return;
        const at = clock.now();
        const cause = causes.join(", ");
        causes = [];
        const next = snapshot(doc);
        const found: Warning[] = last ? compare(last, next, at, cause) : [];
        last = next;
        const now = new Set<string>();
        for (const warning of clippedAndOutside(doc, at, viewportRef.current)) {
          const key = stillKey(warning);
          if (now.has(key)) continue;
          now.add(key);
          if (!active.has(key)) found.push(warning);
        }
        active = now;
        // In the same update as the warnings it found, so the two always belong together.
        setCheckedAt(at);
        if (found.length > 0) setWarnings((all) => [...all, ...found]);
      };

      const pend = (cause: string) => {
        if (causes.length < MAX_CAUSES && !causes.includes(cause))
          causes.push(cause);
        dirty = true;
        if (handle === null && !heldRef.current)
          handle = win.requestAnimationFrame(check);
      };

      const start = () => {
        const clock = win.__workbenchClock;
        const control = win.__workbench;
        if (!clock || !control) return;
        const offTick = clock.onTick(() => pend("clock"));
        const offChange = control.onChange((change) => pend(causeOf(change)));
        // An app frame also has the fake `/api`, the streams and the sockets.
        const offApi = win.__workbenchApi?.onChange((change) => {
          if (change.kind === "settled") {
            pend(`request ${change.record.method} ${change.record.path}`);
          }
        });
        const offStreams = win.__workbenchStreams?.onChange(() =>
          pend("stream"),
        );
        const offSockets = win.__workbenchSockets?.onChange(() =>
          pend("socket"),
        );
        off = () => {
          offTick();
          offChange();
          offApi?.();
          offStreams?.();
          offSockets?.();
        };
        check();
      };

      // The boot script sets up the clock before the window's own code; wait for it if needed.
      let poll: ReturnType<typeof setTimeout> | null = null;
      const wait = () => {
        poll = null;
        if (stopped || win.closed) return;
        if (win.__workbenchBooted) start();
        else poll = setTimeout(wait, 10);
      };
      wait();
      flushRef.current = () => {
        if (dirty) check();
      };

      return () => {
        stopped = true;
        if (poll !== null) clearTimeout(poll);
        if (handle !== null) win.cancelAnimationFrame(handle);
        off?.();
        flushRef.current = () => {};
      };
    };

    if (!frame) {
      setWarnings([]);
      setCheckedAt(0);
      return;
    }
    let stopWatch = watch(frame);
    // A load of the same iframe again (the app frame reloads after a source edit) is a new
    // window: its own clock from 0, and none of the old window's listeners. Watch it from the start.
    const onLoad = () => {
      stopWatch();
      stopWatch = watch(frame);
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      stopWatch();
    };
  }, [frame]);

  const flush = useCallback(() => flushRef.current(), []);
  const hold = useCallback((on: boolean) => {
    heldRef.current = on;
  }, []);
  return { warnings, checkedAt, flush, hold };
}
