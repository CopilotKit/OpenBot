import { describe, expect, test } from "bun:test";
import { frameFiring } from "../../shared/routine-firing";
import { isPersonSentMessage } from "../src/components/channels/chat-transcript";

/**
 * A routine firing is persisted with `role: "user"`, which is right for the model — it is the turn's
 * user message — and wrong for anything that reads the role as "the person did this". The transcript
 * itself already knows the difference (`RoutineFiring` vs. a person's bubble); this is the predicate
 * the scroll machinery uses to catch up, so a firing landing while somebody is reading back through
 * the channel does not yank their viewport as though they had just sent something.
 */

describe("isPersonSentMessage", () => {
  test("a person's own plain message is theirs", () => {
    expect(isPersonSentMessage("user", "when does the offer expire?")).toBe(
      true,
    );
  });

  test("a routine firing wears role: user but was never typed by anyone", () => {
    const firing = frameFiring("Check the queue and summarize backlog age.");
    expect(isPersonSentMessage("user", firing)).toBe(false);
  });

  test("an assistant message is never the person's, framed or not", () => {
    expect(isPersonSentMessage("assistant", "Here is what changed.")).toBe(
      false,
    );
  });
});
