// The findings of `bun run workbench:check`: every layout warning and every run problem of every
// committed scene, merged into findings. shot.ts writes them to `<out>/findings.json`, and the
// Findings page (findings/FindingsPage.tsx) lists them. Pure: no file system, no browser.

import { buildPrompt, type PickedElement } from "./commentPrompt";
import type { ComponentInfo } from "./componentChain";
import type { Box } from "./geometry";
import type { ScreenMark, Warning } from "./layoutWatch";
import {
  DEFAULT_APP,
  encodeState,
  type WindowSettings,
  type WorkbenchState,
} from "./urlState";

/** The workbench server's findings routes (findingsServer.ts). */
export const FINDINGS_URL = "/__workbench/findings";
export const FINDINGS_RUN_URL = `${FINDINGS_URL}/run`;
export const FINDINGS_STATUS_URL = `${FINDINGS_URL}/status`;

/** What a finding is about: a layout warning, or a problem of the run. */
export type FindingKind =
  | "moved"
  | "clipped"
  | "outside"
  | "spacing"
  | "no-answer"
  | "app-error"
  | "stalled"
  | "step";

export const FINDING_KINDS: readonly FindingKind[] = [
  "moved",
  "clipped",
  "outside",
  "spacing",
  "no-answer",
  "app-error",
  "stalled",
  "step",
];

/** The words for a kind, as the page shows them. */
export const KIND_LABELS: Record<FindingKind, string> = {
  moved: "Moved",
  clipped: "Cut off",
  outside: "Outside",
  spacing: "Spacing",
  "no-answer": "No answer",
  "app-error": "App error",
  stalled: "Stalled",
  step: "Run step",
};

/** The kinds that are layout warnings: they have an element and a box in the window. */
export function isLayoutKind(
  kind: FindingKind,
): kind is "moved" | "clipped" | "outside" | "spacing" {
  return (
    kind === "moved" ||
    kind === "clipped" ||
    kind === "outside" ||
    kind === "spacing"
  );
}

/**
 * The Spacing class: what the rule checks and why, as the Findings page shows it. Every Spacing
 * finding shows by default (it is never an expected move).
 */
export const SPACING_RULE =
  "On a Mac, nothing of the page comes within 8 px of the window's close, minimise and zoom buttons, and no panel's edge or rounded corner does either. The buttons fit the column they sit over with 8 px on each side, sit in its middle over its icons, and share a middle with the row beside them.";
export const SPACING_WHY =
  "macOS draws the buttons over the page at a fixed place (TRAFFIC_LIGHTS in main.rs). A panel's corner or an icon jammed against them, or buttons that miss the column's middle, reads as a page that does not know the window it is in. Little details matter.";

/** The severity of a problem of the run: higher than any layout warning in a window. */
export const PROBLEM_SEVERITY = 10_000;

/** Moves are merged when their deltas fall in the same bucket of this many pixels. */
export const DELTA_BUCKET_PX = 4;

export type SceneRef = {
  id: string;
  title: string;
  group: string;
  kind: "desktop" | "app";
};

/** One link of a component chain, as findings.json keeps it. */
export type ChainLink = { name: string; file?: string; line?: number };

/** One time a scene showed a warning or a problem. */
export type Occurrence = {
  scene: SceneRef;
  /** Milliseconds from the scene start. */
  at: number;
  kind: FindingKind;
  /** The element's label for a layout warning, the message for a problem. */
  label: string;
  /** The element's key (`role:name`), when the check found the element. */
  elementKey: string | null;
  /** The element's components, innermost first. Empty when the check did not find them. */
  chain: ChainLink[];
  /** The layout warning itself, with its boxes. Null for a problem. */
  warning: Warning | null;
  /** For a move: its class, the rule that gave it and why (classifyMoves). Null otherwise. */
  movement?: Movement | null;
};

export type Finding = {
  /** Stable across runs: made from `key`. */
  id: string;
  /** What makes two occurrences one finding: kind, element, component file, rounded delta. */
  key: string;
  kind: FindingKind;
  title: string;
  /** Higher is worse: the largest size, or PROBLEM_SEVERITY for a problem. */
  severity: number;
  /** The largest size in px of the occurrences, or null for a problem. */
  size: number | null;
  /** The element's label, or null for a problem. */
  element: string | null;
  /** The innermost component with a source file. */
  component: ChainLink | null;
  sceneCount: number;
  /** The earliest time of the occurrences, in ms. */
  firstAt: number;
  /** For a move: the worst class of its occurrences, with that occurrence's rule and why. */
  movement: Movement | null;
  occurrences: Occurrence[];
};

export type FindingsFile = {
  version: 1;
  generatedAt: string;
  /** How many scenes the check walked. */
  sceneCount: number;
  /** The window settings the check used. Links to the workbench use them. */
  window: WindowSettings;
  findings: Finding[];
};

/** The first link of a chain that has a source file. */
export function componentOf(chain: readonly ChainLink[]): ChainLink | null {
  return chain.find((link) => link.file) ?? null;
}

/** The size of an occurrence in px: how far it moved, how much is cut off or outside. */
export function occurrenceSize(occurrence: Occurrence): number | null {
  const w = occurrence.warning;
  if (!w) return null;
  switch (w.kind) {
    case "moved":
      return Math.round(Math.hypot(w.dx, w.dy));
    case "clipped":
      return Math.max(
        0,
        Math.round(w.scrollWidth - w.box.width),
        Math.round(w.scrollHeight - w.box.height),
      );
    case "outside":
      return Math.round(w.overBy);
    case "spacing":
      return Math.round(w.size);
  }
}

function bucket(value: number): number {
  // `|| 0` turns -0 into 0, so the key does not depend on the sign of a zero.
  return Math.round(value / DELTA_BUCKET_PX) * DELTA_BUCKET_PX || 0;
}

/** A problem message without the parts that change from run to run: ids, numbers, times. */
export function normalizeMessage(message: string): string {
  return message
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      ":id",
    )
    .replace(/\b[0-9a-f]{16,}\b/gi, ":id")
    .replace(/\b\d+(\.\d+)?\b/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

/** What a finding is merged by: kind, element key, component file and rounded delta. */
export function findingKey(occurrence: Occurrence): string {
  const file = componentOf(occurrence.chain)?.file ?? "";
  const w = occurrence.warning;
  if (!w) return `${occurrence.kind}|${normalizeMessage(occurrence.label)}`;
  const element = occurrence.elementKey ?? w.label;
  let delta: string;
  // A jitter moves by a different amount each time: one finding for the element.
  if (w.kind === "moved" && occurrence.movement?.class === "jitter")
    delta = "jitter";
  else if (w.kind === "moved") delta = `${bucket(w.dx)},${bucket(w.dy)}`;
  else if (w.kind === "spacing")
    delta = `${w.rule},${bucket(occurrenceSize(occurrence) ?? 0)}`;
  else delta = String(bucket(occurrenceSize(occurrence) ?? 0));
  return `${w.kind}|${element}|${file}|${delta}`;
}

/** A short id made from a key (FNV-1a, 32 bits): the same key always gives the same id. */
export function findingId(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `f${hash.toString(16).padStart(8, "0")}`;
}

/** The words for a move: "157 px up", or both axes when both are more than 2 px. */
export function moveWords(dx: number, dy: number): string {
  const x = Math.round(dx);
  const y = Math.round(dy);
  const vertical = { n: Math.abs(y), words: y > 0 ? "down" : "up" };
  const across = { n: Math.abs(x), words: x > 0 ? "right" : "left" };
  const parts = (
    vertical.n >= across.n ? [vertical, across] : [across, vertical]
  )
    .filter((part, i) => i === 0 || part.n > 2)
    .map((part) => `${part.n} px ${part.words}`);
  return parts.join(" and ");
}

const MAX_TITLE_MESSAGE = 120;

function shorten(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The title of an occurrence, for example `span "Installing" moves 157 px up`. */
export function occurrenceTitle(occurrence: Occurrence): string {
  const w = occurrence.warning;
  if (w) {
    const size = occurrenceSize(occurrence) ?? 0;
    switch (w.kind) {
      case "moved":
        return `${w.label} moves ${moveWords(w.dx, w.dy)}`;
      case "clipped":
        return size > 0
          ? `${w.label} is cut off by ${size} px`
          : `${w.label} is cut off`;
      case "outside":
        return `${w.label} is ${size} px outside the window`;
      case "spacing":
        return w.text;
    }
  }
  return shorten(occurrence.label, MAX_TITLE_MESSAGE);
}

/** The scene order of the check, then time: the order of a finding's occurrences. */
function byTime(a: Occurrence, b: Occurrence): number {
  return a.at - b.at || a.scene.id.localeCompare(b.scene.id);
}

/**
 * The occurrences with an element filled in where the check did not find it: the element was gone
 * by the time the check looked (a scene that ends on another screen). An occurrence of the same
 * kind and label whose element was found lends its key and chain, so the two merge.
 */
export function lendElements(occurrences: readonly Occurrence[]): Occurrence[] {
  const found = new Map<string, Occurrence>();
  for (const o of occurrences) {
    const id = `${o.kind}|${o.label}`;
    if (o.warning && o.elementKey !== null && !found.has(id)) found.set(id, o);
  }
  return occurrences.map((o) => {
    if (!o.warning || o.elementKey !== null) return o;
    const lender = found.get(`${o.kind}|${o.label}`);
    return lender
      ? { ...o, elementKey: lender.elementKey, chain: lender.chain }
      : o;
  });
}

/**
 * Merges occurrences into findings. Occurrences with the same `findingKey` are one finding; its
 * title comes from its largest occurrence. The findings come out by severity, then by title.
 */
export function buildFindings(occurrences: readonly Occurrence[]): Finding[] {
  const groups = new Map<string, Occurrence[]>();
  for (const occurrence of lendElements(occurrences)) {
    const key = findingKey(occurrence);
    const group = groups.get(key);
    if (group) group.push(occurrence);
    else groups.set(key, [occurrence]);
  }
  const findings: Finding[] = [];
  for (const [key, group] of groups) {
    const sceneOrder = new Map<string, number>();
    for (const o of group)
      if (!sceneOrder.has(o.scene.id))
        sceneOrder.set(o.scene.id, sceneOrder.size);
    const sorted = [...group].sort(
      (a, b) =>
        (sceneOrder.get(a.scene.id) ?? 0) - (sceneOrder.get(b.scene.id) ?? 0) ||
        byTime(a, b),
    );
    const sizes = sorted.map(occurrenceSize);
    let biggest = 0;
    sizes.forEach((size, i) => {
      if ((size ?? 0) > (sizes[biggest] ?? 0)) biggest = i;
    });
    const first = sorted[biggest] as Occurrence;
    const size = first.warning ? (sizes[biggest] ?? 0) : null;
    // The worst class wins; between equals, the largest move.
    let worst: Occurrence | null = null;
    sorted.forEach((o, i) => {
      if (!o.movement) return;
      const rank = CLASS_RANK[o.movement.class];
      const best = worst?.movement ? CLASS_RANK[worst.movement.class] : 99;
      if (
        rank < best ||
        (rank === best &&
          (sizes[i] ?? 0) > (occurrenceSize(worst as Occurrence) ?? 0))
      )
        worst = o;
    });
    const movement = (worst as Occurrence | null)?.movement ?? null;
    findings.push({
      id: findingId(key),
      key,
      kind: first.kind,
      title:
        movement?.class === "jitter" && first.warning
          ? `${first.warning.label} moves back and forth, up to ${size} px`
          : occurrenceTitle(first),
      severity: size === null ? PROBLEM_SEVERITY : size,
      size,
      element: first.warning ? first.warning.label : null,
      component: componentOf(first.chain),
      sceneCount: sceneOrder.size,
      firstAt: Math.min(...sorted.map((o) => o.at)),
      movement,
      occurrences: sorted,
    });
  }
  return sortFindings(findings, "size");
}

export type FindingSort = "size" | "scenes" | "time";

export function sortFindings(
  findings: readonly Finding[],
  by: FindingSort,
): Finding[] {
  const tie = (a: Finding, b: Finding) =>
    a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  return [...findings].sort((a, b) => {
    // By size, the moves that are bugs come first: shift under hand, then jitter.
    if (by === "size" && findingRank(a) !== findingRank(b))
      return findingRank(a) - findingRank(b);
    if (by === "scenes")
      return (
        b.sceneCount - a.sceneCount || b.severity - a.severity || tie(a, b)
      );
    if (by === "time") return a.firstAt - b.firstAt || tie(a, b);
    return b.severity - a.severity || b.sceneCount - a.sceneCount || tie(a, b);
  });
}

export type FindingFilter = {
  kind: FindingKind | "all";
  window: "all" | "desktop" | "app";
  /** A component file, or "" for every file. */
  file: string;
  /** The smallest size in px. Problems always pass. */
  minSize: number;
  /** Words in the title, the element, the file or a scene's id or title. */
  text: string;
  /** Also the moves that are expected (after an action, on a new screen, while it loads). */
  showExpected: boolean;
};

export const NO_FILTER: FindingFilter = {
  kind: "all",
  window: "all",
  file: "",
  minSize: 0,
  text: "",
  showExpected: false,
};

export function filterFindings(
  findings: readonly Finding[],
  filter: FindingFilter,
): Finding[] {
  const words = filter.text.trim().toLowerCase();
  return findings.filter((f) => {
    if (filter.kind !== "all" && f.kind !== filter.kind) return false;
    if (!filter.showExpected && isExpected(f.movement)) return false;
    if (
      filter.window !== "all" &&
      !f.occurrences.some((o) => o.scene.kind === filter.window)
    )
      return false;
    if (filter.file !== "" && f.component?.file !== filter.file) return false;
    if (f.size !== null && f.size < filter.minSize) return false;
    if (words === "") return true;
    const haystack = [
      f.title,
      f.element ?? "",
      f.component?.file ?? "",
      ...f.occurrences.flatMap((o) => [o.scene.id, o.scene.title]),
    ]
      .join("\n")
      .toLowerCase();
    return haystack.includes(words);
  });
}

/** The component files of the findings, sorted, for the file filter. */
export function findingFiles(findings: readonly Finding[]): string[] {
  const files = new Set<string>();
  for (const f of findings) if (f.component?.file) files.add(f.component.file);
  return [...files].sort();
}

// --- Movement classes --------------------------------------------------------------------------

/**
 * What a move is. Most moves are normal: a layout changes and things move. Only two are bugs:
 *
 * - `shift-under-hand` (worst): the element the person is about to click or type into, or that has
 *   the focus, moves with no input in the last 500 ms, so the click lands somewhere else.
 * - `jitter`: the same element moves back and forth 3 or more times on a screen that stays the
 *   same, with no input in between.
 *
 * Everything else is `expected`: within 500 ms after an input (as CLS leaves out moves after
 * input), across a change of screen, while a screen loads (before it is first quiet), or a late
 * load shift on a quiet screen.
 */
export type MoveClass = "shift-under-hand" | "jitter" | "expected";

export type MoveRule =
  | "shift-under-hand"
  | "jitter"
  | "after-action"
  | "screen-change"
  | "initial-load"
  | "late-load";

export type Movement = { class: MoveClass; rule: MoveRule; why: string };

/** Lower is worse. Findings that are not moves sit between the bugs and the expected moves. */
export const CLASS_RANK: Record<MoveClass, number> = {
  "shift-under-hand": 0,
  jitter: 1,
  expected: 3,
};

export const CLASS_LABELS: Record<MoveClass, string> = {
  "shift-under-hand": "Shift under hand",
  jitter: "Jitter",
  expected: "Expected",
};

export const RULE_LABELS: Record<MoveRule, string> = {
  "shift-under-hand": "Shift under hand",
  jitter: "Jitter",
  "after-action": "After an input",
  "screen-change": "New screen",
  "initial-load": "While the screen loads",
  "late-load": "Late load shift",
};

function findingRank(f: Finding): number {
  return f.movement ? CLASS_RANK[f.movement.class] : 2;
}

/** A step of a run that a person would do: a click, typing, or going to a route. */
export type RunAction = {
  /** Milliseconds from the scene start. */
  at: number;
  kind: "click" | "type" | "navigate";
  /** The accessible name clicked or typed into, or the route. */
  target: string;
};

/** Moves this long after an input are the input's (CLS leaves out 500 ms after input). */
export const INPUT_WINDOW_MS = 500;
/** A screen is quiet after this long with no move. The walk checks every 500 ms or less. */
export const QUIET_MS = 500;
/** A screen's load ends this long after it starts, also when it never goes quiet. */
export const LOAD_LIMIT_MS = 5000;
/** How far ahead the next click or type step counts as where the pointer is going. */
export const AIM_MS = 2000;
/** How many moves back and forth make a jitter. */
export const JITTER_MOVES = 3;

/** The actions of a scene's run steps, in time order. */
export function userActions(steps: readonly object[]): RunAction[] {
  const actions: RunAction[] = [];
  for (const step of steps as readonly Record<string, unknown>[]) {
    const at = typeof step.at === "number" ? Math.round(step.at * 1000) : null;
    if (at === null) continue;
    if (typeof step.click === "string")
      actions.push({ at, kind: "click", target: step.click });
    else if (typeof step.type === "string" && typeof step.into === "string")
      actions.push({ at, kind: "type", target: step.into });
    else if (typeof step.navigate === "string")
      actions.push({ at, kind: "navigate", target: step.navigate });
  }
  return actions.sort((a, b) => a.at - b.at);
}

/** The name in a label: `button "Install"` gives `Install`. */
function nameIn(label: string): string {
  const m = /"(.*)"$/s.exec(label);
  return m ? (m[1] as string) : label;
}

/** The heading part of a screen (`/settings · General` gives `General`). */
function headingOf(screen: string | undefined): string {
  if (!screen) return "the screen";
  const at = screen.indexOf(" · ");
  return at === -1 ? screen : screen.slice(at + 3);
}

function clock(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

type Move = Extract<Warning, { kind: "moved" }>;

/**
 * The class of every move of one scene's run, by its mark (`warningMark`). `screens` is what the
 * layout checks saw (one entry each time the screen or the focus changed), `actions` the run's
 * clicks, typing and routes. Pure: the same run always gives the same classes.
 */
export function classifyMoves(
  warnings: readonly Warning[],
  actions: readonly RunAction[],
  screens: readonly ScreenMark[],
): Map<string, Movement> {
  const moves = warnings
    .filter((w): w is Move => w.kind === "moved")
    .sort((a, b) => a.at - b.at);
  const marks = [...screens].sort((a, b) => a.at - b.at);
  /** The newest entry at or before `t` (or strictly before, with `before`). */
  const entryAt = (t: number, before = false) => {
    let found: ScreenMark | undefined;
    for (const m of marks) {
      if (before ? m.at < t : m.at <= t) found = m;
      else break;
    }
    return found;
  };
  const screenAt = (t: number) => entryAt(t)?.screen;
  /** When the screen shown at `t` began: the first entry of its unbroken run of entries. */
  const screenStart = (t: number): number => {
    let start = 0;
    let previous: string | undefined;
    for (const m of marks) {
      if (m.at > t) break;
      if (m.screen !== previous) start = m.at;
      previous = m.screen;
    }
    return start;
  };
  const lastAction = (t: number) => {
    let found: RunAction | undefined;
    for (const a of actions) {
      if (a.at <= t) found = a;
      else break;
    }
    return found;
  };
  const actionBetween = (from: number, to: number) =>
    actions.some((a) => a.at > from && a.at <= to);

  // The moves of each screen's load: from the screen's start, while moves keep coming no more
  // than QUIET_MS apart, and at most LOAD_LIMIT_MS.
  const loading = new Set<Move>();
  const bySegment = new Map<string, Move[]>();
  for (const m of moves) {
    const id = `${screenStart(m.at)}|${screenAt(m.at) ?? ""}`;
    const list = bySegment.get(id);
    if (list) list.push(m);
    else bySegment.set(id, [m]);
  }
  for (const [id, list] of bySegment) {
    const start = Number(id.slice(0, id.indexOf("|")));
    let previous = start;
    for (const m of list) {
      if (m.at - previous > QUIET_MS || m.at - start > LOAD_LIMIT_MS) break;
      loading.add(m);
      previous = m.at;
    }
  }

  const result = new Map<string, Movement>();
  const px = (m: Move) => Math.round(Math.hypot(m.dx, m.dy));
  const open: Move[] = [];
  for (const m of moves) {
    const action = lastAction(m.at);
    const screen = screenAt(m.at);
    const heading = headingOf(screen);
    if (action && m.at - action.at <= INPUT_WINDOW_MS) {
      const what =
        action.kind === "navigate"
          ? `the move to ${action.target}`
          : `the ${action.kind === "click" ? "click on" : "typing into"} "${action.target}"`;
      result.set(warningMark(m), {
        class: "expected",
        rule: "after-action",
        why: `moved ${px(m)} px ${m.at - action.at} ms after ${what}`,
      });
      continue;
    }
    const before = entryAt(m.at, true)?.screen;
    if (before !== undefined && screen !== undefined && before !== screen) {
      result.set(warningMark(m), {
        class: "expected",
        rule: "screen-change",
        why: `moved ${px(m)} px when the screen changed from "${headingOf(before)}" to "${heading}"`,
      });
      continue;
    }
    if (loading.has(m)) {
      result.set(warningMark(m), {
        class: "expected",
        rule: "initial-load",
        why: `moved ${px(m)} px while "${heading}" loaded, before the screen was first quiet`,
      });
      continue;
    }
    // Where the pointer is: on the element of the last click or type step on this screen, or
    // going to the element of the next one; and the focused element.
    const name = nameIn(m.label);
    const next = actions.find(
      (a) => a.at > m.at && a.at - m.at <= AIM_MS && a.kind !== "navigate",
    );
    const focus = entryAt(m.at)?.focus ?? null;
    let hand: string | null = null;
    if (next && next.target === name)
      hand = `while the person was about to ${next.kind === "click" ? "click" : "type into"} it (the next step, at ${clock(next.at)})`;
    else if (
      action &&
      action.kind !== "navigate" &&
      action.target === name &&
      screenAt(action.at) === screen
    )
      hand = `under the pointer that clicked it at ${clock(action.at)}`;
    else if (focus !== null && focus === m.label)
      hand = "while it had the focus";
    if (hand) {
      result.set(warningMark(m), {
        class: "shift-under-hand",
        rule: "shift-under-hand",
        why: `moved ${px(m)} px ${hand}, with no input in the last ${INPUT_WINDOW_MS} ms`,
      });
      continue;
    }
    open.push(m);
  }

  // Jitter: the same element on the same screen, 3 or more moves with no input between them,
  // and at least one turn back.
  const series = new Map<string, Move[]>();
  for (const m of open) {
    const id = `${m.label}|${screenStart(m.at)}|${screenAt(m.at) ?? ""}`;
    const list = series.get(id);
    if (list) list.push(m);
    else series.set(id, [m]);
  }
  for (const list of series.values()) {
    let run: Move[] = [];
    const flush = () => {
      if (run.length >= JITTER_MOVES && turnsBack(run)) {
        const most = Math.max(...run.map(px));
        const heading = headingOf(screenAt(run[0]?.at ?? 0));
        for (const m of run)
          result.set(warningMark(m), {
            class: "jitter",
            rule: "jitter",
            why: `moved up to ${most} px ${run.length} times on "${heading}" with no input`,
          });
      }
      run = [];
    };
    for (const m of list) {
      const last = run[run.length - 1];
      if (last && actionBetween(last.at, m.at)) flush();
      run.push(m);
    }
    flush();
  }

  for (const m of open) {
    if (result.has(warningMark(m))) continue;
    result.set(warningMark(m), {
      class: "expected",
      rule: "late-load",
      why: `moved ${px(m)} px on "${headingOf(screenAt(m.at))}" with no input in the last ${INPUT_WINDOW_MS} ms: a late load shift, which is normal`,
    });
  }
  return result;
}

/**
 * True for a move the rules call expected (after an input, a new screen, a load, a late load
 * shift). The Findings page and the workbench page's warnings hide these by default; every other
 * warning (shift under hand, jitter, cut off, outside, a move with no class) shows.
 */
export function isExpected(movement: Movement | null | undefined): boolean {
  return movement?.class === "expected";
}

/**
 * The warnings of one run in two lists, by the same rules as the findings (classifyMoves):
 * `shown` (shift under hand, jitter, cut off, outside) and `expected` (the expected moves).
 * `movements` holds the class of each move by its mark, also for the workbench page's rows.
 */
export function splitWarnings<W extends Warning>(
  warnings: readonly W[],
  movements: ReadonlyMap<string, Movement>,
): { shown: W[]; expected: W[] } {
  const shown: W[] = [];
  const expected: W[] = [];
  for (const warning of warnings) {
    if (isExpected(movements.get(warningMark(warning)))) expected.push(warning);
    else shown.push(warning);
  }
  return { shown, expected };
}

/** True when the moves change direction at least once (on the axis that moves most). */
function turnsBack(run: readonly Move[]): boolean {
  const across = run.reduce((n, m) => n + Math.abs(m.dx), 0);
  const down = run.reduce((n, m) => n + Math.abs(m.dy), 0);
  const signs = run
    .map((m) => Math.sign(across > down ? m.dx : m.dy))
    .filter((sign) => sign !== 0);
  return signs.some((sign, i) => i > 0 && sign !== signs[i - 1]);
}

// --- The `mark` link parameter ------------------------------------------------------------------

/**
 * A warning the workbench marks over the window when a link opens: `mark=<kind>|<ms>|<label>`, and
 * for a Spacing warning `mark=spacing|<ms>|<rule>|<label>` (`label` then holds `<rule>|<label>`).
 */
export type Mark = { kind: Warning["kind"]; at: number; label: string };

/**
 * The label part of a warning's mark: its label, and for a Spacing warning its rule first, since
 * one panel can break two rules at the same time (`clearance|panel <main>`).
 */
export function markLabel(warning: Warning): string {
  return warning.kind === "spacing"
    ? `${warning.rule}|${warning.label}`
    : warning.label;
}

/** The mark of a warning. The same text as WarningsList's `warningKey`. */
export function warningMark(warning: Warning): string {
  return `${warning.kind}|${warning.at}|${markLabel(warning)}`;
}

export function parseMark(text: string | null): Mark | null {
  if (!text) return null;
  const m = /^(moved|clipped|outside|spacing)\|(\d+(?:\.\d+)?)\|(.+)$/s.exec(
    text,
  );
  if (!m) return null;
  return {
    kind: m[1] as Mark["kind"],
    at: Number(m[2]),
    label: m[3] as string,
  };
}

/** How far from a mark's time a warning may be and still be the marked one, in ms. */
export const MARK_TOLERANCE_MS = 1000;

/**
 * The warning a mark names: the same kind and label, the time nearest the mark's and at most
 * MARK_TOLERANCE_MS from it. Null when there is none.
 */
export function matchWarning(
  warnings: readonly Warning[],
  mark: Mark,
): Warning | null {
  let best: Warning | null = null;
  for (const w of warnings) {
    if (w.kind !== mark.kind || markLabel(w) !== mark.label) continue;
    const off = Math.abs(w.at - mark.at);
    if (off > MARK_TOLERANCE_MS) continue;
    if (!best || off < Math.abs(best.at - mark.at)) best = w;
  }
  return best;
}

// --- Links and prompts --------------------------------------------------------------------------

/** Seconds, one decimal, never after `ms`: a link opens at or before the occurrence. */
function linkSeconds(ms: number): number {
  return Math.floor(ms / 100) / 10;
}

/**
 * The workbench query of an occurrence: its scene at its time with the check's window, and the
 * mark of its warning. Without `zoom`, so the window fits. `embed` hides the side columns.
 */
export function occurrenceQuery(
  occurrence: Occurrence,
  window: WindowSettings,
  options: { embed?: boolean } = {},
): string {
  const state: WorkbenchState = {
    scene: occurrence.scene.id,
    at: linkSeconds(occurrence.at),
    answers: {},
    env: {},
    window,
    app: DEFAULT_APP,
  };
  const params = new URLSearchParams(encodeState(state));
  params.delete("zoom");
  if (occurrence.warning) params.set("mark", warningMark(occurrence.warning));
  if (options.embed) params.set("embed", "1");
  return params.toString();
}

function formatClock(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** One line for an occurrence: scene, time and, for a move, its cause. */
export function occurrenceLine(occurrence: Occurrence): string {
  const w = occurrence.warning;
  const cause = w?.kind === "moved" && w.cause ? ` (${w.cause})` : "";
  return `${occurrence.scene.title} (\`${occurrence.scene.id}\`) at ${formatClock(occurrence.at)}${cause}`;
}

function boxOf(warning: Warning): Box {
  return warning.kind === "moved" ? warning.to : warning.box;
}

const MAX_PROMPT_OCCURRENCES = 20;

/**
 * A change request (commentPrompt's `buildPrompt`) about a finding: what is wrong, every scene
 * and time it shows in, and the element at `occurrence` with its component chain.
 */
export function findingPrompt(
  finding: Finding,
  occurrence: Occurrence,
  context: { window: WindowSettings; origin: string },
): string {
  const where = finding.component?.file
    ? `${finding.component.file}${finding.component.line !== undefined ? `:${finding.component.line}` : ""}`
    : null;
  const shown = finding.occurrences.slice(0, MAX_PROMPT_OCCURRENCES);
  const more = finding.occurrences.length - shown.length;
  const comment = [
    `Fix this finding of \`bun run workbench:check\`: ${finding.title}.`,
    isLayoutKind(finding.kind)
      ? "Find out why it happens. If it is a real layout bug, fix it in the component. If it is only the scene's own timing, say so and fix the scene instead."
      : "Find out why it happens and fix it.",
    ...(finding.movement
      ? [
          `Why it is a finding: ${RULE_LABELS[finding.movement.rule]}: ${finding.movement.why}.`,
        ]
      : []),
    where
      ? `The component's file: ${where}.`
      : "The workbench did not find the component's file. Search the repo.",
    `It shows ${finding.occurrences.length} time(s) in ${finding.sceneCount} scene(s):`,
    ...shown.map((o) => `- ${occurrenceLine(o)}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
    "Then run `cd desktop && bun run workbench:check` and check that the finding is gone from workbench-shots/check/findings.json.",
  ].join("\n");
  const link = `${context.origin}/workbench/?${occurrenceQuery(occurrence, context.window)}`;
  const base = {
    comment,
    scene: { id: occurrence.scene.id, title: occurrence.scene.title },
    atSeconds: occurrence.at / 1000,
    window: { ...context.window, zoom: 1 },
    link,
  };
  const w = occurrence.warning;
  if (!w) {
    // A problem has no element: the prompt names the whole window.
    return buildPrompt(
      {
        kind: "area",
        area: {
          x: 0,
          y: 0,
          width: context.window.width,
          height: context.window.height,
        },
        elements: [],
      },
      base,
    );
  }
  const element: PickedElement = {
    label: w.label,
    box: boxOf(w),
    gaps: { top: null, right: null, bottom: null, left: null },
    offGrid: { x: 0, y: 0 },
    styles: {},
    chain: occurrence.chain as ComponentInfo[],
    text: "",
  };
  return buildPrompt({ kind: "element", element }, base);
}
