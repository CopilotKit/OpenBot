/**
 * Who may see a Bot: the one rule the roster, the runtime, handoffs and groups all share.
 *
 * An administrator sees every Bot. Anybody else sees a public Bot, their own, and a Team Bot that
 * reaches them: published, described well enough for a teammate to recognise, and published to the
 * whole team, to them by name, to a group they are in, or assigned by an administrator to such a group.
 *
 * Publication, audience and assignment are part of each Bot's access in Intelligence, and the Bot
 * itself is in its agent registry; both are held in memory on this instance. The person's groups are
 * this deployment's (`users.groups`, from the identity provider). So the rule is: which publications
 * reach this person (from memory, against their groups), and whether the Bot is described for the
 * team (its name and role). Kept free of anything heavier so the profile store and the runtime loader
 * can import it without a cycle.
 */
import { eq } from "drizzle-orm";
import type { Bot } from "../agents/bot-registry/types";
import { botConfiguration } from "../configuration/directory";
import type { BotAccess as AccessRecord } from "../configuration/types";
import type { Database } from "../db/client";
import { users } from "../db/schema/core";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** The pool, or a caller's open transaction. */
export type AccessExecutor =
  | Pick<Database, "select">
  | Pick<Transaction, "select">;

/** This person's groups, as the identity provider last said. */
export async function groupsOf(
  executor: AccessExecutor,
  actorId: string,
): Promise<string[]> {
  const [row] = await executor
    .select({ groups: users.groups })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  return row?.groups ?? [];
}

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

/** Whether an administrator has put this published Bot in the sidebar of somebody in `groups`. */
function assignedTo(
  access: AccessRecord,
  groups: ReadonlySet<string>,
): boolean {
  return (
    access.publication !== null &&
    access.assignments.some(
      (assignment) => assignment.group === "*" || groups.has(assignment.group),
    )
  );
}

/** Whether this published Bot reaches somebody with this id and these groups. */
function reachesPerson(
  access: AccessRecord,
  actorId: string,
  groups: ReadonlySet<string>,
): boolean {
  const publication = access.publication;
  if (!publication) return false;
  return (
    publication.audience === "team" ||
    publication.members.some(
      (member) =>
        (member.kind === "user" && member.value === actorId) ||
        (member.kind === "group" && groups.has(member.value)),
    ) ||
    assignedTo(access, groups)
  );
}

/** Whether an administrator has put this published Bot in this person's sidebar. */
export async function isAssignedTo(
  executor: AccessExecutor,
  actorId: string,
  botId: string,
): Promise<boolean> {
  const access = botConfiguration().access.get(botId);
  if (!access?.publication) return false;
  return assignedTo(access, new Set(await groupsOf(executor, actorId)));
}

/**
 * Which published Bots reach this person, and which of those an administrator assigned to them.
 *
 * Publications only: whether each Bot is also described for the team is the caller's half, through
 * {@link describedForTeam} or {@link botAccessFor}, because that needs the Bot's name and role.
 */
export async function teamBotReach(
  executor: AccessExecutor,
  actorId: string,
): Promise<{ reaches: Set<string>; assigned: Set<string> }> {
  const groups = new Set(await groupsOf(executor, actorId));
  const reaches = new Set<string>();
  const assigned = new Set<string>();
  for (const access of botConfiguration().access.all()) {
    if (!access.publication) continue;
    if (reachesPerson(access, actorId, groups)) reaches.add(access.botId);
    if (assignedTo(access, groups)) assigned.add(access.botId);
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
