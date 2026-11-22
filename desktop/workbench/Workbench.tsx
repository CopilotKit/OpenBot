import { useCallback, useEffect, useRef, useState } from "react";
import type { Call } from "../src/fakeNative/control";
import { COMMANDS } from "../src/fakeNative/registry";
import type { PageClock } from "./clock";
import { type FrameConfig, frameUrl } from "./frameConfig";
import { formatTime, RunControls, type Speed } from "./RunControls";
import { SceneList } from "./SceneList";
import { SCENES } from "./scenes";
import { decodeState, encodeState, type WorkbenchState } from "./urlState";
import { WindowFrame } from "./WindowFrame";
import {
  WindowSettingsPanel,
  type WindowSettingsValue,
} from "./WindowSettingsPanel";

declare global {
  interface Window {
    /** The workbench as tests and scripts drive it. */
    __workbenchPage?: WorkbenchPage;
  }
}

export type WorkbenchPage = {
  /** False while the window remounts; true after it loads and the clock is at its time. */
  readonly ready: boolean;
  readonly scene: string;
  /** Milliseconds from the scene start, on the window's clock. */
  now(): number;
  /** Resolves when the window is ready at `ms` and has drawn one frame. */
  seek(ms: number): Promise<void>;
  calls(): readonly Call[];
  /** True when the window has called `show_openbot` and the call did not fail. */
  handedOver(): boolean;
};

type RunInfo = { end: number; nextAt(ms: number): number | null };
type FrameWindow = Window & typeof globalThis;
/** The loaded window: its clock, its run, and how to stop listening to it. */
type Live = { win: FrameWindow; clock: PageClock; info: RunInfo; off(): void };

const BOOT_TIMEOUT_MS = 10_000;
/** The longest step of a walk. Steps fall on multiples of it, so every walk to a time takes the same steps. */
const WALK_STEP_MS = 500;
/** A window that keeps changing (a requestAnimationFrame loop) still lets a walk go on. */
const MAX_SETTLE_ROUNDS = 20;

/** Seconds, one decimal, as the URL keeps them. */
function toSeconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

function nextFrame(win: Window): Promise<void> {
  return new Promise((resolve) => win.requestAnimationFrame(() => resolve()));
}

/** One turn of the real event loop (the parent's timers are not on the page clock). */
function realTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Lets the window finish what the last timers started (answers, renders, effects) until its page stops changing. */
async function settle(win: FrameWindow): Promise<void> {
  let changed = true;
  const observer = new win.MutationObserver(() => {
    changed = true;
  });
  observer.observe(win.document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  try {
    for (let round = 0; changed && round < MAX_SETTLE_ROUNDS; round++) {
      changed = false;
      await realTurn();
      await realTurn();
    }
  } finally {
    observer.disconnect();
  }
}

/**
 * Takes the clock forward to `target`, stopping at each run step and at each multiple of
 * WALK_STEP_MS to let the window settle. One jump would run every step before the window draws
 * the screen the next step clicks on. False when `stopped` says a newer walk took over.
 */
async function walkTo(
  live: Live,
  target: number,
  stopped: () => boolean,
): Promise<boolean> {
  const { clock, info, win } = live;
  await settle(win);
  if (stopped()) return false;
  // Steps due now run before the first move.
  clock.advanceTo(clock.now());
  while (clock.now() < target) {
    await settle(win);
    if (stopped()) return false;
    const now = clock.now();
    const boundary = (Math.floor(now / WALK_STEP_MS) + 1) * WALK_STEP_MS;
    const mark = info.nextAt(now) ?? Number.POSITIVE_INFINITY;
    clock.advanceTo(Math.min(target, boundary, mark));
  }
  await settle(win);
  return !stopped();
}

/**
 * True when the window has handed over to OpenBot: it called `show_openbot`, and the answer for it
 * is not a fail answer. The call log does not record how a call ended, so a fallback that fails
 * (a state in `states.ts`) still counts.
 */
function handedOverIn(win: FrameWindow | undefined): boolean {
  const control = win?.__workbench;
  if (!control) return false;
  if (control.answers().get("show_openbot")?.mode === "fail") return false;
  return control.calls().some((call) => call.command === "show_openbot");
}

/** Waits until the window's boot script has set up its clock. */
async function booted(win: FrameWindow): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (!win.__workbenchBooted) {
    if (Date.now() > deadline || win.closed) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

// The grid color is page state and not in the URL. A color input takes only #rrggbb.
const DEFAULT_GRID_COLOR = "#ff00ff";

function initial(): { state: WorkbenchState; notices: string[] } {
  return decodeState(window.location.search, SCENES, COMMANDS);
}

/** The frame reads this object when it boots, so it is set before the iframe mounts. */
function frameConfig(state: WorkbenchState): FrameConfig {
  const scene = SCENES.find((s) => s.id === state.scene) ?? SCENES[0];
  return {
    hash: scene?.start.hash ?? "",
    search: scene?.start.search ?? "",
    os: state.window.os,
    env: { ...scene?.start.env, ...state.env },
    answers: { ...scene?.start.answers, ...state.answers },
    theme: state.window.theme,
  };
}

export function Workbench() {
  const [boot] = useState(initial);
  const [state, setState] = useState<WorkbenchState>(boot.state);
  const [notices, setNotices] = useState<string[]>(boot.notices);
  const [gridColor, setGridColor] = useState(DEFAULT_GRID_COLOR);
  const [remountCount, setRemountCount] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [now, setNow] = useState(0);
  const [end, setEnd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [handedOver, setHandedOver] = useState(false);
  /** The person closed the handover overlay. It shows again after the window hands over again. */
  const [overlayClosed, setOverlayClosed] = useState(false);
  const speedRef = useRef<Speed>(speed);
  speedRef.current = speed;
  const stateRef = useRef(state);
  stateRef.current = state;
  const liveRef = useRef<Live | null>(null);
  /** The time the next load goes to, when a seek back remounts the window. */
  const targetRef = useRef<number | null>(null);
  const readyRef = useRef(false);
  const waitersRef = useRef<
    { resolve: () => void; reject: (error: Error) => void }[]
  >([]);
  /** Set when the window did not start in time, so a later seek fails and does not wait. */
  const bootFailedRef = useRef(false);
  /** Counts walks of the clock, so a newer seek or remount stops an older walk. */
  const walkRef = useRef(0);

  const update = useCallback(
    (next: WorkbenchState | ((prev: WorkbenchState) => WorkbenchState)) => {
      setState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        window.history.replaceState(null, "", `?${encodeState(value)}`);
        return value;
      });
    },
    [],
  );

  const config = frameConfig(state);
  const scene = SCENES.find((s) => s.id === state.scene);
  const run = scene?.run ?? [];
  // Set during render, before the iframe element mounts and starts to load.
  window.__workbenchFrame = config;
  // A run, even an empty one, keeps the window from playing by itself.
  window.__workbenchRun = run;
  const frameKey = `${state.scene}|${state.window.os}|${JSON.stringify(config.env)}|${remountCount}`;

  const writeAt = useCallback(
    (ms: number) => update((prev) => ({ ...prev, at: toSeconds(ms) })),
    [update],
  );

  /** Marks the window ready and lets every waiting seek go on. */
  const markReady = useCallback(() => {
    readyRef.current = true;
    const waiters = waitersRef.current;
    waitersRef.current = [];
    for (const waiter of waiters) waiter.resolve();
  }, []);

  /** Reads again whether the window has handed over to OpenBot. */
  const checkHandover = useCallback(() => {
    const next = handedOverIn(liveRef.current?.win);
    setHandedOver(next);
    if (!next) setOverlayClosed(false);
  }, []);

  const detach = useCallback(() => {
    walkRef.current += 1;
    readyRef.current = false;
    liveRef.current?.off();
    liveRef.current = null;
    setPlaying(false);
    setHandedOver(false);
    setOverlayClosed(false);
  }, []);

  /** Takes the window's clock to `target` in short steps; false when a newer walk took over. */
  const walk = useCallback(async (live: Live, target: number) => {
    const id = ++walkRef.current;
    readyRef.current = false;
    const ok = await walkTo(live, target, () => walkRef.current !== id);
    return ok && walkRef.current === id;
  }, []);

  const attach = useCallback(
    async (iframe: HTMLIFrameElement) => {
      const win = iframe.contentWindow as FrameWindow | null;
      if (!win) return;
      bootFailedRef.current = false;
      if (!(await booted(win))) {
        // A newer frame took this one's place, or the window closed: not a timeout.
        if (frameRef.current !== iframe || win.closed) return;
        bootFailedRef.current = true;
        setNotices((all) => [
          ...all,
          "The window did not start in 10 seconds.",
        ]);
        const waiters = waitersRef.current;
        waitersRef.current = [];
        for (const waiter of waiters)
          waiter.reject(new Error("The window did not start in 10 seconds."));
        return;
      }
      // A newer frame took this one's place while it booted.
      if (frameRef.current !== iframe) return;
      const clock = win.__workbenchClock;
      const info = win.__workbenchRunInfo;
      if (!clock || !info) return;
      liveRef.current?.off();
      const target = targetRef.current ?? stateRef.current.at * 1000;
      targetRef.current = null;
      const hasRun =
        (SCENES.find((s) => s.id === stateRef.current.scene)?.run ?? [])
          .length > 0;
      const off = clock.onTick((ms) => {
        setNow(ms);
        checkHandover();
        // A run stops at its end, at every speed. A scene without a run plays on at 1×.
        if (hasRun && clock.playing() && ms >= info.end) {
          clock.pause();
          setPlaying(false);
          writeAt(ms);
        }
      });
      // The window can call show_openbot after the last tick (a render the last step started),
      // so a new call or answer reads the handover again too.
      const offChange = win.__workbench?.onChange((change) => {
        if (change.kind !== "emit") checkHandover();
      });
      const live = {
        win,
        clock,
        info,
        off: () => {
          off();
          offChange?.();
        },
      };
      liveRef.current = live;
      setEnd(info.end);
      if (!(await walk(live, target))) return;
      setNow(clock.now());
      checkHandover();
      if (target === 0 && !hasRun) {
        clock.play(1);
        setPlaying(true);
      } else setPlaying(false);
      markReady();
    },
    [checkHandover, markReady, walk, writeAt],
  );

  const whenReady = useCallback(async () => {
    if (!readyRef.current && bootFailedRef.current)
      throw new Error("The window did not start in 10 seconds.");
    if (!readyRef.current)
      await new Promise<void>((resolve, reject) =>
        waitersRef.current.push({ resolve, reject }),
      );
    const live = liveRef.current;
    await nextFrame(live?.win ?? window);
  }, []);

  const seek = useCallback(
    async (ms: number) => {
      const live = liveRef.current;
      // A seek lands paused.
      if (live?.clock.playing()) {
        live.clock.pause();
        setPlaying(false);
      }
      const target = Math.max(0, ms);
      writeAt(target);
      if (live && target >= live.clock.now()) {
        if (await walk(live, target)) {
          checkHandover();
          markReady();
        }
      } else {
        // The clock runs only forward: the window starts again and goes to the time.
        targetRef.current = target;
        bootFailedRef.current = false;
        detach();
        setRemountCount((count) => count + 1);
      }
      await whenReady();
    },
    [checkHandover, detach, markReady, walk, whenReady, writeAt],
  );

  useEffect(() => {
    window.__workbenchPage = {
      get ready() {
        return readyRef.current;
      },
      get scene() {
        return stateRef.current.scene;
      },
      now: () => liveRef.current?.clock.now() ?? 0,
      seek,
      calls: () => liveRef.current?.win.__workbench?.calls() ?? [],
      handedOver: () => handedOverIn(liveRef.current?.win),
    };
  }, [seek]);

  useEffect(
    () => () => {
      liveRef.current?.off();
      liveRef.current = null;
      delete window.__workbenchPage;
    },
    [],
  );

  const play = (next: Speed = speed) => {
    const clock = liveRef.current?.clock;
    if (!clock) return;
    clock.play(next === "max" ? Number.POSITIVE_INFINITY : next);
    setPlaying(true);
  };

  const pause = () => {
    const clock = liveRef.current?.clock;
    if (!clock) return;
    clock.pause();
    setPlaying(false);
    writeAt(clock.now());
  };

  const pickScene = (id: string) => {
    const scene = SCENES.find((s) => s.id === id);
    update((prev) => ({
      ...prev,
      scene: id,
      at: 0,
      answers: {},
      window: { ...prev.window, os: scene?.start.os ?? prev.window.os },
    }));
  };

  const changeWindow = (patch: Partial<WindowSettingsValue>) => {
    update((prev) => ({ ...prev, window: { ...prev.window, ...patch } }));
    if (patch.theme) {
      const win = frameRef.current?.contentWindow as
        | (Window & typeof globalThis)
        | null
        | undefined;
      win?.__workbenchSetTheme?.(patch.theme);
    }
  };

  return (
    <div className="wb-page">
      <aside className="wb-side wb-side-left">
        <SceneList scenes={SCENES} current={state.scene} onPick={pickScene} />
      </aside>
      <main className="wb-center">
        {notices.length > 0 && (
          <div className="wb-notices">
            {notices.map((text, index) => (
              <div
                // A notice has no id, and the list only shrinks.
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
                key={`${index}|${text}`}
                className="wb-notice"
                role="status"
              >
                <span>{text}</span>
                <button
                  type="button"
                  onClick={() =>
                    setNotices((all) => all.filter((_, i) => i !== index))
                  }
                >
                  Close
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="wb-stage">
          <WindowFrame
            src={frameUrl(config)}
            frameKey={frameKey}
            width={state.window.width}
            height={state.window.height}
            os={state.window.os}
            active={state.window.active}
            theme={state.window.theme}
            zoom={state.window.zoom}
            grid={state.window.grid}
            gridColor={gridColor}
            onFrame={(iframe) => {
              frameRef.current = iframe;
              if (iframe === null) detach();
              else void attach(iframe);
            }}
          />
          {handedOver && !overlayClosed && (
            // A sibling of the window, so a shot of the window does not show it.
            <section
              className="wb-handover"
              aria-labelledby="wb-handover-heading"
            >
              <div className="wb-handover-card">
                <h2 id="wb-handover-heading">OpenBot opens here</h2>
                <p>
                  The real window now shows OpenBot's own page. The workbench
                  shows only the setup window.
                </p>
                <button type="button" onClick={() => setOverlayClosed(true)}>
                  Show the setup window
                </button>
              </div>
            </section>
          )}
        </div>
        <div className="wb-under" />
      </main>
      <aside className="wb-side wb-side-right">
        {run.length > 0 ? (
          <RunControls
            now={now}
            end={end}
            marks={run.map((step) => step.at * 1000)}
            playing={playing}
            speed={speed}
            onPlay={() => play()}
            onPause={pause}
            onStep={() => {
              liveRef.current?.clock.stepToNext();
            }}
            onSeek={(ms) => {
              void seek(ms);
            }}
            onSpeed={(next) => {
              setSpeed(next);
              if (playing) play(next);
            }}
          />
        ) : (
          <div>{`Time ${formatTime(now)}`}</div>
        )}
        <WindowSettingsPanel
          value={state.window}
          gridColor={gridColor}
          onChange={changeWindow}
          onGridColor={setGridColor}
          onCopyLink={() => {
            void navigator.clipboard.writeText(window.location.href);
          }}
        />
      </aside>
    </div>
  );
}
