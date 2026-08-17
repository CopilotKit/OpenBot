import { motion, useReducedMotion } from "motion/react";
import type * as React from "react";

import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";

/**
 * A row or card arriving as part of a list.
 *
 * WHY A LIST ANIMATES AT ALL. A configuration screen is a stack of unrelated decisions, and when
 * they all appear on the same frame there is nothing telling the eye where to start. A short
 * cascade down the list does that, and nothing else — it is not decoration, and it is not here to
 * be noticed.
 *
 * 40ms apart, which is the middle of the 30–80ms that reads as one movement rather than as items
 * queueing. Past that it stops being a cascade and starts being a wait.
 *
 * CAPPED, because the cost of a stagger is paid by whatever is last. Twelve items at 40ms is 480ms
 * before the final one starts; a list of forty would leave the bottom half sitting blank for two
 * seconds while somebody is already trying to read it. Past the cap everything arrives together.
 */
const STAGGER_SECONDS = 0.04;
const STAGGER_CAP = 12;

/**
 * ONLY ON MOUNT, AND THIS IS THE LOAD-BEARING PART. `initial`/`animate` run when the element
 * mounts, and these lists re-render constantly — a grant toggled, a query refetched, a filter
 * typed. If the entrance replayed on those, granting a plugin would make the whole page flicker.
 * React keeps the elements mounted across those renders, so it does not.
 *
 * The corollary is that anything which REMOUNTS a list must not use this: switching a tab, or
 * paging a table, would replay the cascade every time. Those lists are left alone deliberately.
 */
export function StaggerItem({
  children,
  className,
  index,
}: {
  children: React.ReactNode;
  className?: string;
  /** Position in the list. Delay is derived from it, so it must be the render index. */
  index: number;
}) {
  const shouldReduceMotion = useReducedMotion();
  const delay = Math.min(index, STAGGER_CAP) * STAGGER_SECONDS;

  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      className={className}
      /*
       * The full transform string rather than motion's `y` shorthand: the shorthand is not
       * hardware accelerated and drops frames exactly when the main thread is busy, which on these
       * screens is while the list it belongs to is still being fetched.
       */
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(6px)",
      }}
      transition={{
        delay: shouldReduceMotion ? 0 : delay,
        duration: ENTRANCE_SECONDS,
        ease: EASE_OUT,
      }}
    >
      {children}
    </motion.div>
  );
}
