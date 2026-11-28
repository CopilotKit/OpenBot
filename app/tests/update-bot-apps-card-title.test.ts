import { expect, test } from "bun:test";
import { botNamed } from "@/components/settings-tools/update-bot-apps-card";

/**
 * The Bot an `update_bot_apps` card is titled with before the call has an answer.
 *
 * FOUND IN DOGFOODING. A member talking with his organization's General Assistant, a shared Bot he
 * could only view and with no Bot of his own, saw "Your Bot" on every refused call: one named the
 * Bot by its name ("General Assistant"), the others named none, and only an id was looked up.
 */

const ROSTER = [
  { id: "agent_9f2c", name: "General Assistant" },
  { id: "agent_41ab", name: "Knowledge" },
];

test("a call naming the Bot by its id, by its name, or by nothing, is titled with that Bot", () => {
  expect(botNamed(ROSTER, "agent_41ab", "agent_9f2c")).toBe("Knowledge");
  expect(botNamed(ROSTER, "General Assistant", undefined)).toBe(
    "General Assistant",
  );
  expect(botNamed(ROSTER, "the General Assistant Bot", undefined)).toBe(
    "General Assistant",
  );
  // Named none: the Bot this conversation is with.
  expect(botNamed(ROSTER, undefined, "agent_9f2c")).toBe("General Assistant");
  expect(botNamed(ROSTER, null, "agent_9f2c")).toBe("General Assistant");
});

test("a Bot it can't find is left for the card's own word, never 'Your Bot'", () => {
  expect(botNamed(ROSTER, "Nobody's Bot", "agent_9f2c")).toBeUndefined();
  expect(botNamed(undefined, undefined, "agent_9f2c")).toBeUndefined();
});
