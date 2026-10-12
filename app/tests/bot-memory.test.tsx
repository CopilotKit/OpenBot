import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
/** A refusal the server gives the next write, or none. */
let refuseWrite: string | null = null;
/** The settings the Drive search action takes. */
let searchSettings: Record<string, unknown> = {};
function serving() {
  requested.length = 0;
  refuseWrite = null;
  searchSettings = {};
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    if (init?.method && init.method !== "GET") {
      if (refuseWrite) {
        const error = refuseWrite;
        refuseWrite = null;
        return Response.json({ error }, { status: 400 });
      }
      return Response.json({ ok: true });
    }
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
            inputSchema: { properties: searchSettings },
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

/** Opens Add source for the Expenses Bot and chooses its one read action. */
async function openAddSource(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({ document });
  await view.findByText("Receipts folder");
  await user.click(view.getByRole("button", { name: "Add source" }));
  await user.click(
    await view.findByRole("combobox", { name: "Connected app action" }),
  );
  await user.click(await view.findByRole("option", { name: "Search Drive" }));
  return user;
}

test("an action setting called name is its own field, not the source name", async () => {
  serving();
  searchSettings = { name: { type: "string" } };
  const view = draw(<MemorySources agentId="expenses" />);
  await openAddSource(view);
  const setting = await view.findByLabelText("name");
  expect(setting).not.toBe(view.getByLabelText("Source name"));
});

test("reopening Add source after a failure keeps the draft but not the failure", async () => {
  serving();
  const view = draw(<MemorySources agentId="expenses" />);
  const user = await openAddSource(view);
  await user.type(view.getByLabelText("Source name"), "Invoices");
  refuseWrite = "That folder cannot be read.";
  await user.click(view.getByRole("button", { name: "Add and sync source" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "That folder cannot be read.",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(view.getByRole("button", { name: "Add source" }));
  const name = (await view.findByLabelText("Source name")) as HTMLInputElement;
  expect(name.value).toBe("Invoices");
  expect(view.queryByRole("alert")).toBeNull();
});

test("reopening a research row after a failure starts without it", async () => {
  serving();
  const view = draw(<ProactiveResearchSettings agentId="expenses" />);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /Expenses/ }));
  refuseWrite = "Research is paused.";
  await user.click(await view.findByRole("button", { name: "Run now" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Research is paused.",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(view.getByRole("button", { name: /Expenses/ }));
  await view.findByRole("button", { name: "Run now" });
  expect(view.queryByRole("alert")).toBeNull();
});
