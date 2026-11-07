import { expect, test } from "bun:test";
import {
  DECLINED_BY_PERSON,
  HANDLED_BY_PERSON,
  NOT_RUN_WHILE_WAITING,
} from "@openbot/shared/approval-outcomes";
import { browserStepDetails } from "../src/components/channels/browser-activity";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import { groupToolSteps } from "../src/components/channels/tool-activity";

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

// The computer tools the app draws itself, as CopilotKit's renderer registry would list them.
const drawn = (name: string) =>
  name.startsWith("computer_request_") || name === "computer_run_command";

test("navigation and intervening browser actions become one stable row as results stream", () => {
  const first = step("one");
  const items = [first, step("read", "computer_read"), step("two")];
  const grouped = groupToolSteps(items, drawn);
  expect(grouped).toEqual([{ kind: "tools", id: "group:one", steps: items }]);
  expect(
    groupToolSteps(
      [{ ...first, result: '{"ok":true}' }, ...items.slice(1)],
      drawn,
    )[0]?.id,
  ).toBe("group:one");
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
    const grouped = groupToolSteps([step("one"), boundary, step("two")], drawn);
    expect(grouped.map((item) => item.id)).toEqual([
      "group:one",
      boundary.id,
      "group:two",
    ]);
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

test("a step the person declined, or one the turn stopped before, is not drawn as done", () => {
  // The approval's answers come back as sentences, not the computer's JSON. Read as JSON they were
  // nothing, so a declined field and the fields never filled in all said "Filled in field".
  const declined = browserStepDetails(
    step("name", "computer_type", DECLINED_BY_PERSON),
  );
  expect(declined).toMatchObject({ failed: true, reason: "You declined it." });
  const notRun = browserStepDetails(
    step("email", "computer_type", NOT_RUN_WHILE_WAITING),
  );
  expect(notRun.failed).toBe(true);
  expect(notRun.reason).toBe(
    "Not done. The Bot stopped to wait for you on another step.",
  );
  // The person doing it themselves is done, by them; and the computer's own answers read as before.
  expect(
    browserStepDetails(step("note", "computer_type", HANDLED_BY_PERSON)).failed,
  ).toBe(false);
  expect(
    browserStepDetails(step("plant", "computer_type", '{"ok":true}')).failed,
  ).toBe(false);
  expect(
    browserStepDetails(
      step(
        "gone",
        "computer_click",
        '{"ok":false,"reason":"Not on the page."}',
      ),
    ),
  ).toMatchObject({ failed: true, reason: "Not on the page." });
  expect(
    browserStepDetails(step("broke", "computer_click", "Error: socket closed"))
      .reason,
  ).toBeUndefined();
});
