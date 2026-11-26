/**
 * The cards a Bot draws, as the phone reads them: arguments that may be half written, a message's components from a
 * server that may be older or newer than the app, and what the person answered a question the Bot asked.
 */
import { expect, test } from "bun:test";
import type { ConversationMessage } from "../src/api/generated/model";
import { answerOf, answersIn, drawable, readTable } from "../src/gallery/drawn";
import {
  parsePartialJson,
  partialArguments,
} from "../src/gallery/partial-json";

test("whole JSON reads as JSON.parse reads it", () => {
  expect(parsePartialJson('{"a":[1,2,{"b":null}],"c":"d"}')).toEqual({
    a: [1, 2, { b: null }],
    c: "d",
  });
});

test("what has arrived of an object is read, and what is open is closed", () => {
  expect(parsePartialJson('{"title":"Reve')).toEqual({ title: "Reve" });
  expect(
    parsePartialJson('{"title":"Revenue","points":[{"label":"Sales"'),
  ).toEqual({
    title: "Revenue",
    points: [{ label: "Sales" }],
  });
  expect(parsePartialJson("{")).toEqual({});
  expect(parsePartialJson('{"a":[1,2,')).toEqual({ a: [1, 2] });
});

test("what can't be told yet is left out, not guessed", () => {
  // A number at the very end may have more digits coming.
  expect(parsePartialJson('{"value":12')).toEqual({});
  expect(parsePartialJson('{"value":12,')).toEqual({ value: 12 });
  // A key with no value, a half-written literal, a half-written escape.
  expect(parsePartialJson('{"done"')).toEqual({});
  expect(parsePartialJson('{"done":')).toEqual({});
  expect(parsePartialJson('{"done":tr')).toEqual({});
  expect(parsePartialJson('{"a":"x\\')).toEqual({ a: "x" });
  expect(parsePartialJson('{"a":"x\\u00')).toEqual({ a: "x" });
  expect(parsePartialJson('{"a":"\\u00e9t\\n')).toEqual({ a: "ét\n" });
});

test("text that isn't JSON reads as nothing", () => {
  expect(parsePartialJson("")).toBeUndefined();
  expect(parsePartialJson("   ")).toBeUndefined();
  expect(parsePartialJson("hello")).toBeUndefined();
  expect(parsePartialJson('{"a":1}}')).toBeUndefined();
  expect(parsePartialJson("{a:1}")).toBeUndefined();
  expect(partialArguments("[1,2")).toBeUndefined();
});

test("a key named __proto__ is an own key, as JSON.parse makes it", () => {
  const read = parsePartialJson(
    '{"__proto__":{"polluted":true},"x":"',
  ) as Record<string, unknown>;
  expect(Object.keys(read)).toEqual(["__proto__", "x"]);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

const message = (
  components: unknown,
  extra: Partial<ConversationMessage> = {},
): ConversationMessage =>
  ({
    id: "m1",
    role: "bot",
    personId: null,
    botId: "b1",
    text: "",
    status: "completed",
    createdAt: null,
    components,
    ...extra,
  }) as ConversationMessage;

test("a message's components are the ones the phone draws, in order, once each", () => {
  const drawn = drawable(
    message([
      { toolCallId: "t1", name: "showBarChart", arguments: { title: "A" } },
      { toolCallId: "t2", name: "showSomethingNew", arguments: {} },
      { toolCallId: "t1", name: "showBarChart", arguments: {} },
      { toolCallId: "t3", name: "askChoice", arguments: "not an object" },
      { name: "showTable", arguments: {} },
      "nonsense",
    ]),
  );
  expect(drawn).toEqual([
    { toolCallId: "t1", name: "showBarChart", arguments: { title: "A" } },
    { toolCallId: "t3", name: "askChoice", arguments: {} },
  ]);
  // A server older than the field sends none.
  expect(drawable(message(undefined))).toEqual([]);
});

test("an answer is read in the shapes the web app writes, and nothing else", () => {
  expect(answerOf('{"decision":"approved"}')).toEqual({
    kind: "approval",
    decision: "approved",
  });
  expect(answerOf({ decision: "other", note: "Next week" })).toEqual({
    kind: "approval",
    decision: "other",
    note: "Next week",
  });
  expect(answerOf('{"choice":"staging","label":"Staging"}')).toEqual({
    kind: "choice",
    choice: "staging",
  });
  expect(
    answerOf({ status: "submitted", values: { team: "Ops", seats: 3, x: {} } }),
  ).toEqual({
    kind: "form",
    values: { team: "Ops", seats: 3 },
  });
  expect(answerOf("Used askChoice")).toBeUndefined();
  expect(answerOf({ decision: "maybe" })).toBeUndefined();
});

test("a question's answer is the component's own result, else the tool line after the Bot's message", () => {
  const asked = message(
    [
      { toolCallId: "q1", name: "askChoice", arguments: {} },
      {
        toolCallId: "q2",
        name: "askApproval",
        arguments: {},
        result: '{"decision":"declined"}',
      },
      { toolCallId: "q3", name: "askForm", arguments: {} },
    ],
    { id: "m1" },
  );
  const tool = (id: string, text: string) =>
    message(undefined, { id, role: "tool", text });
  const answers = answersIn([
    asked,
    tool("t1", "Looked it up."),
    tool("t2", '{"choice":"production"}'),
    message(undefined, { id: "m2", role: "person", text: "Thanks" }),
    tool("t3", '{"status":"submitted","values":{}}'),
  ]);
  expect(answers.get("q1")).toEqual({ kind: "choice", choice: "production" });
  expect(answers.get("q2")).toEqual({ kind: "approval", decision: "declined" });
  // Not after what was said next: that tool line is someone else's.
  expect(answers.has("q3")).toBe(false);
});

test("a table still streaming sets its short last row aside, and a finished one that isn't whole has failed", () => {
  const args = {
    columns: ["Team", "Hours"],
    rows: [{ cells: ["Product", 24] }, { cells: ["Design"] }],
  };
  expect(readTable(args, true)).toEqual({
    columns: ["Team", "Hours"],
    rows: [["Product", 24]],
    held: true,
  });
  expect(readTable(args, false)).toEqual({ failed: true });
  expect(readTable({}, true)).toBeNull();
  expect(readTable({ columns: ["A", "A"], rows: [] }, false)).toEqual({
    failed: true,
  });
});
