import { afterEach, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import {
  approveAppAccessRequestMutationOptions,
  approveBotAppMutationOptions,
  cancelAppAccessRequestMutationOptions,
  dismissAppAccessRequestMutationOptions,
  requestAppAccessMutationOptions,
} from "../src/lib/app-access/mutations";
import { appAccessKeys } from "../src/lib/app-access/queries";
import { pluginKeys } from "../src/lib/plugins/queries";

/**
 * The access-request writes, as the browser makes them: what each sends, and that each refreshes
 * every plugin screen on the way out — refused or not, for the reason `invalidatePlugins` gives.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answering(status: number, body: unknown) {
  const sent: { url: string; method: string; body?: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    // A request with no body is recorded with no `body` key, so its absence can be asserted.
    sent.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return sent;
}

async function run(
  build: (queryClient: QueryClient) => unknown,
  variables: unknown,
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const asked: unknown[] = [];
  const invalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: never) => {
    asked.push(filters);
    return invalidate(filters);
  }) as typeof queryClient.invalidateQueries;
  const observer = new MutationObserver(
    queryClient,
    build(queryClient) as never,
  );
  const result = await observer
    .mutate(variables as never)
    .catch((error: Error) => error);
  return { asked, result };
}

test("every app-access key sits under the plugin root, so plugin writes refresh it", () => {
  for (const key of [
    appAccessKeys.all,
    appAccessKeys.bot("b"),
    appAccessKeys.app("b", "Gmail"),
    appAccessKeys.inbox("composio-gmail"),
  ])
    expect(key.slice(0, 1)).toEqual([...pluginKeys.all]);
});

test("asking names the Bot and the app and nothing else", async () => {
  const sent = answering(201, { request: { id: "r1" }, created: true });
  const { asked, result } = await run(requestAppAccessMutationOptions, {
    agentId: "bot-1",
    app: "Gmail",
  });
  expect(sent).toEqual([
    {
      url: "/api/plugins/access-requests",
      method: "POST",
      body: { agentId: "bot-1", app: "Gmail" },
    },
  ]);
  expect(result).toEqual({ request: { id: "r1" }, created: true });
  expect(asked).toEqual([{ queryKey: pluginKeys.all }]);
});

test("approving sends refs only when given", async () => {
  const sent = answering(200, { request: {}, enabled: false, granted: [] });
  await run(approveAppAccessRequestMutationOptions, { id: "r1" });
  await run(approveAppAccessRequestMutationOptions, {
    id: "r2",
    refs: ["composio-gmail/SEND"],
  });
  expect(sent).toEqual([
    { url: "/api/plugins/access-requests/r1/approve", method: "POST" },
    {
      url: "/api/plugins/access-requests/r2/approve",
      method: "POST",
      body: { refs: ["composio-gmail/SEND"] },
    },
  ]);
  // `toEqual` passes over a key it is not given, so the first approval's missing body is its own
  // assertion: no refs means no body at all, not an empty one.
  expect(sent[0]).not.toHaveProperty("body");
});

test("an admin's one press names the Bot and the app in the path, and sends no refs", async () => {
  const sent = answering(200, { request: {}, enabled: true, granted: [] });
  const { asked } = await run(approveBotAppMutationOptions, {
    agentId: "bot 1",
    app: "composio-gmail",
  });
  expect(sent).toEqual([
    {
      url: "/api/plugins/for/bot%201/apps/composio-gmail/approve",
      method: "POST",
    },
  ]);
  expect(sent[0]).not.toHaveProperty("body");
  expect(asked).toEqual([{ queryKey: pluginKeys.all }]);
});

test("a refused write still refreshes every plugin screen", async () => {
  for (const build of [
    requestAppAccessMutationOptions,
    cancelAppAccessRequestMutationOptions,
    approveAppAccessRequestMutationOptions,
    dismissAppAccessRequestMutationOptions,
  ]) {
    answering(409, { error: "That request has already been answered." });
    const { asked, result } = await run(build, "r1");
    expect((result as Error).message).toBe(
      "That request has already been answered.",
    );
    expect(asked).toEqual([{ queryKey: pluginKeys.all }]);
  }
});
