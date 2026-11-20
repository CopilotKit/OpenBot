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

test("a queued message resumes at the end", () => {
  expect(nextFollow(PAUSED, { type: "queued" })).toEqual({
    state: FOLLOWING,
    scrollToEnd: "auto",
  });
});

/* Jumping to a turn from the rail is the person moving through the conversation, like scrolling up. */
test("a jump from the rail stops following, and coming back to the end resumes it", () => {
  const jumped = nextFollow(FOLLOWING, { type: "jump" });
  expect(jumped).toEqual({ state: PAUSED, scrollToEnd: null });
  expect(nextFollow(jumped.state, scroll(900, 800, 40)).state).toEqual(
    FOLLOWING,
  );
});

/*
 * The scroller drops out of following the bottom on ANY wheel, touch or scroll key, downward ones
 * included, and only comes back on its own when a scroll lands at the end. At the end already,
 * a downward flick scrolls nothing, so it stayed out while this said following and the reply ran
 * off the bottom. A scroll to the end puts it back.
 */
test("downward input at the end while following asks for the end again", () => {
  expect(nextFollow(FOLLOWING, { type: "down", atEnd: true })).toEqual({
    state: FOLLOWING,
    scrollToEnd: "auto",
  });
});

test("downward input above the end, or while paused, asks for nothing", () => {
  expect(nextFollow(FOLLOWING, { type: "down", atEnd: false })).toEqual({
    state: FOLLOWING,
    scrollToEnd: null,
  });
  expect(nextFollow(PAUSED, { type: "down", atEnd: true })).toEqual({
    state: PAUSED,
    scrollToEnd: null,
  });
});
