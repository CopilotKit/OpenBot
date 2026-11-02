import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { RecentDeliveries } from "@/components/settings/devices";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → Notifications, Recent deliveries: every message OpenBot sent the person outside the web
 * app, named in the words the rest of the page uses. A row once read "push · attention" and
 * "failed": the server's own names for the channel, the kind and the state.
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

/** One `delivery_outbox` row as `/api/delivery` returns it. */
const delivery = (
  id: string,
  transport: string,
  kind: string,
  state: string,
  error: string | null = null,
) => ({
  id,
  ownerUserId: "person",
  channelId: "channel",
  agentId: "bot",
  threadId: "thread",
  bindingId: null,
  deviceId: null,
  transport,
  text: "What was sent",
  kind,
  requestId: null,
  state,
  providerId: null,
  error,
  createdAt: "2026-10-30T22:24:30Z",
  updatedAt: "2026-10-30T22:24:30Z",
});

function draw(deliveries: ReturnType<typeof delivery>[]) {
  global.fetch = (async (input: RequestInfo | URL) =>
    String(input).endsWith("/api/delivery")
      ? Response.json({
          bindings: [],
          devices: [],
          deliveries,
          available: { slack: true, teams: true, sms: true, push: true },
        })
      : new Response(null, { status: 404 })) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RecentDeliveries />
    </QueryClientProvider>,
  );
}

const rowOf = (title: HTMLElement) =>
  title.closest('[data-slot="item-content"]')?.textContent ?? "";

test("each row names its kind and its channel in the words the routing switches use", async () => {
  const view = draw([
    delivery(
      "ping",
      "push",
      "attention",
      "failed",
      "Expo delivery failed (DeviceNotRegistered).",
    ),
    delivery("reply", "slack", "reply", "delivered"),
    delivery("approval", "teams", "approval", "sent"),
    delivery("question", "sms", "question", "queued"),
  ]);
  const ping = rowOf(await view.findByText("Something needs you"));
  expect(ping).toContain("Push");
  expect(ping).toContain("Failed");
  expect(ping).toContain("Expo delivery failed (DeviceNotRegistered).");
  expect(rowOf(view.getByText("Progress"))).toContain("Slack");
  expect(rowOf(view.getByText("Progress"))).toContain("Delivered");
  expect(rowOf(view.getByText("Decision"))).toContain("Microsoft Teams");
  expect(rowOf(view.getByText("Decision"))).toContain("Sent");
  expect(rowOf(view.getByText("Question"))).toContain("SMS");
  expect(rowOf(view.getByText("Question"))).toContain("Waiting to send");
  const page = view.container.textContent ?? "";
  for (const raw of ["attention", "push ·", "slack ·", "teams", "sms ·"])
    expect(page).not.toContain(raw);
});

test("a state with no plain word of its own is never shown as the server's name for it", async () => {
  const view = draw([
    delivery(
      "unsure",
      "slack",
      "attention",
      "unknown",
      "OpenTag delivery failed (invalid_auth).",
    ),
    delivery(
      "stopped",
      "sms",
      "attention",
      "opted_out",
      "Twilio reports this number opted out (21610). Nothing was sent.",
    ),
    delivery("handed", "push", "reply", "accepted"),
    delivery("going", "slack", "question", "running"),
  ]);
  expect(await view.findAllByText("Something needs you")).toHaveLength(2);
  const page = view.container.textContent ?? "";
  for (const raw of ["unknown", "opted_out", "accepted", "running"])
    expect(page).not.toContain(raw);
  expect(page).toContain("Not confirmed");
  expect(page).toContain("Not sent");
  expect(page).toContain("Sending");
});
