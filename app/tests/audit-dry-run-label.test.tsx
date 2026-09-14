import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { agentKeys } from "@/lib/agents/queries";
import { auditKeys } from "@/lib/audit/queries";
import { Route as AuditRoute } from "@/routes/_authed/admin/audit";

beforeAll(() => GlobalRegistrator.register());

afterEach(() => cleanup());

afterAll(() => GlobalRegistrator.unregister());

const DRY_RUN_LINE = "dry-run: recorded, not enforced";

function event(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const tool = eventType.startsWith("mcp.");
  return {
    id: "event-1",
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType: tool ? "mcp_tool" : "computer",
    targetId: tool ? "google-drive/search_files" : "bot-a",
    payload: { bot: "bot-a", actor: "person@example.test", ...payload },
    createdAt: new Date(0).toISOString(),
  };
}

async function renderAuditRow(row: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData([...auditKeys.all, ""], { events: [row] });
  queryClient.setQueryData(agentKeys.list(false), []);
  const rootRoute = createRootRoute({
    component: AuditRoute.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("Decision");
  return within(view.container.querySelector("tbody") as HTMLElement);
}

test("a dry-run refusal that went ahead says it was not enforced", async () => {
  const row = await renderAuditRow(
    event("computer.action_refused", {
      action: "computer_click",
      decision: {
        allowed: false,
        mode: "dry-run",
        source: "deny",
        rule: 'element.name == "Submit"',
        carriedOut: true,
      },
    }),
  );
  expect(row.queryByText(DRY_RUN_LINE)).not.toBeNull();
});

test("an action a dry-run policy allowed has nothing to not enforce", async () => {
  const row = await renderAuditRow(
    event("computer.action_allowed", {
      action: "computer_click",
      decision: {
        allowed: true,
        mode: "dry-run",
        source: "allow",
        rule: "true",
        carriedOut: true,
      },
    }),
  );
  expect(row.queryByText("Allowed")).not.toBeNull();
  expect(row.queryByText(DRY_RUN_LINE)).toBeNull();
});

test("a tool call content inspection stopped is not described as not enforced", async () => {
  const row = await renderAuditRow(
    event("mcp.call_rejected", {
      server: "google-drive",
      tool: "search_files",
      refusal: "sensitive_tool_arguments",
      contentInspection: {
        reason: "sensitive_content",
        findings: [{ category: "credential_field", path: "$.nested.apiKey" }],
      },
      decision: {
        allowed: true,
        mode: "dry-run",
        source: "allow",
        rule: "true",
        carriedOut: true,
      },
    }),
  );
  expect(row.queryByText("Blocked")).not.toBeNull();
  expect(row.queryByText(DRY_RUN_LINE)).toBeNull();
});

test("an enforced refusal has no dry-run line", async () => {
  const row = await renderAuditRow(
    event("computer.action_refused", {
      action: "computer_click",
      decision: {
        allowed: false,
        mode: "enforce",
        source: "deny",
        rule: 'element.name == "Submit"',
        carriedOut: false,
      },
    }),
  );
  expect(row.queryByText(DRY_RUN_LINE)).toBeNull();
});
