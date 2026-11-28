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
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { SetupSections } from "@/components/bot-profile/setup";
import { SharingSections } from "@/components/bot-profile/sharing";
import { BotRoster } from "@/components/bots/bot-roster";
import type { AgentProfile } from "@/lib/agents/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import {
  DEPLOYMENT_PATH,
  deploymentBody,
  MY_CAPABILITIES_PATH,
  myCapabilitiesResponse,
} from "./admin-settings-api";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotAttention, answerBotsList, answerTeamBots } from "./bots-api";
import { CONVERSATIONS_PATH, TASKS_PATH } from "./conversations-api";
import { CHECK_IN_ITEMS_PATH, pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/**
 * What a person reads about who can use a Bot, and why a Bot can't have a computer of its own, in
 * the three places OpenBot runs:
 *
 * - OpenBot Cloud, where each person has an organization of their own and one computer
 *   (`hostedSignIn`), and is its only member;
 * - an organization of several people on an OpenBot a company runs itself;
 * - the personal edition, one person on their own computer.
 *
 * The Bot OpenBot seeds into each organization (General Assistant) is included with OpenBot, never
 * "shared with you", and a public Bot is for everyone in the organization, never "everyone on
 * OpenBot". The server is faked at the API's own addresses, in the API's shapes.
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
beforeEach(() => setCurrentOrganization("default"));

const ORGANIZATIONS_PATH = "/api/v2/people/me/organizations";
const MEMBERS_PATH = "/api/v2/organizations/default/members";

/** The General Assistant OpenBot seeds into a new organization: public, nobody's, from the package. */
const GENERAL_ASSISTANT: AgentProfile = {
  id: "agent_7c1e4a52-general",
  name: "General Assistant",
  title: "Powered by OpenBot",
  roleDescription: "Helps with anything.",
  avatarSeed: "general-assistant",
  visibility: "public",
  hidden: false,
  pinned: false,
  systemOwned: false,
  packageBotId: "general-assistant",
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  canManage: true,
  mine: false,
  assignedToMe: false,
  builtIn: true,
  runsOnOpenBotModel: true,
  keyFromOpenBot: true,
  isolationActive: false,
  isolationOffReason: null,
};

/** A Bot a teammate made and made public. */
const TEAMMATES: AgentProfile = {
  ...GENERAL_ASSISTANT,
  id: "agent_teammates",
  name: "Expense Review",
  avatarSeed: "expense-review",
  packageBotId: null,
  canManage: false,
};

type Place = {
  edition: "team" | "personal";
  hostedSignIn: boolean;
  organizationName: string;
  members: number;
};

/** OpenBot Cloud: Sam's own organization, with nobody else in it, and one computer for him. */
const CLOUD_ALONE: Place = {
  edition: "team",
  hostedSignIn: true,
  organizationName: "Sam's organization",
  members: 1,
};

/** An OpenBot a company runs itself, with three people in its organization. */
const TEAM: Place = {
  edition: "team",
  hostedSignIn: false,
  organizationName: "Acme",
  members: 3,
};

const PERSONAL: Place = {
  edition: "personal",
  hostedSignIn: false,
  organizationName: "Ada's organization",
  members: 1,
};

function member(index: number) {
  return {
    id: `person-${index}`,
    email: `person${index}@example.test`,
    name: `Person ${index}`,
    image: null,
    role: index === 0 ? "owner" : "member",
    joinedAt: "2026-11-01T09:00:00.000Z",
    removable: index !== 0,
    assignableRoles: [],
  };
}

/** The server for one place, where no Bot can have a computer of its own. */
function serving(place: Place, bots: AgentProfile[]) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("?")[0];
    if (path === DEPLOYMENT_PATH)
      return Response.json({
        ...deploymentBody({
          edition: place.edition,
          builtInBots: true,
          isolatedBots: false,
        }),
        hostedSignIn: place.hostedSignIn,
      });
    if (path === ORGANIZATIONS_PATH)
      return Response.json({
        organizations: [
          {
            id: "default",
            slug: "own",
            name: place.organizationName,
            personal: place.hostedSignIn,
            role: "owner",
            active: true,
          },
        ],
        canCreate: true,
        nextCursor: null,
      });
    if (path === MEMBERS_PATH) {
      const limit = Number(
        new URL(url, "http://openbot.invalid").searchParams.get("limit") ?? 100,
      );
      const everyone = Array.from({ length: place.members }, (_, i) =>
        member(i),
      );
      return Response.json({
        members: everyone.slice(0, limit),
        nextCursor: everyone.length > limit ? "next" : null,
      });
    }
    if (path === MY_CAPABILITIES_PATH)
      return myCapabilitiesResponse({
        capabilities: { isolatedComputers: true },
      });
    const listed =
      answerTeamBots(input, init, []) ??
      answerBotAttention(input, init, { bots: [] }) ??
      answerBotsList(input, init, { visible: bots, hidden: [] });
    if (listed) return listed;
    if (pathOf(url) === CHECK_IN_ITEMS_PATH)
      return Response.json({ checkInItems: [], nextCursor: null });
    if (path === TASKS_PATH)
      return Response.json({ tasks: [], nextCursor: null });
    if (path === CONVERSATIONS_PATH)
      return Response.json({ conversations: [], nextCursor: null });
    return approvalInboxResponse(input) ?? new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function draw(screen: () => ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: screen,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/bots/$agentId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const headings = (view: ReturnType<typeof draw>) =>
  [...view.container.querySelectorAll("h2")].map(
    (heading) => heading.textContent,
  );

/** What the person reads on the page, for the words no screen may say. */
const shown = () => document.body.textContent ?? "";

// The Bots list.

test("Cloud, alone: the General Assistant is included with OpenBot, not shared with you", async () => {
  serving(CLOUD_ALONE, [GENERAL_ASSISTANT]);
  const view = draw(() => <BotRoster />);
  await view.findByText("General Assistant");
  expect(headings(view)).toEqual(["Included with OpenBot"]);
  expect(shown()).not.toMatch(/shared with you/i);
});

test("a team: a teammate's Bot is shared with you, and the General Assistant is included with OpenBot", async () => {
  serving(TEAM, [GENERAL_ASSISTANT, TEAMMATES]);
  const view = draw(() => <BotRoster />);
  await view.findByText("Expense Review");
  expect(headings(view)).toEqual(["Shared with you", "Included with OpenBot"]);
});

test("personal: the assistant is included with OpenBot, as before", async () => {
  serving(PERSONAL, [{ ...GENERAL_ASSISTANT, systemOwned: true }]);
  const view = draw(() => <BotRoster />);
  await view.findByText("General Assistant");
  expect(headings(view)).toEqual(["Included with OpenBot"]);
});

// A starter Bot's Sharing page. The personal edition has none.

test("Cloud, alone: a public Bot says only you can use it, never 'not published' or 'everyone on OpenBot'", async () => {
  serving(CLOUD_ALONE, [GENERAL_ASSISTANT]);
  const view = draw(() => <SharingSections agent={GENERAL_ASSISTANT} />);
  expect(await view.findByText("Only you can use it")).toBeTruthy();
  expect(
    view.getByText(
      "It's public, and you're the only member of Sam's organization.",
    ),
  ).toBeTruthy();
  expect(shown()).not.toMatch(/on OpenBot/);
  expect(shown()).not.toMatch(/not published/i);
});

test("a team: a public Bot says everyone in the organization, by name, can use it", async () => {
  serving(TEAM, [GENERAL_ASSISTANT]);
  const view = draw(() => <SharingSections agent={GENERAL_ASSISTANT} />);
  expect(await view.findByText("Everyone in Acme can use it")).toBeTruthy();
  expect(view.getByText("It's public.")).toBeTruthy();
  expect(shown()).not.toMatch(/on OpenBot/);
  expect(shown()).not.toMatch(/not published/i);
});

// The starter Bot's Setup: who can see it, and its Isolated row.

test("Cloud, alone: Setup says only you for now, and why a Bot has no computer of its own, with OpenBot for Business", async () => {
  serving(CLOUD_ALONE, [GENERAL_ASSISTANT]);
  const view = draw(() => <SetupSections agent={GENERAL_ASSISTANT} />);
  expect(
    await view.findByText(
      "Everyone in Sam's organization can find and use it. Right now that's only you.",
    ),
  ).toBeTruthy();
  expect(
    view.getByText(
      "OpenBot Cloud gives each person one computer, not one per Bot.",
    ),
  ).toBeTruthy();
  expect(
    view.getByRole("button", {
      name: "Give each Bot its own computer with OpenBot for Business.",
    }),
  ).toBeTruthy();
  expect(shown()).not.toMatch(/This OpenBot can't give a Bot/);
  expect(shown()).not.toMatch(/on OpenBot can/);
});

test("a team on an OpenBot it runs itself: Setup keeps today's Isolated wording, with no link", async () => {
  serving(TEAM, [GENERAL_ASSISTANT]);
  const view = draw(() => <SetupSections agent={GENERAL_ASSISTANT} />);
  expect(
    await view.findByText("Everyone in Acme can find and use it."),
  ).toBeTruthy();
  expect(
    view.getByText("This OpenBot can't give a Bot a computer of its own."),
  ).toBeTruthy();
  expect(
    view.queryByRole("button", { name: /OpenBot for Business/ }),
  ).toBeNull();
  expect(shown()).not.toMatch(/OpenBot Cloud/);
});

test("personal: Setup has no Visibility or Isolated row, only the OpenBot for Business link", async () => {
  serving(PERSONAL, [{ ...GENERAL_ASSISTANT, systemOwned: true }]);
  const view = draw(() => (
    <SetupSections agent={{ ...GENERAL_ASSISTANT, systemOwned: true }} />
  ));
  expect(
    await view.findByRole("button", {
      name: "Give each Bot its own computer with OpenBot for Business.",
    }),
  ).toBeTruthy();
  expect(view.queryByText("Isolated")).toBeNull();
  expect(view.queryByText("Visibility")).toBeNull();
  expect(shown()).not.toMatch(/OpenBot Cloud/);
});
