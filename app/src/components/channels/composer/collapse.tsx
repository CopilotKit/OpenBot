import { motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";

/**
 * A box that opens and closes by growing and shrinking, used for the two things above the compact
 * composer's text: the attachment strip and the list of refusals.
 *
 * WHY THIS EXISTS AT ALL. Both of those change the composer's height by far more than a line, and
 * both did it on a single frame — paste a screenshot and the box jumped 86px, taking whatever
 * somebody was mid-sentence in with it. Growing into the space instead is what makes a picture read
 * as having been added to the message rather than as the message having been replaced.
 *
 * WHY IT IS NOT `AnimatePresence`, WHICH IS THE OBVIOUS SPELLING. It was written that way first and
 * cost eight tests. An exiting element stays MOUNTED until its animation reports finished, and
 * under happy-dom that report never comes: every assertion that a removed attachment is gone hung
 * until it timed out. `MotionGlobalConfig.skipAnimations` is motion's own documented hook for
 * exactly this and did not fix it either — it moved the wait from never to about four seconds,
 * against a suite that runs in three. A flourish that makes the behaviour underneath it
 * unverifiable is not worth having.
 *
 * WHY IT MEASURES INSTEAD OF ANIMATING TO `auto`. That was the second attempt, and it looked right
 * in one direction only. Motion resolves `auto` by measuring at the moment the animation starts, so
 * closing — where the content has already left the DOM — measured the EMPTY box and animated 0 to
 * 0. The height snapped 141px to 66px in four milliseconds and then eased the last eleven, which is
 * a jump wearing an animation's clothes. Measuring the content ourselves gives the close a real
 * number to leave from.
 *
 * WHAT A CALLER OWES THIS BOX. Closed here means height 0 under `overflow-hidden`, and that is a
 * VISUAL state only — it is not `display: none`, so everything inside a closed box is still in the
 * accessibility tree, still labelled, still reachable by a screen reader's own navigation. So
 * whatever goes in here has to deal with its own absence: `RejectedFiles` unmounts its alert on
 * the way closed, `AttachmentStrip` keeps its list mounted to be measured and `aria-hidden`s it
 * while it is empty. Both are recorded where they are done.
 *
 * That is deliberately not enforced from in here. This box cannot know whether a caller has left
 * something focusable inside it, and `aria-hidden` over a focusable element is its own defect —
 * worse than the one it would be papering over. The caller knows; this does not.
 */
export function Collapse({
  children,
  className,
  open,
}: {
  children: React.ReactNode;
  /** Classes for the content, not the animating box — that one owns its own overflow. */
  className?: string;
  open: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();
  const content = useRef<HTMLDivElement>(null);
  const [openHeight, setOpenHeight] = useState(0);

  /**
   * The last height the content had while it was OPEN, and the guard is the whole point.
   *
   * A caller may unmount its content on the way closed — `RejectedFiles` does, because a
   * `role="alert"` left in the tree is still an alert to a screen reader. The observer fires for
   * that too, and taking the measurement would overwrite the height we are about to animate FROM
   * with the zero we are animating TO. Read through a ref rather than the closure so this sees the
   * commit that closed it rather than the render that installed the observer.
   */
  const isOpen = useRef(open);

  /**
   * WHY THE ASSIGNMENT IS HERE AND NOT IN THE BODY OF THE RENDER, WHERE IT USED TO BE.
   *
   * `isOpen.current = open` written during render records what React was CONSIDERING, and React is
   * free to render a component and then throw the work away — that is what every interrupted or
   * suspended transition does. A guard fed by a render that never committed answers about a box
   * that never changed: it turns away the observer while the content is still open and visibly
   * resizing, and the box goes on animating to a height its content no longer has.
   *
   * A layout effect only runs on a COMMIT, which is the state the DOM is actually in, and it runs
   * synchronously before the browser lays out — so it is in place before any `ResizeObserver`
   * callback for that same commit can be delivered. That ordering is the reason this is not a
   * plain `useEffect`: passive effects can be flushed after paint, and the observer would get
   * there first.
   */
  useLayoutEffect(() => {
    isOpen.current = open;

    /**
     * AND THE FIRST OPEN IS MEASURED HERE, NOT LEFT TO THE OBSERVER.
     *
     * `openHeight` starts at 0 and the observer is the only other thing that moves it, but the
     * observer's first callback arrives while the box is still closed — where the guard above
     * correctly refuses it. So the first time `open` went true there was still no height to go to,
     * and `animate` ran 0 to 0. The real number turned up on the frame after, once the observer
     * had fired again and its `setState` had landed, and what that reads as is not an animation:
     * the composer sits still for a frame and then jumps. On the first attachment of every
     * session, which is the one moment this component exists to smooth.
     *
     * Measuring on the commit that opens gives that first animation a real destination. It is
     * every open rather than only the first because what goes in this box is a different size each
     * time, and a mount-only measurement would send the second attachment to the height of the
     * first.
     */
    const element = content.current;
    if (open && element) setOpenHeight(element.offsetHeight);
  }, [open]);

  /**
   * And afterwards: the content is not a fixed size once it is open. A thumbnail finishes loading,
   * a filename wraps to a second line, the window narrows — each of those changes the height the
   * box should be holding without changing `open`, and only the observer sees them.
   *
   * It is not asked for an opening measurement here. The layout effect above has already taken one
   * for this same commit, and it ran first; a browser delivers an initial callback on `observe()`
   * in any case.
   */
  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      if (isOpen.current) setOpenHeight(element.offsetHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      animate={{ height: open ? openHeight : 0 }}
      /* What makes a height change read as a reveal rather than as a squash. */
      className="overflow-hidden"
      /* Nothing unfurls on mount: a composer opens with neither of these against it. */
      initial={false}
      transition={{
        // Reduced motion drops the movement, the same bargain `Arriving` and `StaggerItem` strike.
        duration: shouldReduceMotion ? 0 : ENTRANCE_SECONDS,
        ease: EASE_OUT,
      }}
    >
      <div className={className} ref={content}>
        {children}
      </div>
    </motion.div>
  );
}
