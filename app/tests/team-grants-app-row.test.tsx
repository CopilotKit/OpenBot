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
import { PluginPage } from "@/components/manage/plugin-page";
import {
  getGetAppTeamGrantsMockHandler,
  getReplaceAppTeamGrantsMockHandler,
} from "@/lib/api/generated/bot-grants/bot-grants.msw";
import type { Team } from "@/lib/api/generated/model";
import { getListTeamsMockHandler } from "@/lib/api/generated/teams/teams.msw";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { answerAppsApi } from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequestsResponse,
} from "./bot-grants-api";
import { answerBotsList } from "./bots-api";
import { connectionPage, MY_CONNECTIONS_PATH } from "./connections-api";
import { settleReactWork } from "./settle-react-work";
import {
  appTeamGrantsPath,
  KEY,
  recordWrites,
  type SentWrite,
  team,
} from "./team-grants-api";

/**
 * The Teams row on an app's page in Admin: which teams the app is granted to, by name, and the
 * dialog that changes them.
 *
 * The page is the real one, on the app's one query client. The teams and the app's team grants are
 * answered by the handlers Orval generates from the spec, at the API's own addresses; the rest of
 * what the page reads is answered by each area's helper.
 */

/** Which teams each app is granted to, as the server holds it. */
let granted: Record<string, string[]>;
let teams: Team[];
let writes: SentWrite[];
/** Every read, method and path. */
let reads: string[];

const server = setupServer(
  getListTeamsMockHandler(() => ({ teams, canCreate: true, nextCursor: null })),
  getGetAppTeamGrantsMockHandler(({ params }) => ({
    teams: granted[params.appId] ?? [],
  })),
  getReplaceAppTeamGrantsMockHandler(async ({ params, request }) => {
    const body = await request.json();
    granted[params.appId] = body.teams;
    return { teams: body.teams };
  }),
  // Everything else the page reads: the app itself, its catalogue entry, Bots, accounts, requests.
  http.all("*", ({ request }) => {
    const init = { method: request.method };
    const path = new URL(request.url).pathname;
    return (
      answerAppsApi(request.url, init, {
        servers: [
          {
            id: "notion",
            title: "Notion",
            summary: "Pages and databases.",
            provenance: "first-party",
            hasCredential: true,
            dynamicClient: true,
          },
        ],
        catalogue: [{ key: "notion", title: "Notion", auth: "user-oauth" }],
      }) ??
      answerBotsList(request.url, init, { visible: [], hidden: [] }) ??
      (path === MY_CONNECTIONS_PATH ? connectionPage([]) : undefined) ??
      (path === APP_ACCESS_REQUESTS_PATH
        ? appAccessRequestsResponse([])
        : undefined) ??
      new HttpResponse(null, { status: 404 })
    );
  }),
);
server.events.on("request:start", ({ request }) => {
  if (request.method === "GET")
    reads.push(`GET ${new URL(request.url).pathname}`);
});

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
  writes = recordWrites(server);
});
beforeEach(() => {
  writes.length = 0;
  reads = [];
  teams = [
    team("team_sales", "Sales"),
    team("team_support", "Support"),
    team("team_finance", "Finance"),
  ];
  granted = { notion: ["team_sales"] };
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** Notion's page in Admin, as an admin of this edition opens it. */
function open(edition: "team" | "personal" = "team") {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <PluginPage pluginKey="notion" />,
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, person: userEvent.setup({ document }) };
}

/** The Teams row, once it has its answer. */
async function teamsRow(view: ReturnType<typeof render>) {
  const title = await view.findByText("Teams", { selector: "[data-slot]" });
  return title.closest("[data-slot=item]") as HTMLElement;
}

test("an app's Teams row names the teams it is granted to, and Save grants it to the teams ticked", async () => {
  const { view, person } = open();
  const row = await teamsRow(view);
  expect(row.textContent).toContain("Sales");
  expect(row.textContent).not.toContain("Support");
  expect(reads).toContain(`GET ${appTeamGrantsPath("notion")}`);

  await person.click(row);
  const dialog = await view.findByRole("dialog", {
    name: "Teams that can use Notion",
  });
  // Every team of the organization, with the ones it is granted to ticked.
  const box = (name: string) =>
    within(dialog).getByRole("checkbox", { name }) as HTMLElement;
  expect(box("Sales").getAttribute("aria-checked")).toBe("true");
  expect(box("Support").getAttribute("aria-checked")).toBe("false");
  expect(box("Finance").getAttribute("aria-checked")).toBe("false");

  await person.click(box("Support"));
  // Nothing is sent until Save.
  expect(writes).toEqual([]);
  await person.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  expect(writes).toEqual([
    {
      method: "PUT",
      path: appTeamGrantsPath("notion"),
      key: KEY,
      body: { teams: ["team_sales", "team_support"] },
    },
  ]);
  // The row reads what the server now holds.
  await waitFor(async () =>
    expect((await teamsRow(view)).textContent).toContain("Sales, Support"),
  );
});

test("a granted team that no longer exists is named as one, and unticking it removes it", async () => {
  granted = { notion: ["team_sales", "team_deleted"] };
  const { view, person } = open();
  const row = await teamsRow(view);
  expect(row.textContent).toContain("Sales, A team that no longer exists");
  // Never by its id.
  expect(document.body.textContent).not.toContain("team_deleted");

  await person.click(row);
  const dialog = await view.findByRole("dialog");
  const gone = within(dialog).getByRole("checkbox", {
    name: "A team that no longer exists",
  });
  expect(gone.getAttribute("aria-checked")).toBe("true");
  await person.click(gone);
  await person.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  expect(writes).toEqual([
    {
      method: "PUT",
      path: appTeamGrantsPath("notion"),
      key: KEY,
      body: { teams: ["team_sales"] },
    },
  ]);
  await waitFor(async () =>
    expect((await teamsRow(view)).textContent).not.toContain(
      "A team that no longer exists",
    ),
  );
  expect((await teamsRow(view)).textContent).toContain("Sales");
});

test("an app granted to no team says so, and an organization with no teams says how the first one arrives", async () => {
  granted = {};
  teams = [];
  const { view, person } = open();
  const row = await teamsRow(view);
  expect(row.textContent).toContain("It isn't given to any team.");

  await person.click(row);
  const dialog = await view.findByRole("dialog");
  expect(
    within(dialog).getByText(
      "There are no teams yet. Create one on the Teams page.",
    ),
  ).toBeTruthy();
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
  // Cancel sends nothing.
  await person.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([]);
});

test("the personal edition has no Teams row and never asks which teams an app is granted to", async () => {
  const { view } = open("personal");
  await view.findByRole("heading", { level: 1, name: "Notion" });
  await view.findByText("Turned on");
  expect(view.queryByText("Teams")).toBeNull();
  expect(reads).not.toContain(`GET ${appTeamGrantsPath("notion")}`);
});
