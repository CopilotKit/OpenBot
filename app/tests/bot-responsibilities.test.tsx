import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";
import { settleReactWork } from "./settle-react-work";

/** A Bot's Responsibilities page: its own goals, and a new one that needs no Bot picked. */

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

const goal = (id: string, agentId: string, title: string) => ({
  id,
  agentId,
  channelId: `channel-${agentId}`,
  threadId: "thread",
  title,
  instruction: "Do it.",
  successCriteria: "Done.",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  updatedAt: "2026-10-09T10:00:00Z",
});

const channel = (id: string, name: string, agentIds: string[]) => ({
  id,
  name,
  agentIds,
  active: true,
  summary: null,
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: "2026-10-09T10:00:00Z",
  pinned: false,
  lastReadAt: null,
});

const writes: { request: string; body: unknown }[] = [];
function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${url}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ ok: true });
    }
    if (url === "/api/responsibilities") {
      return Response.json({
        responsibilities: [
          goal("g1", "expenses", "Reconcile receipts"),
          goal("g2", "knowledge", "Keep the wiki fresh"),
        ],
      });
    }
    if (url.startsWith("/api/channels")) {
      return Response.json({
        channels: [
          channel("channel-expenses", "Finance desk", ["expenses"]),
          channel("channel-knowledge", "Docs desk", ["knowledge"]),
        ],
        nextCursor: null,
      });
    }
    if (url.startsWith("/api/agents")) {
      return Response.json({
        agents: [
          { id: "expenses", name: "Expenses" },
          { id: "knowledge", name: "Knowledge" },
        ],
      });
    }
    return Response.json({ runs: [], triggers: [], requests: [] });
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <BotResponsibilities agentId="expenses" />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("only this Bot's responsibilities are listed", async () => {
  serving();
  const view = draw();
  expect(await view.findByText("Reconcile receipts")).toBeTruthy();
  expect(view.queryByText("Keep the wiki fresh")).toBeNull();
});

test("a new responsibility needs no Bot picked, and offers only this Bot's conversations", async () => {
  serving();
  const view = draw();
  await view.findByText("Reconcile receipts");
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /New responsibility/ }));
  expect(view.queryByRole("combobox", { name: /^Bot/ })).toBeNull();
  await user.click(view.getByRole("combobox", { name: /^Conversation/ }));
  const options = (await view.findAllByRole("option")).map(
    (option) => option.textContent,
  );
  expect(options).toContain("Finance desk");
  expect(options).not.toContain("Docs desk");

  await user.click(view.getByRole("option", { name: "Finance desk" }));
  await user.type(view.getByLabelText("Title"), "Close the month");
  await user.type(view.getByLabelText("Instruction"), "Close it.");
  await user.type(view.getByLabelText("Success criteria"), "Closed.");
  fireEvent.submit(
    (view.getByRole("button", { name: /Create/ }) as HTMLButtonElement)
      .form as HTMLFormElement,
  );
  await waitFor(() =>
    expect(writes.map((write) => write.body)).toContainEqual(
      expect.objectContaining({
        agentId: "expenses",
        channelId: "channel-expenses",
        title: "Close the month",
      }),
    ),
  );
});
