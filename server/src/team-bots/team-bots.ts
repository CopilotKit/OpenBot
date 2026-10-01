/**
 * Team Bots: one Bot, published by its owner, used by teammates in chats of their own.
 *
 * WHO SEES IT. `teamBotAccess` is the one rule, added to the same SQL gate that already admits public
 * Bots and a person's own (`profile-store.ts` `accessFilter`, `runtime-agents.ts`), so the roster, the
 * runtime, handoffs and groups all see a Team Bot exactly where its publication says. No publication
 * row, no access: unpublishing is one delete.
 *
 * PRIVATE CHATS. A teammate's conversation is an ordinary channel of their own, and channels are
 * membership-scoped, so the owner cannot read it and it cannot read theirs. Nothing here changes that.
 *
 * WHOSE ACCOUNTS. A Team Bot reaches a connected app as its OWNER when the owner has connected it,
 * the same for everyone. A teammate's OWN account on a server the owner has not connected is used
 * only with their consent: Allow once, Always allow for this Bot, or Skip. Everything else about the
 * call (grant, policy, approvals, audit) is still decided as the teammate who is asking.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { capabilityRefusal } from "../admin/capabilities";
import { enterpriseControls } from "../admin/controls";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import { agents, users } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import {
  teamBotAssignments,
  teamBotAudience,
  teamBotConsentDefaults,
  teamBotConsents,
  teamBotPublications,
} from "../db/schema/team-bots";
import { PluginRefusedError } from "../plugins/store";
import {
  assignedCondition,
  describedForTeam,
  PLACEHOLDER_BOT_NAMES,
  teamBotAccess,
} from "./access";

export { teamBotAccess } from "./access";

/** Prefix a consent refusal carries, so a chat can draw the card instead of the sentence. */
export const TEAM_BOT_CONSENT_MARKER = "[team-bot-consent]";

export class TeamBotRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamBotRefusedError";
  }
}
/** The person may not publish Team Bots at all: an administrator turned the switch off. */
export class TeamBotForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamBotForbiddenError";
  }
}

export class TeamBotNotFoundError extends Error {
  constructor() {
    super("That Team Bot was not found.");
    this.name = "TeamBotNotFoundError";
  }
}

export type TeamBotSummary = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  ownerUserId: string | null;
  audience: "team" | "people";
  publishedAt: string;
  assigned: boolean;
};

export type TeamBotConsentDecision =
  | "allow_once"
  | "allow_always"
  | "allow_all_team_bots"
  | "skip";

/** One consent card a run raised: which Team Bot, which of the person's own accounts, and why. */
export type TeamBotConsentAsk = {
  botId: string;
  serverId: string;
  message: string;
};

/** Which servers a person has connected an account on, as the plugin store records it. */
export type ConnectionReader = (userId: string) => Promise<Set<string>>;

export function createTeamBots(options: {
  database: Database;
  /** Every server this person has their own account connected on (OAuth or brokered). */
  connectedServers: ConnectionReader;
}) {
  const { database, connectedServers } = options;
  /**
   * Cards raised while a server-run turn was listening for them, keyed by person and Bot. A browser
   * chat draws the card from the tool result itself; a group turn has no browser, so it collects
   * them here and puts the card in the shared transcript.
   */
  const listening = new Map<string, TeamBotConsentAsk[]>();

  async function publication(botId: string) {
    const [row] = await database
      .select({
        agentId: teamBotPublications.agentId,
        audience: teamBotPublications.audience,
        ownerUserId: agentProfiles.ownerUserId,
      })
      .from(teamBotPublications)
      .innerJoin(
        agentProfiles,
        eq(agentProfiles.agentId, teamBotPublications.agentId),
      )
      .where(
        and(
          eq(teamBotPublications.agentId, botId),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The Bot as its owner, for owner-only acts; administrators may unpublish and assign. */
  async function owned(actor: AgentActor, botId: string, allowAdmin: boolean) {
    const [row] = await database
      .select({
        id: agents.id,
        name: agents.name,
        roleDescription: agentProfiles.roleDescription,
        ownerUserId: agentProfiles.ownerUserId,
      })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(and(eq(agents.id, botId), isNull(agentProfiles.deletedAt)))
      .limit(1);
    if (!row) throw new TeamBotNotFoundError();
    if (row.ownerUserId !== actor.id && !(allowAdmin && actor.role === "admin"))
      throw new TeamBotNotFoundError();
    return row;
  }

  return {
    teamBotAccess,

    /**
     * Whose account a Team Bot's call to `ref` goes out on, for the person asking.
     *
     * The asker, for anything that is not a Team Bot or is theirs, and for a server nobody has a
     * personal account on (a shared credential reaches the same place whoever asks). The owner, where
     * the owner connected it. The asker's own account only with a standing or one-time consent;
     * without one the call is refused with the card's marker, and nothing is sent.
     */
    credentialActorFor(actorId: string, botId: string) {
      return async (ref: string): Promise<string> => {
        const published = await publication(botId);
        const owner = published?.ownerUserId;
        if (!owner || owner === actorId) return actorId;
        const serverId = ref.split("/")[0] ?? "";
        if ((await connectedServers(owner)).has(serverId)) return owner;
        if (!(await connectedServers(actorId)).has(serverId)) return actorId;
        const [consent] = await database
          .select({ decision: teamBotConsents.decision })
          .from(teamBotConsents)
          .where(
            and(
              eq(teamBotConsents.userId, actorId),
              eq(teamBotConsents.agentId, botId),
              eq(teamBotConsents.serverId, serverId),
            ),
          )
          .limit(1);
        if (consent?.decision === "always") return actorId;
        const [everyBot] = await database
          .select({ serverId: teamBotConsentDefaults.serverId })
          .from(teamBotConsentDefaults)
          .where(
            and(
              eq(teamBotConsentDefaults.userId, actorId),
              eq(teamBotConsentDefaults.serverId, serverId),
            ),
          )
          .limit(1);
        if (everyBot) return actorId;
        if (consent?.decision === "once") {
          // Spent by exactly one call: whichever call deletes it is the one that may go.
          const spent = await database
            .delete(teamBotConsents)
            .where(
              and(
                eq(teamBotConsents.userId, actorId),
                eq(teamBotConsents.agentId, botId),
                eq(teamBotConsents.serverId, serverId),
                eq(teamBotConsents.decision, "once"),
              ),
            )
            .returning({ serverId: teamBotConsents.serverId });
          if (spent.length) return actorId;
        }
        const message = `This Team Bot wants to use your own ${serverId} account. Choose Allow once, Always allow, or Skip, then ask again.`;
        listening
          .get(`${actorId}\n${botId}`)
          ?.push({ botId, serverId, message });
        throw new PluginRefusedError(
          `${TEAM_BOT_CONSENT_MARKER}${JSON.stringify({ botId, serverId })} ${message}`,
          null,
        );
      };
    },

    /**
     * Listen for consent cards this person's turns with this Bot raise, until the returned function
     * is called; it returns them once each.
     */
    listenForConsent(
      actorId: string,
      botId: string,
    ): () => TeamBotConsentAsk[] {
      const key = `${actorId}\n${botId}`;
      const asks: TeamBotConsentAsk[] = [];
      listening.set(key, asks);
      return () => {
        if (listening.get(key) === asks) listening.delete(key);
        return asks.filter(
          (ask, index) =>
            asks.findIndex((other) => other.serverId === ask.serverId) ===
            index,
        );
      };
    },

    /** Record a teammate's answer to a consent card. Skip clears any earlier answer. */
    async consent(
      actor: AgentActor,
      botId: string,
      serverId: string,
      decision: TeamBotConsentDecision,
    ) {
      const scope = and(
        eq(teamBotConsents.userId, actor.id),
        eq(teamBotConsents.agentId, botId),
        eq(teamBotConsents.serverId, serverId),
      );
      if (decision === "skip") {
        await database.delete(teamBotConsents).where(scope);
        return;
      }
      if (!(await publication(botId))) throw new TeamBotNotFoundError();
      if (decision === "allow_all_team_bots") {
        await database
          .insert(teamBotConsentDefaults)
          .values({ userId: actor.id, serverId })
          .onConflictDoNothing();
        return;
      }
      const value = decision === "allow_always" ? "always" : "once";
      await database
        .insert(teamBotConsents)
        .values({ userId: actor.id, agentId: botId, serverId, decision: value })
        .onConflictDoUpdate({
          target: [
            teamBotConsents.userId,
            teamBotConsents.agentId,
            teamBotConsents.serverId,
          ],
          set: { decision: value, updatedAt: new Date() },
        });
    },

    /** Settings: forget every consent this person has given any Team Bot. */
    async clearConsents(actor: AgentActor) {
      await database
        .delete(teamBotConsents)
        .where(eq(teamBotConsents.userId, actor.id));
      await database
        .delete(teamBotConsentDefaults)
        .where(eq(teamBotConsentDefaults.userId, actor.id));
    },

    async publish(
      actor: AgentActor,
      botId: string,
      input: {
        audience: "team" | "people";
        emails: string[];
        groups: string[];
      },
    ) {
      // The "Team Bots" switch, here rather than only at the HTTP gate, so every caller meets it.
      // Fails closed when the controls cannot be read.
      const controls = enterpriseControls();
      if (controls) {
        const allowed = await controls
          .capabilityFor(actor.id, "teamBots")
          .catch(() => false);
        if (!allowed)
          throw new TeamBotForbiddenError(capabilityRefusal("teamBots"));
      }
      const bot = await owned(actor, botId, false);
      // A teammate cannot tell an undescribed Bot from any other, so it is not published.
      if (
        !bot.roleDescription.trim() ||
        (PLACEHOLDER_BOT_NAMES as readonly string[]).includes(
          bot.name.trim().toLowerCase(),
        )
      )
        throw new TeamBotRefusedError(
          "Give this Bot a name and a description before publishing it to your team.",
        );
      const emails = [
        ...new Set(input.emails.map((email) => email.trim().toLowerCase())),
      ].filter(Boolean);
      const people = emails.length
        ? await database
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(inArray(sql`lower(${users.email})`, emails))
        : [];
      const missing = emails.filter(
        (email) => !people.some((row) => row.email.toLowerCase() === email),
      );
      if (missing.length)
        throw new TeamBotRefusedError(
          `Nobody has signed in here as ${missing.join(", ")}.`,
        );
      const groups = [
        ...new Set(input.groups.map((group) => group.trim())),
      ].filter(Boolean);
      if (input.audience === "people" && !people.length && !groups.length)
        throw new TeamBotRefusedError(
          "Name at least one person or group, or publish to the whole team.",
        );
      await database.transaction(async (tx) => {
        await tx
          .insert(teamBotPublications)
          .values({
            agentId: botId,
            publishedBy: actor.id,
            audience: input.audience,
          })
          .onConflictDoUpdate({
            target: teamBotPublications.agentId,
            set: { audience: input.audience, publishedBy: actor.id },
          });
        await tx
          .delete(teamBotAudience)
          .where(eq(teamBotAudience.agentId, botId));
        const rows = [
          ...people.map((person) => ({
            agentId: botId,
            kind: "user" as const,
            value: person.id,
          })),
          ...groups.map((group) => ({
            agentId: botId,
            kind: "group" as const,
            value: group,
          })),
        ];
        if (input.audience === "people" && rows.length)
          await tx.insert(teamBotAudience).values(rows);
      });
    },

    /** Teammates lose access until it is published again. Assignments wait, inert. */
    async unpublish(actor: AgentActor, botId: string) {
      await owned(actor, botId, true);
      await database
        .delete(teamBotPublications)
        .where(eq(teamBotPublications.agentId, botId));
    },

    async assign(actor: AgentActor, botId: string, groupName: string) {
      if (actor.role !== "admin")
        throw new TeamBotRefusedError(
          "Only an administrator can assign Team Bots.",
        );
      if (!(await publication(botId)))
        throw new TeamBotRefusedError("Publish this Bot before assigning it.");
      const group = groupName.trim();
      if (!group) throw new TeamBotRefusedError("Name a group, or * for all.");
      await database
        .insert(teamBotAssignments)
        .values({ agentId: botId, groupName: group, assignedBy: actor.id })
        .onConflictDoNothing();
    },

    async unassign(actor: AgentActor, botId: string, groupName: string) {
      if (actor.role !== "admin")
        throw new TeamBotRefusedError(
          "Only an administrator can assign Team Bots.",
        );
      await database
        .delete(teamBotAssignments)
        .where(
          and(
            eq(teamBotAssignments.agentId, botId),
            eq(teamBotAssignments.groupName, groupName),
          ),
        );
    },

    /** Whether this Bot is in this person's sidebar by assignment, which they cannot hide. */
    async isAssignedTo(actorId: string, botId: string): Promise<boolean> {
      const [row] = await database
        .select({ agentId: teamBotPublications.agentId })
        .from(teamBotPublications)
        .where(
          and(
            eq(teamBotPublications.agentId, botId),
            assignedCondition(actorId),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    /** The Team Bots this person may use, their own publications, and each one's settings. */
    async list(actor: AgentActor) {
      const rows = await database
        .select({
          id: agents.id,
          name: agents.name,
          title: agentProfiles.title,
          roleDescription: agentProfiles.roleDescription,
          ownerUserId: agentProfiles.ownerUserId,
          audience: teamBotPublications.audience,
          publishedAt: teamBotPublications.publishedAt,
          assigned: sql<boolean>`${assignedCondition(actor.id)}`,
          described: sql<boolean>`${describedForTeam}`,
        })
        .from(teamBotPublications)
        .innerJoin(agents, eq(agents.id, teamBotPublications.agentId))
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .where(
          and(
            isNull(agentProfiles.deletedAt),
            actor.role === "admin"
              ? undefined
              : or(
                  eq(agentProfiles.ownerUserId, actor.id),
                  teamBotAccess(actor.id, teamBotPublications.agentId),
                ),
          ),
        )
        .orderBy(agents.name);
      const ids = rows.map((row) => row.id);
      const [audience, assignments] = ids.length
        ? await Promise.all([
            database
              .select({
                agentId: teamBotAudience.agentId,
                kind: teamBotAudience.kind,
                value: teamBotAudience.value,
                email: users.email,
              })
              .from(teamBotAudience)
              .leftJoin(
                users,
                and(
                  eq(teamBotAudience.kind, "user"),
                  eq(users.id, teamBotAudience.value),
                ),
              )
              .where(inArray(teamBotAudience.agentId, ids)),
            database
              .select()
              .from(teamBotAssignments)
              .where(inArray(teamBotAssignments.agentId, ids)),
          ])
        : [[], []];
      return rows.map((row) => {
        const manages = row.ownerUserId === actor.id || actor.role === "admin";
        return {
          id: row.id,
          name: row.name,
          title: row.title,
          roleDescription: row.roleDescription,
          mine: row.ownerUserId === actor.id,
          audience: row.audience,
          publishedAt: row.publishedAt.toISOString(),
          assigned: Boolean(row.assigned),
          /** False while its name or description would leave teammates unable to tell it apart. */
          visibleToTeam: Boolean(row.described),
          // Who it reaches is the owner's and administrators' business, not every teammate's.
          ...(manages
            ? {
                people: audience
                  .filter((a) => a.agentId === row.id && a.kind === "user")
                  .map((a) => a.email ?? a.value),
                groups: audience
                  .filter((a) => a.agentId === row.id && a.kind === "group")
                  .map((a) => a.value),
                assignments: assignments
                  .filter((a) => a.agentId === row.id)
                  .map((a) => a.groupName),
              }
            : {}),
        };
      });
    },

    /** The owner's own Bots that could be published, for the publish list. */
    async publishable(actor: AgentActor) {
      return database
        .select({
          id: agents.id,
          name: agents.name,
          title: agentProfiles.title,
        })
        .from(agents)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .leftJoin(
          teamBotPublications,
          eq(teamBotPublications.agentId, agents.id),
        )
        .where(
          and(
            eq(agentProfiles.ownerUserId, actor.id),
            isNull(agentProfiles.deletedAt),
            isNull(teamBotPublications.agentId),
          ),
        )
        .orderBy(agents.name);
    },
  };
}
export type TeamBots = ReturnType<typeof createTeamBots>;
