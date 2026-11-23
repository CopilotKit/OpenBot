import { expect, test } from "bun:test";
import {
  type AppScene,
  PREFERENCES_ROUTE,
} from "../../desktop/workbench/appContract";
import { appFrameConfig } from "../../desktop/workbench/appFrameConfig";
import { DEFAULT_APP, DEFAULT_WINDOW } from "../../desktop/workbench/urlState";
import { APP_SCENES } from "./scenes";
import { skinApi, skinScenes } from "./skins";

test("a skin answers the preferences read with it; no skin answers nothing", () => {
  expect(skinApi(null)).toEqual({});
  const answer = skinApi("opendots")[PREFERENCES_ROUTE];
  expect(answer).toMatchObject({ mode: "value", body: { skin: "opendots" } });
});

const BASE: AppScene = {
  kind: "app",
  id: "app-x",
  title: "X",
  group: "App: Home",
  start: {
    route: "/",
    host: "desktop",
    session: { signedIn: false },
    storage: { other: "1" },
  },
};

test("skinScenes: open and closed where a skin has a sidebar, one scene where it has none", () => {
  const ids = skinScenes(BASE).map((s) => s.id);
  expect(ids).toEqual([
    "app-x-openbot-sidebar-open",
    "app-x-openbot-sidebar-closed",
    "app-x-openduet",
    "app-x-opendots-sidebar-open",
    "app-x-opendots-sidebar-closed",
    "app-x-openfuse",
  ]);
  const closed = skinScenes(BASE).find(
    (s) => s.id === "app-x-opendots-sidebar-closed",
  );
  expect(closed).toMatchObject({
    title: "X: OpenDots, sidebar closed",
    group: "App: Skins",
    start: { skin: "opendots", sidebar: "closed" },
    // OpenDots keeps its sidebar in React state: the scene presses its button.
    run: [{ at: 1, click: "Collapse sidebar" }],
  });
  // OpenBot closes through storage: no step.
  expect(skinScenes(BASE)[1]?.run).toBeUndefined();
});

test("the frame's storage holds the skin and the sidebar; the link wins over the scene", () => {
  const [scene] = skinScenes(BASE).filter((s) =>
    s.id.endsWith("opendots-sidebar-closed"),
  );
  const state = {
    scene: "x",
    at: 0,
    answers: {},
    env: {},
    window: DEFAULT_WINDOW,
    app: DEFAULT_APP,
  };
  const config = appFrameConfig(state, scene as AppScene);
  expect(config.skin).toBe("opendots");
  expect(config.storage).toEqual({
    other: "1",
    "openbot-skin": "opendots",
    "openbot-sidebar": "collapsed",
  });
  const linked = appFrameConfig(
    { ...state, app: { ...DEFAULT_APP, skin: "openfuse", sidebar: "open" } },
    scene as AppScene,
  );
  expect(linked.storage["openbot-skin"]).toBe("openfuse");
  expect(linked.storage["openbot-sidebar"]).toBe("expanded");
  // No skin and no sidebar: the storage is the scene's alone.
  expect(appFrameConfig(state, BASE).storage).toEqual({ other: "1" });
});

test("the main Bot page and Connections are walked in every skin, sidebar open and closed", () => {
  const ids = APP_SCENES.filter((s) => s.group === "App: Skins").map(
    (s) => s.id,
  );
  expect(ids).toContain("app-home-bots-opendots-sidebar-closed");
  expect(ids).toContain("app-settings-connections-openfuse");
  expect(ids).toHaveLength(2 * 6);
});
