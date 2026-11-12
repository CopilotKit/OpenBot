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
import type { SidebarSections } from "@openbot/shared/user-preferences";
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
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationSections } from "@/components/app-sidebar/conversation-sections";
import { agentKeys } from "@/lib/agents/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import type { Project } from "@/lib/projects/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * The sidebar's three collapsible sections, and the "Move to project ▸" row in a conversation's
 * menu — drawn, folded and acted on.
 *
 * `lib/channels/sections.ts` decides where a conversation goes and what a fold means, and
 * `channel-sections.test.ts` covers that on its own. What only a rendered tree can say is whether
 * the answer reaches the screen: a header that names its section and its count, a chevron that asks
 * for the section it belongs to, a folded section that hides its rows and keeps its header, a search
 * that opens what it matched, a folder that folds without folding the section above it, and a menu
 * row that files the conversation it was opened on.
 */

const OPEN = {
  group: false,
  direct: false,
  projects: false,
} satisfies SidebarSections;

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** A minimal but fully-typed channel summary, so the fixtures are real objects rather than casts. */
function channel(
  id: string,
  overrides: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: ["bot-1"],
    threadId: `thread-${id}`,
    active: true,
    summary: null,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

function project(id: string, name: string, channelIds: string[] = []): Project {
  return {
    id,
    name,
    sortOrder: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    channelIds,
  };
}

type SeenRequest = { url: string; init: RequestInit | undefined };

const realFetch = globalThis.fetch;

/**
 * A fetch that answers the one write these tests ask for and fails everything else loudly.
 *
 * The roster and the folder list are put in the cache, so a request reaching the network is a bug in
 * the fixture rather than something to ignore: answering it would hide the row that went looking.
 */
function servingMove(status = 200, body: unknown = {}) {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return seen;
}

beforeEach(() => {
  servingMove();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * The sections, in a router and a query client, as `AppSidebar` draws them.
 *
 * A real memory router rather than a stub: each row is a `Link` and every row asks `useParams` which
 * conversation is open, so a row outside a router is a row that cannot render at all.
 */
async function renderSections({
  channels,
  projects = [],
  collapsed = OPEN,
  searching = false,
  onToggle = () => {},
}: {
  channels: ChannelSummary[];
  projects?: Project[];
  collapsed?: SidebarSections;
  searching?: boolean;
  onToggle?: (id: keyof SidebarSections) => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), []);

  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <div data-testid="sections">
        <ConversationSections
          animateOrder={false}
          channels={channels}
          collapsed={collapsed}
          emphasis="thread"
          onToggle={onToggle}
          projects={projects}
          searching={searching}
        />
      </div>
    ),
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/$channelId",
    component: () => <div />,
  });
  const groupRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/group/$channelId",
    component: () => <div />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, channelRoute, groupRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  // A router resolves its first match on a microtask, so the probe is not in the document yet.
  await view.findByTestId("sections");
  return { ...view, queryClient, router };
}

/** The header button of a section, which is the whole row and the only toggle in it. */
function header(container: HTMLElement, title: string): HTMLButtonElement {
  const span = within(container).getByText(title);
  const button = span.closest("button");
  if (!button) throw new Error(`"${title}" is not drawn in a section header`);
  return button as HTMLButtonElement;
}

/** What a folded section does to the list it hides: the attribute, not the styling. */
function bodyOf(container: HTMLElement, id: string): HTMLElement {
  const body = container.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!body) throw new Error(`no section body with id "${id}"`);
  return body;
}

/*
 * A group chat, a direct chat, and a conversation filed in a folder — the three answers the sidebar
 * has to keep apart. The filed one is a group chat by shape on purpose: a folder wins over
 * membership, and a channel that is in a project appears nowhere else.
 */
const groupChat = channel("team-room", {
  name: "Team room",
  agentIds: ["bot-1", "bot-2"],
  memberCount: 1,
});
const directChat = channel("my-assistant", {
  name: "My assistant",
  agentIds: ["bot-1"],
  memberCount: 1,
});
const filedChat = channel("website-work", {
  name: "Website work",
  agentIds: ["bot-1", "bot-2"],
  memberCount: 3,
  projectId: "p-website",
});
const designFolder = project("p-website", "Website redesign", ["website-work"]);
const emptyFolder = project("p-empty", "Empty folder");

test("draws the three sections with their conversations and counts", async () => {
  const view = await renderSections({
    channels: [groupChat, directChat, filedChat],
    projects: [designFolder, emptyFolder],
  });

  // Every header names itself and counts what is under it. Projects counts what is filed in all of
  // its folders, not how many folders there are.
  expect(
    within(header(view.container, "Group chats")).getByText("1"),
  ).toBeTruthy();
  expect(
    within(header(view.container, "Direct chats")).getByText("1"),
  ).toBeTruthy();
  expect(
    within(header(view.container, "Projects")).getByText("1"),
  ).toBeTruthy();

  // Each conversation is drawn once, and the filed one only inside its folder.
  expect(within(view.container).getAllByText("Team room")).toHaveLength(1);
  expect(within(view.container).getAllByText("My assistant")).toHaveLength(1);
  expect(within(view.container).getAllByText("Website work")).toHaveLength(1);

  const groupSection = bodyOf(view.container, "sidebar-section-group");
  expect(within(groupSection).getByText("Team room")).toBeTruthy();
  expect(within(groupSection).queryByText("Website work")).toBeNull();

  const projectsSection = bodyOf(view.container, "sidebar-section-projects");
  expect(within(projectsSection).getByText("Website redesign")).toBeTruthy();
  expect(within(projectsSection).getByText("Empty folder")).toBeTruthy();
  expect(within(projectsSection).getByText("Website work")).toBeTruthy();
});

test("a header click asks for the section it belongs to, and nothing else", async () => {
  const onToggle = mock((_id: keyof SidebarSections) => {});
  const view = await renderSections({
    channels: [groupChat, directChat],
    onToggle,
  });

  await userEvent.click(header(view.container, "Group chats"));
  expect(onToggle.mock.calls).toEqual([["group"]]);

  await userEvent.click(header(view.container, "Direct chats"));
  expect(onToggle.mock.calls).toEqual([["group"], ["direct"]]);

  await userEvent.click(header(view.container, "Projects"));
  expect(onToggle.mock.calls).toEqual([["group"], ["direct"], ["projects"]]);
});

test("a folded section keeps its header, says it is folded, and hides its rows", async () => {
  const view = await renderSections({
    channels: [groupChat, directChat],
    collapsed: { group: true, direct: false, projects: false },
  });

  const group = header(view.container, "Group chats");
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expect(bodyOf(view.container, "sidebar-section-group").hidden).toBe(true);

  // The section below it is untouched: a fold is one flag, not a mode.
  const direct = header(view.container, "Direct chats");
  expect(direct.getAttribute("aria-expanded")).toBe("true");
  expect(bodyOf(view.container, "sidebar-section-direct").hidden).toBe(false);
});

test("aria-controls names the list the header folds", async () => {
  const view = await renderSections({ channels: [groupChat, directChat] });

  for (const [title, id] of [
    ["Group chats", "sidebar-section-group"],
    ["Direct chats", "sidebar-section-direct"],
    ["Projects", "sidebar-section-projects"],
  ] as const) {
    const button = header(view.container, title);
    expect(button.getAttribute("aria-controls")).toBe(id);
    expect(view.container.querySelector(`#${CSS.escape(id)}`)).not.toBeNull();
  }
});

test("a search opens the sections it matched, without writing the fold away", async () => {
  // A conversation in a folder too: Projects with nothing filed and a search running is dropped
  // rather than drawn empty, which the next test covers.
  const view = await renderSections({
    channels: [groupChat, directChat, filedChat],
    projects: [designFolder],
    collapsed: { group: true, direct: true, projects: true },
    searching: true,
  });

  // Every section is drawn open while the box holds something, so a match found inside a folded
  // section is shown rather than only counted.
  for (const title of ["Group chats", "Direct chats", "Projects"]) {
    expect(header(view.container, title).getAttribute("aria-expanded")).toBe(
      "true",
    );
  }
  expect(bodyOf(view.container, "sidebar-section-group").hidden).toBe(false);

  cleanup();

  // The same flags with the box empty are exactly what the person folded: search is an overlay on
  // the stored flags, not an edit of them.
  const quiet = await renderSections({
    channels: [groupChat, directChat, filedChat],
    projects: [designFolder],
    collapsed: { group: true, direct: true, projects: true },
  });
  expect(
    header(quiet.container, "Group chats").getAttribute("aria-expanded"),
  ).toBe("false");
});

test("an empty section says so when idle, and is dropped while searching", async () => {
  const idle = await renderSections({ channels: [directChat] });
  expect(
    within(bodyOf(idle.container, "sidebar-section-group")).getByText(
      "No group chats yet",
    ),
  ).toBeTruthy();
  expect(idle.container.querySelector("#sidebar-project-hint")).toBeNull();

  cleanup();

  // "No group chats yet" beside a box holding somebody's name would be the wrong sentence about the
  // wrong thing, so an empty section leaves the sidebar while a search is running.
  const searching = await renderSections({
    channels: [directChat],
    searching: true,
  });
  expect(within(searching.container).queryByText("Group chats")).toBeNull();
  expect(within(searching.container).getByText("Direct chats")).toBeTruthy();
});

test("Projects holds folders, counts what is filed in them, and says how to start one", async () => {
  const empty = await renderSections({ channels: [directChat] });
  const projectsBody = bodyOf(empty.container, "sidebar-section-projects");
  expect(within(projectsBody).getByText("No projects yet")).toBeTruthy();
  expect(
    within(projectsBody).getByText(
      "Folders of your own: make one with +, then file a conversation into it from its menu.",
    ),
  ).toBeTruthy();
});

test("a folder folds on its own, and the section above it stays open", async () => {
  const onToggle = mock((_id: keyof SidebarSections) => {});
  const view = await renderSections({
    channels: [filedChat],
    projects: [designFolder],
    onToggle,
  });

  const folderButton = within(
    bodyOf(view.container, "sidebar-section-projects"),
  )
    .getByText("Website redesign")
    .closest("button") as HTMLButtonElement | null;
  if (!folderButton) throw new Error("the folder has no header button");

  expect(folderButton.getAttribute("aria-expanded")).toBe("true");
  const folderBodyId = folderButton.getAttribute("aria-controls");
  if (!folderBodyId) throw new Error("the folder header names no body");
  expect(
    view.container
      .querySelector(`#${CSS.escape(folderBodyId)}`)
      ?.hasAttribute("hidden"),
  ).toBe(false);

  await userEvent.click(folderButton);

  // Folded where it was clicked; the section is not asked to fold and the Projects header keeps its
  // own answer. A folder's fold is remembered by nothing — it is a detail of this moment.
  expect(folderButton.getAttribute("aria-expanded")).toBe("false");
  expect(
    view.container
      .querySelector(`#${CSS.escape(folderBodyId)}`)
      ?.hasAttribute("hidden"),
  ).toBe(true);
  expect(onToggle.mock.calls).toEqual([]);
  expect(header(view.container, "Projects").getAttribute("aria-expanded")).toBe(
    "true",
  );
});

test("a folder's rows are reachable while it is open, and gone from the list when folded", async () => {
  const view = await renderSections({
    channels: [filedChat],
    projects: [designFolder],
  });

  const projectsBody = bodyOf(view.container, "sidebar-section-projects");
  const folderButton = within(projectsBody)
    .getByText("Website redesign")
    .closest("button") as HTMLButtonElement;
  const folderBody = view.container.querySelector<HTMLElement>(
    `#${CSS.escape(folderButton.getAttribute("aria-controls") ?? "")}`,
  );
  if (!folderBody) throw new Error("the folder body is missing");

  expect(within(folderBody).getByText("Website work")).toBeTruthy();

  await userEvent.click(folderButton);
  expect(folderBody.hidden).toBe(true);
});

/*
 * The menu. A conversation's "Move to project ▸" is the only way a conversation is filed, so what it
 * offers and what it does when a row is picked is the feature's whole client half.
 */

/** Opens a conversation's context menu and returns what it drew. */
async function openRowMenu(container: HTMLElement, rowName: string) {
  // The menu trigger wraps the row's link, so the right-click lands on the whole row.
  const trigger = within(container).getByText(rowName).closest("a");
  if (!trigger) throw new Error(`no row for "${rowName}"`);
  fireEvent.contextMenu(trigger);
  return await waitFor(() => {
    const menu = document.querySelector<HTMLElement>(
      '[data-slot="context-menu-content"]',
    );
    if (!menu) throw new Error("the context menu did not open");
    return menu;
  });
}

test("move-to-project offers every folder but the one it is already in", async () => {
  const view = await renderSections({
    channels: [filedChat],
    projects: [designFolder, emptyFolder],
  });

  const menu = await openRowMenu(view.container, "Website work");
  expect(within(menu).getByText("Move to project")).toBeTruthy();

  await userEvent.click(within(menu).getByText("Move to project"));

  const offers = await waitFor(() => {
    const rows = [
      ...document.querySelectorAll('[data-slot="context-menu-item"]'),
    ]
      .map((row) => row.textContent?.trim())
      .filter(Boolean) as string[];
    if (!rows.some((row) => row.includes("Empty folder")))
      throw new Error("the submenu did not open");
    return rows;
  });

  // The folder it is already filed in is not an action: it is left out rather than drawn disabled.
  expect(offers.some((row) => row?.includes("Website redesign"))).toBe(false);
  expect(offers.some((row) => row?.includes("Empty folder"))).toBe(true);
  expect(offers.some((row) => row?.includes("New project"))).toBe(true);
  // And the way back out, because this conversation is filed somewhere.
  expect(offers.some((row) => row?.includes("Remove from project"))).toBe(true);
});

test("picking a folder files the conversation it was opened on", async () => {
  const seen = servingMove();
  const view = await renderSections({
    channels: [directChat],
    projects: [emptyFolder],
  });

  const menu = await openRowMenu(view.container, "My assistant");
  await userEvent.click(within(menu).getByText("Move to project"));

  const row = await waitFor(() => {
    const found = [
      ...document.querySelectorAll('[data-slot="context-menu-item"]'),
    ].find((item) => item.textContent?.includes("Empty folder"));
    if (!found) throw new Error("the folder row did not open");
    return found as HTMLElement;
  });
  await userEvent.click(row);

  await waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]?.url).toBe("/api/channels/my-assistant/project");
  expect(seen[0]?.init?.method).toBe("PATCH");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
    projectId: "p-empty",
  });
});

test("an unfiled conversation offers no way out of a project", async () => {
  const view = await renderSections({
    channels: [directChat],
    projects: [emptyFolder],
  });

  const menu = await openRowMenu(view.container, "My assistant");
  expect(within(menu).queryByText("Remove from project")).toBeNull();
  expect(within(menu).getByText("Move to project")).toBeTruthy();
});

test("a refused move is said on the row that asked", async () => {
  const seenRequests = servingMove(404, {
    error: "That project is not yours.",
  });
  const view = await renderSections({
    channels: [directChat],
    projects: [emptyFolder],
  });

  const menu = await openRowMenu(view.container, "My assistant");
  await userEvent.click(within(menu).getByText("Move to project"));
  const row = await waitFor(() => {
    const found = [
      ...document.querySelectorAll('[data-slot="context-menu-item"]'),
    ].find((item) => item.textContent?.includes("Empty folder"));
    if (!found) throw new Error("the folder row did not open");
    return found as HTMLElement;
  });
  await userEvent.click(row);

  // The menu has closed by then, so the sentence lands on the row: a conversation that quietly
  // stayed where it was reads as a click that did nothing.
  const alert = await waitFor(() => {
    const found = view.container.querySelector('[role="alert"]');
    if (!found) throw new Error("the row said nothing about the refused move");
    return found;
  });
  expect(alert.textContent).toBe("That project is not yours.");
  // And the refusal was the server's, not a click that never left the page.
  expect(
    seenRequests.map((request) => [
      request.url,
      request.init?.method,
      String(request.init?.body),
    ]),
  ).toEqual([
    [
      "/api/channels/my-assistant/project",
      "PATCH",
      JSON.stringify({ projectId: "p-empty" }),
    ],
  ]);
});
