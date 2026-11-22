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
import { NO_ANSWER_DETAIL } from "./appContract";
import {
  type Browser,
  type Chromium,
  FRAME_FLAGS_USAGE,
  type FrameArgs,
  fail,
  messageOf,
  nextFrame,
  openScenePage,
  PLAYWRIGHT,
  parseFrameArgs,
  readPageReport,
  seekTo,
  unknownScene,
} from "./cliPage";
import {
  isApp,
  loadScenesInBun,
  type SceneEntry,
  sceneEnd,
  sceneSteps,
} from "./sceneCatalog";
import { SCENES as BUILT_IN_SCENES } from "./scenes";
import { isScene } from "./scenes/imported";
import type { Scene } from "./scenes/types";
import { ensureServer } from "./server";

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

const USAGE = `Usage: bun run workbench:shot <scene> ${FRAME_FLAGS_USAGE} [--grid] [--all] [--check] [--include-imported]`;

type Options = FrameArgs & {
  all: boolean;
  check: boolean;
  includeImported: boolean;
};

function parseArgs(argv: string[]): Options {
  let all = false;
  let check = false;
  let includeImported = false;
  let grid = false;
  const args = parseFrameArgs(
    argv,
    USAGE,
    resolve(process.cwd(), "workbench-shots"),
    (arg) => {
      if (arg === "--grid") grid = true;
      else if (arg === "--all") all = true;
      else if (arg === "--check") check = true;
      else if (arg === "--include-imported") includeImported = true;
      else return false;
      return true;
    },
  );
  if (grid) args.window.grid = true;
  if (!all && args.scene === "") fail(USAGE);
  return { ...args, all, check, includeImported };
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
  const sceneId = scene.id;
  let now = 0;
  const problem = (message: string): void => {
    problems.push({ scene: sceneId, at: now, message });
  };
  const page = await openScenePage(browser, url, sceneId, options, (page) => {
    if (!options.check) return;
    // The page's console includes its frame's.
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("Run step:")) problem(text);
    });
  });
  const last = times[times.length - 1];
  for (const at of times) {
    now = at;
    let stalled = false;
    try {
      await seekTo(page, at);
    } catch (error) {
      stalled = true;
      problem(`The run stalled: ${messageOf(error)}`);
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
    await nextFrame(page);
    // With --check only the end of a run is saved: the steps before it are there to be walked.
    if (options.check && at !== last) continue;
    const base = `${options.out}/${sceneId}@${at}s`;
    await page.locator("[data-workbench-window]").screenshot({
      path: `${base}.png`,
    });
    const report = await readPageReport(page);
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
    // Also a reused server: stop() gives back this process's lease under the start lock, and
    // stops the server only when no other live lease remains (never one started by hand). The
    // exit hook alone can leave a reused server running with no lease.
    await server.stop();
  }
  for (const p of problems) {
    console.error(`${p.scene} at ${p.at}s: ${p.message}`);
  }
  if (problems.length > 0) process.exit(1);
}

// Tests import this file for `loadImportedScenes`; only the CLI runs `main`.
if (import.meta.main) await main();
