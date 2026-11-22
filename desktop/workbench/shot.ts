// The agent CLI: saves a screenshot and a JSON report of a workbench scene.
//
//   bun run workbench:shot <scene> [--at <seconds>] [--grid] [--size <w>x<h>]
//     [--os mac|windows] [--theme light|dark] [--out <dir>] [--all] [--check] [--include-imported]
//
// `--all --check` walks only the committed scenes. Scenes imported from troubleshooting logs are
// local, approximate and differ per computer, so it skips them unless `--include-imported` is set.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SCENES as BUILT_IN_SCENES } from "./scenes";
import { SCENE_GROUPS, type Scene } from "./scenes/types";
import { ensureServer } from "./server";
import { DEFAULT_WINDOW, encodeState, type WindowSettings } from "./urlState";

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

/** The built-in scenes, then the imported ones. Under Vite the built-in list already has them. */
const SCENES: readonly Scene[] = [...BUILT_IN_SCENES, ...IMPORTED_SCENES];

/**
 * The scenes `--all` shoots. With `--check` it leaves out the imported scenes, unless
 * `includeImported` is set. `skipped` is how many it left out.
 */
export function scenesForAll(
  scenes: readonly Scene[],
  importedIds: ReadonlySet<string>,
  options: { check: boolean; includeImported: boolean },
): { scenes: Scene[]; skipped: number } {
  if (!options.check || options.includeImported)
    return { scenes: [...scenes], skipped: 0 };
  const kept = scenes.filter((scene) => !importedIds.has(scene.id));
  return { scenes: kept, skipped: scenes.length - kept.length };
}

const USAGE =
  "Usage: bun run workbench:shot <scene> [--at <seconds>] [--grid] [--size <w>x<h>] [--os mac|windows] [--theme light|dark] [--out <dir>] [--all] [--check] [--include-imported]";

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
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const window: WindowSettings = { ...DEFAULT_WINDOW };
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
      case "--out":
        out = resolve(process.cwd(), value(i++));
        break;
      default:
        if (arg.startsWith("--") || scene !== "") fail(USAGE);
        scene = arg;
    }
  }
  if (!all && scene === "") fail(USAGE);
  return { scene, at, all, check, includeImported, out, window };
}

function unknownScene(id: string): never {
  fail(
    [`There is no scene "${id}". Scenes:`, ...SCENES.map((s) => s.id)].join(
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
  sceneId: string,
  times: number[],
  problems: Problem[],
): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1200 },
    reducedMotion: "reduce",
  });
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
  const state = {
    scene: sceneId,
    at: 0,
    answers: {},
    env: {},
    window: options.window,
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
      return {
        handedOver: p?.handedOver() ?? false,
        elements: p?.elements?.() ?? [],
        warnings: p?.warnings?.() ?? [],
        calls: p?.calls() ?? [],
      };
    });
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
  if (!options.all && !SCENES.some((s) => s.id === options.scene)) {
    unknownScene(options.scene);
  }
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
        SCENES,
        new Set(IMPORTED_SCENES.map((s) => s.id)),
        options,
      );
      if (picked.skipped > 0) {
        console.log(
          `Skipped ${picked.skipped} imported scene(s) from troubleshooting logs. Add --include-imported to check them too.`,
        );
      }
      for (const scene of picked.scenes) {
        const steps = (scene.run ?? []).map((s) => s.at);
        const end = steps.length > 0 ? Math.max(...steps) : 0;
        const times = [...new Set([...steps, end])].sort((a, b) => a - b);
        await takeShots(
          browser,
          server.url,
          options,
          scene.id,
          times,
          problems,
        );
      }
    } else {
      await takeShots(
        browser,
        server.url,
        options,
        options.scene,
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
