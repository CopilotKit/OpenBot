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
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppsSections, SkillsSections } from "@/components/bot-profile/access";
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
  APP_SETUP_PATH,
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
 * A BOT NOBODY OWNS IS GIVEN APPS BY AN ADMIN, AND ITS SCREENS SAY SO.
 *
 * Found in dogfooding: a member asked the organization's shared General Assistant for Google
 * Calendar, connected it, and was then told the Bot's owner could give it. Nobody owns that Bot
 * (the API's `ownerless`), so only an admin can. The card in the conversation and the Bot's Apps
 * and Skills pages now tell a member only an admin can, and name the admins; a Bot a person owns
 * keeps the words it had.
 *
 * Drawn as the screens draw it, with the app's one query client, and the API answered at its own
 * addresses in its own shapes.
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

const BOT = "general";
const GMAIL = "composio-gmail";

const MEMBERS: OrganizationMember[] = [
  organizationMember("Sam Lee", "sam@northwind.test", "member"),
  organizationMember(null, "kit@northwind.test", "admin"),
  organizationMember("Priya Raman", "priya@northwind.test", "owner"),
];
const ADMINS = "Priya Raman (priya@northwind.test) or kit@northwind.test";

/**
 * The server for one person in the team edition: their role, whether apps are open, the Bot (nobody's
 * where `ownerless`, else somebody else's), and Gmail on it as `gmail`. `apps` is what the Bot's Apps
 * page lists, Gmail unless said.
 */
function serving(options: {
  role: "admin" | "member";
  open: boolean;
  ownerless: boolean;
  gmail?: AppAccess;
  apps?: AppAccess[];
}) {
  const { role, open, ownerless } = options;
  const gmail = options.gmail ?? notGiven;
  const apps = options.apps ?? [gmail];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.split("?")[0] ?? url;
    if (path === DEPLOYMENT_PATH) return Response.json({ edition: "team" });
    if (path === APPS_SETTING_PATH) return appsSettingResponse(!open);
    if (path === ME_PATH)
      return meResponse({ user: { id: "usr_me", role, name: "Me" } });
    if (path === MEMBERS_PATH) return membersResponse(url, MEMBERS);
    if (path === botPath(BOT))
      return Response.json({
        bot: {
          id: BOT,
          name: "General Assistant",
          mine: false,
          // An older server never sends it: a Bot somebody owns is sent without it.
          ...(ownerless ? { ownerless: true } : {}),
        },
      });
    if (path === APP_SETUP_PATH) return appSetupResponse();
    if (method === "GET" && path === botAppPath(BOT, GMAIL))
      return botAppResponse(gmail);
    if (method === "GET" && path === botAppsPath(BOT))
      return botAppsResponse(apps);
    if (path.startsWith(botGrantsPath(BOT))) return botGrantsResponse({});
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
}

/** Gmail, switched on and open to Bot owners, which this Bot hasn't been given. */
const notGiven = appAccess({
  key: GMAIL,
  state: "not_granted",
  granted: false,
  requestKind: "grant",
  ownerGrants: "any",
});

/** Gmail, which nobody in the organization has added yet. */
const notAdded = appAccess({
  key: GMAIL,
  state: "disabled",
  unavailable: "absent",
  granted: false,
  requestKind: "enable",
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
  message: "General Assistant hasn't been given Gmail.",
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

/** The card's words once it has drawn them, and its buttons by name. */
async function card(view: ReturnType<typeof drawn>, words: string) {
  const found = await waitFor(() => {
    const drawnCard = view.container.querySelector("[data-app-access]");
    if (!drawnCard?.getAttribute("data-state"))
      throw new Error("not drawn yet");
    return drawnCard as HTMLElement;
  });
  await waitFor(() => expect(found.textContent).toContain(words), {
    timeout: 3_000,
  });
  await settleReactWork();
  return {
    text: found.textContent ?? "",
    buttons: [...found.querySelectorAll("button")].map(
      (button) => button.getAttribute("aria-label") ?? button.textContent,
    ),
  };
}

const PROFILE = (ownerless: boolean): AgentProfile => ({
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: BOT,
  name: "General Assistant",
  title: "",
  roleDescription: "Helps everyone.",
  avatarSeed: "g",
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
  ...(ownerless ? { ownerless: true } : {}),
});

/** The Apps page's or Skills page's words once they say `words`. */
async function page(view: ReturnType<typeof drawn>, words: string) {
  await waitFor(() => expect(view.container.textContent).toContain(words), {
    timeout: 3_000,
  });
  await settleReactWork();
  return view.container.textContent ?? "";
}

describe("a member, on a Bot nobody owns, is told only an admin can give it apps", () => {
  test("the card, apps open: only an admin can give it, by name, and Request access asks", async () => {
    serving({ role: "member", open: true, ownerless: true });
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    const { text, buttons } = await card(
      view,
      `This Bot hasn't been given Gmail. Only an admin can give it: ${ADMINS}.`,
    );
    expect(text).not.toMatch(/owner/i);
    expect(buttons).toEqual(["Request access to Gmail"]);
  });

  test("the card, apps locked down: only an admin, never its owner", async () => {
    serving({ role: "member", open: false, ownerless: true });
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    const { text, buttons } = await card(
      view,
      `This Bot hasn't been given Gmail. Only an admin can give it: ${ADMINS}.`,
    );
    expect(text).not.toMatch(/owner/i);
    expect(buttons).toEqual(["Request access to Gmail"]);
  });

  test("the card for an app nobody added: only an admin can give it, and they may connect their own", async () => {
    serving({ role: "member", open: true, ownerless: true, gmail: notAdded });
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    const { text, buttons } = await card(
      view,
      `Only an admin can give Gmail to General Assistant: ${ADMINS}. Request access to ask for it. You can connect your own account now too.`,
    );
    expect(text).not.toMatch(/owner/i);
    expect(buttons).toEqual(["Connect Gmail", "Request access to Gmail"]);
  });

  test("the card for actions it wasn't given: only an admin can give it that", async () => {
    serving({ role: "member", open: true, ownerless: true });
    const view = drawn(<AppAccessCard prompt={toolsPrompt} />);
    const { text } = await card(
      view,
      `General Assistant can't send an email yet. Only an admin can give it that: ${ADMINS}.`,
    );
    expect(text).not.toMatch(/owner/i);
  });

  test("the Apps page row: only an admin can give it, by name", async () => {
    serving({ role: "member", open: true, ownerless: true });
    const view = drawn(<AppsSections agent={PROFILE(true)} />);
    const text = await page(
      view,
      `This Bot hasn't been given Gmail. Only an admin can give it: ${ADMINS}.`,
    );
    expect(text).not.toMatch(/owner/i);
  });

  test("the Apps and Skills pages with nothing on them: only an admin can give it some", async () => {
    serving({ role: "member", open: true, ownerless: true, apps: [] });
    const view = drawn(
      <>
        <AppsSections agent={PROFILE(true)} />
        <SkillsSections agent={PROFILE(true)} />
      </>,
    );
    const text = await page(
      view,
      `Only an admin can give it apps: ${ADMINS}. Until then this Bot can only talk with you.`,
    );
    expect(text).toContain(`Only an admin can give it skills: ${ADMINS}.`);
    expect(text).not.toMatch(/owner/i);
  });
});

describe("an admin, on a Bot nobody owns, keeps their own button and words", () => {
  test("the card says what is missing, and the admin gives it", async () => {
    serving({ role: "admin", open: true, ownerless: true });
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    const { text, buttons } = await card(
      view,
      "This Bot hasn't been given Gmail yet.",
    );
    expect(text).not.toMatch(/owner|only an admin/i);
    expect(buttons).toEqual(["Give Gmail to General Assistant"]);
  });
});

describe("a Bot somebody owns keeps the words it had", () => {
  test("the card, apps open: its owner or an admin can give it", async () => {
    serving({ role: "member", open: true, ownerless: false });
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    const { buttons } = await card(
      view,
      "Only General Assistant's owner or an admin can give it Gmail. Request access to ask for it. You can connect your own account now too.",
    );
    expect(buttons).toEqual(["Connect Gmail", "Request access to Gmail"]);
  });

  test("the card, apps locked down: its owner can give it, or an admin", async () => {
    serving({ role: "member", open: false, ownerless: false });
    const view = drawn(<AppAccessCard prompt={prompt()} />);
    await card(
      view,
      `This Bot hasn't been given Gmail. Its owner can give it, or an admin: ${ADMINS}.`,
    );
  });

  test("the card for actions it wasn't given: its owner or an admin", async () => {
    serving({ role: "member", open: true, ownerless: false });
    const view = drawn(<AppAccessCard prompt={toolsPrompt} />);
    await card(
      view,
      "General Assistant can't send an email yet. Only its owner or an admin can give it that. Request access to ask for it.",
    );
  });

  test("the Apps and Skills pages with nothing on them: its owner can give it some", async () => {
    serving({ role: "member", open: true, ownerless: false, apps: [] });
    const view = drawn(
      <>
        <AppsSections agent={PROFILE(false)} />
        <SkillsSections agent={PROFILE(false)} />
      </>,
    );
    const text = await page(
      view,
      "Its owner can give it some. Until then this Bot can only talk with you.",
    );
    expect(text).toContain("The Bot's owner or an admin gives it skills.");
  });
});
