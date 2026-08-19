import { describe, expect, test } from "bun:test";
import type { ComposerDraft } from "./draft";
import { type QueuedMessage, reduceQueue } from "./queue";

function draft(text: string, commandIds: string[] = []): ComposerDraft {
  return { text, agentId: null, commandIds, isEmpty: false };
}

/** Park one message and hand back the queue it produced, which is what every case starts from. */
function park(
  queue: readonly QueuedMessage[],
  id: string,
  text: string,
  commandIds: string[] = [],
): readonly QueuedMessage[] {
  return reduceQueue(queue, {
    busy: true,
    draft: draft(text, commandIds),
    id,
    type: "submit",
  }).queue;
}

describe("submitting", () => {
  test("an idle send goes straight out and queues nothing", () => {
    const sent = draft("open the invoices page");
    const result = reduceQueue([], {
      busy: false,
      draft: sent,
      id: "one",
      type: "submit",
    });

    expect(result.run).toBe(sent);
    expect(result.queue).toEqual([]);
  });

  test("an idle send takes anything already waiting with it", () => {
    // Not a state the app is supposed to reach, which is exactly why the rule has to hold here on
    // its own: a new message that jumped the queue would run before the correction it corrects.
    const waiting = park([], "one", "no, the other one");
    const result = reduceQueue(waiting, {
      busy: false,
      draft: draft("the Q3 file"),
      id: "two",
      type: "submit",
    });

    expect(result.run?.text).toBe("no, the other one\nthe Q3 file");
    expect(result.queue).toEqual([]);
  });

  test("an idle send that empties a queue carries its skills too", () => {
    const waiting = park([], "one", "/search invoices", ["search"]);
    const result = reduceQueue(waiting, {
      busy: false,
      draft: draft("/summarize it", ["summarize"]),
      id: "two",
      type: "submit",
    });

    expect(result.run?.commandIds).toEqual(["search", "summarize"]);
  });

  test("a send while the Bot is working waits instead of running", () => {
    const result = reduceQueue([], {
      busy: true,
      draft: draft("no, the other one"),
      id: "one",
      type: "submit",
    });

    expect(result.run).toBeNull();
    expect(result.queue).toEqual([
      { id: "one", text: "no, the other one", commandIds: [] },
    ]);
  });

  test("keeps the order they were typed in", () => {
    let queue = park([], "one", "first");
    queue = park(queue, "two", "second");
    queue = park(queue, "three", "third");

    expect(queue.map((message) => message.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("settling", () => {
  test("a burst of corrections costs one turn, not three", () => {
    let queue = park([], "one", "no, the other one");
    queue = park(queue, "two", "the Q3 file");
    queue = park(queue, "three", "and skip the summary");

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.text).toBe(
      "no, the other one\nthe Q3 file\nand skip the summary",
    );
    expect(result.queue).toEqual([]);
  });

  test("stopping the Bot is what makes the correction run", () => {
    // The whole of stop-then-steer. Nothing below says "stop": pressing it ends the turn, and the
    // end of a turn is the only thing the drain is listening for.
    const queue = park([], "one", "stop reading, just summarise it");

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.text).toBe("stop reading, just summarise it");
    expect(result.queue).toEqual([]);
  });

  test("a turn ending with nothing waiting starts nothing", () => {
    const result = reduceQueue([], { type: "settle" });

    expect(result.run).toBeNull();
    expect(result.queue).toEqual([]);
  });

  test("the drained turn is addressed to nobody in particular", () => {
    const queue = park([], "one", "@Knowledge check that again");

    // The mention stays in the words; the conversation is already bound to one coworker.
    expect(reduceQueue(queue, { type: "settle" }).run?.agentId).toBeNull();
  });

  test("carries the skills that were invoked, once each", () => {
    let queue = park([], "one", "/search invoices", ["search"]);
    queue = park(queue, "two", "/search receipts too", ["search"]);
    queue = park(queue, "three", "/summarize it", ["summarize"]);

    expect(reduceQueue(queue, { type: "settle" }).run?.commandIds).toEqual([
      "search",
      "summarize",
    ]);
  });

  test("draining twice does not resend what has already gone", () => {
    const queue = park([], "one", "no, the other one");
    const drained = reduceQueue(queue, { type: "settle" });

    expect(reduceQueue(drained.queue, { type: "settle" }).run).toBeNull();
  });
});

describe("removing", () => {
  test("takes a message back before it runs", () => {
    let queue = park([], "one", "no, the other one");
    queue = park(queue, "two", "actually never mind");

    const result = reduceQueue(queue, { id: "two", type: "remove" });

    expect(result.queue.map((message) => message.text)).toEqual([
      "no, the other one",
    ]);
    expect(result.run).toBeNull();
  });

  test("what is left is what still runs on settle", () => {
    let queue = park([], "one", "keep this");
    queue = park(queue, "two", "drop this");
    queue = reduceQueue(queue, { id: "two", type: "remove" }).queue;

    expect(reduceQueue(queue, { type: "settle" }).run?.text).toBe("keep this");
  });

  test("removing the last one leaves nothing to run", () => {
    const queue = park([], "one", "second thoughts");
    const left = reduceQueue(queue, { id: "one", type: "remove" }).queue;

    expect(left).toEqual([]);
    expect(reduceQueue(left, { type: "settle" }).run).toBeNull();
  });

  test("an id that is not in the queue changes nothing at all", () => {
    // Same array, not an equal one: a removal that missed must not cost a re-render.
    const queue = park([], "one", "no, the other one");

    expect(reduceQueue(queue, { id: "elsewhere", type: "remove" }).queue).toBe(
      queue,
    );
  });

  test("two identical corrections are two entries and only one is taken back", () => {
    let queue = park([], "one", "no, the other one");
    queue = park(queue, "two", "no, the other one");

    const result = reduceQueue(queue, { id: "one", type: "remove" });

    expect(result.queue).toEqual([
      { id: "two", text: "no, the other one", commandIds: [] },
    ]);
  });
});
