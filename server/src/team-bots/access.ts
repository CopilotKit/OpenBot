/**
 * Who may see a Bot: the one rule the roster, the runtime, handoffs and groups all share.
 *
 * An administrator sees every Bot. Anybody else sees a public Bot, their own, and a Team Bot that
 * reaches them: published, described well enough for a teammate to recognise, and published to the
 * whole team, to them by name, to a group they are in, or assigned by an administrator to such a group.
 *
 * Publication, audience and assignment are this deployment's tables; the Bot itself is in Intelligence.
 * So the rule is two halves: which publications reach this person (SQL, here), and whether the Bot is
 * described for the team (its name and role, from the Bot directory). Kept free of anything heavier
 * than the schema so the profile store and the runtime loader can import it without a cycle.
 */
import { type SQL, sql } from "drizzle-orm";
import type { Bot } from "../agents/bot-registry/types";
import type { Database } from "../db/client";
import { users } from "../db/schema/core";
import {
  teamBotAssignments,
  teamBotAudience,
  teamBotPublications,
} from "../db/schema/team-bots";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** The pool, or a caller's open transaction. */
export type AccessExecutor =
  | Pick<Database, "select">
  | Pick<Transaction, "select">;

/** This person's groups, as the identity provider last said. */
const groupsOf = (actorId: string) =>
  sql`coalesce((select ${users.groups} from ${users} where ${users.id} = ${actorId}), '{}'::text[])`;

/**
 * Names a Bot has before anybody named it on purpose. A Team Bot still called one of these, or with
 * no description, is invisible to teammates: they could not tell it from any other Bot.
 */
export const PLACEHOLDER_BOT_NAMES = [
  "",
  "new bot",
  "new coworker",
  "untitled",
  "my bot",
] as const;

/** Whether the published Bot is described well enough for a teammate to recognise it. */
export function describedForTeam(
  bot: Pick<Bot, "name" | "roleDescription">,
): boolean {
  return (
    bot.roleDescription.trim() !== "" &&
    !(PLACEHOLDER_BOT_NAMES as readonly string[]).includes(
      bot.name.trim().toLowerCase(),
    )
  );
}

/** Whether an administrator has put this published Bot in this person's sidebar. */
export function assignedCondition(actorId: string): SQL {
  return sql`exists (
    select 1 from ${teamBotAssignments}
    where ${teamBotAssignments.agentId} = ${teamBotPublications.agentId}
      and (${teamBotAssignments.groupName} = '*' or ${teamBotAssignments.groupName} = any(${groupsOf(actorId)}))
  )`;
}

/**
 * Which published Bots reach this person, and which of those an administrator assigned to them.
 *
 * Publications only: whether each Bot is also described for the team is the caller's half, through
 * {@link describedForTeam} or {@link botAccessFor}, because the name and role are not in this database.
 */
export async function teamBotReach(
  executor: AccessExecutor,
  actorId: string,
): Promise<{ reaches: Set<string>; assigned: Set<string> }> {
  const rows = await executor
    .select({
      agentId: teamBotPublications.agentId,
      assigned: sql<boolean>`${assignedCondition(actorId)}`,
      reaches: sql<boolean>`(
        ${teamBotPublications.audience} = 'team'
        or exists (
          select 1 from ${teamBotAudience}
          where ${teamBotAudience.agentId} = ${teamBotPublications.agentId}
            and (
              (${teamBotAudience.kind} = 'user' and ${teamBotAudience.value} = ${actorId})
              or (${teamBotAudience.kind} = 'group' and ${teamBotAudience.value} = any(${groupsOf(actorId)}))
            )
        )
        or ${assignedCondition(actorId)}
      )`,
    })
    .from(teamBotPublications);
  const reaches = new Set<string>();
  const assigned = new Set<string>();
  for (const row of rows) {
    if (row.reaches) reaches.add(row.agentId);
    if (row.assigned) assigned.add(row.agentId);
  }
  return { reaches, assigned };
}

export type BotAccess = {
  /** Whether this person may see and use this Bot. Says nothing about whether it is deleted. */
  canSee(bot: Bot): boolean;
  /** Whether it is a Team Bot an administrator put in this person's sidebar. */
  assignedToMe(bot: Bot): boolean;
  /** Whether it is a Team Bot that reaches this person (and not merely public or their own). */
  teamBot(bot: Bot): boolean;
};

/** The visibility rule for one person, read once and asked of as many Bots as the caller holds. */
export async function botAccessFor(
  executor: AccessExecutor,
  actor: { id: string; role: "admin" | "user" },
): Promise<BotAccess> {
  const { reaches, assigned } = await teamBotReach(executor, actor.id);
  const teamBot = (bot: Bot) => reaches.has(bot.id) && describedForTeam(bot);
  return {
    canSee: (bot) =>
      actor.role === "admin" ||
      bot.visibility === "public" ||
      bot.ownerUserId === actor.id ||
      teamBot(bot),
    assignedToMe: (bot) => assigned.has(bot.id) && describedForTeam(bot),
    teamBot,
  };
}
