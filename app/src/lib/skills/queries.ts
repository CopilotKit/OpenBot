import { queryOptions } from "@tanstack/react-query";
import { everyPage } from "@/lib/api/every-page";
import { listSkills } from "@/lib/api/generated/skills/skills";
import type { Skill as ApiSkill } from "@/lib/api/generated/model";
import { organizationId } from "@/lib/api/request";

/**
 * A skill as the screens read it: a named instruction a person runs with `/`.
 *
 * The caller sees their own skills, the ones granted to a team they are in, and the organization's
 * that are granted to no team; an admin sees every skill.
 */
export type Skill = {
  /** The same as `slug`, which is the skill's address. */
  id: string;
  slug: string;
  /** Whose it is. Null means the organization's: an admin looks after it. */
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  /** The Bots that offer it, by id. */
  grantedTo: string[];
  /**
   * The tools this skill says it needs, as `<appId>/<toolName>` refs.
   *
   * A declaration, not a grant, and the difference is the whole reason anybody may write a skill:
   * naming a tool here cannot make it callable. Selection intersects this with what the Bot was
   * granted, so a skill naming a tool its Bot does not hold selects the skill and loads nothing.
   */
  tools: string[];
  /**
   * Whether the caller may put it on a Bot they own: their own skill, or one granted to a team they
   * are in. The server's answer, so a Bot's Skills page offers exactly what the grant would allow.
   */
  usableOnYourBots: boolean;
};

/**
 * Under the plugins root on purpose: a Bot's grant of a skill is written through the plugins grants,
 * and invalidating those must refresh which Bots each skill shows as offering it.
 */
export const skillKeys = {
  all: ["plugins", "skills"] as const,
  list: () => ["plugins", "skills", "list"] as const,
};

/** One skill in the shape the screens read. */
function skillRecord(skill: ApiSkill): Skill {
  return {
    id: skill.slug,
    slug: skill.slug,
    ownerUserId: skill.ownerId,
    title: skill.title,
    summary: skill.summary,
    instructions: skill.instructions,
    grantedTo: skill.botIds,
    tools: skill.tools,
    usableOnYourBots: skill.usableOnYourBots,
  };
}

/** Every skill the caller may see, every page read, by title and then slug. */
export function skillListQueryOptions() {
  return queryOptions({
    queryKey: skillKeys.list(),
    queryFn: async (): Promise<Skill[]> =>
      (
        await everyPage(async (cursor) => {
          const page = await listSkills(
            organizationId(),
            { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
            { fallback: "Couldn't load the skills." },
          );
          return { items: page.skills, nextCursor: page.nextCursor };
        })
      ).map(skillRecord),
  });
}
