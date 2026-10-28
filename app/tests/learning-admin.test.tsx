import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LearningSettings } from "@openbot/shared/learning";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { LearningPage } from "@/routes/_authed/admin/learning";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function page() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: LearningPage });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("an administrator excludes a Bot and saves without losing the default or pause state", async () => {
  let settings: LearningSettings = {
    enabled: false,
    defaultTarget: { containerId: "support" },
    agents: { bot: { containerId: "sales" } },
  };
  let saved: LearningSettings | undefined;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/settings")) {
        if (init?.method === "PUT") {
          saved = JSON.parse(String(init.body));
          settings = saved!;
        }
        return Response.json({ settings });
      }
      if (path.includes("/api/agents")) return Response.json({ agents: [] });
      return Response.json(
        { error: "Intelligence Learning is unavailable." },
        { status: 502 },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = page();
  const participation = await view.findByLabelText("bot participation");
  fireEvent.change(participation, { target: { value: "exclude" } });
  fireEvent.click(view.getByRole("button", { name: "Save Learning settings" }));
  await waitFor(() =>
    expect(saved).toEqual({
      enabled: false,
      defaultTarget: { containerId: "support" },
      agents: { bot: null },
    }),
  );
  await view.findByText("Settings saved.");
});

test("an unavailable settings store shows an error instead of an editable empty configuration", async () => {
  global.fetch = Object.assign(
    async () =>
      Response.json(
        { error: "Learning settings could not be accessed." },
        { status: 503 },
      ),
    { preconnect: originalFetch.preconnect },
  );
  const view = page();
  await waitFor(() =>
    expect(
      view.getAllByText("Learning settings could not be accessed.").length,
    ).toBeGreaterThan(0),
  );
  expect(
    view.queryByRole("button", { name: "Save Learning settings" }),
  ).toBeNull();
});

test("active and hidden Bots both have participation controls", async () => {
  const bot = (id: string) => ({
    id,
    name: id,
    title: "Bot",
    roleDescription: "Helps",
    avatarSeed: id,
    visibility: "public",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: id === "hidden-bot",
    systemOwned: true,
    canManage: true,
    mine: false,
  });
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/settings"))
        return Response.json({
          settings: { enabled: false, defaultTarget: null, agents: {} },
        });
      if (path === "/api/agents?hidden=true")
        return Response.json({ agents: [bot("hidden-bot")] });
      if (path === "/api/agents")
        return Response.json({ agents: [bot("active-bot")] });
      return Response.json({ error: "Unavailable" }, { status: 502 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = page();
  await view.findByLabelText("hidden-bot participation");
  expect(view.queryByLabelText("active-bot participation")).not.toBeNull();
});

function serve(body: unknown) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/settings")) return Response.json(body);
      if (path.includes("/api/agents")) return Response.json({ agents: [] });
      return Response.json({ error: "unavailable" }, { status: 502 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

test.each([
  [
    { enabled: true, defaultTarget: null, agents: {} },
    { state: "absent", containerId: "openbot" },
    'This Intelligence project has no "openbot" Learning container yet',
  ],
  [
    { enabled: true, defaultTarget: { containerId: "openbot" }, agents: {} },
    { state: "assigned", containerId: "openbot" },
    'OpenBot assigned this Intelligence project\'s "openbot" container automatically',
  ],
  [
    { enabled: true, defaultTarget: null, agents: {} },
    { state: "not_entitled" },
    "plan doesn't include Learning",
  ],
] as const)(
  "the page says what automatic assignment found (%#)",
  async (settings, automatic, expected) => {
    serve({ settings, automatic });
    const view = page();
    await view.findByText(expected, { exact: false });
  },
);

test("a deployment that chose its own container hears nothing about automatic assignment", async () => {
  serve({
    settings: {
      enabled: true,
      defaultTarget: { containerId: "support" },
      agents: {},
    },
    automatic: { state: "saved" },
  });
  const view = page();
  await view.findByLabelText("Default container ID");
  await waitFor(() =>
    expect(view.queryByText("Loading Learning settings…")).toBeNull(),
  );
  expect(view.queryByText("OpenBot assigned", { exact: false })).toBeNull();
  expect(
    view.queryByText("Learning container yet", { exact: false }),
  ).toBeNull();
});

test("a missing container shows exactly what to run, and a Create button only when the deployment can", async () => {
  const instructions =
    "Sign in once with npx --yes copilotkit@latest login, then run bun scripts/setup-learning.ts.";
  serve({
    settings: { enabled: true, defaultTarget: null, agents: {} },
    automatic: { state: "absent", containerId: "openbot", instructions },
  });
  const cannot = page();
  await cannot.findByText(instructions, { exact: false });
  expect(
    cannot.queryByRole("button", { name: "Create the openbot container" }),
  ).toBeNull();
  cleanup();

  let created = 0;
  const settings = { enabled: true, defaultTarget: null, agents: {} };
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/container") && init?.method === "POST") {
        created++;
        return Response.json({
          automatic: { state: "assigned", containerId: "openbot" },
        });
      }
      if (path.endsWith("/settings"))
        return Response.json({
          settings:
            created > 0
              ? { ...settings, defaultTarget: { containerId: "openbot" } }
              : settings,
          automatic:
            created > 0
              ? { state: "assigned", containerId: "openbot" }
              : {
                  state: "absent",
                  containerId: "openbot",
                  instructions,
                  canCreate: true,
                },
        });
      if (path.includes("/api/agents")) return Response.json({ agents: [] });
      return Response.json({ error: "unavailable" }, { status: 502 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const can = page();
  fireEvent.click(
    await can.findByRole("button", { name: "Create the openbot container" }),
  );
  await can.findByText("container automatically", { exact: false });
  expect(created).toBe(1);
  // Let the refetch the creation started settle before the DOM is torn down.
  await waitFor(() =>
    expect(
      can.queryByRole("button", { name: "Create the openbot container" }),
    ).toBeNull(),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
});
