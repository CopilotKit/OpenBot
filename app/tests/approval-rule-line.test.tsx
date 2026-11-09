import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { RuleRow } from "@/components/approvals/rules";
import type { ApprovalRuleRow } from "@/lib/approvals";
import { settleReactWork } from "./settle-react-work";

/*
 * FOUND IN THE 1.0 RC1 MAC PASS: under a saved rule's title, the line that says what else it matches
 * read "write on host-grant-15407-1794112361547002000 for shopper-bot": the raw kind of action, the
 * id OpenBot gave a folder, and the Bot's id. It names the folder as Settings → Computer does, the
 * Bot by its name, and the kind of action in words.
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

const GRANT = "host-grant-15407-1794112361547002000";

function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/host-access")
      return Response.json({
        connected: true,
        grants: [
          {
            id: GRANT,
            botId: "shopper-bot",
            actorId: "me",
            displayName: "share",
          },
        ],
        pending: [],
      });
    if (url.startsWith("/api/agents"))
      return Response.json({ agents: [{ id: "shopper-bot", name: "Shop" }] });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

const rule = (overrides: Partial<ApprovalRuleRow>): ApprovalRuleRow =>
  ({
    id: "rule",
    botId: "*",
    toolRef: "host/write_file",
    effect: "*",
    scope: "*",
    behaviour: "allow",
    ...overrides,
  }) as ApprovalRuleRow;

function draw(row: ApprovalRuleRow) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RuleRow
        disabled={false}
        onChange={() => {}}
        onRevoke={() => {}}
        rule={row}
      />
    </QueryClientProvider>,
  );
}

test("a folder rule names the folder, the Bot and the kind of action in words", async () => {
  serving();
  const view = draw(
    rule({ id: "folder", botId: "shopper-bot", effect: "write", scope: GRANT }),
  );
  expect(await view.findByText("changes in share for Shop")).toBeTruthy();
  const text = view.container.textContent ?? "";
  expect(text).not.toContain("host-grant");
  expect(text).not.toContain("shopper-bot");
  expect(text).not.toMatch(/\bwrite\b/);
});

test("a rule on a folder no longer shared, for a Bot no longer here, says so", async () => {
  serving();
  const view = draw(
    rule({
      id: "gone",
      botId: "old-bot",
      effect: "read",
      scope: "host-grant-1-2",
    }),
  );
  expect(
    await view.findByText(
      "reading in a folder that's no longer shared for a Bot no longer here",
    ),
  ).toBeTruthy();
  expect(view.container.textContent ?? "").not.toContain("host-grant");
});

test("a kind of action with no words of its own is left unsaid", async () => {
  serving();
  const view = draw(
    rule({
      id: "custom",
      toolRef: "computer_click",
      effect: "teleport",
      scope: "shop.example",
    }),
  );
  expect(await view.findByText("on shop.example")).toBeTruthy();
  expect(view.container.textContent ?? "").not.toContain("teleport");
});
