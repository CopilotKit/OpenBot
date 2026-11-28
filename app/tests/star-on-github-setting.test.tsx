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
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { StarOnGitHubSection } from "@/components/settings/star-on-github";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → General's permanent link to star OpenBot on GitHub. Only in the personal edition, like
 * the card: a team's or a company's OpenBot never asks for a star. It stays whether or not the
 * person answered the card; pressing it is counted as a Settings click and answers the card, so
 * somebody who starred here is not asked again.
 */

const STAR = "star-on-github";
const originalFetch = globalThis.fetch;
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
      if (path.endsWith("/people/me/preferences")) {
        // The API answers with the preferences themselves, not wrapped.
        return Response.json({ ...preferences, ...(body as object) });
      }
      return new Response(null, { status: 204 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const preferences: UserPreferences = {
  messageListEmphasis: "thread",
  selfHostBannerDismissed: true,
  dismissedNotices: [],
  narration: null,
  skin: "openbot",
  proactive: "on",
};

function setup(edition: "personal" | "team") {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    role: "user",
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
    // What an earlier build read as leave to list it everywhere. Nothing reads it now.
    starPrompt: true,
  });
  queryClient.setQueryData(
    userPreferencesQueryOptions("alice").queryKey,
    preferences,
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <StarOnGitHubSection />
    </QueryClientProvider>,
  );
}

test("personal edition: Settings lists Star OpenBot on GitHub, linking to the repository in a new tab", () => {
  const view = setup("personal");
  expect(view.getByText("Star OpenBot on GitHub")).toBeTruthy();
  expect(
    view.getByText(
      "OpenBot is open source. A star helps us keep making it better.",
    ),
  ).toBeTruthy();
  const link = view.getByRole("link", { name: "Star on GitHub" });
  expect(link.getAttribute("href")).toBe(
    "https://github.com/CopilotKit/OpenBot",
  );
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("a team's OpenBot lists nothing", () => {
  const view = setup("team");
  expect(view.queryByText("Star OpenBot on GitHub")).toBeNull();
  expect(view.queryByRole("link", { name: "Star on GitHub" })).toBeNull();
});

test("pressing it counts a Settings click and answers the card", async () => {
  const view = setup("personal");
  fireEvent.click(view.getByRole("link", { name: "Star on GitHub" }));

  await waitFor(() =>
    expect(
      requests.find((request) => request.path.endsWith("/nudge-events"))?.body,
    ).toEqual({
      nudge: STAR,
      action: "clicked",
      place: "settings",
      surface: "web",
    }),
  );
  await waitFor(() =>
    expect(
      requests.find(
        (request) =>
          request.path.endsWith("/people/me/preferences") &&
          request.method === "PATCH",
      )?.body,
    ).toEqual({ dismissedNotices: [STAR] }),
  );
  expect(
    queryClient.getQueryData(userPreferencesQueryOptions("alice").queryKey)
      ?.dismissedNotices,
  ).toEqual([STAR]);
  // Still there: the link in Settings is permanent, whatever the card's answer.
  expect(view.getByRole("link", { name: "Star on GitHub" })).toBeTruthy();
});
