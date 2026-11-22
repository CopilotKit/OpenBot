import { describe, expect, test } from "bun:test";
import timings from "../../src/journeyTimings.json";
import { SCENES } from "./index";
import { INSTALL_SCENES } from "./install";
import type { RunStep, Scene } from "./types";

const IDS = [
  "install-mac",
  "install-windows",
  "install-slow-download",
  "install-step-fails",
  "install-slow-sign-in",
  "install-relaunch-update",
  "install-anthropic-plan",
];

function scene(id: string): Scene {
  const found = SCENES.find((each) => each.id === id);
  if (!found) throw new Error(`no scene ${id}`);
  return found;
}

function answered(steps: readonly RunStep[], command: string) {
  return steps.flatMap((step) =>
    "answer" in step && step.answer === command && step.with.mode === "value"
      ? [{ at: step.at, value: step.with.value }]
      : [],
  );
}

describe("install scenes", () => {
  test("the seven install runs are scenes, in the Install group", () => {
    expect(INSTALL_SCENES.map((each) => each.id)).toEqual(IDS);
    for (const id of IDS) expect(scene(id).group).toBe("Install");
  });

  test("install-mac's back end ends its steps in order, each at its milestone", () => {
    const steps = scene("install-mac").run ?? [];
    // The back end starts with Accept, which the account step's Done hands it.
    const accept = steps.find(
      (step) => "click" in step && step.click === "Accept",
    );
    expect(accept).toBeDefined();
    const begin = accept?.at ?? 0;
    const ends = timings.setup.ends as [string, number][];
    const seen: string[] = [];
    for (const { at, value } of answered(steps, "local_eval_steps")) {
      const { ended } = value as { ended: string[] };
      // Each answer keeps what the one before it said, and adds the steps ended since.
      expect(ended.slice(0, seen.length)).toEqual(seen);
      for (const name of ended.slice(seen.length)) {
        const milestone = ends[seen.length];
        expect(name).toBe(milestone[0]);
        expect(at - begin).toBeCloseTo(milestone[1], 5);
        seen.push(name);
      }
    }
    expect(seen).toEqual(ends.map(([name]) => name));

    // Its download runs in the setup's download window, and is gone after it.
    const [from, to] = timings.setup.download;
    const downloads = answered(steps, "local_eval_download");
    expect(downloads.length).toBeGreaterThan(1);
    for (const { at, value } of downloads) {
      expect(at - begin).toBeGreaterThanOrEqual(from);
      expect(at - begin).toBeLessThanOrEqual(to);
      if (at - begin === to) expect(value).toBeNull();
      else expect(value).not.toBeNull();
    }
  });

  test("install-windows runs on Windows, with the Windows answers", () => {
    const { start } = scene("install-windows");
    expect(start.os).toBe("windows");
    expect(start.answers?.windows_blocker).toEqual({
      mode: "value",
      value: null,
    });
    expect(start.answers?.windows_restart_pending).toEqual({
      mode: "value",
      value: false,
    });
  });

  test("every run is in time order, and its rows are numbered in it", () => {
    for (const each of INSTALL_SCENES) {
      const steps = each.run ?? [];
      expect(steps.length).toBeGreaterThan(0);
      for (let i = 1; i < steps.length; i += 1)
        expect(steps[i].at).toBeGreaterThanOrEqual(steps[i - 1].at);
      const seqs = steps.flatMap((step) =>
        "emit" in step && step.emit === "setup:progress"
          ? [(step.payload as { seq: number }).seq]
          : [],
      );
      expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    }
  });

  test("install-anthropic-plan picks Anthropic, then signs in", () => {
    const steps = scene("install-anthropic-plan").run ?? [];
    const clicks = steps.flatMap((step) =>
      "click" in step ? [step.click] : [],
    );
    expect(clicks).toContain("Anthropic");
    expect(clicks.indexOf("Sign in with Anthropic")).toBeGreaterThan(
      clicks.indexOf("Anthropic"),
    );
    // The sign-in's image downloads on the images row before the sign-in gives its address.
    const settled = steps.find(
      (step) => "settle" in step && step.settle === "begin_claude_sign_in",
    );
    const downloading = steps.filter(
      (step) =>
        "emit" in step &&
        (step.payload as { step: string; downloads?: unknown }).step ===
          "images" &&
        (step.payload as { downloads?: unknown }).downloads !== undefined &&
        step.at > 60,
    );
    expect(downloading.length).toBeGreaterThan(1);
    for (const step of downloading)
      expect(step.at).toBeLessThan(settled?.at ?? 0);
  });

  test("install-anthropic-plan's sign-in finishes on its own once the address is open, with nothing typed", () => {
    const steps = scene("install-anthropic-plan").run ?? [];
    expect(steps.some((step) => "type" in step)).toBe(false);
    const begun = steps.find(
      (step) => "settle" in step && step.settle === "begin_claude_sign_in",
    );
    const finished = steps.find(
      (step) => "settle" in step && step.settle === "finish_claude_sign_in",
    );
    expect(begun).toBeDefined();
    expect(finished).toBeDefined();
    expect((begun?.at ?? 99999) < (finished?.at ?? 0)).toBe(true);
    const times = steps.map((step) => step.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
