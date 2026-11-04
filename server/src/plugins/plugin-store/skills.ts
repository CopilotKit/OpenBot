import { and, eq } from "drizzle-orm";
import { recordAuditEvent } from "../../audit";
import { bots } from "../../agents/bot-registry/directory";
import {
  ConfigurationConflictError,
  configurationKey,
} from "../../configuration/client";
import { botConfiguration } from "../../configuration/directory";
import type { SkillEntry } from "../../configuration/types";
import { mcpServers, mcpTools, vendorNameOf } from "../../db/schema";

/** How many times a save is redone on top of somebody else's that saved first. */
const SAVE_ATTEMPTS = 3;

/** Skills sorted by title, as the deployment's database sorted them for a list. */
function byTitle(left: SkillEntry, right: SkillEntry) {
  return left.title.localeCompare(right.title);
}
import type { StoreContext } from "./context";
import { PluginRefusedError, type SkillActor, type SkillRecord } from "./model";

/**
 * Skills, and what the store answers about Bots and servers for the routes and the desk.
 *
 * Skills live in Intelligence, held in memory on this instance (configuration/directory.ts), so a
 * run's skill selection and the `/` menu never wait on it. Writes go to Intelligence and are held
 * here from its answer.
 */
export function skillMethods(context: StoreContext) {
  const { database, auditStore, grantsFor, toolsDeclaredBy, knownToolRefs } =
    context;
  return {
    /**
     * The skills this person may see: the deployment's, plus their own.
     *
     * An administrator sees every skill in the deployment, including other people's, because
     * governing what Bots are told is the job of the surface they are looking at.
     */
    async listSkills(actor?: SkillActor): Promise<SkillRecord[]> {
      const rows = botConfiguration()
        .skills.all()
        .filter(
          (skill) =>
            !actor ||
            actor.isAdmin ||
            skill.ownerUserId === null ||
            skill.ownerUserId === actor.id,
        )
        .sort(byTitle);
      const grants = await grantsFor(
        "skill",
        rows.map((row) => row.slug),
      );
      const declared = await toolsDeclaredBy(rows.map((row) => row.slug));
      return rows.map((row) => ({
        id: row.slug,
        slug: row.slug,
        ownerUserId: row.ownerUserId,
        title: row.title,
        summary: row.summary,
        instructions: row.instructions,
        origin: row.origin,
        installedBy: row.installedBy,
        grantedTo: grants.get(row.slug) ?? [],
        tools: declared.get(row.slug) ?? [],
      }));
    },

    /** Whose a skill is, or `undefined` if there is no such skill. Null owner means the deployment's. */
    async skillOwner(slug: string): Promise<string | null | undefined> {
      const row = botConfiguration().skills.get(slug);
      return row ? row.ownerUserId : undefined;
    },

    /**
     * Whose a Bot is, or `undefined` if there is no such Bot.
     *
     * Read here rather than through the coworker store because the only question this file asks is
     * "may this person put their skill on that Bot", and a whole profile is more than that needs.
     */
    /**
     * Whether this Bot can be granted handing work on, or `undefined` if there is no such Bot.
     *
     * Any Bot that exists can: a built-in Bot runs `message_bot` in this process, and a Bot at its
     * own endpoint calls back for it through the signed tool callback, which reaches the same desk.
     */
    async agentCanHandOn(agentId: string): Promise<boolean | undefined> {
      const bot = await bots().find(agentId);
      // A deleted Bot is not one anybody may be given, and answering about it at all would say it
      // had existed.
      return bot && bot.deletedAt === null ? true : undefined;
    },

    /**
     * Whether this Bot is one somebody could be handed work by, at all.
     *
     * The TARGET of a bot grant, unlike the grantee, may perfectly well run at its own endpoint —
     * being handed work is not the same as being able to hand it on. What it may not be is absent:
     * `ref` is bare text with no foreign key, so a typo stored happily, `message_bot` was offered,
     * and every hop refused as not-granted. That is the same row-that-cannot-work this check exists
     * to stop, arriving from the other side.
     */
    async agentIsRegistered(agentId: string): Promise<boolean> {
      const bot = await bots().find(agentId);
      return bot !== null && bot.deletedAt === null;
    },

    /**
     * Whether this deployment has an app by this id.
     *
     * The narrowest question a caller can ask about a server, and deliberately not `listServers`,
     * which materialises every tool and every grant in the deployment to answer. One row, one
     * column, one limit — this runs on the grant path, which is a person waiting on a switch.
     *
     * Existence only. Whether the app currently ADVERTISES a given tool is a different question and
     * is not asked here: a grant naming a tool a server has stopped offering is a supported state
     * ({@link GrantOnWithdrawnTool}), held and not offered, because what a vendor advertises today
     * is not what somebody decided yesterday. A grant naming no app at all is not that state.
     */
    async serverExists(serverId: string): Promise<boolean> {
      if (!serverId) return false;
      const [row] = await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
        .limit(1);
      return row !== undefined;
    },

    /**
     * Whether this server publishes an action named EXACTLY this.
     *
     * One indexed read on `mcp_tools`, and deliberately not `listServers`, which materialises every
     * tool and every grant in the deployment to answer. The comparison is `=` on the stored text and
     * so CASE-SENSITIVE: Arcade names are dotted and case-sensitive and are never normalized, and
     * `Gmail.SendEmail` is not `gmail.sendemail`.
     *
     * ASKED OF `vendor_name`, WHICH IS THE NAME THE QUESTION IS ABOUT. Every caller of this reaches
     * it holding an action out of the per-action authorization flow, and that flow speaks the
     * vendor's spelling from end to end: `grantsFor` lists what Arcade reports, the Authorize button
     * sends that back, the attempt row stores it, `?action=` carries it home and `authorize({
     * action })` is refused by the vendor under any other spelling. Asking `name` — this
     * deployment's own identifier, which for Arcade is the qualified name with its toolkit removed —
     * would make this gate answer false for every action that exists, and `/servers/:id/authorize`
     * would refuse the whole flow with "does not publish an action by that name".
     *
     * The two columns hold the same string for every other transport, so no other provider's gate
     * moves. See {@link mcpTools.vendorName}.
     */
    async serverPublishesAction(
      serverId: string,
      action: string,
    ): Promise<boolean> {
      if (!serverId || !action) return false;
      const [row] = await database
        .select({ name: vendorNameOf() })
        .from(mcpTools)
        .where(and(eq(mcpTools.serverId, serverId), eq(vendorNameOf(), action)))
        .limit(1);
      return row !== undefined;
    },

    async agentOwner(agentId: string): Promise<string | null | undefined> {
      const bot = await bots().find(agentId);
      return bot ? bot.ownerUserId : undefined;
    },

    async installSkill(input: {
      slug: string;
      title: string;
      summary: string;
      instructions: string;
      origin?: string;
      /** Whose it is. Null writes a skill for the whole deployment, which is an admin's to make. */
      ownerUserId: string | null;
      /**
       * The tools this skill needs, as `<serverId>/<toolName>` refs. Absent leaves whatever was
       * declared before; an empty array clears it, which is how a skill stops asking for anything.
       */
      tools?: string[];
      by: string;
    }): Promise<void> {
      /*
       * Checked before anything is written, so a save is all-or-nothing from the caller's side: a
       * skill is never left saved with half its declarations because the fourth ref was a typo.
       */
      const declared =
        input.tools === undefined
          ? undefined
          : [...new Set(input.tools.map((ref) => ref.trim()).filter(Boolean))];
      if (declared !== undefined && declared.length > 0) {
        const known = await knownToolRefs(declared);
        const unknown = declared.filter((ref) => !known.has(ref));
        if (unknown.length > 0) {
          throw new PluginRefusedError(
            `No tool by that name has been seen here: ${unknown.join(", ")}. A skill names tools as serverId/toolName, and the server has to have been refreshed at least once.`,
            // No policy rule refused this; the name simply matches nothing. `rule` is what an audit
            // reader is shown as the reason, and inventing one here would put a rule in the trail
            // that nobody wrote.
            null,
          );
        }
      }

      /*
       * Written whole, at the version it was read at, and redone on the latest copy when somebody
       * else saved first.
       *
       * Editing keeps the owner it already had. Whose a skill is, is not something a re-save should
       * quietly change, and the route has already checked this person may edit it. `installedBy` is
       * left alone too: it records who first installed it, not who last saved. What a skill needs
       * is replaced wholesale rather than merged: a save says what it is now, and merging would make
       * removing one a thing with no gesture for it. Absent leaves it as it was.
       *
       * WHERE THE TEXT NOW COMES FROM, WRITTEN BESIDE THE TEXT. A save through here leaves `origin`
       * saying what it says on a create. `origin = 'catalogue'` is the condition the package seed
       * (`tenant-package.ts`) overwrites a skill on at every boot; leaving it standing after somebody
       * edited a shipped skill here kept it eligible, so the next boot silently replaced their edit
       * with the package's text.
       */
      const origin = input.origin ?? "yours";
      for (let attempt = 1; ; attempt++) {
        const current = botConfiguration().skills.get(input.slug);
        try {
          const saved = current
            ? await botConfiguration().client.skills.replace(
                input.slug,
                current.version,
                {
                  ownerUserId: current.ownerUserId,
                  title: input.title,
                  summary: input.summary,
                  instructions: input.instructions,
                  origin,
                  installedBy: current.installedBy,
                  tools: (
                    declared ?? current.tools.map((tool) => tool.ref)
                  ).map((ref) => ({
                    ref,
                    declaredBy:
                      declared === undefined
                        ? (current.tools.find((tool) => tool.ref === ref)
                            ?.declaredBy ?? null)
                        : input.by,
                  })),
                },
                configurationKey("skill-save"),
              )
            : await botConfiguration().client.skills.create(
                input.slug,
                {
                  ownerUserId: input.ownerUserId,
                  title: input.title,
                  summary: input.summary,
                  instructions: input.instructions,
                  origin,
                  installedBy: input.by,
                  tools: (declared ?? []).map((ref) => ({
                    ref,
                    declaredBy: input.by,
                  })),
                },
                configurationKey("skill-save"),
              );
          botConfiguration().skills.apply(saved);
          break;
        } catch (error) {
          if (
            !(error instanceof ConfigurationConflictError) ||
            attempt >= SAVE_ATTEMPTS
          )
            throw error;
          await botConfiguration().skills.refresh(input.slug);
        }
      }

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "skill",
        targetId: input.slug,
        payload: {
          actor: input.by,
          change: "skill_installed",
          skill: input.slug,
          // Recorded because it is what the skill will pull into a model's context once selection is
          // built. It changes nothing about what may be called; the grant still decides that.
          ...(declared === undefined ? {} : { declares: declared }),
        },
      });
    },

    async uninstallSkill(slug: string, by: string): Promise<void> {
      // The skill and every grant of it, together: Intelligence removes both in one transaction, so
      // a skill later written under this slug cannot reach a Bot through a grant of this one.
      const holders = botConfiguration()
        .access.all()
        .filter((access) =>
          access.grants.some(
            (grant) => grant.kind === "skill" && grant.ref === slug,
          ),
        )
        .map((access) => access.botId);
      await botConfiguration().client.skills.remove(
        slug,
        configurationKey("skill-uninstall"),
      );
      botConfiguration().skills.forget(slug);
      // The Bots that held it, read again now rather than when their announcements arrive.
      for (const botId of holders)
        await botConfiguration().access.refresh(botId);
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "skill",
        targetId: slug,
        payload: { actor: by, change: "skill_uninstalled", skill: slug },
      });
    },

    /**
     * The Bots one Bot has been granted.
     *
     * Whether one Bot may address another is a decision an administrator can change, and a grant
     * revoked a minute ago has to apply to the next hop rather than after a restart. Read from the
     * Bot's access as this instance holds it, which a revocation reaches here at once and on every
     * other replica with its announcement.
     */
    /**
     * The Bots this one may hand work to.
     *
     * Whatever the grantee's type. A Bot at its own endpoint is offered `message_bot` as a tool it
     * calls back for, and the call reaches the same handoff desk, grant check and caps as a built-in
     * Bot's (see `createCoordinationTools`). This used to keep only built-in grantees, from before
     * remote Bots could call back for coordination, which left every remote Bot's grant reading as
     * configured while no hop ever happened.
     *
     * The join keeps a grant held by a Bot that no longer exists from counting.
     */
    async botsReachableFrom(agentId: string): Promise<string[]> {
      // A grant held by a Bot Intelligence no longer has does not count.
      if (!(await bots().find(agentId))) return [];
      return botConfiguration()
        .accessOf(agentId)
        .grants.filter((grant) => grant.kind === "bot")
        .map((grant) => grant.ref);
    },
  };
}
