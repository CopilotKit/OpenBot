import { describe, expect, test } from "bun:test";
import {
  NOTHING_TO_OFFER,
  OFFER_CHECK_IN_TOOL,
} from "@openbot/shared/check-in-offer";
import { checkInOfferTools } from "../src/proactive/offer-tool";
import type { CheckInSource } from "../src/proactive/scope";
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
    sourceKind: "app",
    sourceServerId: "notion",
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

/** The Bot's tools, as the server would classify them: an app it reads as the person, a web reader. */
const SOURCES: Record<string, CheckInSource> = {
  mcp__notion__fetch: { kind: "app", serverId: "notion", title: "Notion" },
  mcp__parallel__web_fetch: { kind: "page" },
  "mcp__gmail-shared__read": {
    kind: "unreadable",
    serverId: "gmail-shared",
    title: "Gmail",
  },
};

function toolWith(options: {
  allowed?: boolean;
  settings?: ProactiveSetting[];
  readsPages?: boolean;
}) {
  const [tool] = checkInOfferTools({
    ownerUserId: "usr_1",
    agentId: "assistant",
    allowed: async () => options.allowed ?? true,
    list: async () => options.settings ?? [],
    sourceOf: async (name) => SOURCES[name] ?? null,
    readsPages: async () => options.readsPages ?? true,
  });
  if (!tool) throw new Error("no tool");
  return tool;
}

const BRIEF = {
  subject: "Launch brief in Notion",
  link: "https://www.notion.so/launch-brief",
  readWith: "mcp__notion__fetch",
};
const RELEASES = {
  subject: "OpenBot releases",
  link: "https://github.com/CopilotKit/openbot/releases",
  readWith: "mcp__parallel__web_fetch",
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
      "Say what the check-in would watch, and name the tool you read it with as readWith.",
    );
  });

  /*
   * FOUND IN AN AUDIT: a Bot offered a check-in on a page it read in its browser, and the check-in
   * never ran once. What it read with decides, never a label.
   */
  test("read with an app the person connected: the card offers a check-in on that app alone", async () => {
    const answer = await toolWith({}).execute(BRIEF);
    expect(answer).toContain("reading Notion, and nothing else");
    expect(answer).not.toStartWith(NOTHING_TO_OFFER);
  });

  test("read with a page-read tool: a check-in on that page, which needs its public address", async () => {
    expect(await toolWith({}).execute(RELEASES)).toContain("reading that page");
    for (const link of [undefined, "http://localhost:3000/notes"])
      expect(await toolWith({}).execute({ ...RELEASES, link })).toStartWith(
        NOTHING_TO_OFFER,
      );
  });

  test("anything else, like the browser, has nothing to offer and says what to do instead", async () => {
    const answer = String(
      await toolWith({}).execute({
        ...RELEASES,
        readWith: "computer_snapshot",
      }),
    );
    expect(answer).toStartWith(NOTHING_TO_OFFER);
    expect(answer).toContain("routine");
    const shared = String(
      await toolWith({}).execute({
        ...BRIEF,
        readWith: "mcp__gmail-shared__read",
      }),
    );
    expect(shared).toStartWith(NOTHING_TO_OFFER);
    expect(shared).toContain("show_app_access for Gmail");
  });

  test("an older check-in that read every app is offered again on its page", async () => {
    const answer = await toolWith({
      settings: [
        setting({
          sourceLink: RELEASES.link,
          sourceKind: "apps",
          sourceServerId: null,
        }),
      ],
    }).execute(RELEASES);
    expect(answer).toContain("A card in front of the person");
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
