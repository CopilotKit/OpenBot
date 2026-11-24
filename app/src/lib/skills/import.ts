import type { QueryClient } from "@tanstack/react-query";
import type { GitHubSkill, GitHubSkills } from "@/lib/api/generated/model";
import { findGitHubSkills } from "@/lib/api/generated/skills/skills";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { grantPlugin, invalidatePlugins } from "@/lib/plugins/mutations";
import { saveSkill } from "./mutations";
import type { Skill } from "./queries";

/**
 * Importing skills: from a GitHub repository, or several a Bot drafted at once, then putting them on
 * a Bot.
 *
 * Each skill is saved exactly as one written in the form is (`replaceSkill`, as the person), one after
 * another, so one the server refuses (a command somebody else already has) is said for that skill and
 * the rest are still saved. Putting them on a Bot is that Bot's grant, one per skill, as the Skills
 * page gives it; in OpenBot Personal the server has already put a new skill on every Bot.
 */

export type { GitHubSkill, GitHubSkills };

/** The skills a public GitHub repository holds. Nothing is saved: a plain function, as `translate.ts`. */
export function findSkillsOnGitHub(repository: string): Promise<GitHubSkills> {
  return findGitHubSkills(
    organizationId(),
    { repository: repository.trim() },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Couldn't read that repository. Try again in a moment." },
  );
}

/** A skill to save, from GitHub or a Bot's draft. */
export type SkillToSave = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  tools?: string[];
};

/** What happened to one skill: saved (and put on the Bot when asked), or refused, in the server's words. */
export type SkillOutcome =
  | { slug: string; saved: true; onBot: boolean | null; note: string | null }
  | { slug: string; saved: false; reason: string };

/** What a command already names here, for a skill about to be saved under it. */
export type SlugStatus = "new" | "yours" | "theirs";

/** Whether saving under this slug makes a skill, rewrites the person's own, or would touch somebody else's. */
export function slugStatus(
  slug: string,
  existing: readonly Skill[] | undefined,
  me: string | undefined,
): SlugStatus {
  const found = existing?.find((skill) => skill.slug === slug);
  if (!found) return "new";
  return found.ownerUserId !== null && found.ownerUserId === me
    ? "yours"
    : "theirs";
}

/**
 * Save each skill, then put the saved ones on each of `botIds`. Never throws: each skill's outcome
 * says what happened to it. `onProgress` hears how many are done, for a long import.
 */
export async function saveSkills(
  queryClient: QueryClient,
  skills: readonly SkillToSave[],
  options: {
    botIds?: readonly string[];
    onProgress?: (done: number) => void;
  } = {},
): Promise<SkillOutcome[]> {
  const outcomes: SkillOutcome[] = [];
  const botIds = options.botIds ?? [];
  for (const skill of skills) {
    options.onProgress?.(outcomes.length);
    try {
      await saveSkill({
        slug: skill.slug,
        title: skill.title,
        summary: skill.summary,
        instructions: skill.instructions,
        tools: skill.tools ?? [],
      });
    } catch (error) {
      outcomes.push({
        slug: skill.slug,
        saved: false,
        reason: messageOf(error, "Couldn't save it."),
      });
      continue;
    }
    if (botIds.length === 0) {
      outcomes.push({ slug: skill.slug, saved: true, onBot: null, note: null });
      continue;
    }
    const problems: string[] = [];
    for (const botId of botIds) {
      const problem = await putOnBot(skill.slug, botId);
      if (problem) problems.push(problem);
    }
    outcomes.push({
      slug: skill.slug,
      saved: true,
      onBot: problems.length === 0,
      note: problems[0] ?? null,
    });
  }
  options.onProgress?.(outcomes.length);
  await invalidatePlugins(queryClient);
  return outcomes;
}

/**
 * Put skills already saved on a Bot. Each is that Bot's grant of it; one it already has stays as it
 * is. Says, for each, null when it's on the Bot and the server's sentence when it isn't.
 */
export async function putSkillsOnBot(
  queryClient: QueryClient,
  slugs: readonly string[],
  botId: string,
): Promise<Array<{ slug: string; problem: string | null }>> {
  const results: Array<{ slug: string; problem: string | null }> = [];
  for (const slug of slugs)
    results.push({ slug, problem: await putOnBot(slug, botId) });
  await invalidatePlugins(queryClient);
  return results;
}

async function putOnBot(slug: string, botId: string): Promise<string | null> {
  try {
    await grantPlugin({ kind: "skill", ref: slug, agentId: botId });
    return null;
  } catch (error) {
    return messageOf(error, "Couldn't put it on the Bot.");
  }
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ClientError || error instanceof Error)
    return error.message || fallback;
  return fallback;
}

/** One line for the Bot about what an import or a save did, so it can tell the person. */
export function describeOutcomes(
  outcomes: readonly SkillOutcome[],
  botName?: string,
): string {
  const saved = outcomes.filter((outcome) => outcome.saved);
  const refused = outcomes.filter(
    (outcome): outcome is Extract<SkillOutcome, { saved: false }> =>
      !outcome.saved,
  );
  const parts: string[] = [];
  if (saved.length > 0)
    parts.push(
      `Saved ${saved.length} skill${saved.length === 1 ? "" : "s"}: ${saved.map((outcome) => `/${outcome.slug}`).join(", ")}.`,
    );
  const offBot = saved.filter(
    (outcome) => outcome.saved && outcome.onBot === false,
  );
  if (botName && saved.length > offBot.length)
    parts.push(`They're on ${botName}.`);
  for (const outcome of offBot)
    if (outcome.saved && outcome.note)
      parts.push(
        `/${outcome.slug} isn't on ${botName ?? "the Bot"}: ${outcome.note}`,
      );
  for (const outcome of refused)
    parts.push(`/${outcome.slug} wasn't saved: ${outcome.reason}`);
  if (parts.length === 0) return "Nothing was saved.";
  return parts.join(" ");
}
