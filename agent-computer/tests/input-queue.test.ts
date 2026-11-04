import { describe, expect, test } from "bun:test";
import { createInputQueue, foldableOf } from "../src/input-queue";

const move = (x: number, y: number, modifiers = 0) =>
  JSON.stringify({ type: "mouse", event: "moved", x, y, modifiers });
const press = (x: number, y: number) =>
  JSON.stringify({ type: "mouse", event: "pressed", x, y, clickCount: 1 });
const wheel = (deltaY: number, modifiers = 0, x = 10, y = 10) =>
  JSON.stringify({ type: "wheel", x, y, deltaX: 0, deltaY, modifiers });
const key = (k: string) =>
  JSON.stringify({ type: "key", event: "down", key: k, code: `Key${k}` });

/** A queue whose applies wait until released, so a test can pile input up behind the first. */
function heldQueue() {
  const applied: unknown[] = [];
  const releases: Array<() => void> = [];
  const queue = createInputQueue(async (raw) => {
    applied.push(JSON.parse(raw));
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) {
      const next = releases.shift();
      if (next) next();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { queue, applied, settle };
}

describe("live-screen input queue", () => {
  test("moves waiting behind a slow one collapse to the newest", async () => {
    const { queue, applied, settle } = heldQueue();
    queue.push(move(1, 1));
    for (let i = 2; i <= 100; i += 1) queue.push(move(i, i));
    expect(queue.waiting()).toBe(1);
    await settle();
    expect(applied).toEqual([
      JSON.parse(move(1, 1)),
      JSON.parse(move(100, 100)),
    ]);
  });

  test("scrolls waiting add up, at the newest position", async () => {
    const { queue, applied, settle } = heldQueue();
    queue.push(wheel(1));
    queue.push(wheel(10, 0, 5, 5));
    queue.push(wheel(-3, 0, 7, 8));
    queue.push(wheel(20, 0, 9, 9));
    await settle();
    expect(applied).toEqual([
      JSON.parse(wheel(1)),
      { type: "wheel", x: 9, y: 9, deltaX: 0, deltaY: 27, modifiers: 0 },
    ]);
  });

  test("a press, a key, or a change of modifiers is never folded and keeps its place", async () => {
    const { queue, applied, settle } = heldQueue();
    queue.push(move(0, 0));
    queue.push(move(1, 1));
    queue.push(move(2, 2));
    queue.push(press(2, 2));
    queue.push(move(3, 3));
    queue.push(move(4, 4, 8));
    queue.push(key("a"));
    queue.push(wheel(5));
    queue.push(wheel(5, 2));
    await settle();
    expect(applied).toEqual([
      JSON.parse(move(0, 0)),
      JSON.parse(move(2, 2)),
      JSON.parse(press(2, 2)),
      JSON.parse(move(3, 3)),
      JSON.parse(move(4, 4, 8)),
      JSON.parse(key("a")),
      JSON.parse(wheel(5)),
      JSON.parse(wheel(5, 2)),
    ]);
  });

  test("a failed input is reported and the next one still goes through", async () => {
    const applied: string[] = [];
    const errors: unknown[] = [];
    const queue = createInputQueue(
      async (raw) => {
        if (raw === "bad") throw new Error("nope");
        applied.push(raw);
      },
      (error) => errors.push(error),
    );
    queue.push("bad");
    queue.push(key("b"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(applied).toEqual([key("b")]);
  });

  test("anything that is not a well-formed move or scroll is left to validation", () => {
    expect(foldableOf("not json")).toBeNull();
    expect(foldableOf("null")).toBeNull();
    expect(
      foldableOf(
        JSON.stringify({ type: "mouse", event: "moved", x: "1", y: 2 }),
      ),
    ).toBeNull();
    expect(
      foldableOf(
        JSON.stringify({
          type: "wheel",
          x: 1,
          y: 2,
          deltaX: 0,
          deltaY: Number.NaN,
        }),
      ),
    ).toBeNull();
    expect(foldableOf(move(1, 2))?.kind).toBe("move");
    expect(foldableOf(wheel(3))?.kind).toBe("wheel");
  });
});
