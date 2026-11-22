/*
 * The fake native side's control object: what `@tauri-apps/api/core` and `@tauri-apps/api/event`
 * answer when the desktop window runs in a plain browser (the browser test and the workbench).
 * One per page, kept on `globalThis.__workbench`, so every copy of this module shares it.
 */
import { PAGE_COMMANDS } from "./pageRegistry";
import { COMMANDS } from "./registry";

/**
 * Structural, so that app's tsc can check this file without desktop/src/Problem.tsx and the
 * desktop's React code. Problem fits it.
 */
export type FailProblem = { said: string; [field: string]: unknown };

export type Answer =
  | { mode: "value"; value: unknown }
  | { mode: "never" }
  | { mode: "fail"; problem: FailProblem }
  | { mode: "delay"; ms: number; value: unknown }
  | {
      mode: "script";
      run: (args: Record<string, unknown> | undefined, call: number) => unknown;
    };

/** One call to a command. `at` is `performance.now()` at call time. */
export type Call = {
  command: string;
  args?: Record<string, unknown>;
  at: number;
  known: boolean;
  /** How the call ended; undefined while it is pending. */
  settled?: "resolved" | "rejected";
};

export type Change =
  | { kind: "call"; call: Call }
  | { kind: "emit"; event: string; payload: unknown }
  | { kind: "answer"; command: string }
  | { kind: "settled"; call: Call };

export type FallbackAnswer = (
  command: string,
  args: Record<string, unknown> | undefined,
) => unknown;

export interface NativeControl {
  setAnswer(command: string, answer: Answer): void;
  clearAnswer(command: string): void;
  answers(): ReadonlyMap<string, Answer>;
  setFallback(fallback: FallbackAnswer): void;
  emit(event: string, payload: unknown): void;
  listenerCount(event: string): number;
  calls(): readonly Call[];
  onChange(listener: (change: Change) => void): () => void;
  reset(): void;
}

type NativeEvent = { event: string; id: number; payload: unknown };
type Listener = (event: NativeEvent) => void;

/** The older global the browser test reads: listener sets, command names, opened addresses. */
type FakeGlobal = {
  listeners: Record<string, Set<Listener>>;
  download: unknown;
  calls?: string[];
  opened?: string[];
  emit?: (name: string, payload: unknown) => void;
  [key: string]: unknown;
};

type Waiting = {
  args: Record<string, unknown> | undefined;
  call: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type Workbench = NativeControl & {
  call(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: Listener): () => void;
};

declare global {
  var __workbench: Workbench | undefined;
  var __fake: FakeGlobal | undefined;
}

const KNOWN: readonly string[] = [...COMMANDS, ...PAGE_COMMANDS];

function create(): Workbench {
  globalThis.__fake ??= { listeners: {}, download: null };
  const fake = globalThis.__fake;
  fake.listeners ??= {};
  fake.calls ??= [];
  fake.opened ??= [];
  const listeners = fake.listeners;
  const names = fake.calls;
  const opened = fake.opened;

  const answerMap = new Map<string, Answer>();
  let fallback: FallbackAnswer | null = null;
  const callLog: Call[] = [];
  const counts = new Map<string, number>();
  const waiting = new Map<string, Waiting[]>();
  const subscribers = new Set<(change: Change) => void>();
  let nextId = 1;

  const notify = (change: Change) => {
    for (const subscriber of [...subscribers]) subscriber(change);
  };

  /** Runs `run` and adopts what it gives back; a throw becomes a rejection. */
  const attempt = (run: () => unknown): Promise<unknown> =>
    new Promise((resolve) => resolve(run()));

  const settle = (
    answer: Answer,
    entry: Omit<Waiting, "args" | "call">,
    args: Record<string, unknown> | undefined,
    call: number,
  ) => {
    switch (answer.mode) {
      case "value":
        entry.resolve(answer.value);
        return;
      case "fail":
        entry.reject(answer.problem);
        return;
      case "delay":
        globalThis.setTimeout(() => entry.resolve(answer.value), answer.ms);
        return;
      case "script":
        attempt(() => answer.run(args, call)).then(entry.resolve, entry.reject);
        return;
      case "never":
        return;
    }
  };

  const control: Workbench = {
    call(command, args) {
      const call: Call = {
        command,
        args,
        at: performance.now(),
        known: KNOWN.includes(command),
      };
      callLog.push(call);
      names.push(command);
      if (command === "plugin:opener|open_url" && args)
        opened.push(String(args.url));
      const n = (counts.get(command) ?? 0) + 1;
      counts.set(command, n);
      notify({ kind: "call", call });
      const pending = new Promise((resolve, reject) => {
        const answer = answerMap.get(command);
        if (answer === undefined) {
          if (fallback === null) {
            resolve(null);
            return;
          }
          const chosen = fallback;
          attempt(() => chosen(command, args)).then(resolve, reject);
          return;
        }
        if (answer.mode === "never") {
          const list = waiting.get(command) ?? [];
          list.push({ args, call: n, resolve, reject });
          waiting.set(command, list);
          return;
        }
        settle(answer, { resolve, reject }, args, n);
      });
      return pending.then(
        (value) => {
          call.settled = "resolved";
          notify({ kind: "settled", call });
          return value;
        },
        (reason) => {
          call.settled = "rejected";
          notify({ kind: "settled", call });
          throw reason;
        },
      );
    },
    listen(event, handler) {
      const wrapper: Listener = (e) => handler(e);
      listeners[event] ??= new Set();
      listeners[event].add(wrapper);
      return () => {
        listeners[event]?.delete(wrapper);
      };
    },
    setAnswer(command, answer) {
      answerMap.set(command, answer);
      notify({ kind: "answer", command });
      if (answer.mode === "never") return;
      const list = waiting.get(command);
      if (!list) return;
      waiting.delete(command);
      for (const entry of list) settle(answer, entry, entry.args, entry.call);
    },
    clearAnswer(command) {
      answerMap.delete(command);
      notify({ kind: "answer", command });
    },
    answers: () => answerMap,
    setFallback(next) {
      fallback = next;
    },
    emit(event, payload) {
      const id = nextId++;
      for (const listener of [...(listeners[event] ?? [])])
        listener({ event, id, payload });
      notify({ kind: "emit", event, payload });
    },
    listenerCount: (event) => listeners[event]?.size ?? 0,
    calls: () => callLog,
    onChange(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    reset() {
      answerMap.clear();
      fallback = null;
      callLog.length = 0;
      counts.clear();
      waiting.clear();
      for (const set of Object.values(listeners)) set.clear();
      subscribers.clear();
      names.length = 0;
      opened.length = 0;
    },
  };
  fake.emit = (name, payload) => control.emit(name, payload);
  return control;
}

/** The page's one control object. */
export function nativeControl(): NativeControl {
  globalThis.__workbench ??= create();
  return globalThis.__workbench;
}

export function callNative(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  nativeControl();
  return (globalThis.__workbench as Workbench).call(command, args);
}

export function listenNative(
  event: string,
  handler: (event: NativeEvent) => void,
): () => void {
  nativeControl();
  return (globalThis.__workbench as Workbench).listen(event, handler);
}
