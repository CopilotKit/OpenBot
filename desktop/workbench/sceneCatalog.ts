/*
 * The scene catalog: the desktop scenes, then the app scenes. The app scenes live in
 * app/workbench/scenes, and the page loads them at run time from the app server.
 */
import { type AppScene, isAppScene } from "./appContract";
import { SCENES } from "./scenes";
import type { Scene } from "./scenes/types";

export type DesktopSceneEntry = Scene & { kind?: "desktop" };
export type SceneEntry = DesktopSceneEntry | AppScene;

export const APP_SCENES_URL = "/__app/workbench/scenes/index.ts";

/** What to do when the app scenes did not load. The workbench starts the app server itself. */
export const APP_SERVER_HINT =
  "The app server did not start or does not answer. Look in the workbench server's log (the terminal of bun run desktop-workbench, or <tmpdir>/openbot-workbench-<port>/server.log when the CLI or a test started it), then stop and start the workbench.";

export function isApp(scene: SceneEntry): scene is AppScene {
  return scene.kind === "app";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function pickAppScenes(
  module: unknown,
  desktopIds: ReadonlySet<string>,
): { scenes: AppScene[]; notices: string[] } {
  const scenes: AppScene[] = [];
  const notices: string[] = [];
  const list = isRecord(module) ? module.APP_SCENES : undefined;
  if (!Array.isArray(list)) {
    notices.push(
      "The app scenes file has no APP_SCENES list. The workbench shows the desktop scenes only.",
    );
    return { scenes, notices };
  }
  list.forEach((item: unknown, i) => {
    if (!isAppScene(item)) {
      notices.push(
        `The app scene at index ${i} is not valid. The workbench leaves it out.`,
      );
      return;
    }
    if (desktopIds.has(item.id)) {
      notices.push(
        `The app scene "${item.id}" has the id of a desktop scene. The workbench leaves it out.`,
      );
      return;
    }
    scenes.push(item);
  });
  return { scenes, notices };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How long the page keeps asking for the app scenes. The desktop server takes requests before the
 * app server it starts has come up (up to 90 s, APP_START_TIMEOUT_MS in vite.workbench.config.ts),
 * so a first failure is usually the app server still starting.
 */
const APP_SCENES_TRIES = 46;
const APP_SCENES_WAIT_MS = 2000;

export async function loadScenes(
  load: (url: string) => Promise<unknown> = (url) =>
    import(/* @vite-ignore */ url),
  { tries = APP_SCENES_TRIES, waitMs = APP_SCENES_WAIT_MS } = {},
): Promise<{ scenes: SceneEntry[]; notices: string[] }> {
  const desktop: SceneEntry[] = [...SCENES];
  let module: unknown;
  for (let attempt = 1; ; attempt++) {
    try {
      // A new URL for each try: a browser can keep a failed import and answer the same URL with it.
      module = await load(
        attempt === 1 ? APP_SCENES_URL : `${APP_SCENES_URL}?try=${attempt}`,
      );
      break;
    } catch (error) {
      if (attempt < tries) {
        await new Promise((done) => setTimeout(done, waitMs));
        continue;
      }
      return {
        scenes: desktop,
        notices: [
          `The app scenes did not load: ${messageOf(error)}. ${APP_SERVER_HINT}`,
        ],
      };
    }
  }
  const picked = pickAppScenes(module, new Set(SCENES.map((s) => s.id)));
  return { scenes: [...picked.scenes, ...desktop], notices: picked.notices };
}

/** For the CLI: loads the app scenes from the file, not from the app server. */
export function loadScenesInBun(): Promise<{
  scenes: SceneEntry[];
  notices: string[];
}> {
  return loadScenes(
    () =>
      import(
        /* @vite-ignore */ `${import.meta.dir}/../../app/workbench/scenes/index.ts`
      ),
    // A file on disk: a failure is not a server still starting.
    { tries: 1 },
  );
}
