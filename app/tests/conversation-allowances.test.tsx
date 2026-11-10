import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ConversationAllowances } from "@/components/approvals/conversation-allowances";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * What the person allowed for a conversation is shown in that conversation, with a way to turn it
 * off: "Send message on Slack is allowed in this conversation. Turn off".
 */

const originalFetch = globalThis.fetch;
let grants: { id: string; threadId: string; [key: string]: unknown }[] = [];
const revoked: string[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname === "/api/approvals")
        return Response.json({
          enabled: false,
          requests: [],
          rules: [],
          teamRules: [],
          conversationGrants: grants,
          questions: [],
        });
      const turnedOff = url.pathname.match(
        /^\/api\/approvals\/conversation-grants\/([^/]+)$/,
      );
      if (turnedOff && init?.method === "DELETE") {
        const id = decodeURIComponent(turnedOff[1] ?? "");
        revoked.push(id);
        grants = grants.filter((grant) => grant.id !== id);
        return Response.json({ revoked: true });
      }
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  grants = [];
  revoked.length = 0;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const draw = (threadId: string) =>
  render(
    <QueryClientProvider client={queryClient}>
      <ConversationAllowances threadId={threadId} />
    </QueryClientProvider>,
  );

const slackSend = {
  id: "grant-1",
  threadId: "thread-1",
  botId: "assistant",
  toolRef: "composio-slack/SLACK_SEND_MESSAGE",
  effect: "write",
  scope: "composio-slack",
  kind: "sending",
  createdAt: "2026-11-09T10:00:00.000Z",
};

test("a conversation shows what it allows, and Turn off turns it off", async () => {
  grants = [slackSend];
  const view = draw("thread-1");
  const line = await view.findByRole("region", {
    name: "Allowed in this conversation",
  });
  expect(line.textContent).toContain(
    "Send message on Slack is allowed in this conversation.",
  );
  fireEvent.click(
    view.getByRole("button", { name: "Turn off: Send message on Slack" }),
  );
  await waitFor(() => expect(revoked).toEqual(["grant-1"]));
  await waitFor(() =>
    expect(
      view.queryByRole("region", { name: "Allowed in this conversation" }),
    ).toBeNull(),
  );
});

test("another conversation's answer isn't shown here", async () => {
  grants = [{ ...slackSend, threadId: "thread-2" }];
  const view = draw("thread-1");
  await settleReactWork();
  await waitFor(() =>
    expect(queryClient.getQueryData(["approvals"])).toBeTruthy(),
  );
  expect(
    view.queryByRole("region", { name: "Allowed in this conversation" }),
  ).toBeNull();
});

test("a step on a website says the kind it allows there, not every click", async () => {
  grants = [
    {
      ...slackSend,
      id: "grant-2",
      toolRef: "computer_click",
      scope: "chat.example.com",
    },
  ];
  const view = draw("thread-1");
  const line = await view.findByRole("region", {
    name: "Allowed in this conversation",
  });
  expect(line.textContent).toContain(
    "Sending to other people on chat.example.com is allowed in this conversation.",
  );
});
