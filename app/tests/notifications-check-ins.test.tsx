import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { Route as NotificationsRoute } from "@/routes/_authed/settings/notifications";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { PREFERENCES_PATH, preferencesResponse } from "./accounts-api";
import { answerBotsList } from "./bots-api";
import { notificationsResponse } from "./notifications-api";
import { CHECK_INS_PATH, pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Settings → Notifications holds the one switch for check-ins from all of a person's Bots, as the
 * page's first section. The Routines page no longer draws it.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function serving() {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === PREFERENCES_PATH)
      return preferencesResponse({
        preferences: {
          messageListEmphasis: "thread",
          selfHostBannerDismissed: true,
          narration: null,
          skin: "openbot",
          proactive: "on",
        },
      });
    if (pathOf(path) === CHECK_INS_PATH)
      return Response.json({ nextCursor: null, checkIns: [], allowed: true });
    const bots = answerBotsList(path, init, { visible: [] });
    if (bots) return bots;
    return (
      notificationsResponse(init?.method ?? "GET", path, {}) ??
      Response.json({}, { status: 404 })
    );
  }) as unknown as typeof fetch;
}

test("Settings → Notifications shows the check-ins row and its switch, first", async () => {
  serving();
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    name: "Alice",
    role: "user",
  });
  const Page = NotificationsRoute.options.component as ComponentType;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Page /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  expect(await view.findByText("Check-ins from all your Bots")).toBeTruthy();
  const toggle = view.getByRole("switch", {
    name: "Check-ins for all your Bots",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  // The section is the first one on the page, titled Check-ins.
  const sections = view.container.querySelectorAll("section");
  expect(sections[0]?.querySelector("h2")?.textContent).toBe("Check-ins");
});
