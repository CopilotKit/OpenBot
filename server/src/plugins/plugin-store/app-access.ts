import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { type AuditEventInput, recordAuditEvent } from "../../audit";
import {
  agents,
  appAccessRequests,
  brokeredConnections,
  credentials as credentialRows,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../../db/schema";
import {
  type AppAccess,
  type AppAccessFacts,
  type AppAccessRequestKind,
  type AppProvider,
  accountOf,
  appAccessState,
  connectOf,
  REQUEST_KIND_FOR,
  type Unavailable,
  unavailableReason,
} from "../app-access";
import type { BrokerApp } from "../broker";
import { CATALOGUE, type CatalogueEntry, catalogueEntry } from "../catalogue";
import { toolkitOf } from "../composio";
import type { StoreContext } from "./context";
import { iso } from "./model";

/**
 * One app as this module resolves it before anybody's connection is asked about: which rows are
 * it, which of them answers for it, and what the deployment holds for it.
 *
 * `rowIds` IS EVERY ROW THAT IS THIS APP, so a grant made through a duplicate row at a Composio
 * app's url counts as holding the app — the same "the apps, not the rows" rule
 * `sharedAppsHeldBy` follows. `answeringId` is the one row whose columns decide, and the one a
 * grant made by approving a request is written against.
 */
type AppCandidate = {
  key: string;
  title: string;
  logo: string | null;
  provider: AppProvider;
  present: boolean;
  answeringId: string | null;
  rowIds: string[];
  toolkit: string | null;
  entry: CatalogueEntry | null;
  authScheme: string | null;
  accountMode: "personal" | "shared" | null;
  hasCredential: boolean;
};

type ServerRow = {
  id: string;
  title: string;
  logo: string | null;
  url: string;
  provenance: string;
  authScheme: string | null;
  accountMode: "personal" | "shared" | null;
  credentialId: string | null;
};

/** The directory, asked only to name an app this deployment has no row for. */
export type AppDirectory = () => Promise<BrokerApp[]>;

/** What one app is for the deployment and, where a person was named, for them. */
export type AppInspection = {
  access: AppAccess;
  /** Why nobody can use it yet, as {@link unavailableReason} answers; null when somebody can. */
  unavailable: Unavailable | null;
  /** The row a grant is written against, and null for an app with no row. */
  answeringId: string | null;
  /** The Composio app, for a brokered one. */
  toolkit: string | null;
  /** The catalogue entry, for an app this deployment ships. */
  entry: CatalogueEntry | null;
  /** Whether the Shared team account is connected and its key was not refused. */
  sharedUsable: boolean;
};

export type AppAccessRequestStatus =
  | "pending"
  | "approved"
  | "dismissed"
  | "cancelled";

/** A request as the person who filed it and the administrator answering it both read it. */
export type AppAccessRequestRecord = {
  id: string;
  appKey: string;
  appTitle: string;
  kind: AppAccessRequestKind;
  status: AppAccessRequestStatus;
  agentId: string | null;
  /** The Bot's name, or null for a request about the app alone. */
  botName: string | null;
  /** Who asked. Shown to an administrator because they asked; nothing about their connections is. */
  requestedBy: string;
  requesterEmail: string | null;
  requesterName: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

const SLUG_OF_ID = /^composio-/;

/**
 * Per-person, per-Bot status of the work apps a Bot holds, and the requests a person files when
 * only an administrator can change it. See `../app-access.ts` for the rule itself.
 */
export function appAccessMethods(context: StoreContext) {
  const { database, auditStore, brokeredAppRowsAt } = context;

  /*
   * EVERY ROW, ONCE. `mcp_servers` is the deployment's list of apps — tens of rows, not thousands —
   * and every question below is about which of them are one app. Reading the table once and
   * grouping it here costs one query; asking per app would cost one per app and per duplicate.
   * Ordered by id so the grouping meets rows in the order the answering rule names them.
   */
  async function allRows(): Promise<ServerRow[]> {
    return database
      .select({
        id: mcpServers.id,
        title: mcpServers.title,
        logo: mcpServers.logo,
        url: mcpServers.url,
        provenance: mcpServers.provenance,
        authScheme: mcpServers.authScheme,
        accountMode: mcpServers.accountMode,
        credentialId: mcpServers.credentialId,
      })
      .from(mcpServers)
      .orderBy(asc(mcpServers.id));
  }

  /**
   * The rows grouped into apps, keyed by every row id, so a grant's server half finds its app.
   *
   * A BROKERED APP IS ITS ANSWERING ROW, whichever row a grant names: the id, title, scheme and
   * mode all come off the row {@link brokeredAppRowsAt} names for the app's canonical url — the one
   * rule every brokered reader in the store answers by. A brokered row with no row at the
   * canonical url is an app of its own whose scheme nobody recorded, which the state reads as
   * switched off; the gate refuses such a row too.
   */
  async function appsByRow(rows: ServerRow[]) {
    const toolkitOfRow = new Map<string, string>();
    for (const row of rows) {
      const toolkit = row.provenance === "composio" ? toolkitOf(row.url) : null;
      if (toolkit && !catalogueEntry(row.id)) toolkitOfRow.set(row.id, toolkit);
    }
    const answering = await brokeredAppRowsAt([
      ...new Set([...toolkitOfRow.values()].map((t) => `composio://${t}`)),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const apps = new Map<string, AppCandidate>();
    const byRow = new Map<string, AppCandidate>();

    for (const row of rows) {
      const toolkit = toolkitOfRow.get(row.id) ?? null;
      const head = toolkit ? answering.get(`composio://${toolkit}`) : undefined;
      const key = head?.id ?? row.id;
      let app = apps.get(key);
      if (!app) {
        const source = byId.get(key) ?? row;
        const entry = toolkit ? null : catalogueEntry(row.id);
        app = {
          key,
          title: entry?.title ?? source.title,
          logo: source.logo,
          provider: toolkit ? "composio" : entry ? "catalogue" : "custom",
          present: true,
          answeringId: key,
          rowIds: [],
          toolkit,
          entry,
          authScheme: toolkit ? (head?.authScheme ?? null) : source.authScheme,
          accountMode: toolkit ? (head?.accountMode ?? null) : null,
          hasCredential: source.credentialId !== null,
        };
        apps.set(key, app);
      }
      app.rowIds.push(row.id);
      byRow.set(row.id, app);
    }
    return byRow;
  }

  /**
   * An app with no row: a catalogue entry nobody added, or a Composio app nobody enabled.
   *
   * `key` is the id enabling it would mint — the entry's key, or `composio-<slug>` as
   * `addBrokeredApp` names a row — so a request filed now names the row the approval creates.
   */
  function absent(input: {
    key: string;
    title: string;
    logo?: string | null;
    provider: AppProvider;
    toolkit?: string | null;
    entry?: CatalogueEntry | null;
  }): AppCandidate {
    return {
      key: input.key,
      title: input.title,
      logo: input.logo ?? null,
      provider: input.provider,
      present: false,
      answeringId: null,
      rowIds: [],
      toolkit: input.toolkit ?? null,
      entry: input.entry ?? null,
      authScheme: null,
      accountMode: null,
      hasCredential: false,
    };
  }

  /*
   * THE DIRECTORY IS ASKED ONLY FOR AN APP THIS DEPLOYMENT HAS NO ROW FOR, and its failure is an
   * absence rather than an error: it is the one read here that leaves this process, it is cached by
   * the adapter, and a vendor that will not answer leaves an app unnamed rather than a page that
   * cannot load.
   */
  async function readDirectory(directory: AppDirectory | undefined) {
    if (!directory) return null;
    try {
      return await directory();
    } catch {
      return null;
    }
  }

  /** A key with no row, named as well as the deployment can name it. */
  async function absentFor(
    key: string,
    directory: AppDirectory | undefined,
    listed: BrokerApp[] | null | undefined,
  ): Promise<AppCandidate | null> {
    const entry = catalogueEntry(key);
    if (entry)
      return absent({
        key: entry.key,
        title: entry.title,
        provider: "catalogue",
        entry,
      });
    const slug = key.replace(SLUG_OF_ID, "");
    if (toolkitOf(`composio://${slug}`) !== slug) return null;
    const apps = listed === undefined ? await readDirectory(directory) : listed;
    const app = apps?.find((candidate) => candidate.slug === slug);
    if (app)
      return absent({
        key: `composio-${app.slug}`,
        title: app.name,
        logo: app.logo,
        provider: "composio",
        toolkit: app.slug,
      });
    /*
     * A `composio-` id the directory cannot vouch for is still an app somebody once enabled — a
     * grant can outlive its row — so it is named by its slug rather than dropped. A bare word that
     * matches nothing is not an app at all.
     */
    if (SLUG_OF_ID.test(key))
      return absent({
        key,
        title: slug,
        provider: "composio",
        toolkit: slug,
      });
    return null;
  }

  /**
   * One app by whatever a caller called it: a server id, a catalogue key, a Composio slug with or
   * without its `composio-` prefix, or the app's name. Null for a word that names no app here or
   * in the directory.
   */
  async function candidateFor(
    app: string,
    directory: AppDirectory | undefined,
  ): Promise<AppCandidate | null> {
    const asked = app.trim();
    if (!asked) return null;
    const lower = asked.toLowerCase();
    const rows = await allRows();
    const byRow = await appsByRow(rows);

    const byId = byRow.get(asked);
    if (byId) return byId;

    const slug = lower.replace(SLUG_OF_ID, "");
    for (const candidate of new Set(byRow.values()))
      if (candidate.toolkit === slug) return candidate;

    const entry =
      catalogueEntry(lower) ??
      CATALOGUE.find((item) => item.title.toLowerCase() === lower) ??
      null;
    if (entry)
      return byRow.get(entry.key) ?? absentFor(entry.key, undefined, null);

    for (const candidate of new Set(byRow.values()))
      if (candidate.title.toLowerCase() === lower) return candidate;

    const listed = await readDirectory(directory);
    const named = listed?.find(
      (candidate) =>
        candidate.slug === slug || candidate.name.toLowerCase() === lower,
    );
    if (named) return absentFor(`composio-${named.slug}`, undefined, listed);
    return absentFor(SLUG_OF_ID.test(lower) ? lower : asked, undefined, listed);
  }

  /** The server halves of a Bot's MCP grants. */
  async function grantedServerIds(agentId: string): Promise<Set<string>> {
    const grants = await database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.kind, "mcp"), eq(pluginGrants.agentId, agentId)),
      );
    return new Set(
      grants.map((grant) => grant.ref.split("/")[0] ?? "").filter(Boolean),
    );
  }

  /**
   * The connection facts for a set of apps, for one person or for nobody.
   *
   * THE SAME COLUMNS `GET /connections` REPORTS, read without the broker. A brokered connection is
   * usable unless a check ran and the vendor refused its key (`probe_action` set, `verified`
   * false) — the one of `brokeredConnectionsFor`'s four states that is a dead key. A held one is
   * usable unless its credential was withdrawn.
   */
  async function connectionFacts(apps: AppCandidate[], userId: string | null) {
    const toolkits = [
      ...new Set(apps.map((app) => app.toolkit).filter((t) => t !== null)),
    ] as string[];
    const heldIds = apps
      .filter((app) => app.provider === "catalogue" && app.present)
      .flatMap((app) => app.rowIds);
    const usable = (row: { verified: boolean; probeAction: string | null }) =>
      !(row.probeAction !== null && !row.verified);
    const fact = (row: {
      verified: boolean;
      probeAction: string | null;
      connectedAt: Date | null;
    }) => ({ usable: usable(row), connectedAt: iso(row.connectedAt) });

    const [personal, deployment, held] = await Promise.all([
      userId && toolkits.length > 0
        ? database
            .select({
              app: brokeredConnections.app,
              verified: brokeredConnections.verified,
              probeAction: brokeredConnections.probeAction,
              connectedAt: brokeredConnections.connectedAt,
            })
            .from(brokeredConnections)
            .where(
              and(
                eq(brokeredConnections.provider, "composio"),
                eq(brokeredConnections.holder, "person"),
                eq(brokeredConnections.userId, userId),
                inArray(brokeredConnections.app, toolkits),
              ),
            )
        : [],
      toolkits.length > 0
        ? database
            .select({
              app: brokeredConnections.app,
              verified: brokeredConnections.verified,
              probeAction: brokeredConnections.probeAction,
              connectedAt: brokeredConnections.connectedAt,
            })
            .from(brokeredConnections)
            .where(
              and(
                eq(brokeredConnections.provider, "composio"),
                eq(brokeredConnections.holder, "deployment"),
                inArray(brokeredConnections.app, toolkits),
              ),
            )
        : [],
      userId && heldIds.length > 0
        ? database
            .select({
              serverId: mcpUserCredentials.serverId,
              revokedAt: credentialRows.revokedAt,
              connectedAt: mcpUserCredentials.connectedAt,
            })
            .from(mcpUserCredentials)
            .innerJoin(
              credentialRows,
              eq(credentialRows.id, mcpUserCredentials.credentialId),
            )
            .where(
              and(
                eq(mcpUserCredentials.userId, userId),
                inArray(mcpUserCredentials.serverId, heldIds),
              ),
            )
        : [],
    ]);
    return {
      personalBrokered: new Map(personal.map((row) => [row.app, fact(row)])),
      deploymentBrokered: new Map(
        deployment.map((row) => [row.app, fact(row)]),
      ),
      personalHeld: new Map(
        held.map((row) => [
          row.serverId,
          {
            usable: row.revokedAt === null,
            connectedAt: iso(row.connectedAt),
          },
        ]),
      ),
    };
  }

  /** This person's pending requests about these apps, on this Bot or on no Bot. */
  async function pendingRequestsFor(
    userId: string,
    agentId: string,
    keys: string[],
  ) {
    if (keys.length === 0) return [];
    return database
      .select({
        id: appAccessRequests.id,
        appKey: appAccessRequests.appKey,
        kind: appAccessRequests.kind,
        createdAt: appAccessRequests.createdAt,
      })
      .from(appAccessRequests)
      .where(
        and(
          eq(appAccessRequests.requestedBy, userId),
          eq(appAccessRequests.status, "pending"),
          inArray(appAccessRequests.appKey, keys),
          or(
            eq(appAccessRequests.agentId, agentId),
            isNull(appAccessRequests.agentId),
          ),
        ),
      )
      .orderBy(asc(appAccessRequests.createdAt));
  }

  /** Every candidate described for one person and one Bot. */
  async function describe(
    apps: AppCandidate[],
    input: {
      userId: string | null;
      agentId: string;
      composioConfigured: boolean;
    },
  ): Promise<AppInspection[]> {
    const [granted, connections, pending] = await Promise.all([
      grantedServerIds(input.agentId),
      connectionFacts(apps, input.userId),
      input.userId
        ? pendingRequestsFor(
            input.userId,
            input.agentId,
            apps.map((app) => app.key),
          )
        : [],
    ]);
    return apps.map((app) => {
      const teamAccount = app.toolkit
        ? connections.deploymentBrokered.get(app.toolkit)
        : undefined;
      const sharedUsable = teamAccount?.usable === true;
      const personal =
        app.provider === "composio" && app.toolkit
          ? connections.personalBrokered.get(app.toolkit)
          : app.provider === "catalogue"
            ? app.rowIds
                .map((id) => connections.personalHeld.get(id))
                .find((value) => value !== undefined)
            : undefined;
      const facts: AppAccessFacts = {
        provider: app.provider,
        present: app.present,
        composioConfigured: input.composioConfigured,
        authScheme: app.authScheme,
        accountMode: app.accountMode,
        catalogueAuth: app.entry?.auth ?? null,
        hasCredential: app.hasCredential,
        granted: [app.key, ...app.rowIds].some((id) => granted.has(id)),
        personal: personal === undefined ? null : { usable: personal.usable },
        shared: teamAccount ? { usable: sharedUsable } : null,
      };
      const account = accountOf(facts);
      const state = appAccessState(facts);
      const requestKind = REQUEST_KIND_FOR[state];
      const request =
        requestKind === null
          ? undefined
          : pending.find(
              (row) => row.appKey === app.key && row.kind === requestKind,
            );
      return {
        access: {
          key: app.key,
          displayName: app.title,
          logo: app.logo,
          provider: app.provider,
          account,
          connect: connectOf(facts),
          authScheme: app.provider === "composio" ? app.authScheme : null,
          accountMode: app.accountMode,
          state,
          granted: facts.granted,
          connectedAt:
            account === "shared"
              ? (teamAccount?.connectedAt ?? null)
              : account === "personal"
                ? (personal?.connectedAt ?? null)
                : null,
          requestKind,
          request: request
            ? {
                id: request.id,
                kind: request.kind,
                createdAt: iso(request.createdAt) ?? "",
              }
            : null,
        },
        unavailable: unavailableReason(facts),
        answeringId: app.answeringId,
        toolkit: app.toolkit,
        entry: app.entry,
        sharedUsable,
      };
    });
  }

  const requestColumns = {
    request: appAccessRequests,
    botName: agents.name,
    requesterEmail: users.email,
    requesterName: users.name,
  };

  function toRecord(row: {
    request: typeof appAccessRequests.$inferSelect;
    botName: string | null;
    requesterEmail: string | null;
    requesterName: string | null;
  }): AppAccessRequestRecord {
    return {
      id: row.request.id,
      appKey: row.request.appKey,
      appTitle: row.request.appTitle,
      kind: row.request.kind,
      status: row.request.status,
      agentId: row.request.agentId,
      botName: row.botName,
      requestedBy: row.request.requestedBy,
      requesterEmail: row.requesterEmail,
      requesterName: row.requesterName,
      createdAt: iso(row.request.createdAt) ?? "",
      resolvedAt: iso(row.request.resolvedAt),
      resolvedBy: row.request.resolvedBy,
    };
  }

  async function requestRows(where: SQL | undefined) {
    const rows = await database
      .select(requestColumns)
      .from(appAccessRequests)
      .leftJoin(agents, eq(agents.id, appAccessRequests.agentId))
      .leftJoin(users, eq(users.id, appAccessRequests.requestedBy))
      .where(where)
      .orderBy(desc(appAccessRequests.createdAt), asc(appAccessRequests.id));
    return rows.map(toRecord);
  }

  return {
    /**
     * Every work app one Bot holds, each with what it is for this person.
     *
     * HELD MEANS A GRANT, WHETHER OR NOT THE APP IS STILL THERE. A grant whose row is gone — an app
     * removed before removal took its grants with it, or restored from an older backup — is still
     * something this Bot was given, and is listed as switched off rather than dropped, because
     * "this Bot used to reach Gmail and cannot now" is the one thing a person on the Bot's page
     * needs to read about it.
     *
     * Sorted by name, so two loads draw one order.
     */
    async appAccessForBot(input: {
      userId: string;
      agentId: string;
      composioConfigured: boolean;
      directory?: AppDirectory;
    }): Promise<AppAccess[]> {
      const granted = await grantedServerIds(input.agentId);
      if (granted.size === 0) return [];
      const byRow = await appsByRow(await allRows());
      const apps = new Map<string, AppCandidate>();
      const missing: string[] = [];
      for (const serverId of granted) {
        const app = byRow.get(serverId);
        if (app) apps.set(app.key, app);
        else missing.push(serverId);
      }
      const listed = missing.some((id) => SLUG_OF_ID.test(id))
        ? await readDirectory(input.directory)
        : null;
      for (const serverId of missing) {
        const app =
          (await absentFor(serverId, undefined, listed)) ??
          absent({ key: serverId, title: serverId, provider: "custom" });
        if (!apps.has(app.key)) apps.set(app.key, app);
      }
      const described = await describe([...apps.values()], input);
      return described
        .map((item) => item.access)
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        );
    },

    /**
     * One app, by whatever a caller called it, for this Bot and — where `userId` is given — this
     * person. Null for a word that names no app.
     *
     * Used by the chat card, which asks about an app the Bot may hold nothing for, and by the
     * approve route, which asks for the deployment's half alone and passes no person.
     */
    async inspectApp(input: {
      app: string;
      agentId: string;
      userId: string | null;
      composioConfigured: boolean;
      directory?: AppDirectory;
    }): Promise<AppInspection | null> {
      const candidate = await candidateFor(input.app, input.directory);
      if (!candidate) return null;
      const [described] = await describe([candidate], input);
      return described ?? null;
    },

    /** Every tool the app's answering row advertises, as grant refs. */
    async appToolRefs(serverId: string): Promise<string[]> {
      const rows = await database
        .select({ name: mcpTools.name })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, serverId))
        .orderBy(asc(mcpTools.name));
      return rows.map((row) => `${serverId}/${row.name}`);
    },

    /**
     * File a request, or hand back the one already pending.
     *
     * THE INDEX DECIDES, NOT A READ. `on conflict do nothing` against the partial unique index is
     * what keeps two replicas filing the same request from inserting twice; the read after it only
     * finds which row won. A request answered between the two is filed again, once.
     */
    async fileAppAccessRequest(input: {
      requestedBy: string;
      agentId: string | null;
      appKey: string;
      appTitle: string;
      kind: AppAccessRequestKind;
    }): Promise<{ request: AppAccessRequestRecord; created: boolean }> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const id = randomUUID();
        const inserted = await database
          .insert(appAccessRequests)
          .values({ id, ...input })
          .onConflictDoNothing()
          .returning({ id: appAccessRequests.id });
        const [request] = await requestRows(
          inserted.length > 0
            ? eq(appAccessRequests.id, id)
            : and(
                eq(appAccessRequests.requestedBy, input.requestedBy),
                eq(appAccessRequests.appKey, input.appKey),
                eq(appAccessRequests.kind, input.kind),
                eq(appAccessRequests.status, "pending"),
                input.agentId === null
                  ? isNull(appAccessRequests.agentId)
                  : eq(appAccessRequests.agentId, input.agentId),
              ),
        );
        if (request) {
          if (inserted.length > 0)
            await recordAuditEvent(auditStore, {
              eventType: "app_access.requested",
              targetType: "mcp_server",
              targetId: input.appKey,
              actorUserId: input.requestedBy,
              payload: {
                request: id,
                app: input.appKey,
                bot: input.agentId,
                kind: input.kind,
              },
            });
          return { request, created: inserted.length > 0 };
        }
      }
      throw new Error(
        `A request for ${input.appKey} was neither filed nor found pending.`,
      );
    },

    async appAccessRequest(id: string): Promise<AppAccessRequestRecord | null> {
      const [request] = await requestRows(eq(appAccessRequests.id, id));
      return request ?? null;
    },

    /** Pending requests: one person's, one app's, or every one. Newest first. */
    async pendingAppAccessRequests(filter: {
      requestedBy?: string;
      appKey?: string;
    }): Promise<AppAccessRequestRecord[]> {
      return requestRows(
        and(
          eq(appAccessRequests.status, "pending"),
          filter.requestedBy
            ? eq(appAccessRequests.requestedBy, filter.requestedBy)
            : undefined,
          filter.appKey
            ? eq(appAccessRequests.appKey, filter.appKey)
            : undefined,
        ),
      );
    },

    /**
     * Close a pending request, and only a pending one.
     *
     * THE CONDITION IS THE WHOLE OF THE CONCURRENCY STORY. Two administrators answering at once,
     * or a person cancelling while an administrator approves, both run this; the first update
     * finds the row pending and the second finds nothing, and null is how its caller learns it
     * lost. `requestedBy`, when given, confines a cancel to the person's own requests in the same
     * statement.
     */
    async closeAppAccessRequest(input: {
      id: string;
      status: Exclude<AppAccessRequestStatus, "pending">;
      by: string;
      requestedBy?: string;
    }): Promise<AppAccessRequestRecord | null> {
      const [closed] = await database
        .update(appAccessRequests)
        .set({
          status: input.status,
          resolvedAt: new Date(),
          resolvedBy: input.by,
        })
        .where(
          and(
            eq(appAccessRequests.id, input.id),
            eq(appAccessRequests.status, "pending"),
            input.requestedBy
              ? eq(appAccessRequests.requestedBy, input.requestedBy)
              : undefined,
          ),
        )
        .returning({ id: appAccessRequests.id });
      if (!closed) return null;
      const [record] = await requestRows(eq(appAccessRequests.id, closed.id));
      return record ?? null;
    },

    /**
     * A row in the trail about a request, written here so the routes write through the same
     * redacting writer every other plugin event uses.
     */
    async recordAppAccessEvent(
      event: Omit<AuditEventInput, "targetType"> & {
        eventType:
          | "app_access.cancelled"
          | "app_access.approved"
          | "app_access.dismissed"
          | "app_access.refused";
      },
    ): Promise<void> {
      await recordAuditEvent(auditStore, {
        ...event,
        targetType: "mcp_server",
      });
    },
  };
}
