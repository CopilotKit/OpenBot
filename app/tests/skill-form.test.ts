import { describe, expect, test } from "bun:test";
import { emptySkillForm, skillFormSchema } from "@/lib/skills/form";

/**
 * The declared tools, as the form carries them.
 *
 * A skill needing no tool is the ordinary case, and a skill that had its last one unticked has to
 * submit as an empty array rather than as an absent field — the server replaces the set when the
 * field is present and leaves it alone when it is not, so those two are different requests.
 */

const valid = {
  slug: "standup",
  title: "Standup",
  summary: "",
  instructions: "Summarise yesterday.",
};

describe("declaring the tools a skill needs", () => {
  test("a new skill starts with none declared", () => {
    expect(emptySkillForm.tools).toEqual([]);
    // And the empty form is a shape the schema accepts, apart from the fields a person has to fill.
    expect(
      skillFormSchema.safeParse({ ...emptySkillForm, ...valid }).success,
    ).toBeTrue();
  });

  test("no tools is valid, and stays an array", () => {
    const parsed = skillFormSchema.safeParse({ ...valid, tools: [] });
    expect(parsed.success).toBeTrue();
    // Present rather than stripped: this is what clears the set on a skill that used to declare one.
    expect(parsed.success && parsed.data.tools).toEqual([]);
  });

  test("refs are carried through as written", () => {
    // `<serverId>/<toolName>`, the same key a grant is written against. The form does not reformat
    // them, because the server compares them to grant refs character for character.
    const tools = ["acme-docs/find_document", "acme-chat/search_messages"];
    const parsed = skillFormSchema.safeParse({ ...valid, tools });
    expect(parsed.success && parsed.data.tools).toEqual(tools);
  });

  test("the field is required, so a save always says what the set is now", () => {
    // Omitting it would submit a save the server reads as "leave the tools alone", which is not what
    // a form with nothing ticked means.
    expect(skillFormSchema.safeParse(valid).success).toBeFalse();
  });

  test("a ref this deployment has never seen is left to the server", () => {
    /*
     * Not validated here on purpose. The server refuses an unknown ref with a sentence naming it, and
     * it is the only side that knows which tools exist — a list reconstructed in the browser would go
     * stale the moment a server's tools were refreshed.
     */
    expect(
      skillFormSchema.safeParse({ ...valid, tools: ["nope/not_a_tool"] })
        .success,
    ).toBeTrue();
  });
});
