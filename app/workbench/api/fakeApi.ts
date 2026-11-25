/*
 * The in-page `fetch` of the app frame. A same-origin request under `/api/` gets its answer from,
 * in order: the answers that are set (newest first), then each handler group (stream, extra, spec),
 * then a 404 with NO_ANSWER_DETAIL. Every other request goes to the real `fetch`.
 * Pattern: desktop/src/fakeNative/control.ts (answer modes, waiting list, onChange).
 */
import { getResponse, matchRequestUrl, type RequestHandler } from "msw";
import {
  type ApiAnswer,
  type ApiChange,
  type ApiControl,
  type ApiRecord,
  type ApiRoute,
  type ApiSource,
  NO_ANSWER_DETAIL,
} from "../../../desktop/workbench/appContract";

export { NO_ANSWER_DETAIL };

const FAILED_DETAIL = "The request failed.";

export type FakeApiOptions = {
  /** The frame's `location.origin`. */
  origin: string;
  /** For everything that is not `/api`. */
  realFetch: typeof fetch;
  groups: readonly {
    source: "stream" | "extra" | "spec";
    handlers: readonly RequestHandler[];
  }[];
  /** The frame's browser timer, read at call time by the caller. */
  setTimer(run: () => void, ms: number): void;
  /** Browser performance milliseconds. */
  now(): number;
};

type Outcome =
  | {
      kind: "response";
      response: Response;
      source: ApiSource;
      route: ApiRoute | null;
    }
  | { kind: "offline"; route: ApiRoute };

function splitRoute(route: ApiRoute): { method: string; path: string } {
  const space = route.indexOf(" ");
  return { method: route.slice(0, space), path: route.slice(space + 1) };
}

/** 204, 205 and 304 may not carry a body. */
function jsonResponse(status: number, body: unknown): Response {
  if (status === 204 || status === 205 || status === 304) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** What a real fetch rejects with when its signal aborts. */
function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The request was aborted.", "AbortError")
  );
}

/**
 * Waits until `register` calls its `done`, or rejects as a real fetch does when the request's
 * signal aborts (TanStack Query aborts on unmount and on a route change). `register` gives back
 * how to stop waiting.
 */
function waitOrAbort(
  signal: AbortSignal,
  register: (done: () => void) => () => void,
): Promise<void> {
  return new Promise<void>((done, fail) => {
    if (signal.aborted) {
      fail(abortError(signal));
      return;
    }
    let stop = () => {};
    const onAbort = () => {
      stop();
      fail(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stop = register(() => {
      signal.removeEventListener("abort", onAbort);
      done();
    });
  });
}

function toRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  origin: string,
): Request {
  if (input instanceof Request) return new Request(input, init);
  return new Request(new URL(String(input), origin), init);
}

export function installFakeApi(
  target: { fetch: typeof fetch },
  options: FakeApiOptions,
): ApiControl & { uninstall(): void } {
  const original = target.fetch;
  const answers = new Map<ApiRoute, ApiAnswer>();
  const records: ApiRecord[] = [];
  const listeners = new Set<(change: ApiChange) => void>();
  /**
   * Requests that wait on a "never" answer. Any change of the answers wakes all of them: a newer
   * answer on another route (`ALL /api/x` over `GET /api/x`) can match a request too, and each
   * one looks for its answer again.
   */
  const waiting = new Set<() => void>();
  let nextId = 1;

  const notify = (change: ApiChange) => {
    for (const listener of [...listeners]) listener(change);
  };

  const wake = () => {
    const list = [...waiting];
    waiting.clear();
    for (const resume of list) resume();
  };

  const matchingAnswer = (request: {
    method: string;
    url: string;
  }): { route: ApiRoute; answer: ApiAnswer } | null => {
    const url = new URL(request.url, options.origin);
    const entries = [...answers.entries()];
    for (let i = entries.length - 1; i >= 0; i--) {
      const [route, answer] = entries[i];
      const { method, path } = splitRoute(route);
      if (method !== "ALL" && method !== request.method) continue;
      if (matchRequestUrl(url, `*${path}`, options.origin).matches) {
        return { route, answer };
      }
    }
    return null;
  };

  const resolve = async (request: Request): Promise<Outcome> => {
    if (request.signal.aborted) throw abortError(request.signal);
    const found = matchingAnswer(request);
    if (found) {
      const { route, answer } = found;
      switch (answer.mode) {
        case "value":
          return {
            kind: "response",
            response: jsonResponse(answer.status ?? 200, answer.body),
            source: "answer",
            route,
          };
        case "fail":
          return {
            kind: "response",
            response: jsonResponse(
              answer.status,
              answer.body ?? { detail: FAILED_DETAIL },
            ),
            source: "answer",
            route,
          };
        case "delay":
          await waitOrAbort(request.signal, (done) => {
            // After an abort the pending timer only finds nothing to do.
            let live = true;
            options.setTimer(() => {
              if (live) done();
            }, answer.ms);
            return () => {
              live = false;
            };
          });
          return {
            kind: "response",
            response: jsonResponse(answer.status ?? 200, answer.body),
            source: "answer",
            route,
          };
        case "offline":
          return { kind: "offline", route };
        case "never":
          await waitOrAbort(request.signal, (done) => {
            waiting.add(done);
            return () => waiting.delete(done);
          });
          return resolve(request);
      }
    }
    for (const group of options.groups) {
      const response = await getResponse([...group.handlers], request.clone());
      if (response) {
        return {
          kind: "response",
          response,
          source: group.source,
          route: null,
        };
      }
    }
    return {
      kind: "response",
      response: jsonResponse(404, { detail: NO_ANSWER_DETAIL }),
      source: "none",
      route: null,
    };
  };

  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // Check the URL before building a Request: in a browser, new Request(input) takes the body of
    // a Request input, so the real fetch could no longer send it.
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      options.origin,
    );
    if (url.origin !== options.origin || !url.pathname.startsWith("/api/")) {
      return options.realFetch(input, init);
    }
    const request = toRequest(input, init, options.origin);
    // A request that waits on a set answer ("delay", "never") names that answer while it waits, so
    // that no reader takes it for one with no answer. Only a settled "none" is a missing answer.
    // The settled outcome sets both again (a "never" answer that is cleared falls through).
    const found = matchingAnswer(request);
    const record: ApiRecord = {
      id: nextId++,
      method: request.method,
      path: url.pathname + url.search,
      at: options.now(),
      source: found ? "answer" : "none",
      route: found?.route ?? null,
      status: null,
      state: "pending",
    };
    records.push(record);
    notify({ kind: "request", record: { ...record } });

    let outcome: Outcome;
    try {
      outcome = await resolve(request);
    } catch (error) {
      record.state = "failed";
      notify({ kind: "settled", record: { ...record } });
      throw error;
    }
    record.route = outcome.route;
    if (outcome.kind === "offline") {
      record.source = "answer";
      record.state = "failed";
      notify({ kind: "settled", record: { ...record } });
      throw new TypeError("Failed to fetch");
    }
    record.source = outcome.source;
    record.status = outcome.response.status;
    record.state = "answered";
    notify({ kind: "settled", record: { ...record } });
    return outcome.response;
  };

  target.fetch = fakeFetch as typeof fetch;

  return {
    setAnswer(route, answer) {
      answers.delete(route);
      answers.set(route, answer);
      notify({ kind: "answer", route });
      wake();
    },
    clearAnswer(route) {
      answers.delete(route);
      notify({ kind: "answer", route });
      wake();
    },
    answers: () => new Map(answers),
    answerFor: ({ method, path }) => matchingAnswer({ method, url: path }),
    requests: () => records.map((record) => ({ ...record })),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    uninstall() {
      target.fetch = original;
    },
  };
}
