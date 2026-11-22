import { describe, expect, test } from "bun:test";
import { SCENES } from "./index";
import type { Scene } from "./types";
import { WINDOW_SCENES } from "./windows";

const GROUPS: Record<string, Scene["group"]> = {
  "status-stop-start": "Status",
  "status-updating": "Status",
  "relaunch-update-progress": "Update",
  "move-to-cloud": "Move to Cloud",
  "move-to-cloud-fails": "Move to Cloud",
  "shutting-down": "Shutting down",
};

/** The Shutting down screen has nothing to press (`ShuttingDown.tsx`): Quit is in the menu bar. */
const NOTHING_TO_PRESS = ["shutting-down"];

function scene(id: string): Scene {
  const found = SCENES.find((each) => each.id === id);
  if (!found) throw new Error(`no scene ${id}`);
  return found;
}

describe("window scenes", () => {
  test("the six window runs are scenes, each in its group", () => {
    expect(WINDOW_SCENES.map((each) => each.id)).toEqual(Object.keys(GROUPS));
    for (const [id, group] of Object.entries(GROUPS))
      expect(scene(id).group).toBe(group);
  });

  test("they come after the install runs and before the state scenes", () => {
    const ids = SCENES.map((each) => each.id);
    const first = ids.indexOf("status-stop-start");
    expect(ids[first - 1]).toBe("install-anthropic-plan");
    expect(ids[first + WINDOW_SCENES.length]).toBe("state-first-run");
  });

  test("every run is in time order", () => {
    for (const each of WINDOW_SCENES) {
      const at = (each.run ?? []).map((step) => step.at);
      expect(at.length).toBeGreaterThan(0);
      expect(at).toEqual([...at].sort((a, b) => a - b));
    }
  });

  test("every run has a click, but the Shutting down screen's", () => {
    for (const each of WINDOW_SCENES) {
      const clicks = (each.run ?? []).filter((step) => "click" in step);
      if (NOTHING_TO_PRESS.includes(each.id)) expect(clicks).toEqual([]);
      else expect(clicks.length).toBeGreaterThan(0);
    }
  });

  test("the Shutting down rows' sequence only rises", () => {
    const seqs = (scene("shutting-down").run ?? []).map((step) =>
      "emit" in step ? (step.payload as { seq: number }).seq : 0,
    );
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("a failed move is answered again before Try again", () => {
    const steps = scene("move-to-cloud-fails").run ?? [];
    const failed = steps.findIndex(
      (step) => "fail" in step && step.fail === "move_to_cloud",
    );
    const again = steps.findIndex(
      (step) =>
        "answer" in step &&
        step.answer === "move_to_cloud" &&
        step.with.mode === "never",
    );
    const tryAgain = steps.findIndex(
      (step) => "click" in step && step.click === "Try again",
    );
    expect(failed).toBeGreaterThan(-1);
    expect(again).toBeGreaterThan(failed);
    expect(tryAgain).toBeGreaterThan(again);
  });
});
