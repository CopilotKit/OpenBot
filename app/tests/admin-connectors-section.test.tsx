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
import { McpAllowlistSection } from "@/components/admin/controls/mcp-allowlist-section";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { overviewResponse, SETTINGS_PATH } from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin, Apps: Connectors, the allowlist of the apps Bots may call.
 *
 * FOUND LIVE: with the allowlist on, every app an admin had added and connected read off, and every
 * Bot's call to them was refused. With it off, the same switches read off and could be flipped,
 * though they did nothing. Now: off, every app reads on and can't be switched; turning it on
 * approves every app already added; Routines and OpenBot settings read on in both states and are
 * never switchable. The server is faked at the fetch boundary with the API's own answers.
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

const APPS = [
  { id: "routines", title: "Routines", url: "builtin://routines" },
  {
    id: "openbot-settings",
    title: "OpenBot settings",
    url: "builtin://openbot-settings",
  },
  { id: "composio-slack", title: "Slack", url: "composio://slack" },
  { id: "notion", title: "Notion", url: "https://mcp.notion.com/mcp" },
];

let allowlist: { enabled: boolean; servers: string[] };
const writes: unknown[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? "GET") === "PATCH" && path === SETTINGS_PATH) {
      const body = JSON.parse(String(init?.body)) as {
        mcpAllowlist: typeof allowlist;
      };
      writes.push(body);
      allowlist = body.mcpAllowlist;
      return Response.json({});
    }
    const overview = overviewResponse(path, {
      settings: { mcpAllowlist: allowlist },
      mcpServers: APPS,
    });
    if (overview) return overview;
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  allowlist = { enabled: false, servers: [] };
  queryClient.clear();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  serving();
});

async function draw() {
  const router = createRouter({
    routeTree: createRootRoute({ component: McpAllowlistSection }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** A switch as a person meets it: whether it reads on, and whether it can be pressed. */
function state(element: HTMLElement) {
  return {
    on: element.getAttribute("aria-checked") === "true",
    locked:
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.hasAttribute("data-disabled"),
  };
}

test("is called Connectors, and with it off every app reads on and can't be switched", async () => {
  const view = await draw();
  expect(await view.findByRole("heading", { name: "Connectors" })).toBeTruthy();
  expect(view.queryByText(/MCP server/)).toBeNull();
  const master = view.getByRole("switch", { name: "Only approved connectors" });
  expect(state(master)).toEqual({ on: false, locked: false });
  expect(view.getByText("Off. Bots can use every connector.")).toBeTruthy();
  for (const app of APPS)
    expect(
      state(view.getByRole("switch", { name: `Approve ${app.title}` })),
    ).toEqual({ on: true, locked: true });
  expect(view.getAllByText("Always on, for every Bot.")).toHaveLength(2);
});

test("turning it on approves every app already added, and each can then be turned off but Routines", async () => {
  const view = await draw();
  fireEvent.click(
    await view.findByRole("switch", { name: "Only approved connectors" }),
  );
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    mcpAllowlist: { enabled: true, servers: ["composio-slack", "notion"] },
  });

  await waitFor(() => expect(view.getByText("2 approved")).toBeTruthy());
  const slack = view.getByRole("switch", { name: "Approve Slack" });
  expect(state(slack)).toEqual({ on: true, locked: false });
  expect(state(view.getByRole("switch", { name: "Approve Routines" }))).toEqual(
    { on: true, locked: true },
  );

  fireEvent.click(slack);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual({
    mcpAllowlist: { enabled: true, servers: ["notion"] },
  });
  await waitFor(() =>
    expect(state(view.getByRole("switch", { name: "Approve Slack" }))).toEqual({
      on: false,
      locked: false,
    }),
  );
  expect(view.getByText("1 approved")).toBeTruthy();
});
