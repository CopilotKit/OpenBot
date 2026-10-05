import { z } from "zod";
import type { PluginServer, PluginSkill } from "@/lib/plugins/queries";
import { type SkillFormValues, skillFormSchema } from "./form";

/**
 * A skill a Bot proposes during a conversation, and the checks it goes through before anybody is
 * asked to approve it.
 *
 * WHY A SEPARATE SHAPE FROM THE FORM'S. `form.ts` describes what a person typed into four fields; a
 * model hands over the same four as arguments it may have got wrong in ways a form cannot — a slug
 * with a capital letter in it, a title the length of a paragraph, `tools` arriving as a string. So
 * the model-facing schema is permissive about types and the checking is done afterwards, against the
 * same `skillFormSchema` the form uses. That way a Bot writing a skill and a person writing one are
 * held to one rule, and there is no second parser to drift from the server's.
 *
 * Nothing here decides whether the skill may be saved. That is the server's, and it stays the
 * server's: a skill is an instruction rather than a capability, so the question is only ever whose
 * name the slug is under, which `POST /api/plugins/skills` answers with a sentence.
 */

/**
 * What the card answers its tool call with, and the one fact it reads back out.
 *
 * WHY THESE ARE HERE AND NOT ON THE CARD. A completed card has only the result string to go on — the
 * SDK hands back what the tool answered, not what happened — so whether to offer the "put it on a
 * Bot" link is decided by reading the sentence. Written on the card, the sentence and the reader of
 * the sentence were two literals a reword could silently separate, and the failure is a link that
 * quietly stops appearing. Paired here, and pinned by a test, they cannot drift.
 *
 * The sentences are addressed to the model, because that is who receives them. Each one says what to
 * do next, since a tool result that only reports state leaves the Bot to guess whether the turn is
 * finished.
 */
const SAVED_MARKER = "Saved.";

export const skillCardAnswer = {
  saved: (slug: string) =>
    `${SAVED_MARKER} /${slug} is now in the slash menu. It is on no Bot yet — putting it on one is done from the Skills page, so tell the person that is the remaining step.`,
  declined: () =>
    "The person did not save this skill. Ask what to change rather than saving it again unchanged.",
  /** A proposal the fields refuse, answered rather than shown as a question. See the card. */
  unwritable: (problems: readonly string[]) =>
    `Not saved, and the person was not asked, because the skill is not valid: ${problems.join(" ")} Fix those and propose it again.`,
};

/** Whether a completed card's recorded answer is one that wrote a skill. */
export function wasSaved(result: string): boolean {
  return result.startsWith(SAVED_MARKER);
}

/**
 * The skill whose grant turns a Bot into one you can write skills with.
 *
 * The app offers `save_skill` and the reads beside it only while the active Bot holds this slug, and
 * the shipped package is what puts the slug in the deployment and on a Bot. So the two have to agree:
 * rename it in one place and writing a skill in a conversation stops working with nothing on screen
 * to say why. `skill-creator-slug.test.ts` is the guard, which is why this lives in a module with no
 * React in it rather than beside the hooks that read it.
 *
 * Not an MCP ref, and deliberately not declared in `skills.yaml`'s `tools:`. A declaration there is
 * intersected with the Bot's MCP grants, so naming the app's own tools would name nothing.
 */
export const SKILL_CREATOR_SLUG = "skill-creator";

/**
 * The arguments the model is offered, described for the model rather than for us.
 *
 * Every `describe` here is read by the thing filling the field in, which is why they say what good
 * looks like instead of restating the type. The slug rule is spelled out because a model that has
 * seen `Find A Document` in a title will otherwise offer it as a command.
 */
export const proposedSkillSchema = z.object({
  slug: z
    .string()
    .describe(
      "The `/` command, in lower-case letters, numbers and hyphens: `check-a-claim`, not `Check A Claim`. 2 to 40 characters. This is the skill's identity — reusing one that already exists replaces that skill.",
    ),
  title: z
    .string()
    .describe(
      "What the skill is called in the menu, in a few words of sentence case: `Check a claim against a source`. Up to 120 characters.",
    ),
  summary: z
    .string()
    .optional()
    .describe(
      "One line under the title, saying what invoking it will do. Up to 200 characters. Omit only if the title already says everything.",
    ),
  instructions: z
    .string()
    .describe(
      "The instruction the Bot follows when somebody invokes this skill, written as directions to the Bot in the imperative. Say what to do, in what order, what to do when a step turns up nothing, and what the answer should contain. Explain why a step matters rather than only naming it. Do not describe the skill in the third person, and do not address the person invoking it.",
    ),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      "The tools the skill needs, as `serverId/toolName` refs from list_skill_tools. This is a declaration, not a grant: naming a tool cannot make it callable, and a skill naming a tool its Bot does not hold simply loads nothing. Omit for a skill that is only prose.",
    ),
});

export type ProposedSkill = z.infer<typeof proposedSkillSchema>;

/** What checking a proposal answers with: the four fields to save, or the problems to fix. */
export type CheckedProposal =
  | { ok: true; values: SkillFormValues }
  | { ok: false; problems: string[] };

/**
 * Hold a proposal to the same rule the form is held to.
 *
 * Checked here rather than left to the server because the alternative is a person being shown a card
 * for a skill that cannot be saved, pressing Create, and reading a validation message as though they
 * had done something wrong. A problem the model can fix should reach the model, not the person.
 *
 * The problems name their field, because that is the only part a model needs in order to try again:
 * "slug: Lower-case letters, numbers and hyphens, 2 to 40 characters." is a repair instruction,
 * while "invalid input" is a guess.
 */
export function checkProposal(args: {
  slug?: unknown;
  title?: unknown;
  summary?: unknown;
  instructions?: unknown;
  tools?: unknown;
}): CheckedProposal {
  const parsed = skillFormSchema.safeParse({
    slug: typeof args.slug === "string" ? args.slug : "",
    title: typeof args.title === "string" ? args.title : "",
    // Optional on the server too, so an absent one is an empty one rather than a problem.
    summary: typeof args.summary === "string" ? args.summary : "",
    instructions:
      typeof args.instructions === "string" ? args.instructions : "",
    /*
     * Anything that is not a list of strings is dropped rather than refused. A model that answers
     * `tools: "google-drive/search_files"` meant the one tool, and a refusal here would send it back
     * to redo the whole proposal over a comma. Declaring nothing is always a valid skill.
     */
    tools: toolRefsIn(args.tools),
  });
  if (parsed.success) return { ok: true, values: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    }),
  };
}

/** Tool refs out of whatever the model sent, keeping the strings and a lone string on its own. */
function toolRefsIn(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((ref): ref is string => typeof ref === "string")
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
}

/**
 * Whose a skill is, in the words the answer uses.
 *
 * Ownership rather than permission, and the distinction is the point. Who may replace a slug is
 * decided by the server and nowhere else; what this says is the fact a model needs in order not to
 * try — the same fact the Skills page groups its two lists by. A model told "someone else's" and
 * told in its instructions that those cannot be replaced will pick another name, and if it tries
 * anyway the server's own sentence comes back on the card.
 */
export function ownershipOf(
  skill: Pick<PluginSkill, "ownerUserId">,
  meId: string | undefined,
): "yours" | "the deployment's" | "someone else's" {
  if (skill.ownerUserId === null) return "the deployment's";
  return skill.ownerUserId === meId ? "yours" : "someone else's";
}

/**
 * The skills that already exist here, as the answer to `list_skills`.
 *
 * One line each, because the reason to ask is to pick a name and to find the skill being improved,
 * and a paragraph per skill would push the useful part of a long list out of the run. The
 * instructions are deliberately not included: forty skills' instructions is most of a context
 * window, and a Bot improving one asks for that skill by slug.
 */
export function describeSkills(
  skills: readonly PluginSkill[],
  meId: string | undefined,
): string {
  if (skills.length === 0) {
    return "No skills exist here yet. Any slug is free.";
  }
  const lines = skills.map((skill) => {
    const parts = [
      `/${skill.slug} — ${skill.title} (${ownershipOf(skill, meId)})`,
    ];
    if (skill.summary) parts.push(skill.summary);
    if (skill.tools.length > 0) parts.push(`needs ${skill.tools.join(", ")}`);
    return `- ${parts.join(" · ")}`;
  });
  return [
    `${skills.length} skill${skills.length === 1 ? "" : "s"} exist here. A slug that is not yours cannot be replaced — pick another name.`,
    ...lines,
  ].join("\n");
}

/**
 * One skill's instructions in full, for improving it rather than listing it.
 *
 * Separate from {@link describeSkills} so the expensive field is fetched deliberately, one skill at
 * a time, by a Bot that has been asked to change that skill.
 */
export function describeSkill(skill: PluginSkill): string {
  return [
    `/${skill.slug} — ${skill.title}`,
    skill.summary ? `Summary: ${skill.summary}` : "Summary: (none)",
    skill.tools.length > 0
      ? `Declared tools: ${skill.tools.join(", ")}`
      : "Declared tools: (none)",
    "Instructions:",
    skill.instructions,
  ].join("\n");
}

/**
 * The tool refs a skill here could name, as the answer to `list_skill_tools`.
 *
 * Every connected server's tools, not the active Bot's grants, and that is deliberate rather than
 * loose. A declaration is not a grant: the offer a run gets is the intersection of what the skill
 * names with what the Bot holds, so a skill may — and should — name tools for a connector this
 * deployment has not granted to this Bot yet, which is what makes granting it later the only step.
 * Narrowing this list to the current Bot's grants would quietly produce skills that stop working the
 * moment they are put on a different Bot.
 */
export function describeToolRefs(servers: readonly PluginServer[]): string {
  const connected = servers.filter((server) => server.tools.length > 0);
  if (connected.length === 0) {
    return "No connector here offers any tools yet, so a skill written now can only be prose. That is ordinary — most skills are.";
  }
  const blocks = connected.map((server) => {
    const tools = server.tools.map(
      (tool) =>
        `  - ${tool.ref}${tool.effect === "write" ? " (writes)" : ""} — ${tool.description || tool.name}`,
    );
    return [`${server.title} (${server.id}):`, ...tools].join("\n");
  });
  return ["Refs are `serverId/toolName`.", ...blocks].join("\n");
}
