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
    async grant(
      kind: PluginKind,
      ref: string,
      agentId: string,
      by: string,
    ): Promise<void> {
      await database
        .insert(pluginGrants)
        .values({ kind, ref, agentId, grantedBy: by })
        .onConflictDoUpdate({
          target: [pluginGrants.kind, pluginGrants.ref, pluginGrants.agentId],
          set: { grantedBy: by, updatedAt: new Date() },
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
        },
      });
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
