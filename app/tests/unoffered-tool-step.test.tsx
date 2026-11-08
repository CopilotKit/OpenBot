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
 * A Bot that calls a tool it was never offered gets an answer written for its model, listing every
 * tool it does have by identifier. Seen on a live install: a Bot asked to search the web called
 * `web_search`, and its "Web search" step opened to "Error: Model tried to call unavailable tool
 * 'web_search'. Available tools: generateSandboxedUi, computer_navigate, …", forty names long. The
 * person reads one sentence instead, and the step says it didn't work.
 */

const AI_SDK =
  "Error: Model tried to call unavailable tool 'web_search'. Available tools: generateSandboxedUi, computer_navigate, computer_read, mcp__routines__create_routine, copilotkit_load_skill, AGUISendStateSnapshot.";
const LANGGRAPH =
  "Error: web_search is not a valid tool, try one of [computer_navigate, mcp__routines__create_routine].";
const SENTENCE =
  "This Bot asked for a tool it doesn't have, so it carried on without it.";

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // The line asks whether OpenBot is waiting on the person about this call; nothing is.
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

function call(id: string, name: string, args = "{}") {
  return { id, type: "function" as const, function: { name, arguments: args } };
}

function draw(messages: Message[]) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ChatTranscript busy={false} messages={messages} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

function expectOneSentence(container: HTMLElement) {
  const text = container.textContent ?? "";
  expect(text).toContain(SENTENCE);
  for (const raw of [
    "Model tried",
    "not a valid tool",
    "computer_navigate",
    "mcp__routines__create_routine",
  ])
    expect(text).not.toContain(raw);
}

function lone(result: string): Message[] {
  return [
    { id: "u1", role: "user", content: "Search the web for OpenBot." },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [call("c1", "web_search", '{"query":"OpenBot"}')],
    },
    { id: "t1", role: "tool", toolCallId: "c1", content: result },
    { id: "a2", role: "assistant", content: "Here is what I found." },
  ];
}

test("a lone call to a tool it was never offered opens to one sentence, and didn't work", async () => {
  const view = draw(lone(AI_SDK));
  expect(await view.findByText("Web search, didn't work")).toBeTruthy();
  expectOneSentence(view.container);
});

test("LangGraph's wording, and the runtime's when the Bot has no tools at all, read the same", async () => {
  for (const result of [
    LANGGRAPH,
    JSON.stringify(AI_SDK),
    "Error: Model tried to call unavailable tool 'web_search'. No tools are available.",
  ]) {
    const view = draw(lone(result));
    expect(await view.findByText("Web search, didn't work")).toBeTruthy();
    expectOneSentence(view.container);
    cleanup();
  }
});

test("the same call among other steps opens to the same sentence and counts as an issue", async () => {
  const view = draw([
    { id: "u1", role: "user", content: "Search the web for OpenBot." },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        call("c1", "web_search", '{"query":"OpenBot"}'),
        call("c2", "list_bots"),
      ],
    },
    { id: "t1", role: "tool", toolCallId: "c1", content: LANGGRAPH },
    { id: "t2", role: "tool", toolCallId: "c2", content: "Scout: yours" },
    { id: "a2", role: "assistant", content: "Done." },
  ]);
  expect(await view.findByText("1 issue")).toBeTruthy();
  expectOneSentence(view.container);
});

test("any other answer that starts with Error is still the tool's own words", async () => {
  const view = draw(lone("Error: the page did not load."));
  expect(await view.findByText("Error: the page did not load.")).toBeTruthy();
  expect(view.container.textContent).not.toContain(SENTENCE);
});
