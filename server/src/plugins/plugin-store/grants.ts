import { and, asc, eq, inArray } from "drizzle-orm";
import { recordAuditEvent } from "../../audit";
import { mcpTools, pluginGrants, skills } from "../../db/schema";
import type { StoreContext } from "./context";
import {
  type GrantedPlugins,
  grantTargetType,
  type PluginKind,
  toolNameFor,
} from "./model";

/** Granting and revoking a server, skill or Bot on a Bot, and what a Bot holds. */
export function grantMethods(context: StoreContext) {
  const { database, auditStore, toolsDeclaredBy } = context;
  return {
    /**
     * Give a Bot one thing, as an administrator or — `as: "owner"` — as the Bot's owner giving it one
     * of their own apps. See `plugin_grants.granted_as` for what the difference decides.
     *
     * AN OWNER'S GRANT NEVER OVERWRITES AN ADMINISTRATOR'S. An administrator's grant of the same
     * action already stands for a reason the owner did not give, and turning it into the owner's
     * would also change whose account it uses. So the owner's insert does nothing on a conflict. An
     * administrator granting over an owner's row makes it theirs: that is an administrator deciding.
     */
    async grant(
      kind: PluginKind,
      ref: string,
      agentId: string,
      by: string,
      as: "admin" | "owner" = "admin",
    ): Promise<void> {
      const insert = database
        .insert(pluginGrants)
        .values({ kind, ref, agentId, grantedBy: by, grantedAs: as });
      if (as === "owner") {
        /*
         * Nothing written, nothing in the trail. A row already there is an administrator's grant
         * or the owner's own from before, and a `plugin_granted` row marked `owner` over an
         * administrator's grant would tell a reader the owner had given what an administrator did.
         */
        const written = await insert
          .onConflictDoNothing()
          .returning({ ref: pluginGrants.ref });
        if (written.length === 0) return;
      } else
        await insert.onConflictDoUpdate({
          target: [pluginGrants.kind, pluginGrants.ref, pluginGrants.agentId],
          set: { grantedBy: by, grantedAs: "admin", updatedAt: new Date() },
        });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: grantTargetType(kind),
        targetId: ref,
        payload: {
          actor: by,
          change: "plugin_granted",
          kind,
          ref,
          bot: agentId,
          ...(as === "owner" ? { grantedAs: "owner" } : {}),
        },
      });
    },

    /**
     * Take back what the Bot's owner gave it on one app: every grant on these server rows that the
     * owner made, and none an administrator made. Answers the refs taken, each with its own trail
     * row, as {@link revoke} writes one.
     */
    async revokeOwnerGrants(
      serverIds: string[],
      agentId: string,
      by: string,
    ): Promise<string[]> {
      if (serverIds.length === 0) return [];
      const owned = and(
        eq(pluginGrants.kind, "mcp"),
        eq(pluginGrants.agentId, agentId),
        eq(pluginGrants.grantedAs, "owner"),
      );
      const refs = (
        await database
          .select({ ref: pluginGrants.ref })
          .from(pluginGrants)
          .where(owned)
      )
        .map((row) => row.ref)
        .filter((ref) => serverIds.includes(ref.split("/")[0] ?? ""));
      if (refs.length === 0) return [];
      await database
        .delete(pluginGrants)
        .where(and(owned, inArray(pluginGrants.ref, refs)));
      for (const ref of refs)
        await recordAuditEvent(auditStore, {
          eventType: "configuration.changed",
          targetType: grantTargetType("mcp"),
          targetId: ref,
          payload: {
            actor: by,
            change: "plugin_revoked",
            kind: "mcp",
            ref,
            bot: agentId,
            grantedAs: "owner",
          },
        });
      return refs;
    },

    async revoke(
      kind: PluginKind,
      ref: string,
      agentId: string,
      by: string,
    ): Promise<void> {
      await database
        .delete(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, kind),
            eq(pluginGrants.ref, ref),
            eq(pluginGrants.agentId, agentId),
          ),
        );

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: grantTargetType(kind),
        targetId: ref,
        payload: {
          actor: by,
          change: "plugin_revoked",
          kind,
          ref,
          bot: agentId,
        },
      });
    },

    /** Everything one Bot may use. The runtime asks this and offers exactly what comes back. */
    async listForAgent(agentId: string): Promise<GrantedPlugins> {
      const held = await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, agentId));
      if (held.length === 0) return { tools: [], skills: [] };

      const toolRefs = held
        .filter((row) => row.kind === "mcp")
        .map((row) => row.ref);
      const skillSlugs = held
        .filter((row) => row.kind === "skill")
        .map((row) => row.ref);

      /*
       * Narrowed in the query to the servers this Bot is actually granted something from, the same way
       * `knownToolRefs` does it and for the same reason: a deployment aiming at a thousand tools should
       * not read all of them to offer a handful. This is the run-time path, so it ran on every run of
       * every Bot, selected every row in `mcp_tools`, and then discarded almost all of them here — and
       * it sits underneath tool selection, so its cost is paid before the narrowing that was added to
       * make large catalogues work.
       *
       * The exact ref is still matched below rather than in the query. Narrowing by server is a
       * predicate the composite primary key can use; naming every (server, tool) pair would be exact
       * and is not worth a clause per grant, because a server's own tool list is the bound on what
       * comes back.
       */
      const grantedServers = [
        ...new Set(toolRefs.map((ref) => ref.split("/")[0] ?? "")),
      ];
      const toolRows =
        grantedServers.length === 0
          ? []
          : await database
              .select()
              .from(mcpTools)
              .where(inArray(mcpTools.serverId, grantedServers))
              .orderBy(asc(mcpTools.name));
      // A set, so this is a lookup per row rather than a walk of the grants per row.
      const granted = new Set(toolRefs);
      const grantedTools = toolRows
        .filter((row) => granted.has(`${row.serverId}/${row.name}`))
        .map((row) => {
          const ref = `${row.serverId}/${row.name}`;
          return {
            ref,
            toolName: toolNameFor(ref),
            description: row.description,
            inputSchema: row.inputSchema as Record<string, unknown>,
          };
        });

      const skillRows =
        skillSlugs.length === 0
          ? []
          : await database
              .select()
              .from(skills)
              .where(inArray(skills.slug, skillSlugs));

      /*
       * What each skill says it needs, carried alongside rather than folded into `tools`.
       *
       * `tools` above is what this Bot may call, and nothing here may widen it. Selection, when it is
       * built, intersects the two; handing the runtime a union instead would make writing a skill a
       * way to grant a tool, which is the one thing this must never be.
       */
      const declared = await toolsDeclaredBy(skillRows.map((row) => row.id));

      return {
        tools: grantedTools,
        skills: skillRows.map((row) => ({
          slug: row.slug,
          title: row.title,
          summary: row.summary,
          instructions: row.instructions,
          tools: declared.get(row.id) ?? [],
        })),
      };
    },
  };
}
