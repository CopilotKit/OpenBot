import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export type IntroScene = { id: string; label: string; content: ReactNode };

/** One introduction, with optional playback controls instead of more wizard steps. */
export function IntroAnimation({ scenes }: { scenes: IntroScene[] }) {
  const reducedMotion = useReducedMotion();
  const [scene, setScene] = useState(0);
  const [paused, setPaused] = useState(false);
  const last = scene === scenes.length - 1;
  const playing = !reducedMotion && !paused && !last;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setScene(scene + 1), 6000);
    return () => window.clearTimeout(timer);
  }, [playing, scene]);

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
      <div className="mt-6 flex items-center justify-center gap-4">
        <fieldset className="flex gap-1" aria-label="Introduction scenes">
          {scenes.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-label={item.label}
              aria-current={index === scene ? "step" : undefined}
              className="group flex h-10 w-10 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                setScene(index);
                setPaused(true);
              }}
            >
              <span
                className={`h-1 w-8 rounded-full transition-colors ${index === scene ? "bg-foreground" : "bg-foreground/15 group-hover:bg-foreground/30"}`}
              />
            </button>
          ))}
        </fieldset>
        {!reducedMotion && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-20 text-muted-foreground"
            onClick={() => {
              if (last) {
                setScene(0);
                setPaused(false);
              } else setPaused((current) => !current);
            }}
          >
            {last ? "Replay" : paused ? "Play" : "Pause"}
          </Button>
        )}
      </div>
    </section>
  );
}
