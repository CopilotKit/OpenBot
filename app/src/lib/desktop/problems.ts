/**
 * THE APP'S OWN PROBLEMS, HANDED TO OPENBOT DESKTOP FOR ITS LOG.
 *
 * Inside OpenBot Desktop connected to an OpenBot somewhere else, the page is shown through the
 * desktop app's relay, and nothing the page met was written anywhere the desktop app could read: a
 * reply that broke, a request that failed, an error the page threw. Get Troubleshooting Logs had
 * nothing of the app's own to list. So each one is handed to the desktop app as it happens, through
 * its page plugin's `record_problem` command, which stamps the time, bounds and scrubs every field,
 * keeps the last ones in memory and writes each to its log. The page records whether the desktop app
 * runs OpenBot on this computer or is connected to one elsewhere; the desktop app decides what to
 * keep.
 *
 * ONLY WHAT THE COMMAND TAKES. A request is its method, its path without the query, how it ended and
 * the request id the server gave it. An error is its name and message. Never a body, a query string,
 * a cookie, a token or an address somebody typed.
 *
 * NOTHING IN A BROWSER. Without the desktop app around the page (`desktopShell()` is null), every
 * function here returns at once: nothing is sent, no timer is started, no listener is added.
 *
 * NEVER WAITED ON, NEVER RETRIED. A desktop app older than the command refuses it every time, so a
 * refusal is dropped and the next problem is sent as if it had not happened. At most sixty a minute
 * are sent; the rest are dropped.
 *
 * No imports that reach `lib/client.ts`, so the transport can record here without a cycle.
 */

import { appVersion } from "@/lib/error-details";
import { invokeDesktop } from "./queries";
import { desktopShell } from "./shell";

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

/** For a test: use these timers, or the real ones again when given nothing, and forget the rate. */
export function setProblemClock(replacement?: ProblemClock): void {
  clock = replacement ?? realClock;
  sentAt = [];
}

/** At most `max` characters, counted as the desktop app counts them (code points, not halves of one). */
export function bounded(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/** Hand one problem to the desktop app. Never throws, never waits, never retries. */
export function recordProblem(problem: ReportedProblem): void {
  if (desktopShell() === null) return;
  const now = clock.now();
  sentAt = sentAt.filter((at) => now - at < 60_000);
  if (sentAt.length >= MAX_PER_MINUTE) return;
  sentAt.push(now);
  const version = appVersion();
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

/**
 * Watch one request the app makes, from just before it is sent. Null in a browser: nothing is
 * watched and no timer starts.
 */
export function watchRequest(
  path: string,
  method: string | undefined,
): RequestWatch | null {
  if (desktopShell() === null) return null;
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
