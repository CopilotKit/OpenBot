import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { UpdateRoutingSection } from "@/components/settings/update-routing";
import { settleReactWork } from "./settle-react-work";

/**
 * Where updates go, now in Settings: one decision for all of a person's Bots, so it is no longer
 * repeated on every Bot's page.
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

const writes: { request: string; body: unknown }[] = [];
const everyKind = {
  progress: ["push"],
  decision: "all",
  question: "all",
  attention: "all",
};
const everyChannel = { slack: true, teams: true, sms: true, push: true };
let routing: Record<string, unknown> = everyKind;
let available: Record<string, boolean> = everyChannel;
afterEach(() => {
  routing = everyKind;
  available = everyChannel;
});
function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${String(input)}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ ok: true });
    }
    // Every channel set up unless a case says otherwise, so each switch reflects the person's preference.
    if (String(input).endsWith("/api/delivery")) {
      return Response.json({
        bindings: [],
        devices: [],
        deliveries: [],
        available,
      });
    }
    return Response.json({ routing });
  }) as unknown as typeof fetch;
}

test("switching a transport on for one kind of update saves that kind's transports", async () => {
  serving();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
  fireEvent.click(await view.findByRole("switch", { name: "Progress by SMS" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    request: "PUT /api/bots/routing/progress",
    body: { transports: ["push", "sms"] },
  });
});

test("pings get their own row, Something needs you", async () => {
  routing = {
    progress: ["push"],
    decision: "all",
    question: "all",
    attention: ["push", "slack"],
  };
  serving();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
  expect(await view.findByText("Something needs you")).toBeTruthy();
  const sms = view.getByRole("switch", { name: "Something needs you by SMS" });
  expect(sms.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(sms);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    request: "PUT /api/bots/routing/attention",
    body: { transports: ["push", "slack", "sms"] },
  });
});

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
}

test("only channels that are set up get a switch, and a save keeps the others as they were", async () => {
  available = { slack: true, teams: false, sms: false, push: true };
  routing = { ...everyKind, progress: ["push", "sms"] };
  serving();
  const view = draw();
  const slack = await view.findByRole("switch", { name: "Progress by Slack" });
  expect(view.queryByRole("switch", { name: "Progress by SMS" })).toBeNull();
  expect(view.queryByText("Microsoft Teams")).toBeNull();
  expect(view.queryByText("Not set up")).toBeNull();
  fireEvent.click(slack);
  await waitFor(() => expect(writes).toHaveLength(1));
  // SMS is not set up and has no switch, but the person's choice for it is still saved as it was.
  expect(writes[0]).toEqual({
    request: "PUT /api/bots/routing/progress",
    body: { transports: ["push", "slack", "sms"] },
  });
});

test("with no channel set up, one sentence says updates stay in OpenBot", async () => {
  available = { slack: false, teams: false, sms: false, push: false };
  serving();
  const view = draw();
  expect(await view.findByText("Updates stay in OpenBot")).toBeTruthy();
  expect(view.queryAllByRole("switch")).toHaveLength(0);
});
