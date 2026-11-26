/**
 * Writing a skill from the phone: who may change which skill, and the form as the request `replaceSkill` takes.
 *
 * The limits are the web app's (app/src/lib/skills/form.ts), which match the server's own: a form that is sent is a
 * form that is taken, and a mistake is said beside the form rather than as a refused request.
 *
 * Imports nothing that needs a phone, so it can be tested.
 */
import type { Skill, SkillInput } from "./api/generated/model";

/** A skill's command, what a person types after /: lower-case letters, digits and hyphens, 2 to 40 long. */
export const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** What the person types into the form. */
export type SkillForm = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
};

export const EMPTY_SKILL_FORM: SkillForm = {
  slug: "",
  title: "",
  summary: "",
  instructions: "",
};

/** The form filled with a skill, to change it. */
export function formOf(
  skill: Pick<Skill, "slug" | "title" | "summary" | "instructions">,
): SkillForm {
  return {
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary ?? "",
    instructions: skill.instructions,
  };
}

/** A command made from a name, for a new skill whose command the person hasn't typed: "Daily standup" as daily-standup. */
export function slugFrom(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/**
 * The form as `replaceSkill` takes it, under its command, or what is wrong with it.
 *
 * - A new skill's command must not be one the person can already see: the same command rewrites the skill that has
 *   it, and a new skill must never quietly replace one.
 * - `tools` is what the skill named before, sent as it was: the phone doesn't change which actions a skill needs,
 *   and an empty list would clear them.
 */
export function skillRequest(
  form: SkillForm,
  {
    creating,
    taken = [],
    tools = [],
  }: {
    creating: boolean;
    taken?: readonly string[];
    tools?: readonly string[];
  },
): { slug: string; body: SkillInput } | { error: string } {
  const slug = form.slug.trim();
  const title = form.title.trim();
  const summary = form.summary.trim();
  const instructions = form.instructions.trim();
  if (!title) return { error: "Give the skill a name." };
  if (title.length > 120)
    return { error: "The name must be 120 characters or fewer." };
  if (creating) {
    if (!slug) return { error: "Give the skill a command." };
    if (!SKILL_SLUG.test(slug))
      return {
        error:
          "The command can use lower-case letters, numbers and hyphens, 2 to 40 characters.",
      };
    if (taken.includes(slug))
      return {
        error: `A skill already uses /${slug}. Pick another command.`,
      };
  }
  if (summary.length > 200)
    return { error: "The one-line summary must be 200 characters or fewer." };
  if (!instructions)
    return { error: "Write the instructions. They are what the Bot follows." };
  return {
    slug,
    body: { title, summary, instructions, tools: [...tools] },
  };
}

/**
 * Whether the person may change or delete a skill here, by the web app's rule: their own skill, and in the personal
 * edition the skills written for every Bot too, which are the one person's. The organization's skills are an admin's,
 * changed in OpenBot on the computer. `personId` is unknown until it is read, and then nothing is offered.
 */
export function mayChange(
  skill: Pick<Skill, "ownerId">,
  {
    personId,
    edition,
  }: { personId: string | undefined; edition: string | undefined },
): boolean {
  if (skill.ownerId === null) return edition === "personal";
  return personId !== undefined && skill.ownerId === personId;
}
