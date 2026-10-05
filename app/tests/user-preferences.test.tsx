import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { authKeys } from "@/lib/auth/queries";
import {
  saveUserPreferencesMutationOptions,
  userPreferencesQueryOptions,
} from "@/lib/settings/message-list";
import type { UserPreferences } from "../../shared/user-preferences";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let response: () => Promise<Response>;
let requests: { path: string; method: string; body: unknown }[];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  requests = [];
  response = async () =>
    Response.json({ preferences: { messageListEmphasis: "agent" } });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path: String(input),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return response();
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

function setup() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    role: "user",
    onboarding: null,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MessageListPreference />
    </QueryClientProvider>,
  );
  return { client, view };
}

test("loads preferences from the account and renders the saved emphasis", async () => {
  const { view } = setup();
  const agent = await view.findByText("General Assistant");
  expect(agent.className).toContain("text-[0.9rem]");
  expect(requests).toEqual([
    { path: "/api/settings/preferences", method: "GET", body: undefined },
  ]);
});

test("shows loading and read errors without enabling a save", async () => {
  const pending = Promise.withResolvers<Response>();
  response = () => pending.promise;
  const { view } = setup();
  expect(view.getByRole("combobox")).toHaveProperty("disabled", true);
  expect(view.queryByText("General Assistant")).toBeNull();
  pending.resolve(
    Response.json({ error: "Storage unavailable" }, { status: 503 }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "Storage unavailable",
  );
  expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("successful writes update only the current account cache; failures preserve saved values", async () => {
  const { client, view } = setup();
  await view.findByText("General Assistant");
  const bobKey = userPreferencesQueryOptions("bob").queryKey;
  client.setQueryData(bobKey, {
    messageListEmphasis: "agent",
    selfHostBannerDismissed: false,
  });
  const mutation = client
    .getMutationCache()
    .build(client, saveUserPreferencesMutationOptions(client, "alice"));
  response = async () =>
    Response.json({
      preferences: {
        messageListEmphasis: "thread",
        selfHostBannerDismissed: false,
      },
    });
  await mutation.execute({ messageListEmphasis: "thread" });
  await waitFor(() =>
    expect(view.getByText("Plan next week").className).toContain(
      "text-[0.9rem]",
    ),
  );
  expect(requests.at(-1)).toEqual({
    path: "/api/settings/preferences",
    method: "PATCH",
    body: JSON.stringify({ messageListEmphasis: "thread" }),
  });
  expect(client.getQueryData<UserPreferences>(bobKey)).toEqual({
    messageListEmphasis: "agent",
    selfHostBannerDismissed: false,
  });
  response = async () =>
    Response.json({ error: "Could not save" }, { status: 500 });
  await expect(
    mutation.execute({ messageListEmphasis: "agent" }),
  ).rejects.toThrow("Could not save");
  expect(
    client.getQueryData<UserPreferences>(
      userPreferencesQueryOptions("alice").queryKey,
    ),
  ).toEqual({ messageListEmphasis: "thread", selfHostBannerDismissed: false });
});
