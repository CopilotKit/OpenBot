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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { CapabilitiesSection } from "@/components/admin/controls/capabilities-section";
import { NetworkSection } from "@/components/admin/controls/computer-sections";
import {
  getListCapabilitiesMockHandler,
  getUpdateCapabilityMockHandler,
} from "@/lib/api/generated/capabilities/capabilities.msw";
import type {
  Capability,
  NetworkPolicy,
  Team,
} from "@/lib/api/generated/model";
import {
  getDeleteNetworkPolicyMockHandler,
  getListNetworkPoliciesMockHandler,
  getReplaceNetworkPolicyMockHandler,
  getReplayNetworkPolicyMockHandler,
} from "@/lib/api/generated/network-policies/network-policies.msw";
import { getGetOrganizationSettingsMockHandler } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import { getListTeamsMockHandler } from "@/lib/api/generated/teams/teams.msw";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { settingsBody } from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";

/**
 * Admin's rules for a team: a permission switch on Permissions and a network policy on Computers.
 *
 * Where an admin used to pick a directory group, they pick one of the organization's teams by name,
 * and the team's id is what is sent. A rule made for a directory group before there were teams is
 * still listed and can still be removed, and so is a rule for a team that has since been deleted.
 *
 * The server is the spec's own: the MSW handlers Orval generates beside the client, at the API's
 * addresses, keeping the switches and policies the screens write. The screens are the real ones, on
 * the app's one query client.
 */

const team = (id: string, name: string, rest: Partial<Team> = {}): Team => ({
  id,
  name,
  description: null,
  parentTeamId: null,
  source: "openbot",
  memberCount: 2,
  role: null,
  canManage: true,
  canMove: true,
  canDelete: true,
  createdAt: "2026-11-15T09:12:40.000Z",
  ...rest,
});

const TEAMS = [
  team("team_sales", "Sales"),
  team("team_emea", "Sales EMEA", { parentTeamId: "team_sales" }),
  team("team_finance", "Finance", { source: "directory", canManage: false }),
];

const policy = (
  scopeKind: NetworkPolicy["scopeKind"],
  scopeId: string,
  rest: Partial<NetworkPolicy> = {},
): NetworkPolicy => ({
  id: scopeKind === "organization" ? "organization" : `${scopeKind}:${scopeId}`,
  scopeKind,
  scopeId,
  mode: "defaults_plus_allowlist",
  rules: [{ type: "domain", value: "hubspot.com" }],
  locked: false,
  updatedBy: "dana@acme.test",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...rest,
});

let capabilities: Capability[];
let policies: NetworkPolicy[];
/** Every write, as the server received it. */
let writes: { method: string; path: string; body: unknown }[];

const server = setupServer(
  getListTeamsMockHandler(() => ({
    teams: TEAMS,
    canCreate: true,
    nextCursor: null,
  })),
  getGetOrganizationSettingsMockHandler(
    () =>
      settingsBody({
        groups: ["contractors"],
        defaultDestinations: [
          "github.com",
          "githubusercontent.com",
          "ghcr.io",
          "registry.npmjs.org",
          "pypi.org",
        ],
      }) as never,
  ),
  getListCapabilitiesMockHandler(() => ({ capabilities, nextCursor: null })),
  getUpdateCapabilityMockHandler(async ({ params, request }) => {
    const body = await request.json();
    const capability = capabilities.find(
      (one) => one.id === params.capabilityId,
    ) as Capability;
    for (const level of ["groups", "teams"] as const)
      for (const [name, allowed] of Object.entries(body[level] ?? {})) {
        const stored: Record<string, boolean> = { ...capability[level] };
        if (allowed === null) delete stored[name];
        else stored[name] = allowed;
        capability[level] = stored;
      }
    return capability;
  }),
  getListNetworkPoliciesMockHandler(() => ({
    networkPolicies: policies,
    nextCursor: null,
  })),
  getReplaceNetworkPolicyMockHandler(async ({ params, request }) => {
    const { authoring: _authoring, ...body } = await request.json();
    const [scopeKind, ...rest] = params.networkPolicyId.split(":");
    const saved = policy(
      scopeKind as NetworkPolicy["scopeKind"],
      rest.join(":"),
      body as Partial<NetworkPolicy>,
    );
    policies = [...policies.filter((one) => one.id !== saved.id), saved];
    return saved;
  }),
  getDeleteNetworkPolicyMockHandler(({ params }) => {
    policies = policies.filter((one) => one.id !== params.networkPolicyId);
  }),
  getReplayNetworkPolicyMockHandler(() => ({
    scanned: 0,
    covered: 0,
    wouldBlock: 0,
    wouldAllow: 0,
    undecided: 0,
    unchanged: 0,
    hosts: [],
    sites: 0,
  })),
  // Nothing else is these screens' business.
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", async ({ request }) => {
  if (request.method === "GET") return;
  const url = new URL(request.url);
  if (url.pathname.endsWith("/replay")) return;
  const text = await request.clone().text();
  writes.push({
    method: request.method,
    path: decodeURIComponent(url.pathname),
    body: text ? JSON.parse(text) : undefined,
  });
});

const ORGANIZATION = "/api/v2/organizations/default";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  writes = [];
  capabilities = [
    {
      id: "cloudBrowser",
      title: "Cloud browser",
      description: "Bots may browse the web on a computer of their own.",
      default: true,
      organization: false,
      roles: {},
      // A rule from before there were teams, and one for a team deleted since.
      groups: { contractors: true },
      teams: { team_gone: true },
    },
    {
      id: "localComputer",
      title: "Their own computer",
      description: "Bots may use folders on the person's computer.",
      default: true,
      organization: false,
      roles: {},
      groups: {},
      teams: {},
    },
  ];
  policies = [
    policy("organization", ""),
    policy("group", "contractors"),
    policy("team", "team_gone"),
  ];
  setCurrentOrganization("default");
  queryClient.clear();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

async function open(section: () => ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: section }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

async function openOverrides() {
  const person = userEvent.setup({ document });
  const view = await open(CapabilitiesSection);
  await person.click(
    await view.findByRole("button", { name: /Role and team overrides/ }),
  );
  const dialog = await view.findByRole("dialog");
  return { person, view, dialog };
}

test("a permission is turned on for a team picked by name, and the team's id is what is sent", async () => {
  const { person, view, dialog } = await openOverrides();

  await person.click(within(dialog).getByRole("combobox", { name: "Scope" }));
  // The organization's teams by name, then the rules that are still there for anything else.
  expect(
    (await view.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual([
    "Admins",
    "Members",
    "Team: Sales",
    "Team: Sales EMEA",
    "Team: Finance",
    "A team that no longer exists",
    "Group: contractors",
  ]);
  await person.click(view.getByRole("option", { name: "Team: Sales" }));
  expect(dialog.textContent).toContain("A team can only add.");
  expect(dialog.textContent).not.toContain("team_sales");

  await person.click(
    within(dialog).getByRole("combobox", {
      name: "Cloud browser for Team: Sales",
    }),
  );
  // A team's switch only turns a permission on: there is no Off to choose.
  expect(
    (await view.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Inherit", "Grant"]);
  await person.click(view.getByRole("option", { name: "Grant" }));

  await waitFor(() =>
    expect(writes).toEqual([
      {
        method: "PATCH",
        path: `${ORGANIZATION}/capabilities/cloudBrowser`,
        body: { teams: { team_sales: true } },
      },
    ]),
  );
  // The row behind the dialog counts it with the two that were there.
  await waitFor(() =>
    expect(
      view.getByRole("button", {
        name: /Role and team overrides/,
        // Behind the open dialog.
        hidden: true,
      }).textContent,
    ).toContain("3 set"),
  );
});

test("a directory group's rule from before teams is still listed and can be removed, and no new one can be made", async () => {
  const { person, view, dialog } = await openOverrides();

  await person.click(within(dialog).getByRole("combobox", { name: "Scope" }));
  await person.click(
    await view.findByRole("option", { name: "Group: contractors" }),
  );
  // Only the permission the group has a rule for: a new rule is made for a team.
  expect(
    within(dialog)
      .getAllByRole("combobox")
      .map((box) => box.getAttribute("aria-label")),
  ).toEqual(["Scope", "Cloud browser for Group: contractors"]);
  expect(
    within(dialog).getByRole("combobox", {
      name: "Cloud browser for Group: contractors",
    }).textContent,
  ).toContain("Grant");

  await person.click(
    within(dialog).getByRole("combobox", {
      name: "Cloud browser for Group: contractors",
    }),
  );
  await person.click(await view.findByRole("option", { name: "Inherit" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        method: "PATCH",
        path: `${ORGANIZATION}/capabilities/cloudBrowser`,
        body: { groups: { contractors: null } },
      },
    ]),
  );

  // With its last rule gone the group is no longer a scope to pick.
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Scope" }).textContent,
    ).toContain("Admins"),
  );
  await person.click(within(dialog).getByRole("combobox", { name: "Scope" }));
  expect(
    (await view.findAllByRole("option")).map((option) => option.textContent),
  ).not.toContain("Group: contractors");
});

test("a rule for a team that no longer exists says so and can be removed", async () => {
  const { person, view, dialog } = await openOverrides();

  await person.click(within(dialog).getByRole("combobox", { name: "Scope" }));
  await person.click(
    await view.findByRole("option", { name: "A team that no longer exists" }),
  );
  expect(dialog.textContent).not.toContain("team_gone");
  await person.click(
    within(dialog).getByRole("combobox", {
      name: "Cloud browser for A team that no longer exists",
    }),
  );
  await person.click(await view.findByRole("option", { name: "Inherit" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        method: "PATCH",
        path: `${ORGANIZATION}/capabilities/cloudBrowser`,
        body: { teams: { team_gone: null } },
      },
    ]),
  );
});

test("a network policy for a team is saved under team:<id> and listed by the team's name", async () => {
  const person = userEvent.setup({ document });
  const view = await open(NetworkSection);

  await person.click(
    await view.findByRole("button", { name: "Add a team policy" }),
  );
  const dialog = await view.findByRole("dialog", {
    name: "Team network policy",
  });
  await person.click(within(dialog).getByRole("combobox", { name: "Team" }));
  expect(
    (await view.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Sales", "Sales EMEA", "Finance"]);
  await person.click(view.getByRole("option", { name: "Sales EMEA" }));
  await person.type(within(dialog).getByLabelText("Allowlist"), "example.com");
  await person.click(within(dialog).getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(writes).toEqual([
      {
        method: "PUT",
        path: `${ORGANIZATION}/network-policies/team:team_emea`,
        body: {
          mode: "defaults_plus_allowlist",
          rules: [{ type: "domain", value: "example.com" }],
          locked: false,
        },
      },
    ]),
  );
  const row = await view.findByRole("button", { name: /^Team: Sales EMEA/ });
  expect(row.textContent).toContain("1 rule");
  expect(view.container.textContent).not.toContain("team_emea");
});

test("a directory group's network policy, and one for a team that no longer exists, are still listed and can be removed", async () => {
  const person = userEvent.setup({ document });
  const view = await open(NetworkSection);

  await person.click(
    await view.findByRole("button", { name: /^Group: contractors/ }),
  );
  await person.click(
    within(
      await view.findByRole("dialog", { name: "Group network policy" }),
    ).getByRole("button", { name: "Remove policy" }),
  );
  await waitFor(() =>
    expect(
      view.queryByRole("button", { name: /^Group: contractors/ }),
    ).toBeNull(),
  );

  expect(view.container.textContent).not.toContain("team_gone");
  await person.click(
    view.getByRole("button", { name: /^A team that no longer exists/ }),
  );
  await person.click(
    within(
      await view.findByRole("dialog", { name: "Team network policy" }),
    ).getByRole("button", { name: "Remove policy" }),
  );
  await waitFor(() =>
    expect(
      view.queryByRole("button", { name: /^A team that no longer exists/ }),
    ).toBeNull(),
  );

  expect(writes).toEqual([
    {
      method: "DELETE",
      path: `${ORGANIZATION}/network-policies/group:contractors`,
      body: undefined,
    },
    {
      method: "DELETE",
      path: `${ORGANIZATION}/network-policies/team:team_gone`,
      body: undefined,
    },
  ]);
});
