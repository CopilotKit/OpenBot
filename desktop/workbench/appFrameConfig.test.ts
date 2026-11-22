import { expect, test } from "bun:test";
import type { AppScene } from "./appContract";
import { appFrameConfig } from "./appFrameConfig";
import { DEFAULT_WINDOW, type WorkbenchState } from "./urlState";

const scene: AppScene = {
  kind: "app",
  id: "app-home",
  title: "Home",
  group: "App: Home",
  start: {
    route: "/",
    host: "desktop",
    session: { signedIn: false },
    storage: { "openbot.theme": "dark" },
  },
};

function state(extra: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    scene: scene.id,
    at: 0,
    answers: {},
    env: {},
    window: { ...DEFAULT_WINDOW },
    ...extra,
  };
}

test("it takes the scene's host unless the state names one", () => {
  expect(appFrameConfig(state(), scene).host).toBe("desktop");
  expect(
    appFrameConfig(
      state({ app: { host: null, role: null, motion: "still" } }),
      scene,
    ).host,
  ).toBe("desktop");
  expect(
    appFrameConfig(
      state({ app: { host: "browser", role: null, motion: "still" } }),
      scene,
    ).host,
  ).toBe("browser");
});

test("motion is still and role is null by default", () => {
  const config = appFrameConfig(state(), scene);
  expect(config.motion).toBe("still");
  expect(config.role).toBeNull();
  const set = appFrameConfig(
    state({ app: { host: null, role: "admin", motion: "real" } }),
    scene,
  );
  expect(set.motion).toBe("real");
  expect(set.role).toBe("admin");
});

test("api is {} when the state has none", () => {
  expect(appFrameConfig(state(), scene).api).toEqual({});
  const api = { "GET /api/v2/me": { mode: "never" } } as const;
  expect(appFrameConfig(state({ api }), scene).api).toEqual(api);
});

test("it takes the scene id, the window, the answers and the scene's storage", () => {
  const answers = { status: { mode: "never" } } as const;
  const config = appFrameConfig(
    state({
      answers,
      window: { ...DEFAULT_WINDOW, os: "windows", theme: "light" },
    }),
    scene,
  );
  expect(config.scene).toBe("app-home");
  expect(config.os).toBe("windows");
  expect(config.theme).toBe("light");
  expect(config.answers).toEqual(answers);
  expect(config.storage).toEqual({ "openbot.theme": "dark" });
  const { storage: _, ...start } = scene.start;
  expect(appFrameConfig(state(), { ...scene, start }).storage).toEqual({});
});
