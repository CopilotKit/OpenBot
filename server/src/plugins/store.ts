import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
} from "../computer/policy";
import {
  type CredentialSecretReader,
  type CredentialStore,
  decryptCredentialForUse,
  encryptSecret,
} from "../credentials";
import type { Database } from "../db/client";
import {
  agentProfiles,
  // Aliased: `credentials` is already the injected vault interface in this module, and the table and
  // the interface are two different things to reach for.
  credentials as credentialRows,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
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
import { McpServerError } from "./mcp";
import { transportFor } from "./transport";

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

/**
 * Whose credential reaches this server, as the trail names it.
 *
 * One definition, because this was two: `connectionTokenFor` returned it and the audit payload
 * recomputed the same condition a few lines later. Two expressions for one fact can disagree, and
 * the one place that would show is an audit row claiming a call ran as somebody it did not — which is
 * the row a per-person connector exists to be able to trust.
 *
 * `deployment` for a shared token; the asker's own id for a server reached as the person asking.
 */
const reachedAsFor = (entry: CatalogueEntry | null, actorId: string): string =>
  entry?.auth.kind === "user-oauth" ? actorId : "deployment";

/**
 * Where this server actually is, when the stored row and the catalogue disagree.
 *
 * `mcp_servers.url` is written once, when a server is added, by copying what the catalogue said at
 * the time. That makes it a cache of a reviewed decision — and a cache nothing invalidates. Moving
 * Google Drive from its preview MCP host to its GA REST host changed the catalogue and left every
 * deployment that had already added Drive calling the old address, with no way to tell from any
 * screen: the row looks exactly as intentional as it did the day it was written.
 *
 * So for an entry with a PINNED host, the catalogue wins. It is the reviewed source contract, and a
 * host it no longer names is a host this deployment has decided not to talk to. Editing the
 * catalogue is the act of changing where a first-party server is, and it should take effect.
 *
 * The stored value still wins for the two cases where it is the only truth: a custom server an
 * administrator added by URL, which has no entry at all, and a per-instance vendor whose `host` is
 * null because the customer's own hostname is the answer.
 */
function effectiveUrl(
  row: { id: string; url: string },
  entry: CatalogueEntry | null,
): string {
  if (!entry || entry.host === null) return row.url;
  return resolveServerUrl(row.id)?.url ?? row.url;
}

/**
 * Trade a refresh token for a short-lived access token, at the vendor's own token endpoint.
 *
 * `tokenUrl` comes from the catalogue entry and never from a caller, for the same reason the MCP
 * host does not: this request carries the deployment's client secret and somebody's refresh token,
 * so where it goes is a reviewed decision rather than a runtime one.
 *
 * The vendor's error body is deliberately not passed through. It is written for whoever registered
 * the client, not for the person who asked a Bot a question, and it can name the client id.
 */
async function exchangeRefreshTokenOverHttp(input: {
  tokenUrl: string;
  client: OAuthClient;
  refreshToken: string;
}): Promise<AccessToken> {
  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new McpServerError(
      `The vendor would not renew this access (${response.status}).`,
    );
  }

  const body = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new McpServerError("The vendor renewed this access with no token.");
  }
  return {
    accessToken: body.access_token,
    expiresInSeconds:
      typeof body.expires_in === "number" ? body.expires_in : undefined,
  };
}

/** How long a vendor's token endpoint gets. Shorter than a call: it is one round trip, or nothing. */
const TOKEN_TIMEOUT_MS = 10_000;

/**
 * The deployment's OAuth client for one vendor, as it is held in the vault.
 *
 * Both halves live in the encrypted value rather than the id sitting in `metadata` and the secret
 * here. One read gets a usable client, which keeps {@link CredentialSecretReader} the only vault
 * interface this module needs. The id is also copied into `metadata` for the credentials page to
 * show — a deliberate duplication of something that is not a secret, so that a screen listing what
 * the deployment holds does not have to decrypt anything to name it.
 */
export type OAuthClient = { clientId: string; clientSecret: string };

/** What a vendor's token endpoint gave back for a refresh token. */
export type AccessToken = { accessToken: string; expiresInSeconds?: number };

export type PluginStoreOptions = {
  database: Database;
  auditStore: AuditStore;
  /**
   * The vault, read and write.
   *
   * Writing is here rather than left to the browser posting `/api/admin/credentials` first. An OAuth
   * client belongs to the server registration and a refresh token belongs to a connection, so both
   * are written by the code that owns those acts — otherwise the first of two calls can succeed and
   * the second fail, leaving a secret in the vault that nothing points at and nobody knows to revoke.
   */
  credentials: CredentialSecretReader & CredentialStore;
  encryptionKey: string;
  /** Read at call time, never captured, so a policy changed a moment ago applies to this call. */
  policy: () => ActionPolicy;
  /**
   * Speaking MCP to the vendor. Defaults to the real client.
   *
   * Injected so a test can assert what a call was about to go out with. Whose credential is chosen
   * is the security property of this module, and asserting it otherwise needs a vendor to be
   * reachable, which means the property most worth testing would be the one thing never tested.
   */
  callVendor?: (
    connection: { url: string; token?: string },
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }>;
  /** Trading a refresh token for a short-lived access token. Defaults to a real HTTP exchange. */
  exchangeRefreshToken?: (input: {
    tokenUrl: string;
    client: OAuthClient;
    refreshToken: string;
  }) => Promise<AccessToken>;
};

export function createPluginStore(options: PluginStoreOptions) {
  const { database, auditStore, credentials, encryptionKey } = options;
  /*
   * Held rather than resolved, because the transport is a property of the entry and is not known
   * until a call names one. An injected vendor still wins over both, which is what keeps a test able
   * to assert what a call was about to go out with.
   */
  const injectedVendor = options.callVendor;
  const exchangeRefreshToken =
    options.exchangeRefreshToken ?? exchangeRefreshTokenOverHttp;

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

  /**
   * A credential out of the vault, decrypted for one call and never held.
   *
   * A revoked credential is turned into a refusal rather than left as the vault's thrown error. The
   * two reach a person very differently: an error becomes "that tool could not be called", which is
   * what a vendor being down looks like, while a withdrawn grant is nobody's fault and has an
   * obvious next step. `reconnect` says which of the two to name.
   */
  async function secretFor(
    credentialId: string,
    onRevoked: string,
  ): Promise<string> {
    try {
      return await decryptCredentialForUse(
        encryptionKey,
        credentials,
        credentialId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("revoked") || message.includes("not found")) {
        throw new PluginRefusedError(onRevoked, null);
      }
      throw error;
    }
  }

  /**
   * The token one call goes out with, and whose it is.
   *
   * For a `deployment-bearer` server this is what it always was: the one credential an administrator
   * gave the server, used for everybody.
   *
   * For a `user-oauth` server it is the asker's own, and every branch that cannot prove it has the
   * asker's grant refuses. There is deliberately no fallback. A fallback is the one bug this design
   * exists to make impossible: answering out of whatever the deployment, or the last person to
   * connect, happened to be able to see — which returns a confident answer assembled from documents
   * the person asking cannot open, and looks exactly like a correct answer.
   *
   * Nothing is cached. The refresh token is exchanged for an access token per call and the access
   * token is thrown away, so there is no stored copy of anybody's access for a disconnect to have to
   * find. That costs a round trip to the vendor's token endpoint on every call, which is the price
   * of revocation being complete by construction rather than by cleanup.
   */
  async function connectionTokenFor(
    row: { id: string; url: string; credentialId: string | null },
    entry: CatalogueEntry | null,
    actorId: string,
  ): Promise<{ token?: string }> {
    if (entry?.auth.kind !== "user-oauth") {
      const token = row.credentialId
        ? await secretFor(
            row.credentialId,
            `${row.id} needs a credential this deployment no longer holds. An administrator has to add it again.`,
          )
        : undefined;
      return { token };
    }

    /*
     * The anonymous actor is the empty string, and an empty string must never match a row.
     *
     * `identifyActor` answers with `{ id: "" }` when it cannot resolve who is asking. Letting that
     * reach the lookup would mean a run nobody can be held accountable for picking up whichever
     * grant sorted first, so it is refused before the query rather than trusted to miss.
     */
    if (!actorId) {
      throw new PluginRefusedError(
        `${row.id} answers as the person asking, and this run is not attributed to anybody.`,
        null,
      );
    }

    const [held] = await database
      .select({ credentialId: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, row.id),
          eq(mcpUserCredentials.userId, actorId),
        ),
      )
      .limit(1);

    if (!held) {
      throw new PluginRefusedError(
        `You have not connected your ${entry.title} account. Connect it in Settings and ask again.`,
        null,
      );
    }

    const refreshToken = await secretFor(
      held.credentialId,
      `Your ${entry.title} access was withdrawn. Connect it again in Settings.`,
    );

    if (!row.credentialId) {
      // The person did their part; the deployment has not. Said plainly, because the person cannot
      // fix it and should not be told to try.
      throw new PluginRefusedError(
        `${entry.title} has no OAuth client registered for this deployment, so this cannot be called. An administrator has to add one.`,
        null,
      );
    }
    const client = JSON.parse(
      await secretFor(
        row.credentialId,
        `${entry.title} has no usable OAuth client for this deployment. An administrator has to add one again.`,
      ),
    ) as OAuthClient;

    const minted = await exchangeRefreshToken({
      tokenUrl: entry.auth.tokenUrl,
      client,
      refreshToken,
    });
    return { token: minted.accessToken };
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
     *
     * `actorId` is who is asking, and whether it is needed at all is the transport's answer rather
     * than an assumption here. Where listing means asking a remote server — MCP — a `user-oauth`
     * vendor has no deployment credential to ask with, so the listing runs on the grant of whoever
     * pressed refresh, and an administrator who has not connected gets a refusal that lands in
     * `lastError`. That is the honest state: until somebody has connected, this deployment genuinely
     * does not know what that server offers.
     *
     * Where the tool list is this deployment's own code, nothing is asked and no credential is
     * consulted. Requiring one anyway is what made setting Drive up a round trip through an
     * administrator's personal settings page for a token that was then discarded.
     *
     * Absent for the refresh that happens right after a server is added, where nobody can have
     * connected yet. It makes no difference to a `deployment-bearer` server, which never consults it.
     */
    async refreshTools(
      serverId: string,
      actorId = "",
    ): Promise<{ tools: number }> {
      const { row, entry } = await requireServer(serverId);

      try {
        // The entry decides the protocol. For a custom server there is no entry, and MCP is right.
        const transport = transportFor(entry);

        /*
         * A credential only when listing actually needs one.
         *
         * Where it is needed, it is taken from the same selection the call path uses rather than by
         * decrypting `row.credentialId` — which is what this used to do, and which for a `user-oauth`
         * server would have sent the deployment's OAuth client secret to the vendor as somebody's
         * access token. One answer to "what token does this server get", and it cannot be a secret of
         * the wrong kind.
         *
         * Where it is NOT needed, asking anyway is not a harmless extra check. For a `user-oauth`
         * server that call refuses unless the person pressing the button has connected their own
         * account — so an administrator setting Drive up was blocked at "refresh tools" and sent to
         * their personal settings page to grant access, so that a token could be minted and handed to
         * a function that discards it. The gate outlived the reason for it.
         */
        const token = transport.listNeedsCredential
          ? (await connectionTokenFor(row, entry, actorId)).token
          : undefined;

        const tools = await transport.listTools({
          url: effectiveUrl(row, entry),
          token,
        });

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
          url: effectiveUrl(row, entry),
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
     * Register the deployment's OAuth client for a `user-oauth` server.
     *
     * Both halves go into one encrypted value, so a single vault read yields a usable client. The id
     * is copied into `metadata` as well — it is not a secret, and a page listing what the deployment
     * holds should be able to name it without decrypting anything.
     *
     * Replacing a client revokes the previous one rather than orphaning it, so "what does this
     * deployment hold" keeps having one answer per server. Nobody's connection breaks: a refresh
     * token is the person's, and it is the client that is being rotated underneath it.
     */
    async registerOAuthClient(input: {
      serverId: string;
      client: OAuthClient;
      by: string;
    }): Promise<void> {
      const { row, entry } = await requireServer(input.serverId);
      if (entry?.auth.kind !== "user-oauth") {
        throw new CustomServerRefusedError(
          `${input.serverId} is not reached with an OAuth client.`,
        );
      }

      const stored = await credentials.create({
        kind: "mcp_oauth_client",
        provider: input.serverId,
        keyId: `oauth-client-${input.serverId}`,
        metadata: { server: input.serverId, clientId: input.client.clientId },
        encryptedValue: await encryptSecret(
          encryptionKey,
          JSON.stringify(input.client),
        ),
      });

      await database
        .update(mcpServers)
        .set({ credentialId: stored.id, updatedAt: new Date() })
        .where(eq(mcpServers.id, input.serverId));

      if (row.credentialId) {
        await credentials.revoke(row.credentialId).catch(() => {
          // A previous client that cannot be revoked must not stop the new one taking effect. The
          // pointer has already moved, so nothing reaches the old row; it is a tidiness failure.
        });
      }

      await recordAuditEvent(auditStore, {
        eventType: "mcp.oauth_client_registered",
        targetType: "mcp_server",
        targetId: input.serverId,
        payload: {
          actor: input.by,
          server: input.serverId,
          // The id, never the secret. It identifies the client an administrator registered, which is
          // what somebody reading the trail needs in order to check it against the vendor's console.
          clientId: input.client.clientId,
          replaced: row.credentialId !== null,
        },
      });
    },

    /**
     * Record that one person connected their own account to one server.
     *
     * Upserted on the pair, so reconnecting replaces rather than accumulating. The credential the row
     * used to point at is revoked in the same breath: a refresh token nothing points at is still a
     * live grant at the vendor, and leaving it behind would mean a person who reconnected had two
     * valid grants and could only ever see one of them to disconnect it.
     */
    async recordConnection(input: {
      serverId: string;
      userId: string;
      refreshToken: string;
      scope: string;
    }): Promise<void> {
      const [previous] = await database
        .select({ credentialId: mcpUserCredentials.credentialId })
        .from(mcpUserCredentials)
        .where(
          and(
            eq(mcpUserCredentials.serverId, input.serverId),
            eq(mcpUserCredentials.userId, input.userId),
          ),
        )
        .limit(1);

      const stored = await credentials.create({
        kind: "mcp_user_token",
        provider: input.serverId,
        keyId: input.userId,
        metadata: { server: input.serverId, scope: input.scope },
        encryptedValue: await encryptSecret(encryptionKey, input.refreshToken),
      });

      await database
        .insert(mcpUserCredentials)
        .values({
          serverId: input.serverId,
          userId: input.userId,
          credentialId: stored.id,
          scope: input.scope,
        })
        .onConflictDoUpdate({
          target: [mcpUserCredentials.serverId, mcpUserCredentials.userId],
          set: {
            credentialId: stored.id,
            scope: input.scope,
            updatedAt: new Date(),
          },
        });

      if (previous) {
        await credentials.revoke(previous.credentialId).catch(() => {
          // Same reasoning as above: the pointer has moved, so this is tidiness rather than access.
        });
      }

      await recordAuditEvent(auditStore, {
        eventType: "mcp.account_connected",
        targetType: "mcp_server",
        targetId: input.serverId,
        payload: {
          actor: input.userId,
          server: input.serverId,
          // What the vendor granted, so a later refusal for want of a scope can be explained.
          scope: input.scope,
          reconnected: previous !== undefined,
        },
      });
    },

    /**
     * The deployment's OAuth client for a server, or null if none is registered.
     *
     * Decrypted, because both halves are needed: the id to build a consent URL and the secret to
     * redeem the code it comes back with. Held for the length of one request, like every other
     * secret this module reads.
     */
    async oauthClientFor(serverId: string): Promise<OAuthClient | null> {
      const [row] = await database
        .select({ credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
        .limit(1);
      if (!row?.credentialId) return null;

      try {
        return JSON.parse(
          await decryptCredentialForUse(
            encryptionKey,
            credentials,
            row.credentialId,
          ),
        ) as OAuthClient;
      } catch {
        // A revoked, missing or unreadable client is the same as none for every caller: there is
        // nothing to send anybody to consent with, and the answer is for an administrator to add one.
        return null;
      }
    },

    /** Which `user-oauth` servers this person has connected, for their own settings page. */
    async connectionsFor(
      userId: string,
    ): Promise<{ serverId: string; scope: string; connectedAt: string }[]> {
      const rows = await database
        .select({
          serverId: mcpUserCredentials.serverId,
          scope: mcpUserCredentials.scope,
          connectedAt: mcpUserCredentials.connectedAt,
        })
        .from(mcpUserCredentials)
        .where(eq(mcpUserCredentials.userId, userId))
        .orderBy(asc(mcpUserCredentials.serverId));

      return rows.map((row) => ({
        serverId: row.serverId,
        scope: row.scope,
        connectedAt: iso(row.connectedAt) ?? "",
      }));
    },

    /**
     * Retire every connector credential belonging to one person.
     *
     * WHAT THIS IS FOR. "We removed their access" has to be true of the thing that matters, which is
     * the refresh token sitting at the vendor. Removing somebody from the People screen used to end
     * their sessions and add them to the deny list, and leave their Google grant entirely intact in
     * this deployment's vault. They could not exercise it — the actor comes from a session they no
     * longer get — but the deployment still held a usable secret for a person who had been removed,
     * which is not what an administrator was told they did, and is the first thing a customer asks
     * about a per-person connector.
     *
     * LOOKED UP IN THE VAULT, NOT THROUGH THE JOIN TABLE. `mcp_user_credentials.user_id` cascades on
     * a user row being deleted, so by the time somebody is gone the join row can be gone too and the
     * credential is orphaned: unrevoked, referenced by nothing, reachable from no screen and by no
     * code path. `credentials.key_id` holds the user id for an `mcp_user_token`, so the vault can
     * still be asked directly — which makes this work for the person who was removed and for the one
     * whose row was deleted underneath it.
     *
     * The join rows go too, so the account pages stop claiming a connection this deployment can no
     * longer use.
     *
     * NOT vendor-side revocation. That needs the OAuth client and the vendor's revoke endpoint, and
     * it belongs with disconnect. This is the half that stops us holding the secret; the grant at
     * Google outlives it until somebody revokes it there. Said plainly rather than implied, because
     * the difference matters to whoever has to answer for it.
     */
    async retireConnectionsFor(
      userId: string,
      by: string,
    ): Promise<{ retired: number }> {
      if (!userId) return { retired: 0 };

      const owned = await database
        .select({
          id: credentialRows.id,
          provider: credentialRows.provider,
          revokedAt: credentialRows.revokedAt,
        })
        .from(credentialRows)
        .where(
          and(
            eq(credentialRows.kind, "mcp_user_token"),
            eq(credentialRows.keyId, userId),
          ),
        );

      let retired = 0;
      for (const credential of owned) {
        // Already revoked is not a failure. Retiring twice is something an administrator can
        // legitimately do, and the second time should be quiet rather than an error.
        if (credential.revokedAt) continue;
        await credentials.revoke(credential.id);
        retired += 1;
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_disconnected",
          targetType: "mcp_server",
          targetId: credential.provider,
          payload: {
            actor: by,
            server: credential.provider,
            owner: userId,
            /*
             * Why, because the two reasons are not the same event to a reader. Somebody disconnecting
             * their own account is a person changing their mind; an administrator removing somebody
             * is an offboarding, and an auditor asking "what happened to their access" wants to see
             * which one this was.
             */
            reason: "person_removed",
            vendorRevoked: false,
          },
        });
      }

      await database
        .delete(mcpUserCredentials)
        .where(eq(mcpUserCredentials.userId, userId));

      return { retired };
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
       * Neutral values instead. Empty strings match no substring, no key and no extension, so a rule
       * written about the browser evaluates to false against a tool call, which is the honest answer:
       * a tool call did not click anything. A rule meant to catch tool calls says so, with `mcp` or
       * with `intent`.
       */
      const context: PolicyContext = {
        tool: { name: toolNameFor(input.ref) },
        bot: { id: input.botId },
        actor: { id: input.actorId },
        page: { url: "", host: "" },
        element: { ref: "", role: "", name: "", type: "" },
        key: "",
        file: { path: "", name: "", extension: "" },
        intent: effect === "write" ? "write_tool" : "read_tool",
        mcp: { server: serverId, tool: toolName, effect },
      };

      const verdict = evaluateActionPolicy(options.policy(), context);

      /*
       * The parts of the row that are known before the attempt, held rather than written.
       *
       * Everything here is a fact about the decision, and the decision is final at this point. What
       * is NOT yet known is whether the call worked, which is why this is a variable and not a write:
       * the row goes down once, after the outcome exists.
       */
      const decided = {
        actor: input.actorId,
        bot: input.botId,
        server: serverId,
        tool: toolName,
        effect,
        /*
         * Whose credential this call goes out with.
         *
         * Without it the trail cannot answer "who did this run reach as", which is the whole question
         * a per-person connector raises — two rows for the same tool and the same Bot can legitimately
         * have seen entirely different documents, and nothing else in the row says why.
         */
        reachedAs: reachedAsFor(entry, input.actorId),
        decision: {
          allowed: verdict.allowed,
          mode: verdict.mode,
          rule: verdict.matched,
          source: verdict.source,
          carriedOut: verdict.forward,
        },
      };

      /*
       * A refusal is written here, because there is no attempt to wait for.
       *
       * This deployment declining is the whole event, and it is recorded before the throw so that a
       * refusal cannot be lost by the caller's error handling.
       */
      if (!verdict.forward) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          payload: decided,
        });
        throw new PluginRefusedError(verdict.reason, verdict.matched);
      }

      /*
       * Attempt first, record second.
       *
       * The row now says what HAPPENED rather than what was permitted. It used to be written here,
       * before the two lines below, which meant a call that died at the vendor left `call_succeeded`
       * behind it — and a per-person connector fails at exactly these two lines: no connection for
       * the asker, a refresh token the vendor no longer accepts, an API not enabled for the project.
       * Every one of those was invisible, and worse than invisible, because the trail asserted the
       * opposite.
       *
       * `isError` counts as a failure. A vendor that answers the protocol correctly to say the tool
       * itself failed has not completed the call, and a reader counting successes should not be told
       * it did.
       */
      try {
        const { token } = await connectionTokenFor(row, entry, input.actorId);
        const vendor = injectedVendor ?? transportFor(entry).callTool;
        const result = await vendor(
          { url: effectiveUrl(row, entry), token },
          toolName,
          args,
        );
        await recordAuditEvent(auditStore, {
          eventType: result.isError ? "mcp.call_failed" : "mcp.call_succeeded",
          targetType: "mcp_tool",
          targetId: input.ref,
          /*
           * The vendor's own words, when it is reporting a failure.
           *
           * Only on the failure branch, and this is the whole point of the distinction. A successful
           * result is somebody's data — a file listing, a document — and it has no business in an
           * audit row that an administrator can read. An `isError` result is a message written for
           * whoever operates this deployment, and it is the most useful sentence available: Google
           * refuses the Drive MCP server with "The caller does not have permission", which named the
           * problem after a generic message had already cost a round of probing.
           *
           * Capped, because the failure branch is not a promise about length.
           */
          payload: result.isError
            ? {
                ...decided,
                failure:
                  result.text.slice(0, 400) || "the tool reported an error",
              }
            : decided,
        });
        return { text: result.text, isError: result.isError };
      } catch (error) {
        /*
         * Recorded, then rethrown unchanged. The caller's behaviour is unaffected — what changes is
         * that the failure now exists in the trail, which is where somebody asking "is this connector
         * working" looks. The vendor's own sentence is kept, since for a 403 that is the sentence
         * naming which API is not enabled.
         */
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_failed",
          targetType: "mcp_tool",
          targetId: input.ref,
          payload: {
            ...decided,
            failure: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
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
