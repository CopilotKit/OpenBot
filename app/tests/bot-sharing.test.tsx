import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import { SharingSections } from "@/components/bot-profile/sharing";
import type { AgentProfile } from "@/lib/agents/queries";
import type { Team } from "@/lib/api/generated/model";
import type { TeamBot } from "@/lib/team-bots";
import { meResponse } from "./accounts-api";
import {
  answerTeamBots,
  noContent,
  publishedTeamBotResponse,
  type SentRequest,
  sentRequest,
  teamBotAssignmentPath,
  teamBotOf,
  teamBotPath,
} from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Sharing page: its owner publishes it to everyone in the organization or to people and
 * teams, and unpublishes it; an admin assigns it to a team or to everyone. Each is offered only to
 * whoever the server lets do it. Teams are chosen from the organization's own, never typed.
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

const BOT: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const PUBLISHED: TeamBot = teamBotOf("expenses", "Expenses", {
  title: "Finance",
  roleDescription: "Receipts.",
});

const writes: SentRequest[] = [];

/** One of the organization's teams, as the API lists it to somebody who is not in it. */
const team = (id: string, name: string): Team => ({
  id,
  name,
  description: null,
  parentTeamId: null,
  source: "openbot",
  memberCount: 3,
  role: null,
  canManage: false,
  canMove: false,
  canDelete: false,
  createdAt: "2026-11-15T09:12:40.000Z",
});
const SALES = team("Tm4Qx8LpV2nWc7RbY1sKd0Ze", "Sales");
const SUPPORT = team("Sp9Lk3QwE7rTy1UiO5pAs2Df", "Support");
const TEAMS_PATH = "/api/v2/organizations/default/teams";
const MEMBERS_PATH = "/api/v2/organizations/default/members";

/** The organization's members, as the API lists them: who a Bot can be published to. */
const MEMBERS = [
  { id: "ana", email: "a@example.test", name: "Ana Ruiz" },
  { id: "bo", email: "bo@example.test", name: "Bo Lind" },
].map((one) => ({
  ...one,
  image: null,
  role: "member" as const,
  joinedAt: "2026-11-01T09:00:00.000Z",
  removable: true,
  assignableRoles: [],
}));

/**
 * The published Bots, the organization's teams and the person asking. Every write is answered as
 * the API answers it.
 */
function serving(
  teamBots: TeamBot[],
  role: "admin" | "user",
  teams: Team[] = [SALES, SUPPORT],
) {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const sent = sentRequest(input, init);
    if (sent.method !== "GET") {
      writes.push(sent);
      return sent.method === "DELETE"
        ? noContent()
        : publishedTeamBotResponse(PUBLISHED);
    }
    const listed = answerTeamBots(input, init, teamBots);
    if (listed) return listed;
    if (sent.path.split("?")[0] === TEAMS_PATH)
      return Response.json({ teams, canCreate: false, nextCursor: null });
    // The organization's members, searched as somebody to publish it to is typed.
    if (sent.path.split("?")[0] === MEMBERS_PATH) {
      const typed = (
        new URL(sent.path, "http://openbot.invalid").searchParams.get(
          "search",
        ) ?? ""
      ).toLowerCase();
      return Response.json({
        members: MEMBERS.filter((one) => one.email.includes(typed)),
        nextCursor: null,
      });
    }
    if (url.includes("/shared-use/bot/")) return Response.json({ apps: [] });
    if (url.includes("/shared-use")) return Response.json({ requests: [] });
    return meResponse({
      user: { id: "me", role, email: "me@example.test", name: "Me" },
    });
  }) as unknown as typeof fetch;
}

function draw(agent: AgentProfile) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <SharingSections agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("an unpublished Bot of yours offers to publish it", async () => {
  serving([], "user");
  const view = draw(BOT);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /Audience/ }));
  const dialog = await view.findByRole("dialog", { name: "Publish" });
  expect(within(dialog).getByRole("button", { name: "Publish" })).toBeTruthy();
  // Everybody is "everyone in the organization", never a team: a team is one group inside it.
  expect(
    within(dialog).getByRole("combobox", { name: /^Published to/ }).textContent,
  ).toContain("Everyone in the organization");
  expect(view.queryByRole("button", { name: "Unpublish" })).toBeNull();
});

test("publishing to everyone in the organization sends no people and no teams", async () => {
  serving([], "user");
  const view = draw(BOT);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /Audience/ }));
  const dialog = await view.findByRole("dialog", { name: "Publish" });
  await user.click(within(dialog).getByRole("button", { name: "Publish" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        path: teamBotPath("expenses"),
        method: "PUT",
        key: expect.stringMatching(/^[0-9a-f]{32}$/),
        body: { audience: "team", emails: [], groups: [], teams: [] },
      },
    ]),
  );
});

test("publishing to a team ticks it in the organization's teams and sends the team's id", async () => {
  serving([], "user");
  const view = draw(BOT);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /Audience/ }));
  await user.click(view.getByRole("combobox", { name: /^Published to/ }));
  await user.click(
    await view.findByRole("option", { name: "Specific people or teams" }),
  );
  // The organization's teams, each to tick. Nothing is typed: there is no group field.
  const teams = await view.findByRole("group", { name: "Teams" });
  expect(
    within(teams)
      .getAllByRole("checkbox")
      .map((box) => box.getAttribute("aria-checked")),
  ).toEqual(["false", "false"]);
  expect(view.queryByLabelText("Groups")).toBeNull();
  expect(view.queryByText("Directory groups")).toBeNull();
  await user.click(within(teams).getByRole("checkbox", { name: "Sales" }));
  // A person is found among the organization's members as their name or address is typed.
  await user.type(view.getByRole("combobox", { name: "People" }), "a@");
  await user.click(await view.findByRole("option", { name: /^Ana Ruiz,/ }));
  expect(
    within(
      view.getByRole("list", { name: "People it is published to" }),
    ).getByText("a@example.test"),
  ).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Publish" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        path: teamBotPath("expenses"),
        method: "PUT",
        key: expect.stringMatching(/^[0-9a-f]{32}$/),
        body: {
          audience: "people",
          emails: ["a@example.test"],
          groups: [],
          teams: [SALES.id],
        },
      },
    ]),
  );
});

test("a Bot published to teams names them, and its directory groups from before are kept, not typed", async () => {
  serving(
    [
      {
        ...PUBLISHED,
        audience: "people",
        people: ["a@example.test"],
        groups: ["finance"],
        teams: [SALES.id],
      },
    ],
    "user",
  );
  const view = draw(BOT);
  // By name, never by id.
  expect(
    await view.findByText("To a@example.test, Sales, group finance"),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain(SALES.id);
  expect(view.getByText("1 person, 1 team, 1 group")).toBeTruthy();

  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /Audience/ }));
  const teams = await view.findByRole("group", { name: "Teams" });
  expect(
    within(teams)
      .getByRole("checkbox", { name: "Sales" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  // The group it already reaches is said, and there is nowhere to type another.
  expect(
    view.getByText(
      "It stays published to finance. To reach more people, choose a team.",
    ),
  ).toBeTruthy();
  expect(view.queryByLabelText("Groups")).toBeNull();

  // Adding a team keeps the group and the person.
  await user.click(within(teams).getByRole("checkbox", { name: "Support" }));
  await user.click(view.getByRole("button", { name: "Update" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        path: teamBotPath("expenses"),
        method: "PUT",
        key: expect.stringMatching(/^[0-9a-f]{32}$/),
        body: {
          audience: "people",
          emails: ["a@example.test"],
          groups: ["finance"],
          teams: [SALES.id, SUPPORT.id],
        },
      },
    ]),
  );
});

test("with no teams yet, the publish dialog says where they are made", async () => {
  serving([], "user", []);
  const view = draw(BOT);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /Audience/ }));
  await user.click(view.getByRole("combobox", { name: /^Published to/ }));
  await user.click(
    await view.findByRole("option", { name: "Specific people or teams" }),
  );
  expect(
    await view.findByText(
      "There are no teams yet. An admin creates them on the Teams page.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("checkbox")).toBeNull();
});

test("a published Bot of yours can be updated, unpublished and its link copied", async () => {
  serving([PUBLISHED], "user");
  const view = draw(BOT);
  expect(await view.findByRole("button", { name: "Unpublish" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Copy link" })).toBeTruthy();
  // Published to everybody, which a person reads as the organization.
  expect(view.getByText("To everyone in the organization")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/whole team/i);
  // Not an admin: no assignment.
  expect(view.queryByRole("button", { name: /Assign to a team/ })).toBeNull();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /Audience/ }));
  expect(await view.findByRole("button", { name: "Update" })).toBeTruthy();
});

test("unpublishing a Bot of yours is a delete at its Team Bot address", async () => {
  serving([PUBLISHED], "user");
  const view = draw(BOT);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Unpublish" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        path: teamBotPath("expenses"),
        method: "DELETE",
        key: expect.stringMatching(/^[0-9a-f]{32}$/),
        body: undefined,
      },
    ]),
  );
});

test("Publish is offered for a Bot of yours missing from the Team Bots list, and never for someone else's", async () => {
  // Another of your Bots is published; this one isn't, so it is yours to publish.
  serving([teamBotOf("receipts", "Receipts")], "user");
  const view = draw(BOT);
  expect(await view.findByRole("heading", { name: "Publish" })).toBeTruthy();
  expect(view.getByText("Only you can use it.")).toBeTruthy();
  cleanup();

  serving([], "user");
  const theirs = draw({ ...BOT, mine: false, canManage: false });
  expect(await theirs.findByText("Not published")).toBeTruthy();
  expect(theirs.queryByRole("heading", { name: "Publish" })).toBeNull();
  expect(theirs.queryByRole("button", { name: /Audience/ })).toBeNull();
});

test("an admin assigns a published Bot to a team chosen from the organization's, but can't publish someone else's", async () => {
  serving([{ ...PUBLISHED, mine: false }], "admin");
  const view = draw({ ...BOT, mine: false });
  expect(await view.findByText("Not assigned to anyone")).toBeTruthy();
  expect(view.queryByRole("button", { name: /Audience/ })).toBeNull();
  expect(view.queryByRole("button", { name: "Update" })).toBeNull();
  expect(view.queryByRole("button", { name: "Unpublish" })).toBeNull();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /Assign to a team/ }));
  const dialog = await view.findByRole("dialog", { name: "Assign Expenses" });
  // Nothing to assign until somebody is chosen, and nothing to type.
  const assign = within(dialog).getByRole("button", { name: "Assign" });
  expect(assign.hasAttribute("disabled")).toBe(true);
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  await user.click(within(dialog).getByRole("combobox", { name: "Assign to" }));
  expect(
    (await view.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Everyone in the organization", "Sales", "Support"]);
  await user.click(view.getByRole("option", { name: "Sales" }));
  await user.click(assign);
  await waitFor(() =>
    expect(writes).toEqual([
      {
        // A team is assigned as `team:<id>`, beside a directory group's name.
        path: teamBotAssignmentPath("expenses", `team:${SALES.id}`),
        method: "PUT",
        key: expect.stringMatching(/^[0-9a-f]{32}$/),
        body: undefined,
      },
    ]),
  );
});

test("an admin assigns a published Bot to everyone in the organization", async () => {
  serving(
    [{ ...PUBLISHED, mine: false, assignedGroups: [`team:${SALES.id}`] }],
    "admin",
  );
  const view = draw({ ...BOT, mine: false });
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", { name: /Assign to a team/ }),
  );
  const dialog = await view.findByRole("dialog", { name: "Assign Expenses" });
  await user.click(within(dialog).getByRole("combobox", { name: "Assign to" }));
  // The team it is already assigned to is not offered again.
  expect(
    (await view.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Everyone in the organization", "Support"]);
  await user.click(
    view.getByRole("option", { name: "Everyone in the organization" }),
  );
  await user.click(within(dialog).getByRole("button", { name: "Assign" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        path: teamBotAssignmentPath("expenses", "*"),
        method: "PUT",
        key: expect.stringMatching(/^[0-9a-f]{32}$/),
        body: undefined,
      },
    ]),
  );
});

test("an admin sees who a Bot is assigned to by name, and removes a team and a directory group from before", async () => {
  serving(
    [
      {
        ...PUBLISHED,
        mine: false,
        assignedGroups: ["*", `team:${SALES.id}`, "finance"],
      },
    ],
    "admin",
  );
  const view = draw({ ...BOT, mine: false });
  // Everybody is the organization, a team is its name, and a group from before says it is one.
  expect(await view.findByText("Everyone in the organization")).toBeTruthy();
  expect(await view.findByText("Sales")).toBeTruthy();
  expect(view.getByText("Group finance")).toBeTruthy();
  expect(document.body.textContent).not.toContain(SALES.id);
  expect(document.body.textContent).not.toMatch(/whole team/i);
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Remove Sales" }));
  await user.click(view.getByRole("button", { name: "Remove Group finance" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        path: teamBotAssignmentPath("expenses", `team:${SALES.id}`),
        method: "DELETE",
        key: expect.stringMatching(/^[0-9a-f]{32}$/),
        body: undefined,
      },
      {
        path: teamBotAssignmentPath("expenses", "finance"),
        method: "DELETE",
        key: expect.stringMatching(/^[0-9a-f]{32}$/),
        body: undefined,
      },
    ]),
  );
});

test("a public Bot that is not published says everyone in the organization can use it, never 'not published'", async () => {
  serving([], "user");
  const view = draw({ ...BOT, visibility: "public" });
  expect(
    await view.findByText("Everyone in the organization can use it"),
  ).toBeTruthy();
  expect(view.getByText("It's public.")).toBeTruthy();
  // Its owner can still publish it, which never says only those it's published to can use it.
  expect(
    view.getByText("It's public already. Publish it to get a link to share."),
  ).toBeTruthy();
  expect(view.getByText("Choose who to publish it to")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Only the people and teams/);
  expect(document.body.textContent).not.toMatch(/on OpenBot/);
  expect(document.body.textContent).not.toMatch(/Not published/);
  expect(view.queryByText(/Only you can use it/)).toBeNull();
});

test("someone else's unpublished private Bot is not described as yours alone", async () => {
  serving([], "admin");
  const view = draw({ ...BOT, mine: false });
  expect(await view.findByText("Not published")).toBeTruthy();
  expect(view.queryByText(/Only you can use it/)).toBeNull();
});
