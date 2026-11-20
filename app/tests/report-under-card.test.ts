import { expect, test } from "bun:test";
import {
  DELEGATE_TOOL,
  FOLLOW_UP_TOOL,
  taskReportMessageId,
} from "@openbot/shared/orchestration";
import type { TranscriptItem } from "@/components/channels/tool-activity";
import { reportsUnderTheirCards } from "@/components/tasks/report-under-card";

/**
 * Which of a conversation's task results sit directly under their own task's card, and so lead
 * without the chip that names the task again (task-report-chip.test.tsx draws it in a browser).
 */
const card = (taskId: string, name = DELEGATE_TOOL): TranscriptItem => ({
  kind: "tool",
  id: `call-${taskId}-${name}`,
  toolCall: {
    id: `call-${taskId}-${name}`,
    type: "function",
    function: { name, arguments: "{}" },
  },
  // The runtime may carry the answer encoded once more, as it does here.
  result: JSON.stringify(
    JSON.stringify({ taskId, channelId: `c-${taskId}`, title: taskId }),
  ),
});
const said = (id: string, role: "user" | "assistant" = "assistant") =>
  ({ kind: "text", id, role, text: "words" }) as TranscriptItem;
const report = (kind: "result" | "needs" | "steer", taskId: string) =>
  said(taskReportMessageId(kind, taskId, `run-${kind}`));

test("a result under its own card, past that task's own lines, is under its card; anything else between is not", () => {
  const items = [
    said("u1", "user"),
    card("a"),
    report("needs", "a"),
    report("steer", "a"),
    report("result", "a"),
    // Under another task's card.
    card("b"),
    report("result", "c"),
    // After the person said something else.
    card("d"),
    said("u2", "user"),
    said("reply"),
    report("result", "d"),
    // Under the card a follow-up draws.
    card("e", FOLLOW_UP_TOOL),
    report("result", "e"),
  ];
  expect([...reportsUnderTheirCards(items)].sort()).toEqual(
    [
      taskReportMessageId("result", "a", "run-result"),
      taskReportMessageId("result", "e", "run-result"),
    ].sort(),
  );
});
