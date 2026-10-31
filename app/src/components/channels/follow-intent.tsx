import { useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useMessageScroller } from "@/components/ui/message-scroller";

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
  /*
   * A wheel, key or touch moving down the page. The scroller stops following the bottom on any
   * input; at the end, where nothing scrolls, only a scroll to the end puts it back.
   */
  | { type: "down"; atEnd: boolean }
  /* A mark on the rail: they went to a turn of their choosing, so stay with what they chose. */
  | { type: "jump" }
  | { type: "send" }
  /* A message parked under the conversation: they are looking at the end, so go there. */
  | { type: "queued" };

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
const DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End"]);

/** Within this many pixels of the end, a downward input has nothing left to scroll. */
const END_PX = 8;

function movesUp(event: FollowEvent): boolean {
  switch (event.type) {
    case "wheel":
      return event.deltaY < 0;
    case "key":
      return UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey);
    case "touch":
      return event.fingerDeltaY > 0;
    case "jump":
      return true;
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
    case "down":
      return state.following && event.atEnd
        ? { state, scrollToEnd: "auto" }
        : same;
    case "button":
      return { state: FOLLOWING, scrollToEnd: "smooth" };
    case "send":
      return { state: FOLLOWING, scrollToEnd: null };
    case "queued":
      return { state: FOLLOWING, scrollToEnd: "auto" };
    default:
      return same;
  }
}

function isEditable(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

export type FollowRequest = { behavior: ScrollBehavior; tick: number };

type ViewportHandlers = Pick<
  React.ComponentProps<"div">,
  | "onWheel"
  | "onKeyDown"
  | "onTouchStart"
  | "onTouchMove"
  | "onPointerDown"
  | "onScroll"
>;

/**
 * The follow state for one transcript, fed from the viewport's input events and from a selection
 * anywhere inside it. Back to following whenever a conversation is being restored, so a channel
 * opened next never inherits where the last one was left.
 *
 * `following` goes to the scroller as `autoScroll`; `request` is a scroll to the end that a resume
 * asked for, carried out by `FollowScroll` inside the scroller once `autoScroll` is already true.
 */
export function useFollowIntent(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  restoring: boolean,
): {
  following: boolean;
  dispatch: (event: FollowEvent) => void;
  request: FollowRequest | null;
  viewportHandlers: ViewportHandlers;
} {
  const reducedMotion = useReducedMotion() ?? false;
  const [state, setState] = useState(FOLLOWING);
  const [request, setRequest] = useState<FollowRequest | null>(null);
  const stateRef = useRef(state);

  if (restoring && (state !== FOLLOWING || request !== null)) {
    stateRef.current = FOLLOWING;
    setState(FOLLOWING);
    setRequest(null);
  }

  const dispatch = useCallback(
    (event: FollowEvent) => {
      const step = nextFollow(stateRef.current, event);
      if (step.state !== stateRef.current) {
        stateRef.current = step.state;
        setState(step.state);
      }
      const behavior = step.scrollToEnd;
      if (behavior !== null) {
        setRequest((previous) => ({
          behavior: reducedMotion ? "auto" : behavior,
          tick: (previous?.tick ?? 0) + 1,
        }));
      }
    },
    [reducedMotion],
  );

  const pointerDownRef = useRef(false);
  const previousTopRef = useRef(0);
  const touchYRef = useRef<number | null>(null);

  useEffect(() => {
    const release = () => {
      pointerDownRef.current = false;
    };
    // Only a selection inside the transcript: text selected in the composer is not reading.
    const selectionChanged = () => {
      const selection = document.getSelection();
      const viewport = viewportRef.current;
      dispatch({
        type: "selection",
        active:
          selection !== null &&
          !selection.isCollapsed &&
          (viewport?.contains(selection.anchorNode) ?? false),
      });
    };
    // A scrollbar drag can end with the pointer anywhere on the page.
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    document.addEventListener("selectionchange", selectionChanged);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      document.removeEventListener("selectionchange", selectionChanged);
    };
  }, [dispatch, viewportRef]);

  const down = (element: HTMLElement) =>
    dispatch({
      type: "down",
      atEnd:
        element.scrollHeight - element.scrollTop - element.clientHeight <=
        END_PX,
    });

  const viewportHandlers: ViewportHandlers = {
    onWheel: (event) => {
      dispatch({ type: "wheel", deltaY: event.deltaY });
      if (event.deltaY > 0) down(event.currentTarget);
    },
    onKeyDown: (event) => {
      // A key typed into a field inside the transcript moves a caret, not the page.
      if (event.defaultPrevented || isEditable(event.target)) return;
      dispatch({ type: "key", key: event.key, shiftKey: event.shiftKey });
      if (DOWN_KEYS.has(event.key) || (event.key === " " && !event.shiftKey)) {
        down(event.currentTarget);
      }
    },
    onTouchStart: (event) => {
      touchYRef.current = event.touches[0]?.clientY ?? null;
    },
    onTouchMove: (event) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      const last = touchYRef.current;
      touchYRef.current = y;
      if (last === null) return;
      dispatch({ type: "touch", fingerDeltaY: y - last });
      // The finger moving up the screen scrolls the page down.
      if (y < last) down(event.currentTarget);
    },
    onPointerDown: (event) => {
      /*
       * A press on the viewport itself, not on anything in it: its scrollbar, or the bare margin
       * beside the conversation. Not a gutter check: an overlay scrollbar (macOS with a trackpad)
       * takes no width and a right-to-left one sits on the left, so a thumb is pressed inside the
       * content box. A press on a message is never a drag, so a layout clamp under a finger
       * resting on one is still not the person's.
       */
      pointerDownRef.current = event.target === event.currentTarget;
    },
    onScroll: (event) => {
      const element = event.currentTarget;
      const top = element.scrollTop;
      const previousTop = previousTopRef.current;
      previousTopRef.current = top;
      dispatch({
        type: "scroll",
        top,
        previousTop,
        fromEnd: element.scrollHeight - top - element.clientHeight,
        pointerDown: pointerDownRef.current,
      });
    },
  };

  return { following: state.following, dispatch, request, viewportHandlers };
}

/**
 * Carries out a resume's scroll to the end. Renders nothing; it lives inside the scroller to reach
 * it, and runs in the commit after the resume, when the scroller has already been told to follow, so
 * the scroll leaves it following rather than free.
 */
export function FollowScroll({ request }: { request: FollowRequest | null }) {
  const { scrollToEnd } = useMessageScroller();
  useLayoutEffect(() => {
    if (request !== null) scrollToEnd({ behavior: request.behavior });
  }, [request, scrollToEnd]);
  return null;
}
