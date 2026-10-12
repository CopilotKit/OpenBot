import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryList, RememberFact } from "@/components/memory/memories";
import { settleReactWork } from "./settle-react-work";

/** Settings → Memory: what the person's Bots know about them, and which Bot learned it. */

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

const memory = (overrides: Record<string, unknown>) => ({
  id: "m1",
  content: "I prefer mornings.",
  provenance: "You told a Bot",
  sourceId: null,
  enabled: true,
  reviewState: "confirmed",
  formedBy: "person",
  formedByAgentId: null,
  sourceApp: null,
  sourceLink: null,
  observedAt: null,
  updatedAt: "2026-10-09T10:00:00Z",
  ...overrides,
});

const writes: { request: string; body: unknown }[] = [];
/** A refusal the server gives the next write, or none. */
let refuseWrite: string | null = null;
function serving() {
  writes.length = 0;
  refuseWrite = null;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${url}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (refuseWrite) {
        const error = refuseWrite;
        refuseWrite = null;
        return Response.json({ error }, { status: 400 });
      }
      return Response.json({ ok: true });
    }
    if (url.startsWith("/api/agents")) {
      return Response.json({
        agents: [{ id: "expenses", name: "Expenses", mine: true }],
      });
    }
    return Response.json({
      memories: [
        memory({}),
        memory({
          id: "m2",
          content: "Receipts go to finance@.",
          formedBy: "bot",
          formedByAgentId: "expenses",
          sourceApp: "Gmail",
          reviewState: "unreviewed",
        }),
      ],
    });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

test("a memory a Bot formed names the Bot that formed it", async () => {
  serving();
  const view = draw(<MemoryList />);
  expect(await view.findByText(/Formed by Expenses/)).toBeTruthy();
});

test("remembering a fact saves it", async () => {
  serving();
  const view = draw(<RememberFact />);
  const user = userEvent.setup({ document });
  // The form lives in a dialog behind the page's action, not on the page.
  fireEvent.click(view.getByRole("button", { name: "Remember a fact" }));
  await user.type(
    await view.findByRole("textbox", {
      name: "Something you want your Bots to know",
    }),
    "I work from Lisbon.",
  );
  fireEvent.click(view.getByRole("button", { name: "Remember" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/memory",
      body: { content: "I work from Lisbon." },
    }),
  );
});

test("each memory's switch is named for the memory it turns on or off", async () => {
  serving();
  const view = draw(<MemoryList />);
  expect(
    await view.findByRole("switch", {
      name: "Use this memory: I prefer mornings.",
    }),
  ).toBeTruthy();
  expect(
    view.getByRole("switch", {
      name: "Use this memory: Receipts go to finance@.",
    }),
  ).toBeTruthy();
});

test("reopening Remember a fact after a failure starts clean", async () => {
  serving();
  refuseWrite = "Memory is full.";
  const view = draw(<RememberFact />);
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Remember a fact" }));
  await user.type(
    await view.findByRole("textbox", {
      name: "Something you want your Bots to know",
    }),
    "I work from Lisbon.",
  );
  await user.click(view.getByRole("button", { name: "Remember" }));
  expect((await view.findByRole("alert")).textContent).toBe("Memory is full.");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(view.getByRole("button", { name: "Remember a fact" }));
  const field = (await view.findByRole("textbox", {
    name: "Something you want your Bots to know",
  })) as HTMLTextAreaElement;
  expect(field.value).toBe("");
  expect(view.queryByRole("alert")).toBeNull();
});
