/**
 * What a Bot is writing, from its run's AG-UI events: "Working…" first, its words as they come, and nothing drawn twice
 * once the messages read back hold the reply.
 */
import { expect, test } from "bun:test";
import type { ConversationMessage } from "../src/api/generated/model";
import {
  arriving,
  asMessages,
  caughtUp,
  type LiveRuns,
  liveAnswers,
  reduce,
  sentAgain,
  settle,
  stopOffer,
} from "../src/live-run";
import type { LiveEvent } from "../src/live-thread";

const started = (runId: string): LiveEvent => ({ type: "RUN_STARTED", runId });
const start = (runId: string, messageId: string): LiveEvent => ({
  type: "TEXT_MESSAGE_START",
  runId,
  messageId,
  role: "assistant",
});
const words = (messageId: string, delta: string): LiveEvent => ({
  type: "TEXT_MESSAGE_CONTENT",
  messageId,
  delta,
});
const finished = (runId: string): LiveEvent => ({
  type: "RUN_FINISHED",
  runId,
});
const play = (events: LiveEvent[], from: LiveRuns = []) =>
  events.reduce(reduce, from);
const bot = (id: string, text: string): ConversationMessage => ({
  id,
  role: "bot",
  personId: null,
  botId: "b1",
  text,
  status: "completed",
  createdAt: "2026-11-26T10:00:00.000Z",
});

test("a run that has started and said nothing yet is one reply at work", () => {
  const [working] = asMessages(play([started("r1")]), []);
  expect(working).toMatchObject({ role: "bot", status: "running", text: "" });
});

test("a reply's words add up as they come, even from events that name no run", () => {
  const runs = play([
    started("r1"),
    start("r1", "m1"),
    words("m1", "Hello"),
    words("m1", ", there"),
  ]);
  expect(asMessages(runs, [])).toEqual([
    expect.objectContaining({
      id: "m1",
      text: "Hello, there",
      status: "running",
    }),
  ]);
});

test("reasoning and events of a type it doesn't know change nothing", () => {
  const runs = play([started("r1")]);
  expect(
    play(
      [
        { type: "REASONING_START", runId: "r1" },
        { ...start("r1", "rs1"), role: "reasoning" },
        { type: "SOMETHING_NEW", runId: "r1" },
      ],
      runs,
    ),
  ).toEqual(runs);
});

test("what the thread replayed keeps only the run still in progress", () => {
  const replayed = play([
    started("old"),
    start("old", "m0"),
    words("m0", "Done long ago."),
    finished("old"),
    started("now"),
    start("now", "m1"),
    words("m1", "Half"),
  ]);
  expect(caughtUp(replayed).map((run) => run.id)).toEqual(["now"]);
});

test("an ended run stays drawn until the messages are read again, and then goes", () => {
  const ended = play([
    started("r1"),
    start("r1", "m1"),
    words("m1", "Hi."),
    finished("r1"),
  ]);
  expect(asMessages(ended, []).map((message) => message.text)).toEqual(["Hi."]);
  expect(settle(ended)).toEqual([]);
});

test("a reply the messages already hold is not drawn again", () => {
  const runs = play([started("r1"), start("r1", "m1"), words("m1", "Hi.")]);
  expect(asMessages(runs, [bot("m1", "Hi.")])).toEqual([]);
  // Read back under another id, a finished reply is known by what it says.
  expect(
    asMessages(play([finished("r1")], runs), [bot("other", "Hi.")]),
  ).toEqual([]);
});

test("a reply still being written is never taken for an older one that says the same so far", () => {
  const runs = play([started("r2"), start("r2", "m2"), words("m2", "Hi.")]);
  expect(
    asMessages(runs, [bot("m1", "Hi.")]).map((message) => message.id),
  ).toEqual(["m2"]);
});

test("runs come out newest first, as the API lists messages", () => {
  const runs = play([
    started("r1"),
    start("r1", "m1"),
    words("m1", "First."),
    started("r2"),
  ]);
  expect(asMessages(runs, []).map((message) => message.id)).toEqual([
    "run:r2",
    "m1",
  ]);
});

const tool = (
  toolCallId: string,
  toolCallName: string,
  parentMessageId?: string,
): LiveEvent => ({
  type: "TOOL_CALL_START",
  toolCallId,
  toolCallName,
  ...(parentMessageId ? { parentMessageId } : {}),
});
const args = (toolCallId: string, delta: string): LiveEvent => ({
  type: "TOOL_CALL_ARGS",
  toolCallId,
  delta,
});
const toolEnd = (toolCallId: string): LiveEvent => ({
  type: "TOOL_CALL_END",
  toolCallId,
});

test("a card is drawn once its arguments read, and grows as more arrive", () => {
  const begun = play([
    started("r1"),
    start("r1", "m1"),
    words("m1", "Here it is."),
    tool("c1", "showBarChart", "m1"),
  ]);
  // Nothing of its arguments yet: the reply has no card.
  expect(asMessages(begun, [])[0]?.components).toBeUndefined();
  const partly = play(
    [args("c1", '{"title":"Revenue","points":[{"label":"Sa')],
    begun,
  );
  expect(asMessages(partly, [])[0]).toMatchObject({
    id: "m1",
    text: "Here it is.",
    components: [
      {
        toolCallId: "c1",
        name: "showBarChart",
        arguments: { title: "Revenue", points: [{ label: "Sa" }] },
      },
    ],
  });
  expect(arriving(partly)).toEqual(new Set(["c1"]));
  const whole = play(
    [args("c1", 'les","value":120}]}'), toolEnd("c1")],
    partly,
  );
  expect(asMessages(whole, [])[0]?.components?.[0]?.arguments).toEqual({
    title: "Revenue",
    points: [{ label: "Sales", value: 120 }],
  });
  expect(arriving(whole).size).toBe(0);
});

test("a tool call the phone doesn't draw is left to the messages", () => {
  const runs = play([
    started("r1"),
    start("r1", "m1"),
    words("m1", "Searching."),
    tool("w1", "webSearch", "m2"),
    args("w1", '{"q":"pizza"}'),
  ]);
  expect(runs[0]?.tools).toEqual([]);
  expect(asMessages(runs, []).map((message) => message.id)).toEqual(["m1"]);
});

test("a card in a message of its own is placed after what came before it, in order", () => {
  const runs = play([
    started("r1"),
    start("r1", "m1"),
    words("m1", "First."),
    tool("c1", "showNotice", "m2"),
    args("c1", '{"title":"A"}'),
    tool("c2", "showQuote"),
    args("c2", '{"quote":"B"}'),
  ]);
  const [newest, oldest] = asMessages(runs, []);
  expect(oldest?.id).toBe("m1");
  // A call that names no message is part of the run's last one.
  expect(newest).toMatchObject({
    id: "m2",
    text: "",
    status: "running",
    components: [
      { toolCallId: "c1", name: "showNotice" },
      { toolCallId: "c2", name: "showQuote" },
    ],
  });
});

test("a card the read messages already hold is not drawn again, and one they lack stays", () => {
  const runs = play([
    started("r1"),
    start("r1", "m1"),
    words("m1", "Chart:"),
    tool("c1", "showBarChart", "m1"),
    args("c1", "{}"),
    tool("c2", "showPieChart", "m1"),
    args("c2", "{}"),
  ]);
  const readBack: ConversationMessage = {
    ...bot("m1", "Chart:"),
    components: [{ toolCallId: "c1", name: "showBarChart", arguments: {} }],
  };
  // The words are read back under the same id: only the card the read message lacks is left, on a line of its own.
  expect(asMessages(runs, [readBack])).toEqual([
    expect.objectContaining({
      id: "m1:components",
      text: "",
      components: [{ toolCallId: "c2", name: "showPieChart", arguments: {} }],
    }),
  ]);
  expect(
    asMessages(runs, [
      {
        ...readBack,
        components: [
          ...(readBack.components ?? []),
          { toolCallId: "c2", name: "showPieChart", arguments: {} },
        ],
      },
    ]),
  ).toEqual([]);
});

test("an ended run keeps a card with no words until the messages are read again", () => {
  const runs = play([
    started("r1"),
    tool("c1", "showTable"),
    args("c1", '{"title":"T"}'),
    toolEnd("c1"),
    finished("r1"),
  ]);
  expect(asMessages(runs, [])).toEqual([
    expect.objectContaining({
      id: "tools:c1",
      status: "completed",
      components: [
        { toolCallId: "c1", name: "showTable", arguments: { title: "T" } },
      ],
    }),
  ]);
  expect(arriving(runs).size).toBe(0);
});

test("what a live run's question was answered with is read from its result", () => {
  const runs = play([
    started("r1"),
    tool("q1", "askChoice"),
    args("q1", '{"title":"Where?"}'),
    toolEnd("q1"),
    { type: "TOOL_CALL_RESULT", toolCallId: "q1", content: '{"choice":"a"}' },
  ]);
  expect(liveAnswers(runs).get("q1")).toEqual({ kind: "choice", choice: "a" });
});

test("Stop is offered only where the server says so, in a one-Bot conversation, while a run is live, for every live run", () => {
  const one = { runStop: true, group: false };
  const runs = play([
    started("r1"),
    started("r2"),
    started("r3"),
    finished("r3"),
  ]);
  expect(
    stopOffer(runs, { runStop: false, group: false }, new Set()),
  ).toBeNull();
  // A group: the server keeps no run record there, so Stop could stop nothing.
  expect(stopOffer(runs, { runStop: true, group: true }, new Set())).toBeNull();
  expect(stopOffer(runs, one, new Set())).toEqual({
    runs: ["r1", "r2"],
    stopping: false,
  });
  // Asked already: those are ending, and only the rest would be stopped.
  expect(stopOffer(runs, one, new Set(["r1"]))).toEqual({
    runs: ["r2"],
    stopping: false,
  });
  expect(stopOffer(runs, one, new Set(["r1", "r2"]))).toEqual({
    runs: [],
    stopping: true,
  });
  expect(
    stopOffer(play([finished("r1"), finished("r2")], runs), one, new Set()),
  ).toBeNull();
  expect(stopOffer([], one, new Set())).toBeNull();
});

const runError = (runId: string, message?: string): LiveEvent => ({
  type: "RUN_ERROR",
  runId,
  ...(message ? { message } : {}),
});

test("a run that fails says why, as a failed reply after what it wrote", () => {
  const runs = play([
    started("r1"),
    start("r1", "m1"),
    words("m1", "Half"),
    runError("r1", "Connect your AI to use Bots."),
  ]);
  expect(asMessages(runs, [])).toEqual([
    expect.objectContaining({
      id: "error:r1",
      status: "failed",
      text: "Connect your AI to use Bots.",
    }),
    expect.objectContaining({ id: "m1", text: "Half" }),
  ]);
  // One that names no reason still says it failed.
  expect(asMessages(play([started("r2"), runError("r2")]), [])).toEqual([
    expect.objectContaining({ id: "error:r2", status: "failed" }),
  ]);
});

test("a failure stays once the messages are read again, unless they hold it, and goes once the person sends again", () => {
  const runs = settle(play([started("r1"), runError("r1", "No AI.")]));
  expect(asMessages(runs, []).map((message) => message.id)).toEqual([
    "error:r1",
  ]);
  expect(
    asMessages(runs, [{ ...bot("x", "No AI."), status: "failed" }]),
  ).toEqual([]);
  expect(sentAgain(runs)).toEqual([]);
});
