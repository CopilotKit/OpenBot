// Builds a self-contained review prompt that tells an agent
// with the impeccable skill to review one workbench frame. Pure: no file system, no browser.

import type { AppHost } from "./appContract";
import type { ComponentInfo } from "./componentChain";
import type { Box } from "./geometry";
import type { Warning } from "./layoutWatch";
import type { WindowSettings } from "./urlState";
import { warningText } from "./WarningsList";

/** The impeccable commands available in the review controls. */
export const CRITIQUE_COMMANDS = [
  "critique",
  "audit",
  "layout",
  "typeset",
  "clarify",
  "polish",
] as const;
export type CritiqueCommand = (typeof CRITIQUE_COMMANDS)[number];

/** One element of frame.json: what shot.ts writes, plus the component chain when it is known. */
export type FrameElement = {
  key?: string;
  label: string;
  box: Box;
  text?: string;
  chain?: ComponentInfo[];
};

/** The parts of frame.json that the prompt reads. */
export type FrameReport = {
  kind: "desktop" | "app";
  elements: readonly FrameElement[];
  warnings: readonly Warning[];
};

export type CritiqueContext = {
  command: CritiqueCommand;
  scene: { id: string; title: string };
  /** Seconds from the scene start. */
  window: WindowSettings;
  /** Where the app runs in this frame. */
  host: AppHost;
  /** The `--host` flag the frame was made with, or null for the scene's own host. */
  hostFlag: AppHost | null;
  /** The app route, for an app scene. */
  route?: string;
  link: string;
  /**
   * False for a prompt that the workbench page copies: no frame.png or frame.json comes with it, so
   * the agent renders the frame first. Default true for a supplied screenshot/report pair.
   */
  files?: boolean;
  /** Set when the review is about one part of the frame (a picked element or area). */
  scope?: { what: string; box: Box };
  /** The person's own words, from the Comment box. */
  note?: string;
};

/** How many elements the prompt lists. */
export const MAX_ELEMENTS = 60;

const SOURCE_ROOTS = ["app/src/", "desktop/src/"];

/** Files that draw every screen, so they are never a screen's own file. */
const SHARED_PARTS = ["/components/ui/", "/components/layout/"];
const ENTRY_FILES = new Set(["app/src/main.tsx", "desktop/src/main.tsx"]);

function isScreenSource(file: string): boolean {
  if (!SOURCE_ROOTS.some((root) => file.startsWith(root))) return false;
  if (ENTRY_FILES.has(file)) return false;
  return !SHARED_PARTS.some((part) => file.includes(part));
}

function isRoute(file: string): boolean {
  return file.startsWith("app/src/routes/");
}

type Tally = { file: string; count: number; depth: number };

/** True when `a` is a better main file than `b`. */
function better(a: Tally, b: Tally): boolean {
  if (a.count !== b.count) return a.count > b.count;
  if (isRoute(a.file) !== isRoute(b.file)) return isRoute(a.file);
  if (a.depth !== b.depth) return a.depth < b.depth;
  return a.file < b.file;
}

/**
 * The main source file of the screen: the app/src or desktop/src file that the most elements have
 * in their component chain. Each element counts a file once. The shared primitives
 * (components/ui), the shared layout (components/layout) and the entry files do not count. On a
 * tie, a route file under app/src/routes wins, then the file nearer to the elements (the lower sum
 * of positions in the chains), then the name. Null when no element has such a file.
 */
export function mainSourceFile(
  elements: readonly FrameElement[],
): string | null {
  const tallies = new Map<string, Tally>();
  for (const element of elements) {
    const seen = new Set<string>();
    (element.chain ?? []).forEach((info, depth) => {
      const file = info.file;
      if (!file || seen.has(file) || !isScreenSource(file)) return;
      seen.add(file);
      const tally = tallies.get(file) ?? { file, count: 0, depth: 0 };
      tally.count += 1;
      tally.depth += depth;
      tallies.set(file, tally);
    });
  }
  let best: Tally | null = null;
  for (const tally of tallies.values()) {
    if (best === null || better(tally, best)) best = tally;
  }
  return best?.file ?? null;
}

/** The `--target` of the review: the main source file, else the app route, else the scene id. */
export function critiqueTarget(
  report: FrameReport,
  context: CritiqueContext,
): string {
  return mainSourceFile(report.elements) ?? context.route ?? context.scene.id;
}

/** The desktop-workbench:shot command that renders the same frame. */
export function shotCommand(context: CritiqueContext): string {
  return `cd desktop && bun run desktop-workbench:shot --url '${context.link.replaceAll("'", "'\\''")}'`;
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function formatBox(box: Box): string {
  return `x ${round(box.x)}, y ${round(box.y)}, ${round(box.width)}×${round(box.height)}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function located(chain: readonly ComponentInfo[] | undefined): string {
  const info = (chain ?? []).find((c) => c.file);
  if (!info?.file) return "";
  return info.line !== undefined ? `${info.file}:${info.line}` : info.file;
}

function warningBox(warning: Warning): Box {
  return warning.kind === "moved" ? warning.to : warning.box;
}

function warningLines(warnings: readonly Warning[]): string[] {
  if (warnings.length === 0) {
    return ["The workbench found no layout warnings in this frame."];
  }
  return [
    "The workbench found these layout problems. Check each one in frame.png and in the source. Say if it is real, and fix the cause, not the symptom.",
    "",
    ...warnings.map(
      (w, i) => `${i + 1}. ${warningText(w)} · box ${formatBox(warningBox(w))}`,
    ),
  ];
}

function elementLines(elements: readonly FrameElement[]): string[] {
  if (elements.length === 0) return ["The frame has no labelled elements."];
  const lines = [
    "| Label | Component | File | Box |",
    "| --- | --- | --- | --- |",
  ];
  for (const el of elements.slice(0, MAX_ELEMENTS)) {
    const component = el.chain?.[0]?.name ?? "";
    lines.push(
      `| ${cell(el.label)} | ${cell(component)} | ${cell(located(el.chain))} | ${formatBox(el.box)} |`,
    );
  }
  if (elements.length > MAX_ELEMENTS) {
    lines.push(
      "",
      `Showing the first ${MAX_ELEMENTS} of ${elements.length} elements. frame.json has all of them.`,
    );
  }
  return lines;
}

function visualTruth(context: CritiqueContext, command: string): string[] {
  const avoid =
    "Do NOT use impeccable's own `shot`: it opens a plain page without the fake state that makes this scene.";
  if (context.files === false) {
    return [
      `No image comes with this prompt. First render the frame with \`${command}\`. It writes frame.png and frame.json. Use them as the visual truth, and run the same command again after changes.`,
      avoid,
      "frame.json has the elements, the layout warnings, the native calls and the API requests of this frame.",
    ];
  }
  return [
    `Use frame.png in this folder and \`${command}\` to re-render after changes.`,
    avoid,
    "frame.json in this folder has the elements, the layout warnings, the native calls and the API requests of this frame.",
  ];
}

function scopeLines(context: CritiqueContext): string[] {
  if (!context.scope) return [];
  return [
    "## Scope",
    "",
    `Review only this part of the frame: ${context.scope.what}, at ${formatBox(context.scope.box)}. The elements and the layout warnings below are the ones in this part. Do not change the rest of the screen.`,
    "",
  ];
}

function noteLines(context: CritiqueContext): string[] {
  const note = context.note?.trim();
  if (!note) return [];
  return [
    "## What the person asks",
    "",
    ...note.split("\n").map((line) => `> ${line}`),
    "",
  ];
}

/** prompt.md for one frame. */
export function buildCritiquePrompt(
  report: FrameReport,
  context: CritiqueContext,
): string {
  const target = critiqueTarget(report, context);
  const w = context.window;
  const command = shotCommand(context);
  const app = report.kind === "app";
  const surface = app
    ? "the OpenBot web app, as OpenBot Desktop shows it after setup"
    : "the OpenBot Desktop setup window";
  const lines = [
    `/impeccable ${context.command} ${target}`,
    "",
    `# Design review of a workbench frame: ${context.scene.title}`,
    "",
    `Run the impeccable \`${context.command}\` command on this frame. Pass \`--target ${target}\` to \`impeccable context\`.`,
    "",
    "## Surface mode",
    "",
    `Operate. The frame shows ${surface}. The setup window and the app UI are task surfaces: the person must finish a task. Scanability, consistency and native expectations come before expression.`,
    "",
    "## Visual truth",
    "",
    ...visualTruth(context, command),
    "",
    ...scopeLines(context),
    ...noteLines(context),
    "## Frame",
    "",
    `- View: ${context.scene.title} (\`${context.scene.id}\`)`,
    `- Window: ${w.width}×${w.height}, OS ${w.os}, theme ${w.theme}`,
  ];
  if (app) {
    lines.push(
      `- Host: ${context.host === "browser" ? "Browser" : "OpenBot Desktop"}`,
    );
    if (context.route) lines.push(`- Route: ${context.route}`);
  }
  lines.push(
    `- Link: ${context.link} (open it with \`cd desktop && bun run desktop-workbench\` running)`,
    "",
    "## Layout warnings to check",
    "",
    ...warningLines(report.warnings),
    "",
    "## Elements",
    "",
    ...elementLines(report.elements),
    "",
    "## What to report",
    "",
    "1. Report the findings ordered by severity, the worst first. Give each one a `file:line`.",
    "2. Keep the 4px grid.",
    app
      ? "3. The app's files are under `app/src`. Follow the repo's `openbot-copy` and `openbot-screen-layout` rules there."
      : "3. Follow the repo's `openbot-copy` rules for the text of the setup window. The `openbot-screen-layout` rules are for the app screens under `app/src`: use them only for a finding there.",
    `4. After a change, run \`${command}\` again and compare the new frame with frame.png.`,
    "",
  );
  return lines.join("\n");
}
