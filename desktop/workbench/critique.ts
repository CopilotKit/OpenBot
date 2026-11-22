// The design-review CLI: turns workbench frames into ready-to-run impeccable reviews.
//
//   bun run workbench:critique <scene> [--at <seconds>]
//     [--command critique|audit|layout|typeset|clarify|polish] [--size <w>x<h>]
//     [--os mac|windows] [--theme light|dark] [--host desktop|browser] [--role member|admin|owner]
//     [--out <dir>] [--all]
//
// For each frame it writes `<out>/<scene>@<at>s/` with frame.png, frame.json and prompt.md.
// `--all` does every committed scene at its end, and each app scene at each run step too, and
// writes index.md. The scenes imported from troubleshooting logs are left out of `--all`.
//
// It drives the page as shot.ts does (cliPage.ts), and adds the component chains to the elements.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ApiRecord } from "./appContract";
import {
  type Browser,
  type Chromium,
  FRAME_FLAGS_USAGE,
  type FrameArgs,
  fail,
  frameState,
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
import { encodeState, type WindowSettings } from "./urlState";

const USAGE = `Usage: bun run workbench:critique <scene> ${FRAME_FLAGS_USAGE} [--command ${CRITIQUE_COMMANDS.join("|")}] [--all]`;

type Options = FrameArgs & { command: CritiqueCommand; all: boolean };

export function parseArgs(argv: readonly string[]): Options {
  let command: CritiqueCommand = "critique";
  let all = false;
  const args = parseFrameArgs(
    argv,
    USAGE,
    resolve(process.cwd(), "workbench-shots", "critique"),
    (arg, value) => {
      if (arg === "--all") all = true;
      else if (arg === "--command") {
        const v = value();
        const found = CRITIQUE_COMMANDS.find((c) => c === v);
        if (!found) fail(USAGE);
        command = found;
      } else return false;
      return true;
    },
  );
  if (all === (args.scene !== "")) fail(USAGE);
  return { ...args, command, all };
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
  const state = (at: number) => frameState(scene.id, at, options);
  const page = await openScenePage(browser, url, scene.id, options);
  for (const at of times) {
    try {
      await seekTo(page, at);
    } catch (error) {
      process.exitCode = 1;
      console.error(
        `${scene.id} at ${at}s: the run stalled: ${messageOf(error)}`,
      );
      break;
    }
    await nextFrame(page);
    const folder = folderName(scene.id, at);
    const dir = join(options.out, folder);
    mkdirSync(dir, { recursive: true });
    await page.locator("[data-workbench-window]").screenshot({
      path: join(dir, "frame.png"),
    });
    const base = await readPageReport(page);
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
    // Also a reused server: stop() gives back this process's lease under the start lock, and
    // stops the server only when no other live lease remains (never one started by hand). The
    // exit hook alone can leave a reused server running with no lease.
    await server.stop();
  }
}

if (import.meta.main) await main();
