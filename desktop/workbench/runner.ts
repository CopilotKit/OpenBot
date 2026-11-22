import { nativeControl } from "../src/fakeNative/control";
import type { PageClock } from "./clock";
import type { RunStep } from "./scenes/types";

function findButton(root: Document, name: string): HTMLElement | null {
  const buttons = root.querySelectorAll<HTMLElement>("button, [role=button]");
  for (const button of buttons) {
    const label = button.getAttribute("aria-label");
    const text = (button.textContent ?? "").replace(/\s+/g, " ").trim();
    if (label === name || text === name) return button;
  }
  return null;
}

function perform(step: RunStep, root: Document | undefined): void {
  const control = nativeControl();
  if ("emit" in step) control.emit(step.emit, step.payload);
  else if ("answer" in step) control.setAnswer(step.answer, step.with);
  else if ("settle" in step)
    control.setAnswer(step.settle, { mode: "value", value: step.value });
  else if ("fail" in step)
    control.setAnswer(step.fail, { mode: "fail", problem: step.problem });
  else {
    const button = findButton(root ?? document, step.click);
    if (button) button.click();
    else console.warn(`Run step: no button named "${step.click}" on the page.`);
  }
}

export function startRun(
  steps: readonly RunStep[],
  clock: PageClock,
  root?: Document,
): { end: number; nextAt(ms: number): number | null } {
  for (const step of steps)
    clock.schedule(step.at * 1000, () => perform(step, root));
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
