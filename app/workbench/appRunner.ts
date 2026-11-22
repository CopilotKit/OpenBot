// The run of an app scene: each step at its time on the page clock. The same contract as the
// desktop frame's startRun (desktop/workbench/runner.ts), with the app's extra step kinds: API
// answers, AG-UI stream events, socket messages and a route change.

import type { NativeControl } from "../../desktop/src/fakeNative/control";
import type {
  ApiControl,
  AppRunStep,
  SocketControl,
  StreamControl,
} from "../../desktop/workbench/appContract";
import type { PageClock } from "../../desktop/workbench/clock";
import {
  performDomStep,
  type RunAction,
} from "../../desktop/workbench/domSteps";

export type AppRunDeps = {
  control: NativeControl;
  api: ApiControl;
  streams: StreamControl;
  sockets: SocketControl;
  root: Document;
  navigate(path: string): void;
};

export type AppRunOptions = {
  /** Called just before a click or a type step acts, with what it acts on. */
  onAction?(action: RunAction): void;
};

function perform(
  step: AppRunStep,
  deps: AppRunDeps,
  options: AppRunOptions,
): void {
  if ("click" in step)
    performDomStep(step, deps.root, (target) =>
      options.onAction?.({
        kind: "click",
        name: step.click,
        at: step.at * 1000,
        target,
      }),
    );
  else if ("type" in step)
    performDomStep(step, deps.root, (target) =>
      options.onAction?.({
        kind: "type",
        name: step.into,
        text: step.type,
        at: step.at * 1000,
        target,
      }),
    );
  else if ("answer" in step) deps.control.setAnswer(step.answer, step.with);
  else if ("settle" in step)
    deps.control.setAnswer(step.settle, { mode: "value", value: step.value });
  else if ("fail" in step)
    deps.control.setAnswer(step.fail, { mode: "fail", problem: step.problem });
  else if ("api" in step) {
    if (step.with === null) deps.api.clearAnswer(step.api);
    else deps.api.setAnswer(step.api, step.with);
  } else if ("stream" in step) deps.streams.push(step.stream, step.events);
  else if ("streamEnd" in step) deps.streams.end(step.streamEnd);
  else if ("socket" in step) {
    if (deps.sockets.send(step.socket, step.send) === 0)
      console.warn(
        `Run step: no open socket has "${step.socket}" in its address.`,
      );
  } else deps.navigate(step.navigate);
}

export function startAppRun(
  steps: readonly AppRunStep[],
  clock: PageClock,
  deps: AppRunDeps,
  options: AppRunOptions = {},
): { end: number; nextAt(ms: number): number | null } {
  for (const step of steps)
    clock.schedule(step.at * 1000, () => perform(step, deps, options));
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

/** Goes to `path` in the app the way its router sees a link: a new history entry, then popstate. */
export function navigateIn(win: Window, path: string): void {
  win.history.pushState(null, "", path);
  const PopState = (win as Window & typeof globalThis).PopStateEvent;
  win.dispatchEvent(new PopState("popstate", { state: null }));
}
