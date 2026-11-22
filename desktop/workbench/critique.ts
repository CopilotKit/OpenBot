// The design-review CLI: turns workbench frames into ready-to-run impeccable reviews.
//
//   bun run workbench:critique <scene> [--at <seconds>]
//     [--command critique|audit|layout|typeset|clarify|polish] [--size <w>x<h>]
//     [--os mac|windows] [--theme light|dark] [--host desktop|browser] [--out <dir>] [--all]
//
// For each frame it writes `<out>/<scene>@<at>s/` with frame.png, frame.json and prompt.md.
// `--all` does every committed scene at its end, and each app scene at each run step too, and
// writes index.md. The scenes imported from troubleshooting logs are left out of `--all`.
//
// shot.ts drives one page per scene in the same way. Its `takeShots` is not exported, so the page
// driving below is a short copy of it, with the component chains added to the elements.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ApiRecord, AppHost } from "./appContract";
import {
  buildCritiquePrompt,
  buildIndex,
  CRITIQUE_COMMANDS,
  type CritiqueCommand,
  type CritiqueContext,
  critiqueTarget,
  type FrameElement,
  folderName,
  type IndexEntry,
} from "./critiquePrompt";
import {
  isApp,
  loadScenesInBun,
  type SceneEntry,
  sceneEnd,
  sceneSteps,
} from "./sceneCatalog";
import { ensureServer, WORKBENCH_URL } from "./server";
import { loadImportedScenes } from "./shot";
import {
  type AppSettings,
  DEFAULT_APP,
  DEFAULT_WINDOW,
  encodeState,
  type WindowSettings,
  type WorkbenchState,
} from "./urlState";

const USAGE = `Usage: bun run workbench:critique <scene> [--at <seconds>] [--command ${CRITIQUE_COMMANDS.join("|")}] [--size <w>x<h>] [--os mac|windows] [--theme light|dark] [--host desktop|browser] [--out <dir>] [--all]`;

const PLAYWRIGHT: string = "playwright-core";
type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  evaluate<T, A = undefined>(
    run: ((arg: A) => T) | string,
    arg?: A,
  ): Promise<T>;
  locator(selector: string): {
    screenshot(options: { path: string }): Promise<unknown>;
  };
  close(): Promise<void>;
};
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
  command: CritiqueCommand;
  all: boolean;
  out: string;
  window: WindowSettings;
  app: AppSettings;
};

const HOSTS: readonly AppHost[] = ["desktop", "browser"];

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

export function parseArgs(argv: readonly string[]): Options {
  const window: WindowSettings = { ...DEFAULT_WINDOW };
  const app: AppSettings = { ...DEFAULT_APP };
  let scene = "";
  let at = 0;
  let command: CritiqueCommand = "critique";
  let all = false;
  let out = resolve(process.cwd(), "workbench-shots", "critique");
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
      case "--command": {
        const v = value(i++);
        const found = CRITIQUE_COMMANDS.find((c) => c === v);
        if (!found) fail(USAGE);
        command = found;
        break;
      }
      case "--all":
        all = true;
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
      case "--out":
        out = resolve(process.cwd(), value(i++));
        break;
      default:
        if (arg.startsWith("--") || scene !== "") fail(USAGE);
        scene = arg;
    }
  }
  if (all === (scene !== "")) fail(USAGE);
  return { scene, at, command, all, out, window, app };
}

function unknownScene(id: string, scenes: readonly { id: string }[]): never {
  fail(
    [`There is no scene "${id}". Scenes:`, ...scenes.map((s) => s.id)].join(
      "\n",
    ),
  );
}

/**
 * The elements of the loaded window with their component chains. It runs in the page and loads
 * the workbench's own modules from the Vite server, so the elements, keys and labels are the ones
 * `__workbenchPage.elements()` gives, and the lines come from the source maps.
 */
const ELEMENTS_WITH_CHAINS = `(async () => {
  const frame = document.querySelector("[data-workbench-window] iframe");
  const doc = frame && frame.contentDocument;
  if (!doc) return [];
  const [{ componentChain }, { visibleElements }, { resolveLines }] = await Promise.all([
    import("/workbench/componentChain.ts"),
    import("/workbench/layoutWatch.ts"),
    import("/workbench/sourceLines.ts"),
  ]);
  const cache = new Map();
  const seen = new Map();
  const result = [];
  for (const { element, key, label, box } of visibleElements(doc)) {
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    let chain = [];
    try {
      chain = await resolveLines(componentChain(element, 12), undefined, cache);
    } catch {}
    result.push({
      key: count === 1 ? key : key + "#" + count,
      chain: chain.map(({ name, file, line }) => ({ name, file, line })),
    });
  }
  return result;
})()`;

type FrameReport = {
  scene: string;
  at: number;
  window: WindowSettings;
  kind: "desktop" | "app";
  handedOver: boolean;
  handedBack: string | null;
  elements: FrameElement[];
  warnings: CritiqueReportWarnings;
  calls: unknown[];
  requests: readonly ApiRecord[];
  errors: readonly string[];
};
type CritiqueReportWarnings = Parameters<
  typeof buildCritiquePrompt
>[0]["warnings"];

async function critiqueScene(
  browser: Browser,
  url: string,
  options: Options,
  scene: SceneEntry,
  times: readonly number[],
  entries: IndexEntry[],
): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1200 },
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const state = (at: number): WorkbenchState => ({
    scene: scene.id,
    at,
    answers: {},
    env: {},
    window: options.window,
    app: options.app,
  });
  await page.goto(`${url}/workbench/?${encodeState(state(0))}`);
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
  for (const at of times) {
    try {
      await page.evaluate((ms) => window.__workbenchPage?.seek(ms), at * 1000);
    } catch (error) {
      process.exitCode = 1;
      console.error(
        `${scene.id} at ${at}s: the run stalled: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(done)),
    );
    const folder = folderName(scene.id, at);
    const dir = join(options.out, folder);
    mkdirSync(dir, { recursive: true });
    await page.locator("[data-workbench-window]").screenshot({
      path: join(dir, "frame.png"),
    });
    const base = await page.evaluate(() => {
      const p = window.__workbenchPage;
      const handedBack = (
        p as { handedBack?: () => unknown } | undefined
      )?.handedBack?.();
      return {
        kind: p?.kind ?? "desktop",
        handedOver: p?.handedOver() ?? false,
        handedBack: (handedBack ?? null) as string | null,
        elements: p?.elements?.() ?? [],
        warnings: p?.warnings?.() ?? [],
        calls: (p?.calls() ?? []) as unknown[],
        requests: p?.requests?.() ?? ([] as readonly ApiRecord[]),
        errors: p?.errors?.() ?? ([] as readonly string[]),
      };
    });
    const chains =
      await page.evaluate<{ key: string; chain: FrameElement["chain"] }[]>(
        ELEMENTS_WITH_CHAINS,
      );
    const chainOf = new Map(chains.map((c) => [c.key, c.chain]));
    const elements: FrameElement[] = base.elements.map((el) => ({
      ...el,
      chain: chainOf.get(el.key) ?? [],
    }));
    const route = isApp(scene)
      ? await page.evaluate(() => {
          const frame = document.querySelector<HTMLIFrameElement>(
            "[data-workbench-window] iframe",
          );
          const loc = frame?.contentWindow?.location;
          return loc ? `${loc.pathname}${loc.search}${loc.hash}` : "";
        })
      : "";
    const report: FrameReport = {
      scene: scene.id,
      at,
      window: options.window,
      ...base,
      elements,
    };
    await Bun.write(
      join(dir, "frame.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    const context: CritiqueContext = {
      command: options.command,
      scene: { id: scene.id, title: scene.title },
      at,
      window: options.window,
      host: options.app.host ?? (isApp(scene) ? scene.start.host : "desktop"),
      hostFlag: options.app.host,
      route: isApp(scene) ? route || scene.start.route : undefined,
      link: `${WORKBENCH_URL}/workbench/?${encodeState(state(at))}`,
    };
    await Bun.write(
      join(dir, "prompt.md"),
      buildCritiquePrompt(report, context),
    );
    entries.push({
      folder,
      scene: context.scene,
      at,
      warnings: report.warnings.length,
      target: critiqueTarget(report, context),
    });
    console.log(dir);
  }
  await page.close();
}

/** The times `--all` reviews: the end of every scene, and each run step of an app scene. */
export function critiqueTimes(scene: SceneEntry): number[] {
  const steps = isApp(scene) ? sceneSteps(scene).map((s) => s.at) : [];
  return [...new Set([...steps, sceneEnd(scene)])].sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const catalog = await loadScenesInBun();
  for (const notice of catalog.notices) console.error(notice);
  const committed: SceneEntry[] = catalog.scenes;
  const ids = new Set(committed.map((s) => s.id));
  const scenes: SceneEntry[] = [
    ...committed,
    ...loadImportedScenes().filter((s) => !ids.has(s.id)),
  ];
  const chosen = scenes.find((s) => s.id === options.scene);
  if (!options.all && !chosen) unknownScene(options.scene, scenes);
  mkdirSync(options.out, { recursive: true });

  const entries: IndexEntry[] = [];
  const server = await ensureServer();
  let browser: Browser | undefined;
  try {
    const { chromium } = (await import(PLAYWRIGHT)) as { chromium: Chromium };
    browser = await chromium.launch({ channel: "chromium" });
    if (options.all) {
      // The imported scenes are local and approximate: `--all` reviews the committed scenes only.
      for (const scene of committed) {
        await critiqueScene(
          browser,
          server.url,
          options,
          scene,
          critiqueTimes(scene),
          entries,
        );
      }
      const index = join(options.out, "index.md");
      await Bun.write(index, buildIndex(entries, options.command));
      console.log(index);
    } else if (chosen) {
      await critiqueScene(
        browser,
        server.url,
        options,
        chosen,
        [options.at],
        entries,
      );
    }
  } finally {
    await browser?.close();
    if (server.started) await server.stop();
  }
}

if (import.meta.main) await main();
