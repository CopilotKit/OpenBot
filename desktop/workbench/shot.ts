// The agent CLI: saves a screenshot and a JSON report of a workbench scene.
//
//   bun run workbench:shot <scene> [--at <seconds>] [--grid] [--size <w>x<h>]
//     [--os mac|windows] [--theme light|dark] [--host desktop|browser] [--role member|admin|owner]
//     [--out <dir>] [--all] [--check] [--include-imported]
//
// `--all --check` walks only the committed scenes. Scenes imported from troubleshooting logs are
// local, approximate and differ per computer, so it skips them unless `--include-imported` is set.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ApiRecord, AppHost, Role } from "./appContract";
import {
  isApp,
  loadScenesInBun,
  type SceneEntry,
  sceneEnd,
  sceneSteps,
} from "./sceneCatalog";
import { SCENES as BUILT_IN_SCENES } from "./scenes";
import { SCENE_GROUPS, type Scene } from "./scenes/types";
import { ensureServer } from "./server";
import {
  type AppSettings,
  DEFAULT_APP,
  DEFAULT_WINDOW,
  encodeState,
  type WindowSettings,
  type WorkbenchState,
} from "./urlState";

/** The sentence of the fake API's 404 (app/workbench/api/fakeApi.ts NO_ANSWER_DETAIL). */
const NO_ANSWER_DETAIL = "The workbench has no answer for this request.";

const IMPORTED_DIR = join(import.meta.dir, "scenes", "imported");

/**
 * The scenes that `bun run workbench:import` wrote. The page gets them from Vite's
 * `import.meta.glob` (`scenes/imported.ts`), but bun has no `import.meta.glob`, so the CLI reads
 * the folder itself. A file that is not a scene is skipped with a note.
 */
export function loadImportedScenes(dir: string = IMPORTED_DIR): Scene[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const scenes: Scene[] = [];
  for (const name of names) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      console.warn(`Skipped ${name}: it is not JSON.`);
      continue;
    }
    if (isScene(value)) scenes.push(value);
    else console.warn(`Skipped ${name}: it is not a scene.`);
  }
  return scenes;
}

function isScene(value: unknown): value is Scene {
  if (typeof value !== "object" || value === null) return false;
  const scene = value as Partial<Record<keyof Scene, unknown>>;
  const start = scene.start as Record<string, unknown> | null | undefined;
  return (
    typeof scene.id === "string" &&
    scene.id !== "" &&
    typeof scene.title === "string" &&
    SCENE_GROUPS.includes(scene.group as Scene["group"]) &&
    typeof start === "object" &&
    start !== null &&
    typeof start.hash === "string" &&
    typeof start.search === "string" &&
    (scene.run === undefined || Array.isArray(scene.run))
  );
}

const IMPORTED_SCENES: readonly Scene[] = loadImportedScenes().filter(
  (scene) => !BUILT_IN_SCENES.some((s) => s.id === scene.id),
);

/**
 * The scene catalog (the desktop scenes, then the app scenes), then the imported scenes that the
 * catalog does not have. Under Vite the built-in list already has them. The catalog's notices go
 * to stderr.
 */
async function loadAllScenes(): Promise<SceneEntry[]> {
  const catalog = await loadScenesInBun();
  for (const notice of catalog.notices) console.error(notice);
  const ids = new Set(catalog.scenes.map((s) => s.id));
  return [
    ...catalog.scenes,
    ...IMPORTED_SCENES.filter((scene) => !ids.has(scene.id)),
  ];
}

/**
 * The scenes `--all` shoots. With `--check` it leaves out the imported scenes, unless
 * `includeImported` is set. `skipped` is how many it left out.
 */
export function scenesForAll<T extends { id: string }>(
  scenes: readonly T[],
  importedIds: ReadonlySet<string>,
  options: { check: boolean; includeImported: boolean },
): { scenes: T[]; skipped: number } {
  if (!options.check || options.includeImported)
    return { scenes: [...scenes], skipped: 0 };
  const kept = scenes.filter((scene) => !importedIds.has(scene.id));
  return { scenes: kept, skipped: scenes.length - kept.length };
}

const USAGE =
  "Usage: bun run workbench:shot <scene> [--at <seconds>] [--grid] [--size <w>x<h>] [--os mac|windows] [--theme light|dark] [--host desktop|browser] [--role member|admin|owner] [--out <dir>] [--all] [--check] [--include-imported]";

const PLAYWRIGHT: string = "playwright-core";
type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  evaluate<T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<T>;
  locator(selector: string): {
    screenshot(options: { path: string }): Promise<unknown>;
  };
  on(event: "console", listener: (message: ConsoleMessage) => void): void;
  close(): Promise<void>;
};
type ConsoleMessage = { text(): string };
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    reducedMotion: "reduce";
    locale: string;
    timezoneId: string;
  }): Promise<Page>;
  close(): Promise<void>;
};
type Chromium = { launch(options: { channel: string }): Promise<Browser> };

type Options = {
  scene: string;
  at: number;
  all: boolean;
  check: boolean;
  includeImported: boolean;
  out: string;
  window: WindowSettings;
  app: AppSettings;
};

const HOSTS: readonly AppHost[] = ["desktop", "browser"];
const ROLES: readonly Role[] = ["member", "admin", "owner"];

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const window: WindowSettings = { ...DEFAULT_WINDOW };
  const app: AppSettings = { ...DEFAULT_APP };
  let scene = "";
  let at = 0;
  let all = false;
  let check = false;
  let includeImported = false;
  let out = resolve(process.cwd(), "workbench-shots");
  const value = (i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) fail(USAGE);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--at": {
        const n = Number(value(i++));
        if (!Number.isFinite(n) || n < 0) fail(USAGE);
        at = n;
        break;
      }
      case "--grid":
        window.grid = true;
        break;
      case "--all":
        all = true;
        break;
      case "--check":
        check = true;
        break;
      case "--include-imported":
        includeImported = true;
        break;
      case "--size": {
        const m = /^(\d+)x(\d+)$/.exec(value(i++));
        if (!m) fail(USAGE);
        window.width = Number(m[1]);
        window.height = Number(m[2]);
        break;
      }
      case "--os": {
        const v = value(i++);
        if (v !== "mac" && v !== "windows") fail(USAGE);
        window.os = v;
        break;
      }
      case "--theme": {
        const v = value(i++);
        if (v !== "light" && v !== "dark") fail(USAGE);
        window.theme = v;
        break;
      }
      case "--host": {
        const v = value(i++);
        const host = HOSTS.find((h) => h === v);
        if (!host) fail(USAGE);
        app.host = host;
        break;
      }
      case "--role": {
        const v = value(i++);
        const role = ROLES.find((r) => r === v);
        if (!role) fail(USAGE);
        app.role = role;
        break;
      }
      case "--out":
        out = resolve(process.cwd(), value(i++));
        break;
      default:
        if (arg.startsWith("--") || scene !== "") fail(USAGE);
        scene = arg;
    }
  }
  if (!all && scene === "") fail(USAGE);
  return { scene, at, all, check, includeImported, out, window, app };
}

function unknownScene(id: string, scenes: readonly { id: string }[]): never {
  fail(
    [`There is no scene "${id}". Scenes:`, ...scenes.map((s) => s.id)].join(
      "\n",
    ),
  );
}

/** One thing `--check` found: a run that went wrong in a scene at a time. */
type Problem = { scene: string; at: number; message: string };

async function takeShots(
  browser: Browser,
  url: string,
  options: Options,
  scene: SceneEntry,
  times: number[],
  problems: Problem[],
): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1200 },
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const sceneId = scene.id;
  let now = 0;
  const problem = (message: string): void => {
    problems.push({ scene: sceneId, at: now, message });
  };
  if (options.check) {
    // The page's console includes its frame's.
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("Run step:")) problem(text);
    });
  }
  const state: WorkbenchState = {
    scene: sceneId,
    at: 0,
    answers: {},
    env: {},
    window: options.window,
    app: options.app,
  };
  await page.goto(`${url}/workbench/?${encodeState(state)}`);
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
  const last = times[times.length - 1];
  for (const at of times) {
    now = at;
    let stalled = false;
    try {
      await page.evaluate((ms) => window.__workbenchPage?.seek(ms), at * 1000);
    } catch (error) {
      stalled = true;
      problem(
        `The run stalled: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (options.check && !stalled) {
      const error = await page.evaluate(() => {
        const e = (window.__workbenchPage as { error?: unknown } | undefined)
          ?.error;
        return e === undefined || e === null
          ? ""
          : String(typeof e === "function" ? (e as () => unknown)() : e);
      });
      if (error !== "") problem(`The run stalled: ${error}`);
    }
    if (stalled) break;
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(done)),
    );
    // With --check only the end of a run is saved: the steps before it are there to be walked.
    if (options.check && at !== last) continue;
    const base = `${options.out}/${sceneId}@${at}s`;
    await page.locator("[data-workbench-window]").screenshot({
      path: `${base}.png`,
    });
    const report = await page.evaluate(() => {
      const p = window.__workbenchPage;
      const handedBack = (
        p as { handedBack?: () => unknown } | undefined
      )?.handedBack?.();
      return {
        kind: p?.kind ?? "desktop",
        handedOver: p?.handedOver() ?? false,
        handedBack: handedBack ?? null,
        elements: p?.elements?.() ?? [],
        warnings: p?.warnings?.() ?? [],
        calls: p?.calls() ?? [],
        requests: p?.requests?.() ?? ([] as readonly ApiRecord[]),
        errors: p?.errors?.() ?? ([] as readonly string[]),
      };
    });
    if (options.check && isApp(scene)) {
      for (const record of report.requests) {
        if (record.source === "none") {
          problem(`No answer for ${record.method} ${record.path}`);
        }
      }
      for (const message of report.errors) {
        if (!message.includes(NO_ANSWER_DETAIL)) {
          problem(`Error in the app: ${message}`);
        }
      }
    }
    await Bun.write(
      `${base}.json`,
      `${JSON.stringify({ scene: sceneId, at, window: options.window, ...report }, null, 2)}\n`,
    );
    console.log(`${base}.png`);
    console.log(`${base}.json`);
  }
  await page.close();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const scenes = await loadAllScenes();
  const chosen = scenes.find((s) => s.id === options.scene);
  if (!options.all && !chosen) unknownScene(options.scene, scenes);
  mkdirSync(options.out, { recursive: true });

  const problems: Problem[] = [];
  const server = await ensureServer();
  let browser: Browser | undefined;
  try {
    const { chromium } = (await import(PLAYWRIGHT)) as {
      chromium: Chromium;
    };
    browser = await chromium.launch({ channel: "chromium" });
    if (options.all) {
      const picked = scenesForAll(
        scenes,
        new Set(IMPORTED_SCENES.map((s) => s.id)),
        options,
      );
      if (picked.skipped > 0) {
        console.log(
          `Skipped ${picked.skipped} imported scene(s) from troubleshooting logs. Add --include-imported to check them too.`,
        );
      }
      for (const scene of picked.scenes) {
        const steps = sceneSteps(scene).map((s) => s.at);
        const times = [...new Set([...steps, sceneEnd(scene)])].sort(
          (a, b) => a - b,
        );
        await takeShots(browser, server.url, options, scene, times, problems);
      }
    } else if (chosen) {
      await takeShots(
        browser,
        server.url,
        options,
        chosen,
        [options.at],
        problems,
      );
    }
  } finally {
    await browser?.close();
    if (server.started) await server.stop();
  }
  for (const p of problems) {
    console.error(`${p.scene} at ${p.at}s: ${p.message}`);
  }
  if (problems.length > 0) process.exit(1);
}

// Tests import this file for `loadImportedScenes`; only the CLI runs `main`.
if (import.meta.main) await main();
