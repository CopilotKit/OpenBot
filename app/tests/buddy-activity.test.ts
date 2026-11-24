import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { conversationActivity } from "@/lib/buddies/activity";
import { poseFor, stockBuddy } from "@/lib/buddies/buddy";
import { STOCK_BUDDIES } from "@/lib/buddies/stock";

/*
 * The buddy beside the composer plays what the Bot is doing in its turn: thinking until it does
 * something, working while a step it called has no result, talking while it writes, asking while a
 * question is open.
 */

const asked: Message = { id: "u1", role: "user", content: "Plan my week" };

describe("what a conversation's buddy plays", () => {
  test("idle with no turn running, and asking while a question is open", () => {
    expect(
      conversationActivity({ busy: false, waiting: false, messages: [asked] }),
    ).toBe("idle");
    expect(
      conversationActivity({ busy: true, waiting: true, messages: [asked] }),
    ).toBe("waiting");
  });

  test("thinking before the Bot has done anything", () => {
    expect(
      conversationActivity({ busy: true, waiting: false, messages: [asked] }),
    ).toBe("thinking");
  });

  test("working while a step it called has no result, thinking once it has", () => {
    const calling: Message = {
      id: "a1",
      role: "assistant",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "calendar", arguments: "{}" },
        },
      ],
    };
    expect(
      conversationActivity({
        busy: true,
        waiting: false,
        messages: [asked, calling],
      }),
    ).toBe("working");
    const result: Message = {
      id: "t1",
      role: "tool",
      toolCallId: "c1",
      content: "3 meetings",
    };
    expect(
      conversationActivity({
        busy: true,
        waiting: false,
        messages: [asked, calling, result],
      }),
    ).toBe("thinking");
  });

  test("talking while it writes its answer", () => {
    expect(
      conversationActivity({
        busy: true,
        waiting: false,
        messages: [
          asked,
          { id: "a2", role: "assistant", content: "Here is your week" },
        ],
      }),
    ).toBe("talking");
  });

  test("a stock buddy thinks with its thinking pose", () => {
    const buddy = stockBuddy(STOCK_BUDDIES[0] as (typeof STOCK_BUDDIES)[0]);
    expect(poseFor(buddy, "thinking")).toBe("thinking");
  });
});
