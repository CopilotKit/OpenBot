import { useCallback, useEffect, useRef, useState } from "react";
import type { Answer, Call, NativeControl } from "../src/fakeNative/control";
import {
  HANDBACK_COMMANDS,
  PAGE_COMMANDS,
} from "../src/fakeNative/pageRegistry";
import { COMMANDS } from "../src/fakeNative/registry";
import {
  type ActionMark,
  ActionMarkers,
  boxOverFrame,
  MARKER_MS,
} from "./ActionMarkers";
import { ApiAnswersPanel } from "./ApiAnswersPanel";
import type {
  ApiAnswer,
  ApiControl,
  ApiRecord,
  ApiRoute,
  SocketControl,
  StreamControl,
} from "./appContract";
import { appFrameConfig } from "./appFrameConfig";
import { CallLog } from "./CallLog";
import { CommandsPanel } from "./CommandsPanel";
import type { PageClock } from "./clock";
import { EventsPanel } from "./EventsPanel";
import { type FrameConfig, frameUrl } from "./frameConfig";
import { appSceneAfter, desktopSceneFor, HANDBACK_WORDS } from "./handover";
import { ImportLogPanel } from "./ImportLogPanel";
import "./appPanels.css";
import { describeElements, type Warning } from "./layoutWatch";
import { RequestLog } from "./RequestLog";
import { formatTime, RunControls, type Speed } from "./RunControls";
import {
  actionLabel,
  findTarget,
  playTo,
  type RunAction,
  runActions,
} from "./runner";
import { SceneList } from "./SceneList";
import { StreamPanel } from "./StreamPanel";
import {
  ALL_SCENE_GROUPS,
  type DesktopSceneEntry,
  isApp,
  loadScenes,
  type SceneEntry,
  sceneEnd,
  sceneSteps,
} from "./sceneCatalog";
import type { Scene } from "./scenes/types";
import {
  DEFAULT_APP,
  decodeState,
  encodeState,
  type WorkbenchState,
} from "./urlState";
import { useLayoutWatch } from "./useLayoutWatch";
import { WarningsList } from "./WarningsList";
import { WindowFrame } from "./WindowFrame";
import {
  type AppWindowSettings,
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
  /** "app" when the window shows OpenBot's web app, "desktop" for the setup window. */
  readonly kind: "desktop" | "app";
  /** Milliseconds from the scene start, on the window's clock. */
  now(): number;
  /**
   * Resolves when the window is ready at `ms` and has drawn one frame. An app window must also be
   * quiet: no request on its way, no route that loads and no change for two frames (at most 3 s).
   */
  seek(ms: number): Promise<void>;
  calls(): readonly Call[];
  /** True when the window has called `show_openbot` and the call resolved. */
  handedOver(): boolean;
  /** The handback command the app window called and that resolved, or null. */
  handedBack(): string | null;
  /** The layout warnings of the loaded window, oldest first. */
  warnings(): Warning[];
  /** The elements the layout warnings know in the loaded window, in document order. */
  elements(): ReturnType<typeof describeElements>;
  /** The `/api` requests of the loaded app window, oldest first. Empty for a desktop window. */
  requests(): readonly ApiRecord[];
  /** The errors the loaded app window caught. Empty for a desktop window. */
  errors(): readonly string[];
};

type RunInfo = { end: number; nextAt(ms: number): number | null };
type FrameWindow = Window & typeof globalThis;
/** The loaded window: its clock, its run, whether it shows the app, and how to stop listening to it. */
type Live = {
  win: FrameWindow;
  clock: PageClock;
  info: RunInfo;
  app: boolean;
  off(): void;
};

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

/** Animation frames in a row without a change after which an app frame is quiet. */
const QUIET_FRAMES = 2;
/** The longest real time a stop waits for an app frame to be quiet. Then the walk goes on. */
const QUIET_LIMIT_MS = 3000;
/** A frame that does not draw (a hidden tab) still lets the quiet wait count. */
const FRAME_FALLBACK_MS = 100;

/** One animation frame of the window, or FRAME_FALLBACK_MS of real time when it does not draw. */
function frameOrFallback(win: Window): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FRAME_FALLBACK_MS);
    win.requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** True when an API route ("GET /api/x/:id", "ALL /api/*") matches a request. */
function routeMatches(route: string, method: string, path: string): boolean {
  const space = route.indexOf(" ");
  const routeMethod = route.slice(0, space);
  if (routeMethod !== "ALL" && routeMethod !== method) return false;
  const pattern = route
    .slice(space + 1)
    .split("/")
    .map((part) =>
      part === "*"
        ? ".*"
        : part.startsWith(":")
          ? "[^/]+"
          : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  const pathname = path.split("?")[0] ?? path;
  return new RegExp(`^${pattern}$`).test(pathname);
}

/**
 * True when a pending request waits on the page clock or on a person: its answer is "delay" or
 * "never". Moving the clock (or a new answer) ends the wait, so the quiet wait does not wait for it.
 */
function waitsOnClock(
  record: ApiRecord,
  answers: readonly (readonly [string, ApiAnswer])[],
): boolean {
  // The newest answer wins, as in the fake API.
  for (let i = answers.length - 1; i >= 0; i--) {
    const [route, answer] = answers[i];
    if (!routeMatches(route, record.method, record.path)) continue;
    return answer.mode === "delay" || answer.mode === "never";
  }
  return false;
}

type RouterLike = { state?: { status?: string; isLoading?: boolean } };

/**
 * True while the app frame still works on real time: a request to the fake API is on its way, or
 * the router loads a route (its chunks come from the dev server). A request or a native call that
 * waits on the clock is not work on real time, and a router that waits on one is not either.
 */
function frameBusy(win: FrameWindow): boolean {
  const api = win.__workbenchApi;
  const answers = api ? [...api.answers()] : [];
  let waitsForClock = false;
  for (const record of api?.requests() ?? []) {
    if (record.state !== "pending") continue;
    if (!waitsOnClock(record, answers)) return true;
    waitsForClock = true;
  }
  // A native call ends in the same task unless its answer waits on the clock or never comes.
  if (win.__workbench?.calls().some((call) => call.settled === undefined))
    waitsForClock = true;
  const router = (win as { __TSR_ROUTER__?: RouterLike }).__TSR_ROUTER__;
  const loading =
    router?.state?.status === "pending" || router?.state?.isLoading === true;
  return loading && !waitsForClock;
}

/**
 * Waits until an app frame is quiet: no request on its way, no route that loads, and no change to
 * its page, its requests or its loaded files for QUIET_FRAMES animation frames in a row. The app
 * does that work on real time (a fetch that resolves, a route chunk, React commits), and the clock
 * must not move while it runs: a timer that the work starts must start at the same clock time
 * each way the walk gets there. False when the frame was not quiet after QUIET_LIMIT_MS.
 */
async function waitQuiet(
  win: FrameWindow,
  stopped: () => boolean,
): Promise<boolean> {
  let changed = false;
  const mark = () => {
    changed = true;
  };
  const observer = new win.MutationObserver(mark);
  observer.observe(win.document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  const offApi = win.__workbenchApi?.onChange(mark);
  let files: PerformanceObserver | null = null;
  try {
    files = new win.PerformanceObserver(mark);
    files.observe({ type: "resource" });
  } catch {
    files = null;
  }
  const deadline = Date.now() + QUIET_LIMIT_MS;
  try {
    let quietFrames = 0;
    while (quietFrames < QUIET_FRAMES) {
      if (stopped()) return true;
      if (Date.now() > deadline) return false;
      await frameOrFallback(win);
      if (changed || frameBusy(win)) {
        changed = false;
        quietFrames = 0;
      } else quietFrames++;
    }
    return true;
  } finally {
    observer.disconnect();
    offApi?.();
    files?.disconnect();
  }
}

/** What a walk tells the page at each stop. */
type WalkHooks = {
  /** True when a newer walk took over. */
  stopped(): boolean;
  /** The clock stopped and the window settled. */
  onStop(): void;
  /** An app frame was still not quiet after QUIET_LIMIT_MS at this clock time. */
  onNotQuiet(ms: number): void;
};

/** Lets the window settle at a stop: a desktop window until its page stops changing, an app window until it is quiet. */
async function settleStop(live: Live, hooks: WalkHooks): Promise<void> {
  if (!live.app) {
    await settle(live.win);
    return;
  }
  if (!(await waitQuiet(live.win, hooks.stopped)) && !hooks.stopped())
    hooks.onNotQuiet(live.clock.now());
}

/**
 * Takes the clock forward to `target`, stopping at each run step and at each multiple of
 * WALK_STEP_MS to let the window settle. One jump would run every step before the window draws
 * the screen the next step clicks on. False when `stopped` says a newer walk took over.
 */
async function walkTo(
  live: Live,
  target: number,
  hooks: WalkHooks,
): Promise<boolean> {
  const { clock, info } = live;
  const { stopped, onStop } = hooks;
  await settleStop(live, hooks);
  if (stopped()) return false;
  onStop();
  // Steps due now run before the first move.
  clock.advanceTo(clock.now());
  while (clock.now() < target) {
    await settleStop(live, hooks);
    if (stopped()) return false;
    onStop();
    const now = clock.now();
    const boundary = (Math.floor(now / WALK_STEP_MS) + 1) * WALK_STEP_MS;
    const mark = info.nextAt(now) ?? Number.POSITIVE_INFINITY;
    clock.advanceTo(Math.min(target, boundary, mark));
  }
  await settleStop(live, hooks);
  if (stopped()) return false;
  onStop();
  return true;
}

/** True when the window has handed over to OpenBot: a call to `show_openbot` resolved. */
/** The buttons of a handover or handback card, in one row (workbench.css styles one button). */
const HANDOVER_ACTIONS = { display: "flex", gap: 8, flexWrap: "wrap" } as const;

const HANDBACK: readonly string[] = HANDBACK_COMMANDS;

/** True for a call of a handback command that resolved: the app handed back to OpenBot Desktop. */
function isHandback(call: Call): boolean {
  return call.settled === "resolved" && HANDBACK.includes(call.command);
}

function handedOverIn(win: FrameWindow | undefined): boolean {
  const control = win?.__workbench;
  if (!control) return false;
  return control
    .calls()
    .some(
      (call) => call.command === "show_openbot" && call.settled === "resolved",
    );
}

/** True for a field that takes typed text, where the C key must type a letter. */
function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  return ![
    "button",
    "checkbox",
    "radio",
    "range",
    "color",
    "submit",
    "reset",
    "image",
    "file",
  ].includes(type);
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

/** Where the scenes imported in the page are kept, for this browser tab only. */
const IMPORTED_KEY = "workbench.imported";

function loadImported(): Scene[] {
  try {
    const raw = window.sessionStorage.getItem(IMPORTED_KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    return value.filter(
      (scene): scene is Scene =>
        typeof scene === "object" &&
        scene !== null &&
        typeof scene.id === "string" &&
        typeof scene.title === "string" &&
        typeof scene.start === "object" &&
        scene.start !== null,
    );
  } catch {
    return [];
  }
}

function saveImported(scenes: readonly Scene[]): void {
  try {
    window.sessionStorage.setItem(IMPORTED_KEY, JSON.stringify(scenes));
  } catch {
    // The scenes still work until the page closes.
  }
}

function initial(catalog: readonly SceneEntry[]): {
  state: WorkbenchState;
  notices: string[];
  imported: Scene[];
} {
  const imported = loadImported();
  return {
    ...decodeState(
      window.location.search,
      [...catalog, ...imported],
      [...COMMANDS, ...PAGE_COMMANDS],
    ),
    imported,
  };
}

/** Waits for the fonts of an app window, so its text has its final boxes. */
async function fontsReady(live: Live): Promise<void> {
  if (!live.app) return;
  try {
    await live.win.document.fonts?.ready;
  } catch {
    // A font that does not load leaves the fallback font: the window is still ready.
  }
}

/** The desktop frame reads this object when it boots, so it is set before the iframe mounts. */
function frameConfig(
  state: WorkbenchState,
  scenes: readonly DesktopSceneEntry[],
): FrameConfig {
  const scene = scenes.find((s) => s.id === state.scene) ?? scenes[0];
  return {
    hash: scene?.start.hash ?? "",
    search: scene?.start.search ?? "",
    os: state.window.os,
    env: { ...scene?.start.env, ...state.env },
    answers: { ...scene?.start.answers, ...state.answers },
    theme: state.window.theme,
  };
}

type Catalog = { scenes: SceneEntry[]; notices: string[] };

/** Loads the scene catalog once, then shows the workbench. */
export function Workbench() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const loadRef = useRef<Promise<Catalog> | null>(null);
  useEffect(() => {
    let current = true;
    loadRef.current ??= loadScenes();
    void loadRef.current.then((loaded) => {
      if (current) setCatalog(loaded);
    });
    return () => {
      current = false;
    };
  }, []);
  if (!catalog)
    return (
      <div className="wb-page">
        <p role="status">Loading scenes…</p>
      </div>
    );
  return (
    <WorkbenchLoaded
      catalog={catalog.scenes}
      catalogNotices={catalog.notices}
    />
  );
}

export type WorkbenchLoadedProps = {
  /** The desktop scenes, then the app scenes. */
  catalog: readonly SceneEntry[];
  /** What went wrong while the app scenes loaded. */
  catalogNotices: readonly string[];
};

export function WorkbenchLoaded({
  catalog,
  catalogNotices,
}: WorkbenchLoadedProps) {
  const [boot] = useState(() => initial(catalog));
  const [state, setState] = useState<WorkbenchState>(boot.state);
  /** Scenes made from logs in this page: only in this browser tab, and not in links elsewhere. */
  const [imported, setImported] = useState<Scene[]>(boot.imported);
  const scenes: readonly SceneEntry[] = [...catalog, ...imported];
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const [notices, setNotices] = useState<string[]>(() => [
    ...catalogNotices,
    ...boot.notices,
  ]);
  const [gridColor, setGridColor] = useState(DEFAULT_GRID_COLOR);
  const [remountCount, setRemountCount] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [now, setNow] = useState(0);
  const [end, setEnd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  /** "Pause at each action": a play stops just before each click and type step. */
  const [pauseAtActions, setPauseAtActions] = useState(false);
  const pauseAtActionsRef = useRef(pauseAtActions);
  pauseAtActionsRef.current = pauseAtActions;
  /** The markers of the actions the bot just did; each goes after MARKER_MS of real time. */
  const [marks, setMarks] = useState<ActionMark[]>([]);
  /** The action a play with "Pause at each action" stopped before. */
  const [nextAction, setNextAction] = useState<ActionMark | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const markIdRef = useRef(0);
  const markTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  /** Set while the workbench plays the clock itself, to stop at each action. */
  const loopRef = useRef<{
    kind: "timer" | "walk";
    handle: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  /** Set while the Step button runs a step, so its action shows a marker. */
  const steppingRef = useRef(false);
  const [handedOver, setHandedOver] = useState(false);
  /** The person closed the handover overlay. It shows again after the window hands over again. */
  const [overlayClosed, setOverlayClosed] = useState(false);
  /** The handback command the app window called, or null. A remount clears it. */
  const [handedBack, setHandedBack] = useState<string | null>(null);
  const handedBackRef = useRef<string | null>(null);
  /** The person closed the handback card. */
  const [handbackClosed, setHandbackClosed] = useState(false);
  /** Comment mode: a click or a drag in the window picks what a comment is about. */
  const [commenting, setCommenting] = useState(false);
  /** The loaded window, as state, so the C key also works with the focus in it. */
  const [frameEl, setFrameEl] = useState<HTMLIFrameElement | null>(null);
  /** The loaded window's fake native side, for the commands, calls and events panels. */
  const [frameControl, setFrameControl] = useState<NativeControl | null>(null);
  /** The loaded app window's fake API, streams and sockets, for the app panels. */
  const [frameApi, setFrameApi] = useState<ApiControl | null>(null);
  const [frameStreams, setFrameStreams] = useState<StreamControl | null>(null);
  const [frameSockets, setFrameSockets] = useState<SocketControl | null>(null);
  /** The route the Requests panel picked, for the API answers panel. */
  const [pickedRoute, setPickedRoute] = useState<ApiRoute | null>(null);
  const answersFoldRef = useRef<HTMLDetailsElement | null>(null);
  const {
    warnings,
    flush: checkLayout,
    hold: holdLayout,
  } = useLayoutWatch(frameEl, {
    width: state.window.width,
    height: state.window.height,
  });
  const warningsRef = useRef(warnings);
  warningsRef.current = warnings;
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

  const scene = scenes.find((s) => s.id === state.scene);
  const appScene = scene && isApp(scene) ? scene : null;
  const steps = scene ? sceneSteps(scene) : [];
  const runEnd = scene ? sceneEnd(scene) : 0;
  const actionsRef = useRef(runActions(steps));
  actionsRef.current = runActions(steps);
  // Set during render, before the iframe element mounts and starts to load.
  let config: FrameConfig | null = null;
  const appConfig = appScene ? appFrameConfig(state, appScene) : null;
  if (appScene && appConfig) {
    // The app frame finds its run in the app scenes by id.
    window.__workbenchAppFrame = appConfig;
    delete window.__workbenchRun;
  } else {
    config = frameConfig(
      state,
      scenes.filter((s): s is DesktopSceneEntry => !isApp(s)),
    );
    delete window.__workbenchAppFrame;
    window.__workbenchFrame = config;
    // A run, even an empty one, keeps the window from playing by itself.
    window.__workbenchRun = scene && !isApp(scene) ? (scene.run ?? []) : [];
  }
  const kind = appConfig ? "app" : "desktop";
  const host = appConfig?.host ?? "desktop";
  const frameKey = `${state.scene}|${state.window.os}|${JSON.stringify(config?.env ?? {})}|${remountCount}|${kind}|${host}|${appConfig?.role ?? ""}|${appConfig?.motion ?? ""}`;

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

  /** Stops the workbench's own play loop, if one runs. */
  const stopLoop = useCallback(() => {
    const loop = loopRef.current;
    loopRef.current = null;
    if (loop?.handle != null) clearTimeout(loop.handle);
    return loop;
  }, []);

  /** The box of an element of the window, over the window, in the wrapper's coordinates. */
  const boxOf = useCallback((target: Element | null) => {
    const wrap = wrapRef.current;
    const iframe = frameRef.current;
    if (!target || !wrap || !iframe) return null;
    return boxOverFrame(wrap, iframe, target, stateRef.current.window.width);
  }, []);

  /** Shows a marker over what an action acted on, for MARKER_MS of real time. */
  const showAction = useCallback(
    (action: RunAction) => {
      const id = ++markIdRef.current;
      const mark = {
        id,
        label: actionLabel(action),
        box: boxOf(action.target),
      };
      setMarks((all) => [...all, mark]);
      // The parent's own timer: the window's clock does not move it.
      const timer = setTimeout(() => {
        markTimersRef.current.delete(timer);
        setMarks((all) => all.filter((m) => m.id !== id));
      }, MARKER_MS);
      markTimersRef.current.add(timer);
    },
    [boxOf],
  );

  const detach = useCallback(() => {
    stopLoop();
    setNextAction(null);
    walkRef.current += 1;
    holdLayout(false);
    readyRef.current = false;
    liveRef.current?.off();
    liveRef.current = null;
    setFrameControl(null);
    setFrameApi(null);
    setFrameStreams(null);
    setFrameSockets(null);
    setPlaying(false);
    setHandedOver(false);
    setOverlayClosed(false);
    handedBackRef.current = null;
    setHandedBack(null);
    setHandbackClosed(false);
  }, [holdLayout, stopLoop]);

  /** Tells the person once per clock time that a shot there can show a screen that still draws. */
  const noteNotQuiet = useCallback((ms: number) => {
    const text = `The app window still changed after 3 seconds at ${formatTime(ms)}. A shot or check at this time can show a screen that is not fully drawn.`;
    console.warn(text);
    setNotices((all) => (all.includes(text) ? all : [...all, text]));
  }, []);

  /** Takes the window's clock to `target` in short steps; false when a newer walk took over. */
  const walk = useCallback(
    async (live: Live, target: number) => {
      const id = ++walkRef.current;
      readyRef.current = false;
      // The layout is checked at each stop of the walk, and not at frames in between.
      holdLayout(true);
      try {
        const ok = await walkTo(live, target, {
          stopped: () => walkRef.current !== id,
          onStop: checkLayout,
          onNotQuiet: noteNotQuiet,
        });
        return ok && walkRef.current === id;
      } finally {
        if (walkRef.current === id) holdLayout(false);
      }
    },
    [checkLayout, holdLayout, noteNotQuiet],
  );

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
      const current = scenesRef.current.find(
        (s) => s.id === stateRef.current.scene,
      );
      const hasRun = current ? sceneSteps(current).length > 0 : false;
      const app = current ? isApp(current) : false;
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
        // An app button that hands back to OpenBot Desktop.
        if (app && change.kind === "settled" && isHandback(change.call)) {
          handedBackRef.current = change.call.command;
          setHandedBack(change.call.command);
          setHandbackClosed(false);
        }
      });
      if (app) {
        // A handback before this listener started (the window boots before attach).
        const earlier = win.__workbench?.calls().find(isHandback);
        handedBackRef.current = earlier?.command ?? null;
        setHandedBack(handedBackRef.current);
      }
      // A marker shows each action of a play or a step. A seek (and so a CLI shot) shows none.
      const offActions = win.__workbenchActions?.subscribe((action) => {
        if (clock.playing() || loopRef.current || steppingRef.current)
          showAction(action);
      });
      setFrameControl(win.__workbench ?? null);
      setFrameApi(win.__workbenchApi ?? null);
      setFrameStreams(win.__workbenchStreams ?? null);
      setFrameSockets(win.__workbenchSockets ?? null);
      const live: Live = {
        win,
        clock,
        info,
        app,
        off: () => {
          off();
          offChange?.();
          offActions?.();
        },
      };
      liveRef.current = live;
      setEnd(info.end);
      if (!(await walk(live, target))) return;
      await fontsReady(live);
      if (liveRef.current !== live) return;
      setNow(clock.now());
      checkHandover();
      if (target === 0 && !hasRun) {
        clock.play(1);
        setPlaying(true);
      } else setPlaying(false);
      markReady();
    },
    [checkHandover, markReady, showAction, walk, writeAt],
  );

  const whenReady = useCallback(async () => {
    if (!readyRef.current && bootFailedRef.current)
      throw new Error("The window did not start in 10 seconds.");
    if (!readyRef.current)
      await new Promise<void>((resolve, reject) =>
        waitersRef.current.push({ resolve, reject }),
      );
    const live = liveRef.current;
    if (live) await fontsReady(live);
    // An app frame does work on real time after the clock stops: ready only when it is quiet.
    if (live?.app) {
      const quiet = await waitQuiet(live.win, () => liveRef.current !== live);
      if (!quiet && liveRef.current === live) noteNotQuiet(live.clock.now());
    }
    await nextFrame(live?.win ?? window);
  }, [noteNotQuiet]);

  const seek = useCallback(
    async (ms: number) => {
      const live = liveRef.current;
      // A seek lands paused.
      setNextAction(null);
      if (stopLoop()) setPlaying(false);
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
    [checkHandover, detach, markReady, stopLoop, walk, whenReady, writeAt],
  );

  useEffect(() => {
    window.__workbenchPage = {
      get ready() {
        return readyRef.current;
      },
      get scene() {
        return stateRef.current.scene;
      },
      get kind() {
        const id = stateRef.current.scene;
        const current = scenesRef.current.find((s) => s.id === id);
        return current && isApp(current) ? "app" : "desktop";
      },
      now: () => liveRef.current?.clock.now() ?? 0,
      seek,
      calls: () => liveRef.current?.win.__workbench?.calls() ?? [],
      handedOver: () => handedOverIn(liveRef.current?.win),
      handedBack: () => handedBackRef.current,
      warnings: () => [...warningsRef.current],
      elements: () => {
        const doc = frameRef.current?.contentDocument;
        return doc ? describeElements(doc) : [];
      },
      requests: () => liveRef.current?.win.__workbenchApi?.requests() ?? [],
      errors: () => [...(liveRef.current?.win.__workbenchErrors ?? [])],
    };
  }, [seek]);

  useEffect(() => {
    const markTimers = markTimersRef.current;
    return () => {
      liveRef.current?.off();
      liveRef.current = null;
      for (const timer of markTimers) clearTimeout(timer);
      markTimers.clear();
      delete window.__workbenchPage;
    };
  }, []);

  // C turns Comment mode on and off, when the focus is not in a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "c" && event.key !== "C") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || isTextField(event.target)) return;
      event.preventDefault();
      setCommenting((on) => !on);
    };
    const doc = frameEl?.contentDocument;
    window.addEventListener("keydown", onKey);
    doc?.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      doc?.removeEventListener("keydown", onKey);
    };
  }, [frameEl]);

  /** Ends a play of the workbench's own loop. */
  const endLoop = (live: Live) => {
    stopLoop();
    setPlaying(false);
    setNow(live.clock.now());
    writeAt(live.clock.now());
  };

  /** Stops 1 ms before the action at `at`, and outlines what it will act on. */
  const stopBefore = (live: Live, at: number) => {
    endLoop(live);
    const action = actionsRef.current.find((a) => a.at === at);
    if (!action) return;
    // One frame, so the window has drawn what the steps before it changed.
    void nextFrame(live.win).then(() => {
      if (liveRef.current !== live || live.clock.now() !== at - 1) return;
      const target = findTarget(live.win.document, action);
      setNextAction({
        id: 0,
        label: actionLabel(action),
        box: boxOf(target),
      });
    });
  };

  /** Plays the clock, and stops before each action of the run: see playTo. */
  const playWithStops = (live: Live, next: Speed) => {
    const times = actionsRef.current.map((a) => a.at);
    const end = live.info.end;
    if (next === "max") {
      // As fast as the window can draw: a walk, as a seek does.
      loopRef.current = { kind: "walk", handle: null };
      const { to, stopAt } = playTo(live.clock.now(), end, times);
      void walk(live, to).then((ok) => {
        if (!ok || loopRef.current?.kind !== "walk") return;
        checkHandover();
        markReady();
        if (stopAt !== null) stopBefore(live, stopAt);
        else endLoop(live);
      });
      return;
    }
    let last = performance.now();
    const tick = () => {
      const loop = loopRef.current;
      if (!loop || liveRef.current !== live) return;
      loop.handle = null;
      const real = performance.now();
      const now = live.clock.now();
      const wanted = Math.min(end, now + (real - last) * next);
      last = real;
      const { to, stopAt } = playTo(now, wanted, times);
      live.clock.advanceTo(to);
      if (stopAt !== null && live.clock.now() >= to) stopBefore(live, stopAt);
      else if (live.clock.now() >= end) endLoop(live);
      else loop.handle = setTimeout(tick, 16);
    };
    loopRef.current = { kind: "timer", handle: setTimeout(tick, 0) };
  };

  const play = (next: Speed = speed) => {
    const live = liveRef.current;
    if (!live) return;
    const { clock } = live;
    setNextAction(null);
    stopLoop();
    clock.pause();
    setPlaying(true);
    if (pauseAtActionsRef.current && actionsRef.current.length > 0)
      playWithStops(live, next);
    else clock.play(next === "max" ? Number.POSITIVE_INFINITY : next);
  };

  const pause = () => {
    const clock = liveRef.current?.clock;
    if (!clock) return;
    if (stopLoop()?.kind === "walk") {
      // Stops the walk, and lets the window take seeks again.
      walkRef.current += 1;
      holdLayout(false);
      markReady();
    }
    clock.pause();
    setPlaying(false);
    writeAt(clock.now());
  };

  const pickScene = (id: string) => {
    const scene = scenesRef.current.find((s) => s.id === id);
    setPickedRoute(null);
    update((prev) => ({
      ...prev,
      scene: id,
      at: 0,
      answers: {},
      api: {},
      // The host and the motion stay; the role is the scene's again.
      app: prev.app ? { ...prev.app, role: null } : prev.app,
      window: { ...prev.window, os: scene?.start.os ?? prev.window.os },
    }));
  };

  /** The commands panel already set the answer on the live window: keep it for the URL and the next remount. */
  const keepAnswer = (command: string, answer: Answer) => {
    update((prev) => ({
      ...prev,
      answers: { ...prev.answers, [command]: answer },
    }));
    const frame = window.__workbenchFrame;
    if (frame) frame.answers = { ...frame.answers, [command]: answer };
    const appFrame = window.__workbenchAppFrame;
    if (appFrame) appFrame.answers = { ...appFrame.answers, [command]: answer };
  };

  /** The API answers panel already set the answer on the live window: keep it for the URL and the next remount. */
  const keepApi = (route: ApiRoute, answer: ApiAnswer | null) => {
    const apply = (
      all: Partial<Record<ApiRoute, ApiAnswer>> | undefined,
    ): Partial<Record<ApiRoute, ApiAnswer>> => {
      const next = { ...all };
      if (answer === null) delete next[route];
      else next[route] = answer;
      return next;
    };
    update((prev) => ({ ...prev, api: apply(prev.api) }));
    const appFrame = window.__workbenchAppFrame;
    if (appFrame) appFrame.api = apply(appFrame.api);
  };

  /** A new host, role or motion remounts the window (the frame key has them). */
  const changeApp = (patch: Partial<AppWindowSettings>) => {
    update((prev) => {
      return { ...prev, app: { ...(prev.app ?? DEFAULT_APP), ...patch } };
    });
  };

  /** The desktop scene the handback card opens, when the workbench has it. */
  const handbackTarget =
    handedBack === null ? null : desktopSceneFor(handedBack);
  const handbackScene =
    handbackTarget !== null && scenes.some((s) => s.id === handbackTarget)
      ? handbackTarget
      : null;
  /** The app scene the handover card opens, when the workbench has it. */
  const openbotTarget = appSceneAfter(state.scene);
  const openbotScene = scenes.some((s) => s.id === openbotTarget)
    ? openbotTarget
    : null;

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
        <ImportLogPanel
          scenes={imported}
          current={state.scene}
          onImport={(scene) => {
            const next = [...imported.filter((s) => s.id !== scene.id), scene];
            setImported(next);
            saveImported(next);
            // A new scene of the same id loads again.
            setRemountCount((count) => count + 1);
            scenesRef.current = [...catalog, ...next];
            pickScene(scene.id);
          }}
          onPick={pickScene}
        />
        <SceneList
          scenes={catalog}
          current={state.scene}
          onPick={pickScene}
          groups={ALL_SCENE_GROUPS}
        />
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
          <div className="wb-window-wrap" ref={wrapRef}>
            <WindowFrame
              src={config ? frameUrl(config) : (appScene?.start.route ?? "/")}
              frameKey={frameKey}
              host={host}
              address={appScene?.start.route}
              width={state.window.width}
              height={state.window.height}
              os={state.window.os}
              active={state.window.active}
              theme={state.window.theme}
              zoom={state.window.zoom}
              grid={state.window.grid}
              gridColor={gridColor}
              comment={
                commenting && scene
                  ? {
                      scene: { id: scene.id, title: scene.title },
                      atSeconds: toSeconds(now),
                      window: state.window,
                    }
                  : null
              }
              onFrame={(iframe) => {
                frameRef.current = iframe;
                setFrameEl(iframe);
                if (iframe === null) detach();
                else void attach(iframe);
              }}
            />
            <ActionMarkers marks={marks} next={nextAction} />
          </div>
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
                <div className="wb-handover-actions" style={HANDOVER_ACTIONS}>
                  {openbotScene !== null && (
                    <button
                      type="button"
                      onClick={() => pickScene(openbotScene)}
                    >
                      Open OpenBot
                    </button>
                  )}
                  <button type="button" onClick={() => setOverlayClosed(true)}>
                    Show the setup window
                  </button>
                </div>
              </div>
            </section>
          )}
          {appScene && handedBack !== null && !handbackClosed && (
            // A sibling of the window, as the handover card, so a shot of the window does not show it.
            <section
              className="wb-handover"
              aria-labelledby="wb-handback-heading"
            >
              <div className="wb-handover-card">
                <h2 id="wb-handback-heading">
                  OpenBot Desktop shows its setup window here
                </h2>
                <p>
                  The app asked OpenBot Desktop to{" "}
                  {HANDBACK_WORDS[handedBack] ?? handedBack}. The real window
                  now shows the setup window.
                </p>
                <div className="wb-handover-actions" style={HANDOVER_ACTIONS}>
                  {handbackScene !== null && (
                    <button
                      type="button"
                      onClick={() => pickScene(handbackScene)}
                    >
                      Open the setup window
                    </button>
                  )}
                  <button type="button" onClick={() => setHandbackClosed(true)}>
                    Show OpenBot
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
        <div className="wb-under">
          <WarningsList
            warnings={warnings}
            onSeek={(ms) => {
              void seek(ms);
            }}
          />
        </div>
      </main>
      <aside className="wb-side wb-side-right">
        <section className="wb-comment-toggle">
          <button
            type="button"
            aria-pressed={commenting}
            aria-keyshortcuts="C"
            title="Comment (C)"
            onClick={() => setCommenting((on) => !on)}
          >
            Comment
          </button>
          <p>
            {commenting
              ? "Click an element or drag over an area in the window. Press C to stop."
              : "Press C to comment on a part of the window."}
          </p>
        </section>
        {steps.length > 0 ? (
          <RunControls
            now={now}
            end={end || runEnd * 1000}
            marks={steps.map((step) => step.at * 1000)}
            playing={playing}
            speed={speed}
            onPlay={() => play()}
            onPause={pause}
            onStep={() => {
              setNextAction(null);
              steppingRef.current = true;
              try {
                liveRef.current?.clock.stepToNext();
              } finally {
                steppingRef.current = false;
              }
            }}
            onSeek={(ms) => {
              void seek(ms);
            }}
            onSpeed={(next) => {
              setSpeed(next);
              if (playing) play(next);
            }}
            pauseAtActions={pauseAtActions}
            onPauseAtActions={(on) => {
              setPauseAtActions(on);
              pauseAtActionsRef.current = on;
              if (!on) setNextAction(null);
              if (playing) play();
            }}
            next={nextAction?.label ?? null}
          />
        ) : (
          <div>{`Time ${formatTime(now)}`}</div>
        )}
        <WindowSettingsPanel
          value={state.window}
          gridColor={gridColor}
          onChange={changeWindow}
          onGridColor={setGridColor}
          app={
            appConfig
              ? {
                  host: appConfig.host,
                  role: appConfig.role,
                  motion: appConfig.motion,
                }
              : undefined
          }
          onAppChange={appConfig ? changeApp : undefined}
          onCopyLink={() => {
            void navigator.clipboard.writeText(window.location.href);
            if (imported.some((s) => s.id === state.scene))
              setNotices((all) => [
                ...all,
                "This scene comes from a log you imported. It is only in this browser tab, so the link does not open it in another browser. To keep it, use Save for agents.",
              ]);
          }}
        />
        {appConfig ? (
          <>
            <details className="wb-fold">
              <summary>
                {`Desktop commands (${Object.keys(state.answers).join(", ") || "none set"})`}
              </summary>
              <CommandsPanel
                control={frameControl}
                onAnswer={keepAnswer}
                commands={PAGE_COMMANDS}
              />
            </details>
            <details className="wb-fold">
              <summary>Calls</summary>
              <CallLog control={frameControl} />
            </details>
            <details className="wb-fold wb-app-fold">
              <summary>Requests</summary>
              <RequestLog
                api={frameApi}
                onPick={(route) => {
                  setPickedRoute(route);
                  if (answersFoldRef.current)
                    answersFoldRef.current.open = true;
                }}
              />
            </details>
            <details className="wb-fold wb-app-fold" ref={answersFoldRef}>
              <summary>API answers</summary>
              <ApiAnswersPanel
                api={frameApi}
                picked={pickedRoute}
                onAnswer={keepApi}
              />
            </details>
            <details className="wb-fold wb-app-fold">
              <summary>Stream and sockets</summary>
              <StreamPanel streams={frameStreams} sockets={frameSockets} />
            </details>
          </>
        ) : (
          <>
            <details className="wb-fold">
              <summary>
                {`Commands (${Object.keys(state.answers).join(", ") || "none set"})`}
              </summary>
              <CommandsPanel control={frameControl} onAnswer={keepAnswer} />
            </details>
            <details className="wb-fold">
              <summary>Calls</summary>
              <CallLog control={frameControl} />
            </details>
            <details className="wb-fold">
              <summary>Events</summary>
              <EventsPanel control={frameControl} />
            </details>
          </>
        )}
      </aside>
    </div>
  );
}
