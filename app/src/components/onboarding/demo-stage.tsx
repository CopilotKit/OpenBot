import { useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { IllustrationFrame } from "./illustration-frame";

/** How long one beat of a demo holds before the next. */
export const DEMO_BEAT_MS = 2400;

/** What a demo draws each beat with. */
export type DemoBeat = {
  /** Which beat, from 0 to `beats - 1`. Reduced motion holds `rest`. */
  beat: number;
  /** Moving now: on screen, in a shown tab, and motion allowed. Anything animated stops without it. */
  playing: boolean;
  /** The reader asked for less motion. */
  reduced: boolean;
};

/**
 * Whether an element is on screen in a shown tab, kept current.
 *
 * On screen until an IntersectionObserver says otherwise, and always where there is none to ask,
 * so a browser without one still plays rather than freezing on its first beat.
 */
function useOnScreen() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const element = ref.current;
    let intersecting = true;
    const update = () => setVisible(intersecting && !document.hidden);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            intersecting = entry?.isIntersecting ?? false;
            update();
          });
    if (element) observer?.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return [ref, visible] as const;
}

/**
 * The picture a step shows, and the clock it plays on.
 *
 * A PICTURE, AND SAID TO BE ONE. Everything inside sits in {@link IllustrationFrame}: nothing in it
 * can be clicked, typed in or tabbed to, and a screen reader hears `label` once in its place. The
 * buttons drawn on the approval card are a drawing of the decision, not the decision.
 *
 * ONE CLOCK PER DEMO, AND ONLY WHILE SOMEBODY CAN SEE IT. The beat advances every `beatMs` while
 * the demo is on screen in a shown tab. Scrolled away, in a background tab, or with the reader's
 * reduced-motion setting on, it stops, and `playing` tells the orbs and loops inside to stop too.
 * With reduced motion it holds `rest`, the beat that says the most as a still.
 */
export function DemoStage({
  kind,
  label,
  beats = 1,
  rest = beats - 1,
  beatMs = DEMO_BEAT_MS,
  className = "",
  children,
}: {
  /** Which demo, for tests and styles. */
  kind: string;
  /** What the picture shows, read in place of everything drawn inside it. */
  label: string;
  beats?: number;
  rest?: number;
  beatMs?: number;
  className?: string;
  children: (now: DemoBeat) => ReactNode;
}) {
  const reduced = useReducedMotion() === true;
  const [ref, visible] = useOnScreen();
  const [beat, setBeat] = useState(0);
  const playing = !reduced && visible;
  useEffect(() => {
    if (!playing || beats < 2) return;
    const timer = setInterval(
      () => setBeat((value) => (value + 1) % beats),
      beatMs,
    );
    return () => clearInterval(timer);
  }, [playing, beats, beatMs]);
  const shown = reduced ? rest : beat;

  return (
    <div
      className="flex w-full min-w-0 justify-center"
      data-demo={kind}
      data-demo-beat={shown}
      data-playing={playing ? "" : undefined}
      ref={ref}
    >
      <IllustrationFrame className={className} label={label}>
        {children({ beat: shown, playing, reduced })}
      </IllustrationFrame>
    </div>
  );
}
