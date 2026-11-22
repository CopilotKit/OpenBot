import { describe, expect, test } from "bun:test";
import { STATE_NAMES } from "../../src/fakeNative/states";
import { SCENES } from "./index";
import { STATE_SCENES } from "./states";
import { SCENE_GROUPS } from "./types";

describe("scenes", () => {
  test("each test state has exactly one scene", () => {
    for (const state of STATE_NAMES) {
      const found = STATE_SCENES.filter(
        (scene) =>
          scene.start.hash === state.hash &&
          scene.start.search === state.search,
      );
      expect(found.length).toBe(1);
    }
  });

  test("ids are unique", () => {
    const ids = SCENES.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("each group is a known group", () => {
    for (const scene of SCENES) {
      expect(SCENE_GROUPS).toContain(scene.group);
    }
  });

  test("the first state scene is the first run", () => {
    expect(STATE_SCENES[0]?.id).toBe("state-first-run");
  });
});
