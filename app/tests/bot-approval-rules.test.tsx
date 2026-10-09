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
import { BotApprovalRules } from "@/components/approvals/bot-rules";
import { settleReactWork } from "./settle-react-work";

/** A Bot's Approval rules page: the person's rules for this Bot, and the team rules that reach it. */

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

const rule = (id: string, botId: string, toolRef: string) => ({
  id,
  botId,
  toolRef,
  effect: "*",
  scope: "*",
  behaviour: "ask",
});

const sent: { path: string; method: string; body: unknown }[] = [];
function serving() {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      sent.push({
        path: url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({ ok: true });
    }
    return Response.json({
      enabled: true,
      requests: [],
      questions: [],
      rules: [
        rule("mine", "expenses", "mcp/gmail/*"),
        rule("other", "knowledge", "mcp/drive/*"),
        rule("every", "*", "mcp/slack/*"),
      ],
      teamRules: [
        rule("team-every", "*", "mcp/drive/share"),
        rule("team-expenses", "expenses", "computer_click"),
        rule("team-knowledge", "knowledge", "host/*"),
      ],
      preferences: { enabled: true, autoReview: false, hostCommands: "ask" },
      team: {
        enforceAutoReview: false,
        customRulesEnabled: true,
        hostCommandsCap: "allow",
      },
      hostCommands: "ask",
    });
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <BotApprovalRules agentId="expenses" />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("only this Bot's own rules can be changed, and the team rules that reach it are shown locked", async () => {
  serving();
  const view = draw();
  expect(
    await view.findByRole("combobox", { name: "Behaviour for mcp/gmail/*" }),
  ).toBeTruthy();
  expect(
    view.queryByRole("combobox", { name: "Behaviour for mcp/drive/*" }),
  ).toBeNull();
  expect(
    view.queryByRole("combobox", { name: "Behaviour for mcp/slack/*" }),
  ).toBeNull();
  expect(view.getByText("mcp/drive/share")).toBeTruthy();
  expect(view.getByText(/^computer_click/)).toBeTruthy();
  expect(view.queryByText(/^host\/\*/)).toBeNull();
});

test("a rule added here is for this Bot, with no Bot to type", async () => {
  serving();
  const view = draw();
  await view.findByText("Add a rule");
  expect(view.queryByRole("textbox", { name: "Bot" })).toBeNull();
  const user = userEvent.setup({ document });
  await user.type(
    view.getByRole("textbox", { name: "Tool or app" }),
    "mcp/notion/*",
  );
  fireEvent.submit(
    view
      .getByRole("button", { name: "Save rule" })
      .closest("form") as HTMLFormElement,
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/rules",
      method: "POST",
      body: {
        botId: "expenses",
        toolRef: "mcp/notion/*",
        effect: "*",
        scope: "*",
        behaviour: "ask",
      },
    }),
  );
});

test("a personal rule whose Bot is a pattern matching this Bot is shown and can be removed here", async () => {
  serving();
  const served = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await served(input, init);
    if (String(input) !== "/api/approvals" || init?.method) return response;
    const body = await response.json();
    body.rules.push(rule("pattern", "exp*", "mcp/linear/*"));
    return Response.json(body);
  }) as unknown as typeof fetch;
  const view = draw();
  expect(
    await view.findByRole("combobox", { name: "Behaviour for mcp/linear/*" }),
  ).toBeTruthy();
});
