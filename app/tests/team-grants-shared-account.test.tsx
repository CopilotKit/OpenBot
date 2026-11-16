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
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharedUseRequests } from "@/components/approvals/shared-use-requests";
import { PluginBotPage } from "@/components/manage/plugin-bot-page";
import { agentKeys } from "@/lib/agents/queries";
import type { Team } from "@/lib/api/generated/model";
import { deploymentKeys } from "@/lib/deployment/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  type AppsFixture,
  answerAppsApi,
  seedAppReads,
  type TodayServer,
} from "./apps-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A shared app account's audience names the organization's teams.
 *
 * The real screens on the API's addresses. Turning on an action of a shared app asks who may use
 * the shared account: an admin picks a team by its name and its id is what is sent, as a member of
 * kind `team`. A directory group named before there were teams is still shown and can be removed.
 * Where an approval is read back, a team is called by its name, and one that is gone says so.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const ORGANIZATION = "/api/v2/organizations/default";
const TEAMS_PATH = `${ORGANIZATION}/teams`;
const SHARED_USE_REQUESTS = `${ORGANIZATION}/shared-use-requests`;

const team = (id: string, name: string): Team => ({
  id,
  name,
  description: null,
  parentTeamId: null,
  source: "openbot",
  memberCount: 3,
  role: null,
  canManage: true,
  canMove: true,
  canDelete: true,
  createdAt: "2026-11-15T09:12:40.000Z",
});
const SUPPORT = team("team_4b1d07", "Support");
const FIELD_SALES = team("team_9e52aa", "Field Sales");

const github: TodayServer = {
  id: "gh",
  title: "GitHub",
  vendor: "GitHub",
  url: "https://mcp.github.test/mcp",
  summary: "Issues and pull requests.",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "me",
  dynamicClient: false,
  authScheme: null,
  accountMode: "shared",
  sharedVendorConnected: true,
  ownerGrants: "any",
  ownerGrantsChosen: null,
  withdrawn: [],
  tools: [
    {
      name: "create_issue",
      ref: "gh/create_issue",
      description: "Open an issue.",
      serverId: "gh",
      inputSchema: {},
      effect: "write",
      destructive: false,
      grantedTo: [],
    },
  ],
};
const apps: AppsFixture = {
  catalogue: [],
  servers: [github],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: true,
  provider: "composio",
  authorizesPerAction: false,
};

/** What the Bot's audience needs today: a directory group it was published to before teams. */
const NEEDED = {
  audience: "people",
  outsideInput: false,
  members: [{ kind: "group", value: "platform" }],
};

/** A request whose standing approval names a team, a team since deleted, a group and a person. */
const REQUEST = {
  id: "r1",
  botId: "bot-1",
  botName: "Helpdesk",
  ownerUserId: "dana",
  serverId: "gh",
  title: "GitHub",
  proposed: { audience: "team", outsideInput: false, members: [] },
  current: {
    audience: "people",
    outsideInput: false,
    members: [
      { kind: "team", value: SUPPORT.id },
      { kind: "team", value: "team_deleted" },
      { kind: "group", value: "platform" },
      { kind: "user", value: "user_sam" },
    ],
  },
  reason: "publish",
  requestedBy: "dana",
  status: "pending",
  createdAt: "2026-11-15T09:12:40.000Z",
};

/** Every write, as the server received it. */
let writes: { method: string; path: string; body: unknown }[];
const originalFetch = global.fetch;
beforeEach(() => {
  writes = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        writes.push({
          method,
          path,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ ok: true });
      }
      if (path === ME_PATH)
        return meResponse({
          user: { id: "me", email: "me@example.test", role: "admin" },
        });
      if (path === TEAMS_PATH)
        return Response.json({
          teams: [SUPPORT, FIELD_SALES],
          canCreate: true,
          nextCursor: null,
        });
      if (path === `${ORGANIZATION}/bots/bot-1/shared-use`)
        return Response.json({
          apps: [
            {
              serverId: "gh",
              title: "GitHub",
              approval: null,
              needed: NEEDED,
              covered: false,
            },
          ],
          pending: [],
        });
      if (path === SHARED_USE_REQUESTS)
        return Response.json({
          sharedUseRequests: [REQUEST],
          nextCursor: null,
        });
      return (
        answerAppsApi(input, init, apps) ?? new Response(null, { status: 404 })
      );
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function drawBotAndApp() {
  const queryClient = client();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  seedAppReads(queryClient, apps);
  queryClient.setQueryData(pluginKeys.connections(), { connections: [] });
  const bots = [{ id: "bot-1", name: "Helpdesk", hidden: false }];
  queryClient.setQueryData(agentKeys.list(false), bots);
  queryClient.setQueryData(agentKeys.list(true), bots);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <PluginBotPage agentId="bot-1" pluginKey="gh" />,
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a shared account's audience names a team by its name and sends its id, and a directory group is still shown and can be removed", async () => {
  const view = drawBotAndApp();
  const user = userEvent.setup({ document });

  // Turning on an action of a shared app asks who may use the shared account first.
  await user.click(
    await view.findByRole("switch", { name: "Let Helpdesk call create_issue" }),
  );
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByText(
    "Let Helpdesk use the shared GitHub account?",
  );

  // The audience the Bot has now names a directory group. It is shown as what it is.
  const named = within(dialog).getByRole("radio", {
    name: "Named teams and people",
  }) as HTMLInputElement;
  expect(named.checked).toBe(true);
  const group = (await within(dialog).findByText("platform")).closest(
    "[data-shared-member]",
  ) as HTMLElement;
  expect(group.textContent).toContain("Directory group");

  // The organization's teams are offered by name, never by id.
  await user.click(
    await within(dialog).findByRole("checkbox", { name: "Support" }),
  );
  expect(
    within(dialog).getByRole("checkbox", { name: "Field Sales" }),
  ).toBeTruthy();
  expect(dialog.textContent).not.toContain(SUPPORT.id);

  // The directory group can be taken out.
  await user.click(
    within(dialog).getByRole("button", {
      name: "Remove directory group platform",
    }),
  );
  await waitFor(() =>
    expect(within(dialog).queryByText("platform")).toBeNull(),
  );

  await user.click(within(dialog).getByRole("button", { name: "Allow" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    method: "PUT",
    path: `${ORGANIZATION}/bots/bot-1/grants/${encodeURIComponent("action:gh:create_issue")}`,
    body: {
      approval: {
        audience: "people",
        outsideInput: false,
        members: [{ kind: "team", value: SUPPORT.id }],
      },
    },
  });
});

test("a directory group that is left alone is sent back as it was, beside the team", async () => {
  const view = drawBotAndApp();
  const user = userEvent.setup({ document });

  await user.click(
    await view.findByRole("switch", { name: "Let Helpdesk call create_issue" }),
  );
  const dialog = await view.findByRole("dialog");
  await user.click(
    await within(dialog).findByRole("checkbox", { name: "Field Sales" }),
  );
  await user.click(within(dialog).getByRole("button", { name: "Allow" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.body).toEqual({
    approval: {
      audience: "people",
      outsideInput: false,
      members: [
        { kind: "group", value: "platform" },
        { kind: "team", value: FIELD_SALES.id },
      ],
    },
  });
});

test("naming nobody can't be allowed", async () => {
  const view = drawBotAndApp();
  const user = userEvent.setup({ document });

  await user.click(
    await view.findByRole("switch", { name: "Let Helpdesk call create_issue" }),
  );
  const dialog = await view.findByRole("dialog");
  await user.click(
    await within(dialog).findByRole("button", {
      name: "Remove directory group platform",
    }),
  );
  await within(dialog).findByText("Choose a team.");
  expect(
    (within(dialog).getByRole("button", { name: "Allow" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("an approval that names a team is described by the team's name, and a team that is gone says so", async () => {
  const view = render(
    <QueryClientProvider client={client()}>
      <SharedUseRequests />
    </QueryClientProvider>,
  );
  await view.findByText("Helpdesk wants the shared GitHub account");
  await view.findByText(
    "Now: The team Support, a team that no longer exists, the group platform and 1 person",
  );
  expect(view.container.textContent).not.toContain(SUPPORT.id);
  expect(view.container.textContent).not.toContain("team_deleted");
});
