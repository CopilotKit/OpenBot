import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  backtestHeadline,
  replayWords,
} from "@/components/approvals/describe-rules";
import type {
  ApprovalBacktest,
  ApprovalRulesPreview,
} from "@/lib/approval-rules/queries";
import type { ApprovalRuleTranslation } from "@/lib/approval-rules/translate";
import type { ApprovalRuleInput } from "@/lib/approvals";
import { Route as DescribeRoute } from "@/routes/_authed/admin/approvals_.describe";

/**
 * Team approval rules described in English, on Admin → Approvals → Describe it in words: the model's
 * rules land as fields the admin can change, beside their independent reading and whether they
 * check; what they would have changed is replayed as they are edited; and only Save adds them, with
 * the sentence. The server is a fake that answers as the real routes do.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const SALES = "agent_5e2f8a90-1c3b-4d6e-8f70-a1b2c3d4e5f6";

/** What the real endpoint answered for this description, through the real screen. */
const OPPORTUNITIES: ApprovalRuleTranslation = {
  rules: [
    {
      toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY*",
      effect: "write",
      scope: "composio-salesforce",
      botId: SALES,
      behaviour: "allow",
    },
  ],
  summary:
    "The Sales Assistant updates Salesforce opportunities without asking.",
  explanation:
    "The Sales Assistant updates Salesforce opportunities with the two listed opportunity-update tools without asking.",
  check: { ok: true },
  warning: null,
};

const REPORT: ApprovalBacktest = {
  scanned: 22,
  matched: 4,
  changed: 4,
  removedAsks: 4,
  removedDenied: 1,
  addedAsks: 0,
  fixed: 0,
  changes: [
    {
      id: "audit-1",
      createdAt: "2026-11-09T21:16:20.000Z",
      ownerUserId: "user-ben",
      initiator: { kind: "person", id: null },
      bot: SALES,
      toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY",
      effect: "write",
      scope: "composio-salesforce",
      subject: {},
      was: "ask",
      wasSource: "default",
      would: "allow",
      change: "removes_ask",
      person: "deny",
      rule: 1,
      reason: "Rule 1 takes action without asking.",
    },
  ],
};

const sent: { path: string; body: Record<string, unknown> }[] = [];
const originalFetch = global.fetch;

/** The check the real backtest route makes of rows as they stand. */
function checked(rules: ApprovalRuleInput[]): ApprovalRulesPreview {
  const bad = rules.findIndex((rule) => rule.toolRef.startsWith("mcp/"));
  return {
    check:
      bad === -1
        ? { ok: true }
        : {
            ok: false,
            error: "no tool here starts with mcp/",
            problems: [
              {
                row: bad + 1,
                field: "toolRef",
                message: `"${rules[bad]?.toolRef}" matches no tool: no tool here starts with mcp/.`,
              },
            ],
          },
    warning: null,
    report:
      bad === -1
        ? REPORT
        : {
            ...REPORT,
            matched: 0,
            changed: 0,
            removedAsks: 0,
            removedDenied: 0,
            changes: [],
          },
  };
}

beforeEach(() => {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") sent.push({ path, body });
    if (path.endsWith("/api/approvals/team/rules/translate"))
      return Response.json(OPPORTUNITIES);
    if (path.endsWith("/api/approvals/team/rules/backtest"))
      return Response.json(checked(body.rules));
    if (path.endsWith("/api/approvals/team/rules/batch"))
      return Response.json({ rules: body.rules }, { status: 201 });
    if (path.includes("/api/agents"))
      return Response.json({
        agents: [{ id: SALES, name: "Sales Assistant" }],
      });
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function open() {
  const root = createRootRoute({ component: Outlet });
  const approvals = createRoute({
    path: "/admin/approvals",
    getParentRoute: () => root,
    component: () => null,
  });
  const describe = (
    DescribeRoute as unknown as { update: (options: unknown) => never }
  ).update({
    id: "/admin/approvals_/describe",
    path: "/admin/approvals/describe",
    getParentRoute: () => root,
  });
  const router = createRouter({
    routeTree: root.addChildren([approvals, describe]),
    history: createMemoryHistory({
      initialEntries: ["/admin/approvals/describe"],
    }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

async function describeRules(view: ReturnType<typeof render>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByLabelText("Describe the rules"), text);
  await user.click(view.getByRole("button", { name: "Write rules" }));
}

const TEXT =
  "Let the sales assistant update opportunities in Salesforce without asking";

test("a description fills the rules, shows their reading and check, replays them, and Save adds them with the sentence", async () => {
  const { view, router } = open();
  await describeRules(view, TEXT);

  expect(
    await view.findByText(OPPORTUNITIES.explanation as string),
  ).toBeTruthy();
  expect(
    view.getByText(
      "Checks. Every rule matches tools and Bots this OpenBot has.",
    ),
  ).toBeTruthy();
  // The rows, as fields that stay editable.
  expect((view.getByLabelText("Tool or app") as HTMLInputElement).value).toBe(
    "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY*",
  );
  // Replayed as soon as they rest, and the asks a person denied are counted.
  expect(
    await view.findByText(
      "Would have changed 4 decisions: removes 4 asks, of which 1 a person had denied; adds 0 asks.",
    ),
  ).toBeTruthy();
  expect(view.getByText("A person denied it.")).toBeTruthy();
  expect(sent.filter((call) => call.path.endsWith("/batch"))).toHaveLength(0);

  const save = view.getByRole("button", { name: "Save rules" });
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  await waitFor(() =>
    expect(sent.filter((call) => call.path.endsWith("/batch"))).toHaveLength(1),
  );
  expect(sent.find((call) => call.path.endsWith("/batch"))?.body).toEqual({
    rules: OPPORTUNITIES.rules,
    authoring: { source: "english", text: TEXT },
  });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/approvals"),
  );
});

test("an edit after the rules were written is called out, checked as it stands, and can't be saved until it checks", async () => {
  const { view } = open();
  await describeRules(view, TEXT);
  await view.findByText(OPPORTUNITIES.explanation as string);
  expect(view.queryByText(/You've changed the rules/)).toBeNull();

  const user = userEvent.setup({ document: view.container.ownerDocument });
  const tool = view.getByLabelText("Tool or app") as HTMLInputElement;
  await user.clear(tool);
  await user.type(tool, "mcp/salesforce/*");

  expect(
    view.getByText(
      "You've changed the rules since they were written. The check and the reading above are for the written rules, not your edit.",
    ),
  ).toBeTruthy();
  // The live check says what is wrong with the edit, under the field.
  expect(
    await view.findByText(
      '"mcp/salesforce/*" matches no tool: no tool here starts with mcp/.',
    ),
  ).toBeTruthy();
  expect(
    (view.getByRole("button", { name: "Save rules" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  // Put right, it checks again and can be saved, still from the sentence.
  await user.clear(tool);
  await user.type(tool, "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY");
  await waitFor(() =>
    expect(
      (view.getByRole("button", { name: "Save rules" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

test("the headline counts what changed and never what a safety requirement decided", () => {
  expect(backtestHeadline(REPORT)).toBe(
    "Would have changed 4 decisions: removes 4 asks, of which 1 a person had denied; adds 0 asks.",
  );
  const none = {
    ...REPORT,
    changed: 0,
    removedAsks: 0,
    removedDenied: 0,
    matched: 2,
    fixed: 2,
  };
  expect(backtestHeadline(none)).toBe("Would have changed no decisions.");
  expect(replayWords(none, true)).toBe(
    "Replayed over the last 22 actions OpenBot checked. These rules are about 2 of them. 2 were decided by a safety requirement, auto-review or a task, which rules don't change. Actions that ran with nothing to check aren't recorded, so a new ask can reach further than this shows.",
  );
});
