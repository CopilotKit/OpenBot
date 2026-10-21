import { motion, useReducedMotion } from "motion/react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { appConfig } from "@/lib/generated/application-config";

/**
 * A laptop whose lid swings open, then whose screen lights up with the product: the orb the Welcome
 * slide opens on, and the product's name from the brand config, so a white-label build shows its own.
 *
 * Drawn here rather than loaded: a local install should not fetch artwork from somebody else's
 * server to say its data stays home. There is no logo file to use instead, so the orb stands in.
 *
 * The lid starts tilted back on mount and the screen fades in after it, so it plays each time the
 * slide arrives. Somebody who asks for reduced motion gets the laptop already open.
 */
export function LaptopIllustration() {
  const reduceMotion = useReducedMotion();
  return (
    <div className="mx-auto w-64 perspective-distant">
      <motion.div
        animate={{ rotateX: 0 }}
        className="mx-auto h-32 w-[90%] rounded-t-lg bg-neutral-100 p-1 shadow-sm ring-1 shadow-black/10 ring-black/10 dark:bg-neutral-800 dark:shadow-white/5 dark:ring-white/10"
        initial={reduceMotion ? false : { rotateX: -60 }}
        style={{ transformOrigin: "center bottom" }}
        transition={{ delay: 0.35, duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="relative h-full w-full overflow-hidden rounded-t rounded-b-sm bg-white dark:bg-neutral-900">
          <div className="absolute inset-x-0 top-1 mx-auto h-2 w-7 rounded-full bg-black" />
          <motion.div
            animate={{ opacity: 1, filter: "blur(0px)" }}
            className="flex h-full flex-col items-center justify-center gap-2 pt-2"
            initial={reduceMotion ? false : { opacity: 0, filter: "blur(8px)" }}
            transition={{ delay: 1, duration: 0.6 }}
          >
            <AgentOrb size="44px" />
            <span className="text-xs font-semibold tracking-tight">
              {appConfig.brand.productName}
            </span>
          </motion.div>
        </div>
      </motion.div>
      <div className="relative h-3 w-full rounded-t-md rounded-b-3xl bg-linear-to-b from-neutral-100 to-neutral-300 shadow-[0px_1px_0px_0px_var(--color-neutral-200)_inset] dark:from-neutral-700 dark:to-neutral-900 dark:shadow-[0px_1px_0px_0px_var(--color-neutral-600)_inset]">
        <div className="absolute inset-x-0 top-0 mx-auto h-1.5 w-10 rounded-b-sm bg-neutral-400 shadow-[0px_-1px_0px_0px_var(--color-neutral-300)_inset] dark:bg-neutral-600 dark:shadow-[0px_-1px_0px_0px_var(--color-neutral-500)_inset]" />
      </div>
    </div>
  );
}
