import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { OnboardingFrame } from "./onboarding-frame";

/**
 * One step: an id that outlives the list changing around it, its name in the step list, its words
 * and its picture, and what its buttons say and do. Ids are this app's own fixed words, which is
 * what lets them sit in a selector unescaped.
 *
 * TWO HALVES, BECAUSE A DESKTOP SHOWS THEM SIDE BY SIDE. `intro` is the step's heading (an `h1`),
 * its sentence and any control that belongs with them; `demo` is what it shows. From `lg` up the
 * intro sits under the step list on the left and the demo fills the right; below, the demo follows
 * the intro, or comes first where `demoFirst` says so (the name step, under its orb).
 *
 * The buttons are the frame's, so a step describes them rather than drawing them: the primary's
 * words where the step has its own action ("Turn on notifications"), what that action does given
 * the move to the next step, and, on an optional step, a second button such as "Not now" that
 * moves on and writes nothing. A step whose own form carries its button (`ownAction`) gets no
 * primary at all.
 */
export type OnboardingStep = {
  id: string;
  /** The step's name in the step list: short, a few words. */
  title: string;
  intro: () => ReactNode;
  demo?: () => ReactNode;
  /** Below `lg`, the demo above the intro rather than after it. */
  demoFirst?: boolean;
  /** The primary's words here. "Continue" when absent. */
  primaryLabel?: string;
  /** What the primary does, given the move to the next step. Moving on when absent. */
  onPrimary?: (next: () => void) => void;
  /** The primary reads as done, green with a check. */
  primaryDone?: boolean;
  /** The primary is waiting on something, such as the browser's permission prompt. */
  primaryPending?: boolean;
  primaryDisabled?: boolean;
  /** The step's own form has the button that moves on, so the frame draws none. */
  ownAction?: boolean;
  /** A way past it, beside the primary. Moves on when it has no action of its own. */
  secondary?: { label: string; onClick?: (next: () => void) => void };
  /**
   * An optional step keeps the second button's place even while it has none, so the primary stays
   * put for the whole step: Get notified drops Not now once the browser has answered.
   */
  optional?: boolean;
  /** A line about the step, above the buttons. */
  footnote?: ReactNode;
  /** Something the step has to say right above its buttons, such as why the button became Next. */
  notice?: ReactNode;
};

/**
 * A step crossfades with a short travel toward the way the journey is going: the chrome around it
 * stays still, so only the content moves, and never by more than 24 px.
 */
const variants = {
  initial: (direction: number) => ({ x: 24 * direction, opacity: 0 }),
  active: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: -24 * direction, opacity: 0 }),
};

/** A pane that crossfades as the step changes, keyed on the step so the old one can leave. */
function Pane({
  stepId,
  direction,
  children,
  attribute,
}: {
  stepId: string | undefined;
  direction: number;
  children: ReactNode;
  attribute: "data-step" | "data-step-demo";
}) {
  return (
    <AnimatePresence custom={direction} initial={false} mode="popLayout">
      <motion.div
        animate="active"
        className="w-full min-w-0"
        custom={direction}
        exit="exit"
        initial="initial"
        key={stepId}
        variants={variants}
        {...{ [attribute]: stepId }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * The steps, moved through one at a time inside {@link OnboardingFrame}.
 *
 * WHERE SOMEBODY IS, BY ID. The list grows after it first draws: the self-hosting step joins once
 * the server says this is somebody trying OpenBot alone, and that answer can arrive while they are
 * on step two. Held as an index, their place would slide; held as an id, the step they are on stays
 * the step they are on, and only the list around it changes.
 *
 * WHO HOLDS THE ID. The route does, through `stepId` and `onMove`, because the step lives in the
 * address (`?step=`) so that a reload, browser Back and a consent's return all land on the right
 * one. Without `onMove` the wizard keeps the id itself, from `initialStepId`.
 *
 * HOW FAR SOMEBODY HAS COME. Every step up to the furthest one they have been on can be picked
 * from the desktop's step list; the ones after it cannot, because nobody has seen them yet.
 *
 * FOCUS FOLLOWS THE STEP. A change of step replaces the heading, the picture and the buttons, so
 * the element that had focus either vanished or now means something else. Focus moves to the new
 * step's heading, which a screen reader then reads, and the first draw leaves focus alone. Motion
 * respects the reader's reduced-motion setting: the movement becomes a fade.
 */
export function OnboardingWizard({
  steps,
  stepId: heldStepId,
  onMove,
  initialStepId,
  notice,
}: {
  steps: OnboardingStep[];
  /** The step to show, when the caller holds it. */
  stepId?: string;
  /** Asked to move to another step, when the caller holds it. */
  onMove?: (to: string, way: "forward" | "back") => void;
  initialStepId?: string;
  /** Said above the buttons on every step, such as a save that failed. */
  notice?: ReactNode;
}) {
  const [own, setOwn] = useState(() => initialStepId ?? steps[0]?.id ?? "");
  const current = heldStepId ?? own;
  const container = useRef<HTMLDivElement>(null);

  // A step that left the list (the server's answer changed) falls back to the first, never to nothing.
  const found = steps.findIndex((step) => step.id === current);
  const index = found === -1 ? 0 : found;
  const step = steps[index];

  /*
   * The furthest step reached, by id, so a step joining the list (the self-hosting one, once the
   * server answers) does not shift it. Every step up to it can be picked from the list.
   */
  const visited = useRef(new Set<string>());
  if (step) visited.current.add(step.id);
  const reachedAt = steps.reduce(
    (furthest, candidate, at) =>
      visited.current.has(candidate.id) ? Math.max(furthest, at) : furthest,
    index,
  );

  // The way the journey is going, for the motion: toward a later step, or back to an earlier one.
  const shown = useRef(index);
  const way = useRef(1);
  if (index !== shown.current) {
    way.current = index > shown.current ? 1 : -1;
    shown.current = index;
  }
  const direction = way.current;

  const go = (to: number) => {
    const target = steps[to];
    if (!target || to === index) return;
    if (onMove) onMove(target.id, to > index ? "forward" : "back");
    else setOwn(target.id);
  };
  /*
   * On from the step this was handed to, not from whichever step is current when it runs: a step
   * that moves on after a beat (Get notified, once the browser said yes) must not skip a step if
   * the person pressed Back or Continue during that beat.
   */
  const showing = useRef(step?.id);
  showing.current = step?.id;
  const from = step?.id;
  const next = () => {
    if (showing.current !== from) return;
    go(index + 1);
  };

  /*
   * Keyed on the id, not the step object: the list is rebuilt on every render of the route, and a
   * fresh object would pull focus back to the heading each time anything on the page changed, such
   * as the checklist's answer arriving while somebody tabs through it. The first draw is skipped,
   * so arriving on a page leaves focus where the browser put it.
   */
  const stepId = step?.id;
  const arrivedOn = useRef(stepId);
  const moved = useRef(false);
  useEffect(() => {
    if (!stepId) return;
    if (!moved.current && stepId === arrivedOn.current) return;
    moved.current = true;
    // The new heading starts at the top, on the page and in the desktop's picture pane.
    window.scrollTo?.({ top: 0 });
    const frame = container.current;
    const demo = frame?.querySelector<HTMLElement>("[data-onboarding-demo]");
    if (demo) demo.scrollTop = 0;
    const heading = frame?.querySelector<HTMLElement>(
      `[data-step="${stepId}"] h1`,
    );
    if (!heading) return;
    // Focusable by script only, so it is not a stop when tabbing through the page.
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [stepId]);

  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="contents" ref={container}>
        <OnboardingFrame
          demo={
            step?.demo ? (
              <Pane
                attribute="data-step-demo"
                direction={direction}
                stepId={step.id}
              >
                {step.demo()}
              </Pane>
            ) : null
          }
          demoFirst={step?.demoFirst === true}
          footnote={step?.footnote}
          index={index}
          intro={
            <Pane attribute="data-step" direction={direction} stepId={step?.id}>
              {step?.intro()}
            </Pane>
          }
          notice={
            step?.notice || notice ? (
              <>
                {step?.notice}
                {notice}
              </>
            ) : undefined
          }
          onBack={() => go(index - 1)}
          onPick={(at) => {
            if (at <= reachedAt) go(at);
          }}
          primary={
            step?.ownAction
              ? null
              : {
                  label: step?.primaryLabel ?? "Continue",
                  disabled:
                    step?.primaryDisabled === true ||
                    step?.primaryPending === true,
                  done: step?.primaryDone === true,
                  pending: step?.primaryPending === true,
                  onClick: () => {
                    if (step?.onPrimary) return step.onPrimary(next);
                    next();
                  },
                }
          }
          reached={reachedAt}
          reserveSecondary={step?.optional === true}
          secondary={
            step?.secondary
              ? {
                  label: step.secondary.label,
                  onClick: () =>
                    step.secondary?.onClick
                      ? step.secondary.onClick(next)
                      : next(),
                }
              : undefined
          }
          titles={steps.map((candidate) => candidate.title)}
        />
      </div>
    </MotionConfig>
  );
}
