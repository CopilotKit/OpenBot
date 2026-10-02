/**
 * The Team Bot access rule as SQL, kept free of anything heavier than the schema so the profile
 * store and the runtime loader can import it without a cycle.
 */
import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { alias } from "drizzle-orm/pg-core";
import { agents, users } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import {
  teamBotAssignments,
  teamBotAudience,
  teamBotPublications,
} from "../db/schema/team-bots";

/** This person's groups, as the identity provider last said. */
const groupsOf = (actorId: string) =>
  sql`coalesce((select ${users.groups} from ${users} where ${users.id} = ${actorId}), '{}'::text[])`;

/**
 * Whether the Bot in `agentId` is a Team Bot this person may use: published, and either to the whole
 * team, to them by name, to a group they are in, or assigned by an administrator to such a group.
 */
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

const tbAgent = alias(agents, "team_bot_agent");
const tbProfile = alias(agentProfiles, "team_bot_profile");

/** Whether the published Bot is described well enough for a teammate to recognise it. */
export const describedForTeam = sql`exists (
  select 1 from ${agentProfiles} ${tbProfile}
  inner join ${agents} ${tbAgent} on ${tbAgent.id} = ${tbProfile.agentId}
  where ${tbProfile.agentId} = ${teamBotPublications.agentId}
    and btrim(${tbProfile.roleDescription}) <> ''
    and lower(btrim(${tbAgent.name})) not in (${sql.join(
      PLACEHOLDER_BOT_NAMES.map((name) => sql`${name}`),
      sql`, `,
    )})
)`;

export function teamBotAccess(actorId: string, agentId: AnyPgColumn): SQL {
  return sql`exists (
    select 1 from ${teamBotPublications}
    where ${teamBotPublications.agentId} = ${agentId}
      and ${describedForTeam}
      and (
        ${teamBotPublications.audience} = 'team'
        or exists (
          select 1 from ${teamBotAudience}
          where ${teamBotAudience.agentId} = ${teamBotPublications.agentId}
            and (
              (${teamBotAudience.kind} = 'user' and ${teamBotAudience.value} = ${actorId})
              or (${teamBotAudience.kind} = 'group' and ${teamBotAudience.value} = any(${groupsOf(actorId)}))
            )
        )
        or exists (
          select 1 from ${teamBotAssignments}
          where ${teamBotAssignments.agentId} = ${teamBotPublications.agentId}
            and (${teamBotAssignments.groupName} = '*' or ${teamBotAssignments.groupName} = any(${groupsOf(actorId)}))
        )
      )
  )`;
}

/** Whether an administrator has put this published Bot in this person's sidebar. */
export function assignedCondition(actorId: string) {
  return sql`exists (
    select 1 from ${teamBotAssignments}
    where ${teamBotAssignments.agentId} = ${teamBotPublications.agentId}
      and (${teamBotAssignments.groupName} = '*' or ${teamBotAssignments.groupName} = any(${groupsOf(actorId)}))
  )`;
}

/** Whether an administrator assigned this Bot, published and described, to this person. */
export function assignedToActor(actorId: string, agentId: AnyPgColumn): SQL {
  return sql`exists (
    select 1 from ${teamBotPublications}
    where ${teamBotPublications.agentId} = ${agentId}
      and ${describedForTeam}
      and ${assignedCondition(actorId)}
  )`;
}
