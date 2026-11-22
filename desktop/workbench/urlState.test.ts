import { describe, expect, test } from "bun:test";
import type { Scene } from "./scenes/types";
import {
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
});
