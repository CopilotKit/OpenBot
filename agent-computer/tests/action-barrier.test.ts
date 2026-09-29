import { expect, test } from "bun:test";
import { createActionBarrier } from "../src/action-barrier";

test("closing admission refuses new actions and drains admitted work exactly once", async () => {
  const barrier = createActionBarrier();
  const release = barrier.enter();
  barrier.close();
  expect(() => barrier.enter()).toThrow(/closed/);
  let drained = false;
  const waiting = barrier.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  release();
  await waiting;
  expect(barrier.pending()).toBe(0);
  barrier.open();
  barrier.enter()();
});

test("a drain timeout never grants admission", async () => {
  const barrier = createActionBarrier();
  const release = barrier.enter();
  barrier.close();
  await expect(barrier.drain(1)).rejects.toThrow(/still finishing/);
  expect(() => barrier.enter()).toThrow();
  release();
  await barrier.drain();
});
