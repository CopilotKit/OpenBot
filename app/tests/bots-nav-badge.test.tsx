import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The badge on the sidebar's Bots item: how many things wait on the person across every Bot, or a
 * dot when only something unread does. It replaced one sidebar row per Bot, so it also carries the
 * browser notifications those rows used to send, and the one each check-in ping sends.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const originalNotification = globalThis.Notification;
afterEach(() => {
  global.fetch = originalFetch;
  globalThis.Notification = originalNotification;
});

const attention = (
  agentId: string,
  counts: Partial<{
    questions: number;
    approvals: number;
    handoffs: number;
    unread: number;
    items: number;
    tasks: { needsInput: number; ready: number; failed: number };
  }>,
) => ({
  agentId,
  name: agentId === "expenses" ? "Expenses" : "Knowledge",
  questions: 0,
  approvals: 0,
  handoffs: 0,
  unread: 0,
  paused: false,
  notify: "all",
  items: 0,
  tasks: { needsInput: 0, ready: 0, failed: 0 },
  ...counts,
});

/** An open item as `/api/proactive/suggestions` lists it, carried by `pingId`. */
const item = (id: string, agentId: string, title: string, pingId: string) => ({
  id,
  agentId,
  title,
  detail: "Why it was raised.",
  sourceApp: "Gmail",
  sourceRef: "gmail/message",
  sourceLink: null,
  pingId,
  createdAt: "2026-10-30T10:00:00Z",
});

let served: ReturnType<typeof attention>[] = [];
let lastPingId: string | null = null;
let items: ReturnType<typeof item>[] = [];
function serving(bots: ReturnType<typeof attention>[]) {
  served = bots;
  global.fetch = (async (input: RequestInfo | URL) =>
    String(input) === "/api/proactive/suggestions"
      ? Response.json({ suggestions: items })
      : Response.json({
          bots: served,
          lastPingId,
        })) as unknown as typeof fetch;
}
afterEach(() => {
  lastPingId = null;
  items = [];
});

/** Stands in for the browser's Notification, recording each one it is asked to show. */
function notifications() {
  const sent: { title: string; body?: string; tag?: string }[] = [];
  globalThis.Notification = Object.assign(
    function (this: unknown, title: string, options?: NotificationOptions) {
      sent.push({ title, body: options?.body, tag: options?.tag });
    },
    { permission: "granted" },
  ) as unknown as typeof Notification;
  return sent;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <BotsNavBadge />
    </QueryClientProvider>,
  );
  return { view, client };
}

test("the badge adds up what waits on the person across every Bot", async () => {
  serving([
    attention("expenses", { questions: 1, approvals: 1 }),
    attention("knowledge", { handoffs: 1, unread: 4 }),
  ]);
  const { view } = draw();
  const badge = await view.findByText("3");
  expect(badge.getAttribute("aria-label")).toBe("3 things need you");
});

test("with only unread messages the badge is a dot, not a number", async () => {
  serving([attention("expenses", { unread: 2 })]);
  const { view } = draw();
  expect(await view.findByLabelText("Unread messages")).toBeTruthy();
  expect(view.container.textContent).toBe("");
});

test("with nothing waiting there is no badge", async () => {
  serving([attention("expenses", {})]);
  const { view, client } = draw();
  await waitFor(() =>
    expect(client.getQueryState(botLifecycleKeys.attention)?.status).toBe(
      "success",
    ),
  );
  expect(view.container.innerHTML).toBe("");
});

test("a Bot that starts needing the person sends a browser notification", async () => {
  const notices = notifications();
  serving([attention("expenses", {})]);
  const { client } = draw();
  await waitFor(() =>
    expect(client.getQueryState(botLifecycleKeys.attention)?.status).toBe(
      "success",
    ),
  );
  // The state on arrival is not news.
  expect(notices).toEqual([]);

  served = [attention("expenses", { questions: 1 })];
  await act(async () => {
    await client.refetchQueries({ queryKey: botLifecycleKeys.attention });
  });
  await waitFor(() =>
    expect(notices.map((notice) => notice.title)).toEqual([
      "Expenses needs you",
    ]),
  );
});

test("a task that starts waiting on the person sends a browser notification, though no approval count rose", async () => {
  const notices = notifications();
  serving([attention("expenses", {})]);
  const { client } = draw();
  await waitFor(() =>
    expect(client.getQueryState(botLifecycleKeys.attention)?.status).toBe(
      "success",
    ),
  );
  // The server counts a task's approval as the task needing input, never as an approval too.
  served = [
    attention("expenses", { tasks: { needsInput: 1, ready: 0, failed: 0 } }),
  ];
  await act(async () => {
    await client.refetchQueries({ queryKey: botLifecycleKeys.attention });
  });
  await waitFor(() =>
    expect(notices).toEqual([
      {
        title: "Expenses needs you",
        body: "1 task waiting on you",
        tag: "openbot-attention-expenses",
      },
    ]),
  );
});

test("the badge counts check-in items and the tasks waiting on the person, each once", async () => {
  serving([
    attention("expenses", {
      items: 2,
      // An approval in the person's own conversation. The server counts one a task waits on as the
      // task needing input instead, never as both, so every number here is added once.
      approvals: 1,
      tasks: { needsInput: 1, ready: 1, failed: 1 },
    }),
    attention("knowledge", { items: 1 }),
  ]);
  const { view } = draw();
  const badge = await view.findByText("7");
  expect(badge.getAttribute("aria-label")).toBe("7 things need you");
});

test("a ping of three items sends one browser notification, and nothing more until the next ping", async () => {
  const sent = notifications();
  serving([attention("expenses", {}), attention("knowledge", {})]);
  const { client } = draw();
  await waitFor(() =>
    expect(client.getQueryState(botLifecycleKeys.attention)?.status).toBe(
      "success",
    ),
  );

  // A ping folds three items from two Bots into one message.
  lastPingId = "ping-1";
  items = [
    item("s1", "expenses", "Approve the March invoice", "ping-1"),
    item("s2", "expenses", "Reply to Dana", "ping-1"),
    item("s3", "knowledge", "Fix the stale onboarding page", "ping-1"),
  ];
  served = [
    attention("expenses", { items: 2 }),
    attention("knowledge", { items: 1 }),
  ];
  await act(async () => {
    await client.refetchQueries({ queryKey: botLifecycleKeys.attention });
  });
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    title: "Your Bots",
    body: "3 things need you: Approve the March invoice; Reply to Dana; Fix the stale onboarding page",
    tag: "openbot-ping-ping-1",
  });

  // The same ping read again, and an item raised after it that waits for the hourly slot: no news.
  items = [...items, item("s4", "expenses", "Book the venue", "ping-2")];
  served = [
    attention("expenses", { items: 3 }),
    attention("knowledge", { items: 1 }),
  ];
  await act(async () => {
    await client.refetchQueries({ queryKey: botLifecycleKeys.attention });
  });
  await settleReactWork();
  expect(sent).toHaveLength(1);

  // The next ping is news again, and names its one Bot.
  lastPingId = "ping-2";
  await act(async () => {
    await client.refetchQueries({ queryKey: botLifecycleKeys.attention });
  });
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toEqual({
    title: "Expenses",
    body: "One thing needs you: Book the venue",
    tag: "openbot-ping-ping-2",
  });
});

test("a ping already sent when the page opened is not announced again", async () => {
  const sent = notifications();
  lastPingId = "ping-1";
  items = [item("s1", "expenses", "Approve the March invoice", "ping-1")];
  serving([attention("expenses", { items: 1 })]);
  const { client } = draw();
  await waitFor(() =>
    expect(client.getQueryState(botLifecycleKeys.attention)?.status).toBe(
      "success",
    ),
  );
  await act(async () => {
    await client.refetchQueries({ queryKey: botLifecycleKeys.attention });
  });
  await settleReactWork();
  expect(sent).toEqual([]);
});
