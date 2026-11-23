import { describe, expect, test } from "bun:test";
import type { Scene } from "./scenes/types";
import {
  DEFAULT_APP,
  DEFAULT_WINDOW,
  decodeState,
  encodeState,
  type WorkbenchState,
} from "./urlState";

const scenes = [
  {
    id: "first",
    title: "First",
    group: "Install",
    start: { hash: "", search: "" },
  },
  {
    id: "second",
    title: "Second",
    group: "Install",
    start: { hash: "", search: "" },
  },
] as Scene[];
const commands = ["alpha", "beta"];

const state: WorkbenchState = {
  scene: "second",
  at: 2.5,
  answers: {
    alpha: { mode: "value", value: { a: 1 } },
    beta: { mode: "fail", problem: { said: "No." } as never },
  },
  env: { VITE_OPENBOT_CLOUD_ENABLED: "true" },
  window: { ...DEFAULT_WINDOW, width: 720, height: 560, os: "windows" },
  api: {},
  app: DEFAULT_APP,
};

describe("urlState", () => {
  test("round trip", () => {
    const out = decodeState(`?${encodeState(state)}`, scenes, commands);
    expect(out.notices).toEqual([]);
    expect(out.state).toEqual(state);
  });

  test("unknown scene", () => {
    const out = decodeState("scene=nope", scenes, commands);
    expect(out.state.scene).toBe("first");
    expect(out.notices[0]).toContain("nope");
  });

  test("unknown command is dropped", () => {
    const query = encodeState({
      ...state,
      answers: { ghost: { mode: "never" } },
    });
    const out = decodeState(query, scenes, commands);
    expect(out.state.answers).toEqual({});
    expect(out.notices.join(" ")).toContain("ghost");
  });

  test("script answers are not encoded", () => {
    const query = encodeState({
      ...state,
      answers: { alpha: { mode: "script", run: () => 1 } },
    });
    expect(query).not.toContain("script");
  });

  test("garbage gives defaults and notices", () => {
    const out = decodeState("?w=abc&answers={", scenes, commands);
    expect(out.state.window).toEqual(DEFAULT_WINDOW);
    expect(out.notices.length).toBe(2);
  });

  test("empty scenes do not throw", () => {
    expect(decodeState("", [], commands).state.scene).toBe("");
  });

  test("a negative delay answer is dropped", () => {
    const query = encodeState({
      ...state,
      answers: { alpha: { mode: "delay", ms: -5, value: 1 } },
    });
    const out = decodeState(query, scenes, commands);
    expect(out.state.answers).toEqual({});
    expect(out.notices.join(" ")).toContain("alpha");
  });

  test("a zero delay answer is kept", () => {
    const query = encodeState({
      ...state,
      answers: { alpha: { mode: "delay", ms: 0, value: 1 } },
    });
    const out = decodeState(query, scenes, commands);
    expect(out.state.answers.alpha).toEqual({ mode: "delay", ms: 0, value: 1 });
  });

  test("zoom outside 0.5 to 2 gives the default and a notice", () => {
    for (const zoom of ["0.1", "3", "0"]) {
      const out = decodeState(`zoom=${zoom}`, scenes, commands);
      expect(out.state.window.zoom).toBe(DEFAULT_WINDOW.zoom);
      expect(out.notices.join(" ")).toContain("zoom");
    }
    for (const zoom of ["0.5", "2", "1.5"]) {
      const out = decodeState(`zoom=${zoom}`, scenes, commands);
      expect(out.state.window.zoom).toBe(Number(zoom));
      expect(out.notices).toEqual([]);
    }
  });

  test("round trip with api, host, role and motion", () => {
    const full: WorkbenchState = {
      ...state,
      api: {
        "GET /api/v2/organizations/:organizationId/bots": {
          mode: "value",
          body: [{ id: "bot-1", name: "Helper" }],
        },
        "POST /api/v2/things": { mode: "fail", status: 500 },
        "ALL /api/*": { mode: "offline" },
      },
      app: {
        host: "browser",
        role: "admin",
        motion: "real",
        skin: "opendots",
        sidebar: "closed",
      },
    };
    const out = decodeState(`?${encodeState(full)}`, scenes, commands);
    expect(out.notices).toEqual([]);
    expect(out.state).toEqual(full);
  });

  test("default app settings and no api add no params", () => {
    const query = new URLSearchParams(encodeState(state));
    for (const key of ["api", "host", "role", "motion", "skin", "sidebar"]) {
      expect(query.has(key)).toBe(false);
    }
    const noFields: WorkbenchState = { ...state };
    delete noFields.api;
    delete noFields.app;
    expect(encodeState(noFields)).toBe(encodeState(state));
  });

  test("an old link decodes to no api and the default app settings", () => {
    const out = decodeState("scene=first&at=1", scenes, commands);
    expect(out.notices).toEqual([]);
    expect(out.state.api).toEqual({});
    expect(out.state.app).toEqual(DEFAULT_APP);
  });

  test("api that is not JSON gives a notice", () => {
    const out = decodeState("api={", scenes, commands);
    expect(out.state.api).toEqual({});
    expect(out.notices).toEqual([
      "The api value is not valid JSON. The workbench ignores it.",
    ]);
  });

  test("a key that is not an API route gives a notice", () => {
    const api = JSON.stringify({
      "/api/v2/bots": { mode: "never" },
      "GET /api/v2/ok": { mode: "never" },
    });
    const out = decodeState(`api=${encodeURIComponent(api)}`, scenes, commands);
    expect(out.state.api).toEqual({ "GET /api/v2/ok": { mode: "never" } });
    expect(out.notices).toEqual([
      '"/api/v2/bots" is not an API route. Write a method and a path, for example GET /api/v2/organizations/:organizationId/bots. The workbench ignores it.',
    ]);
  });

  test("an answer that is not valid gives a notice", () => {
    const api = JSON.stringify({ "GET /api/v2/bots": { mode: "fail" } });
    const out = decodeState(`api=${encodeURIComponent(api)}`, scenes, commands);
    expect(out.state.api).toEqual({});
    expect(out.notices).toEqual([
      'The API answer for "GET /api/v2/bots" is not valid. The workbench ignores it.',
    ]);
  });

  test("bad host, role and motion give notices and defaults", () => {
    const out = decodeState(
      "host=phone&role=king&motion=fast",
      scenes,
      commands,
    );
    expect(out.state.app).toEqual(DEFAULT_APP);
    expect(out.notices).toEqual([
      'The host "phone" is not valid. The workbench uses the scene\'s host.',
      'The role "king" is not valid. The workbench uses the scene\'s role.',
      'The motion "fast" is not valid. The workbench uses "still".',
    ]);
  });

  test("decodeState takes any list of objects with an id", () => {
    const out = decodeState("scene=app-one", [{ id: "app-one" }], commands);
    expect(out.state.scene).toBe("app-one");
  });
});
