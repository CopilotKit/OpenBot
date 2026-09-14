import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import {
  SlackChannelContent,
  SlackRosterProblem,
} from "@/components/app-sidebar/slack-channel";
import type { ExternalThreadSummary } from "@/lib/external/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

function slackThread(
  overrides: Partial<ExternalThreadSummary> = {},
): ExternalThreadSummary {
  return {
    threadId: "slack-thread-1",
    provider: "slack",
    agentId: "agent-support",
    agentName: "Support Agent",
    lastMessage: "Can you check the customer handoff?",
    lastMessageAt: "2026-08-27T18:00:00.000Z",
    createdAt: "2026-08-27T17:30:00.000Z",
    readOnly: true,
    ...overrides,
  };
}

test("Slack row content keeps the Slack chip beside the agent name", () => {
  const view = render(
    <SlackChannelContent lastMessageAt="2 hours ago" thread={slackThread()} />,
  );
  const title = view.container.querySelector(
    '[data-slot="conversation-title"]',
  );

  expect(title).toBeTruthy();
  expect(within(title as HTMLElement).getByText("Support Agent")).toBeTruthy();
  expect(within(title as HTMLElement).getByText("Slack")).toBeTruthy();
  expect(view.getByText("Can you check the customer handoff?")).toBeTruthy();
  expect(view.getByText("2 hours ago")).toBeTruthy();
  expect(view.queryByText("Pin channel")).toBeNull();
  expect(view.queryByText("Delete channel…")).toBeNull();
});

test("Slack roster problem announces the loading failure and retries Slack only", () => {
  let retryCalls = 0;
  const view = render(
    <SlackRosterProblem
      onRetry={() => {
        retryCalls += 1;
      }}
    />,
  );

  expect(view.getByRole("alert").textContent).toContain(
    "Slack conversations could not be loaded.",
  );
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  expect(retryCalls).toBe(1);
});

test("Slack roster problem disables retry while a retry is already running", () => {
  let retryCalls = 0;
  const view = render(
    <SlackRosterProblem
      isRetrying
      onRetry={() => {
        retryCalls += 1;
      }}
    />,
  );

  const button = view.getByRole("button", { name: "Retrying…" });

  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(retryCalls).toBe(0);
});
