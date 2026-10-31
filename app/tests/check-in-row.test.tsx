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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * One Bot's check-ins on its Memory page, against a server answering as `/api/proactive` does: the
 * row says how often and when it runs next whatever the focus, what the last check-in did (a skip and
 * why included), what Run now did, and Turn on check-ins is offered only for a Bot that has none,
 * over the person's own conversations with it, never a task's.
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

function draw() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ProactiveResearchSettings agentId="expenses" />
    </QueryClientProvider>,
  );
}

test("the row leads with how often and when, whatever the focus, and the focus follows on one line", async () => {
  settings = [setting({ focus: FOCUS })];
  const view = draw();
  const row = await view.findByRole("button", { name: /Expenses/ });
  const lines = [...row.querySelectorAll("[data-slot=item-description]")];
  expect(lines[0]?.textContent).toMatch(/^Every hour · Next /);
  const focus = lines.find((line) => line.textContent?.includes(FOCUS));
  expect(focus?.textContent).toBe(`Looks for: ${FOCUS}`);
  expect(focus?.className).toContain("line-clamp-1");
});

test("a skipped check-in says why on the row and in its dialog", async () => {
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
  const row = await view.findByRole("button", { name: /Expenses/ });
  expect(
    within(row).getByText(`Skipped 5 minutes ago. ${NOTHING_TO_READ}`),
  ).toBeTruthy();
  const user = userEvent.setup({ document });
  await user.click(row);
  const dialog = await view.findByRole("dialog");
  expect(
    within(dialog).getByText(`Skipped 5 minutes ago. ${NOTHING_TO_READ}`),
  ).toBeTruthy();
});

test("Run now skipped at once says why in its dialog, never nothing", async () => {
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
  const view = draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /Expenses/ }));
  const dialog = await view.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Run now" }));
  expect(writes).toEqual(["POST /api/proactive/settings/p1/run"]);
  expect(
    await within(dialog).findByText(`Skipped just now. ${NOTHING_TO_READ}`),
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
  const view = draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /Expenses/ }));
  const dialog = await view.findByRole("dialog");
  expect(
    within(dialog).getByText("Checked 2 hours ago. Found 2 things for you."),
  ).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Run now" }));
  expect(
    await within(dialog).findByText("Queued. It checks in within a minute."),
  ).toBeTruthy();
});

test("Turn on check-ins is offered only for a Bot without them, and lists its own conversations, never a task's", async () => {
  const on = draw();
  await on.findByRole("button", { name: /Expenses/ });
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
  await user.click(await off.findByRole("combobox", { name: "Conversation" }));
  await waitFor(() =>
    expect(
      off.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Expenses: Expense reports"]),
  );
});
