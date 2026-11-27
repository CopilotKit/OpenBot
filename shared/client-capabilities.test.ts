import { expect, test } from "bun:test";
import {
  CAPABILITIES_HEADER,
  COMPUTER_STEP_TAKEN,
  capabilitiesValue,
  hasCapability,
  parseCapabilities,
} from "./client-capabilities";

/*
 * The one reading of what an app says it understands. The server sends a newer answer only to a
 * request naming its token, so a token misread is an app sent an answer it can't read, or one never
 * sent the answer it asked for.
 */
test("the header's tokens are read as the app wrote them, lowercased, each once", () => {
  expect(CAPABILITIES_HEADER).toBe("OpenBot-Capabilities");
  expect([
    ...parseCapabilities("computer-step-taken  conversation-work-turn"),
  ]).toEqual(["computer-step-taken", "conversation-work-turn"]);
  expect([
    ...parseCapabilities(" Computer-Step-Taken computer-step-taken "),
  ]).toEqual(["computer-step-taken"]);
  expect(
    hasCapability(
      "conversation-work-turn computer-step-taken",
      COMPUTER_STEP_TAKEN,
    ),
  ).toBe(true);
});

test("no header, an empty one, or one naming something else does not name the token", () => {
  for (const value of [
    undefined,
    null,
    "",
    "   ",
    "web/1.3.0",
    "computer-step",
  ])
    expect(hasCapability(value, COMPUTER_STEP_TAKEN)).toBe(false);
  // Commas are not separators: a list written that way names nothing this reads.
  expect(hasCapability("computer-step-taken,other", COMPUTER_STEP_TAKEN)).toBe(
    false,
  );
});

test("a list is written as the header reads it", () => {
  const value = capabilitiesValue([
    COMPUTER_STEP_TAKEN,
    "conversation-work-turn",
  ]);
  expect(value).toBe("computer-step-taken conversation-work-turn");
  expect(hasCapability(value, COMPUTER_STEP_TAKEN)).toBe(true);
});
