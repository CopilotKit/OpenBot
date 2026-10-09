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
 * browser notification those rows used to send.
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
  ...counts,
});

let served: ReturnType<typeof attention>[] = [];
function serving(bots: ReturnType<typeof attention>[]) {
  served = bots;
  global.fetch = (async () =>
    Response.json({ bots: served })) as unknown as typeof fetch;
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
  const sent: string[] = [];
  globalThis.Notification = Object.assign(
    function (this: unknown, title: string) {
      sent.push(title);
    },
    { permission: "granted" },
  ) as unknown as typeof Notification;
  serving([attention("expenses", {})]);
  const { client } = draw();
  await waitFor(() =>
    expect(client.getQueryState(botLifecycleKeys.attention)?.status).toBe(
      "success",
    ),
  );
  // The state on arrival is not news.
  expect(sent).toEqual([]);

  served = [attention("expenses", { questions: 1 })];
  await act(async () => {
    await client.refetchQueries({ queryKey: botLifecycleKeys.attention });
  });
  await waitFor(() => expect(sent).toEqual(["Expenses needs you"]));
});
