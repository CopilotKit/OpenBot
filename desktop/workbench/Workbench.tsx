import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  followMarks,
  followTarget,
  MARKER_MS,
  sameBox,
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
import { buildScreenPrompt } from "./askPrompt";
import { CallLog } from "./CallLog";
import { CommandsPanel } from "./CommandsPanel";
import { copyText } from "./clipboard";
import type { PageClock } from "./clock";
import { CRITIQUE_COMMANDS, type CritiqueCommand } from "./critiquePrompt";
import { EventsPanel } from "./EventsPanel";
import { type FrameConfig, frameUrl } from "./frameConfig";
import { appSceneAfter, desktopSceneFor, HANDBACK_WORDS } from "./handover";
import { ImportLogPanel } from "./ImportLogPanel";
import "./appPanels.css";
import {
  classifyMoves,
  type Mark,
  type Movement,
  matchWarning,
  parseMark,
  userActions,
} from "./findings";
import { KeysHelp } from "./KeysHelp";
import { describeElements, type ScreenMark, type Warning } from "./layoutWatch";
import { pickArea } from "./pickElement";
import { RequestLog } from "./RequestLog";
import { formatTime, RunControls, type Speed } from "./RunControls";
import {
  actionLabel,
  findTarget,
  playTo,
  type RunAction,
  runActions,
} from "./runner";
import { SceneList, type SceneListHandle } from "./SceneList";
import { Splitter } from "./Splitter";
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
import { resolveTarget } from "./sourceLines";
import { windowButtonsBox } from "./titleBar";
import {
  DEFAULT_APP,
  decodeState,
  encodeState,
  type WorkbenchState,
} from "./urlState";
import { useLayoutWatch } from "./useLayoutWatch";
import { clamp, isNumber, readPref, writePref } from "./viewerPrefs";
import {
  type FrameOrigin,
  frameOrigin,
  stillHtml,
  WarningHighlight,
  WindowStill,
  type WindowStillShot,
} from "./WarningHighlight";
import { mergeRunWarnings, WarningsList, warningKey } from "./WarningsList";
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
  /** The screens and the focus the layout checks of the loaded window saw, oldest first. */
  screens(): ScreenMark[];
  /** The elements the layout warnings know in the loaded window, in document order. */
  elements(): ReturnType<typeof describeElements>;
  /** The `/api` requests of the loaded app window, oldest first. Empty for a desktop window. */
  requests(): readonly ApiRecord[];
  /** The errors the loaded app window caught. Empty for a desktop window. */
  errors(): readonly string[];
  /**
   * Seeks to the time of a mark (`<kind>|<ms>|<label>`, as the `mark` link parameter) and keeps
   * the matching warning shown over the window. False when the run does not show it.
   */
  mark(text: string): Promise<boolean>;
};

type RunInfo = { end: number; nextAt(ms: number): number | null };
type FrameWindow = Window & typeof globalThis;
/** The loaded window: its clock, its run, whether it shows the app, and how to stop listening to it. */
type Live = {
  win: FrameWindow;
  /** The document the window had when it booted. Another one means the frame loaded again. */
  doc: Document;
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
/** How long a backward warning jump waits for the still of the window before it goes on. */
const STILL_WAIT_MS = 500;

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

/**
 * True when a pending request waits on the page clock or on a person: its answer is "delay" or
 * "never". Moving the clock (or a new answer) ends the wait, so the quiet wait does not wait for it.
 * The fake API says which answer the request gets, with the same route matching that answers it.
 */
function waitsOnClock(record: ApiRecord, api: ApiControl): boolean {
  const mode = api.answerFor(record)?.answer.mode;
  return mode === "delay" || mode === "never";
}

type RouterLike = {
  state?: { status?: string; isLoading?: boolean };
  /** The router's history: it calls back after each push, replace and back. */
  history?: { subscribe?(listener: () => void): () => void };
};

/** The route an app frame shows now: its path, query and hash (the frame's address is the route). */
function liveRouteOf(win: Window): string {
  const { pathname, search, hash } = win.location;
  return `${pathname}${search}${hash}`;
}

/**
 * True while the app frame still works on real time: a request to the fake API is on its way, or
 * the router loads a route (its chunks come from the dev server). A request or a native call that
 * waits on the clock is not work on real time, and a router that waits on one is not either.
 */
function frameBusy(win: FrameWindow): boolean {
  const api = win.__workbenchApi;
  let waitsForClock = false;
  for (const record of api?.requests() ?? []) {
    if (record.state !== "pending") continue;
    if (!waitsOnClock(record, api as ApiControl)) return true;
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

/** True for a control that uses the arrow keys itself: a slider or a splitter. */
function usesArrows(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.nodeType !== 1) return false;
  if (el.getAttribute("role") === "separator") return true;
  return (
    el.tagName.toLowerCase() === "input" &&
    (el.getAttribute("type") ?? "").toLowerCase() === "range"
  );
}

/** True for a control that Space and Enter press: a button, a link, a checkbox, a summary. */
function pressable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  return (
    tag === "button" ||
    tag === "summary" ||
    tag === "a" ||
    tag === "input" ||
    el.getAttribute("role") === "separator"
  );
}

/** The panel sizes: defaults, limits and where each is kept for this viewer. */
const LEFT = { pref: "leftWidth", initial: 248, min: 180, max: 420 };
const RIGHT = { pref: "rightWidth", initial: 280, min: 220, max: 480 };
const UNDER = { pref: "warningsHeight", min: 72 };
/** The space around the window in the stage, on each side. */
const STAGE_PAD = 16;
/** The smallest zoom Fit uses. */
const MIN_FIT = 0.25;

function storedWidth(size: typeof LEFT): number {
  const value = readPref(size.pref, isNumber);
  return value === null ? size.initial : clamp(value, size.min, size.max);
}

/** The query without `zoom`: with Fit on, the link opens with Fit too. */
function withoutZoom(query: string): string {
  const params = new URLSearchParams(query);
  params.delete("zoom");
  return params.toString();
}

/**
 * What a link asks for once, when the page opens: `embed=1` shows only the window and the layout
 * warnings (the Findings page holds the workbench so), and `mark` names a warning to show.
 */
function linkExtras(search: string): { embed: boolean; mark: Mark | null } {
  const params = new URLSearchParams(search);
  return {
    embed: params.get("embed") === "1",
    mark: parseMark(params.get("mark")),
  };
}

/** How many animation frames a mark waits for its warning after the seek. */
const MARK_WAIT_FRAMES = 30;

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

/** A layout warning shown over the window. */
type Highlight = {
  id: number;
  warning: Warning;
  key: string;
  /** A click keeps it when the pointer leaves the warnings list. */
  pinned: boolean;
  /** The seek to its time still runs. */
  jumping: boolean;
};

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
  const [extras] = useState(() => linkExtras(window.location.search));
  const [state, setState] = useState<WorkbenchState>(boot.state);
  /** Fit: with no zoom in the URL, the window zooms to fit the stage. A zoom you set turns it off. */
  const [fit, setFit] = useState(
    () => !new URLSearchParams(window.location.search).has("zoom"),
  );
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const [fitZoom, setFitZoom] = useState(1);
  /** The panel sizes, kept for this viewer. A null warnings height is the automatic height. */
  const [leftWidth, setLeftWidth] = useState(() => storedWidth(LEFT));
  const [rightWidth, setRightWidth] = useState(() => storedWidth(RIGHT));
  const [underHeight, setUnderHeight] = useState<number | null>(() =>
    readPref(UNDER.pref, isNumber),
  );
  const stageRef = useRef<HTMLDivElement | null>(null);
  const underRef = useRef<HTMLDivElement | null>(null);
  const sceneListRef = useRef<SceneListHandle | null>(null);
  /** "Critique this screen": the impeccable command, and what the copy did. */
  const [screenCommand, setScreenCommand] =
    useState<CritiqueCommand>("critique");
  const [screenStatus, setScreenStatus] = useState<string | null>(null);
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
  /** The route the app frame shows now, after its redirects and navigations. Null before it boots. */
  const [liveRoute, setLiveRoute] = useState<string | null>(null);
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
  /** The layout warning shown over the window, from a hover or a click in the warnings list. */
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  /** Counts highlights, so a newer one or a clear stops an older jump from showing its highlight. */
  const highlightIdRef = useRef(0);
  /** Where the window is under the highlight; measured after the jump and when the window changes. */
  const [origin, setOrigin] = useState<FrameOrigin | null>(null);
  /**
   * The still of the window over it while a warning hover seeks back, so the replay under it does
   * not show. It belongs to the jump that made it, or to a newer jump that took it over.
   */
  const [still, setStill] = useState<
    | (WindowStillShot & {
        scene: string;
        /** The handover and handback cards as they were: they stay while the still shows. */
        handover: boolean;
        handback: string | null;
      })
    | null
  >(null);
  /** The cards over the window now, for a still to keep. */
  const cardsRef = useRef({
    handover: false,
    handback: null as string | null,
  });
  const stillOwnerRef = useRef(0);
  const stillShownRef = useRef<(() => void) | null>(null);
  /** Who hosts the watched window: the Spacing check needs the Mac buttons only in Desktop. */
  const watchedScene = scenes.find((s) => s.id === state.scene);
  const watchedHost =
    watchedScene && isApp(watchedScene)
      ? (state.app?.host ?? watchedScene.start.host)
      : "desktop";
  const {
    warnings,
    checkedAt,
    flush: checkLayout,
    hold: holdLayout,
    screens: layoutScreens,
  } = useLayoutWatch(frameEl, {
    width: state.window.width,
    height: state.window.height,
    buttons: windowButtonsBox(state.window.os, watchedHost),
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
        const query = encodeState(value);
        const shown = fitRef.current ? withoutZoom(query) : query;
        window.history.replaceState(
          null,
          "",
          `?${extras.embed ? `${shown}&embed=1` : shown}`,
        );
        return value;
      });
    },
    [extras.embed],
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
  /** The zoom the window shows at: Fit's zoom, or the zoom you set. */
  const zoom = fit ? fitZoom : state.window.zoom;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const host = appConfig?.host ?? "desktop";
  const frameKey = `${state.scene}|${state.window.os}|${JSON.stringify(config?.env ?? {})}|${remountCount}|${kind}|${host}|${appConfig?.role ?? ""}|${appConfig?.motion ?? ""}|${appConfig?.skin ?? ""}|${appConfig?.sidebar ?? ""}`;

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
        target: action.target,
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
    setLiveRoute(null);
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
      // A load of the same iframe again (a reload of the app frame) is not ready until it walked.
      readyRef.current = false;
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
      // The app changes its route without a load (a redirect, a link): read it at each change.
      const readRoute = () => {
        if (app && !win.closed) setLiveRoute(liveRouteOf(win));
      };
      readRoute();
      const router = app
        ? (win as { __TSR_ROUTER__?: RouterLike }).__TSR_ROUTER__
        : undefined;
      const offHistory = router?.history?.subscribe?.(readRoute);
      if (app) win.addEventListener("popstate", readRoute);
      const off = clock.onTick((ms) => {
        setNow(ms);
        readRoute();
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
        readRoute();
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
        doc: win.document,
        clock,
        info,
        app,
        off: () => {
          off();
          offChange?.();
          offActions?.();
          offHistory?.();
          win.removeEventListener("popstate", readRoute);
        },
      };
      liveRef.current = live;
      setEnd(info.end);
      if (!(await walk(live, target))) return;
      await fontsReady(live);
      if (liveRef.current !== live) return;
      setNow(clock.now());
      checkHandover();
      readRoute();
      if (target === 0 && !hasRun) {
        clock.play(1);
        setPlaying(true);
      } else setPlaying(false);
      markReady();
    },
    [checkHandover, markReady, showAction, walk, writeAt],
  );

  const whenReady = useCallback(async () => {
    // The frame can load again while this waits (Vite reloads an app frame, for example). Then
    // this waits for the new load, so a seek never ends on a window that is not ready.
    for (;;) {
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
      // Not a bare frame of the window: a window that unloads drops its animation frames, and the
      // seek would then never end ("Resulting promise was garbage collected" in a CLI shot).
      await frameOrFallback(live?.win ?? window);
      const reloaded =
        live !== null &&
        (live !== liveRef.current || live.win.document !== live.doc);
      if (readyRef.current && !reloaded) return;
    }
  }, [noteNotQuiet]);

  /** Removes the highlight of a layout warning. A play, a step, a new scene or a seek does this. */
  const clearHighlight = useCallback(() => {
    highlightIdRef.current += 1;
    setHighlight(null);
  }, []);

  /**
   * Puts a still of the window over it, and resolves when the still shows (or after a short
   * wait, when it does not load). The caller removes it.
   */
  const coverWithStill = useCallback((live: Live): Promise<void> => {
    if (!frameRef.current) return Promise.resolve();
    const { width, height, theme } = stateRef.current.window;
    let html: string;
    try {
      html = stillHtml(live.doc, theme);
    } catch {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, STILL_WAIT_MS);
      function done() {
        clearTimeout(timer);
        stillShownRef.current = null;
        resolve();
      }
      stillShownRef.current = done;
      setStill({
        scene: stateRef.current.scene,
        ...cardsRef.current,
        html,
        width,
        height,
        theme,
        scrollX: live.win.scrollX,
        scrollY: live.win.scrollY,
      });
    });
  }, []);

  const seek = useCallback(
    async (ms: number, options?: { cover?: boolean }) => {
      const live = liveRef.current;
      clearHighlight();
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
        // The clock runs only forward: the window starts again and goes to the time. A warning
        // hover first covers the window with a still of it, so the replay does not show.
        if (options?.cover && live) await coverWithStill(live);
        targetRef.current = target;
        bootFailedRef.current = false;
        detach();
        setRemountCount((count) => count + 1);
      }
      await whenReady();
    },
    [
      checkHandover,
      clearHighlight,
      coverWithStill,
      detach,
      markReady,
      stopLoop,
      walk,
      whenReady,
      writeAt,
    ],
  );

  /** Seeks to a warning's time, then shows the warning over the window. */
  const showWarning = useCallback(
    (warning: Warning, pinned: boolean) => {
      // The seek clears the highlight before it waits, so the new one stays.
      const done = seek(warning.at, { cover: true });
      const id = ++highlightIdRef.current;
      // A still that an older jump put up is this jump's now: it goes when this one ends.
      stillOwnerRef.current = id;
      setHighlight({
        id,
        warning,
        key: warningKey(warning),
        pinned,
        jumping: true,
      });
      // The still goes in the same update that shows the window's new state: one step.
      const dropStill = () => {
        if (stillOwnerRef.current === id) setStill(null);
      };
      done.then(
        () => {
          dropStill();
          if (highlightIdRef.current !== id) return;
          setHighlight((h) => (h?.id === id ? { ...h, jumping: false } : h));
        },
        () => {
          dropStill();
          if (highlightIdRef.current === id) clearHighlight();
        },
      );
    },
    [clearHighlight, seek],
  );

  /**
   * Goes to a mark's time and keeps its warning shown, as a click on its row does. The warning is
   * the one of this run that matches the mark (kind, label, nearest time). Without one, a notice
   * says so.
   */
  const markWarning = useCallback(
    async (mark: Mark): Promise<boolean> => {
      await whenReady();
      const now = liveRef.current?.clock.now() ?? 0;
      if (now !== mark.at) {
        // A seek back covers the window with a still, as a warning hover does: this mark owns
        // it, and it goes when the seek ends, unless a newer jump took it over.
        const owner = ++highlightIdRef.current;
        stillOwnerRef.current = owner;
        try {
          await seek(mark.at, { cover: now > mark.at });
        } finally {
          if (stillOwnerRef.current === owner) setStill(null);
        }
      }
      let found: Warning | null = null;
      for (let i = 0; i < MARK_WAIT_FRAMES && !found; i++) {
        found = matchWarning(warningsRef.current, mark);
        if (!found) await new Promise((done) => requestAnimationFrame(done));
      }
      if (!found) {
        setNotices((all) => [
          ...all,
          `The warning "${mark.label}" (${mark.kind}) did not show again at ${formatTime(mark.at)}. The run may have changed since the check.`,
        ]);
        return false;
      }
      const id = ++highlightIdRef.current;
      setHighlight({
        id,
        warning: found,
        key: warningKey(found),
        pinned: true,
        jumping: false,
      });
      return true;
    },
    [seek, whenReady],
  );
  const markWarningRef = useRef(markWarning);
  markWarningRef.current = markWarning;

  // A link with `mark` shows its warning once the window is at the link's time. Once only, also
  // when React runs the effect twice.
  const markedRef = useRef(false);
  useEffect(() => {
    const mark = extras.mark;
    if (!mark || markedRef.current) return;
    markedRef.current = true;
    void markWarningRef.current(mark).catch(() => {});
  }, [extras.mark]);

  const hoverWarning = (warning: Warning) => {
    const current = highlightRef.current;
    // A pinned warning stays until a click on another one; the same warning does not jump again.
    if (current?.pinned || current?.key === warningKey(warning)) return;
    showWarning(warning, false);
  };

  const pinWarning = (warning: Warning) => {
    const current = highlightRef.current;
    if (current?.key === warningKey(warning)) {
      setHighlight({ ...current, pinned: true });
      return;
    }
    showWarning(warning, true);
  };

  // While markers show, each follows its element on every animation frame. When the element left
  // the screen, the marker turns into a ghost at its last place for GHOST_MS and goes: a marker
  // never points at a place where its element is now, and every action shows long enough to see.
  const hasMarks = marks.length > 0;
  useEffect(() => {
    if (!hasMarks) return;
    let handle = 0;
    const tick = () => {
      setMarks((all) => {
        const next = followMarks(
          all,
          (target) => boxOf(target),
          performance.now(),
        );
        return next === all ? all : [...next];
      });
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [hasMarks, boxOf]);

  // The paused "Next:" marker is measured again when the zoom, the window or the stage changes
  // (Fit, a size, a splitter drag), so it stays on its element.
  const nextTarget = nextAction?.target ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new zoom or window moves the element, so it is measured again
  useLayoutEffect(() => {
    if (!nextTarget) return;
    const measure = () =>
      setNextAction((mark) => {
        if (!mark?.target) return mark;
        const step = followTarget(mark.target, () =>
          boxOf(mark.target ?? null),
        );
        if (step.drop) return null;
        return sameBox(step.box, mark.box) ? mark : { ...mark, box: step.box };
      });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const el of [frameEl, wrapRef.current, stageRef.current]) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [nextTarget, zoom, state.window, frameEl, boxOf]);

  // Measures where the window is, after a jump and when the size, the zoom or the frame changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new zoom (Fit) moves the window, so it is measured again
  useLayoutEffect(() => {
    if (!highlight || highlight.jumping) return;
    const wrap = wrapRef.current;
    setOrigin(
      wrap && frameEl ? frameOrigin(wrap, frameEl, state.window.width) : null,
    );
  }, [highlight, state.window, zoom, frameEl]);

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
      screens: layoutScreens,
      elements: () => {
        const doc = frameRef.current?.contentDocument;
        return doc ? describeElements(doc) : [];
      },
      requests: () => liveRef.current?.win.__workbenchApi?.requests() ?? [],
      errors: () => [...(liveRef.current?.win.__workbenchErrors ?? [])],
      mark: async (text) => {
        const mark = parseMark(text);
        return mark ? markWarningRef.current(mark) : false;
      },
    };
  }, [seek, layoutScreens]);

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

  // Fit: the largest zoom (at most 1) at which the whole window shows in the stage.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const wrap = wrapRef.current;
    if (!stage || !wrap) return;
    const measure = () => {
      const rect = wrap.getBoundingClientRect();
      const z = zoomRef.current || 1;
      const width = rect.width / z;
      const height = rect.height / z;
      if (width <= 0 || height <= 0) return;
      const next = Math.min(
        1,
        (stage.clientWidth - 2 * STAGE_PAD) / width,
        (stage.clientHeight - 2 * STAGE_PAD) / height,
      );
      // Two decimals, rounded down: a scroll bar never comes and goes with the fit.
      const rounded = Math.max(MIN_FIT, Math.floor(next * 100) / 100);
      setFitZoom((prev) => (prev === rounded ? prev : rounded));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // C turns Comment mode on and off, when the focus is not in a text field. The frame's listener
  // goes on again at each load: a full reload or a navigation in the frame (a sign-out) gives the
  // same iframe a new document, and frameEl does not change.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "c" && event.key !== "C") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || isTextField(event.target)) return;
      event.preventDefault();
      setCommenting((on) => !on);
    };
    let doc: Document | null = null;
    const attach = () => {
      doc?.removeEventListener("keydown", onKey);
      doc = frameEl?.contentDocument ?? null;
      doc?.addEventListener("keydown", onKey);
    };
    window.addEventListener("keydown", onKey);
    attach();
    frameEl?.addEventListener("load", attach);
    return () => {
      window.removeEventListener("keydown", onKey);
      frameEl?.removeEventListener("load", attach);
      doc?.removeEventListener("keydown", onKey);
    };
  }, [frameEl]);

  // The page's keys (see KeysHelp). None fires while the focus is in a field you type in.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (isTextField(target)) return;
      const keys = keysRef.current;
      switch (event.key) {
        case "/":
          event.preventDefault();
          sceneListRef.current?.focusFilter();
          return;
        case "ArrowDown":
        case "ArrowUp":
          if (usesArrows(target)) return;
          event.preventDefault();
          sceneListRef.current?.move(event.key === "ArrowDown" ? 1 : -1);
          return;
        case "Enter":
          if (pressable(target)) return;
          if (sceneListRef.current?.pickCursor()) event.preventDefault();
          return;
        case " ": {
          // A scene row is a button, but Space on it plays: a click on it again would start the scene over.
          const row = (target as HTMLElement | null)?.classList?.contains(
            "wb-scene",
          );
          if (pressable(target) && !row) return;
          event.preventDefault();
          if (keys.playing) keys.pause();
          else keys.play();
          return;
        }
        case ".":
          event.preventDefault();
          keys.step();
          return;
        case "ArrowLeft":
        case "ArrowRight":
          if (usesArrows(target)) return;
          event.preventDefault();
          keys.seekBy(event.key === "ArrowLeft" ? -1000 : 1000);
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        target,
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
    clearHighlight();
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

  const stepOnce = () => {
    setNextAction(null);
    clearHighlight();
    steppingRef.current = true;
    try {
      liveRef.current?.clock.stepToNext();
    } finally {
      steppingRef.current = false;
    }
  };

  /** ← and →: a seek of one second back or on, within the run. */
  const seekBy = (deltaMs: number) => {
    const live = liveRef.current;
    if (!live) return;
    const last = end || runEnd * 1000;
    const target = Math.max(0, live.clock.now() + deltaMs);
    void seek(last > 0 ? Math.min(last, target) : target);
  };

  const keysRef = useRef({ play, pause, step: stepOnce, seekBy, playing });
  keysRef.current = { play, pause, step: stepOnce, seekBy, playing };

  const pickScene = (id: string) => {
    const scene = scenesRef.current.find((s) => s.id === id);
    clearHighlight();
    setPickedRoute(null);
    update((prev) => ({
      ...prev,
      scene: id,
      at: 0,
      answers: {},
      api: {},
      // The host, the motion, the skin and the sidebar stay; the role is the scene's again.
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

  /** A new host, role, motion, skin or sidebar remounts the window (the frame key has them). */
  const changeApp = (patch: Partial<AppWindowSettings>) => {
    update((prev) => {
      return { ...prev, app: { ...(prev.app ?? DEFAULT_APP), ...patch } };
    });
  };

  /*
   * The cards over the window. While a still covers the window, the cards it had stay as they
   * were: the replay under it starts again before them, and the eye must see no change.
   */
  const cover = still && still.scene === state.scene ? still : null;
  const showHandover = cover ? cover.handover : handedOver && !overlayClosed;
  const shownHandback = cover
    ? cover.handback
    : appScene && handedBack !== null && !handbackClosed
      ? handedBack
      : null;
  cardsRef.current = { handover: showHandover, handback: shownHandback };
  /** The desktop scene the handback card opens, when the workbench has it. */
  const handbackTarget =
    shownHandback === null ? null : desktopSceneFor(shownHandback);
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
    if (patch.zoom !== undefined) {
      fitRef.current = false;
      setFit(false);
    }
    update((prev) => ({ ...prev, window: { ...prev.window, ...patch } }));
    if (patch.theme) {
      const win = frameRef.current?.contentWindow as
        | (Window & typeof globalThis)
        | null
        | undefined;
      win?.__workbenchSetTheme?.(patch.theme);
    }
  };

  /** Fit on or off. Off keeps the zoom you set before; the URL gets the zoom again. */
  const changeFit = (on: boolean) => {
    fitRef.current = on;
    setFit(on);
    update((prev) => prev);
  };

  const copyScreenPrompt = async () => {
    const doc = frameRef.current?.contentDocument;
    if (!doc || !scene) return;
    const area = {
      x: 0,
      y: 0,
      width: state.window.width,
      height: state.window.height,
    };
    const picked = {
      kind: "area" as const,
      area,
      elements: pickArea(area, doc),
    };
    const resolved = await resolveTarget(picked).catch(() => picked);
    const text = buildScreenPrompt(
      screenCommand,
      resolved.kind === "area" ? resolved.elements : [],
      {
        scene: { id: scene.id, title: scene.title },
        atSeconds: toSeconds(now),
        window: state.window,
        link: window.location.href,
        app: appScene
          ? { route: liveRoute ?? appScene.start.route, host }
          : undefined,
      },
      { kind, warnings },
    );
    try {
      await copyText(text);
      setScreenStatus("Copied.");
    } catch {
      setScreenStatus("The workbench cannot write to the clipboard.");
    }
    setTimeout(() => setScreenStatus(null), 2000);
  };

  /**
   * The list keeps every row of the run: after a seek back, the rows that the replay has not
   * reached show muted, not removed, so the list does not shrink under the pointer. While a hover jumps to a
   * warning, it keeps the rows it had, so the row under the pointer stays. A new scene, window,
   * answers or settings is a new run, and starts the rows again. A kept row the window's checks
   * passed without finding it again (fixed, and the frame reloaded) goes.
   *
   * That time is the watch's `checkedAt`, not `now`: after a seek back the new window's warnings
   * start empty while `now` still holds the old window's time for a render, and a merge at that
   * time dropped every row behind it, so the list showed nothing.
   */
  const runKey = JSON.stringify([
    state.scene,
    state.answers,
    state.env,
    state.app,
    { ...state.window, zoom: 0, grid: false },
  ]);
  const shownWarningsRef = useRef<{
    run: string;
    warnings: readonly Warning[];
  }>({ run: runKey, warnings });
  if (shownWarningsRef.current.run !== runKey)
    shownWarningsRef.current = { run: runKey, warnings };
  else if (!highlight?.jumping)
    shownWarningsRef.current.warnings = mergeRunWarnings(
      shownWarningsRef.current.warnings,
      warnings,
      checkedAt,
    );
  /** The rows the run found up to now; frozen with the rows while a hover jumps. */
  const foundWarningsRef = useRef(warnings);
  if (!highlight?.jumping) foundWarningsRef.current = warnings;
  /**
   * The class of each move of the run, by the findings' rules (classifyMoves), so the list hides
   * the expected moves as the Findings page does. A class stays for the run: a row kept from
   * before a seek back keeps the class it had; a row the run finds again gets its class anew.
   */
  const movementsRef = useRef<{ run: string; map: Map<string, Movement> }>({
    run: runKey,
    map: new Map(),
  });
  if (movementsRef.current.run !== runKey)
    movementsRef.current = { run: runKey, map: new Map() };
  const sceneRun = scene?.run;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each check sets checkedAt, and the screens grow in the same check
  const freshMovements = useMemo(
    () => classifyMoves(warnings, userActions(sceneRun ?? []), layoutScreens()),
    [warnings, checkedAt, sceneRun, layoutScreens],
  );
  for (const [mark, movement] of freshMovements)
    movementsRef.current.map.set(mark, movement);

  const pageStyle = {
    "--wb-left": `${leftWidth}px`,
    "--wb-right": `${rightWidth}px`,
  } as CSSProperties;
  const underMax = Math.round(window.innerHeight * 0.7);

  return (
    <div
      className="wb-page"
      style={pageStyle}
      data-embed={extras.embed ? "" : undefined}
    >
      <aside className="wb-side wb-side-left">
        <nav className="wb-pages" aria-label="Workbench pages">
          <span aria-current="page">Scenes</span>
          <a href="/workbench/findings/">Findings</a>
        </nav>
        <SceneList
          scenes={catalog}
          current={state.scene}
          onPick={pickScene}
          groups={ALL_SCENE_GROUPS}
          handle={sceneListRef}
        />
        <details className="wb-fold" open={imported.length > 0 || undefined}>
          <summary>Import a log</summary>
          <ImportLogPanel
            scenes={imported}
            current={state.scene}
            onImport={(scene) => {
              const next = [
                ...imported.filter((s) => s.id !== scene.id),
                scene,
              ];
              setImported(next);
              saveImported(next);
              // A new scene of the same id loads again.
              setRemountCount((count) => count + 1);
              scenesRef.current = [...catalog, ...next];
              pickScene(scene.id);
            }}
            onPick={pickScene}
          />
        </details>
      </aside>
      <Splitter
        axis="x"
        label="Scene column width"
        size={() => leftWidth}
        min={LEFT.min}
        max={LEFT.max}
        grow={1}
        value={leftWidth}
        onSize={(px) => {
          setLeftWidth(px);
          writePref(LEFT.pref, px);
        }}
        onReset={() => {
          setLeftWidth(LEFT.initial);
          writePref(LEFT.pref, null);
        }}
      />
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
        <div className="wb-stage" ref={stageRef}>
          <div className="wb-window-wrap" ref={wrapRef}>
            <WindowFrame
              src={config ? frameUrl(config) : (appScene?.start.route ?? "/")}
              frameKey={frameKey}
              host={host}
              address={liveRoute ?? appScene?.start.route}
              width={state.window.width}
              height={state.window.height}
              os={state.window.os}
              active={state.window.active}
              theme={state.window.theme}
              zoom={zoom}
              grid={state.window.grid}
              gridColor={gridColor}
              comment={
                commenting && scene
                  ? {
                      scene: { id: scene.id, title: scene.title },
                      atSeconds: toSeconds(now),
                      window: state.window,
                      frameInfo: { kind, warnings },
                      app: appScene
                        ? {
                            route: liveRoute ?? appScene.start.route,
                            host,
                          }
                        : undefined,
                    }
                  : null
              }
              cover={
                cover && (
                  <WindowStill
                    still={cover}
                    onReady={() => stillShownRef.current?.()}
                  />
                )
              }
              onFrame={(iframe) => {
                frameRef.current = iframe;
                setFrameEl(iframe);
                if (iframe === null) detach();
                else void attach(iframe);
              }}
            />
            <ActionMarkers marks={marks} next={nextAction} />
            {highlight && !highlight.jumping && origin && (
              <WarningHighlight
                warning={highlight.warning}
                origin={origin}
                viewport={{
                  width: state.window.width,
                  height: state.window.height,
                }}
              />
            )}
          </div>
          {showHandover && (
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
          {shownHandback !== null && (
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
                  {HANDBACK_WORDS[shownHandback] ?? shownHandback}. The real
                  window now shows the setup window.
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
        <Splitter
          axis="y"
          label="Layout warnings height"
          size={() => underRef.current?.offsetHeight ?? 160}
          min={UNDER.min}
          max={underMax}
          grow={-1}
          value={underHeight}
          onSize={(px) => {
            setUnderHeight(px);
            writePref(UNDER.pref, px);
          }}
          onReset={() => {
            setUnderHeight(null);
            writePref(UNDER.pref, null);
          }}
        />
        <div
          className="wb-under"
          ref={underRef}
          style={
            underHeight === null
              ? undefined
              : { height: Math.min(underHeight, underMax), maxHeight: "none" }
          }
        >
          <WarningsList
            warnings={shownWarningsRef.current.warnings}
            found={foundWarningsRef.current}
            run={runKey}
            movements={movementsRef.current.map}
            seekingTo={highlight?.jumping ? highlight.warning.at : null}
            onSeek={(ms) => {
              void seek(ms);
            }}
            onHover={hoverWarning}
            onPin={pinWarning}
            onLeave={() => {
              if (highlightRef.current && !highlightRef.current.pinned)
                clearHighlight();
            }}
            highlight={highlight}
          />
        </div>
      </main>
      <Splitter
        axis="x"
        label="Right panel width"
        size={() => rightWidth}
        min={RIGHT.min}
        max={RIGHT.max}
        grow={-1}
        value={rightWidth}
        onSize={(px) => {
          setRightWidth(px);
          writePref(RIGHT.pref, px);
        }}
        onReset={() => {
          setRightWidth(RIGHT.initial);
          writePref(RIGHT.pref, null);
        }}
      />
      <aside className="wb-side wb-side-right">
        <section className="wb-run-panel">
          <div className="wb-panel-head">
            <h2>Run</h2>
            <KeysHelp />
          </div>
          {steps.length > 0 ? (
            <RunControls
              now={now}
              end={end || runEnd * 1000}
              marks={steps.map((step) => step.at * 1000)}
              playing={playing}
              speed={speed}
              onPlay={() => play()}
              onPause={pause}
              onStep={stepOnce}
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
            <p className="wb-run-still">
              <span>No run. The scene plays on its own.</span>
              <span className="wb-time">{formatTime(now)}</span>
            </p>
          )}
        </section>
        <WindowSettingsPanel
          value={state.window}
          gridColor={gridColor}
          onChange={changeWindow}
          onGridColor={setGridColor}
          fit={{ on: fit, zoom: fitZoom }}
          onFit={changeFit}
          app={
            appConfig
              ? {
                  host: appConfig.host,
                  role: appConfig.role,
                  motion: appConfig.motion,
                  // The link's choice, so "As the scene says" stays selected when the scene sets one.
                  skin: state.app?.skin ?? null,
                  sidebar: state.app?.sidebar ?? null,
                }
              : undefined
          }
          onAppChange={appConfig ? changeApp : undefined}
          onCopyLink={() => {
            void copyText(window.location.href).catch(() =>
              setNotices((all) => [
                ...all,
                "The browser did not let the page copy the link.",
              ]),
            );
            if (imported.some((s) => s.id === state.scene))
              setNotices((all) => [
                ...all,
                "This scene comes from a log you imported. It is only in this browser tab, so the link does not open it in another browser. To keep it, use Save for agents.",
              ]);
          }}
        />
        <section className="wb-comment-toggle">
          <h2>Review</h2>
          <div className="wb-presets">
            <button
              type="button"
              aria-pressed={commenting}
              aria-keyshortcuts="C"
              title="Comment (C)"
              onClick={() => setCommenting((on) => !on)}
            >
              Comment
            </button>
          </div>
          {commenting && (
            <p>
              Click an element or drag over an area in the window. Press C to
              stop.
            </p>
          )}
          <div className="wb-inline">
            <select
              aria-label="Impeccable command"
              value={screenCommand}
              onChange={(event) =>
                setScreenCommand(event.target.value as CritiqueCommand)
              }
            >
              {CRITIQUE_COMMANDS.map((command) => (
                <option key={command} value={command}>
                  {command}
                </option>
              ))}
            </select>
            <button
              type="button"
              title="Copy an impeccable prompt about the whole window"
              disabled={!frameEl}
              onClick={() => void copyScreenPrompt()}
            >
              Critique this screen
            </button>
          </div>
          {screenStatus && <p role="status">{screenStatus}</p>}
        </section>
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
