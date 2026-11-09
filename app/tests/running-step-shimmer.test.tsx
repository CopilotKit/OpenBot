import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * While a Bot is working, the transcript says so, whether the work is a tool or the model.
 *
 * Reported from the Desktop: a Bot fetching email showed a folded "Used Gmail" line with four
 * "Fetch emails" steps and a "Fetch message by thread id", every one of them drawn still. The
 * person "thought it may have been dead". Two gaps: a step that was still running looked like the
 * finished ones above it, and once every step had its answer and the model was reading them, nothing
 * at all said the Bot was still going.
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Each line asks whether OpenBot is waiting on the person about its call; nothing is.
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
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
          questions: [],
        });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const EMAILS = '{"messages":[{"subject":"Quarterly numbers"}]}';

/** One Gmail call through Composio, answered unless `result` is left out. */
function gmail(n: number, tool: string, result?: string): Message[] {
  const id = `call-${n}`;
  return [
    {
      id: `a-${n}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: {
            name: `mcp__composio-gmail__${tool}`,
            arguments: JSON.stringify({ page: n }),
          },
        },
      ],
    },
    ...(result === undefined
      ? []
      : [
          {
            id: `t-${n}`,
            role: "tool" as const,
            toolCallId: id,
            content: result,
          },
        ]),
  ];
}

/** The run from the report: four fetches answered, then the thread read, answered or not yet. */
function run(lastAnswered: boolean): Message[] {
  return [
    {
      id: "u1",
      role: "user",
      content: "Summarize my five most recent unread emails.",
    },
    ...gmail(1, "GMAIL_FETCH_EMAILS", EMAILS),
    ...gmail(2, "GMAIL_FETCH_EMAILS", EMAILS),
    ...gmail(3, "GMAIL_FETCH_EMAILS", EMAILS),
    ...gmail(4, "GMAIL_FETCH_EMAILS", EMAILS),
    ...gmail(
      5,
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      lastAnswered ? EMAILS : undefined,
    ),
  ];
}

function transcript(messages: Message[], busy: boolean) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ChatTranscript busy={busy} messages={messages} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

const SHIMMER = "tool-line-running";

test("the step still running shimmers, and stops when its answer arrives", async () => {
  const view = render(transcript(run(false), true));

  // Named as the app's page names it, not in its stored order ("Fetch message by thread id").
  const running = await view.findByText("Fetch thread messages");
  expect(running.classList.contains(SHIMMER)).toBe(true);
  // The steps already answered look as they always have.
  const finished = view.getAllByText("Fetch emails");
  expect(finished).toHaveLength(4);
  for (const step of finished)
    expect(step.classList.contains(SHIMMER)).toBe(false);

  view.rerender(transcript(run(true), true));
  expect(
    view.getByText("Fetch thread messages").classList.contains(SHIMMER),
  ).toBe(false);
});

test("once every step has its answer and the model is still going, the transcript says it is thinking", async () => {
  const view = render(transcript(run(true), true));

  expect(await view.findByText("Used Gmail")).toBeTruthy();
  const thinking = view.getByText("Thinking");
  expect(thinking.getAttribute("role")).toBe("status");
  expect(thinking.classList.contains(SHIMMER)).toBe(true);

  // The turn ends: nothing says it is still working.
  view.rerender(transcript(run(true), false));
  expect(view.queryByText("Thinking")).toBeNull();
  expect(document.querySelector(`.${SHIMMER}`)).toBeNull();
});
