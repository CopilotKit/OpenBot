/*
 * The scene catalog: the desktop scenes, then the app scenes. The app scenes live in
 * app/workbench/scenes, and the page loads them at run time from the app server.
 */
import { APP_SCENE_GROUPS, type AppScene, isAppScene } from "./appContract";
import { SCENES } from "./scenes";
import { SCENE_GROUPS, type Scene } from "./scenes/types";

export type DesktopSceneEntry = Scene & { kind?: "desktop" };
export type SceneEntry = DesktopSceneEntry | AppScene;

export const APP_SCENES_URL = "/__app/workbench/scenes/index.ts";

export const ALL_SCENE_GROUPS: readonly string[] = [
  ...SCENE_GROUPS,
  ...APP_SCENE_GROUPS,
];

export function isApp(scene: SceneEntry): scene is AppScene {
  return scene.kind === "app";
}

export function sceneSteps(scene: SceneEntry): readonly { at: number }[] {
  return scene.run ?? [];
}

/** Seconds: the `at` of the last step, or 0 when the scene has no run. */
export function sceneEnd(scene: SceneEntry): number {
  let end = 0;
  for (const step of sceneSteps(scene)) end = Math.max(end, step.at);
  return end;
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

export async function loadScenes(
  load: (url: string) => Promise<unknown> = (url) =>
    import(/* @vite-ignore */ url),
): Promise<{ scenes: SceneEntry[]; notices: string[] }> {
  const desktop: SceneEntry[] = [...SCENES];
  let module: unknown;
  try {
    module = await load(APP_SCENES_URL);
  } catch (error) {
    return {
      scenes: desktop,
      notices: [
        `The app scenes did not load: ${messageOf(error)}. Start the app server with "bun run workbench" in app/.`,
      ],
    };
  }
  const picked = pickAppScenes(module, new Set(SCENES.map((s) => s.id)));
  return { scenes: [...desktop, ...picked.scenes], notices: picked.notices };
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
  );
}
