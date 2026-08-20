import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type ApprovalRegistry,
  fingerprintOf,
  type PendingApproval,
} from "../computer/approvals";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
} from "../computer/policy";
import {
  type CredentialSecretReader,
  decryptCredentialForUse,
} from "../credentials";
import type { Database } from "../db/client";
import {
  agentProfiles,
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
} from "../db/schema";
import {
  type CatalogueEntry,
  catalogueEntry,
  classifyTool,
  customUrlRefusal,
  resolveServerUrl,
} from "./catalogue";
import { callTool as callRemoteTool, listTools, McpServerError } from "./mcp";

/**
 * Plugins: what this deployment has added, which Bots may use it, and the one path a call takes.
 *
 * The grant and the policy are two different questions and both are asked on every call. The grant
 * answers "is this Bot allowed this tool at all", which an operator decides on the Plugins page. The
 * policy answers "is this particular call permitted right now", which is written as a rule and can
 * say things a grant cannot: not on this host, not this argument, not a write. Collapsing them would
 * mean an operator who granted a Bot a server had also, invisibly, waived every rule about it.
 */

export type PluginKind = "mcp" | "skill";

export type ToolRecord = {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `<serverId>/<name>`. What a grant names and what the model's tool name is derived from. */
  ref: string;
  effect: "read" | "write";
  grantedTo: string[];
};

export type ServerRecord = {
  id: string;
  title: string;
  vendor: string;
  url: string;
  summary: string;
  docsUrl: string;
  /** `first-party` or `custom`. Shown wherever the server is, never inferred by a reader. */
  provenance: string;
  hasCredential: boolean;
  toolsRefreshedAt: string | null;
  lastError: string | null;
  addedBy: string | null;
  tools: ToolRecord[];
};

export type SkillRecord = {
  id: string;
  slug: string;
  /** Whose it is. Null means the deployment's, written by an administrator or shipped. */
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  grantedTo: string[];
};

/**
 * Who is asking, for the surfaces where the answer depends on it.
 *
 * An administrator sees and governs the whole deployment. Everybody else sees the deployment's
 * skills and their own, and may act only on their own.
 */
export type SkillActor = { id: string; isAdmin: boolean };

/** What one Bot holds. Everything the runtime needs to offer it, and nothing it does not. */
export type GrantedPlugins = {
  tools: {
    ref: string;
    /** The name the model is offered, which is the ref with the separator a tool name allows. */
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  skills: {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
  }[];
};

export type PluginDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export class PluginRefusedError extends Error {
  constructor(
    message: string,
    readonly rule: string | null,
  ) {
    super(message);
    this.name = "PluginRefusedError";
  }
}

/**
 * The boundary wants a person's answer before this call is made.
 *
 * Emphatically not a {@link PluginRefusedError}, for the same reason the computer keeps the two
 * apart. A refusal is final and a model told it was refused should say so and stop; this is a pause,
 * and the identical call arriving again with an approval on it is the intended next step rather than
 * an attempt to get around anything. Collapsing them teaches a model to abandon exactly the work a
 * deployment was willing to permit, which is what makes an ask list that degrades to a deny list
 * worse than having no ask list at all.
 */
export class PluginNeedsApprovalError extends Error {
  /** What the caller presents once somebody has answered. */
  readonly approvalId: string;
  /** The question in the words a person is being shown, so the Bot can say what it is waiting for. */
  readonly question: string;
  /** The rule that asked, so the surface can name the boundary the way a refusal does. */
  readonly rule: string;

  constructor(approval: PendingApproval) {
    super(approval.question);
    this.name = "PluginNeedsApprovalError";
    this.approvalId = approval.id;
    this.question = approval.question;
    this.rule = approval.rule;
  }
}

export class CatalogueEntryUnknownError extends Error {
  constructor(key: string) {
    super(`${key} is not a server this deployment will connect to.`);
    this.name = "CatalogueEntryUnknownError";
  }
}

/** A URL an administrator offered that this deployment will not point itself at. */
export class CustomServerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomServerRefusedError";
  }
}

/**
 * A tool name the model can actually call.
 *
 * `<server>/<tool>` is how a grant is stored, because a slash reads correctly to a person and cannot
 * appear in either half. Model tool names may not contain one, so the offered name uses `__`.
 * Converting in one place, both ways, keeps the two spellings from drifting.
 */
export const toolNameFor = (ref: string) => `mcp__${ref.replace("/", "__")}`;

export function refFromToolName(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return null;
  return `${rest.slice(0, separator)}/${rest.slice(separator + 2)}`;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;

export type PluginStoreOptions = {
  database: Database;
  auditStore: AuditStore;
  credentials: CredentialSecretReader;
  encryptionKey: string;
  /** Read at call time, never captured, so a policy changed a moment ago applies to this call. */
  policy: () => ActionPolicy;
  /**
   * Where a question raised by the `ask` list waits for an answer.
   *
   * Required rather than optional, and the same registry the computer uses. Optional would mean a
   * store built without one, which is easily done, quietly turning every ask rule about a tool call
   * into a refusal: the failure this whole path exists to avoid, arriving through a field somebody
   * forgot to pass.
   */
  approvals: ApprovalRegistry;
};

export function createPluginStore(options: PluginStoreOptions) {
  const { database, auditStore, credentials, encryptionKey } = options;

  async function grantsFor(kind: PluginKind, refs: string[]) {
    if (refs.length === 0) return new Map<string, string[]>();
    const rows = await database
      .select()
      .from(pluginGrants)
      .where(and(eq(pluginGrants.kind, kind), inArray(pluginGrants.ref, refs)));
    const byRef = new Map<string, string[]>();
    for (const row of rows) {
      byRef.set(row.ref, [...(byRef.get(row.ref) ?? []), row.agentId]);
    }
    return byRef;
  }

  /**
   * Who did it goes in the payload, never in `actorUserId`.
   *
   * That column is a foreign key to `users.id`, and everything here holds an email. Writing one
   * there does not fail loudly: the insert violates the constraint and the entire audit row is lost.
   */

  /** The credential for a server, decrypted for one call and never held. */
  async function tokenFor(
    credentialId: string | null,
  ): Promise<string | undefined> {
    if (!credentialId) return undefined;
    return decryptCredentialForUse(encryptionKey, credentials, credentialId);
  }

  async function requireServer(serverId: string) {
    const [row] = await database
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!row) throw new CatalogueEntryUnknownError(serverId);

    const entry = catalogueEntry(row.id);
    if (row.provenance === "first-party" && !entry) {
      // The row outlived its catalogue entry, which means a build removed a vendor while a
      // deployment still had it added. Refused rather than reached: the pinned host that made it
      // admissible no longer exists to check against, so there is nothing left that says this URL
      // is one we agreed to talk to.
      throw new CatalogueEntryUnknownError(row.id);
    }
    // Null for a custom server, and every caller handles that by assuming the worst about it.
    return { row, entry };
  }

  /**
   * Spend a person's answer on this call, or stop and ask them.
   *
   * The fingerprint covers the arguments as well as the tool, which is the difference between this
   * and the browser actions. A click is identified by the thing it lands on; a call to somebody
   * else's server is identified by what it says, and an approval for "post the release note in the
   * team channel" that could be spent on any other message to any other channel would be a
   * confirmation prompt wearing a governance feature's clothes.
   *
   * Returns who allowed it. Throws when nobody has, which every unsuccessful presentation counts as:
   * an expired id, one already spent, a No being replayed and an approval given for a different call
   * all mean that nobody has agreed to THIS, and asking again is both the safe answer and the one a
   * person can act on.
   */
  async function askAbout(question: {
    approvalId: string | undefined;
    botId: string;
    actorId: string;
    ref: string;
    serverId: string;
    toolName: string;
    effect: "read" | "write";
    args: Record<string, unknown>;
    rule: string;
    question: string;
  }): Promise<string> {
    const fingerprint = fingerprintOf({
      botId: question.botId,
      toolName: toolNameFor(question.ref),
      arguments: question.args,
    });
    const presented = question.approvalId
      ? options.approvals.consume(question.approvalId, fingerprint)
      : undefined;
    // An approval with nobody's name on it asks again rather than being credited to whoever was
    // driving the Bot, which is the one attribution this record must never make.
    if (presented?.ok && presented.approval.answeredBy) {
      return presented.approval.answeredBy;
    }

    const pending = options.approvals.request({
      botId: question.botId,
      actor: question.actorId,
      rule: question.rule,
      question: question.question,
      fingerprint,
      // Filed against the tool, so the answer's row lands beside the call's own row rather than
      // under whichever surface the person happened to press the button on.
      target: { type: "mcp_tool", id: question.ref },
    });
    await recordAuditEvent(auditStore, {
      eventType: "approval.requested",
      targetType: "mcp_tool",
      targetId: question.ref,
      payload: {
        bot: question.botId,
        actor: question.actorId,
        approval: pending.id,
        rule: pending.rule,
        reason: pending.question,
        server: question.serverId,
        tool: question.toolName,
        effect: question.effect,
      },
    });
    throw new PluginNeedsApprovalError(pending);
  }

  return {
    /**
     * Add a server from the catalogue.
     *
     * The URL is resolved from the catalogue rather than accepted from the caller, so the only thing
     * a person can influence is which entry and, for a per-instance vendor, their own instance
     * hostname, which is then checked against that vendor's anchored pattern before anything is
     * stored.
     */
    async addServer(input: {
      key: string;
      instanceHost?: string;
      credentialId?: string;
      by: string;
    }): Promise<ServerRecord> {
      const resolved = resolveServerUrl(input.key, input.instanceHost);
      if (!resolved) throw new CatalogueEntryUnknownError(input.key);

      await database
        .insert(mcpServers)
        .values({
          id: resolved.entry.key,
          title: resolved.entry.title,
          vendor: resolved.entry.vendor,
          url: resolved.url,
          credentialId: input.credentialId ?? null,
          addedBy: input.by,
        })
        .onConflictDoUpdate({
          target: mcpServers.id,
          set: {
            url: resolved.url,
            credentialId: input.credentialId ?? null,
            addedBy: input.by,
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: resolved.entry.key,
        payload: {
          actor: input.by,
          change: "mcp_server_added",
          server: resolved.entry.key,
          url: resolved.url,
        },
      });

      // Refreshed immediately so the page that added it can show what it offers, and so a bad
      // credential is reported now rather than the first time a Bot tries to use it.
      await this.refreshTools(resolved.entry.key);
      const servers = await this.listServers();
      const added = servers.find((server) => server.id === resolved.entry.key);
      if (!added) throw new CatalogueEntryUnknownError(input.key);
      return added;
    },

    /**
     * Add a server that is not in the catalogue, by URL.
     *
     * The administrator's path is different from pressing Add on a curated entry. That
     * one picks a reviewed vendor at a pinned host; this one points the deployment at an address
     * somebody typed. Both are useful and only one of them can be reviewed in advance, so this one
     * is guarded at the URL, recorded with its provenance, and every tool it offers is treated as a
     * write because nothing here knows otherwise.
     */
    async addCustomServer(input: {
      id: string;
      title: string;
      url: string;
      credentialId?: string;
      by: string;
    }): Promise<ServerRecord> {
      const refusal = customUrlRefusal(input.url);
      if (refusal) throw new CustomServerRefusedError(refusal);

      // A custom server may not take a curated entry's slug. The slug prefixes tool names and is
      // what a grant and a policy rule are written against, so allowing a shadow would let a custom
      // server inherit rules an operator wrote about the vendor.
      if (catalogueEntry(input.id)) {
        throw new CustomServerRefusedError(
          `${input.id} is the name of a server this deployment already knows. Choose another.`,
        );
      }
      if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(input.id)) {
        throw new CustomServerRefusedError(
          "A server name is lower-case letters, numbers and hyphens.",
        );
      }

      await database
        .insert(mcpServers)
        .values({
          id: input.id,
          title: input.title,
          vendor: new URL(input.url).hostname,
          url: input.url,
          provenance: "custom",
          credentialId: input.credentialId ?? null,
          addedBy: input.by,
        })
        .onConflictDoUpdate({
          target: mcpServers.id,
          set: {
            title: input.title,
            url: input.url,
            credentialId: input.credentialId ?? null,
            addedBy: input.by,
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: input.id,
        payload: {
          actor: input.by,
          change: "mcp_server_added",
          server: input.id,
          url: input.url,
          // Named in the trail, because "who added a server nobody reviewed" is a question somebody
          // will ask and the answer should not require reading the catalogue of a past build.
          provenance: "custom",
        },
      });

      await this.refreshTools(input.id);
      const added = (await this.listServers()).find(
        (server) => server.id === input.id,
      );
      if (!added) throw new CatalogueEntryUnknownError(input.id);
      return added;
    },

    async removeServer(serverId: string, by: string): Promise<void> {
      await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: serverId,
        payload: { actor: by, change: "mcp_server_removed", server: serverId },
      });
    },

    /**
     * Ask a server what it offers and replace what we hold.
     *
     * Replaced wholesale, never merged. A tool a vendor withdrew has to stop being offered, and a
     * merge would leave it in the list forever as a name the model will happily call.
     */
    async refreshTools(serverId: string): Promise<{ tools: number }> {
      const { row } = await requireServer(serverId);

      try {
        const token = await tokenFor(row.credentialId);
        const tools = await listTools({ url: row.url, token });

        await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
        if (tools.length > 0) {
          await database.insert(mcpTools).values(
            tools.map((tool) => ({
              serverId,
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          );
        }

        await database
          .update(mcpServers)
          .set({
            toolsRefreshedAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(mcpServers.id, serverId));

        return { tools: tools.length };
      } catch (error) {
        const message =
          error instanceof McpServerError || error instanceof Error
            ? error.message
            : String(error);
        // The failure is recorded rather than thrown away, because a server with no tools and no
        // explanation reads as a server that offers nothing, and an operator would go looking in
        // the wrong place. The tools already held are left alone: a vendor being briefly
        // unreachable is not a reason to revoke what Bots are using.
        await database
          .update(mcpServers)
          .set({ lastError: message, updatedAt: new Date() })
          .where(eq(mcpServers.id, serverId));
        return { tools: 0 };
      }
    },

    async listServers(): Promise<ServerRecord[]> {
      const rows = await database
        .select()
        .from(mcpServers)
        .orderBy(asc(mcpServers.title));
      if (rows.length === 0) return [];

      const tools = await database
        .select()
        .from(mcpTools)
        .where(
          inArray(
            mcpTools.serverId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(asc(mcpTools.name));

      const grants = await grantsFor(
        "mcp",
        tools.map((tool) => `${tool.serverId}/${tool.name}`),
      );

      return rows.map((row) => {
        const entry = catalogueEntry(row.id);
        return {
          id: row.id,
          title: row.title,
          vendor: row.vendor,
          url: row.url,
          summary: entry?.summary ?? "",
          docsUrl: entry?.docsUrl ?? "",
          provenance: row.provenance,
          hasCredential: row.credentialId !== null,
          toolsRefreshedAt: iso(row.toolsRefreshedAt),
          lastError: row.lastError,
          addedBy: row.addedBy,
          tools: tools
            .filter((tool) => tool.serverId === row.id)
            .map((tool) => {
              const ref = `${tool.serverId}/${tool.name}`;
              return {
                serverId: tool.serverId,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema as Record<string, unknown>,
                ref,
                effect: classifyTool(entry, tool.name, true),
                grantedTo: grants.get(ref) ?? [],
              };
            }),
        };
      });
    },

    /**
     * The skills this person may see: the deployment's, plus their own.
     *
     * An administrator sees every skill in the deployment, including other people's, because
     * governing what Bots are told is the job of the surface they are looking at.
     */
    async listSkills(actor?: SkillActor): Promise<SkillRecord[]> {
      const visible =
        !actor || actor.isAdmin
          ? undefined
          : or(isNull(skills.ownerUserId), eq(skills.ownerUserId, actor.id));
      const rows = await database
        .select()
        .from(skills)
        .where(visible)
        .orderBy(asc(skills.title));
      const grants = await grantsFor(
        "skill",
        rows.map((row) => row.slug),
      );
      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        ownerUserId: row.ownerUserId,
        title: row.title,
        summary: row.summary,
        instructions: row.instructions,
        origin: row.origin,
        installedBy: row.installedBy,
        grantedTo: grants.get(row.slug) ?? [],
      }));
    },

    /** Whose a skill is, or `undefined` if there is no such skill. Null owner means the deployment's. */
    async skillOwner(slug: string): Promise<string | null | undefined> {
      const [row] = await database
        .select({ ownerUserId: skills.ownerUserId })
        .from(skills)
        .where(eq(skills.slug, slug))
        .limit(1);
      return row ? row.ownerUserId : undefined;
    },

    /**
     * Whose a Bot is, or `undefined` if there is no such Bot.
     *
     * Read here rather than through the coworker store because the only question this file asks is
     * "may this person put their skill on that Bot", and a whole profile is more than that needs.
     */
    async agentOwner(agentId: string): Promise<string | null | undefined> {
      const [row] = await database
        .select({ ownerUserId: agentProfiles.ownerUserId })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, agentId))
        .limit(1);
      return row ? row.ownerUserId : undefined;
    },

    async installSkill(input: {
      slug: string;
      title: string;
      summary: string;
      instructions: string;
      origin?: string;
      /** Whose it is. Null writes a skill for the whole deployment, which is an admin's to make. */
      ownerUserId: string | null;
      by: string;
    }): Promise<void> {
      await database
        .insert(skills)
        .values({
          id: input.slug,
          slug: input.slug,
          ownerUserId: input.ownerUserId,
          title: input.title,
          summary: input.summary,
          instructions: input.instructions,
          origin: input.origin ?? "yours",
          installedBy: input.by,
        })
        // Editing keeps the owner it already had. Whose a skill is, is not something a re-save
        // should quietly change, and the route has already checked this person may edit it.
        .onConflictDoUpdate({
          target: skills.slug,
          set: {
            title: input.title,
            summary: input.summary,
            instructions: input.instructions,
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "skill",
        targetId: input.slug,
        payload: {
          actor: input.by,
          change: "skill_installed",
          skill: input.slug,
        },
      });
    },

    async uninstallSkill(slug: string, by: string): Promise<void> {
      await database.delete(skills).where(eq(skills.slug, slug));
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "skill",
        targetId: slug,
        payload: { actor: by, change: "skill_uninstalled", skill: slug },
      });
    },

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
        targetType: kind === "mcp" ? "mcp_tool" : "skill",
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
        targetType: kind === "mcp" ? "mcp_tool" : "skill",
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

      const toolRows =
        toolRefs.length === 0
          ? []
          : await database.select().from(mcpTools).orderBy(asc(mcpTools.name));
      const grantedTools = toolRows
        .filter((row) => toolRefs.includes(`${row.serverId}/${row.name}`))
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

      return {
        tools: grantedTools,
        skills: skillRows.map((row) => ({
          slug: row.slug,
          title: row.title,
          summary: row.summary,
          instructions: row.instructions,
        })),
      };
    },

    /**
     * May this Bot use this plugin?
     *
     * The single question every caller asks, so there is one place the answer is decided and one
     * place to audit it. A missing row is a refusal, not an oversight.
     */
    async decide(
      kind: PluginKind,
      ref: string,
      agentId: string,
    ): Promise<PluginDecision> {
      const [row] = await database
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, kind),
            eq(pluginGrants.ref, ref),
            eq(pluginGrants.agentId, agentId),
          ),
        )
        .limit(1);

      if (!row) {
        return {
          allowed: false,
          reason:
            kind === "mcp"
              ? `This Bot has not been given the tool ${ref}.`
              : `This Bot has not been given the skill ${ref}.`,
        };
      }
      return { allowed: true };
    },

    /**
     * Call a tool on somebody else's server, on a Bot's behalf.
     *
     * Decide, record, then act, which is the order the computer gateway uses and for the same
     * reason: a call that was permitted and then failed is exactly what an investigation needs to
     * see, and a trail written only on success cannot show it. The grant is checked first because a
     * tool this Bot was never given should not reach the policy engine, the vault or the network.
     */
    async callTool(input: {
      ref: string;
      args: Record<string, unknown>;
      botId: string;
      actorId: string;
      /**
       * An answer a person already gave, presented for the call it was given for.
       *
       * The same contract the acting routes on the computer have, and for the same reason: the id
       * alone proves nothing, it is the id together with the fingerprint of the call actually being
       * made that means anything.
       */
      approvalId?: string | undefined;
    }): Promise<{ text: string; isError: boolean }> {
      const [serverId, ...rest] = input.ref.split("/");
      const toolName = rest.join("/");
      if (!serverId || !toolName) {
        throw new PluginRefusedError(`${input.ref} is not a tool.`, null);
      }

      const decision = await this.decide("mcp", input.ref, input.botId);
      if (!decision.allowed) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          payload: {
            actor: input.actorId,
            bot: input.botId,
            server: serverId,
            tool: toolName,
            refusal: "not_granted",
            reason: decision.reason,
          },
        });
        throw new PluginRefusedError(decision.reason, null);
      }

      const { row, entry } = await requireServer(serverId);

      const advertised = await database
        .select({ name: mcpTools.name, inputSchema: mcpTools.inputSchema })
        .from(mcpTools)
        .where(
          and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
        )
        .limit(1);

      const effect = classifyTool(entry, toolName, advertised.length > 0);

      const args = withoutEmptyOptionals(
        input.args,
        advertised[0]?.inputSchema as Record<string, unknown> | undefined,
      );

      /**
       * The same policy the computer actions are judged by, asked about a tool call.
       *
       * Every field is present, including the ones a tool call has no use for, and that is load
       * bearing rather than tidy. This engine treats an expression it cannot evaluate as a match,
       * which is correct for a browser action on an element the server could not resolve. Applied to
       * a tool call it is a disaster: the boundary this product ships in `.env.example` denies
       * `contains(element.name, "submit") || key == "Enter"`, and with `element` and `key` absent
       * that rule is unevaluable, so it would match, so every deployment using the shipped preset
       * would refuse every MCP call for a reason mentioning a submit button.
       *
       * Neutral values instead. Empty strings match no substring, no key and no extension, and
       * `submit` is false because a tool call submits no form, so a rule written about the browser
       * evaluates to false against a tool call, which is the honest answer: a tool call did not click
       * anything. A rule meant to catch tool calls says so, with `mcp` or with `intent`.
       *
       * The blanks are for the policy engine and never for a person: the sentence a question is
       * phrased in reads them as absent rather than as an empty file path, or somebody would be
       * asked to approve "The Bot wants to call ."
       */
      const context: PolicyContext = {
        tool: { name: toolNameFor(input.ref) },
        bot: { id: input.botId },
        actor: { id: input.actorId },
        page: { url: "", host: "" },
        // One, for the same reason as the empty strings, and with a cost worth naming: repetition is
        // counted by the computer gateway, and nothing counts a Bot calling the same MCP tool over
        // and over. A rule about repetition is therefore false here rather than unevaluable, which
        // keeps a browser rule from refusing every tool call, and leaves a Bot looping through
        // somebody else's server as a gap this deployment cannot yet see.
        repeat: { count: 1 },
        element: { ref: "", role: "", name: "", type: "" },
        key: "",
        submit: false,
        file: { path: "", name: "", extension: "" },
        intent: effect === "write" ? "write_tool" : "read_tool",
        mcp: { server: serverId, tool: toolName, effect },
      };

      const verdict = evaluateActionPolicy(options.policy(), context);

      /**
       * The third answer, handled here as well as on the computer.
       *
       * An `ask` verdict is `forward: false` in enforce mode, so a call site that knows only about
       * yes and no reads it as a refusal, and the list an operator wrote to be asked about silently
       * becomes a list of things their Bots may never do. That is the exact failure the ask list
       * exists to prevent, and it is worse here than it looks: the boundary editor and the shipped
       * configuration both offer `ask` as a general third list, and "ask me before anything changes
       * anything in Jira" is the first rule most deployments reach for.
       *
       * So the same shape as the gateway: spend an approval that fits this exact call, or open the
       * question and stop. Nothing is recorded as succeeded or rejected in the second case, because
       * neither happened yet.
       */
      const approved =
        verdict.source === "ask" && !verdict.forward
          ? await askAbout({
              approvalId: input.approvalId,
              botId: input.botId,
              actorId: input.actorId,
              ref: input.ref,
              serverId,
              toolName,
              effect,
              args,
              rule: verdict.matched ?? "",
              question: verdict.reason,
            })
          : undefined;

      // What the boundary settled on once a person's answer is folded in. The source stays `ask`, so
      // the row reads as "allowed, because somebody was asked and said yes" rather than as an
      // ordinary permission nobody ever questioned.
      const carriedOut = verdict.forward || approved !== undefined;

      await recordAuditEvent(auditStore, {
        eventType: carriedOut ? "mcp.call_succeeded" : "mcp.call_rejected",
        targetType: "mcp_tool",
        targetId: input.ref,
        payload: {
          actor: input.actorId,
          bot: input.botId,
          server: serverId,
          tool: toolName,
          effect,
          decision: {
            allowed: verdict.allowed || approved !== undefined,
            mode: verdict.mode,
            rule: verdict.matched,
            source: verdict.source,
            carriedOut,
            ...(approved ? { approvedBy: approved } : {}),
          },
        },
      });

      if (!carriedOut) {
        throw new PluginRefusedError(verdict.reason, verdict.matched);
      }

      const token = await tokenFor(row.credentialId);
      const result = await callRemoteTool(
        { url: row.url, token },
        toolName,
        args,
      );
      return { text: result.text, isError: result.isError };
    },
  };
}

/**
 * Optional arguments the model filled in with an empty string, removed.
 *
 * A model handed a schema with many optional fields tends to fill them all, and where it has no
 * value it writes "". Vendors reject that: an empty string is not a channel id, not a timestamp and
 * not a cursor, so the call fails with a validation error that reads to the person as the tool being
 * broken.
 *
 * Only optional fields, and only empty strings. A required field left empty is the model getting it
 * wrong, and the vendor should say so rather than have us hide it. Anything other than "" is a value
 * the model meant, including false and 0.
 */
function withoutEmptyOptionals(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const required = new Set(
    Array.isArray(schema?.required) ? (schema.required as string[]) : [],
  );
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) => required.has(key) || value !== "",
    ),
  );
}

export type PluginStore = ReturnType<typeof createPluginStore>;
export type { CatalogueEntry };
