import { expect, test } from "bun:test";
import {
  browserStepDetails,
  groupBrowserSteps,
} from "../src/components/channels/browser-activity";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";

function step(
  id: string,
  name = "computer_navigate",
  result?: string,
): Extract<VisibleChatItem, { kind: "tool" }> {
  return {
    kind: "tool",
    id,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: '{"url":"https://example.com"}' },
    },
    ...(result === undefined ? {} : { result }),
  };
}

test("navigation and intervening browser actions become one stable row as results stream", () => {
  const first = step("one");
  const items = [first, step("read", "computer_read"), step("two")];
  const grouped = groupBrowserSteps(items);
  expect(grouped).toEqual([{ kind: "browser", id: "one", steps: items }]);
  expect(
    groupBrowserSteps([
      { ...first, result: '{"ok":true}' },
      ...items.slice(1),
    ])[0]?.id,
  ).toBe("one");
  expect(items).toHaveLength(3);
});

test("grouping keeps messages, other tools, and human assistance requests in their original positions", () => {
  const boundaries: VisibleChatItem[] = [
    {
      kind: "text",
      id: "answer",
      role: "assistant",
      text: "Here is what I found.",
    },
    { kind: "text", id: "question", role: "user", text: "Check another page." },
    step("help", "computer_request_help"),
    step("secret", "computer_request_secret"),
    step("shell", "computer_run_command"),
  ];
  for (const boundary of boundaries) {
    const grouped = groupBrowserSteps([step("one"), boundary, step("two")]);
    expect(grouped.map((item) => item.id)).toEqual(["one", boundary.id, "two"]);
    expect(grouped[1]).toBe(boundary);
  }
});

test("failed visits stay inspectable and unsafe or streaming URLs never become links", () => {
  const failed = browserStepDetails(
    step(
      "failed",
      "computer_navigate",
      '{"ok":false,"refused":true,"reason":"Site blocked"}',
    ),
  );
  expect(failed.failed).toBe(true);
  expect(failed.reason).toBe("Site blocked");
  expect(failed.visited).toBe(false);
  const unsafe = step(
    "unsafe",
    "computer_navigate",
    '{"ok":true,"url":"javascript:alert(1)"}',
  );
  expect(browserStepDetails(unsafe).href).toBeUndefined();
  const streaming = step("partial");
  streaming.toolCall.function.arguments = '{"url":';
  expect(browserStepDetails(streaming).pending).toBe(true);
  expect(browserStepDetails(streaming).href).toBeUndefined();
  expect(
    browserStepDetails(step("throw", "computer_navigate", "Error: Failed"))
      .failed,
  ).toBe(true);
});
