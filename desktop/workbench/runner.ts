import { nativeControl } from "../src/fakeNative/control";
import type { PageClock } from "./clock";
import { performDomStep, type RunAction } from "./domSteps";
import type { RunStep } from "./scenes/types";

export { findTarget, type RunAction, runActions } from "./domSteps";

export type RunOptions = {
  /** Called just before a click or a type step acts, with what it acts on. */
  onAction?(action: RunAction): void;
};

/** The words for an action: "Click · Install", "Type · Code from your browser". */
export function actionLabel(action: Pick<RunAction, "kind" | "name">): string {
  return `${action.kind === "click" ? "Click" : "Type"} · ${action.name}`;
}

/**
 * Where a play with "Pause at each action" goes next. It goes to `wanted`, but it stops 1 ms
 * before the first action it would pass. At 1 ms before an action (where it stopped), it goes on
 * through that action. `stopAt` is the time of the action it stops before, or null.
 */
export function playTo(
  now: number,
  wanted: number,
  actionTimes: readonly number[],
): { to: number; stopAt: number | null } {
  let next: number | null = null;
  for (const t of actionTimes)
    if (t - 1 > now && (next === null || t < next)) next = t;
  if (next !== null && next - 1 <= wanted)
    return { to: next - 1, stopAt: next };
  return { to: wanted, stopAt: null };
}

function perform(
  step: RunStep,
  root: Document | undefined,
  options: RunOptions,
): void {
  const control = nativeControl();
  if ("emit" in step) control.emit(step.emit, step.payload);
  else if ("answer" in step) control.setAnswer(step.answer, step.with);
  else if ("settle" in step)
    control.setAnswer(step.settle, { mode: "value", value: step.value });
  else if ("fail" in step)
    control.setAnswer(step.fail, { mode: "fail", problem: step.problem });
  else if ("type" in step)
    performDomStep(step, root ?? document, (target) =>
      options.onAction?.({
        kind: "type",
        name: step.into,
        text: step.type,
        at: step.at * 1000,
        target,
      }),
    );
  else
    performDomStep(step, root ?? document, (target) =>
      options.onAction?.({
        kind: "click",
        name: step.click,
        at: step.at * 1000,
        target,
      }),
    );
}

export function startRun(
  steps: readonly RunStep[],
  clock: PageClock,
  root?: Document,
  options: RunOptions = {},
): { end: number; nextAt(ms: number): number | null } {
  for (const step of steps)
    clock.schedule(step.at * 1000, () => perform(step, root, options));
  const times = steps.map((step) => step.at * 1000);
  return {
    end: times.length === 0 ? 0 : Math.max(...times),
    nextAt(ms) {
      let best: number | null = null;
      for (const t of times)
        if (t > ms && (best === null || t < best)) best = t;
      return best;
    },
  };
}
