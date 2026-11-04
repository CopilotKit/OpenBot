/**
 * Team Bots: one Bot, published by its owner, used by teammates in chats of their own.
 *
 * WHO SEES IT. `botAccessFor` (access.ts) is the one rule, the same gate that already admits public
 * Bots and a person's own (`profile-store.ts`, `runtime-agents.ts`), so the roster, the runtime,
 * handoffs and groups all see a Team Bot exactly where its publication says. No publication, no
 * access: unpublishing is one change.
 *
 * WHERE IT IS KEPT. A publication, its audience and its assignments are part of the Bot's access in
 * Intelligence; a teammate's consents are their preferences there. Both are held in memory on this
 * instance (configuration/directory.ts), so the checks on every tool call never wait on Intelligence.
 * A one-time consent is spent in Intelligence, in one statement, so exactly one call on any replica
 * gets to use it.
 *
 * PRIVATE CHATS. A teammate's conversation is an ordinary channel of their own, and channels are
 * membership-scoped, so the owner cannot read it and it cannot read theirs. Nothing here changes that.
 *
 * WHOSE ACCOUNTS. A Team Bot reaches a connected app as its OWNER when the owner has connected it,
 * the same for everyone — for an app an ADMINISTRATOR gave it. An app the owner gave it themselves
 * (`plugin_grants.granted_as = owner`) always runs on the asking teammate's own account. A teammate's OWN account on a server the owner has not connected is used
 * only with their consent: Allow once, Always allow for this Bot, or Skip. Everything else about the
 * call (grant, policy, approvals, audit) is still decided as the teammate who is asking.
 */
import { inArray, sql } from "drizzle-orm";
import { capabilityRefusal } from "../admin/capabilities";
import { enterpriseControls } from "../admin/controls";
import { bots } from "../agents/bot-registry/directory";
import type { AgentActor } from "../agents/profile-types";
import { ConfigurationMissingError } from "../configuration/client";
import { botConfiguration } from "../configuration/directory";
import type { Database } from "../db/client";
import { users } from "../db/schema/core";
import { PluginRefusedError } from "../plugins/store";
import {
  describedForTeam,
  isAssignedTo,
  PLACEHOLDER_BOT_NAMES,
  teamBotReach,
} from "./access";

/** Whose grant a Bot's grant of this tool is: `owner` when the owner gave it their own app. */
function grantedAsFor(botId: string, ref: string) {
  return botConfiguration()
    .accessOf(botId)
    .grants.find((grant) => grant.kind === "mcp" && grant.ref === ref)
    ?.grantedAs;
}

/** This person's standing answer about this Bot on this server, from their preferences. */
function consentFor(userId: string, botId: string, serverId: string) {
  return botConfiguration()
    .preferencesOf(userId)
    .consents.find(
      (consent) => consent.botId === botId && consent.serverId === serverId,
    )?.decision;
}

/** Whether this person allowed every Team Bot their own account on this server. */
function allowsEveryBot(userId: string, serverId: string) {
  return botConfiguration()
    .preferencesOf(userId)
    .consentDefaults.some((consent) => consent.serverId === serverId);
}

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

  /** The live, published Bot and who owns it, or null. */
  async function publication(botId: string) {
    const published = botConfiguration().access.get(botId)?.publication;
    if (!published) return null;
    const bot = await bots().find(botId);
    if (!bot || bot.deletedAt !== null) return null;
    return {
      agentId: botId,
      audience: published.audience,
      ownerUserId: bot.ownerUserId,
    };
  }

  /** The Bot as its owner, for owner-only acts; administrators may unpublish and assign. */
  async function owned(actor: AgentActor, botId: string, allowAdmin: boolean) {
    const bot = await bots().find(botId);
    if (!bot || bot.deletedAt !== null) throw new TeamBotNotFoundError();
    if (bot.ownerUserId !== actor.id && !(allowAdmin && actor.role === "admin"))
      throw new TeamBotNotFoundError();
    return bot;
  }

  return {
    /**
     * Whose account a Team Bot's call to `ref` goes out on, for the person asking.
     *
     * The asker, for anything that is not a Team Bot or is theirs, and for a server nobody has a
     * personal account on (a shared credential reaches the same place whoever asks). The owner, where
     * the owner connected it. The asker's own account only with a standing or one-time consent;
     * without one the call is refused with the card's marker, and nothing is sent.
     *
     * NEVER THE OWNER'S FOR A GRANT THE OWNER MADE. Where the owner gave the Bot this action of one of
     * their own apps (`granted_as = owner`), the owner's connection is not asked about: the call goes
     * on as though the owner had none, which is the asker's own account — with their consent, or
     * refused to connect. An owner giving their Bot their Gmail decided about their own mailbox for
     * their own use; publishing the Bot afterwards must not turn that into every teammate's access to
     * it. Only an administrator's grant can put a Team Bot on its owner's account.
     */
    credentialActorFor(actorId: string, botId: string) {
      return async (ref: string): Promise<string> => {
        const published = await publication(botId);
        const owner = published?.ownerUserId;
        if (!owner || owner === actorId) return actorId;
        const serverId = ref.split("/")[0] ?? "";
        if (
          grantedAsFor(botId, ref) !== "owner" &&
          (await connectedServers(owner)).has(serverId)
        )
          return owner;
        if (!(await connectedServers(actorId)).has(serverId)) return actorId;
        const consent = consentFor(actorId, botId, serverId);
        if (consent === "always") return actorId;
        if (allowsEveryBot(actorId, serverId)) return actorId;
        if (consent === "once") {
          // Spent by exactly one call, on any replica: whichever call Intelligence lets spend it is
          // the one that may go.
          if (await botConfiguration().consumeConsent(actorId, botId, serverId))
            return actorId;
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
     * For a check-in, which nobody is watching: which of this Bot's tools go out on the asker's OWN
     * account without asking them anything. Null when the Bot is theirs or nobody's Team Bot, where
     * every call already does.
     *
     * {@link credentialActorFor}'s answer, read without acting on it. That one spends a one-time
     * consent and raises a card, and both need a person present. So here the owner's account is no
     * (it is not what the asker connected), a one-time consent is no (it was for one call they made),
     * no consent is no, and a standing consent, for this Bot or every Bot, is yes.
     */
    async unaskedOwnAccount(
      actorId: string,
      botId: string,
    ): Promise<((ref: string) => Promise<boolean>) | null> {
      const owner = (await publication(botId))?.ownerUserId;
      if (!owner || owner === actorId) return null;
      return async (ref) => {
        const serverId = ref.split("/")[0] ?? "";
        if (
          grantedAsFor(botId, ref) !== "owner" &&
          (await connectedServers(owner)).has(serverId)
        )
          return false;
        if (consentFor(actorId, botId, serverId) === "always") return true;
        return allowsEveryBot(actorId, serverId);
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
      if (decision === "skip") {
        try {
          await botConfiguration().changePreferences(actor.id, [
            { op: "setConsent", botId, serverId, decision: null },
          ]);
        } catch (error) {
          // A Bot Intelligence no longer has holds no consent to clear.
          if (!(error instanceof ConfigurationMissingError)) throw error;
        }
        return;
      }
      if (!(await publication(botId))) throw new TeamBotNotFoundError();
      if (decision === "allow_all_team_bots") {
        await botConfiguration().changePreferences(actor.id, [
          { op: "setConsentDefault", serverId, allowed: true },
        ]);
        return;
      }
      await botConfiguration().changePreferences(actor.id, [
        {
          op: "setConsent",
          botId,
          serverId,
          decision: decision === "allow_always" ? "always" : "once",
        },
      ]);
    },

    /** Settings: forget every consent this person has given any Team Bot. */
    async clearConsents(actor: AgentActor) {
      await botConfiguration().changePreferences(actor.id, [
        { op: "clearConsents" },
      ]);
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
      // The publication and its audience together, in one change: a teammate never sees a Bot
      // published to the team for a moment on its way to being published to three people.
      await botConfiguration().changeAccess([
        {
          op: "publish",
          botId,
          audience: input.audience,
          members:
            input.audience === "people"
              ? [
                  ...[...new Set(people.map((person) => person.id))].map(
                    (id) => ({ kind: "user" as const, value: id }),
                  ),
                  ...groups.map((group) => ({
                    kind: "group" as const,
                    value: group,
                  })),
                ]
              : [],
          publishedBy: actor.id,
        },
      ]);
    },

    /** Teammates lose access until it is published again. Assignments wait, inert. */
    async unpublish(actor: AgentActor, botId: string) {
      await owned(actor, botId, true);
      await botConfiguration().changeAccess([{ op: "unpublish", botId }]);
    },

    async assign(actor: AgentActor, botId: string, groupName: string) {
      if (actor.role !== "admin")
        throw new TeamBotRefusedError("Only an admin can assign Team Bots.");
      if (!(await publication(botId)))
        throw new TeamBotRefusedError("Publish this Bot before assigning it.");
      const group = groupName.trim();
      if (!group) throw new TeamBotRefusedError("Name a group, or * for all.");
      await botConfiguration().changeAccess([
        { op: "assign", botId, group, assignedBy: actor.id },
      ]);
    },

    async unassign(actor: AgentActor, botId: string, groupName: string) {
      if (actor.role !== "admin")
        throw new TeamBotRefusedError("Only an admin can assign Team Bots.");
      try {
        await botConfiguration().changeAccess([
          { op: "unassign", botId, group: groupName },
        ]);
      } catch (error) {
        // A Bot Intelligence no longer has is assigned nowhere.
        if (!(error instanceof ConfigurationMissingError)) throw error;
      }
    },

    /** Whether this is a Team Bot somebody else published, where this person's accounts need their consent. */
    async publishedByAnother(actorId: string, botId: string): Promise<boolean> {
      const owner = (await publication(botId))?.ownerUserId;
      return Boolean(owner) && owner !== actorId;
    },

    /** Whether this Bot is in this person's sidebar by assignment, which they cannot hide. */
    async isAssignedTo(actorId: string, botId: string): Promise<boolean> {
      return isAssignedTo(database, actorId, botId);
    },

    /** The Team Bots this person may use, their own publications, and each one's settings. */
    async list(actor: AgentActor) {
      const publications = botConfiguration()
        .access.all()
        .flatMap((access) =>
          access.publication
            ? [
                {
                  agentId: access.botId,
                  audience: access.publication.audience,
                  publishedAt: access.publication.publishedAt,
                  members: access.publication.members,
                  assignments: access.assignments,
                },
              ]
            : [],
        );
      const { reaches, assigned } = await teamBotReach(database, actor.id);
      const live = await bots().findMany(
        publications.map((publication) => publication.agentId),
      );
      const rows = publications
        .flatMap((publication) => {
          const bot = live.get(publication.agentId);
          if (!bot || bot.deletedAt !== null) return [];
          const described = describedForTeam(bot);
          const visible =
            actor.role === "admin" ||
            bot.ownerUserId === actor.id ||
            (reaches.has(bot.id) && described);
          if (!visible) return [];
          return [
            {
              id: bot.id,
              name: bot.name,
              title: bot.title,
              roleDescription: bot.roleDescription,
              ownerUserId: bot.ownerUserId,
              audience: publication.audience,
              publishedAt: publication.publishedAt,
              assigned: assigned.has(bot.id),
              described,
              members: publication.members,
              assignments: publication.assignments,
            },
          ];
        })
        .sort((left, right) => left.name.localeCompare(right.name));
      // The people in an audience by their address, which is what an owner typed and recognises.
      const memberIds = [
        ...new Set(
          rows.flatMap((row) =>
            row.members
              .filter((member) => member.kind === "user")
              .map((member) => member.value),
          ),
        ),
      ];
      const emails = new Map(
        memberIds.length
          ? (
              await database
                .select({ id: users.id, email: users.email })
                .from(users)
                .where(inArray(users.id, memberIds))
            ).map((row) => [row.id, row.email])
          : [],
      );
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
                people: row.members
                  .filter((member) => member.kind === "user")
                  .map((member) => emails.get(member.value) ?? member.value),
                groups: row.members
                  .filter((member) => member.kind === "group")
                  .map((member) => member.value),
                assignments: row.assignments.map(
                  (assignment) => assignment.group,
                ),
              }
            : {}),
        };
      });
    },

    /** The owner's own Bots that could be published, for the publish list. */
    async publishable(actor: AgentActor) {
      const published = new Set(
        botConfiguration()
          .access.all()
          .filter((access) => access.publication !== null)
          .map((access) => access.botId),
      );
      return bots()
        .live()
        .filter((bot) => bot.ownerUserId === actor.id && !published.has(bot.id))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((bot) => ({ id: bot.id, name: bot.name, title: bot.title }));
    },
  };
}
export type TeamBots = ReturnType<typeof createTeamBots>;
