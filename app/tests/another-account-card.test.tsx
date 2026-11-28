import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  anotherAccountAnswer,
  connectAppRefusal,
  readAnotherAccountPrompt,
  readConnectPrompt,
  SHOW_APP_ACCESS_TOOL,
} from "@openbot/shared/connect-prompt";
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
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { ServerToolLine } from "@/components/channels/chat-transcript";
import { setCurrentOrganization } from "@/lib/organizations/current";
import type { BrokeredAccountRecord } from "@/lib/plugins/queries";
import { appAccess } from "./app-access-fixture";
import { botAppResponse } from "./bot-grants-api";
import {
  accountsPage,
  connectionResponse,
  myAccountPath,
  myConnectionPath,
  startResponse,
} from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * Asked to connect one more account at an app the person already connected ("Can I connect you to
 * my personal email as well?"), a Bot puts up one card that starts that account's sign-in, as
 * Connections' Connect another account does, and then says which account Bots use, with Make
 * default where that isn't the new one. Reported in dogfooding: the Bot could only show Gmail's
 * card, reading "Gmail is ready now", and three how-to guides.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let originalOpen: typeof window.open | undefined;
beforeAll(() => {
  originalOpen = window.open;
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalOpen) window.open = originalOpen;
});

const APP = "composio-gmail";
const WORK: BrokeredAccountRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  identity: "sam@work.example",
  label: "sam@work.example",
  isDefault: true,
  connectedAt: "2026-11-01T09:00:00.000Z",
};
const PERSONAL: BrokeredAccountRecord = {
  id: "00000000-0000-4000-8000-000000000002",
  identity: "sam@home.example",
  label: "sam@home.example",
  isDefault: false,
  connectedAt: "2026-11-25T09:00:00.000Z",
};

const answer = anotherAccountAnswer({
  serverId: APP,
  title: "Gmail",
  agentId: "assistant",
  held: 1,
  message:
    "The card in front of the person offers Connect another account. Say so in one sentence.",
});

/** The server: Gmail's accounts as `state.accounts` says now, and every write the card sends. */
function serving(state: { accounts: BrokeredAccountRecord[] }) {
  const writes: { path: string; body: unknown }[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://openbot.test").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      writes.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path === myConnectionPath(APP, "connect"))
        return startResponse({
          authorizationUrl: "https://gmail.test/consent",
        });
      if (path === myAccountPath(APP, PERSONAL.id, "make-default")) {
        state.accounts = state.accounts.map((account) => ({
          ...account,
          isDefault: account.id === PERSONAL.id,
        }));
        return new Response(null, { status: 204 });
      }
      return Response.json({});
    }
    if (path.includes("/apps/"))
      return botAppResponse(
        appAccess({ key: APP, displayName: "Gmail", connect: "oauth" }),
      );
    if (path === myConnectionPath(APP, "accounts"))
      return accountsPage(state.accounts);
    if (path === myConnectionPath(APP))
      return connectionResponse({ serverId: APP, canAddAccount: true });
    return Response.json({});
  }) as unknown as typeof fetch;
  return writes;
}

/** Where the sign-in tab was sent, recorded rather than opened. */
function claimingTabs() {
  const sent: string[] = [];
  window.open = (() => ({
    opener: null,
    closed: false,
    location: { replace: (to: string) => sent.push(to) },
    close: () => {},
    focus: () => {},
  })) as unknown as typeof window.open;
  return sent;
}

function mount(children: ReactNode) {
  setCurrentOrganization("default");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{children}</>,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { client });
}

const card = (view: ReturnType<typeof mount>) =>
  waitFor(() => {
    const found = view.container.querySelector("[data-another-account]");
    if (!found?.getAttribute("data-state")) throw new Error("not drawn yet");
    return found as HTMLElement;
  });

test("the answer is a card of its own, which an older reader leaves as a line", () => {
  expect(readAnotherAccountPrompt(answer)).toEqual({
    serverId: APP,
    title: "Gmail",
    agentId: "assistant",
    held: 1,
    message:
      "The card in front of the person offers Connect another account. Say so in one sentence.",
  });
  // Never the app's own card, which would say Gmail is ready now.
  expect(readConnectPrompt(answer)).toBeNull();
  expect(
    readAnotherAccountPrompt(
      connectAppRefusal({ serverId: APP, title: "Gmail", message: "" }),
    ),
  ).toBeNull();
});

test("one card starts the second account's sign-in, then offers Make default for it", async () => {
  const state = { accounts: [WORK] };
  const writes = serving(state);
  const sent = claimingTabs();
  const view = mount(
    <ServerToolLine name={SHOW_APP_ACCESS_TOOL} result={answer} />,
  );

  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("ready-to-connect");
  expect(drawn.textContent).toContain(
    "Connect another Gmail account. Bots keep using sam@work.example until you make another the default.",
  );
  expect(drawn.textContent).not.toContain("ready now");
  expect(
    view.container.querySelectorAll("[data-another-account]"),
  ).toHaveLength(1);
  expect(view.container.querySelector("[data-app-access]")).toBeNull();

  fireEvent.click(
    await view.findByRole("button", { name: "Connect another Gmail account" }),
  );
  await waitFor(() => expect(sent).toEqual(["https://gmail.test/consent"]));
  // The same press as Connections' Connect another account.
  expect(writes[0]).toEqual({
    path: myConnectionPath(APP, "connect"),
    body: { returnTo: "connections", anotherAccount: true },
  });
  expect(await view.findByText("Finish in the tab that opened.")).toBeTruthy();

  // Signed in with the second account in the other tab.
  state.accounts = [WORK, PERSONAL];
  await act(() => view.client.invalidateQueries());
  await waitFor(async () =>
    expect((await card(view)).getAttribute("data-state")).toBe("connected"),
  );
  expect((await card(view)).textContent).toContain(
    "sam@home.example is connected. Bots use sam@work.example unless you ask for sam@home.example.",
  );
  expect(view.queryByText("Finish in the tab that opened.")).toBeNull();

  fireEvent.click(
    await view.findByRole("button", {
      name: "Make sam@home.example the default",
    }),
  );
  await waitFor(async () =>
    expect((await card(view)).textContent).toContain(
      "sam@home.example is connected. Bots use it by default.",
    ),
  );
  expect(writes.at(-1)?.path).toBe(
    myAccountPath(APP, PERSONAL.id, "make-default"),
  );
  expect(
    view.queryByRole("button", { name: /Make .* the default/ }),
  ).toBeNull();
});

test("drawn again after the account was connected, it says so and offers no second sign-in", async () => {
  serving({ accounts: [WORK, PERSONAL] });
  const view = mount(
    <ServerToolLine name={SHOW_APP_ACCESS_TOOL} result={answer} />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("connected");
  expect(
    view.queryByRole("button", { name: "Connect another Gmail account" }),
  ).toBeNull();
});

// Found in the live journey: an account the app names by no address started the sentence lower case.
test("an account with no address starts its sentence with a capital", async () => {
  serving({
    accounts: [
      { ...WORK, identity: null, label: "account 1" },
      { ...PERSONAL, identity: null, label: "account 2" },
    ],
  });
  const view = mount(
    <ServerToolLine name={SHOW_APP_ACCESS_TOOL} result={answer} />,
  );
  expect((await card(view)).textContent).toContain(
    "Account 2 is connected. Bots use account 1 unless you ask for account 2.",
  );
});
