import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { showBadge } from "../src/background/badge";
import { IDLE_STATE, type RecorderState } from "../src/protocol/messages";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
beforeEach(() => {
  fake = installChromeFake();
});
afterEach(() => {
  fake.uninstall();
});

const recording = (actions: number): RecorderState => ({
  ...IDLE_STATE,
  phase: "recording",
  actions,
});

describe("showBadge", () => {
  test("a recording shows REC in red until the first action", async () => {
    await showBadge(recording(0));
    expect(fake.badge).toEqual({ text: "REC", color: "#e7000b" });
  });

  test("a recording shows its action count", async () => {
    await showBadge(recording(7));
    expect(fake.badge).toEqual({ text: "7", color: "#e7000b" });
    await showBadge(recording(999));
    expect(fake.badge.text).toBe("999");
  });

  test("a count above 999 reads 999+", async () => {
    await showBadge(recording(1000));
    expect(fake.badge.text).toBe("999+");
  });

  test("going idle clears the badge", async () => {
    await showBadge(recording(3));
    await showBadge(IDLE_STATE);
    expect(fake.badge.text).toBe("");
  });
});
