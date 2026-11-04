import { describe, expect, test } from "bun:test";
import { OFFER_CHECK_IN_TOOL } from "@openbot/shared/check-in-offer";
import { checkInOfferTools } from "../src/proactive/offer-tool";
import type { ProactiveSetting } from "../src/proactive/types";
import { researchInstruction } from "../src/proactive/window";

/**
 * A Bot offering the person a check-in on one thing, and a check-in watching one thing.
 *
 * The tool writes nothing: it says whether there is anything to offer, and the card in front of the
 * person creates the check-in if they accept.
 */

function setting(overrides: Partial<ProactiveSetting>): ProactiveSetting {
  return {
    id: "set_1",
    ownerUserId: "usr_1",
    agentId: "assistant",
    channelId: "ch_1",
    threadId: "th_1",
    focus: "",
    subject: "",
    sourceLink: null,
    enabled: true,
    intervalMinutes: 1440,
    nextRunAt: new Date(),
    lastRunAt: null,
    lastStatus: "idle",
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function toolWith(options: {
  allowed?: boolean;
  settings?: ProactiveSetting[];
}) {
  const [tool] = checkInOfferTools({
    ownerUserId: "usr_1",
    agentId: "assistant",
    allowed: async () => options.allowed ?? true,
    list: async () => options.settings ?? [],
  });
  if (!tool) throw new Error("no tool");
  return tool;
}

const BRIEF = {
  subject: "Launch brief in Notion",
  link: "https://www.notion.so/launch-brief",
};

describe("offer_check_in", () => {
  test("is offered under its shared name, and tells the model when not to use it", () => {
    const tool = toolWith({});
    expect(tool.name).toBe(OFFER_CHECK_IN_TOOL);
    expect(tool.description).toContain("Not for a one-off lookup");
  });

  test("puts the offer in front of the person, and tells the model not to ask in words", async () => {
    const answer = await toolWith({}).execute(BRIEF);
    expect(answer).toContain("A card in front of the person");
    expect(answer).toContain("Do not ask about it in words");
  });

  test("offers nothing where check-ins are turned off for the person", async () => {
    expect(await toolWith({ allowed: false }).execute(BRIEF)).toContain(
      "Check-ins are turned off",
    );
  });

  test("says so where this Bot already watches the same page", async () => {
    const answer = await toolWith({
      settings: [setting({ sourceLink: BRIEF.link, subject: "Brief" })],
    }).execute(BRIEF);
    expect(answer).toContain("You already check");
  });

  test("a check-in that was turned off, or another Bot's, is offered again", async () => {
    for (const settings of [
      [setting({ sourceLink: BRIEF.link, enabled: false })],
      [setting({ sourceLink: BRIEF.link, agentId: "researcher" })],
    ])
      expect(await toolWith({ settings }).execute(BRIEF)).toContain(
        "A card in front of the person",
      );
  });

  test("arguments that name nothing are refused", async () => {
    expect(await toolWith({}).execute({ subject: " " })).toBe(
      "Say what the check-in would watch.",
    );
  });
});

describe("a check-in on one thing", () => {
  const window = {
    now: new Date("2026-11-04T09:00:00Z"),
    since: new Date("2026-11-03T09:00:00Z"),
    firstRun: false,
  };

  test("reads only what it watches", () => {
    const said = researchInstruction(
      { focus: "", subject: BRIEF.subject, sourceLink: BRIEF.link },
      window,
    );
    expect(said).toContain(
      `This check-in watches one thing for them: ${BRIEF.subject} (${BRIEF.link}). Read only that`,
    );
    expect(said).not.toContain("changes to their plans");
  });

  test("one that watches everything reads as it always did", () => {
    const said = researchInstruction({ focus: "" }, window);
    expect(said).not.toContain("watches one thing");
    expect(said).toContain("changes to their plans");
  });
});
