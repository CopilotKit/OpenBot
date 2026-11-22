/*
 * The in-page `fetch` of the app frame. A same-origin request under `/api/` gets its answer from,
 * in order: the answers that are set (newest first), then each handler group (stream, extra, spec),
 * then a 404 with NO_ANSWER_DETAIL. Every other request goes to the real `fetch`.
 * Pattern: desktop/src/fakeNative/control.ts (answer modes, waiting list, onChange).
 */
import { getResponse, matchRequestUrl, type RequestHandler } from "msw";
import type {
  ApiAnswer,
  ApiChange,
  ApiControl,
  ApiRecord,
  ApiRoute,
  ApiSource,
} from "../../../desktop/workbench/appContract";

export const NO_ANSWER_DETAIL = "The workbench has no answer for this request.";

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
  /** The page clock's setTimeout, read at call time by the caller. */
  setTimer(run: () => void, ms: number): void;
  /** Page clock milliseconds. */
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
  /** Requests that wait on a "never" answer, by route. */
  const waiting = new Map<ApiRoute, (() => void)[]>();
  let nextId = 1;

  const notify = (change: ApiChange) => {
    for (const listener of [...listeners]) listener(change);
  };

  const wake = (route: ApiRoute) => {
    const list = waiting.get(route);
    if (!list) return;
    waiting.delete(route);
    for (const resume of list) resume();
  };

  const matchingAnswer = (
    request: Request,
  ): { route: ApiRoute; answer: ApiAnswer } | null => {
    const url = new URL(request.url);
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
          await new Promise<void>((done) => options.setTimer(done, answer.ms));
          return {
            kind: "response",
            response: jsonResponse(answer.status ?? 200, answer.body),
            source: "answer",
            route,
          };
        case "offline":
          return { kind: "offline", route };
        case "never":
          await new Promise<void>((done) => {
            const list = waiting.get(route) ?? [];
            list.push(done);
            waiting.set(route, list);
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
    const record: ApiRecord = {
      id: nextId++,
      method: request.method,
      path: url.pathname + url.search,
      at: options.now(),
      source: "none",
      route: null,
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
      wake(route);
    },
    clearAnswer(route) {
      answers.delete(route);
      notify({ kind: "answer", route });
      wake(route);
    },
    answers: () => new Map(answers),
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
