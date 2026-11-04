import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";

export type IntroScene = { id: string; label: string; content: ReactNode };

/** A looping introduction instead of more wizard steps. */
export function IntroAnimation({ scenes }: { scenes: IntroScene[] }) {
  const reducedMotion = useReducedMotion();
  const [scene, setScene] = useState(0);
  useEffect(() => {
    if (reducedMotion || scenes.length < 2) return;
    const timer = window.setInterval(
      () => setScene((current) => (current + 1) % scenes.length),
      4000,
    );
    return () => window.clearInterval(timer);
  }, [reducedMotion, scenes.length]);

  // Keep every scene available without auto-updating content when motion is reduced.
  if (reducedMotion) {
    return (
      <section
        aria-label="Meet OpenBot"
        className="flex w-full flex-col gap-12 py-8"
      >
        {scenes.map((item) => (
          <div key={item.id}>{item.content}</div>
        ))}
      </section>
    );
  }

  return (
    <section aria-label="Meet OpenBot" className="w-full">
      <div className="grid min-h-[440px] items-center">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={scenes[scene]?.id}
            initial={{ opacity: 0, y: reducedMotion ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reducedMotion ? 0 : -12 }}
            transition={{ duration: reducedMotion ? 0 : 0.35 }}
            className="col-start-1 row-start-1 w-full"
          >
            {scenes[scene]?.content}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}
