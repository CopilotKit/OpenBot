import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { WaitingForYou } from "@/components/approvals/waiting";
import { settleReactWork } from "./settle-react-work";

/*
 * An approval a task started from a check-in raised offers Allow once and Deny, never "Always allow
 * here": tasks ask before every change whatever the person's rules say, so a rule saved from one
 * would be ignored the next time. Any other approval still offers it. Both places a person decides
 * one in the browser: the card in the conversation, and the row on the Bot's page.
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

/** A pending request as `GET /api/approvals` returns it. */
const request = (
  id: string,
  toolCallId: string,
  path: string,
  policy: { behaviour: "ask"; source: string; reason: string },
) => ({
  id,
  status: "pending",
  createdAt: "2026-10-30T22:00:00Z",
  action: {
    actorId: "me",
    botId: "assistant",
    toolRef: "computer_write_file",
    effect: "write",
    scope: "workspace",
    threadId: `thread-${id}`,
    runId: `run-${id}`,
    toolCallId,
    actionDigest: `digest-${id}`,
    args: { path },
    target: null,
    policy,
  },
});

function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/approvals")
      return Response.json({
        enabled: false,
        rules: [],
        teamRules: [],
        questions: [],
        requests: [
          request("task-request", "task-call", "deno-rollback-note.md", {
            behaviour: "ask",
            source: "task",
            reason: "Tasks started from a check-in ask before every change.",
          }),
          request("own-request", "own-call", "notes.md", {
            behaviour: "ask",
            source: "personal_rule",
            reason: "A rule asks before this kind of action.",
          }),
        ],
      });
    if (path.startsWith("/api/agents"))
      return Response.json({
        agents: [{ id: "assistant", name: "General Assistant" }],
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>,
  );
}

const names = (scope: HTMLElement) =>
  within(scope)
    .getAllByRole("button")
    .map((button) => button.textContent);

test("in the conversation, a check-in task's approval offers Allow once and Deny, and no standing rule", async () => {
  serving();
  const view = draw(
    <>
      <section aria-label="task">
        <InlineApproval toolCallId="task-call" fallback={null} />
      </section>
      <section aria-label="own">
        <InlineApproval toolCallId="own-call" fallback={null} />
      </section>
    </>,
  );
  await view.findAllByRole("region", { name: "Waiting for your approval" });
  expect(names(view.getByRole("region", { name: "task" }))).toEqual([
    "Allow once",
    "Deny",
  ]);
  expect(
    within(view.getByRole("region", { name: "task" })).getByText(
      "Tasks started from a check-in ask before every change.",
    ),
  ).toBeTruthy();
  expect(names(view.getByRole("region", { name: "own" }))).toEqual([
    "Allow once",
    "Always allow here",
    "Deny",
  ]);
});

test("on the Bot's page, the same: the task's row has no Always allow here, the other row keeps it", async () => {
  serving();
  const view = draw(<WaitingForYou agentId="assistant" />);
  const row = async (path: string) =>
    (await view.findByText(path, { exact: false })).closest(
      "[data-slot=item]",
    ) as HTMLElement;
  expect(names(await row("deno-rollback-note.md"))).toEqual([
    "Allow once",
    "Deny",
  ]);
  expect(names(await row("notes.md"))).toEqual([
    "Allow once",
    "Always allow here",
    "Deny",
  ]);
});
