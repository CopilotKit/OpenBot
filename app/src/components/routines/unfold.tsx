import { motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";

/**
 * A row or a Bot's group on the Routines page that opens out when it is added and folds away when
 * it goes, so the rows under it slide rather than jump. Its height animates, not its position, so
 * nothing has to measure the list. Put it inside an `AnimatePresence` with `initial={false}`: what
 * is there when the list first draws simply appears. With reduced motion it appears and goes at once.
 */
export function Unfold({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      // Clipped only while it moves: at rest a row's focus ring must not be cut off.
      animate={{
        opacity: 1,
        height: "auto",
        transitionEnd: { overflow: "visible" },
      }}
      className={className}
      exit={{ opacity: 0, height: 0, overflow: "hidden" }}
      initial={{ opacity: 0, height: 0, overflow: "hidden" }}
      transition={{ duration: reduced ? 0 : ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}
