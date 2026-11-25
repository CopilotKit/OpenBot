import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ConnectPrompt } from "@openbot/shared/connect-prompt";
import { QueryClientProvider } from "@tanstack/react-query";
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
import { AppsSections } from "@/components/bot-profile/access";
import { AppAccessCard } from "@/components/channels/app-access-card";
import type { AgentProfile } from "@/lib/agents/queries";
import type { OrganizationMember } from "@/lib/api/generated/model";
import type { AppAccess } from "@/lib/app-access/queries";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  APPS_SETTING_PATH,
  appsSettingResponse,
  DEPLOYMENT_PATH,
} from "./admin-settings-api";
import { appAccess } from "./app-access-fixture";
import {
  APP_ACCESS_REQUESTS_PATH,
  APP_SETUP_PATH,
  appAccessRequest,
  appAccessRequestResponse,
  appSetupResponse,
  botAppPath,
  botAppResponse,
  botAppsPath,
  botAppsResponse,
  botGrantsPath,
  botGrantsResponse,
} from "./bot-grants-api";
import { botPath } from "./bots-api";
import { connectionPage, MY_CONNECTIONS_PATH } from "./connections-api";
import {
  MEMBERS_PATH,
  membersResponse,
  organizationMember,
} from "./organizations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * WHO THE ADMIN IS, wherever a member is told only an admin can take the step.
 *
 * Reported in dogfooding: a member trying to connect a service was told "Only an admin can give it"
 * and had no way to know which human that was. Now the sentence names the organization's admins,
 * owners first, by name and address, a few of them and then how many more; and after Request access
 * the status says who it went to. An admin is offered the step itself, so never reads any of it.
 *
 * Drawn as the screens draw it, the app's one query client, and the API answered at its own
 * addresses in its own shapes: the members list paged as the API pages it.
 */

beforeAll(() =>
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/channel/one" }),
);
beforeEach(() => queryClient.clear());
const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const BOT = "expenses";
const GMAIL = "composio-gmail";

/** Members who aren't admins, enough that the list runs past one page of 100. */
const filler = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) =>
    organizationMember(
      `Member ${from + index}`,
      `member${from + index}@northwind.test`,
      "member",
    ),
  );

/**
 * Northwind, in the order its people joined: an admin before the owner, a role this app doesn't
 * know (never named as an admin), an admin with no name, and an admin on the second page.
 */
const NORTHWIND: OrganizationMember[] = [
  organizationMember("Ines Duarte", "ines@northwind.test", "admin"),
  ...filler(1, 10),
  organizationMember("Priya Raman", "priya@northwind.test", "owner"),
  organizationMember("Billie Shaw", "billie@northwind.test", "billing"),
  organizationMember("Morgan Reyes", "morgan@northwind.test", "admin"),
  ...filler(11, 60),
  organizationMember(null, "kit@northwind.test", "admin"),
  ...filler(71, 40),
  organizationMember("Tom Avery", "tom@northwind.test", "admin"),
];
const MANY_NAMED =
  "Priya Raman (priya@northwind.test), Ines Duarte (ines@northwind.test), Morgan Reyes (morgan@northwind.test) and 2 more";

/** A smaller organization: one owner, one admin with no name. */
const SMALL: OrganizationMember[] = [
  organizationMember("Sam Lee", "sam@northwind.test", "member"),
  organizationMember(null, "kit@northwind.test", "admin"),
  organizationMember("Priya Raman", "priya@northwind.test", "owner"),
];

type Sent = { method: string; url: string };

/**
 * The server for one person in the team edition (or `edition`): their role, the Bot, Gmail on the
 * Bot as `gmail` (which a request turns to requested), and the organization's `members`.
 */
function serving(options: {
  role: "owner" | "admin" | "member";
  gmail: AppAccess;
  members?: OrganizationMember[];
  edition?: "team" | "personal";
  /** Whether apps are open. Locked down unless said: naming the admins is locked down's. */
  open?: boolean;
}) {
  const { role, members = NORTHWIND, edition = "team" } = options;
  const sent: Sent[] = [];
  let gmail = options.gmail;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push({ method, url });
    const path = url.split("?")[0] ?? url;
    if (path === DEPLOYMENT_PATH) return Response.json({ edition });
    if (path === APPS_SETTING_PATH)
      return appsSettingResponse(options.open !== true);
    if (path === ME_PATH)
      return meResponse({ user: { id: "usr_me", role, name: "Me" } });
    if (path === MEMBERS_PATH) return membersResponse(url, members);
    if (path === botPath(BOT))
      return Response.json({ bot: { id: BOT, name: "Expenses" } });
    if (path === APP_SETUP_PATH) return appSetupResponse();
    if (method === "GET" && path === botAppPath(BOT, GMAIL))
      return botAppResponse(gmail);
    if (method === "GET" && path === botAppsPath(BOT))
      return botAppsResponse([gmail]);
    if (path.startsWith(botGrantsPath(BOT))) return botGrantsResponse({});
    if (method === "POST" && path === APP_ACCESS_REQUESTS_PATH) {
      const filed = appAccessRequest({ id: "req_gmail", agentId: BOT });
      gmail = {
        ...gmail,
        request: { id: filed.id, kind: "grant", createdAt: filed.createdAt },
      };
      return appAccessRequestResponse(filed);
    }
    if (path.startsWith(MY_CONNECTIONS_PATH)) return connectionPage([]);
    if (url.includes("/handoff"))
      return Response.json({
        handoff: {
          enabled: false,
          canGrant: false,
          reachable: [],
          grantable: false,
        },
      });
    return Response.json({});
  }) as unknown as typeof fetch;
  return sent;
}

const askedForMembers = (sent: Sent[]) =>
  sent.some((each) => each.url.split("?")[0] === MEMBERS_PATH);

/**
 * Gmail on the Bot, which this Bot hasn't been given, and which an admin kept to admins: only an
 * admin can give it. (Open to owners, the default, its owner could give it too.)
 */
const notGiven = appAccess({
  key: GMAIL,
  state: "not_granted",
  granted: false,
  requestKind: "grant",
  ownerGrants: "admin",
});

function drawn(children: ReactNode) {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <ConversationProvider ask={() => undefined}>
        {children}
      </ConversationProvider>
    ),
  });
  const appPage = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => null,
  });
  const grants = createRoute({
    getParentRoute: () => root,
    path: "/admin/plugins/$key/bots/$agentId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, appPage, grants]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const prompt = (overrides: Partial<ConnectPrompt> = {}): ConnectPrompt => ({
  serverId: GMAIL,
  title: "Gmail",
  message: "Expenses hasn't been given Gmail.",
  agentId: BOT,
  reason: "access",
  blocked: true,
  ...overrides,
});

const toolsPrompt = prompt({
  reason: "tools",
  actions: [`${GMAIL}/GMAIL_SEND_EMAIL`],
  need: "To send an email.",
});

const card = (view: ReturnType<typeof drawn>) =>
  waitFor(() => {
    const found = view.container.querySelector("[data-app-access]");
    if (!found?.getAttribute("data-state")) throw new Error("not drawn yet");
    return found as HTMLElement;
  });

const BOT_PROFILE: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: BOT,
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
  visibility: "public",
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
  canManage: false,
  mine: false,
};

const appsRow = async (view: ReturnType<typeof drawn>) => {
  await view.findByText("Apps it can use");
  return (await waitFor(() => {
    const found = view.container.querySelector(`[data-app="${GMAIL}"]`);
    if (!found) throw new Error("not drawn yet");
    return found;
  })) as HTMLElement;
};

describe("a member is told who the admins are", () => {
  test("on the app card: owners first, by name and address, then how many more", async () => {
    const sent = serving({ role: "member", gmail: notGiven });
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    const found = await card(view);
    await waitFor(() =>
      expect(found.textContent).toContain(
        `This Bot hasn't been given Gmail. Only an admin can give it: ${MANY_NAMED}.`,
      ),
    );
    // Every page of the members was read, 100 at a time.
    const pages = sent.filter((each) => each.url.startsWith(MEMBERS_PATH));
    expect(pages.map((each) => each.url)).toEqual([
      `${MEMBERS_PATH}?limit=100`,
      `${MEMBERS_PATH}?limit=100&cursor=100`,
    ]);
  });

  test("after Request access: Requested, and who it was sent to", async () => {
    serving({ role: "member", gmail: notGiven });
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    fireEvent.click(
      await view.findByRole("button", { name: "Request access to Gmail" }),
    );
    // "Requested" stays its own words, and who it went to is said under it.
    await view.findByText(
      "Sent to Priya Raman, Ines Duarte, Morgan Reyes and 2 more.",
      { exact: true },
    );
    expect(view.getByText("Requested", { exact: true })).toBeTruthy();
    expect(view.getByRole("status").textContent).toBe(
      "RequestedSent to Priya Raman, Ines Duarte, Morgan Reyes and 2 more.",
    );
    expect(
      view.getByRole("button", { name: "Withdraw request for Gmail" }),
    ).toBeTruthy();
  });

  test("on the card for actions the Bot wasn't given, a nameless admin by address", async () => {
    serving({ role: "member", gmail: notGiven, members: SMALL });
    const view = drawn(<AppAccessCard prompt={toolsPrompt} />);
    const found = await card(view);
    await waitFor(() =>
      expect(found.textContent).toContain(
        "Expenses can't send an email yet. Only an admin can give it that: Priya Raman (priya@northwind.test) or kit@northwind.test.",
      ),
    );
  });

  test("on the Bot's Apps row, and after Request access there", async () => {
    serving({ role: "member", gmail: notGiven, members: SMALL });
    const view = drawn(<AppsSections agent={BOT_PROFILE} />);
    const row = await appsRow(view);
    await waitFor(() =>
      expect(row.textContent).toContain(
        "This Bot hasn't been given Gmail. Only an admin can give it: Priya Raman (priya@northwind.test) or kit@northwind.test.",
      ),
    );
    fireEvent.click(
      within(row).getByRole("button", { name: "Request access to Gmail" }),
    );
    await within(row).findByText(
      "Sent to Priya Raman and kit@northwind.test.",
      { exact: true },
    );
    expect(within(row).getByText("Requested", { exact: true })).toBeTruthy();
  });

  test("an app not turned on yet names them too", async () => {
    serving({
      role: "member",
      gmail: appAccess({
        key: GMAIL,
        state: "disabled",
        unavailable: "absent",
        granted: false,
        requestKind: "enable",
      }),
      members: SMALL,
    });
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    const found = await card(view);
    await waitFor(() =>
      expect(found.textContent).toContain(
        "Gmail isn't turned on yet. Only an admin can turn it on: Priya Raman (priya@northwind.test) or kit@northwind.test.",
      ),
    );
  });

  test("apps open: an app not added yet names nobody, and the members are never read", async () => {
    const sent = serving({
      role: "member",
      gmail: appAccess({
        key: GMAIL,
        state: "disabled",
        unavailable: "absent",
        granted: false,
        requestKind: "enable",
      }),
      members: SMALL,
      open: true,
    });
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    const found = await card(view);
    await waitFor(() =>
      expect(found.textContent).toContain(
        "Gmail isn't connected yet. Connect it, and this Bot's owner can give it to the Bot.",
      ),
    );
    await settleReactWork();
    expect(found.textContent).not.toMatch(/admin|northwind/i);
    expect(askedForMembers(sent)).toBe(false);
  });

  test("while the members can't be read, the sentence stands on its own", async () => {
    serving({ role: "member", gmail: notGiven });
    const fetched = global.fetch;
    let refused = 0;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith(MEMBERS_PATH)) return fetched(input, init);
      refused += 1;
      return Response.json({ error: "nope" }, { status: 500 });
    }) as typeof fetch;
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    const found = await card(view);
    await waitFor(() => expect(refused).toBeGreaterThan(0));
    await settleReactWork();
    expect(found.textContent).toContain(
      "This Bot hasn't been given Gmail. Only an admin can give it.",
    );
    expect(found.textContent).not.toContain("northwind.test");
  });
});

describe("an admin is never told to ask one", () => {
  for (const role of ["admin", "owner"] as const) {
    test(`an ${role} on the card, the actions card and the Apps row`, async () => {
      const sent = serving({ role, gmail: notGiven });
      const view = drawn(
        <>
          <AppAccessCard prompt={prompt()} />
          <AppAccessCard prompt={toolsPrompt} />
          <AppsSections agent={BOT_PROFILE} />
        </>,
      );
      const row = await appsRow(view);
      await view.findAllByRole("button", { name: "Give Gmail to Expenses" });
      await waitFor(() =>
        expect(row.textContent).toContain("This Bot hasn't been given Gmail"),
      );
      const cards = [
        ...view.container.querySelectorAll("[data-app-access]"),
      ].map((each) => each.textContent ?? "");
      expect(cards).toHaveLength(2);
      for (const text of [...cards, row.textContent ?? ""]) {
        expect(text).not.toMatch(/only an admin|ask an admin/i);
        expect(text).not.toContain("northwind.test");
      }
      await settleReactWork();
      expect(askedForMembers(sent)).toBe(false);
    });
  }
});

test("the personal edition has no admins to name, and never asks for them", async () => {
  const sent = serving({
    role: "owner",
    edition: "personal",
    gmail: appAccess({
      key: GMAIL,
      state: "disabled",
      unavailable: "scheme_unreadable",
      granted: false,
    }),
  });
  const view = drawn(<AppAccessCard prompt={prompt()} />);
  const found = await card(view);
  await waitFor(() =>
    expect(found.textContent).toContain(
      "Gmail isn't fully set up yet. Set it up to finish.",
    ),
  );
  await settleReactWork();
  expect(found.textContent).not.toContain("northwind.test");
  expect(askedForMembers(sent)).toBe(false);
});
