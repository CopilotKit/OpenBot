import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import {
  ChatTranscript,
  sameToolRow,
} from "@/components/channels/chat-transcript";
import * as toolActivity from "@/components/channels/tool-activity";
import { settleReactWork } from "./settle-react-work";

/**
 * While a reply streams, every token re-renders the transcript. Rows that have finished must not
 * re-render with it: a tool group in history (and the markdown inside it) redrawn on every token is
 * the cost that made long conversations stutter.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function user(id: string, text: string): Message {
  return { id, role: "user", content: text };
}

function assistant(id: string, text: string): Message {
  return { id, role: "assistant", content: text };
}

/* An assistant turn that searched twice: two adjacent tool calls, folded into one group row. */
function searched(id: string): Message[] {
  return [
    {
      id,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `${id}-c1`,
          type: "function",
          function: { name: "web_search", arguments: '{"q":"one"}' },
        },
        {
          id: `${id}-c2`,
          type: "function",
          function: { name: "web_search", arguments: '{"q":"two"}' },
        },
      ],
    },
    {
      id: `${id}-r1`,
      role: "tool",
      toolCallId: `${id}-c1`,
      content: "found one",
    },
    {
      id: `${id}-r2`,
      role: "tool",
      toolCallId: `${id}-c2`,
      content: "found two",
    },
  ] as Message[];
}

const step = (id: string, result?: string) => ({
  kind: "tool" as const,
  id,
  toolCall: {
    id,
    type: "function" as const,
    function: { name: "web_search", arguments: '{"q":"x"}' },
  },
  result,
});

test("a rebuilt but identical tool row is the same row", () => {
  const props = {
    id: "group:a",
    active: false,
    latest: false,
    spokeAfter: false,
  };
  expect(
    sameToolRow(
      { ...props, steps: [step("a", "done")] },
      { ...props, steps: [step("a", "done")] },
    ),
  ).toBe(true);
  expect(
    sameToolRow(
      { ...props, steps: [step("a")] },
      { ...props, steps: [step("a", "done")] },
    ),
  ).toBe(false);
  expect(
    sameToolRow(
      { ...props, steps: [step("a", "done")] },
      { ...props, steps: [step("a", "done"), step("b")] },
    ),
  ).toBe(false);
  expect(
    sameToolRow(
      { ...props, steps: [step("a", "done")] },
      { ...props, active: true, steps: [step("a", "done")] },
    ),
  ).toBe(false);
  expect(
    sameToolRow(
      { ...props, steps: [step("a", "done")] },
      { ...props, spokeAfter: true, steps: [step("a", "done")] },
    ),
  ).toBe(false);
});

test("a finished tool group does not re-render while a reply streams", () => {
  const renders = spyOn(toolActivity, "ToolActivity");
  const history = [user("u1", "look it up"), ...searched("a1")];
  let reply = "Here";
  const client = new QueryClient();
  const view = render(
    <ChatTranscript
      busy
      messages={[...history, assistant("a2", reply)]}
      restoring={false}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  const before = renders.mock.calls.length;
  expect(before).toBeGreaterThan(0);

  for (let token = 0; token < 10; token++) {
    reply += ` word${token}`;
    view.rerender(
      <ChatTranscript
        busy
        messages={[...history, assistant("a2", reply)]}
        restoring={false}
      />,
    );
  }

  expect(renders.mock.calls.length).toBe(before);
  renders.mockRestore();
});

/*
 * The agent client appends a call's argument chunks to the same `toolCall` object it already
 * handed over. A row that compared the arguments it was given with themselves never saw them grow,
 * so a running search showed no query until its result arrived.
 */
test("a running tool row redraws as its arguments stream in place", () => {
  const renders = spyOn(toolActivity, "ToolActivity");
  const [call, ...rest] = searched("a1");
  const message = call as Message & {
    toolCalls: { function: { arguments: string } }[];
  };
  const streaming = message.toolCalls[1];
  if (!streaming) throw new Error("the fixture has two calls");
  streaming.function.arguments = "";
  const results = rest.slice(0, 1);
  const client = new QueryClient();
  const view = render(
    <ChatTranscript
      busy
      messages={[user("u1", "look it up"), message, ...results]}
      restoring={false}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );

  const before = renders.mock.calls.length;
  streaming.function.arguments = '{"q":"two"}';
  view.rerender(
    <ChatTranscript
      busy
      messages={[user("u1", "look it up"), message, ...results]}
      restoring={false}
    />,
  );

  expect(renders.mock.calls.length).toBeGreaterThan(before);
  const last = renders.mock.calls.at(-1)?.[0];
  expect(last?.group.steps[1]?.toolCall.function.arguments).toBe('{"q":"two"}');
  renders.mockRestore();
});
