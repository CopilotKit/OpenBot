import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { getListCapabilitiesMockHandler } from "@/lib/api/generated/capabilities/capabilities.msw";
import type { ModelCatalogue, Team } from "@/lib/api/generated/model";
import { getGetModelCatalogueMockHandler } from "@/lib/api/generated/models/models.msw";
import { getListNetworkPoliciesMockHandler } from "@/lib/api/generated/network-policies/network-policies.msw";
import {
  getGetModelUsageMockHandler,
  getGetOrganizationSettingsMockHandler,
} from "@/lib/api/generated/organization-settings/organization-settings.msw";
import {
  getDeleteTeamModelsMockHandler,
  getGetTeamMockHandler,
  getGetTeamModelsMockHandler,
  getListTeamMembersMockHandler,
  getListTeamsMockHandler,
  getReplaceTeamModelsMockHandler,
} from "@/lib/api/generated/teams/teams.msw";
import { deploymentKeys } from "@/lib/deployment/queries";
import { modelCatalogueQueryOptions, modelKeys } from "@/lib/models/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { settingsBody } from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";
import { vendoredMarkFor } from "./vendored-marks";

/*
 * A team's models: the Models row on a team's page, its dialog, and the line on Admin, AI providers
 * naming the teams with a list of their own.
 *
 * The server is the spec's own: the MSW handlers Orval generates beside the client, at the API's
 * addresses, over one organization whose admin allows two of the three models its provider lists.
 * Each team's list is kept as the server would keep it, and every write is recorded as it arrived.
 * Marks resolve as the app resolves them, from the files vendored in `shared/marks`.
 */
mock.module("@/lib/marks", () => ({ markFor: vendoredMarkFor }));

// After the stub: a static import is hoisted and would load the real marks module first.
const { TeamDetailPage } = await import("@/components/teams/team-page");
const {
  ModelAllowlistSection,
  ModelUsageSection,
  organizationModels,
  teamModelsSummary,
} = await Promise.all([
  import("@/components/admin/controls/model-sections"),
  import("@/components/teams/team-models"),
]).then(([sections, models]) => ({ ...sections, ...models }));
const { DecisionCell, modelRefusalWords, WhatCell } = await import(
  "@/components/audit/audit-cells"
);
const { eventTypeFilter, REFUSED_EVENT_TYPES } = await import(
  "@/lib/audit/outcome"
);

const ORGANIZATION = "org_acme";

/** What the provider lists: newest first, with labels and makers, as `view=all` answers. */
const LISTING: ModelCatalogue = {
  provider: "openai",
  source: "openai",
  exposure: "allowed",
  default: "gpt-5.6-terra",
  listed: true,
  choosable: true,
  models: [
    { id: "gpt-6-sol", label: "GPT-6 Sol", vendor: "openai" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", vendor: "openai" },
    { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
  ],
};

/** The organization's allowlist: two of the three listed. GPT-4o is not one it allows. */
let allowlist: { enabled: boolean; models: string[] };
/** Each team's list as the server keeps it; absent for a team that sets none. */
let lists: Record<string, string[]>;
/** Whether the signed-in person is an owner or an admin of the organization. */
let admin: boolean;
/** Every write, as the server received it. */
let writes: {
  method: string;
  path: string;
  key: string | null;
  body: unknown;
}[];
/** Every read of the model catalogue, by the view it asked for. */
let catalogueReads: string[];
/** Every read of a team's list, by the team. */
let listReads: string[];

const team = (id: string, name: string): Team => ({
  id,
  name,
  description: null,
  parentTeamId: null,
  source: "openbot",
  memberCount: 0,
  role: null,
  canManage: admin,
  // The server's verdict that the caller is an owner or an admin: what lets them set a team's models.
  canMove: admin,
  canDelete: admin,
  createdAt: "2026-11-15T09:12:40.000Z",
});

const TEAMS = () => [
  team("team_sales", "Sales"),
  team("team_eng", "Engineering"),
];

const server = setupServer(
  getListTeamsMockHandler(() => ({
    teams: TEAMS(),
    canCreate: admin,
    nextCursor: null,
  })),
  getGetTeamMockHandler(({ params }) => {
    const found = TEAMS().find((one) => one.id === params.teamId);
    if (!found)
      throw HttpResponse.json(
        { title: "Not found", status: 404, detail: "Couldn't find that team." },
        { status: 404 },
      );
    return { team: found };
  }),
  getListTeamMembersMockHandler({ members: [], nextCursor: null }),
  getGetTeamModelsMockHandler(({ params }) => {
    listReads.push(params.teamId);
    const models = lists[params.teamId] ?? null;
    return {
      models,
      updatedBy: models ? "dana" : null,
      updatedAt: models ? "2026-11-23T10:04:11.000Z" : null,
    };
  }),
  getReplaceTeamModelsMockHandler(async ({ params, request }) => {
    if (!admin)
      throw HttpResponse.json(
        {
          type: "https://open.bot/errors/permission-denied",
          title: "Permission denied.",
          status: 403,
          detail:
            "Only an admin of this organization can change a team's models.",
          code: "PERMISSION_DENIED",
        },
        {
          status: 403,
          headers: { "content-type": "application/problem+json" },
        },
      );
    const { models } = await request.json();
    lists[params.teamId] = models;
    return {
      models,
      updatedBy: "dana",
      updatedAt: "2026-11-23T10:04:11.000Z",
    };
  }),
  getDeleteTeamModelsMockHandler(({ params }) => {
    delete lists[params.teamId];
  }),
  getGetModelCatalogueMockHandler(({ request }) => {
    const view = new URL(request.url).searchParams.get("view") ?? "offered";
    catalogueReads.push(view);
    if (view === "all") return LISTING;
    // What the signed-in person may pick: narrowed by the allowlist, and by their teams' lists.
    const mine = lists.team_sales ?? allowlist.models;
    return {
      ...LISTING,
      models: LISTING.models.filter((model) =>
        mine.includes(`openai/${model.id}`),
      ),
    };
  }),
  getGetOrganizationSettingsMockHandler(
    () =>
      settingsBody({
        settings: { modelAllowlist: allowlist },
        builtInModel: "openai/gpt-5.6-terra",
      }) as never,
  ),
  getListCapabilitiesMockHandler({ capabilities: [], nextCursor: null }),
  getListNetworkPoliciesMockHandler({ networkPolicies: [], nextCursor: null }),
  // What Bots ran on: one model the provider lists, and a remote Bot's own it doesn't.
  getGetModelUsageMockHandler({
    days: 30,
    summary: [
      {
        model: "openai/gpt-6-sol",
        source: "configured",
        runs: 6,
        refused: 0,
        people: 1,
        lastUsedAt: "2026-11-23T10:00:00.000Z",
      },
      {
        model: "acme/house-model",
        source: "observed",
        runs: 2,
        refused: 0,
        people: 1,
        lastUsedAt: "2026-11-23T10:00:00.000Z",
      },
    ],
    recent: [],
  }),
  // Nothing else is these screens' business.
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", async ({ request }) => {
  if (request.method === "GET") return;
  const text = await request.clone().text();
  writes.push({
    method: request.method,
    path: new URL(request.url).pathname,
    key: request.headers.get("idempotency-key"),
    body: text ? JSON.parse(text) : undefined,
  });
});

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  allowlist = {
    enabled: true,
    models: ["openai/gpt-6-sol", "openai/gpt-5.6-terra"],
  };
  lists = {};
  admin = true;
  writes = [];
  catalogueReads = [];
  setCurrentOrganization(ORGANIZATION);
  startAfresh();
});

/** Nothing read yet, on the team edition, as the app starts. */
function startAfresh() {
  listReads = [];
  queryClient.clear();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
}
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function Detail() {
  const { teamId } = useParams({ strict: false }) as { teamId: string };
  return <TeamDetailPage key={teamId} shell="admin" teamId={teamId} />;
}

/** A team's page, or Admin's allowed models, at its own address, with the team pages beside it. */
function open(start: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const page = (path: string, component: () => React.ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path, component });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [start] }),
    routeTree: rootRoute.addChildren([
      page("/admin/providers", ModelAllowlistSection),
      page("/admin/usage", () => <ModelUsageSection team />),
      page("/admin/activity", () => (
        <>
          <WhatCell event={MODELS_CHANGED} storedName />
          <DecisionCell event={MODELS_CHANGED} />
        </>
      )),
      page("/admin/activity/refused", () => (
        <>
          <WhatCell event={MODEL_REFUSED} storedName />
          <DecisionCell event={MODEL_REFUSED} />
        </>
      )),
      page("/admin/teams", () => null),
      page("/admin/teams/$teamId", Detail),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, person: userEvent.setup({ document }) };
}

/**
 * A change to a team's models on the trail, as the server records it: the team by its id and its
 * name then, and the models before (none) and after, one the provider no longer lists among them.
 */
const MODELS_CHANGED = {
  id: "evt_1",
  actorUserId: "dana",
  initiatorKind: "person",
  eventType: "team.models_changed",
  targetType: "team",
  targetId: "team_sales",
  payload: {
    team: "Sales",
    before: null,
    after: ["openai/gpt-6-sol", "openai/gpt-retired"],
  },
  createdAt: "2026-11-23T10:04:11.000Z",
};

/** A run refused for its model by the person's teams, as the server's gate records it. */
const MODEL_REFUSED = {
  id: "evt_2",
  actorUserId: "sam",
  initiatorKind: "person",
  eventType: "model.refused",
  targetType: "agent",
  targetId: "atlas",
  payload: {
    model: "openai/gpt-6-sol",
    source: "configured",
    rule: "team",
    teams: [{ id: "team_sales", name: "Sales" }],
  },
  createdAt: "2026-11-23T10:05:00.000Z",
};

const KEY = expect.stringMatching(/^[0-9a-f]{32}$/);
const MODELS_PATH = `/api/v2/organizations/${ORGANIZATION}/teams/team_sales/models`;

/** The Models row on a team's page, once its summary has arrived. */
async function modelsRow(view: ReturnType<typeof render>, says: string) {
  await view.findByText(says);
  const row = view.getByText("Models").closest("[data-slot=item]");
  if (!row) throw new Error("no Models row");
  return row as HTMLElement;
}

test("an admin gives a team one model, sees it named, adds another, then lets the team use everything again", async () => {
  // The person's picker has read what they may pick, as the composer does.
  await queryClient.fetchQuery(modelCatalogueQueryOptions());
  const { view, person } = open("/admin/teams/team_sales");
  const row = await modelsRow(view, "Everything the organization allows");
  expect(row.tagName).toBe("BUTTON");

  await person.click(row);
  const dialog = await view.findByRole("dialog", { name: "Models for Sales" });
  // What the organization allows, from its allowlist: never a model it doesn't allow.
  await within(dialog).findByRole("checkbox", { name: "Allow GPT-6 Sol" });
  expect(
    within(dialog)
      .getAllByRole("checkbox")
      .map((box) => box.getAttribute("aria-label")),
  ).toEqual(["Allow GPT-6 Sol", "Allow GPT-5.6 Terra"]);
  // Nothing to clear yet, and nothing ticked to save.
  expect(
    within(dialog).queryByRole("button", {
      name: "Use everything the organization allows",
    }),
  ).toBeNull();
  expect(
    within(dialog)
      .getByRole("button", { name: "Save" })
      .hasAttribute("disabled"),
  ).toBe(true);

  await person.click(
    within(dialog).getByRole("checkbox", { name: "Allow GPT-6 Sol" }),
  );
  await person.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "Models for Sales" })).toBeNull(),
  );
  expect(writes).toEqual([
    {
      method: "PUT",
      path: MODELS_PATH,
      key: KEY,
      body: { models: ["openai/gpt-6-sol"] },
    },
  ]);
  // One model is named by its label.
  await modelsRow(view, "GPT-6 Sol");
  // The picker's catalogue, which the server narrows by the person's teams, is stale at once, so
  // the composer asks again instead of offering what it read before for five minutes.
  expect(queryClient.getQueryState(modelKeys.catalogue)?.isInvalidated).toBe(
    true,
  );
  const picker = await queryClient.fetchQuery(modelCatalogueQueryOptions());
  expect(picker.models.map((model) => model.id)).toEqual(["gpt-6-sol"]);

  // A second model: the summary counts them.
  await person.click(await modelsRow(view, "GPT-6 Sol"));
  const again = await view.findByRole("dialog", { name: "Models for Sales" });
  const terra = await within(again).findByRole("checkbox", {
    name: "Allow GPT-5.6 Terra",
  });
  expect(
    within(again)
      .getByRole("checkbox", { name: "Allow GPT-6 Sol" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await person.click(terra);
  await person.click(within(again).getByRole("button", { name: "Save" }));
  await modelsRow(view, "2 models");
  expect(lists.team_sales).toEqual([
    "openai/gpt-6-sol",
    "openai/gpt-5.6-terra",
  ]);

  // Cleared: the team sets nothing again.
  await person.click(await modelsRow(view, "2 models"));
  const last = await view.findByRole("dialog", { name: "Models for Sales" });
  await person.click(
    await within(last).findByRole("button", {
      name: "Use everything the organization allows",
    }),
  );
  await modelsRow(view, "Everything the organization allows");
  expect(writes.at(-1)).toEqual({
    method: "DELETE",
    path: MODELS_PATH,
    key: KEY,
    body: undefined,
  });
  expect(lists.team_sales).toBeUndefined();
});

test("a model the organization no longer allows stays on the team's list greyed, says why, and comes off on save", async () => {
  lists = { team_sales: ["openai/gpt-6-sol", "openai/gpt-4o"] };
  const { view, person } = open("/admin/teams/team_sales");
  await person.click(
    await modelsRow(view, "2 models. One is no longer allowed."),
  );
  const dialog = await view.findByRole("dialog", { name: "Models for Sales" });
  const retired = await within(dialog).findByRole("checkbox", {
    // By its name: the provider still lists it, though the organization no longer allows it.
    name: "Allow GPT-4o",
  });
  expect(retired.getAttribute("aria-checked")).toBe("true");
  expect(retired.hasAttribute("data-disabled")).toBe(true);
  expect(
    within(dialog).getByText(
      "The organization no longer allows it, so nobody runs it. Saving takes it off.",
    ),
  ).toBeTruthy();
  await person.click(within(dialog).getByRole("button", { name: "Save" }));
  await modelsRow(view, "GPT-6 Sol");
  expect(writes.at(-1)?.body).toEqual({ models: ["openai/gpt-6-sol"] });
});

test("somebody who isn't an admin reads a team's models and can't change them", async () => {
  admin = false;
  lists = { team_sales: ["openai/gpt-5.6-terra"] };
  const { view } = open("/admin/teams/team_sales");
  // Their own catalogue names the one model.
  const row = await modelsRow(view, "GPT-5.6 Terra");
  expect(row.tagName).not.toBe("BUTTON");
  expect(view.queryByRole("button", { name: /Models/ })).toBeNull();
  // The organization's whole listing and allowlist are an admin's to read, and were never asked.
  expect(catalogueReads).not.toContain("all");

  cleanup();
  startAfresh();
  const other = open("/admin/teams/team_eng");
  await modelsRow(other.view, "Everything the organization allows");
});

test("the server's refusal is said in the dialog, in its own words", async () => {
  const { view, person } = open("/admin/teams/team_sales");
  await person.click(
    await modelsRow(view, "Everything the organization allows"),
  );
  const dialog = await view.findByRole("dialog", { name: "Models for Sales" });
  await person.click(
    await within(dialog).findByRole("checkbox", { name: "Allow GPT-6 Sol" }),
  );
  // Somebody took away their admin role while the dialog was open.
  admin = false;
  await person.click(within(dialog).getByRole("button", { name: "Save" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Only an admin of this organization can change a team's models.",
  );
});

test("Admin's allowed models name the teams with their own list, each linking to its page", async () => {
  lists = { team_sales: ["openai/gpt-6-sol"] };
  const { view, router, person } = open("/admin/providers");
  const sales = await view.findByRole("link", { name: "Sales" });
  expect(sales.getAttribute("href")).toBe("/admin/teams/team_sales");
  expect(view.queryByRole("link", { name: "Engineering" })).toBeNull();
  expect(
    view.getByText("Teams with their own list").closest("[data-slot=item]")
      ?.textContent,
  ).toContain(
    "Sales. People in them run only their team's models, within this list.",
  );
  await person.click(sales);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/teams/team_sales"),
  );
  cleanup();

  // No team with a list: nothing is said.
  lists = {};
  startAfresh();
  const none = open("/admin/providers");
  await none.view.findByText("Only allowed models");
  // Both teams' lists were read, and neither has one.
  await waitFor(() =>
    expect([...new Set(listReads)].toSorted()).toEqual([
      "team_eng",
      "team_sales",
    ]),
  );
  await settleReactWork();
  expect(none.view.queryByText("Teams with their own list")).toBeNull();
});

test("the dialog offers what the provider lists and the organization allows, and every listed model while the allowlist narrows nothing", async () => {
  // The allowlist names one listed model and one the provider no longer offers.
  allowlist = {
    enabled: true,
    models: ["openai/gpt-retired", "openai/gpt-5.6-terra"],
  };
  const offeredIn = async () => {
    const { view, person } = open("/admin/teams/team_sales");
    await person.click(
      await modelsRow(view, "Everything the organization allows"),
    );
    const dialog = await view.findByRole("dialog", {
      name: "Models for Sales",
    });
    await within(dialog).findAllByRole("checkbox");
    return within(dialog)
      .getAllByRole("checkbox")
      .map((box) => box.getAttribute("aria-label"));
  };
  expect(await offeredIn()).toEqual(["Allow GPT-5.6 Terra"]);

  // Only allowed models off: every model the provider lists, whatever the allowlist names.
  cleanup();
  startAfresh();
  allowlist = { enabled: false, models: ["openai/gpt-5.6-terra"] };
  expect(await offeredIn()).toEqual([
    "Allow GPT-6 Sol",
    "Allow GPT-5.6 Terra",
    "Allow GPT-4o",
  ]);
});

test("with nothing ticked, the dialog's hint offers only what its footer does", async () => {
  // No list yet: there is nothing to clear, so the hint says so instead of pointing at a button.
  const first = open("/admin/teams/team_sales");
  await first.person.click(
    await modelsRow(first.view, "Everything the organization allows"),
  );
  const empty = await first.view.findByRole("dialog", {
    name: "Models for Sales",
  });
  expect(
    await within(empty).findByText(
      "The team uses everything the organization allows. Tick models to limit it to those.",
    ),
  ).toBeTruthy();
  expect(
    within(empty).queryByRole("button", {
      name: "Use everything the organization allows",
    }),
  ).toBeNull();
  cleanup();

  // A list saved and every model unticked: the hint names the button beside Cancel.
  startAfresh();
  lists = { team_sales: ["openai/gpt-6-sol"] };
  const second = open("/admin/teams/team_sales");
  await second.person.click(await modelsRow(second.view, "GPT-6 Sol"));
  const saved = await second.view.findByRole("dialog", {
    name: "Models for Sales",
  });
  await second.person.click(
    await within(saved).findByRole("checkbox", { name: "Allow GPT-6 Sol" }),
  );
  expect(
    await within(saved).findByText(
      "Tick at least one model, or use everything the organization allows.",
    ),
  ).toBeTruthy();
  expect(
    within(saved).getByRole("button", {
      name: "Use everything the organization allows",
    }),
  ).toBeTruthy();
});

test("Activity names the team whose models changed, and its models before and after by their names", async () => {
  const { view } = open("/admin/activity");
  expect(await view.findByText("Change a team's models")).toBeTruthy();
  // The team, by the name it had then, under what was done.
  expect(view.getByText("Sales")).toBeTruthy();
  // Before and after, by the names the team's page lists them by; one no longer listed keeps its id.
  expect(
    await view.findByText("Now: GPT-6 Sol, openai/gpt-retired"),
  ).toBeTruthy();
  expect(
    view.getByText("Before: Everything the organization allows"),
  ).toBeTruthy();
});

test("Activity draws a run refused for its model as Blocked, says whose list left it out, and the Blocked view asks for it", async () => {
  const { view } = open("/admin/activity/refused");
  expect(await view.findByText("Use a model")).toBeTruthy();
  // The server records a refusal; it was drawn as "Allowed".
  expect(view.getByText("Blocked")).toBeTruthy();
  expect(view.queryByText("Allowed")).toBeNull();
  // The team whose list it wasn't on, by its name then.
  expect(await view.findByText("GPT-6 Sol isn't on Sales' list.")).toBeTruthy();
  // The Blocked view's filter is built from the same list.
  expect(eventTypeFilter(REFUSED_EVENT_TYPES)).toContain("model.refused");
  // The organization's list, and a rule this app doesn't know yet.
  const named = (name: string) =>
    name === "openai/gpt-6-sol" ? "GPT-6 Sol" : name;
  expect(
    modelRefusalWords(
      { model: "openai/gpt-6-sol", rule: "organization" },
      named,
    ),
  ).toBe("GPT-6 Sol isn't one the organization allows.");
  expect(modelRefusalWords({ model: "x/y", rule: "lock" }, named)).toBe(
    "x/y isn't allowed.",
  );
  // Several teams' lists, in plain English; and a row written before teams were named.
  const team = (name: string) => ({ id: name.toLowerCase(), name });
  expect(
    modelRefusalWords(
      {
        model: "openai/gpt-6-sol",
        rule: "team",
        teams: [team("Sales"), team("Engineering")],
      },
      named,
    ),
  ).toBe("GPT-6 Sol isn't on Sales' or Engineering's list.");
  expect(
    modelRefusalWords(
      {
        model: "openai/gpt-6-sol",
        rule: "team",
        teams: [team("Sales"), team("Engineering"), team("Support")],
      },
      named,
    ),
  ).toBe("GPT-6 Sol isn't on Sales', Engineering's or Support's list.");
  expect(
    modelRefusalWords({ model: "openai/gpt-6-sol", rule: "team" }, named),
  ).toBe("GPT-6 Sol isn't one their teams allow.");
});

test("models are named where a person reads them: Allowed models, Usage and the team's dialog", async () => {
  // AI providers' Allowed models row.
  const providers = open("/admin/providers");
  expect(
    await providers.view.findByText("GPT-6 Sol, GPT-5.6 Terra"),
  ).toBeTruthy();
  expect(providers.view.queryByText(/openai\/gpt-6-sol/)).toBeNull();
  cleanup();

  // Usage: a listed model by its name; a remote Bot's own, which no listing names, by its id.
  startAfresh();
  const usage = open("/admin/usage");
  expect(await usage.view.findByText("GPT-6 Sol")).toBeTruthy();
  expect(usage.view.getByText("acme/house-model")).toBeTruthy();
  expect(usage.view.queryByText("openai/gpt-6-sol")).toBeNull();
  cleanup();

  // The team's Models dialog: names only, no id under each.
  startAfresh();
  const { view, person } = open("/admin/teams/team_sales");
  await person.click(
    await modelsRow(view, "Everything the organization allows"),
  );
  const dialog = await view.findByRole("dialog", { name: "Models for Sales" });
  await within(dialog).findByRole("checkbox", { name: "Allow GPT-6 Sol" });
  expect(dialog.textContent).not.toContain("openai/");
});

test("what the organization allows, and what the row says, from real lists", () => {
  // `view=all` is every model the provider offers, never narrowed by the allowlist. Narrowed: what
  // the listing offers AND the allowlist names, in the listing's order, by `provider/model`. A model
  // the allowlist names that the provider no longer offers is not one to choose.
  expect(
    organizationModels(LISTING, {
      enabled: true,
      models: [
        "openai/gpt-retired",
        "openai/gpt-5.6-terra",
        "openai/gpt-6-sol",
      ],
    }),
  ).toEqual([
    { name: "openai/gpt-6-sol", label: "GPT-6 Sol", vendor: "openai" },
    { name: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", vendor: "openai" },
  ]);
  // Narrowed to nothing the provider offers: nothing to choose from.
  expect(
    organizationModels(LISTING, {
      enabled: true,
      models: ["openai/gpt-retired"],
    }),
  ).toBeNull();
  // Off, or on with nothing allowed: every listed model.
  for (const off of [
    { enabled: false, models: ["openai/gpt-4o"] },
    { enabled: true, models: [] },
  ])
    expect(organizationModels(LISTING, off)?.map((one) => one.name)).toEqual([
      "openai/gpt-6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-4o",
    ]);
  // The listing couldn't be read: nothing to choose from.
  expect(
    organizationModels(
      { ...LISTING, listed: false },
      { enabled: false, models: [] },
    ),
  ).toBeNull();

  const label = (name: string) =>
    name === "openai/gpt-6-sol" ? "GPT-6 Sol" : name;
  expect(teamModelsSummary(null, label)).toBe(
    "Everything the organization allows",
  );
  expect(teamModelsSummary(["openai/gpt-6-sol"], label)).toBe("GPT-6 Sol");
  expect(
    teamModelsSummary(["openai/gpt-6-sol", "openai/gpt-4o", "x/y"], label),
  ).toBe("3 models");
});
