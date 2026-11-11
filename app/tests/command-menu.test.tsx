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
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandMenu } from "@/components/navigation/command-menu";
import { authKeys } from "@/lib/auth/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The command palette: Cmd/Ctrl+K anywhere signed in, a box, and the pages, Bots and conversations it
 * finds. Navigation only, and never a page this person can't open.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const now = new Date().toISOString();
const channel = (
  id: string,
  summary: string,
  agentIds = ["helper"],
): ChannelSummary => ({
  id,
  name: "Helper",
  agentIds,
  threadId: `t-${id}`,
  active: true,
  lastMessageAt: now,
  summary,
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: now,
  pinned: false,
  lastReadAt: now,
});

const RECENT = Array.from({ length: 7 }, (_, index) =>
  channel(`recent-${index + 1}`, `Recent talk ${index + 1}`),
);

/** Every request the menu made, by path and query. */
let requests: string[] = [];
/** How a history search answers right now. */
let searchAnswer: "ok" | "fail" = "ok";
let searchResults: ChannelSummary[] = [];
const originalFetch = global.fetch;

beforeEach(() => {
  requests = [];
  searchAnswer = "ok";
  searchResults = [channel("old-1", "Quarterly budget review")];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/channels/search") {
      if (searchAnswer === "fail")
        return Response.json({ error: "Server error" }, { status: 500 });
      return Response.json({ channels: searchResults, nextCursor: null });
    }
    if (url.pathname === "/api/channels")
      return Response.json({ channels: RECENT, nextCursor: null });
    if (url.pathname === "/api/agents")
      return Response.json({
        agents: [
          { id: "helper", name: "Helper", avatarSeed: "helper" },
          { id: "budget", name: "Budget Buddy", avatarSeed: "budget" },
        ],
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

async function draw({
  role = "user",
  edition = "team",
}: {
  role?: "user" | "admin";
  edition?: "team" | "personal";
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(authKeys.currentUser(), {
    id: "me",
    role,
    email: "me@example.test",
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  const root = createRootRoute({
    component: () => (
      <>
        <textarea aria-label="Message" defaultValue="" />
        <CommandMenu />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "$",
        component: () => null,
      }),
    ]),
  });
  // Resolved before the first render, so the page is on screen from the start.
  await router.load();
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

/**
 * Cmd+K on a Mac, Ctrl+K elsewhere. Which one the app expects was read from the platform when the
 * registry loaded, so Ctrl is pressed first and Cmd only if that opened nothing.
 */
async function pressShortcut(target: Element | Window = window) {
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  fireEvent.keyDown(target, { key: "k", code: "KeyK", ctrlKey: true });
  await settle();
  if (within(document.body).queryByRole("dialog")) return;
  fireEvent.keyDown(target, { key: "k", code: "KeyK", metaKey: true });
  await settle();
}

/** Types into the box as a person does, key by key. */
async function typeIn(text: string) {
  const user = userEvent.setup({ document });
  await user.type(box(), text);
}

const box = () =>
  within(document.body).getByRole("combobox", {
    name: "Search pages, Bots and conversations",
  });
const group = (name: string) =>
  within(document.body).queryByRole("group", { name });
const options = (name: string) => {
  const found = group(name);
  return found
    ? within(found)
        .queryAllByRole("option")
        .map((option) => option.textContent)
    : [];
};

async function openMenu() {
  const drawn = await draw();
  await pressShortcut();
  await within(document.body).findByRole("dialog", { name: "Command palette" });
  return drawn;
}

test("Cmd/Ctrl+K opens it, and empty it lists pages, Bots and five recent conversations", async () => {
  await openMenu();
  await waitFor(() => expect(options("Conversations")).toHaveLength(5));
  expect(options("Pages")).toEqual([
    "New conversation",
    "Bots",
    "Routines",
    "Memory",
    "Skills",
    "Connections",
    "Settings",
  ]);
  expect(options("Bots")).toEqual(["Helper", "Budget Buddy"]);
  expect(options("Conversations")[0]).toContain("Recent talk 1");
  expect(document.activeElement).toBe(box());
});

test("a member never sees Admin; an admin does; the personal edition has no Memory or Admin", async () => {
  await openMenu();
  expect(options("Pages")).not.toContain("Admin");
  cleanup();

  await draw({ role: "admin" });
  await pressShortcut();
  await within(document.body).findByRole("dialog", { name: "Command palette" });
  expect(options("Pages")).toContain("Admin");
  cleanup();

  await draw({ edition: "personal" });
  await pressShortcut();
  await within(document.body).findByRole("dialog", { name: "Command palette" });
  expect(options("Pages")).not.toContain("Memory");
  expect(options("Pages")).not.toContain("Admin");
  expect(options("Pages")).not.toContain("OpenBot for Business");
});

test("typing filters pages and Bots here, and one character asks for one more before searching history", async () => {
  await openMenu();
  await typeIn("b");
  expect(options("Pages")).toEqual(["Bots"]);
  expect(options("Bots")).toEqual(["Budget Buddy"]);
  expect(
    within(document.body).getByText(
      "Type at least 2 characters to search history.",
    ),
  ).toBeTruthy();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(requests.some((request) => request.includes("/search"))).toBe(false);
});

test("two characters search every conversation's name and recent messages on the server", async () => {
  await openMenu();
  await typeIn("budget");
  await waitFor(() =>
    expect(options("Conversations")).toEqual([
      expect.stringContaining("Quarterly budget review"),
    ]),
  );
  const searched = requests.filter((request) => request.includes("/search"));
  expect(searched).toHaveLength(1);
  expect(searched[0]).toContain("q=budget");
  // Local matches stay: the Bot is found here, not by the server.
  expect(options("Bots")).toEqual(["Budget Buddy"]);
});

test("a failed history search says so, offers Retry, and keeps the pages and Bots it found", async () => {
  searchAnswer = "fail";
  await openMenu();
  await typeIn("budget");
  // Said on screen, beside Retry, and once to a screen reader.
  const retry = await within(document.body).findByRole(
    "button",
    { name: "Retry" },
    { timeout: 2000 },
  );
  expect(retry.parentElement?.textContent).toContain(
    "Couldn't search conversations.",
  );
  expect(within(document.body).getByRole("status").textContent).toBe(
    "Couldn't search conversations.",
  );
  expect(options("Bots")).toEqual(["Budget Buddy"]);
  expect(
    within(document.body).queryByText("No conversations match."),
  ).toBeNull();

  searchAnswer = "ok";
  fireEvent.click(retry);
  await waitFor(() =>
    expect(options("Conversations")).toEqual([
      expect.stringContaining("Quarterly budget review"),
    ]),
  );
});

test("arrows move the active result and Enter opens it, a Bot's profile, without starting anything", async () => {
  const { router } = await openMenu();
  await typeIn("budg");
  // Pages has nothing for "budg", so the first result is the Bot.
  await waitFor(() => expect(options("Bots")).toEqual(["Budget Buddy"]));
  const active = () =>
    document.getElementById(box().getAttribute("aria-activedescendant") ?? "")
      ?.textContent;
  expect(active()).toBe("Budget Buddy");
  fireEvent.keyDown(box(), { key: "ArrowDown" });
  fireEvent.keyDown(box(), { key: "ArrowUp" });
  expect(active()).toBe("Budget Buddy");

  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/budget"),
  );
  expect(within(document.body).queryByRole("dialog")).toBeNull();
  expect(requests.filter((request) => !request.startsWith("GET"))).toEqual([]);
});

test("Enter while an input method is composing picks the character, not a result", async () => {
  const { router } = await openMenu();
  await typeIn("bo");
  fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
  expect(router.state.location.pathname).toBe("/");
  expect(within(document.body).getByRole("dialog")).toBeTruthy();
});

test("Escape closes it, focus goes back, and a draft in the message box is kept", async () => {
  const { view } = await draw();
  const message = view.getByLabelText("Message") as HTMLTextAreaElement;
  message.focus();
  await userEvent.setup({ document }).type(message, "Half a thought");
  // Pressed while typing: a modified shortcut isn't a character, so it opens over the draft.
  await pressShortcut(message);
  await within(document.body).findByRole("dialog", { name: "Command palette" });

  fireEvent.keyDown(box(), { key: "Escape" });
  await waitFor(() =>
    expect(within(document.body).queryByRole("dialog")).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(message));
  expect(message.value).toBe("Half a thought");
});

test("a group conversation opens as a group, and a one-Bot one as a conversation", async () => {
  searchResults = [
    channel("grp", "Trip planning together", ["helper", "budget"]),
  ];
  const { router } = await openMenu();
  await typeIn("trip");
  const found = await waitFor(() => {
    const option = within(document.body).getByRole("option", {
      name: /Trip planning together/,
    });
    return option;
  });
  fireEvent.click(found);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/group/grp"),
  );
});
