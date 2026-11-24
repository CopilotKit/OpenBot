/**
 * THE APP'S OWN PROBLEMS, KEPT FOR THE TROUBLESHOOTING LOGS.
 *
 * A reply that broke, a request that failed, an error the page threw: none of it was written
 * anywhere a person could send in. So each one is recorded as it happens. The page keeps the latest
 * ones from the last half hour in memory, in a browser and inside OpenBot Desktop alike, and Get
 * troubleshooting logs writes them out (`lib/troubleshooting/logs.ts`).
 *
 * INSIDE OPENBOT DESKTOP each one is also handed to the desktop app, through its page plugin's
 * `record_problem` command, which stamps the time, bounds and scrubs every field, keeps the last ones
 * and writes each to its log. Connected to an OpenBot elsewhere, the page is shown through the
 * desktop app's relay, and this is how the desktop app's own troubleshooting file lists them. The
 * page records whether the desktop app runs OpenBot here or is connected; the desktop app decides.
 *
 * ONLY WHAT THE COMMAND TAKES. A request is its method, its path without the query, how it ended and
 * the request id the server gave it. An error is its name and message. Never a body, a query string,
 * a cookie, a token or an address somebody typed.
 *
 * BOUNDED. At most sixty a minute are recorded; the rest are dropped. The last hundred are kept, and
 * none older than half an hour.
 *
 * NEVER WAITED ON, NEVER RETRIED. A desktop app older than the command refuses it every time, so a
 * refusal is dropped and the next problem is sent as if it had not happened.
 *
 * No imports that reach `lib/client.ts`, so the transport can record here without a cycle.
 */

import { RELEASE } from "@openbot/shared/client-version";
import { appVersion } from "@/lib/error-details";
import { invokeDesktop } from "./queries";
import { desktopShell } from "./shell";

/**
 * The web app's own release: the build's label when it has one, and otherwise the release it was
 * built from, the one every request names in `OpenBot-Client`. Found on a test OpenBot: the image's
 * web app had no build label, and both troubleshooting files said its version wasn't known.
 */
export function frontEndRelease(): string {
  return appVersion() ?? RELEASE;
}

/** One problem, in the shape the desktop app's `record_problem` takes. */
export type ReportedProblem = {
  kind: "request" | "page-error" | "unhandled-rejection" | "run";
  /** kind "request": "GET", "POST", ... */
  method?: string;
  /** kind "request": the pathname only, never the query string or fragment. */
  path?: string;
  /**
   * kind "request". failed: answered with a status of 400 or more. no-answer: the network failed.
   * slow: no answer yet after {@link SLOW_AFTER_MS}.
   */
  outcome?: "failed" | "no-answer" | "slow";
  /** kind "request": the status it was answered with. */
  status?: number;
  /** The server's id for the request: its X-Request-Id header, or a problem body's `requestId`. */
  requestId?: string;
  /** kind "request": how long it had waited when recorded (no-answer and slow). */
  waitedMs?: number;
  /** "TypeError: x is not a function", or the sentence a failed run showed. */
  message?: string;
  /** kind "page-error": "file:line:column" of where it was thrown, when known. */
  source?: string;
  /** The page's own release. */
  appVersion?: string;
};

/** A request with no answer yet after this long is recorded as slow, once. */
export const SLOW_AFTER_MS = 30_000;
const MAX_PER_MINUTE = 60;
const MAX_MESSAGE = 500;
const MAX_SOURCE = 300;

/** The timers and the clock this module uses. A test replaces them so it can wait 30 s at once. */
export type ProblemClock = {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

const realClock: ProblemClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
let clock = realClock;
let sentAt: number[] = [];

/** How many of the latest problems the page keeps, and for how long. */
export const KEPT = 100;
export const KEPT_FOR_MS = 30 * 60_000;

/** A problem the page kept, and when (milliseconds since the epoch, the page's clock). */
export type KeptProblem = { at: number; problem: ReportedProblem };
let kept: KeptProblem[] = [];

/**
 * For a test: use these timers, or the real ones again when given nothing, and forget the rate and
 * what was kept.
 */
export function setProblemClock(replacement?: ProblemClock): void {
  clock = replacement ?? realClock;
  sentAt = [];
  kept = [];
}

/** The problems kept from the last half hour, oldest first. */
export function recentProblems(): KeptProblem[] {
  const now = clock.now();
  kept = kept.filter(({ at }) => now - at < KEPT_FOR_MS);
  return [...kept];
}

/** The page's clock, for what is written beside the problems. */
export function problemClockNow(): number {
  return clock.now();
}

/** At most `max` characters, counted as the desktop app counts them (code points, not halves of one). */
export function bounded(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/**
 * Keep one problem, and inside OpenBot Desktop hand it to the desktop app too. Never throws, never
 * waits, never retries.
 */
export function recordProblem(problem: ReportedProblem): void {
  const now = clock.now();
  sentAt = sentAt.filter((at) => now - at < 60_000);
  if (sentAt.length >= MAX_PER_MINUTE) return;
  sentAt.push(now);
  const version = frontEndRelease();
  const sent: ReportedProblem = {
    ...problem,
    ...(problem.message === undefined
      ? {}
      : { message: bounded(problem.message, MAX_MESSAGE) }),
    ...(problem.source === undefined
      ? {}
      : { source: bounded(problem.source, MAX_SOURCE) }),
    ...(version ? { appVersion: version } : {}),
  };
  kept = kept.filter(({ at }) => now - at < KEPT_FOR_MS);
  if (kept.length >= KEPT) kept.shift();
  kept.push({ at: now, problem: sent });
  if (desktopShell() === null) return;
  invokeDesktop("record_problem", { problem: sent }).catch(() => {
    // An older desktop app has no such command. Its log is not this page's to fix, and is not retried.
  });
}

/** The path a request was sent to, without its query or fragment, whatever form it was given in. */
export function pathOnly(path: string): string {
  try {
    return new URL(path, "http://openbot.invalid").pathname;
  } catch {
    return path.split(/[?#]/, 1)[0] ?? "";
  }
}

/** The request id a problem body (RFC 9457, as OpenBot's API answers) carries, when it has one. */
export function problemRequestId(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const id = (body as { requestId?: unknown }).requestId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/** What `lib/client.ts` tells the watch of one request as it ends. */
export type RequestWatch = {
  /** It was answered. Call before anything reads the body: a problem body is read from a copy. */
  answered: (response: Response) => void;
  /** `fetch` rejected. Only the network failing (a TypeError) is recorded; the page giving up is not. */
  rejected: (error: unknown) => void;
};

/** Watch one request the app makes, from just before it is sent. */
export function watchRequest(
  path: string,
  method: string | undefined,
): RequestWatch {
  const request = {
    kind: "request" as const,
    method: (method ?? "GET").toUpperCase(),
    path: pathOnly(path),
  };
  const started = clock.now();
  let settled = false;
  const slow = clock.setTimeout(() => {
    if (settled) return;
    recordProblem({
      ...request,
      outcome: "slow",
      waitedMs: Math.round(clock.now() - started),
    });
  }, SLOW_AFTER_MS);
  const settle = () => {
    settled = true;
    clock.clearTimeout(slow);
  };
  return {
    answered(response) {
      settle();
      if (response.status < 400) return;
      const failed = {
        ...request,
        outcome: "failed" as const,
        status: response.status,
      };
      const header = response.headers.get("x-request-id")?.trim();
      if (header) return recordProblem({ ...failed, requestId: header });
      if (!(response.headers.get("content-type") ?? "").includes("json"))
        return recordProblem(failed);
      // The caller reads the body; the id is read from a copy, taken before it does.
      response
        .clone()
        .json()
        .then(
          (body: unknown) => {
            const requestId = problemRequestId(body);
            recordProblem(requestId ? { ...failed, requestId } : failed);
          },
          () => recordProblem(failed),
        );
    },
    rejected(error) {
      settle();
      if (!(error instanceof TypeError)) return;
      recordProblem({
        ...request,
        outcome: "no-answer",
        waitedMs: Math.round(clock.now() - started),
      });
    },
  };
}
