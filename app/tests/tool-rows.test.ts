import { expect, test } from "bun:test";
import { connectAppRefusal } from "@openbot/shared/connect-prompt";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import { groupToolSteps } from "../src/components/channels/tool-activity";
import { REFUSAL_MARKER } from "../src/lib/plugins/tool-result";

/**
 * A row of tool calls keeps one key for its whole life. React keys the transcript row on it, so a
 * key that changed when a second call arrived, or when the first call turned out to ask the person
 * something, tore the row down and rebuilt it: its entrance replayed and anything drawn in it
 * flickered. Group ids carry a `group:` prefix so they can never collide with a single row's id.
 */

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

function call(id: string, result?: string): ToolItem {
  return {
    kind: "tool",
    id,
    toolCall: {
      id,
      type: "function",
      function: { name: "mcp__exa__web_search_exa", arguments: "{}" },
    },
    ...(result === undefined ? {} : { result }),
  };
}

const text = (id: string): VisibleChatItem => ({
  kind: "text",
  id,
  role: "assistant",
  text: "Here is what I found.",
});

const asks = `${REFUSAL_MARKER} ${connectAppRefusal({
  serverId: "composio-gmail",
  title: "Gmail",
  message: "You have not connected your Gmail account.",
  agentId: "expenses",
})}`;

const drawsNothing = () => false;

test("a lone foldable call is a group of one under a group key", () => {
  const grouped = groupToolSteps([call("t1")], drawsNothing, new Map());
  expect(grouped).toEqual([
    { kind: "tools", id: "group:t1", steps: [call("t1")] },
  ]);
});

test("a second adjacent call keeps the row id", () => {
  const rowIds = new Map<string, string>();
  const first = groupToolSteps([call("t1")], drawsNothing, rowIds);
  const second = groupToolSteps([call("t1"), call("t2")], drawsNothing, rowIds);
  expect(first.map((item) => item.id)).toEqual(["group:t1"]);
  expect(second.map((item) => item.id)).toEqual(["group:t1"]);
});

test("a first step that leaves the group does not take the group's id with it", () => {
  const rowIds = new Map<string, string>();
  groupToolSteps([call("t1"), call("t2"), call("t3")], drawsNothing, rowIds);
  const after = groupToolSteps(
    [call("t1", asks), call("t2"), call("t3")],
    drawsNothing,
    rowIds,
  );
  expect(after.map((item) => [item.kind, item.id])).toEqual([
    ["tool", "t1"],
    ["tools", "group:t1"],
  ]);
});

test("two groups never claim the same row id", () => {
  const rowIds = new Map<string, string>();
  groupToolSteps([call("t1"), call("t2")], drawsNothing, rowIds);
  const split = groupToolSteps(
    [call("t1"), text("between"), call("t2")],
    drawsNothing,
    rowIds,
  );
  expect(split.map((item) => item.id)).toEqual([
    "group:t1",
    "between",
    "group:t2",
  ]);
});

test("a lone call whose result asks the person keeps its row id", () => {
  const rowIds = new Map<string, string>();
  groupToolSteps([call("t1")], drawsNothing, rowIds);
  const after = groupToolSteps([call("t1", asks)], drawsNothing, rowIds);
  expect(after.map((item) => [item.kind, item.id])).toEqual([
    ["tool", "group:t1"],
  ]);
});
