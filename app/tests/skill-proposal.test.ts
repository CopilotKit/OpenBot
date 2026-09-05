import { describe, expect, test } from "bun:test";
import type { PluginServer, PluginSkill } from "@/lib/plugins/queries";
import {
  checkProposal,
  describeSkill,
  describeSkills,
  describeToolRefs,
  ownershipOf,
  skillCardAnswer,
  wasSaved,
} from "@/lib/skills/proposal";

/**
 * A skill a Bot wrote, on its way to the card somebody presses.
 *
 * The checking is here rather than left to the server because the alternative is a person being shown
 * a card for a skill that cannot be saved. So these tests are about one thing: a problem a model can
 * fix reaches the model, and everything else reaches the person unchanged.
 */

const skill = (over: Partial<PluginSkill> = {}): PluginSkill => ({
  id: "skill_1",
  slug: "check-a-claim",
  ownerUserId: null,
  title: "Check a claim against a source",
  summary: "Take a statement and check it against the documents.",
  instructions: "You are checking a claim, not answering a question.",
  origin: "package",
  installedBy: null,
  grantedTo: [],
  tools: [],
  ...over,
});

describe("checking what a Bot proposed", () => {
  test("a complete proposal passes and keeps every field", () => {
    const checked = checkProposal({
      slug: "weekly-summary",
      title: "Weekly summary",
      summary: "Summarise the week.",
      instructions: "List what moved this week, newest first.",
      tools: ["google-drive/search_files"],
    });
    expect(checked.ok).toBeTrue();
    if (!checked.ok) return;
    expect(checked.values).toEqual({
      slug: "weekly-summary",
      title: "Weekly summary",
      summary: "Summarise the week.",
      instructions: "List what moved this week, newest first.",
      tools: ["google-drive/search_files"],
    });
  });

  test("a slug a model wrote as a title is refused, naming the field", () => {
    const checked = checkProposal({
      slug: "Weekly Summary",
      title: "Weekly summary",
      instructions: "List what moved.",
    });
    expect(checked.ok).toBeFalse();
    if (checked.ok) return;
    // The field is the repair instruction: a model told only "invalid" would guess at which of four.
    expect(checked.problems.join(" ")).toContain("slug:");
  });

  test("missing instructions are a problem rather than an empty skill", () => {
    const checked = checkProposal({ slug: "standup", title: "Standup" });
    expect(checked.ok).toBeFalse();
    if (checked.ok) return;
    expect(checked.problems.join(" ")).toContain("instructions:");
  });

  test("an absent summary is an empty one, not a problem", () => {
    const checked = checkProposal({
      slug: "standup",
      title: "Standup",
      instructions: "Summarise yesterday.",
    });
    expect(checked.ok).toBeTrue();
    if (!checked.ok) return;
    expect(checked.values.summary).toBe("");
  });

  test("declaring no tools is ordinary, and arrives as an empty array", () => {
    const checked = checkProposal({
      slug: "standup",
      title: "Standup",
      instructions: "Summarise yesterday.",
    });
    expect(checked.ok).toBeTrue();
    if (!checked.ok) return;
    // Sent rather than omitted: the server replaces the declared set when the field is present.
    expect(checked.values.tools).toEqual([]);
  });

  test("one tool sent as a bare string is read as that one tool", () => {
    // A model that answers with the string meant the single tool. Refusing would send it back to
    // redo a whole proposal over a comma, and declaring nothing is always valid anyway.
    const checked = checkProposal({
      slug: "standup",
      title: "Standup",
      instructions: "Summarise yesterday.",
      tools: "notion/notion-search",
    });
    expect(checked.ok).toBeTrue();
    if (!checked.ok) return;
    expect(checked.values.tools).toEqual(["notion/notion-search"]);
  });

  test("junk among the tools is dropped rather than failing the proposal", () => {
    const checked = checkProposal({
      slug: "standup",
      title: "Standup",
      instructions: "Summarise yesterday.",
      tools: ["notion/notion-search", 7, null, "  ", "notion/notion-fetch"],
    });
    expect(checked.ok).toBeTrue();
    if (!checked.ok) return;
    expect(checked.values.tools).toEqual([
      "notion/notion-search",
      "notion/notion-fetch",
    ]);
  });
});

describe("whose a skill is", () => {
  test("a deployment skill belongs to nobody in particular", () => {
    expect(ownershipOf(skill({ ownerUserId: null }), "user_1")).toBe(
      "the deployment's",
    );
  });

  test("a person's own skill is theirs", () => {
    expect(ownershipOf(skill({ ownerUserId: "user_1" }), "user_1")).toBe(
      "yours",
    );
  });

  test("somebody else's is named as such, including when nobody is signed in", () => {
    expect(ownershipOf(skill({ ownerUserId: "user_2" }), "user_1")).toBe(
      "someone else's",
    );
    expect(ownershipOf(skill({ ownerUserId: "user_2" }), undefined)).toBe(
      "someone else's",
    );
  });
});

describe("what already exists here", () => {
  test("an empty deployment says every slug is free", () => {
    expect(describeSkills([], "user_1")).toContain("Any slug is free");
  });

  test("each skill is one line, with whose it is and what it needs", () => {
    const answer = describeSkills(
      [
        skill({ slug: "mine", ownerUserId: "user_1", title: "Mine" }),
        skill({
          slug: "theirs",
          ownerUserId: "user_2",
          title: "Theirs",
          tools: ["notion/notion-search"],
        }),
      ],
      "user_1",
    );
    expect(answer).toContain("/mine — Mine (yours)");
    expect(answer).toContain("/theirs — Theirs (someone else's)");
    expect(answer).toContain("needs notion/notion-search");
    // The count and the rule that stops a model taking a name it cannot have.
    expect(answer).toContain("2 skills exist here");
    expect(answer).toContain("cannot be replaced");
  });

  test("the listing carries no instructions, because forty of them is a context window", () => {
    const answer = describeSkills(
      [skill({ instructions: "SECRET-LONG-INSTRUCTION" })],
      "user_1",
    );
    expect(answer).not.toContain("SECRET-LONG-INSTRUCTION");
  });

  test("reading one skill does carry its instructions, which is the point of it", () => {
    const answer = describeSkill(
      skill({ instructions: "Quote the sentence you rely on." }),
    );
    expect(answer).toContain("Quote the sentence you rely on.");
    expect(answer).toContain("Declared tools: (none)");
  });
});

describe("the tool refs a skill may declare", () => {
  const server = (over: Partial<PluginServer> = {}): PluginServer =>
    ({
      id: "notion",
      title: "Notion",
      tools: [
        {
          serverId: "notion",
          name: "notion-search",
          description: "Search Notion.",
          inputSchema: {},
          ref: "notion/notion-search",
          effect: "read",
          grantedTo: [],
        },
      ],
      ...over,
    }) as PluginServer;

  test("a deployment with no connector says a skill can only be prose", () => {
    expect(describeToolRefs([])).toContain("only be prose");
  });

  test("refs are grouped by connector and a write says so", () => {
    const answer = describeToolRefs([
      server({
        tools: [
          {
            serverId: "notion",
            name: "notion-create",
            description: "Create a page.",
            inputSchema: {},
            ref: "notion/notion-create",
            effect: "write",
            grantedTo: [],
          },
        ],
      }),
    ]);
    expect(answer).toContain("Notion (notion):");
    expect(answer).toContain("notion/notion-create (writes)");
  });

  test("a connector advertising nothing is left out rather than shown empty", () => {
    const answer = describeToolRefs([
      server(),
      server({ id: "drive", title: "Drive", tools: [] }),
    ]);
    expect(answer).toContain("Notion (notion):");
    expect(answer).not.toContain("Drive (drive):");
  });

  test("every connector is offered, not only the ones this Bot holds", () => {
    // A declaration is not a grant. Narrowing this to the current Bot's grants would quietly produce
    // skills that stop working the moment they are put on a different Bot.
    const answer = describeToolRefs([server({ tools: server().tools })]);
    expect(answer).toContain("notion/notion-search");
  });
});

describe("what the card answers its tool call with", () => {
  test("a saved answer is recognised as one, by the card that wrote it", () => {
    // The pairing is the point: a completed card decides whether to offer the "put it on a Bot" link
    // by reading its own recorded answer, so a reword must not be able to separate the two.
    expect(wasSaved(skillCardAnswer.saved("weekly-summary"))).toBeTrue();
    expect(skillCardAnswer.saved("weekly-summary")).toContain(
      "/weekly-summary",
    );
  });

  test("declining and refusing are not saves", () => {
    expect(wasSaved(skillCardAnswer.declined())).toBeFalse();
    expect(wasSaved(skillCardAnswer.unwritable(["slug: no."]))).toBeFalse();
  });

  test("a saved answer names the step that is left, because the skill is on no Bot", () => {
    expect(skillCardAnswer.saved("standup")).toContain("Skills page");
  });

  test("an invalid proposal is answered with the problems, so the model can retry", () => {
    const answer = skillCardAnswer.unwritable([
      "slug: Lower-case letters.",
      "instructions: Instructions are required.",
    ]);
    expect(answer).toContain("slug: Lower-case letters.");
    expect(answer).toContain("instructions: Instructions are required.");
    expect(answer).toContain("propose it again");
  });

  test("declining tells the Bot to ask rather than to try again unchanged", () => {
    expect(skillCardAnswer.declined()).toContain("Ask what to change");
  });
});
