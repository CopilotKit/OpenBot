import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { deleteSkill, replaceSkill } from "@/lib/api/generated/skills/skills";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
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
    mutationFn: (input: SkillInput): Promise<unknown> =>
      replaceSkill(
        ORGANIZATION_ID,
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
      ),
    onSettled: () => invalidateSkills(queryClient),
  });
}

export function removeSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await deleteSkill(
        ORGANIZATION_ID,
        slug,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't delete the skill." },
      );
    },
    onSettled: () => invalidateSkills(queryClient),
  });
}
