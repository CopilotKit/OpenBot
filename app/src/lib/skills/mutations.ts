import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  deleteSkill,
  replaceSkill,
  replaceSkillBots,
} from "@/lib/api/generated/skills/skills";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { pluginKeys } from "@/lib/plugins/queries";

/** A skill as the API takes it, under its slug. */
export type SkillInput = {
  slug: string;
  title: string;
  summary?: string;
  instructions: string;
  /** Make a new skill the organization's. Only an admin may; rewriting one keeps whose it is. */
  global?: boolean;
  /**
   * The tools this skill says it needs, as `<appId>/<toolName>` refs.
   *
   * Sent on every save, including empty, because a save replaces the set rather than merging into
   * it: an empty list is how a skill stops asking for anything.
   */
  tools: string[];
};

/**
 * Skills, and what a Bot offers: a skill's Bots are read from it, and a deleted skill leaves every
 * Bot that offered it. Both live under the plugins root.
 */
function invalidateSkills(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: pluginKeys.all });
}

/**
 * Write a skill, or rewrite one.
 *
 * One write for both: the slug is the identity, so saving under an existing one replaces it. The
 * fallback names saving rather than creating for that reason.
 */
export function saveSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: saveSkill,
    onSettled: () => invalidateSkills(queryClient),
  });
}

/** The write itself, for a caller saving several and refreshing once at the end (`import.ts`). */
export function saveSkill(input: SkillInput): Promise<unknown> {
  return replaceSkill(
    organizationId(),
    input.slug,
    {
      title: input.title,
      summary: input.summary ?? "",
      instructions: input.instructions,
      tools: input.tools,
      forEveryone: input.global === true,
    },
    { "Idempotency-Key": idempotencyKey() },
    /*
     * The server refuses for reasons a form cannot check — a slug somebody else already owns is
     * the common one — and paraphrasing that would throw away the only part worth reading.
     */
    { fallback: "Couldn't save the skill." },
  );
}

export function removeSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await deleteSkill(
        organizationId(),
        slug,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't delete the skill." },
      );
    },
    onSettled: () => invalidateSkills(queryClient),
  });
}

/** Which Bots use a skill: every Bot, Bots made later included, or exactly these. */
export type SkillBots =
  | { everyBot: true }
  | { everyBot: false; botIds: string[] };

/** The write itself, for a caller choosing several skills' Bots and refreshing once (`import.ts`). */
export function chooseSkillBots(
  slug: string,
  bots: SkillBots,
): Promise<unknown> {
  return replaceSkillBots(
    organizationId(),
    slug,
    bots.everyBot
      ? { everyBot: true, botIds: [] }
      : { everyBot: false, botIds: bots.botIds },
    { "Idempotency-Key": idempotencyKey() },
    // The server says which Bot it couldn't change, and why: that sentence is the useful part.
    { fallback: "Couldn't change which Bots use the skill." },
  );
}

/**
 * Choose the Bots that use a skill. Each Bot it is put on or taken from is that Bot's own change,
 * so a Bot's Skills page and "What it can use" are refreshed with the skill list.
 */
export function chooseSkillBotsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { slug: string; bots: SkillBots }) =>
      chooseSkillBots(variables.slug, variables.bots),
    onSettled: () => invalidateSkills(queryClient),
  });
}
