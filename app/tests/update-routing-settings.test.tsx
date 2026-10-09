import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { UpdateRoutingSection } from "@/components/settings/update-routing";

/**
 * Where updates go, now in Settings: one decision for all of a person's Bots, so it is no longer
 * repeated on every Bot's page.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const writes: { request: string; body: unknown }[] = [];
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
    return Response.json({
      routing: { progress: ["push"], decision: "all", question: "all" },
    });
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
