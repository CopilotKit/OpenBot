/**
 * Whether the transcript follows a streaming reply, decided from what the person does.
 *
 * The scroller on its own follows whenever the view is at the end, and a layout change that leaves
 * the view at the end looks the same to it as somebody scrolling there. So the decision is made
 * here, from input events only: moving up the page (wheel, keys, a touch drag, a scrollbar drag)
 * stops following at once, selecting text in the transcript pauses it, and it picks up again when
 * the person comes back down near the end, presses the button, clears their selection or sends.
 * A scroll with no input behind it (content growing, shrinking, the scroller's own moves) is never
 * the person, and changes nothing.
 */

/** How close to the end, in pixels, scrolling back down picks following up again. */
export const RESUME_PX = 80;

export type FollowState = {
  following: boolean;
  pausedBy: "scroll" | "selection" | null;
};

export const FOLLOWING: FollowState = { following: true, pausedBy: null };

export type FollowEvent =
  | { type: "wheel"; deltaY: number }
  | { type: "key"; key: string; shiftKey: boolean }
  /* Positive: the finger moved down the screen, which scrolls the page up. */
  | { type: "touch"; fingerDeltaY: number }
  | {
      type: "scroll";
      top: number;
      previousTop: number;
      fromEnd: number;
      pointerDown: boolean;
    }
  | { type: "selection"; active: boolean }
  | { type: "button" }
  | { type: "send" };

export type FollowStep = {
  state: FollowState;
  scrollToEnd: ScrollBehavior | null;
};

const PAUSED_BY_SCROLL: FollowState = { following: false, pausedBy: "scroll" };
const PAUSED_BY_SELECTION: FollowState = {
  following: false,
  pausedBy: "selection",
};

const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

function movesUp(event: FollowEvent): boolean {
  switch (event.type) {
    case "wheel":
      return event.deltaY < 0;
    case "key":
      return UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey);
    case "touch":
      return event.fingerDeltaY > 0;
    case "scroll":
      // Only a scroll the person is dragging: the scrollbar, with a pointer held down on it.
      return event.pointerDown && event.top < event.previousTop;
    default:
      return false;
  }
}

export function nextFollow(state: FollowState, event: FollowEvent): FollowStep {
  const same = { state, scrollToEnd: null };

  if (movesUp(event)) {
    return state.pausedBy === "scroll"
      ? same
      : { state: PAUSED_BY_SCROLL, scrollToEnd: null };
  }

  switch (event.type) {
    case "scroll":
      return state.pausedBy === "scroll" &&
        event.top > event.previousTop &&
        event.fromEnd <= RESUME_PX
        ? { state: FOLLOWING, scrollToEnd: "auto" }
        : same;
    case "selection":
      if (event.active && state.following) {
        return { state: PAUSED_BY_SELECTION, scrollToEnd: null };
      }
      if (!event.active && state.pausedBy === "selection") {
        return { state: FOLLOWING, scrollToEnd: "auto" };
      }
      return same;
    case "button":
      return { state: FOLLOWING, scrollToEnd: "smooth" };
    case "send":
      return { state: FOLLOWING, scrollToEnd: null };
    default:
      return same;
  }
}
