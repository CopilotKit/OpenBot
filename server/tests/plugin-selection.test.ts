import { describe, expect, test } from "bun:test";
import {
  latestUserText,
  readChosenSkills,
  SELECTION_FLOOR,
  selectionPrompt,
  selectTools,
} from "../src/plugins/selection";

/**
 * Narrowing a Bot's tools to the ones a run is about.
 *
 * Two properties are asserted harder than the rest, because they are the two that would make this
 * dangerous rather than merely wrong. The first is that a skill cannot widen anything: a declaration
 * naming a tool the Bot was never granted must produce nothing, or writing a skill — which anybody
 * signed in may do — becomes a way to grant yourself a tool. The second is the failure direction:
 * every way this can go wrong has to end with the whole catalogue offered, because a selector that
 * fails closed takes away tools an administrator granted, and does it silently.
 */

const tool = (ref: string) => ({ ref });

/** More than `SELECTION_FLOOR`, so selection actually runs. Named for what it is doing. */
const manyTools = [
  ...Array.from({ length: 8 }, (_, index) => tool(`drive/tool_${index}`)),
  ...Array.from({ length: 8 }, (_, index) => tool(`slack/tool_${index}`)),
];

const skills = [
  {
    slug: "drive-audit",
    title: "Drive audit",
    summary: "Read documents out of Google Drive.",
    tools: ["drive/tool_0", "drive/tool_1"],
  },
  {
    slug: "slack-digest",
    title: "Slack digest",
    summary: "Summarise Slack channels.",
    tools: ["slack/tool_0"],
  },
];

const answering = (skillSlugs: string[]) => async () =>
  JSON.stringify({ skills: skillSlugs });

describe("what gets offered", () => {
  test("a small catalogue is offered whole, and pass one is never called", async () => {
    let asked = 0;
    const tools = Array.from({ length: SELECTION_FLOOR }, (_, index) =>
      tool(`drive/tool_${index}`),
    );
    const selection = await selectTools({
      tools,
      skills,
      text: "read my drive",
      choose: async () => {
        asked += 1;
        return JSON.stringify({ skills: [] });
      },
    });
    expect(selection.reason).toBe("under-floor");
    expect(selection.offered).toHaveLength(SELECTION_FLOOR);
    // The point of the floor is the round trip it saves, so the assertion is that it was saved.
    expect(asked).toBe(0);
  });

  test("chosen skills bring their tools, and the rest of their servers stay behind", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills,
      text: "what is in the quarterly report in my drive",
      choose: answering(["drive-audit"]),
    });
    expect(selection.reason).toBe("selected");
    expect(selection.skills).toEqual(["drive-audit"]);
    expect(selection.offered.map((entry) => entry.ref)).toContain(
      "drive/tool_0",
    );
    expect(selection.offered.map((entry) => entry.ref)).toContain(
      "drive/tool_1",
    );
    // Declared by the other skill, and that skill was not chosen.
    expect(selection.offered.map((entry) => entry.ref)).not.toContain(
      "slack/tool_0",
    );
    expect(selection.granted).toBe(manyTools.length);
  });

  test("a tool no skill declares is always offered", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills,
      text: "anything",
      choose: answering(["drive-audit"]),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    /*
     * `slack/tool_1` onwards are granted and claimed by nobody. Dropping them would silently remove
     * a capability an administrator handed over, on the strength of a skill nobody has written yet.
     */
    expect(offered).toContain("slack/tool_1");
    expect(offered).toContain("drive/tool_7");
  });

  test("choosing several skills unions their tools", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills,
      text: "compare the drive doc against the slack thread",
      choose: answering(["drive-audit", "slack-digest"]),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).toContain("drive/tool_0");
    expect(offered).toContain("slack/tool_0");
  });
});

describe("a declaration is not a grant", () => {
  test("a skill naming a tool the Bot does not hold offers nothing extra", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills: [
        {
          slug: "overreach",
          title: "Overreach",
          summary: "Names a tool nobody granted.",
          // Both are absent from `manyTools`. One is a server the Bot has, one is a server it
          // does not; neither may appear, and neither may cause the others to be dropped.
          tools: ["drive/delete_everything", "vault/read_secret"],
        },
        ...skills,
      ],
      text: "delete everything",
      choose: answering(["overreach"]),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).not.toContain("drive/delete_everything");
    expect(offered).not.toContain("vault/read_secret");
    // The offer is still a subset of the grants, which is the invariant that matters.
    for (const entry of offered) {
      expect(manyTools.map((granted) => granted.ref)).toContain(entry);
    }
  });

  test("the offer is never larger than the grant, whatever is chosen", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills,
      text: "everything at once",
      choose: answering(["drive-audit", "slack-digest"]),
    });
    expect(selection.offered.length).toBeLessThanOrEqual(manyTools.length);
  });
});

describe("every failure offers everything", () => {
  test("a selector that throws", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills,
      text: "read my drive",
      choose: async () => {
        throw new Error("no model key");
      },
    });
    expect(selection.reason).toBe("unavailable");
    expect(selection.offered).toHaveLength(manyTools.length);
  });

  test("a selector that answers with something that is not JSON", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills,
      text: "read my drive",
      choose: async () => "I think you want the Drive one",
    });
    expect(selection.reason).toBe("unavailable");
    expect(selection.offered).toHaveLength(manyTools.length);
  });

  test("a selector that answers with JSON of the wrong shape", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills,
      text: "read my drive",
      choose: async () => JSON.stringify({ chosen: "drive-audit" }),
    });
    expect(selection.reason).toBe("unavailable");
    expect(selection.offered).toHaveLength(manyTools.length);
  });

  test("a selector that names no skill at all", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills,
      text: "hello",
      choose: answering([]),
    });
    /*
     * Distinguished from `unavailable` in the trail, and identical in effect. Reading an empty
     * answer as "offer only the undeclared tools" would mean one bad judgement in pass one makes the
     * needed tool absent rather than merely unlikely, which is the categorical failure this design
     * exists to avoid.
     */
    expect(selection.reason).toBe("nothing-chosen");
    expect(selection.offered).toHaveLength(manyTools.length);
  });

  test("no skill declares anything", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills: [
        {
          slug: "prose",
          title: "Prose",
          summary: "Just instructions",
          tools: [],
        },
      ],
      text: "read my drive",
      choose: async () => {
        throw new Error("should not be asked");
      },
    });
    expect(selection.reason).toBe("nothing-declared");
    expect(selection.offered).toHaveLength(manyTools.length);
  });

  test("an empty message", async () => {
    const selection = await selectTools({
      tools: manyTools,
      skills,
      text: "   ",
      choose: async () => {
        throw new Error("should not be asked");
      },
    });
    expect(selection.reason).toBe("unavailable");
    expect(selection.offered).toHaveLength(manyTools.length);
  });
});

describe("reading pass one's answer", () => {
  test("a slug that is not a granted skill is dropped, not fatal", () => {
    expect(
      readChosenSkills(
        JSON.stringify({ skills: ["drive-audit", "invented"] }),
        skills,
      ),
    ).toEqual(["drive-audit"]);
  });

  test("duplicates collapse", () => {
    expect(
      readChosenSkills(
        JSON.stringify({ skills: ["drive-audit", "drive-audit"] }),
        skills,
      ),
    ).toEqual(["drive-audit"]);
  });

  test("non-strings inside the list are dropped", () => {
    expect(
      readChosenSkills(
        JSON.stringify({ skills: [1, null, "slack-digest"] }),
        skills,
      ),
    ).toEqual(["slack-digest"]);
  });

  test("null for anything that is not an object with a list", () => {
    expect(readChosenSkills("[]", skills)).toBeNull();
    expect(readChosenSkills("null", skills)).toBeNull();
    expect(readChosenSkills("{}", skills)).toBeNull();
    expect(readChosenSkills("not json", skills)).toBeNull();
  });

  test("an answer naming only unknown slugs is an empty choice, not a failure", () => {
    // The model answered; it just named nothing real. That is "none apply", and the caller offers
    // everything either way, but the two are different facts and the row says which.
    expect(
      readChosenSkills(JSON.stringify({ skills: ["nope"] }), skills),
    ).toEqual([]);
  });
});

describe("the prompt", () => {
  test("carries every skill and the message, and says which way to err", () => {
    const prompt = selectionPrompt("find the quarterly report", skills);
    expect(prompt).toContain("drive-audit");
    expect(prompt).toContain("Read documents out of Google Drive.");
    expect(prompt).toContain("slack-digest");
    expect(prompt).toContain("find the quarterly report");
    // The asymmetry is the whole reason pass one is safe. If the prompt stops saying it, a model
    // will start being parsimonious and the misses become invisible.
    expect(prompt).toContain("When in");
    expect(prompt).toContain("doubt, include it.");
  });
});

describe("which message pass one reads", () => {
  test("the last user message, not the last message", () => {
    expect(
      latestUserText([
        { role: "user", content: "first" },
        { role: "assistant", content: "an answer" },
        { role: "user", content: "second" },
        { role: "assistant", content: "another answer" },
      ]),
    ).toBe("second");
  });

  test("structured content is flattened to its text parts", () => {
    expect(
      latestUserText([
        {
          role: "user",
          content: [
            { type: "text", text: "look at" },
            { type: "image", url: "http://example.test/x.png" },
            { type: "text", text: "this" },
          ],
        },
      ]),
    ).toBe("look at this");
  });

  test("no user message at all reads as nothing to select against", () => {
    expect(latestUserText([{ role: "system", content: "a role" }])).toBe("");
    expect(latestUserText([])).toBe("");
  });
});
