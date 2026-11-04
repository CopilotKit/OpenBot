import { asc, inArray } from "drizzle-orm";
import { recordAuditEvent } from "../../audit";
import { botConfiguration } from "../../configuration/directory";
import { mcpTools } from "../../db/schema";
import type { StoreContext } from "./context";
import {
  type GrantedPlugins,
  grantTargetType,
  type PluginKind,
  toolNameFor,
} from "./model";

/**
 * Granting and revoking a server, skill or Bot on a Bot, and what a Bot holds.
 *
 * A Bot's grants are part of its access in Intelligence, held in memory on this instance
 * (configuration/directory.ts): what a run may offer is read from there, never from a request to
 * Intelligence, and a grant made on another replica arrives with its announcement.
 */
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
      const [result] = await botConfiguration().changeAccess([
        {
          op: "grant",
          botId: agentId,
          kind,
          ref,
          grantedBy: by,
          grantedAs: as,
          ifGranted: as === "owner" ? "keep" : "replace",
        },
      ]);
      /*
       * Nothing written, nothing in the trail. A grant already there is an administrator's or the
       * owner's own from before, and a `plugin_granted` row marked `owner` over an administrator's
       * grant would tell a reader the owner had given what an administrator did.
       */
      if (as === "owner" && result?.outcome === "kept") return;

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
      // Every one this owner gave, on any of these servers, in one change.
      const results = await botConfiguration().changeAccess(
        serverIds.map((serverId) => ({
          op: "revokeMatching" as const,
          kind: "mcp" as const,
          botIds: [agentId],
          refPrefix: `${serverId}/`,
          grantedAs: "owner" as const,
        })),
      );
      const refs = [
        ...new Set(
          results.flatMap((result) =>
            (result.revoked ?? []).map((grant) => grant.ref),
          ),
        ),
      ].sort();
      if (refs.length === 0) return [];
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
      await botConfiguration().changeAccess([
        { op: "revoke", botId: agentId, kind, ref },
      ]);

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
      const held = botConfiguration().accessOf(agentId).grants;
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

      const skillRows = skillSlugs.flatMap((slug) => {
        const skill = botConfiguration().skills.get(slug);
        return skill ? [skill] : [];
      });

      /*
       * What each skill says it needs, carried alongside rather than folded into `tools`.
       *
       * `tools` above is what this Bot may call, and nothing here may widen it. Selection, when it is
       * built, intersects the two; handing the runtime a union instead would make writing a skill a
       * way to grant a tool, which is the one thing this must never be.
       */
      const declared = await toolsDeclaredBy(skillRows.map((row) => row.slug));

      return {
        tools: grantedTools,
        skills: skillRows.map((row) => ({
          slug: row.slug,
          title: row.title,
          summary: row.summary,
          instructions: row.instructions,
          tools: declared.get(row.slug) ?? [],
        })),
      };
    },
  };
}
