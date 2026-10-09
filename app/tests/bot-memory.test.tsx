import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemorySources } from "@/components/memory/sources";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import { settleReactWork } from "./settle-react-work";

/** A Bot's Memory page: the apps that feed it facts, and its background research. */

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

const source = (id: string, agentId: string, title: string) => ({
  id,
  title,
  agentId,
  toolRef: "mcp/drive/search",
  enabled: true,
  syncStatus: "succeeded",
  syncError: null,
  lastSyncAt: null,
});

const research = (id: string, agentId: string, focus: string) => ({
  id,
  agentId,
  channelId: `channel-${agentId}`,
  focus,
  enabled: true,
  intervalMinutes: 240,
  nextRunAt: "2026-10-09T12:00:00Z",
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
});

const requested: string[] = [];
function serving() {
  requested.length = 0;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url === "/api/memory/sources") {
      return Response.json({
        sources: [
          source("s1", "expenses", "Receipts folder"),
          source("s2", "knowledge", "Wiki pages"),
        ],
      });
    }
    if (url.startsWith("/api/memory/sources/available/")) {
      return Response.json({
        tools: [
          {
            ref: "mcp/drive/search",
            title: "Search Drive",
            description: "",
            inputSchema: {},
          },
        ],
      });
    }
    if (url === "/api/proactive/settings") {
      return Response.json({
        settings: [
          research("p1", "expenses", "Unpaid invoices"),
          research("p2", "knowledge", "Stale pages"),
        ],
      });
    }
    if (url.startsWith("/api/channels")) {
      return Response.json({ channels: [], nextCursor: null });
    }
    return Response.json({
      agents: [
        { id: "expenses", name: "Expenses" },
        { id: "knowledge", name: "Knowledge" },
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

test("only this Bot's sources are listed, and its app actions load without picking a Bot", async () => {
  serving();
  const view = draw(<MemorySources agentId="expenses" />);
  expect(await view.findByText("Receipts folder")).toBeTruthy();
  expect(view.queryByText("Wiki pages")).toBeNull();
  expect(view.queryByRole("combobox", { name: /^Bot/ })).toBeNull();
  await waitFor(() =>
    expect(requested).toContain("/api/memory/sources/available/expenses"),
  );
});

test("only this Bot's background research is listed, with no Bot to pick", async () => {
  serving();
  const view = draw(<ProactiveResearchSettings agentId="expenses" />);
  expect(await view.findByText(/Unpaid invoices/)).toBeTruthy();
  expect(view.queryByText(/Stale pages/)).toBeNull();
  expect(view.queryByRole("combobox", { name: /^Bot/ })).toBeNull();
});
