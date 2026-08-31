import type { Message } from "@ag-ui/core";
import { describe, expect, test } from "bun:test";
import { toVisibleChatItems } from "../src/components/channels/chat-messages";

/**
 * What a channel transcript shows, out of the messages a run produced.
 *
 * The projection used to name the roles it understood and drop everything else, which was correct
 * while every answer was prose or a tool call. It stopped being correct once a Bot could answer by
 * drawing: a generated interface arrives as an activity message, says nothing in `content`, and
 * pairs with no tool result — so the turn rendered as silence. These cases hold that shut.
 */

const PROSE: Message = {
  id: "assistant-1",
  role: "assistant",
  content: "Here is how those issues group.",
};

/** A generated interface, mid-stream: the HTML grows on every chunk and `generating` is still true. */
const DRAWING: Message = {
  id: "activity-1",
  role: "activity",
  activityType: "open-generative-ui",
  content: {
    css: ".card { color: #0a0a0a }",
    cssComplete: true,
    html: ['<div class="card">'],
    htmlComplete: false,
    generating: true,
  },
};

describe("toVisibleChatItems", () => {
  test("keeps an activity, carrying the message whole", () => {
    expect(toVisibleChatItems([DRAWING])).toEqual([
      { kind: "activity", id: "activity-1", message: DRAWING },
    ]);
  });

  /*
   * The regression this projection had. A Bot that answers only by drawing produces exactly this
   * one message, so dropping it left a turn that had plainly happened showing nothing at all.
   */
  test("does not render a drawing-only turn as silence", () => {
    expect(toVisibleChatItems([DRAWING])).not.toEqual([]);
  });

  test("keeps an activity in its place beside the prose", () => {
    expect(
      toVisibleChatItems([PROSE, DRAWING]).map((item) => item.kind),
    ).toEqual(["text", "activity"]);
  });

  /*
   * An activity is a message in its own right, not something folded into the assistant turn that
   * preceded it: it renders as its own row, and both survive.
   */
  test("draws prose and an activity as two items", () => {
    const items = toVisibleChatItems([PROSE, DRAWING]);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      kind: "text",
      id: "assistant-1",
      role: "assistant",
      text: "Here is how those issues group.",
    });
  });

  // The roles this file already understood, so the addition above is not paid for elsewhere.
  test("still pairs a tool call with the result that answers it", () => {
    const called: Message = {
      id: "assistant-2",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "botActivity", arguments: '{"days":7}' },
        },
      ],
    };
    const answered: Message = {
      id: "result-1",
      role: "tool",
      toolCallId: "call-1",
      content: "42",
    };

    expect(toVisibleChatItems([called, answered])).toEqual([
      {
        kind: "tool",
        id: "call-1",
        toolCall: called.toolCalls?.[0],
        result: "42",
      },
    ]);
  });

  /*
   * The call that produces a generated interface is not a row of its own.
   *
   * Its renderer shows the waiting message and then returns nothing, so keeping the item left an
   * empty child in a `gap-6` column and every generated interface gained a stray gap beneath it.
   */
  test("drops the call that draws an interface, and keeps the interface", () => {
    const drawing: Message = {
      id: "assistant-3",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-2",
          type: "function",
          function: { name: "generateSandboxedUi", arguments: "{}" },
        },
      ],
    };

    expect(toVisibleChatItems([drawing, DRAWING])).toEqual([
      { kind: "activity", id: "activity-1", message: DRAWING },
    ]);
  });

  // Every other tool still gets its row: only the one whose output is the activity is dropped.
  test("keeps a call from any other tool", () => {
    const other: Message = {
      id: "assistant-4",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-3",
          type: "function",
          function: { name: "botActivity", arguments: "{}" },
        },
      ],
    };

    expect(toVisibleChatItems([other]).map((item) => item.kind)).toEqual([
      "tool",
    ]);
  });

  // Roles the transcript has nothing to draw for are still dropped rather than rendered empty.
  test("drops a role it has nothing to show", () => {
    const thinking: Message = {
      id: "reasoning-1",
      role: "reasoning",
      content: "considering the grouping",
    };

    expect(toVisibleChatItems([thinking])).toEqual([]);
  });
});
