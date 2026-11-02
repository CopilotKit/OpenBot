import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type ConnectPrompt,
  connectAppRefusal,
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
import { AppAccessCard } from "@/components/channels/app-access-card";
import { ServerToolLine } from "@/components/channels/chat-transcript";
import type { AppAccess } from "@/lib/app-access/queries";
import { ActiveBotProvider, useActiveBot } from "@/lib/copilot/active-bot";
import { carryOnMessage } from "@/lib/copilot/carry-on";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { appAccess } from "./app-access-fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * The card a conversation draws when a Bot could not use an app, for every way that happens: the
 * person has not connected, a Shared app has no team account, the vendor lost the account, and the
 * `show_app_access` tool a Bot calls for an app it holds nothing for (switched off, not granted).
 *
 * The card never draws what the refusal said: it asks the server what the app is for this person
 * on the Bot that refused, and draws that. The one exception is an account the vendor lost, which
 * the server cannot know about — drawn as Reconnect over a live `ready`, until a connection newer
 * than the refusal says it has been put back.
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

/** Answers the live read with `live`, and records which Bot and app it was asked about. */
function serving(live: AppAccess | null) {
  const asked: string[] = [];
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.includes("/apps/"))
      return live
        ? Response.json({ app: live })
        : Response.json({ error: "nope" }, { status: 500 });
    if (url.includes("/api/plugins/connections"))
      return Response.json({ connections: [], redirectUri: null });
    return Response.json({});
  }) as unknown as typeof fetch;
  return asked;
}

function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{children}</>,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { client });
}

const prompt = (overrides: Partial<ConnectPrompt> = {}): ConnectPrompt => ({
  serverId: "composio-gmail",
  title: "Gmail",
  message:
    "You have not connected your Gmail account. Connect it and ask again.",
  agentId: "expenses",
  ...overrides,
});

const card = (view: ReturnType<typeof mount>) =>
  waitFor(() => {
    const found = view.container.querySelector("[data-app-access]");
    if (!found?.getAttribute("data-state")) throw new Error("not drawn yet");
    return found as HTMLElement;
  });

test("asks about the app on the Bot that refused, not on another", async () => {
  const asked = serving(appAccess({ state: "not_connected" }));
  mount(<AppAccessCard prompt={prompt()} />);
  await waitFor(() =>
    expect(asked).toContain("/api/plugins/for/expenses/apps/composio-gmail"),
  );
});

test("not connected: names the app and offers Connect", async () => {
  serving(appAccess({ state: "not_connected" }));
  const view = mount(<AppAccessCard prompt={prompt()} />);
  const drawn = await card(view);
  expect(drawn.textContent).toContain("Gmail");
  expect(drawn.textContent).toContain(
    "You haven't connected your Gmail account yet.",
  );
  expect(view.getByRole("button", { name: "Connect Gmail" })).toBeTruthy();
});

test("connected since the refusal: says so and offers nothing stale", async () => {
  serving(appAccess({ state: "ready" }));
  const view = mount(<AppAccessCard prompt={prompt()} />);
  const drawn = await card(view);
  expect(drawn.textContent).toContain(
    "Gmail is ready now. Ask again and the Bot can use it.",
  );
  expect(view.queryByRole("button")).toBeNull();
});

test("a Shared app with no team account: Request access, not a sentence", async () => {
  serving(
    appAccess({
      state: "shared_not_connected",
      account: "shared",
      accountMode: "shared",
      requestKind: "connect_shared",
    }),
  );
  const view = mount(
    <AppAccessCard
      prompt={prompt({
        reason: "shared",
        message:
          "Gmail is shared across this deployment and no account is connected to it yet. Ask an admin to connect it.",
      })}
    />,
  );
  const drawn = await card(view);
  expect(drawn.textContent).toContain(
    "Your organisation's Gmail account isn't connected yet.",
  );
  expect(
    view.getByRole("button", { name: "Request access to Gmail" }),
  ).toBeTruthy();
});

test("an account the vendor lost: Reconnect, though the server still reads ready", async () => {
  serving(
    appAccess({ state: "ready", connectedAt: "2026-10-01T00:00:00.000Z" }),
  );
  const view = mount(
    <AppAccessCard
      prompt={prompt({ reason: "reconnect", at: "2026-10-20T12:00:00.000Z" })}
    />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("reconnect");
  expect(drawn.textContent).toContain(
    "Your Gmail connection needs reconnecting.",
  );
  expect(
    (await view.findByText("Reconnect")).closest("a")?.getAttribute("href"),
  ).toBe("/connections/composio-gmail");
});

test("an account lost and then connected again: the newer connection wins", async () => {
  serving(
    appAccess({ state: "ready", connectedAt: "2026-10-20T12:05:00.000Z" }),
  );
  const view = mount(
    <AppAccessCard
      prompt={prompt({ reason: "reconnect", at: "2026-10-20T12:00:00.000Z" })}
    />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("ready");
  expect(view.queryByText("Reconnect")).toBeNull();
});

test("a team account the vendor lost: says an admin has to reconnect it, with nothing to press", async () => {
  serving(appAccess({ state: "ready", account: "shared" }));
  const view = mount(<AppAccessCard prompt={prompt({ reason: "shared" })} />);
  const drawn = await card(view);
  expect(drawn.textContent).toContain(
    "Your organisation's Gmail account needs reconnecting. Only an admin can reconnect it.",
  );
  expect(view.queryByRole("button")).toBeNull();
});

test.each([
  ["disabled", "enable", /Gmail isn't turned on yet/],
  ["not_granted", "grant", /This Bot hasn't been given Gmail/],
] as const)(
  "the Bot asked about an app that is %s: Request access",
  async (state, kind, sentence) => {
    serving(appAccess({ state, requestKind: kind, granted: false }));
    const view = mount(
      <AppAccessCard prompt={prompt({ reason: "access", message: "" })} />,
    );
    const drawn = await card(view);
    expect(drawn.textContent).toMatch(sentence);
    expect(
      view.getByRole("button", { name: "Request access to Gmail" }),
    ).toBeTruthy();
  },
);

test("asked about an app that is ready, it says so without claiming it was just connected", async () => {
  serving(appAccess());
  const view = mount(<AppAccessCard prompt={prompt({ reason: "access" })} />);
  const drawn = await card(view);
  expect(drawn.textContent).toContain("Ready to use.");
});

test("an account lost on somebody else's Team Bot that runs on its owner's: only the owner can reconnect it", async () => {
  serving(
    appAccess({
      state: "ready",
      accountHolder: "owner",
      connectedAt: "2026-10-01T00:00:00.000Z",
    }),
  );
  const view = mount(
    <AppAccessCard
      prompt={prompt({ reason: "reconnect", at: "2026-10-20T12:00:00.000Z" })}
    />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("reconnect");
  expect(drawn.textContent).toContain(
    "This Bot uses its owner's Gmail account, which needs reconnecting. Only the Bot's owner can reconnect it.",
  );
  expect(view.queryByRole("button")).toBeNull();
  expect(view.queryByRole("link")).toBeNull();
});

test("a Shared app whose audience is not approved: says so, with nothing to press", async () => {
  serving(
    appAccess({
      state: "shared_not_approved",
      account: "shared",
      accountMode: "shared",
    }),
  );
  const view = mount(<AppAccessCard prompt={prompt({ reason: "access" })} />);
  const drawn = await card(view);
  expect(drawn.textContent).toContain("Only an admin can approve it.");
  expect(view.queryByRole("button")).toBeNull();
});

/** Declares a Bot the way a channel does, around whatever it is given. */
function Declaring({
  botId,
  children,
}: {
  botId: string;
  children: ReactNode;
}) {
  useActiveBot(botId);
  return <>{children}</>;
}

test("an older refusal that names no Bot asks about the Bot the surface declared", async () => {
  const asked = serving(appAccess({ state: "not_connected" }));
  const view = mount(
    <ActiveBotProvider>
      <Declaring botId="travel">
        <AppAccessCard prompt={prompt({ agentId: undefined })} />
      </Declaring>
    </ActiveBotProvider>,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("not_connected");
  expect(asked).toContain("/api/plugins/for/travel/apps/composio-gmail");
});

test("with no Bot to ask about at all, it is the Connect card it always was", async () => {
  const asked = serving(null);
  const view = mount(<AppAccessCard prompt={prompt({ agentId: undefined })} />);
  expect(await view.findByText("Connect Gmail")).toBeTruthy();
  expect(asked.some((url) => url.includes("/apps/"))).toBe(false);
});

test("a live read that fails falls back to the Connect card for a connect refusal", async () => {
  serving(null);
  const view = mount(<AppAccessCard prompt={prompt()} />);
  expect(await view.findByText("Connect Gmail")).toBeTruthy();
});

test("a live read that fails says so in the person's words, never the model's", async () => {
  serving(null);
  const view = mount(
    <AppAccessCard
      prompt={prompt({
        reason: "access",
        message:
          "Gmail is switched off. Do not browse to its website or ask them to sign in there.",
      })}
    />,
  );
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "Gmail's status couldn't be loaded. Try again in a moment.",
  );
  expect(view.container.textContent).not.toContain("Do not browse");
});

/*
 * THROUGH THE TRANSCRIPT'S OWN LINE. The card is drawn from a server tool's answer — a refusal, or
 * the `show_app_access` result — by `ServerToolLine`, and only those two are read for a marker.
 * That it is drawn rather than folded into "Used N tools" is `tool-activity.test.tsx`'s.
 */
test("the transcript draws a refusal's card", async () => {
  serving(appAccess({ state: "not_connected" }));
  const view = mount(
    <ServerToolLine
      name="mcp__composio-gmail__GMAIL_FETCH_EMAILS"
      result={`${REFUSAL_MARKER} ${connectAppRefusal(prompt())}`}
    />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("not_connected");
});

test("the transcript draws show_app_access's card from its ordinary answer", async () => {
  serving(
    appAccess({ state: "disabled", requestKind: "enable", granted: false }),
  );
  const view = mount(
    <ServerToolLine
      name={SHOW_APP_ACCESS_TOOL}
      result={connectAppRefusal(
        prompt({
          reason: "access",
          message: "Gmail is switched off on this deployment.",
        }),
      )}
    />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("disabled");
});

test("an ordinary tool's answer is never read for a card, whatever it starts with", async () => {
  serving(appAccess({ state: "not_connected" }));
  const view = mount(
    <ServerToolLine name="run_command" result={connectAppRefusal(prompt())} />,
  );
  await settleReactWork();
  expect(view.container.querySelector("[data-app-access]")).toBeNull();
});

test("show_app_access is named for the person while it runs, not by its identifier", () => {
  const view = mount(<ServerToolLine name={SHOW_APP_ACCESS_TOOL} />);
  return waitFor(() => {
    expect(view.getByText("Checking app access")).toBeTruthy();
    expect(view.container.textContent).not.toContain(SHOW_APP_ACCESS_TOOL);
  });
});

test("show_app_access about an app nobody can name draws the line, never its words to the model", async () => {
  const view = mount(
    <ServerToolLine
      name={SHOW_APP_ACCESS_TOOL}
      result="This deployment has no app called Gmial, so there is nothing to show. Say so plainly; do not browse to it instead."
    />,
  );
  expect(await view.findByText("Checked app access")).toBeTruthy();
  expect(view.container.textContent).not.toContain("Say so plainly");
  // Nothing behind a disclosure either: the line is not expandable.
  expect(view.container.querySelector("details")).toBeNull();
});

/*
 * CARRYING ON. Once the app is ready the conversation goes on by itself — one message, as the
 * person, through the conversation's `ask` — but only from the card that is still the latest thing,
 * only once, and only where the card saw the change; a card drawn already ready offers Continue.
 */
describe("carrying the task on once the app is ready", () => {
  let calls = 0;
  const nextId = () => {
    calls += 1;
    return `call_${calls}_${Math.random().toString(36).slice(2)}`;
  };

  /** Answers the live read with whatever `state.live` is now, so a test can change it. */
  function servingNow(state: { live: AppAccess }) {
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/apps/")) return Response.json({ app: state.live });
      if (url.includes("/api/plugins/connections"))
        return Response.json({ connections: [], redirectUri: null });
      return Response.json({});
    }) as unknown as typeof fetch;
  }

  function inConversation(
    children: ReactNode,
  ): ReturnType<typeof mount> & { asked: string[] } {
    const asked: string[] = [];
    const view = mount(
      <ConversationProvider ask={(text) => asked.push(text)}>
        {children}
      </ConversationProvider>,
    );
    return Object.assign(view, { asked });
  }

  test("a card that sees the app become ready carries on, once", async () => {
    const state = { live: appAccess({ state: "not_connected" }) };
    servingNow(state);
    const place = { toolCallId: nextId(), latest: true };
    const view = inConversation(
      <AppAccessCard place={place} prompt={prompt()} />,
    );
    expect((await card(view)).getAttribute("data-state")).toBe("not_connected");
    state.live = appAccess({ state: "ready" });
    await act(() => view.client.invalidateQueries());
    await waitFor(() => expect(view.asked).toEqual([carryOnMessage("Gmail")]));
    expect((await card(view)).textContent).toContain("Gmail is ready now.");
    expect(view.container.textContent).not.toContain("Ask again");
    // Read again and drawn again: still the one message.
    await act(() => view.client.invalidateQueries());
    await settleReactWork();
    expect(view.asked).toHaveLength(1);
    expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  test("a card the conversation has moved on from only says the app is ready", async () => {
    const state = { live: appAccess({ state: "not_connected" }) };
    servingNow(state);
    const view = inConversation(
      <AppAccessCard
        place={{ toolCallId: nextId(), latest: false }}
        prompt={prompt()}
      />,
    );
    await card(view);
    state.live = appAccess({ state: "ready" });
    await act(() => view.client.invalidateQueries());
    await waitFor(async () =>
      expect((await card(view)).getAttribute("data-state")).toBe("ready"),
    );
    await settleReactWork();
    expect(view.asked).toEqual([]);
    expect((await card(view)).textContent).toContain(
      "Gmail is ready now. Ask again and the Bot can use it.",
    );
  });

  test("a card drawn already ready offers Continue, which carries on once", async () => {
    servingNow({ live: appAccess({ state: "ready" }) });
    const place = { toolCallId: nextId(), latest: true };
    const view = inConversation(
      <AppAccessCard place={place} prompt={prompt()} />,
    );
    fireEvent.click(await view.findByRole("button", { name: "Continue" }));
    expect(view.asked).toEqual([carryOnMessage("Gmail")]);
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Continue" })).toBeNull(),
    );
    cleanup();
    // The same card drawn again, here or in another tab, has nothing left to offer.
    const again = inConversation(
      <AppAccessCard place={place} prompt={prompt()} />,
    );
    expect((await card(again)).textContent).toContain("Gmail is ready now.");
    expect(again.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(again.asked).toEqual([]);
  });

  test.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])(
    "show_app_access drawn ready offers Continue only if the app was blocked when asked (blocked: %p)",
    async (blocked, offered) => {
      servingNow({ live: appAccess({ state: "ready" }) });
      const view = inConversation(
        <AppAccessCard
          place={{ toolCallId: nextId(), latest: true }}
          prompt={prompt({
            reason: "access",
            ...(blocked === undefined ? {} : { blocked }),
          })}
        />,
      );
      await card(view);
      await settleReactWork();
      expect(view.queryByRole("button", { name: "Continue" }) !== null).toBe(
        offered,
      );
      expect(view.asked).toEqual([]);
    },
  );

  test("with no conversation around it, the card only says the app is ready", async () => {
    servingNow({ live: appAccess({ state: "ready" }) });
    const view = mount(
      <AppAccessCard
        place={{ toolCallId: nextId(), latest: true }}
        prompt={prompt()}
      />,
    );
    expect((await card(view)).textContent).toContain(
      "Ask again and the Bot can use it.",
    );
    expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});
