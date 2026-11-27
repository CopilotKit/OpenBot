import { expect, test } from "bun:test";
import { shouldGlideOnSend } from "@/components/channels/chat-transcript";

/**
 * The viewport glides for a beat when the person sends something, so the eye can follow their
 * message up to where it anchors. It must never glide for history: that animated the jump to the
 * bottom while a channel opened, which is the one moment nothing should be seen moving.
 *
 * A send is one row arriving. History arrives in batches — the gateway snapshot, the stored
 * thread merged in after the restore gate lifts, a late voice card, a roster re-read — so the
 * glide only fires when exactly one row arrived with the new id.
 */

test("no glide while restoring", () => {
  expect(
    shouldGlideOnSend({
      previous: "a",
      next: "b",
      restoring: true,
      reducedMotion: false,
      arrivedRows: 1,
    }),
  ).toBe(false);
});

test("no glide for the first id after restore", () => {
  expect(
    shouldGlideOnSend({
      previous: null,
      next: "b",
      restoring: false,
      reducedMotion: false,
      arrivedRows: 1,
    }),
  ).toBe(false);
});

test("glide when a new message is sent", () => {
  expect(
    shouldGlideOnSend({
      previous: "a",
      next: "b",
      restoring: false,
      reducedMotion: false,
      arrivedRows: 1,
    }),
  ).toBe(true);
});

test("no glide when nothing changed", () => {
  expect(
    shouldGlideOnSend({
      previous: "a",
      next: "a",
      restoring: false,
      reducedMotion: false,
      arrivedRows: 0,
    }),
  ).toBe(false);
});

test("no glide under reduced motion", () => {
  expect(
    shouldGlideOnSend({
      previous: "a",
      next: "b",
      restoring: false,
      reducedMotion: true,
      arrivedRows: 1,
    }),
  ).toBe(false);
});

test("no glide when history arrives in a batch", () => {
  expect(
    shouldGlideOnSend({
      previous: "a",
      next: "b",
      restoring: false,
      reducedMotion: false,
      arrivedRows: 40,
    }),
  ).toBe(false);
});

test("no glide when a batch arrives with no new user message", () => {
  expect(
    shouldGlideOnSend({
      previous: "a",
      next: "a",
      restoring: false,
      reducedMotion: false,
      arrivedRows: 40,
    }),
  ).toBe(false);
});
