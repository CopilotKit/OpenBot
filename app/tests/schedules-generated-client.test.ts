import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cancelFollowUpMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  createProactiveSetting,
  proactiveAllowedQueryOptions,
  proactiveSuggestionsQueryOptions,
  removeProactiveSetting,
  resolveSuggestion,
  runProactiveNow,
  updateProactiveSetting,
} from "@/lib/proactive";
import {
  createGithubBinding,
  createResponsibility,
  createTrigger,
  deleteResponsibility,
  removeGithubBinding,
  removeTrigger,
  responsibilitiesQueryOptions,
  responsibilityAction,
  revealTriggerSecret,
  setTriggerEnabled,
  setTriggerSecret,
  updateResponsibility,
} from "@/lib/responsibilities";
import {
  createFromPlanMutationOptions,
  deleteRoutineMutationOptions,
  runRoutineNowMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Routines, check-ins, goals and follow-ups are read and written through the client generated from
 * api/openapi.yaml, and only through it.
 *
 * The server here answers at the API's addresses and nowhere else. Every request is recorded, and
 * one to any other address is refused, so a hand-written fetch or an address these lived at before
 * cannot pass: the write would fail, and its line would not be the one expected.
 */

const ORG = "/api/v2/organizations/default";

type Seen = { line: string; key: string | null; body: unknown };
const seen: Seen[] = [];

/** What the API answers each write with, enough of it for the caller to read. */
function answerFor(method: string, path: string): Response {
  if (method === "DELETE") return new HttpResponse(null, { status: 204 });
  if (path === `${ORG}/routines`)
    return HttpResponse.json({ routine: { id: "r1" } }, { status: 201 });
  if (path === `${ORG}/goals`)
    return HttpResponse.json({ goal: { id: "g1", title: "Ship it" } });
  if (path.endsWith("/triggers") || path.endsWith("/replace-secret"))
    return HttpResponse.json({ trigger: { id: "t1" }, secret: "whsec_new" });
  if (path === `${ORG}/github-event-sources`)
    return HttpResponse.json({ githubEventSource: { id: "gh1" } });
  if (path.endsWith("/run") && path.startsWith(`${ORG}/check-ins/`))
    return HttpResponse.json({ queued: true });
  return HttpResponse.json({ ok: true });
}

const server = setupServer(
  http.get(`*${ORG}/routines`, ({ request }) => {
    const cursor = new URL(request.url).searchParams.get("cursor");
    // Two pages, so a reader that stops at the first one is caught.
    return HttpResponse.json(
      cursor
        ? { routines: [{ id: "r2" }], nextCursor: null }
        : { routines: [{ id: "r1" }], nextCursor: "bmV4dA" },
    );
  }),
  http.get(`*${ORG}/check-ins`, () =>
    HttpResponse.json({ checkIns: [], allowed: false, nextCursor: null }),
  ),
  http.get(`*${ORG}/check-in-items`, () =>
    HttpResponse.json({ checkInItems: [{ id: "s1" }], nextCursor: null }),
  ),
  http.get(`*${ORG}/goals`, () =>
    HttpResponse.json({
      goals: [
        { id: "made-last", updatedAt: "2026-11-01T10:00:00Z" },
        { id: "changed-last", updatedAt: "2026-11-09T10:00:00Z" },
      ],
      nextCursor: null,
    }),
  ),
  http.get(`*${ORG}/goals/:goalId/triggers/:triggerId/secret`, () =>
    HttpResponse.json({ secret: "whsec_shown" }),
  ),
  // Every write under the API's address is taken; a write anywhere else is refused below.
  http.all(`*${ORG}/*`, ({ request }) => {
    const url = new URL(request.url);
    return request.method === "GET"
      ? new HttpResponse(null, { status: 404 })
      : answerFor(request.method, url.pathname);
  }),
  http.post("*/api/channels", () =>
    HttpResponse.json({ channel: { id: "c9" } }),
  ),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", async ({ request }) => {
  const url = new URL(request.url);
  const text = await request.clone().text();
  seen.push({
    line: `${request.method} ${url.pathname}${url.search}`,
    key: request.headers.get("idempotency-key"),
    body: text ? JSON.parse(text) : undefined,
  });
});

beforeAll(() => {
  // An address for the page, so the app's relative requests resolve as they do in a browser.
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const freshClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** Runs one of the area's mutations as a screen does. */
function mutate<Variables>(
  queryClient: QueryClient,
  options: object,
  variables: Variables,
) {
  return new MutationObserver(queryClient, options as never).mutate(
    variables as never,
  );
}

/** The writes sent, as `METHOD address`, checked to carry an Idempotency-Key each, all different. */
function writes() {
  const sent = seen.filter((request) => !request.line.startsWith("GET "));
  for (const request of sent) expect(request.key).toBeTruthy();
  expect(new Set(sent.map((request) => request.key)).size).toBe(sent.length);
  return sent.map(({ line, body }) => ({ line, body }));
}

test("the lists are read at the API's addresses, every page of them", async () => {
  const queryClient = freshClient();

  const routines = await queryClient.fetchQuery(routinesQueryOptions());
  expect(routines.routines.map((routine) => routine.id)).toEqual(["r1", "r2"]);

  expect(await queryClient.fetchQuery(proactiveAllowedQueryOptions())).toEqual({
    settings: [],
    allowed: false,
  });
  expect(
    (await queryClient.fetchQuery(proactiveSuggestionsQueryOptions())).map(
      (item) => item.id,
    ),
  ).toEqual(["s1"]);

  // The API lists goals by when each was made; the screens show the one changed last first.
  expect(
    (await queryClient.fetchQuery(responsibilitiesQueryOptions())).map(
      (goal) => goal.id,
    ),
  ).toEqual(["changed-last", "made-last"]);

  expect(seen.map((request) => request.line)).toEqual([
    `GET ${ORG}/routines?limit=100`,
    `GET ${ORG}/routines?limit=100&cursor=bmV4dA`,
    `GET ${ORG}/check-ins?limit=100`,
    `GET ${ORG}/check-in-items?limit=100`,
    `GET ${ORG}/goals?limit=100`,
  ]);
});

test("a routine is made, paused, resumed, run and deleted at the API's addresses", async () => {
  const queryClient = freshClient();
  await mutate(queryClient, createFromPlanMutationOptions(queryClient), {
    kind: "routine",
    routine: {
      botId: "bot-1",
      conversationId: "c1",
      instruction: "Send the digest",
      cron: "0 9 * * 1",
      timezone: "Europe/Paris",
    },
  });
  const enabled = setRoutineEnabledMutationOptions(queryClient);
  await mutate(queryClient, enabled, { id: "r/1", enabled: false });
  await mutate(queryClient, enabled, { id: "r/1", enabled: true });
  await mutate(queryClient, runRoutineNowMutationOptions(queryClient), "r/1");
  await mutate(queryClient, deleteRoutineMutationOptions(queryClient), "r/1");

  expect(writes()).toEqual([
    {
      line: `POST ${ORG}/routines`,
      body: {
        botId: "bot-1",
        conversationId: "c1",
        instruction: "Send the digest",
        cron: "0 9 * * 1",
        timezone: "Europe/Paris",
      },
    },
    // An id stays one path segment, whatever it holds.
    { line: `POST ${ORG}/routines/r%2F1/pause`, body: undefined },
    { line: `POST ${ORG}/routines/r%2F1/resume`, body: undefined },
    { line: `POST ${ORG}/routines/r%2F1/run`, body: undefined },
    { line: `DELETE ${ORG}/routines/r%2F1`, body: undefined },
  ]);
});

test("a check-in is turned on, changed, run and removed, and an item started or hidden, at the API's addresses", async () => {
  const input = {
    botId: "bot-1",
    conversationId: "c1",
    focus: "Watch the inbox",
    subject: "Inbox",
    intervalMinutes: 60,
  };
  await createProactiveSetting(input);
  await createProactiveSetting(input, { refuseExisting: true });
  await updateProactiveSetting("p1", { enabled: false });
  expect(await runProactiveNow("p1")).toEqual({ queued: true });
  await removeProactiveSetting("p1");
  await resolveSuggestion("s1", "start");
  await resolveSuggestion("s1", "dismiss");

  expect(writes()).toEqual([
    { line: `POST ${ORG}/check-ins`, body: input },
    { line: `POST ${ORG}/check-ins?refuseExisting=true`, body: input },
    { line: `PATCH ${ORG}/check-ins/p1`, body: { enabled: false } },
    { line: `POST ${ORG}/check-ins/p1/run`, body: undefined },
    { line: `DELETE ${ORG}/check-ins/p1`, body: undefined },
    { line: `POST ${ORG}/check-in-items/s1/work-on`, body: undefined },
    { line: `POST ${ORG}/check-in-items/s1/dismiss`, body: undefined },
  ]);
});

test("a goal, its triggers and a GitHub event source are written at the API's addresses", async () => {
  const goal = {
    botId: "bot-1",
    conversationId: "c1",
    title: "Ship it",
    instruction: "Ship the release",
  };
  expect((await createResponsibility(goal)).id).toBe("g1");
  await updateResponsibility("g1", { title: "Ship it soon" });
  for (const action of ["pause", "resume", "run", "complete"] as const)
    await responsibilityAction("g1", action);

  const trigger = { id: "t1", goalId: "g1" };
  const config = { kind: "webhook" as const, filter: { eventTypes: [] } };
  expect((await createTrigger("g1", { config })).secret).toBe("whsec_new");
  await setTriggerSecret(trigger);
  await setTriggerSecret(trigger, "pasted");
  await setTriggerEnabled(trigger, false);
  await setTriggerEnabled(trigger, true);
  expect(await revealTriggerSecret(trigger)).toBe("whsec_shown");
  await removeTrigger(trigger);
  await deleteResponsibility("g1");

  expect((await createGithubBinding("acme/web", "s3cret")).id).toBe("gh1");
  await removeGithubBinding("gh1");

  const triggers = `${ORG}/goals/g1/triggers`;
  expect(writes()).toEqual([
    { line: `POST ${ORG}/goals`, body: goal },
    { line: `PATCH ${ORG}/goals/g1`, body: { title: "Ship it soon" } },
    { line: `POST ${ORG}/goals/g1/pause`, body: undefined },
    { line: `POST ${ORG}/goals/g1/resume`, body: undefined },
    { line: `POST ${ORG}/goals/g1/run`, body: undefined },
    { line: `POST ${ORG}/goals/g1/complete`, body: undefined },
    { line: `POST ${triggers}`, body: { config } },
    { line: `POST ${triggers}/t1/replace-secret`, body: {} },
    { line: `POST ${triggers}/t1/replace-secret`, body: { secret: "pasted" } },
    { line: `POST ${triggers}/t1/disable`, body: undefined },
    { line: `POST ${triggers}/t1/enable`, body: undefined },
    { line: `DELETE ${triggers}/t1`, body: undefined },
    { line: `DELETE ${ORG}/goals/g1`, body: undefined },
    {
      line: `POST ${ORG}/github-event-sources`,
      body: { repository: "acme/web", secret: "s3cret" },
    },
    { line: `DELETE ${ORG}/github-event-sources/gh1`, body: undefined },
  ]);
  // The secret is read, never written for.
  expect(seen.map((request) => request.line)).toContain(
    `GET ${triggers}/t1/secret`,
  );
});

test("a follow-up is cancelled at its own address under its Bot, with nothing sent", async () => {
  const queryClient = freshClient();
  await mutate(queryClient, cancelFollowUpMutationOptions(queryClient), {
    agentId: "bot-1",
    id: "wake-up:42",
  });
  expect(writes()).toEqual([
    {
      line: `POST ${ORG}/bots/bot-1/follow-ups/wake-up%3A42/cancel`,
      body: undefined,
    },
  ]);
});
