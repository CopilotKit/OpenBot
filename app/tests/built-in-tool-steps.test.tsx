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
 * OpenBot's own tools read as words in the conversation, never as their identifiers.
 *
 * Seen on a live install: the step lines of one conversation read `copilotkit_load_skill`,
 * `list_bots` and `remember_personal_fact`, between lines that read "Searched the web" and "Asked
 * Knowledge". None of the three has a component of its own, so each is drawn as a plain line, and a
 * plain line named any tool missing from the label table by its identifier.
 */

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

/** One call of `name`, answered with `result` unless it is still running, then a sentence after it. */
function step(name: string, result?: string): Message[] {
  const id = `call-${name}`;
  return [
    {
      id: `a-${name}`,
      role: "assistant",
      content: "",
      toolCalls: [
        { id, type: "function", function: { name, arguments: "{}" } },
      ],
    },
    ...(result === undefined
      ? []
      : [
          {
            id: `t-${name}`,
            role: "tool" as const,
            toolCallId: id,
            content: result,
          },
          {
            id: `s-${name}`,
            role: "assistant" as const,
            content: `After ${name}.`,
          },
        ]),
  ];
}

function draw(messages: Message[], busy = false) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ChatTranscript busy={busy} messages={messages} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

test("the tools a live conversation showed by identifier read as what they did", async () => {
  const view = draw([
    {
      id: "u1",
      role: "user",
      content: "Who else here could help with invoices?",
    },
    ...step("copilotkit_load_skill", '{"instructions":"..."}'),
    ...step("list_bots", "Finance Bot: yours"),
    ...step("remember_personal_fact", '{"id":"m1"}'),
  ]);
  expect(await view.findByText("Used a skill")).toBeTruthy();
  expect(await view.findByText("Checked existing Bots")).toBeTruthy();
  expect(await view.findByText("Saved a memory")).toBeTruthy();
  for (const identifier of [
    "copilotkit_load_skill",
    "list_bots",
    "remember_personal_fact",
  ])
    expect(view.queryByText(identifier)).toBeNull();
});

test("while one is still running, its line says what it is doing", async () => {
  const view = draw(
    [
      { id: "u1", role: "user", content: "Remember that I prefer mornings." },
      ...step("remember_personal_fact"),
    ],
    true,
  );
  expect(await view.findByText("Saving a memory")).toBeTruthy();
  expect(view.queryByText("remember_personal_fact")).toBeNull();
});

/*
 * A DRAWN INTERFACE IS A STEP TOO. The runtime offers `render_ui` when a conversation can draw
 * generated interfaces, so no OpenBot registration names it, and a live conversation read
 * "render_ui" above the trip budget its Bot had just drawn.
 */
test("drawing an interface reads as what the Bot did, not the tool's identifier", async () => {
  const view = draw([
    { id: "u1", role: "user", content: "Build a weekend trip budget." },
    ...step("render_ui", '{"rendered":true}'),
  ]);
  expect(await view.findByText("Drew an interface")).toBeTruthy();
  expect(view.queryByText("render_ui")).toBeNull();
});

/*
 * A NAME NOBODY LABELLED IS STILL A STEP. Seen on a live install: a Bot asked to search the web
 * first called `web_search`, a name it was never offered, and for its first seconds the line read
 * "web_search" and then "▸ web_search" before the real search joined it as "Search the web…". The
 * line is drawn the moment the call starts, before any of its arguments arrive, so its words have to
 * come from the name alone.
 */
test("a call to a name with no label reads in words from its first frame", async () => {
  const view = draw(
    [
      { id: "u1", role: "user", content: "Search the web for OpenBot." },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "web_search", arguments: "" },
          },
        ],
      },
    ],
    true,
  );
  expect(await view.findByText("Web search")).toBeTruthy();
  expect(view.queryByText("web_search")).toBeNull();
});

test("once a call to a name with no label is answered, it still reads in words", async () => {
  const view = draw([
    { id: "u1", role: "user", content: "Search the web for OpenBot." },
    ...step("web_search", "Error: no tool by that name."),
  ]);
  expect(await view.findByText("Web search")).toBeTruthy();
  expect(view.queryByText("web_search")).toBeNull();
});

test("while the interface is still being drawn, its line says so in words", async () => {
  const view = draw(
    [
      { id: "u1", role: "user", content: "Build a weekend trip budget." },
      ...step("render_ui"),
    ],
    true,
  );
  expect(await view.findByText("Drawing an interface")).toBeTruthy();
  expect(view.queryByText("render_ui")).toBeNull();
});
