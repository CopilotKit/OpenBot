import { expect, test } from "bun:test";
import {
  FOLLOWING,
  type FollowState,
  nextFollow,
} from "@/components/channels/follow-intent";

/**
 * Whether the view follows a streaming reply is decided by what the person does, never by where the
 * view happens to be after a layout change. Moving up the page stops following at once; coming back
 * down near the end, pressing the button or sending picks it up again.
 */

const PAUSED: FollowState = { following: false, pausedBy: "scroll" };
const SELECTING: FollowState = { following: false, pausedBy: "selection" };

function scroll(
  top: number,
  previousTop: number,
  fromEnd = 400,
  pointerDown = false,
) {
  return { type: "scroll" as const, top, previousTop, fromEnd, pointerDown };
}

test("an upward wheel stops following", () => {
  expect(nextFollow(FOLLOWING, { type: "wheel", deltaY: -40 })).toEqual({
    state: PAUSED,
    scrollToEnd: null,
  });
});

test("a downward wheel keeps following", () => {
  expect(nextFollow(FOLLOWING, { type: "wheel", deltaY: 40 }).state).toBe(
    FOLLOWING,
  );
});

test("scroll keys stop following", () => {
  for (const key of ["PageUp", "ArrowUp", "Home"]) {
    expect(
      nextFollow(FOLLOWING, { type: "key", key, shiftKey: false }).state,
    ).toEqual(PAUSED);
  }
  expect(
    nextFollow(FOLLOWING, { type: "key", key: " ", shiftKey: true }).state,
  ).toEqual(PAUSED);
  expect(
    nextFollow(FOLLOWING, { type: "key", key: " ", shiftKey: false }).state,
  ).toBe(FOLLOWING);
  expect(
    nextFollow(FOLLOWING, { type: "key", key: "ArrowDown", shiftKey: false })
      .state,
  ).toBe(FOLLOWING);
});

test("a touch drag up the page stops following", () => {
  expect(
    nextFollow(FOLLOWING, { type: "touch", fingerDeltaY: 12 }).state,
  ).toEqual(PAUSED);
  expect(
    nextFollow(FOLLOWING, { type: "touch", fingerDeltaY: -12 }).state,
  ).toBe(FOLLOWING);
});

test("a scrollbar drag up stops following", () => {
  expect(nextFollow(FOLLOWING, scroll(400, 500, 400, true)).state).toEqual(
    PAUSED,
  );
});

test("a layout correction is not the person scrolling", () => {
  expect(nextFollow(FOLLOWING, scroll(400, 500, 0, false)).state).toBe(
    FOLLOWING,
  );
});

test("scrolling back down to within 80px resumes", () => {
  expect(nextFollow(PAUSED, scroll(900, 850, 60))).toEqual({
    state: FOLLOWING,
    scrollToEnd: "auto",
  });
  expect(nextFollow(PAUSED, scroll(900, 850, 81)).state).toBe(PAUSED);
});

test("an upward move ending near the end does not resume", () => {
  expect(nextFollow(PAUSED, scroll(850, 900, 60)).state).toBe(PAUSED);
});

test("selecting text pauses and clearing it resumes", () => {
  const paused = nextFollow(FOLLOWING, { type: "selection", active: true });
  expect(paused).toEqual({ state: SELECTING, scrollToEnd: null });
  expect(
    nextFollow(paused.state, { type: "selection", active: false }),
  ).toEqual({ state: FOLLOWING, scrollToEnd: "auto" });
});

test("scrolling away while selecting is a scroll pause", () => {
  expect(nextFollow(SELECTING, { type: "wheel", deltaY: -40 }).state).toEqual(
    PAUSED,
  );
});

test("clearing a selection does not resume a scroll pause", () => {
  expect(nextFollow(PAUSED, { type: "selection", active: false }).state).toBe(
    PAUSED,
  );
  expect(nextFollow(PAUSED, { type: "selection", active: true }).state).toBe(
    PAUSED,
  );
});

test("the button resumes smoothly", () => {
  expect(nextFollow(PAUSED, { type: "button" })).toEqual({
    state: FOLLOWING,
    scrollToEnd: "smooth",
  });
});

test("a send resumes without scrolling", () => {
  expect(nextFollow(PAUSED, { type: "send" })).toEqual({
    state: FOLLOWING,
    scrollToEnd: null,
  });
});
