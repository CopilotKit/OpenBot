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
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { CheckInRoutePage } from "@/components/suggestions/check-in-page";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * One Bot's check-ins, against a server answering as `/api/proactive` does: the row says how often
 * and when it runs next whatever the focus and links to the check-in's page, which says what the last
 * check-in did (a skip and why included) and what Run now did. Turn on check-ins is offered only for
 * a Bot that has none, and asks for no conversation: a check-in belongs to its Bot.
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

const NOTHING_TO_READ = "Nothing to check: connect an app this Bot can read.";
const FOCUS =
  "I must decide this week whether to trial the TypeScript 7.1 Beta in my apps. Each check-in, search the web for the announcement and raise one next step.";

type LastRun = {
  outcome: "running" | "quiet" | "raised" | "failed" | "skipped";
  trigger: "schedule" | "run_now";
  skipReason: string | null;
  why: string | null;
  itemsRaised: number;
  startedAt: string;
  finishedAt: string | null;
};

const setting = (overrides: Record<string, unknown> = {}) => ({
  id: "p1",
  ownerUserId: "alice",
  agentId: "expenses",
  channelId: "own",
  threadId: "t-p1",
  focus: "",
  enabled: true,
  intervalMinutes: 60,
  nextRunAt: new Date(Date.now() + 45 * 60_000).toISOString(),
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
  createdAt: "2026-10-30T10:00:00Z",
  updatedAt: "2026-10-30T10:00:00Z",
  lastRun: null as LastRun | null,
  ...overrides,
});

let settings: ReturnType<typeof setting>[] = [];
/** What `POST .../run` answers, and the last check-in it leaves behind for the next read. */
let runAnswer: Record<string, unknown> = { queued: true };
let afterRun: LastRun | null = null;
const writes: string[] = [];

const channel = (id: string, summary: string, task: boolean) => ({
  id,
  name: "Expenses",
  agentIds: ["expenses"],
  threadId: `thread-${id}`,
  active: true,
  lastMessageAt: "2026-10-30T10:00:00Z",
  summary,
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: "2026-10-30T10:00:00Z",
  pinned: false,
  lastReadAt: null,
  task,
});

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path === "/api/proactive/settings/p1/run" && method === "POST") {
      if (afterRun)
        settings = settings.map((row) => ({ ...row, lastRun: afterRun }));
      return Response.json(runAnswer);
    }
    if (path === "/api/proactive/settings")
      return Response.json({ settings, allowed: true });
    if (path === "/api/settings/preferences")
      return Response.json({
        preferences: {
          messageListEmphasis: "thread",
          selfHostBannerDismissed: true,
          narration: null,
          skin: "openbot",
          proactive: "on",
        },
      });
    if (path.startsWith("/api/channels"))
      return Response.json({
        channels: [
          channel("own", "Expense reports", false),
          channel("task", "Deno 2.9.8 Upgrade Review", true),
        ],
        nextCursor: null,
      });
    if (path.startsWith("/api/agents"))
      return Response.json({ agents: [{ id: "expenses", name: "Expenses" }] });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  settings = [setting()];
  runAnswer = { queued: true };
  afterRun = null;
  serving();
  // The app's one cache, which Run now's answer refreshes, as it does in the app.
  queryClient.clear();
});

/** Drawn under a router: a row is a link to its page, and the page has a back link. */
function inRouter(node: React.ReactNode) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => node,
      }),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const draw = () => inRouter(<ProactiveResearchSettings agentId="expenses" />);
/** The check-in's own page, as its row's link opens it. */
const page = () => inRouter(<CheckInRoutePage checkInId="p1" />);

test("the row leads with how often, that it tells you, and when, whatever the focus, and the focus follows on one line", async () => {
  settings = [setting({ focus: FOCUS })];
  const view = draw();
  const row = await view.findByRole("link", { name: /Expenses/ });
  const lines = [...row.querySelectorAll("[data-slot=item-description]")];
  // When it looks next in the words a routine's page uses, never a raw date and time.
  expect(lines[0]?.textContent).toBe(
    "Every hour · Tells you · Next check in 45 minutes",
  );
  const focus = lines.find((line) => line.textContent?.includes(FOCUS));
  expect(focus?.textContent).toBe(`Looks for: ${FOCUS}`);
  expect(focus?.className).toContain("line-clamp-1");
});

test("a skipped check-in says why on the row and on its page", async () => {
  settings = [
    setting({
      lastRun: {
        outcome: "skipped",
        trigger: "schedule",
        skipReason: "no_sources",
        why: NOTHING_TO_READ,
        itemsRaised: 0,
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    }),
  ];
  const view = draw();
  const row = await view.findByRole("link", { name: /Expenses/ });
  expect(
    within(row).getByText(`Skipped 5 minutes ago. ${NOTHING_TO_READ}`),
  ).toBeTruthy();
  expect(row.getAttribute("href")).toBe("/routines/check-ins/p1");
  cleanup();
  const details = page();
  expect(
    await details.findByText(`Skipped 5 minutes ago. ${NOTHING_TO_READ}`),
  ).toBeTruthy();
});

test("Run now skipped at once says why on the page, never nothing", async () => {
  runAnswer = { queued: false, skipped: "no_sources", why: NOTHING_TO_READ };
  afterRun = {
    outcome: "skipped",
    trigger: "run_now",
    skipReason: "no_sources",
    why: NOTHING_TO_READ,
    itemsRaised: 0,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
  const view = page();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /^Run now/ }));
  expect(writes).toEqual(["POST /api/proactive/settings/p1/run"]);
  expect(
    await view.findByText(`Skipped just now. ${NOTHING_TO_READ}`),
  ).toBeTruthy();
});

test("Run now queued says it is on its way, and a check-in that ran says what it found", async () => {
  settings = [
    setting({
      lastRun: {
        outcome: "raised",
        trigger: "schedule",
        skipReason: null,
        why: null,
        itemsRaised: 2,
        startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        finishedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      },
    }),
  ];
  const view = page();
  const user = userEvent.setup({ document });
  expect(
    await view.findByText("Checked 2 hours ago. Found 2 things for you."),
  ).toBeTruthy();
  await user.click(view.getByRole("button", { name: /^Run now/ }));
  expect(
    await view.findByText("Queued. It checks in within a minute."),
  ).toBeTruthy();
});

test("Turn on check-ins is offered only for a Bot without them, and asks for no conversation", async () => {
  const on = draw();
  await on.findByRole("link", { name: /Expenses/ });
  expect(on.queryByRole("button", { name: "Turn on check-ins" })).toBeNull();
  cleanup();
  queryClient.clear();

  settings = [];
  const off = draw();
  const user = userEvent.setup({ document });
  const [turnOn] = await off.findAllByRole("button", {
    name: "Turn on check-ins",
  });
  await user.click(turnOn as HTMLElement);
  const dialog = await off.findByRole("dialog", { name: "Turn on check-ins" });
  expect(
    within(dialog).queryByRole("combobox", { name: "Conversation" }),
  ).toBeNull();
  expect(
    within(dialog)
      .getByRole("button", { name: "Turn on check-ins" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("Remove asks first, and only then removes the check-in", async () => {
  const view = page();
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", { name: /^Remove check-in/ }),
  );
  const confirm = await view.findByRole("dialog", {
    name: "Remove this check-in?",
  });
  expect(writes).toEqual([]);
  await user.click(within(confirm).getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(writes).toEqual(["DELETE /api/proactive/settings/p1"]),
  );
});

// FOUND IN AN AUDIT: a row said it checked a page it could never read, and nothing said otherwise.
test("the row says what it reads, and a check-in that can't look says so in place of its last run", async () => {
  settings = [
    setting({
      subject: "OpenBot releases",
      sourceKind: "page",
      reads: "github.com",
      lastRun: {
        outcome: "quiet",
        trigger: "schedule",
        skipReason: null,
        why: null,
        itemsRaised: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
      health: {
        why: "Expenses couldn't read this page the last 3 times.",
        fix: "open",
        app: null,
      },
    }),
  ];
  const view = draw();
  const row = (await view.findByText("OpenBot releases")).closest(
    "[data-slot=item]",
  ) as HTMLElement;
  expect(within(row).getByText(/Reads github\.com/)).toBeTruthy();
  const why = within(row).getByText(
    "Expenses couldn't read this page the last 3 times.",
  );
  expect(why.className).toContain("text-destructive");
  expect(within(row).queryByText(/Nothing needed you/)).toBeNull();
});
