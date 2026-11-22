/*
 * Turns an OpenBot Desktop troubleshooting file into a workbench scene.
 *
 * The file is what `troubleshooting::bundle` writes (`src-tauri/src/troubleshooting.rs`): a header
 * with "Summary: OpenBot Desktop <version> (...) on <os> <arch>.", then "## What failed", and the
 * end of the Desktop log in "## OpenBot Desktop log (end)". Every row the setup window shows is in
 * that log as `[step <id>] <entry>` (`report_line` and `report_running_line` in `main.rs`), and a
 * failed row as `[step <id>] failed: <entry>`. The entry is `<detail> (window: <what the window
 * said>)` when the row has technical words for the log (`engine::StepLine::log_entry`), else the
 * window's words. Each app start writes `[launch] OpenBot Desktop ...`.
 *
 * THE SCENE IS APPROXIMATE. The log has the rows' words and their times, and nothing more: no
 * download bytes, no download counts, no answers from the back end, and no clicks. The scene plays
 * the rows at the times the log has, as `setup:progress` events, on top of the fake native side.
 *
 * Nothing here throws on odd input: lines it does not know are skipped.
 */
import type { Answer } from "../src/fakeNative/control";
import type { Progress } from "../src/SetupProgress";
import type { Os } from "./frameConfig";
import type { RunStep, Scene } from "./scenes/types";

/** One setup row from the Desktop log. */
export type LogStep = {
  /** Seconds from the session's first `[step]` line. */
  at: number;
  /** The row's step id: `engine`, `images`, `services`, ... */
  step: string;
  /** The entry as logged, without `(window: ...)`. */
  text: string;
  /** What the window said, when the entry carries it. */
  window?: string;
  /** False when the log wrote it as `[step x] failed: ...`. */
  ok: boolean;
};

/** The Desktop log lines from one app start to the next. */
export type Session = {
  /** The time of the session's first line, as the log writes it. */
  startedAt: string | null;
  steps: LogStep[];
  /** The ERROR lines' messages. */
  problems: string[];
};

export type ParsedLog = {
  version: string | null;
  os: Os;
  /** The text under "What failed", or null when nothing failed. */
  failed: string | null;
  sessions: Session[];
};

const LINE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(.*)$/;
const STEP = /^\[step ([\w.-]+)\]\s+(failed:\s+)?(.*)$/;
const LAUNCH = /^\[launch\] OpenBot Desktop /;
const NOTHING_FAILED = "Nothing reported a failure.";

/** The lines under each "## " heading, by heading. A "## " line in a ``` block is not a heading. */
function sections(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | null = null;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("```")) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) {
      current = [];
      found.set(line.slice(3).trim(), current);
      continue;
    }
    current?.push(line);
  }
  return found;
}

/** Splits `<detail> (window: <said>)` into its two parts. */
function splitWindow(entry: string): { text: string; window?: string } {
  const marker = " (window: ";
  const index = entry.lastIndexOf(marker);
  if (index < 0 || !entry.endsWith(")")) return { text: entry };
  return {
    text: entry.slice(0, index),
    window: entry.slice(index + marker.length, -1),
  };
}

function seconds(stamp: string): number {
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

/** Reads a troubleshooting file. Never throws: what it does not know it skips. */
export function parseTroubleshooting(text: string): ParsedLog {
  const input = typeof text === "string" ? text : "";
  const summary = /^Summary: OpenBot Desktop (\S+).* on (\w+)/m.exec(input);
  const system = summary?.[2] ?? /^System: (\w+)/m.exec(input)?.[1] ?? "";
  const os: Os = system.toLowerCase() === "windows" ? "windows" : "mac";
  const parts = sections(input);

  const failedText = (parts.get("What failed") ?? []).join("\n").trim();
  const failed =
    failedText === "" || failedText === NOTHING_FAILED ? null : failedText;

  const sessions: Session[] = [];
  let session: Session | null = null;
  let first: number | null = null;
  for (const raw of parts.get("OpenBot Desktop log (end)") ?? []) {
    const line = LINE.exec(raw.trimEnd());
    if (!line) continue;
    const [, stamp, level, message] = line;
    if (LAUNCH.test(message) || !session) {
      session = { startedAt: stamp, steps: [], problems: [] };
      sessions.push(session);
      first = null;
    }
    if (level === "ERROR") session.problems.push(message);
    const step = STEP.exec(message);
    if (!step) continue;
    const now = seconds(stamp);
    first ??= now;
    session.steps.push({
      at: Math.round((now - first) * 10) / 10,
      step: step[1],
      ok: !step[2],
      ...splitWindow(step[3]),
    });
  }
  return { version: summary?.[1] ?? null, os, failed, sessions };
}

export type ToSceneOptions = {
  /** Which session, from 0. By default the last one with setup rows. */
  session?: number;
  /** A first run plays from the first screen with Install pressed; a relaunch from `#start`. */
  start: "first-run" | "relaunch";
  id?: string;
  title?: string;
};

/** When a first run's Install is pressed, and when the log's rows begin after it. */
const INSTALL_AT = 0.5;
const FIRST_RUN_ROWS_AT = 0.6;
/** A relaunch starts by itself; its rows begin as `install-relaunch-update`'s do. */
const RELAUNCH_ROWS_AT = 1;

/**
 * What the first screen needs to wait on the rows, as `install.ts`'s first runs have it: the native
 * commands Install and the steps after it call do not answer, so the rows are all the window sees.
 * Every other command gets the fake native side's first-run answer.
 */
const FIRST_RUN_ANSWERS: Record<string, Answer> = {
  prepare_installation: { mode: "never" },
  sign_in_to_copilotkit: { mode: "never" },
  set_up_local_eval: { mode: "never" },
  start_stack: { mode: "never" },
};

/** As `install-relaunch-update`: the Start that updates OpenBot does not answer. */
const RELAUNCH_ANSWERS: Record<string, Answer> = {
  upgrade_and_start: { mode: "never" },
};

/** A short, stable hash (FNV-1a, 32 bits) as 6 hex digits. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/** The session `toScene` uses: the one asked for when it exists, else the last with rows. */
export function pickSession(
  parsed: ParsedLog,
  session?: number,
): { index: number; session: Session } | null {
  const { sessions } = parsed;
  if (
    session !== undefined &&
    Number.isInteger(session) &&
    session >= 0 &&
    session < sessions.length
  )
    return { index: session, session: sessions[session] };
  for (let i = sessions.length - 1; i >= 0; i -= 1)
    if (sessions[i].steps.length > 0) return { index: i, session: sessions[i] };
  return sessions.length > 0
    ? { index: sessions.length - 1, session: sessions[sessions.length - 1] }
    : null;
}

/** `log-<date of the session>-<hash>`, the same for the same rows and start. */
export function defaultSceneId(
  parsed: ParsedLog,
  options: Pick<ToSceneOptions, "session" | "start">,
): string {
  const picked = pickSession(parsed, options.session);
  const date = picked?.session.startedAt?.slice(0, 10) ?? "undated";
  const rows = (picked?.session.steps ?? [])
    .map((s) => `${s.at} ${s.step} ${s.ok} ${s.text} ${s.window ?? ""}`)
    .join("\n");
  return `log-${date}-${shortHash(`${options.start}\n${parsed.version}\n${rows}`)}`;
}

/** The progress rows, numbered in order, with each step's last row done and the ones before it running. */
function progressRows(
  steps: readonly LogStep[],
  failed: string | null,
  offset: number,
): RunStep[] {
  return steps.map((line, index) => {
    const later = steps.slice(index + 1).some((s) => s.step === line.step);
    const last = index === steps.length - 1;
    const payload: Progress & { seq: number } = {
      seq: index + 1,
      step: line.step,
      ok: line.ok,
      running: later,
      detail: line.window ?? line.text,
    };
    if (last && failed !== null) {
      payload.ok = false;
      payload.running = false;
      payload.detail = failed;
    }
    return {
      at: Math.round((offset + line.at) * 10) / 10,
      emit: "setup:progress",
      payload,
    };
  });
}

/** A scene that plays the log's setup rows. Approximate: see the top of this file. */
export function toScene(parsed: ParsedLog, options: ToSceneOptions): Scene {
  const relaunch = options.start === "relaunch";
  const picked = pickSession(parsed, options.session);
  const steps = picked?.session.steps ?? [];
  const date = picked?.session.startedAt?.slice(0, 10);
  const what = relaunch ? "Open again" : "Install";
  const where = parsed.os === "windows" ? "on Windows" : "on a Mac";
  const version = parsed.version ? ` ${parsed.version}` : "";
  const note =
    steps.length > 0 ? "(from a log)" : "(from a log: it has no setup rows)";
  const title =
    options.title ??
    `${what}${version} ${where}${date ? `, ${date}` : ""} ${note}`;

  const scene: Scene = {
    id: options.id ?? defaultSceneId(parsed, options),
    title,
    group: relaunch ? "Update" : "Install",
    start: {
      hash: relaunch ? "#start" : "",
      search: "",
      os: parsed.os,
      answers: { ...(relaunch ? RELAUNCH_ANSWERS : FIRST_RUN_ANSWERS) },
    },
  };
  if (steps.length === 0) return scene;

  const rows = progressRows(
    steps,
    parsed.failed,
    relaunch ? RELAUNCH_ROWS_AT : FIRST_RUN_ROWS_AT,
  );
  // A first run's rows begin when the person presses Install. The log has no clicks, and the
  // steps after Install (sign in, Accept, Continue) wait on answers the log does not have, so
  // Install is the only click the scene makes.
  scene.run = relaunch ? rows : [{ at: INSTALL_AT, click: "Install" }, ...rows];
  return scene;
}
