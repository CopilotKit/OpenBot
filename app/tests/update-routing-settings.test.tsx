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
let routing: Record<string, unknown> = {
  progress: ["push"],
  decision: "all",
  question: "all",
};
afterEach(() => {
  routing = { progress: ["push"], decision: "all", question: "all" };
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
    // A deployment with every channel set up, so each switch reflects the person's preference.
    if (String(input).endsWith("/api/delivery")) {
      return Response.json({
        bindings: [],
        devices: [],
        deliveries: [],
        available: { slack: true, teams: true, sms: true, push: true },
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

test("pings get their own row, Something needs you, once the server routes them", async () => {
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

test("with no ping routing from the server there is no row for it to promise", async () => {
  serving();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
  expect(await view.findByText("Questions")).toBeTruthy();
  expect(view.queryByText("Something needs you")).toBeNull();
});
