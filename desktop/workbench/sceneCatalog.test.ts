import { describe, expect, test } from "bun:test";
import type { AppScene } from "./appContract";
import {
  APP_SCENES_URL,
  APP_SERVER_HINT,
  isApp,
  loadScenes,
  pickAppScenes,
  type SceneEntry,
  sceneEnd,
} from "./sceneCatalog";
import { SCENES } from "./scenes";

function appScene(id: string, run?: AppScene["run"]): AppScene {
  return {
    kind: "app",
    id,
    title: `Scene ${id}`,
    group: "App: Home",
    start: { route: "/", host: "desktop", session: { signedIn: false } },
    ...(run ? { run } : {}),
  };
}

describe("pickAppScenes", () => {
  test("keeps good scenes and gives both notices", () => {
    const out = pickAppScenes(
      {
        APP_SCENES: [
          appScene("app-home"),
          { kind: "app", id: "broken" },
          appScene("taken"),
          appScene("app-settings"),
        ],
      },
      new Set(["taken"]),
    );
    expect(out.scenes.map((s) => s.id)).toEqual(["app-home", "app-settings"]);
    expect(out.notices).toEqual([
      "The app scene at index 1 is not valid. The workbench leaves it out.",
      'The app scene "taken" has the id of a desktop scene. The workbench leaves it out.',
    ]);
  });

  test("a module with no list gives a notice", () => {
    const out = pickAppScenes({}, new Set());
    expect(out.scenes).toEqual([]);
    expect(out.notices.length).toBe(1);
  });
});

describe("loadScenes", () => {
  test("a failed load gives the desktop scenes and a notice", async () => {
    const out = await loadScenes(() => Promise.reject(new Error("No server")));
    expect(out.scenes).toEqual([...SCENES]);
    expect(out.notices).toEqual([
      `The app scenes did not load: No server. ${APP_SERVER_HINT}`,
    ]);
  });

  test("desktop scenes first, then the app scenes", async () => {
    let asked = "";
    const out = await loadScenes((url) => {
      asked = url;
      return Promise.resolve({ APP_SCENES: [appScene("app-only")] });
    });
    expect(asked).toBe(APP_SCENES_URL);
    expect(out.notices).toEqual([]);
    expect(out.scenes.length).toBe(SCENES.length + 1);
    const last = out.scenes.at(-1) as SceneEntry;
    expect(isApp(last)).toBe(true);
    expect(out.scenes.slice(0, SCENES.length).some(isApp)).toBe(false);
  });
});

describe("sceneEnd", () => {
  test("a desktop run", () => {
    const withRun = SCENES.find((s) => s.run && s.run.length > 0);
    expect(withRun).toBeDefined();
    if (!withRun?.run) return;
    const expected = Math.max(...withRun.run.map((s) => s.at));
    expect(sceneEnd(withRun)).toBe(expected);
  });

  test("an app run", () => {
    const scene = appScene("app-run", [
      { at: 0.5, click: "button" },
      { at: 3, navigate: "/settings" },
    ]);
    expect(sceneEnd(scene)).toBe(3);
  });

  test("no run", () => {
    expect(sceneEnd(appScene("app-still"))).toBe(0);
  });
});
