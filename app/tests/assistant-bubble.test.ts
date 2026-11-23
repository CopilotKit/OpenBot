/**
 * Compact view's bubble says what is happening in the person's conversations without being opened
 * (app/src/components/desktop/assistant-bubble.tsx): these are its rules for what counts as news,
 * and what it says to a screen reader and under the pointer.
 */
import { expect, test } from "bun:test";
import {
  type BubbleSignal,
  bubbleEvents,
  bubbleLabel,
} from "@/components/desktop/assistant-bubble";

const quiet: BubbleSignal = { working: false, unread: 0, waiting: 0 };

test("what was there when the conversations loaded is not news", () => {
  expect(
    bubbleEvents(undefined, { working: true, unread: 3, waiting: 1 }),
  ).toEqual({ replied: false, finished: false });
});

test("a new reply is news, and reading one is not", () => {
  expect(bubbleEvents(quiet, { ...quiet, unread: 1 }).replied).toBe(true);
  expect(
    bubbleEvents({ ...quiet, unread: 2 }, { ...quiet, unread: 3 }).replied,
  ).toBe(true);
  expect(
    bubbleEvents({ ...quiet, unread: 2 }, { ...quiet, unread: 1 }).replied,
  ).toBe(false);
});

test("the Bots finishing is news once, when the last one stops", () => {
  const working = { ...quiet, working: true };
  expect(bubbleEvents(working, quiet).finished).toBe(true);
  expect(bubbleEvents(working, working).finished).toBe(false);
  expect(bubbleEvents(quiet, working).finished).toBe(false);
});

test("the label says what waits, what is new and who is working, in that order", () => {
  expect(bubbleLabel(quiet)).toBe("Open conversations");
  expect(bubbleLabel({ working: true, unread: 1, waiting: 1 })).toBe(
    "Open conversations, 1 thing needs you, 1 new reply, a Bot is working",
  );
  expect(bubbleLabel({ working: false, unread: 4, waiting: 2 })).toBe(
    "Open conversations, 2 things need you, 4 new replies",
  );
});
