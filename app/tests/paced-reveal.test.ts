import { expect, test } from "bun:test";
import { FINISH_MS, nextReveal } from "@/components/channels/paced-reveal";

/**
 * A streaming reply arrives in bursts; it is revealed at a steady pace a little behind what has
 * arrived, a word at a time, and never so far behind that it is still typing long after the Bot
 * stopped: once the stream ends, the rest is out within FINISH_MS.
 */

const BURST = Array.from(
  { length: 80 },
  (_, index) => `word${index % 10}`,
).join(" ");

function atBoundary(text: string, shown: number): boolean {
  return shown === text.length || /\s/.test(text[shown] ?? "");
}

test("a 400-character burst reveals over several frames, on word boundaries", () => {
  const text = BURST.slice(0, 400);
  const lastSpace = text.lastIndexOf(" ");
  const seen = new Set<number>();
  let shown = 0;
  for (let frame = 0; frame < 120; frame++) {
    shown = nextReveal({
      text,
      shown,
      elapsedMs: 16,
      streaming: true,
      finishInMs: FINISH_MS,
    });
    seen.add(shown);
    expect(atBoundary(text, shown)).toBe(true);
    expect(shown).toBeLessThanOrEqual(lastSpace);
  }
  expect(seen.size).toBeGreaterThanOrEqual(5);
  expect(shown).toBe(lastSpace);
});

test("after the stream ends the rest is revealed within FINISH_MS", () => {
  const text = BURST;
  let shown = 0;
  let finishInMs = FINISH_MS;
  while (finishInMs > 0) {
    shown = nextReveal({
      text,
      shown,
      elapsedMs: 16,
      streaming: false,
      finishInMs,
    });
    expect(atBoundary(text, shown)).toBe(true);
    finishInMs -= 16;
  }
  shown = nextReveal({
    text,
    shown,
    elapsedMs: 16,
    streaming: false,
    finishInMs,
  });
  expect(shown).toBe(text.length);
});

test("never goes backwards", () => {
  const text = "one two three four";
  expect(
    nextReveal({
      text,
      shown: 8,
      elapsedMs: 0,
      streaming: true,
      finishInMs: FINISH_MS,
    }),
  ).toBeGreaterThanOrEqual(8);
});

test("a shorter text clamps", () => {
  expect(
    nextReveal({
      text: "short",
      shown: 40,
      elapsedMs: 16,
      streaming: true,
      finishInMs: FINISH_MS,
    }),
  ).toBe(5);
});

/*
 * Text with no spaces (Chinese, Japanese, a long link) has no word to stop at. Held back to the last
 * space, the whole reply stayed hidden for as long as it streamed and then appeared at once.
 */
test("text with no spaces still reveals while it streams", () => {
  const text = "这是一个没有空格的很长的回答".repeat(20);
  const seen = new Set<number>();
  let shown = 0;
  for (let frame = 0; frame < 60; frame++) {
    shown = nextReveal({
      text,
      shown,
      elapsedMs: 16,
      streaming: true,
      finishInMs: FINISH_MS,
    });
    seen.add(shown);
  }
  expect(seen.size).toBeGreaterThanOrEqual(5);
  expect(shown).toBeGreaterThan(text.length / 2);
});

/* A reply whose text has stopped growing is finished, even while the run goes on with other work. */
test("a tail that has stopped growing is shown", () => {
  const text = "here is a chart of your sales:";
  let shown = 0;
  for (let frame = 0; frame < 60; frame++) {
    shown = nextReveal({
      text,
      shown,
      elapsedMs: 16,
      streaming: true,
      holdTail: false,
      finishInMs: FINISH_MS,
    });
  }
  expect(shown).toBe(text.length);
});
