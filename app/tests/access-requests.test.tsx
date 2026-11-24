import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { AccessRequestsSection } from "@/components/plugins/access-requests";
import type { AppAccessRequest } from "@/lib/app-access/queries";
import { Route as PluginsIndexRoute } from "@/routes/_authed/admin/plugins/index";
import { answerAppsApi } from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessApprovalResponse,
  appAccessRequestBody,
  appAccessRequestPath,
  appAccessRequestResponse,
} from "./bot-grants-api";
import { settleReactWork } from "./settle-react-work";

/**
 * The administrator's side of an access request: the Requests section on an app's admin page and
 * at the top of the Plugins list, and the count on each row of that list.
 *
 * Approve and Dismiss go to the routes that do the work; a refusal from Approve — the step only an
 * administrator can take first, with the request left pending — is drawn under the request it is
 * about. Who asked is shown, because they asked; nobody's connection is.
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

const request = (
  overrides: Partial<AppAccessRequest> = {},
): AppAccessRequest => ({
  id: "req_1",
  appKey: "composio-gmail",
  appTitle: "Gmail",
  kind: "grant",
  status: "pending",
  agentId: "expenses",
  botName: "Expenses",
  requestedBy: "u_ada",
  requesterEmail: "ada@example.test",
  requesterName: "Ada",
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  resolvedAt: null,
  resolvedBy: null,
  actions: [],
  ...overrides,
});

function serving(options: {
  requests: AppAccessRequest[];
  approve?: { status: number; body: unknown };
  /** How many requests the list answers on one page; every one on the first page unless given. */
  pageSize?: number;
}) {
  const sent: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/approve"))
      return options.approve
        ? Response.json(options.approve.body, {
            status: options.approve.status,
          })
        : appAccessApprovalResponse({
            request: request({ status: "approved" }),
          });
    if (method === "POST" && url.endsWith("/dismiss"))
      return appAccessRequestResponse(request({ status: "dismissed" }));
    if (url.startsWith(APP_ACCESS_REQUESTS_PATH)) {
      const query = new URL(url, "http://x").searchParams;
      const app = query.get("appId");
      const listed = app
        ? options.requests.filter((each) => each.appKey === app)
        : options.requests;
      // Pages of `pageSize`, the cursor saying where the next one starts.
      const start = Number(query.get("cursor") ?? 0);
      const size = options.pageSize ?? listed.length;
      const page = listed.slice(start, start + size);
      const next = start + size < listed.length ? String(start + size) : null;
      return Response.json({
        appAccessRequests: page.map(appAccessRequestBody),
        nextCursor: next,
      });
    }
    if (url === "/api/plugins/connections")
      return Response.json({ connections: [], redirectUri: null });
    const apps = answerAppsApi(input, init, {
      servers: [
        {
          id: "composio-gmail",
          title: "Gmail",
          summary: "Mail.",
          tools: [],
          lastError: null,
        },
        {
          id: "notion",
          title: "Notion",
          summary: "Docs.",
          tools: [],
          lastError: null,
        },
      ],
      composioConfigured: true,
      botsMayCallBack: true,
    });
    if (apps) return apps;
    return Response.json({});
  }) as unknown as typeof fetch;
  return sent;
}

function draw(Page: () => ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: Page,
  });
  const app = createRoute({
    getParentRoute: () => root,
    path: "/admin/plugins/$key",
    component: () => null,
  });
  const composio = createRoute({
    getParentRoute: () => root,
    path: "/admin/plugins/composio",
    component: () => null,
  });
  const bot = createRoute({
    getParentRoute: () => root,
    path: "/admin/plugins/$key/bots/$agentId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, app, composio, bot]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("lists who asked for what, for which Bot, and when — and nothing about anybody's connection", async () => {
  serving({
    requests: [
      request(),
      request({ id: "req_2", kind: "enable", appTitle: "Gmail" }),
      request({
        id: "req_3",
        kind: "connect_shared",
        requesterName: null,
      }),
    ],
  });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  expect(await view.findByText("Give Gmail to Expenses")).toBeTruthy();
  expect(view.getByText("Turn on Gmail for Expenses")).toBeTruthy();
  expect(view.getByText("Connect the shared Gmail account")).toBeTruthy();
  expect(view.getAllByText(/Ada asked 5 minutes ago/)).toHaveLength(2);
  // No name on the request falls back to the address they asked from.
  expect(view.getByText(/ada@example\.test asked/)).toBeTruthy();
  expect(view.queryByText(/connected/i)).toBeNull();
});

test("approve does what was asked through the approve route", async () => {
  const sent = serving({ requests: [request()] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  fireEvent.click(await view.findByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(sent).toContain(`POST ${appAccessRequestPath("req_1")}/approve`),
  );
});

test("an approval the server cannot complete says why, on the request, and leaves it there", async () => {
  serving({
    requests: [request({ kind: "connect_shared" })],
    approve: {
      status: 409,
      body: {
        error:
          "The shared Gmail account is not connected yet. Connect it on Gmail's page under Apps, then approve this request.",
      },
    },
  });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  fireEvent.click(await view.findByRole("button", { name: "Approve" }));
  const row = within(
    (await view.findByRole("alert")).closest("[data-request]") as HTMLElement,
  );
  expect(row.getByRole("alert").textContent).toMatch(
    /^The shared Gmail account is not connected yet\./,
  );
  expect(row.getByRole("button", { name: "Approve" })).toBeTruthy();
});

test("a grant says approving gives the Bot read-only actions, and links to where the others are chosen", async () => {
  serving({ requests: [request()] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  const element = (await view.findByText("Give Gmail to Expenses")).closest(
    "[data-request]",
  ) as HTMLElement;
  const row = within(element);
  expect(element.textContent).toContain(
    "Approving gives Expenses only Gmail's read-only actions. Choose any others on the Bot's page under Gmail.",
  );
  const page = row.getByRole("link", {
    name: "the Bot's page under Gmail",
  });
  expect(page.getAttribute("href")).toBe(
    "/admin/plugins/composio-gmail/bots/expenses",
  );
});

test("a request for actions a Bot needs names them, and Approve gives them with no body", async () => {
  const sent = serving({
    requests: [
      request({
        appKey: "composio-googlecalendar",
        appTitle: "Google Calendar",
        botName: "Calendar Bot",
        actions: [
          "composio-googlecalendar/GOOGLECALENDAR_PATCH_EVENT",
          "composio-googlecalendar/GOOGLECALENDAR_UPDATE_EVENT",
        ],
      }),
    ],
  });
  const view = draw(() => (
    <AccessRequestsSection app="composio-googlecalendar" />
  ));
  const element = (
    await view.findByText("Give Calendar Bot 2 more Google Calendar actions")
  ).closest("[data-request]") as HTMLElement;
  expect(element.textContent).toContain(
    "Approving gives Calendar Bot only GOOGLECALENDAR_PATCH_EVENT and GOOGLECALENDAR_UPDATE_EVENT. Choose any others on the Bot's page under Google Calendar.",
  );
  expect(element.textContent).not.toContain("read-only");
  const bodies: unknown[] = [];
  const answer = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") bodies.push(init.body);
    return answer(input, init);
  }) as typeof fetch;
  fireEvent.click(within(element).getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(sent).toContain(`POST ${appAccessRequestPath("req_1")}/approve`),
  );
  // The server gives the actions the request names.
  expect(bodies).toEqual([undefined]);
});

test("one action asked for reads in the singular", async () => {
  serving({
    requests: [
      request({
        actions: ["composio-gmail/GMAIL_SEND_EMAIL"],
      }),
    ],
  });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  expect(
    await view.findByText("Give Expenses 1 more Gmail action"),
  ).toBeTruthy();
  expect(
    view.getByText(/Approving gives Expenses only GMAIL_SEND_EMAIL\./),
  ).toBeTruthy();
});

test("switching an app on for a Bot says the same, with no link to a page the app does not have yet", async () => {
  serving({ requests: [request({ kind: "enable" })] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  const row = within(
    (await view.findByText("Turn on Gmail for Expenses")).closest(
      "[data-request]",
    ) as HTMLElement,
  );
  expect(
    row.getByText(
      /Approving gives Expenses only Gmail's read-only actions\. Choose any others on the Bot's page under Gmail\./,
    ),
  ).toBeTruthy();
  expect(row.queryByRole("link")).toBeNull();
});

test("an app asked for from Connections, with no Bot, is added for everyone", async () => {
  serving({
    requests: [
      request({
        kind: "enable",
        agentId: null,
        botName: null,
        appKey: "slack",
        appTitle: "Slack",
      }),
    ],
  });
  const view = draw(() => <AccessRequestsSection />);
  const row = within(
    (await view.findByText("Add Slack for everyone")).closest(
      "[data-request]",
    ) as HTMLElement,
  );
  expect(row.queryByText(/a Bot/)).toBeNull();
  expect(row.queryByText(/read-only/)).toBeNull();
});

test("connecting the shared account says nothing about actions", async () => {
  serving({ requests: [request({ kind: "connect_shared" })] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  await view.findByText("Connect the shared Gmail account");
  expect(view.queryByText(/read-only/)).toBeNull();
});

test("an app with no read-only actions is refused on the row, which stays", async () => {
  serving({
    requests: [request()],
    approve: {
      status: 409,
      body: {
        error:
          "Gmail has no read-only actions to grant. Choose which actions Expenses may use on its page under Gmail.",
      },
    },
  });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  fireEvent.click(await view.findByRole("button", { name: "Approve" }));
  expect((await view.findByRole("alert")).textContent).toMatch(
    /^Gmail has no read-only actions to grant\./,
  );
  expect(view.getByText("Give Gmail to Expenses")).toBeTruthy();
});

test("dismiss goes to the dismiss route", async () => {
  const sent = serving({ requests: [request()] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  fireEvent.click(await view.findByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(sent).toContain(`POST ${appAccessRequestPath("req_1")}/dismiss`),
  );
});

test("nothing waiting draws no section at all", async () => {
  const sent = serving({ requests: [] });
  const view = draw(() => <AccessRequestsSection app="composio-gmail" />);
  await waitFor(() =>
    expect(sent).toContain(
      `GET ${APP_ACCESS_REQUESTS_PATH}?limit=100&appId=composio-gmail`,
    ),
  );
  await settleReactWork();
  expect(view.queryByText("Requests")).toBeNull();
});

test("the Plugins list puts every request first and counts them on each app's row", async () => {
  serving({
    requests: [
      request(),
      request({ id: "req_2", kind: "enable" }),
      // An app with no row of its own: its request is still listed, at the top.
      request({
        id: "req_3",
        appKey: "composio-slack",
        appTitle: "Slack",
        kind: "enable",
      }),
    ],
  });
  const Page = PluginsIndexRoute.options.component as () => ReactNode;
  const view = draw(Page);
  expect(await view.findByText("Requests")).toBeTruthy();
  expect(view.getByText("Turn on Slack for Expenses")).toBeTruthy();
  const gmail = within(await view.findByTestId("plugin-composio-gmail"));
  expect(gmail.getByText("2 requests")).toBeTruthy();
  const notion = within(view.getByTestId("plugin-notion"));
  expect(notion.queryByText(/request/)).toBeNull();
});

test("the inbox reads every page of waiting requests, and counts them all", async () => {
  serving({
    requests: [
      request(),
      request({ id: "req_2", kind: "enable" }),
      request({ id: "req_3", appKey: "notion", appTitle: "Notion" }),
    ],
    pageSize: 1,
  });
  const Page = PluginsIndexRoute.options.component as () => ReactNode;
  const view = draw(Page);
  expect(await view.findByText("Give Notion to Expenses")).toBeTruthy();
  const gmail = within(await view.findByTestId("plugin-composio-gmail"));
  expect(gmail.getByText("2 requests")).toBeTruthy();
});
