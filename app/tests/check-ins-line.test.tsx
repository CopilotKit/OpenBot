import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { CheckInsSection } from "@/components/settings/check-ins";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { PREFERENCES_PATH, preferencesResponse } from "./accounts-api";
import { CHECK_INS_PATH, pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/*
 * The check-ins switch drawn as one quiet line under a list: the same switch, saves and disabled
 * rule as the row, with no row around it.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let proactive: "on" | "off" = "on";
let allowed = true;
const writes: { request: string; body: unknown }[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const preferences = () => ({
      messageListEmphasis: "thread",
      selfHostBannerDismissed: true,
      narration: null,
      skin: "openbot",
      proactive,
    });
    if (path === PREFERENCES_PATH && method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      writes.push({ request: `${method} ${path}`, body });
      proactive = body.proactive;
      return preferencesResponse({ preferences: preferences() });
    }
    if (path === PREFERENCES_PATH)
      return preferencesResponse({ preferences: preferences() });
    if (pathOf(path) === CHECK_INS_PATH)
      return Response.json({ nextCursor: null, checkIns: [], allowed });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  proactive = "on";
  allowed = true;
  queryClient.clear();
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    name: "Alice",
    role: "user",
  });
});

async function draw(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the line draws the switch next to the label", async () => {
  serving();
  const view = await draw(<CheckInsSection variant="line" />);
  const toggle = await view.findByRole("switch", {
    name: "Check-ins for all your Bots",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(view.getByText("Check-ins from all Bots")).toBeTruthy();
});

test("pressing the switch on the line saves off, then on", async () => {
  serving();
  const view = await draw(<CheckInsSection variant="line" />);
  const toggle = await view.findByRole("switch", {
    name: "Check-ins for all your Bots",
  });
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(writes).toEqual([
      { request: `PATCH ${PREFERENCES_PATH}`, body: { proactive: "off" } },
    ]),
  );
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false"),
  );
  await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(writes).toEqual([
      { request: `PATCH ${PREFERENCES_PATH}`, body: { proactive: "off" } },
      { request: `PATCH ${PREFERENCES_PATH}`, body: { proactive: "on" } },
    ]),
  );
});

test("turned off by an admin, the line says so and the switch is disabled", async () => {
  allowed = false;
  serving();
  const view = await draw(<CheckInsSection variant="line" />);
  expect(await view.findByText(/Turned off by your admin\./)).toBeTruthy();
  const toggle = view.getByRole("switch", {
    name: "Check-ins for all your Bots",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.hasAttribute("data-disabled")).toBe(true);
});
