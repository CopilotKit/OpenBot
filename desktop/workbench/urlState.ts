import type { Answer } from "../src/fakeNative/control";
import type { EnvValues, Os } from "./frameConfig";
import type { Scene } from "./scenes/types";

export type WindowSettings = {
  width: number;
  height: number;
  os: Os;
  active: boolean;
  theme: "light" | "dark";
  zoom: number;
  grid: boolean;
};

export type WorkbenchState = {
  scene: string;
  /** Seconds from the scene start. */
  at: number;
  answers: Record<string, Answer>;
  env: EnvValues;
  window: WindowSettings;
};

export const DEFAULT_WINDOW: WindowSettings = {
  width: 1000,
  height: 800,
  os: "mac",
  active: true,
  theme: "dark",
  zoom: 1,
  grid: false,
};

export const MIN_WINDOW = { width: 720, height: 560 };

export function encodeState(state: WorkbenchState): string {
  const params = new URLSearchParams();
  params.set("scene", state.scene);
  params.set("at", String(state.at));
  params.set("w", String(state.window.width));
  params.set("h", String(state.window.height));
  params.set("os", state.window.os);
  params.set("active", state.window.active ? "1" : "0");
  params.set("theme", state.window.theme);
  params.set("zoom", String(state.window.zoom));
  params.set("grid", state.window.grid ? "1" : "0");
  params.set("env", JSON.stringify(state.env));
  const answers: Record<string, Answer> = {};
  for (const [name, answer] of Object.entries(state.answers)) {
    if (answer.mode !== "script") answers[name] = answer;
  }
  params.set("answers", JSON.stringify(answers));
  return params.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAnswer(value: unknown): Answer | null {
  if (!isRecord(value)) return null;
  switch (value.mode) {
    case "value":
      return "value" in value ? { mode: "value", value: value.value } : null;
    case "never":
      return { mode: "never" };
    case "fail": {
      const problem = value.problem;
      if (isRecord(problem) && typeof problem.said === "string") {
        return { mode: "fail", problem: problem as never };
      }
      return null;
    }
    case "delay":
      return typeof value.ms === "number" &&
        Number.isFinite(value.ms) &&
        value.ms >= 0
        ? { mode: "delay", ms: value.ms, value: value.value }
        : null;
    default:
      return null;
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function parseNumber(text: string | null): number | null {
  if (text === null || text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function decodeState(
  query: string,
  scenes: readonly Scene[],
  commands: readonly string[],
): { state: WorkbenchState; notices: string[] } {
  const params = new URLSearchParams(
    query.startsWith("?") ? query.slice(1) : query,
  );
  const notices: string[] = [];

  const firstId = scenes[0]?.id ?? "";
  let scene = firstId;
  const sceneParam = params.get("scene");
  if (sceneParam !== null) {
    if (scenes.some((s) => s.id === sceneParam)) scene = sceneParam;
    else {
      notices.push(
        `There is no scene "${sceneParam}". The workbench shows "${firstId}" instead.`,
      );
    }
  }

  let at = 0;
  const atParam = params.get("at");
  if (atParam !== null) {
    const n = parseNumber(atParam);
    if (n !== null && n >= 0) at = n;
    else
      notices.push(
        `The time "${atParam}" is not valid. The workbench starts at 0.`,
      );
  }

  const win: WindowSettings = { ...DEFAULT_WINDOW };

  for (const [key, min] of [
    ["w", MIN_WINDOW.width],
    ["h", MIN_WINDOW.height],
  ] as const) {
    const text = params.get(key);
    if (text === null) continue;
    const n = parseNumber(text);
    const field = key === "w" ? "width" : "height";
    if (n !== null && n >= min) win[field] = n;
    else {
      notices.push(
        `The window ${field} "${text}" is not valid. It must be a number of at least ${min}. The workbench uses ${DEFAULT_WINDOW[field]}.`,
      );
    }
  }

  const os = params.get("os");
  if (os !== null) {
    if (os === "mac" || os === "windows") win.os = os;
    else
      notices.push(
        `The system "${os}" is not valid. The workbench uses "${DEFAULT_WINDOW.os}".`,
      );
  }

  const theme = params.get("theme");
  if (theme !== null) {
    if (theme === "light" || theme === "dark") win.theme = theme;
    else
      notices.push(
        `The theme "${theme}" is not valid. The workbench uses "${DEFAULT_WINDOW.theme}".`,
      );
  }

  const zoom = params.get("zoom");
  if (zoom !== null) {
    const n = parseNumber(zoom);
    if (n !== null && n >= 0.5 && n <= 2) win.zoom = n;
    else
      notices.push(
        `The zoom "${zoom}" is not valid. The workbench uses ${DEFAULT_WINDOW.zoom}.`,
      );
  }

  const active = params.get("active");
  if (active !== null) win.active = active !== "0";
  const grid = params.get("grid");
  if (grid !== null) win.grid = grid === "1";

  let env: EnvValues = {};
  const envText = params.get("env");
  if (envText !== null) {
    const parsed = parseJson(envText);
    if (parsed.ok && isRecord(parsed.value)) {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.value)) {
        if (typeof v === "string") clean[k] = v;
      }
      env = clean as EnvValues;
    } else
      notices.push(
        "The env value is not valid JSON. The workbench ignores it.",
      );
  }

  const answers: Record<string, Answer> = {};
  const answersText = params.get("answers");
  if (answersText !== null) {
    const parsed = parseJson(answersText);
    if (parsed.ok && isRecord(parsed.value)) {
      for (const [name, raw] of Object.entries(parsed.value)) {
        if (!commands.includes(name)) {
          notices.push(
            `There is no command "${name}". The workbench ignores its answer.`,
          );
          continue;
        }
        const answer = parseAnswer(raw);
        if (answer) answers[name] = answer;
        else
          notices.push(
            `The answer for the command "${name}" is not valid. The workbench ignores it.`,
          );
      }
    } else
      notices.push(
        "The answers value is not valid JSON. The workbench ignores it.",
      );
  }

  return { state: { scene, at, answers, env, window: win }, notices };
}
