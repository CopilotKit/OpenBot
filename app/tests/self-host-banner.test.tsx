import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UserPreferences } from "@openbot/shared/user-preferences";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { TeamFeaturesDialog } from "@/components/edition/team-features-dialog";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { PREFERENCES_PATH, preferencesResponse } from "./accounts-api";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let response: () => Promise<Response>;
let requests: { path: string; method: string; body: unknown }[];
// The dialog's booking calendar keeps its address but never fetches it: no test reaches Calendly.
beforeAll(() =>
  GlobalRegistrator.register({
    url: "http://localhost/",
    settings: { navigation: { disableChildFrameNavigation: true } },
  }),
);
beforeEach(() => {
  requests = [];
  response = async () =>
    preferencesResponse({
      preferences: {
        messageListEmphasis: "thread",
        selfHostBannerDismissed: true,
      },
    });
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
// A failed save rolls the cache back after the last test has seen the banner return, and React
// renders that after `cleanup`. Unregistering at once removes `window` under it, and the scheduler's
// read of `window.event` throws between tests, failing the run with every test passed.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const banner = { name: "Self-host OpenBot" } as const;

function setup({
  enabled = true,
  dismissed = false,
}: {
  enabled?: boolean;
  dismissed?: boolean;
} = {}) {
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
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: enabled,
  });
  const preferences: UserPreferences = {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: dismissed,
    narration: null,
    skin: "openbot",
    proactive: "on",
  };
  client.setQueryData(
    userPreferencesQueryOptions("alice").queryKey,
    preferences,
  );
  const view = render(
    <QueryClientProvider client={client}>
      <SelfHostBanner />
      <TeamFeaturesDialog />
    </QueryClientProvider>,
  );
  return { client, view };
}

test("offers self-hosting, and Book a call opens the OpenBot for Business dialog in the app", async () => {
  const { view } = setup();
  expect(
    view.getByText("Self-host OpenBot for your organization."),
  ).toBeTruthy();
  expect(view.queryByRole("link", { name: "Book a call" })).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Book a call" }));

  const dialog = await view.findByRole("dialog", {
    name: "OpenBot for Business",
  });
  expect(dialog.querySelector('iframe[title="Booking calendar"]')).toBeTruthy();
});

test("stays hidden for somebody who closed it", () => {
  const { view } = setup({ dismissed: true });
  expect(view.queryByRole("complementary", banner)).toBeNull();
});

test("stays hidden when the deployment turned it off", () => {
  const { view } = setup({ enabled: false });
  expect(view.queryByRole("complementary", banner)).toBeNull();
});

test("closing it hides it at once and saves the choice to this person's preferences", async () => {
  const { client, view } = setup();
  fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
  // Hidden from the cache patch, before the save has answered.
  await waitFor(() =>
    expect(view.queryByRole("complementary", banner)).toBeNull(),
  );
  await waitFor(() => expect(requests.length).toBe(1));
  expect(requests[0]).toEqual({
    path: PREFERENCES_PATH,
    method: "PATCH",
    body: JSON.stringify({ selfHostBannerDismissed: true }),
  });
  await waitFor(() =>
    expect(
      client.getQueryData<UserPreferences>(
        userPreferencesQueryOptions("alice").queryKey,
      )?.selfHostBannerDismissed,
    ).toBe(true),
  );
});

test("comes back if the save fails, so the click is not silently lost", async () => {
  response = async () =>
    Response.json({ error: "Could not save" }, { status: 500 });
  const { view } = setup();
  fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(view.getByRole("complementary", banner)).toBeTruthy(),
  );
});
