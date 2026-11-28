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
import { SkillPage } from "@/components/manage/skill-page";
import type { Team } from "@/lib/api/generated/model";
import {
  getGetSkillTeamGrantsMockHandler,
  getReplaceSkillTeamGrantsMockHandler,
} from "@/lib/api/generated/skills/skills.msw";
import { getListTeamsMockHandler } from "@/lib/api/generated/teams/teams.msw";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { answerAppsApi } from "./apps-api";
import { answerBotsList } from "./bots-api";
import { settleReactWork } from "./settle-react-work";
import { SKILLS_PATH, skillsResponse } from "./skills-api";
import {
  KEY,
  recordWrites,
  type SentWrite,
  skillTeamGrantsPath,
  team,
} from "./team-grants-api";

/**
 * The Teams row on a skill's page in Admin: which teams the skill is granted to, by name, and the
 * dialog that changes them.
 *
 * The page is the real one, on the app's one query client. The teams and the skill's team grants
 * are answered by the handlers Orval generates from the spec, at the API's own addresses; the rest
 * of what the page reads is answered by each area's helper.
 */

/** Which teams each skill is granted to, as the server holds it, by the skill's slug. */
let granted: Record<string, string[]>;
let teams: Team[];
let writes: SentWrite[];
/** Every read, method and path. */
let reads: string[];

const server = setupServer(
  getListTeamsMockHandler(() => ({ teams, canCreate: true, nextCursor: null })),
  getGetSkillTeamGrantsMockHandler(({ params }) => ({
    teams: granted[params.skillId] ?? [],
  })),
  getReplaceSkillTeamGrantsMockHandler(async ({ params, request }) => {
    const body = await request.json();
    granted[params.skillId] = body.teams;
    return { teams: body.teams };
  }),
  // Everything else the page reads: the skills, the Bots that may offer one, the apps' tools.
  http.all("*", ({ request }) => {
    const init = { method: request.method };
    const path = new URL(request.url).pathname;
    return (
      (path === SKILLS_PATH && request.method === "GET"
        ? skillsResponse([
            {
              slug: "triage",
              title: "Triage the inbox",
              summary: "Sorts new mail by what needs an answer",
              grantedTo: ["bot-ada"],
            },
          ])
        : undefined) ??
      answerBotsList(request.url, init, {
        visible: [{ id: "bot-ada", name: "Ada" }],
        hidden: [],
      }) ??
      answerAppsApi(request.url, init, { servers: [] }) ??
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
  granted = { triage: ["team_support"] };
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

/** The Triage skill's page, as somebody in this edition opens it. */
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
      component: () => <SkillPage slug="triage" />,
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

test("a skill's Teams row names the teams it is granted to, and Save grants it to the teams ticked", async () => {
  const { view, person } = open();
  const row = await teamsRow(view);
  expect(row.textContent).toContain("Support");
  expect(row.textContent).not.toContain("Sales");
  // The skill's slug is the id the address takes.
  expect(reads).toContain(`GET ${skillTeamGrantsPath("triage")}`);

  await person.click(row);
  const dialog = await view.findByRole("dialog", {
    name: "Teams that can use Triage the inbox",
  });
  const box = (name: string) =>
    within(dialog).getByRole("checkbox", { name }) as HTMLElement;
  expect(box("Support").getAttribute("aria-checked")).toBe("true");
  expect(box("Sales").getAttribute("aria-checked")).toBe("false");

  await person.click(box("Finance"));
  expect(writes).toEqual([]);
  await person.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  expect(writes).toEqual([
    {
      method: "PUT",
      path: skillTeamGrantsPath("triage"),
      key: KEY,
      body: { teams: ["team_support", "team_finance"] },
    },
  ]);
  // The row reads what the server now holds.
  await waitFor(async () =>
    expect((await teamsRow(view)).textContent).toContain("Support, Finance"),
  );
});

test("a granted team that no longer exists is named as one, and unticking it removes it", async () => {
  granted = { triage: ["team_deleted"] };
  const { view, person } = open();
  const row = await teamsRow(view);
  expect(row.textContent).toContain("A team that no longer exists");
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
      path: skillTeamGrantsPath("triage"),
      key: KEY,
      body: { teams: [] },
    },
  ]);
  // Granted to no team now, and the row says that.
  await waitFor(async () =>
    expect((await teamsRow(view)).textContent).toContain(
      "It isn't given to any team.",
    ),
  );
});

test("the personal edition has no Teams row and never asks which teams a skill is granted to", async () => {
  const { view } = open("personal");
  await view.findByRole("heading", { level: 1, name: "Triage the inbox" });
  await view.findByText("Ada");
  expect(view.queryByText("Teams")).toBeNull();
  expect(reads).not.toContain(`GET ${skillTeamGrantsPath("triage")}`);
});
