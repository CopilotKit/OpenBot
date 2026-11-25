import { describe, expect, test } from "bun:test";
import { getResponse, HttpResponse, http } from "msw";
import type { ApiChange } from "../../../desktop/workbench/appContract";
import { getListBotsResponseMock } from "../../src/lib/api/generated/bots/bots.msw";
import { agentsForBots, BOTS_ROUTE, extraHandlers } from "./extraHandlers";
import { installFakeApi, NO_ANSWER_DETAIL } from "./fakeApi";

const ORIGIN = "http://localhost:3021";
const BOTS = "/api/v2/organizations/default/bots";

function setup() {
  const realCalls: string[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const changes: ApiChange[] = [];
  const target = {
    fetch: (async () => new Response("original")) as unknown as typeof fetch,
  };
  const original = target.fetch;
  const realFetch = (async (input: string | URL | Request) => {
    realCalls.push(input instanceof Request ? input.url : String(input));
    return new Response("real");
  }) as typeof fetch;
  const api = installFakeApi(target, {
    origin: ORIGIN,
    realFetch,
    groups: [
      {
        source: "spec",
        handlers: [
          http.get("*/api/v2/organizations/:organizationId/bots", () =>
            HttpResponse.json({ bots: [{ id: "spec-bot" }] }),
          ),
        ],
      },
    ],
    setTimer: (run, ms) => {
      timers.push({ run, ms });
    },
    now: () => 1500,
  });
  api.onChange((change) => changes.push(change));
  return { api, target, original, realCalls, timers, changes };
}

/** Lets pending promises run. */
const flush = () => new Promise((done) => setTimeout(done, 0));

describe("installFakeApi", () => {
  test("the generated Bots seed and runtime agents agree, and explicit answers win", async () => {
    const { api, target } = setup();
    const seed = getListBotsResponseMock();
    api.setAnswer(BOTS_ROUTE, { mode: "value", body: seed });
    const runtime = extraHandlers({ agents: () => agentsForBots(api, BOTS) });
    const ids = async () => {
      const bots = (await (await target.fetch(BOTS)).json()) as {
        bots: { id: string }[];
      };
      const info = await getResponse(
        runtime,
        new Request(`${ORIGIN}/api/copilotkit/info`),
      );
      const body = (await info?.json()) as { agents: Record<string, unknown> };
      expect(Object.keys(body.agents)).toEqual(bots.bots.map((bot) => bot.id));
    };
    await ids();
    api.setAnswer(BOTS_ROUTE, {
      mode: "value",
      body: { bots: [{ id: "configured-bot" }] },
    });
    await ids();
    api.setAnswer(BOTS_ROUTE, { mode: "value", body: { bots: [] } });
    await ids();
  });

  test("a value answer for a route pattern answers a matching path", async () => {
    const { api, target } = setup();
    api.setAnswer("GET /api/v2/organizations/:organizationId/bots", {
      mode: "value",
      body: { bots: [{ id: "answer-bot" }] },
    });
    const response = await target.fetch(BOTS);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bots: [{ id: "answer-bot" }] });
    const [record] = api.requests();
    expect(record).toMatchObject({
      id: 1,
      method: "GET",
      path: BOTS,
      at: 1500,
      source: "answer",
      route: "GET /api/v2/organizations/:organizationId/bots",
      status: 200,
      state: "answered",
    });
  });

  test("the newest matching answer wins", async () => {
    const { api, target } = setup();
    api.setAnswer("ALL /api/*", { mode: "offline" });
    api.setAnswer("GET /api/v2/organizations/:organizationId/bots", {
      mode: "value",
      body: { ok: true },
    });
    expect(await (await target.fetch(BOTS)).json()).toEqual({ ok: true });

    // Set again, the offline answer moves to the newest place and wins.
    api.setAnswer("ALL /api/*", { mode: "offline" });
    await expect(target.fetch(BOTS)).rejects.toBeInstanceOf(TypeError);
    expect([...api.answers().keys()]).toEqual([
      "GET /api/v2/organizations/:organizationId/bots",
      "ALL /api/*",
    ]);
  });

  test("a spec handler answers when no answer matches", async () => {
    const { api, target } = setup();
    api.setAnswer("POST /api/v2/organizations/:organizationId/bots", {
      mode: "value",
      body: { wrong: true },
    });
    const response = await target.fetch(`${ORIGIN}${BOTS}`);
    expect(await response.json()).toEqual({ bots: [{ id: "spec-bot" }] });
    expect(api.requests()[0]).toMatchObject({
      source: "spec",
      route: null,
      status: 200,
    });
  });

  test("a request with no answer gets a 404 with the workbench's sentence", async () => {
    const { api, target } = setup();
    const response = await target.fetch("/api/v2/unknown?x=1", {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: NO_ANSWER_DETAIL });
    expect(api.requests()[0]).toMatchObject({
      method: "DELETE",
      path: "/api/v2/unknown?x=1",
      source: "none",
      route: null,
      status: 404,
      state: "answered",
    });
  });

  test("a never answer waits, and a later value answer settles it", async () => {
    const { api, target } = setup();
    const route = "GET /api/v2/organizations/:organizationId/bots" as const;
    api.setAnswer(route, { mode: "never" });
    let settled = false;
    const pending = target.fetch(BOTS).then((response) => {
      settled = true;
      return response;
    });
    await flush();
    expect(settled).toBe(false);
    expect(api.requests()[0].state).toBe("pending");
    api.setAnswer(route, { mode: "value", status: 201, body: { late: true } });
    const response = await pending;
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ late: true });
  });

  test("answerFor names the answer a request gets, newest first, query and all", () => {
    const { api } = setup();
    expect(api.answerFor({ method: "GET", path: BOTS })).toBeNull();
    api.setAnswer("GET /api/v2/organizations/:organizationId/bots", {
      mode: "never",
    });
    api.setAnswer("ALL /api/*", { mode: "delay", ms: 5, body: null });
    expect(api.answerFor({ method: "GET", path: `${BOTS}?x=1` })).toEqual({
      route: "ALL /api/*",
      answer: { mode: "delay", ms: 5, body: null },
    });
    api.clearAnswer("ALL /api/*");
    expect(api.answerFor({ method: "GET", path: BOTS })?.answer.mode).toBe(
      "never",
    );
    expect(api.answerFor({ method: "POST", path: BOTS })).toBeNull();
  });

  test("a never request wakes for a newer matching answer on another route", async () => {
    const { api, target } = setup();
    api.setAnswer("GET /api/v2/organizations/:organizationId/bots", {
      mode: "never",
    });
    const pending = target.fetch(BOTS);
    await flush();
    // Another key that matches too: newest first, it wins, and the waiting request sees it.
    api.setAnswer("ALL /api/v2/organizations/:organizationId/bots", {
      mode: "value",
      body: { woke: true },
    });
    expect(await (await pending).json()).toEqual({ woke: true });
  });

  test("an aborted never or delay request rejects with AbortError and is recorded as failed", async () => {
    const { api, target, timers } = setup();
    api.setAnswer("GET /api/v2/organizations/:organizationId/bots", {
      mode: "never",
    });
    const never = new AbortController();
    const waiting = target.fetch(BOTS, { signal: never.signal });
    await flush();
    never.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(api.requests()[0].state).toBe("failed");

    api.setAnswer("GET /api/*", { mode: "delay", ms: 300, body: {} });
    const delay = new AbortController();
    const slow = target.fetch(BOTS, { signal: delay.signal });
    await flush();
    delay.abort();
    await expect(slow).rejects.toMatchObject({ name: "AbortError" });
    // The timer that runs later finds nothing to settle.
    timers[0]?.run();
    await flush();
    expect(api.requests().map((record) => record.state)).toEqual([
      "failed",
      "failed",
    ]);

    // Aborted before it was sent: rejected at once, as a real fetch does.
    const early = new AbortController();
    early.abort();
    await expect(
      target.fetch(BOTS, { signal: early.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("a delay answer waits for the timer", async () => {
    const { api, target, timers } = setup();
    api.setAnswer("GET /api/*", { mode: "delay", ms: 300, body: { slow: 1 } });
    let settled = false;
    const pending = target.fetch(BOTS).then((response) => {
      settled = true;
      return response;
    });
    await flush();
    expect(settled).toBe(false);
    expect(timers.map((timer) => timer.ms)).toEqual([300]);
    timers[0].run();
    expect(await (await pending).json()).toEqual({ slow: 1 });
  });

  test("a request that waits on an answer names it, not 'none'", async () => {
    const { api, target, timers, changes } = setup();
    const never = "GET /api/v2/organizations/:organizationId/bots" as const;
    const delay = "GET /api/v2/people/*" as const;
    api.setAnswer(never, { mode: "never" });
    api.setAnswer(delay, { mode: "delay", ms: 300, body: {} });
    const waiting = target.fetch(BOTS);
    const slow = target.fetch("/api/v2/people/me/organizations");
    await flush();
    for (const record of api.requests()) {
      expect(record.state).toBe("pending");
      expect(record.source).toBe("answer");
    }
    expect(api.requests().map((record) => record.route)).toEqual([
      never,
      delay,
    ]);
    const first = changes.find((change) => change.kind === "request");
    expect(first?.kind === "request" && first.record.source).toBe("answer");
    // A cleared "never" answer falls through to the handlers, and the settled record says so.
    api.clearAnswer(never);
    await waiting;
    timers[0].run();
    await slow;
    expect(api.requests().map((record) => record.source)).toEqual([
      "spec",
      "answer",
    ]);
  });

  test("a request with no answer is 'none' only once it settles", async () => {
    const { api, target } = setup();
    await target.fetch("/api/v2/nothing-here");
    expect(api.requests()[0]).toMatchObject({
      source: "none",
      state: "answered",
      status: 404,
    });
  });

  test("a fail answer gives its status and the default body", async () => {
    const { api, target } = setup();
    api.setAnswer("GET /api/*", { mode: "fail", status: 422 });
    const response = await target.fetch(BOTS);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "The request failed." });
  });

  test("a 204 value answer has no body", async () => {
    const { api, target } = setup();
    api.setAnswer("ALL /api/*", { mode: "value", status: 204, body: null });
    const response = await target.fetch(BOTS, { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("an offline answer rejects with a TypeError and the record failed", async () => {
    const { api, target } = setup();
    api.setAnswer("ALL /api/*", { mode: "offline" });
    const error = await target.fetch(BOTS).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe("Failed to fetch");
    expect(api.requests()[0]).toMatchObject({
      source: "answer",
      route: "ALL /api/*",
      status: null,
      state: "failed",
    });
  });

  test("other paths and other origins go to the real fetch", async () => {
    const { api, target, realCalls } = setup();
    expect(await (await target.fetch("/assets/x.js")).text()).toBe("real");
    expect(
      await (await target.fetch("https://openbot.example.com/api/x")).text(),
    ).toBe("real");
    expect(realCalls).toEqual([
      "/assets/x.js",
      "https://openbot.example.com/api/x",
    ]);
    expect(api.requests()).toEqual([]);
  });

  test("a Request with a body outside /api reaches the real fetch as the same object", async () => {
    const seen: unknown[] = [];
    const target = { fetch: globalThis.fetch };
    installFakeApi(target, {
      origin: ORIGIN,
      realFetch: (async (input: string | URL | Request) => {
        seen.push(input);
        return new Response("real");
      }) as typeof fetch,
      groups: [],
      setTimer: () => {},
      now: () => 0,
    });
    const request = new Request(`${ORIGIN}/upload`, {
      method: "POST",
      body: "payload",
    });
    expect(await (await target.fetch(request)).text()).toBe("real");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(request);
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe("payload");
  });

  test("clearAnswer falls back to the groups", async () => {
    const { api, target, changes } = setup();
    const route = "GET /api/v2/organizations/:organizationId/bots" as const;
    api.setAnswer(route, { mode: "value", body: { answer: true } });
    api.clearAnswer(route);
    expect(api.answers().size).toBe(0);
    expect(await (await target.fetch(BOTS)).json()).toEqual({
      bots: [{ id: "spec-bot" }],
    });
    expect(changes.filter((change) => change.kind === "answer")).toEqual([
      { kind: "answer", route },
      { kind: "answer", route },
    ]);
  });

  test("onChange gives request, then settled", async () => {
    const { target, changes } = setup();
    await target.fetch(BOTS);
    expect(changes.map((change) => change.kind)).toEqual([
      "request",
      "settled",
    ]);
    const [request, settled] = changes;
    expect(request.kind === "request" && request.record.state).toBe("pending");
    expect(settled.kind === "settled" && settled.record.state).toBe("answered");
  });

  test("a thrown handler error rejects and the record failed", async () => {
    const realCalls: string[] = [];
    const target = { fetch: fetch };
    const api = installFakeApi(target, {
      origin: ORIGIN,
      realFetch: (async () => {
        realCalls.push("real");
        return new Response();
      }) as unknown as typeof fetch,
      groups: [
        {
          source: "extra",
          handlers: [
            http.get("*/api/boom", () => {
              throw new Error("boom");
            }),
          ],
        },
      ],
      setTimer: () => {},
      now: () => 0,
    });
    const error = await target.fetch("/api/boom").catch((reason) => reason);
    // msw's getResponse lets a resolver's error propagate.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("boom");
    expect(api.requests()[0]).toMatchObject({ state: "failed", status: null });
    expect(realCalls).toEqual([]);
    api.uninstall();
  });

  test("uninstall restores the original fetch", () => {
    const { api, target, original } = setup();
    expect(target.fetch).not.toBe(original);
    api.uninstall();
    expect(target.fetch).toBe(original);
  });
});
