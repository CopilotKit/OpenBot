import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

const FALLBACK = "Ask anything";
const INTERVAL_MS = 3200;

/**
 * A composer placeholder that steps through `examples`, one every 3.2 seconds.
 *
 * It holds while `paused` (the composer has focus or text, so the person is already writing) and
 * under reduced motion, where text that changes on its own is the motion. No examples gives the
 * composer's usual "Ask anything".
 */
export function useRotatingPlaceholder(
  examples: string[],
  { paused }: { paused: boolean },
): string {
  const [index, setIndex] = useState(0);
  const reduceMotion = useReducedMotion();
  const count = examples.length;

  useEffect(() => {
    if (paused || reduceMotion || count < 2) return;
    const timer = setInterval(
      () => setIndex((current) => (current + 1) % count),
      INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [paused, reduceMotion, count]);

  if (count === 0) return FALLBACK;
  // The list can shrink between renders (a Bot is deleted); wrap rather than read past the end.
  return examples[index % count] ?? FALLBACK;
}
