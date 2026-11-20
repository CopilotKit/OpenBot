import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { DEMO_BEAT_MS } from "../demo-stage";
import { ComputerDemo } from "./computer-demo";
import { TeamDemo } from "./team-demo";
import { WelcomeDemo } from "./welcome-demo";

/** How long one scene holds: the welcome demo's three beats, so it plays through once. */
export const SCENE_MS = DEMO_BEAT_MS * 3;

type Scene = { id: string; caption: string; draw: () => ReactNode };

const ASK: Scene = {
  id: "welcome",
  caption:
    "Ask in plain words. A Bot does the work and tells you when it's done.",
  draw: () => <WelcomeDemo />,
};
/*
 * Said so it holds however OpenBot runs its computers: one shared by every Bot on Desktop, one per
 * person, or one per Bot. Each of those is apart from the person's own machine, and none is promised
 * to a single Bot.
 */
const COMPUTER: Scene = {
  id: "computer",
  caption: "Bots use a browser and files of their own, apart from yours.",
  draw: () => <ComputerDemo />,
};
const TEAM: Scene = {
  id: "team",
  caption: "Pick a Bot for the job, or make your own.",
  draw: () => <TeamDemo />,
};

/**
 * The welcome step's one animation: what OpenBot does, as three scenes that play in turn.
 *
 * A PICTURE, LIKE EVERY DEMO. Each scene is a `DemoStage`, which is inert and labelled, and the
 * caption under it says the same thing in words. The dots only say which scene is showing; there
 * is nothing here to press.
 *
 * `computer` false leaves the Bot computer scene out, for an OpenBot that has none yet, so the
 * picture never promises one. With reduced motion the reel holds its first scene, and it waits
 * while the tab is hidden.
 */
export function IntroReel({ computer = true }: { computer?: boolean }) {
  const scenes = computer ? [ASK, COMPUTER, TEAM] : [ASK, TEAM];
  const reduced = useReducedMotion() === true;
  const [at, setAt] = useState(0);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const count = scenes.length;
  useEffect(() => {
    if (reduced || hidden) return;
    const timer = setInterval(
      () => setAt((value) => (value + 1) % count),
      SCENE_MS,
    );
    return () => clearInterval(timer);
  }, [reduced, hidden, count]);
  const scene = scenes[at % count] ?? ASK;

  return (
    <div className="flex w-full flex-col items-center gap-5" data-intro-reel="">
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          animate={{ opacity: 1 }}
          className="flex w-full flex-col items-center gap-5"
          data-scene={scene.id}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          key={scene.id}
          transition={{ duration: reduced ? 0 : 0.4 }}
        >
          {scene.draw()}
          <p className="text-sm max-w-sm text-center text-pretty text-muted-foreground">
            {scene.caption}
          </p>
        </motion.div>
      </AnimatePresence>
      <div aria-hidden="true" className="flex gap-1.5">
        {scenes.map((candidate) => (
          <span
            className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${
              candidate.id === scene.id
                ? "w-5 bg-foreground"
                : "w-1.5 bg-foreground/20"
            }`}
            key={candidate.id}
          />
        ))}
      </div>
    </div>
  );
}
