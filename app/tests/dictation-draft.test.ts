import { expect, test } from "bun:test";
import type { Segment } from "prompt-area/helpers";
import { appendDictation } from "@/components/channels/composer/dictation-draft";

test("appends to text without replacing earlier edits", () => {
  expect(
    appendDictation(
      [{ type: "text", text: "My existing draft" }],
      "  dictated words  ",
    ),
  ).toEqual([{ type: "text", text: "My existing draft dictated words" }]);
  expect(
    appendDictation([{ type: "text", text: "A new line\n" }], "hello"),
  ).toEqual([{ type: "text", text: "A new line\nhello" }]);
});
test("preserves agent and skill chips", () => {
  const chips: Segment[] = [
    { type: "chip", trigger: "@", value: "agent-1", displayText: "Agent" },
    { type: "chip", trigger: "/", value: "skill-1", displayText: "Skill" },
  ];
  const result = appendDictation(chips, "hello");
  expect(result.slice(0, 2)).toEqual(chips);
  expect(result.at(-1)).toEqual({ type: "text", text: " hello" });
});
