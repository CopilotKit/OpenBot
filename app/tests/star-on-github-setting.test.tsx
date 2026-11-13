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
import { StarOnGitHubSection } from "@/components/settings/star-on-github";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { OPENBOT_REPO_URL } from "@/lib/star-prompt";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → General's permanent link to star OpenBot on GitHub. There whenever the deployment
 * allows the ask at all, whether or not this person has answered the card; pressing it is counted
 * as a Settings click and answers the card, so somebody who starred here is not asked again.
 */

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let requests: { path: string; method: string; body: unknown }[];

beforeAll(() =>
  // The link is real: pressing it must not open github.com from a test.
  GlobalRegistrator.register({
    url: "http://localhost:3010",
    settings: {
      navigation: {
        disableChildPageNavigation: true,
        disableMainFrameNavigation: true,
      },
    },
  }),
);
beforeEach(() => {
  requests = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      requests.push({ path, method, body });
      if (path.endsWith("/api/settings/preferences")) {
        return Response.json({
          preferences: { ...preferences, ...(body as object) },
        });
      }
      return new Response(null, { status: 204 });
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
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const preferences: UserPreferences = {
  messageListEmphasis: "thread",
  selfHostBannerDismissed: true,
  narration: null,
  skin: "openbot",
  proactive: "on",
};

function setup(starPrompt: boolean) {
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
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    starPrompt,
  });
  client.setQueryData(
    userPreferencesQueryOptions("alice").queryKey,
    preferences,
  );
  return {
    client,
    view: render(
      <QueryClientProvider client={client}>
        <StarOnGitHubSection />
      </QueryClientProvider>,
    ),
  };
}

test("Settings lists Star OpenBot on GitHub, linking to the repository in a new tab", () => {
  const { view } = setup(true);
  expect(view.getByText("Star OpenBot on GitHub")).toBeTruthy();
  const link = view.getByRole("link", { name: "Star on GitHub" });
  expect(link.getAttribute("href")).toBe(OPENBOT_REPO_URL);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("Settings lists nothing when the deployment turned the ask off", () => {
  const { view } = setup(false);
  expect(view.queryByText("Star OpenBot on GitHub")).toBeNull();
  expect(view.queryByRole("link", { name: "Star on GitHub" })).toBeNull();
});

test("pressing it counts a Settings click and answers the card", async () => {
  const { client, view } = setup(true);
  fireEvent.click(view.getByRole("link", { name: "Star on GitHub" }));

  await waitFor(() =>
    expect(
      requests.find((request) =>
        request.path.endsWith("/api/telemetry/product-events"),
      )?.body,
    ).toEqual({
      kind: "star_prompt_clicked",
      trigger: "settings",
      surface: "web",
    }),
  );
  await waitFor(() =>
    expect(
      requests.find(
        (request) =>
          request.path.endsWith("/api/settings/preferences") &&
          request.method === "PATCH",
      )?.body,
    ).toEqual({ starPromptAnswered: true }),
  );
  expect(
    client.getQueryData(userPreferencesQueryOptions("alice").queryKey)
      ?.starPromptAnswered,
  ).toBe(true);
  // Still there: the link in Settings is permanent, whatever the card's answer.
  expect(view.getByRole("link", { name: "Star on GitHub" })).toBeTruthy();
});
