import type { Attachment } from "@copilotkit/react-core/v2";
import { describe, expect, test } from "bun:test";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/channels/attachments";
import type { ComposerDraft } from "./draft";
import { type QueuedMessage, reduceQueue } from "./queue";

function attachment(id: string): Attachment {
  return {
    id,
    type: "image",
    source: { type: "url", value: `https://example.com/${id}.png` },
    status: "ready",
  };
}

function draft(
  text: string,
  commandIds: string[] = [],
  attachments: Attachment[] = [],
): ComposerDraft {
  return { text, agentId: null, commandIds, isEmpty: false, attachments };
}

/** Park one message and hand back the queue it produced, which is what every case starts from. */
function park(
  queue: readonly QueuedMessage[],
  id: string,
  text: string,
  commandIds: string[] = [],
  attachments: Attachment[] = [],
): readonly QueuedMessage[] {
  return reduceQueue(queue, {
    busy: true,
    draft: draft(text, commandIds, attachments),
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

  test("an idle send keeps its own @mention whether or not anything was parked", () => {
    // Routing must not depend on a coincidence. The same draft, sent twice: once into an empty
    // queue and once into one that happened to hold a leftover, and the coworker it is addressed
    // to has to be the same coworker both times. The join used to hardcode `agentId: null`, so the
    // second send silently fell back to the channel's default and the mention became decoration.
    const addressed: ComposerDraft = {
      ...draft("@Knowledge the Q3 file"),
      agentId: "knowledge",
    };

    const alone = reduceQueue([], {
      busy: false,
      draft: addressed,
      id: "two",
      type: "submit",
    });
    const joined = reduceQueue(park([], "one", "no, the other one"), {
      busy: false,
      draft: addressed,
      id: "two",
      type: "submit",
    });

    expect(alone.run?.agentId).toBe("knowledge");
    expect(joined.run?.agentId).toBe("knowledge");
  });

  test("an idle send with no mention still lets the channel pick", () => {
    const joined = reduceQueue(park([], "one", "no, the other one"), {
      busy: false,
      draft: draft("the Q3 file"),
      id: "two",
      type: "submit",
    });

    expect(joined.run?.agentId).toBeNull();
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
      {
        id: "one",
        text: "no, the other one",
        commandIds: [],
        attachments: [],
      },
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

  test("a parked screenshot with no words does not become a blank line", () => {
    // A message can be an attachment and nothing else — `canSendDraft` unlocks Send on attachments
    // alone, so a screenshot pasted mid-turn parks with an empty text. Joining that in as a line
    // opens the drained turn with a blank one, which reads as an instruction nobody typed.
    const shot = attachment("screenshot");
    let queue = park([], "one", "", [], [shot]);
    queue = park(queue, "two", "what is wrong with this");

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.text).toBe("what is wrong with this");
    // The file still rides along; it is the empty LINE that goes, not the message carrying it.
    expect(result.run?.attachments).toEqual([shot]);
  });

  test("an empty message between two typed ones does not split them apart", () => {
    let queue = park([], "one", "no, the other one");
    queue = park(queue, "two", "", [], [attachment("screenshot")]);
    queue = park(queue, "three", "the Q3 file");

    expect(reduceQueue(queue, { type: "settle" }).run?.text).toBe(
      "no, the other one\nthe Q3 file",
    );
  });

  test("a drain of nothing but attachments has no text and admits it", () => {
    // `isEmpty` is a claim about the words, and the drained draft used to assert `false`
    // unconditionally. With nothing but a screenshot parked there are no words at all, and the
    // one field that answers that question has to say so rather than repeat a constant.
    const queue = park([], "one", "", [], [attachment("screenshot")]);

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.text).toBe("");
    expect(result.run?.isEmpty).toBe(true);
  });

  test("a drain with words still reports itself as non-empty", () => {
    const queue = park([], "one", "no, the other one");

    expect(reduceQueue(queue, { type: "settle" }).run?.isEmpty).toBe(false);
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

  /*
   * WHAT THIS BLOCK USED TO NOT SAY, AND WHY IT MATTERED. Every case above is about which words
   * survive a removal, and none of them was about the FILES the removed message was carrying. The
   * composer hands its staged attachments to the queue and takes them off its own strip in the
   * same breath, so a parked message holds the only reference anything has to those rows — and
   * `remove` used to drop that reference, leaving the rows staged server-side with `attachedAt
   * IS NULL` until the 24-hour sweep, counting against the person's eight-per-channel limit and
   * surfacing as a 409 naming files on nobody's screen. `droppedAttachments` is how the removal
   * hands them back, and these are the assertions that would have caught it.
   */
  test("taking a message back hands its attachments back to be released", () => {
    const receipt = attachment("receipt");
    const queue = park([], "one", "here's the file", [], [receipt]);

    const result = reduceQueue(queue, { id: "one", type: "remove" });

    expect(result.queue).toEqual([]);
    expect(result.droppedAttachments).toEqual([receipt]);
  });

  test("only the removed message's attachments come back, not the ones still waiting", () => {
    // The survivors are still going to be sent, so handing them over for release would delete the
    // rows out from under a turn that has not run yet.
    const kept = attachment("kept");
    const dropped = attachment("dropped");
    let queue = park([], "one", "keep this", [], [kept]);
    queue = park(queue, "two", "drop this", [], [dropped]);

    const result = reduceQueue(queue, { id: "two", type: "remove" });

    expect(result.droppedAttachments).toEqual([dropped]);
    expect(
      reduceQueue(result.queue, { type: "settle" }).run?.attachments,
    ).toEqual([kept]);
  });

  test("taking back a message that carried nothing releases nothing", () => {
    const queue = park([], "one", "second thoughts");

    expect(
      reduceQueue(queue, { id: "one", type: "remove" }).droppedAttachments,
    ).toEqual([]);
  });

  test("a removal that missed releases nothing", () => {
    // Nothing left the queue, so nothing may be deleted — a release keyed on a miss would take
    // the rows off a message still sitting on screen waiting to run.
    const queue = park(
      [],
      "one",
      "here's the file",
      [],
      [attachment("receipt")],
    );

    expect(
      reduceQueue(queue, { id: "elsewhere", type: "remove" })
        .droppedAttachments,
    ).toEqual([]);
  });

  test("two identical corrections are two entries and only one is taken back", () => {
    let queue = park([], "one", "no, the other one");
    queue = park(queue, "two", "no, the other one");

    const result = reduceQueue(queue, { id: "one", type: "remove" });

    expect(result.queue).toEqual([
      { id: "two", text: "no, the other one", commandIds: [], attachments: [] },
    ]);
  });
});

describe("attachments", () => {
  test("a queued message's attachments join the drained draft", () => {
    const file = attachment("receipt");
    const queue = park([], "one", "here's the file", [], [file]);

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.attachments).toEqual([file]);
  });

  test("attachments from two queued messages land in queue order", () => {
    const first = attachment("first");
    const second = attachment("second");
    let queue = park([], "one", "the first one", [], [first]);
    queue = park(queue, "two", "and the second one", [], [second]);

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.attachments).toEqual([first, second]);
  });

  test("an idle send that empties a queue also merges attachments in order", () => {
    const queued = attachment("queued");
    const submitted = attachment("submitted");
    const waiting = park([], "one", "no, the other one", [], [queued]);

    const result = reduceQueue(waiting, {
      busy: false,
      draft: draft("the Q3 file", [], [submitted]),
      id: "two",
      type: "submit",
    });

    expect(result.run?.attachments).toEqual([queued, submitted]);
  });

  /*
   * THE IDLE-SEND JOIN IS THE SECOND WAY INTO `joinQueued`, AND IT WAS ONLY EVER TESTED FOR ORDER.
   * The case above says merged attachments keep their order and stops there — so every rule the
   * join applies on the way out was pinned on the `settle` path alone, and an idle send that
   * emptied a queue could have overrun the cap, or eaten the overflow silently, with nothing here
   * to notice. Both paths produce a draft that has to be sendable, so both get asked.
   */
  test("an idle send that empties a queue is capped like any other drain", () => {
    // A full load parked, and one more attached to the send that joins it: nine against a cap of
    // eight, assembled by a step that never re-asked.
    const parked = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE },
      (_, index) => attachment(`parked-${index}`),
    );
    const waiting = park([], "one", "the invoices", [], parked);

    const result = reduceQueue(waiting, {
      busy: false,
      draft: draft("and this one", [], [attachment("live")]),
      id: "two",
      type: "submit",
    });

    expect(result.run?.attachments).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    // The earliest survive, so the live send's own file is the one that goes: it arrived last.
    expect(result.run?.attachments).toEqual(parked);
  });

  test("an idle send that empties a queue reports what the cap bumped off", () => {
    const live = attachment("live");
    const waiting = park(
      [],
      "one",
      "the invoices",
      [],
      Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) =>
        attachment(`parked-${index}`),
      ),
    );

    const result = reduceQueue(waiting, {
      busy: false,
      draft: draft("and this one", [], [live]),
      id: "two",
      type: "submit",
    });

    // Still staged server-side, so a silent slice here is a 409 on this person's next upload with
    // no way back to the file that caused it.
    expect(result.droppedAttachments).toEqual([live]);
  });

  test("an idle send that empties a queue under the cap reports nothing dropped", () => {
    const waiting = park([], "one", "the invoices", [], [attachment("parked")]);

    const result = reduceQueue(waiting, {
      busy: false,
      draft: draft("and this one", [], [attachment("live")]),
      id: "two",
      type: "submit",
    });

    expect(result.droppedAttachments).toEqual([]);
  });

  test("a message with no attachments contributes none, leaving text-merging untouched", () => {
    let queue = park([], "one", "no, the other one");
    queue = park(queue, "two", "the Q3 file");
    queue = park(queue, "three", "and skip the summary");

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.text).toBe(
      "no, the other one\nthe Q3 file\nand skip the summary",
    );
    expect(result.run?.attachments).toEqual([]);
  });

  test("the drained draft is capped, however many messages fed it", () => {
    // The cap is checked as files are staged, one draft at a time, so three parked messages
    // carrying a full load each would drain into one draft of three times the limit — a message
    // this deployment does not accept, assembled by a step that never re-asked.
    const staged = (message: string) =>
      Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) =>
        attachment(`${message}-${index}`),
      );
    let queue = park([], "one", "the invoices", [], staged("one"));
    queue = park(queue, "two", "and these", [], staged("two"));
    queue = park(queue, "three", "these too", [], staged("three"));

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.attachments).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    // The earliest survive, so what is kept is what the person picked first rather than an
    // arbitrary slice of a flattened list.
    expect(result.run?.attachments).toEqual(staged("one"));
  });

  test("what the cap bumps off a drained turn is reported, not just dropped", () => {
    // Three parked messages of a full load each: eight kept by the cap, sixteen that the cap
    // re-check would otherwise erase without a trace. Those sixteen are still staged
    // server-side, so losing track of them here is what turns into a confusing 409 on this
    // person's next upload.
    const staged = (message: string) =>
      Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) =>
        attachment(`${message}-${index}`),
      );
    let queue = park([], "one", "the invoices", [], staged("one"));
    queue = park(queue, "two", "and these", [], staged("two"));
    queue = park(queue, "three", "these too", [], staged("three"));

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.run?.attachments).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(result.droppedAttachments).toHaveLength(
      2 * MAX_ATTACHMENTS_PER_MESSAGE,
    );
    // Queue order, not the reverse: the survivors are message one's files, so the reported
    // list is what message two contributed followed by what message three contributed.
    expect(result.droppedAttachments).toEqual([
      ...staged("two"),
      ...staged("three"),
    ]);
  });

  test("a drain inside the cap reports nothing dropped", () => {
    const file = attachment("receipt");
    const queue = park([], "one", "here's the file", [], [file]);

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.droppedAttachments).toEqual([]);
  });
});

/**
 * WHICH OF A RUN'S ATTACHMENTS HAVE NOWHERE TO GO BACK TO IF THE RUN NEVER BECOMES A MESSAGE.
 *
 * `droppedAttachments` covers the files a transition refused to carry. These cases are about the
 * other half of the same worry: the files it DID carry, and whether carrying them was the last
 * anybody sees of them. A drained turn is built out of messages the composer let go of as they
 * were parked, so a failed drain strands every row it was holding; a live send that joins a
 * non-empty queue is built out of both kinds at once, and the composer puts its OWN chips back
 * beside the restored words — so releasing those would delete rows behind chips somebody can see
 * and press send on again.
 *
 * The distinction is only visible here, in the transition. By the time `conversation-view.tsx`
 * has a rejected promise in hand, the queue that knew where each attachment came from is empty.
 */
describe("stranding", () => {
  test("a drain strands everything it drained, because nothing else was holding it", () => {
    const first = attachment("first");
    const second = attachment("second");
    let queue = park([], "one", "the invoices", [], [first]);
    queue = park(queue, "two", "and these", [], [second]);

    const result = reduceQueue(queue, { type: "settle" });

    expect(result.strandedIfRunFails).toEqual([first, second]);
  });

  test("a settle with nothing waiting strands nothing", () => {
    const result = reduceQueue([], { type: "settle" });

    expect(result.strandedIfRunFails).toEqual([]);
  });

  test("an idle send with nothing waiting strands nothing: the composer still holds its own", () => {
    // THE CASE THAT MUST STAY EMPTY. The run here IS the draft in the box; a failed send hands the
    // words and the chips straight back, so releasing them would delete the rows behind chips that
    // are on screen again and still sendable.
    const own = attachment("own");
    const result = reduceQueue([], {
      busy: false,
      draft: draft("the Q3 file", [], [own]),
      id: "one",
      type: "submit",
    });

    expect(result.strandedIfRunFails).toEqual([]);
  });

  test("an idle send that empties a queue strands the parked half and not its own", () => {
    const parked = attachment("parked");
    const own = attachment("own");
    const waiting = park([], "one", "no, the other one", [], [parked]);

    const result = reduceQueue(waiting, {
      busy: false,
      draft: draft("the Q3 file", [], [own]),
      id: "two",
      type: "submit",
    });

    // Both ride out on the same run — the queue was emptied to build it — but only one of them
    // has nobody left to give it back.
    expect(result.run?.attachments).toEqual([parked, own]);
    expect(result.strandedIfRunFails).toEqual([parked]);
  });

  test("what the cap already bumped off is not stranded a second time", () => {
    // The excess is reported through `droppedAttachments` and released there. Naming it here too
    // would issue a second DELETE for a row that is already gone, on the one path that produces
    // both lists at once.
    const own = attachment("own");
    const parked = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE },
      (_, index) => attachment(`parked-${index}`),
    );
    const waiting = park([], "one", "the invoices", [], parked);

    const result = reduceQueue(waiting, {
      busy: false,
      draft: draft("and this one", [], [own]),
      id: "two",
      type: "submit",
    });

    expect(result.droppedAttachments).toEqual([own]);
    expect(result.strandedIfRunFails).toEqual(parked);
    expect(result.strandedIfRunFails).not.toContain(own);
  });

  test("parking strands nothing: there is no run, and the queue is still holding them", () => {
    const file = attachment("receipt");
    const result = reduceQueue([], {
      busy: true,
      draft: draft("here's the file", [], [file]),
      id: "one",
      type: "submit",
    });

    expect(result.run).toBeNull();
    expect(result.strandedIfRunFails).toEqual([]);
  });

  test("taking a queued message back strands nothing: those rows go out as dropped instead", () => {
    const file = attachment("receipt");
    const queue = park([], "one", "here's the file", [], [file]);

    const result = reduceQueue(queue, { id: "one", type: "remove" });

    expect(result.droppedAttachments).toEqual([file]);
    expect(result.strandedIfRunFails).toEqual([]);
  });
});
