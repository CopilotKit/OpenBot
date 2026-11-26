/**
 * What a Bot is writing, from its run's AG-UI events: "Working…" first, its words as they come, and nothing drawn twice
 * once the messages read back hold the reply.
 */
import { expect, test } from "bun:test";
import type { ConversationMessage } from "../src/api/generated/model";
import {
  asMessages,
  caughtUp,
  type LiveRuns,
  reduce,
  settle,
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
