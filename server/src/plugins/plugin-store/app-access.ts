import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
} from "drizzle-orm";
import { type AuditEventInput, recordAuditEvent } from "../../audit";
import {
  agentProfiles,
  agents,
  appAccessRequests,
  brokeredConnections,
  credentials as credentialRows,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  teamBotConsentDefaults,
  teamBotConsents,
  teamBotPublications,
  users,
} from "../../db/schema";
import { BROKERED_PROFILE, brokeredProvenance, toolkitOfFor } from "../access";
import {
  type AppAccess,
  type AppAccessFacts,
  type AppAccessRequestKind,
  type AppProvider,
  accountOf,
  appAccessState,
  connectOf,
  type OwnerGrants,
  ownerGrantsOf,
  REQUEST_KIND_FOR,
  type Unavailable,
  unavailableReason,
} from "../app-access";
import type { BrokerApp } from "../broker";
import {
  CATALOGUE,
  type CatalogueEntry,
  catalogueEntry,
  classifyTool,
} from "../catalogue";
import type { StoreContext } from "./context";
import { iso } from "./model";

/**
 * One app as this module resolves it before anybody's connection is asked about: which rows are
 * it, which of them answers for it, and what the deployment holds for it.
 *
 * `rowIds` IS EVERY ROW THAT IS THIS APP, so a grant made through a duplicate row at a brokered
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
  /** The answering row's `owner_grants`, null where nobody chose or there is no row. */
  ownerGrants: OwnerGrants | null;
  /**
   * Whether anything but the caller's own word says this app exists: a row, a catalogue entry, or
   * the vendor's directory. False only for an id in the broker's namespace (`composio-`,
   * `arcade-`) the directory did not list — named so a grant that outlived its row still reads,
   * and never something a request may be filed to enable.
   */
  vouched: boolean;
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
  ownerGrants: OwnerGrants | null;
};

/** An app a person could give their own Bots. See `giveableApps`. */
export type GiveableApp = Pick<
  AppAccess,
  "key" | "displayName" | "logo" | "account"
>;

/** The directory, asked only to name an app this deployment has no row for. */
export type AppDirectory = () => Promise<BrokerApp[]>;

/** What one app is for the deployment and, where a person was named, for them. */
export type AppInspection = {
  access: AppAccess;
  /** Why nobody can use it yet, as {@link unavailableReason} answers; null when somebody can. */
  unavailable: Unavailable | null;
  /** The row a grant is written against, and null for an app with no row. */
  answeringId: string | null;
  /** Every row that is this app, which is where the grants an owner takes back may be. */
  rowIds: string[];
  /** The app at the broker, for a brokered one. */
  toolkit: string | null;
  /** The catalogue entry, for an app this deployment ships. */
  entry: CatalogueEntry | null;
  /** Whether the Shared team account is connected and its key was not refused. */
  sharedUsable: boolean;
  /** See {@link AppCandidate.vouched}. */
  vouched: boolean;
};

/**
 * Whether the shared-use gate would admit this person's calls through this Bot to a Shared app's
 * team account — the gate's own rule, without the request it files when it refuses.
 */
export type SharedAudienceCheck = (input: {
  botId: string;
  serverId: string;
  actorId: string;
}) => Promise<boolean>;

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

/**
 * Whether `error` is a Postgres unique_violation (SQLSTATE 23505). Bun's driver puts the SQLSTATE in
 * `errno`, and drizzle wraps the driver error as `cause` — the same reading `identity/store.ts` makes.
 */
function isUniqueViolation(error: unknown): boolean {
  type Driver = { errno?: unknown };
  return [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ].some((candidate) => candidate?.errno === "23505");
}

/**
 * Per-person, per-Bot status of the work apps a Bot holds, and the requests a person files when
 * only an administrator can change it. See `../app-access.ts` for the rule itself.
 *
 * ONE BROKER, THE STORE'S. Which rows are brokered apps, which connections are theirs, the scheme
 * an app's url is minted at and the prefix its row id takes all come from `brokerProvider` and
 * {@link BROKERED_PROFILE}, so a personal Arcade app is read exactly as a personal Composio app is
 * — and a row left by the broker this deployment does not run is no brokered app here, as it is
 * no brokered app to any other reader in the store.
 */
export function appAccessMethods(context: StoreContext) {
  const { database, auditStore, brokeredAppRowsAt, brokerProvider } = context;
  const { scheme, idPrefix } = BROKERED_PROFILE[brokerProvider];
  /** Whether an id is in the namespace `addBrokeredApp` mints this broker's rows into. */
  const isBrokeredId = (id: string) => id.startsWith(idPrefix);
  /** An id with that namespace taken off, and any other word as it came. */
  const slugOfId = (id: string) =>
    isBrokeredId(id) ? id.slice(idPrefix.length) : id;

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
        ownerGrants: mcpServers.ownerGrants,
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
      const toolkit =
        row.provenance === brokerProvider
          ? toolkitOfFor(brokerProvider, row.url)
          : null;
      if (toolkit && !catalogueEntry(row.id)) toolkitOfRow.set(row.id, toolkit);
    }
    const answering = await brokeredAppRowsAt([
      ...new Set([...toolkitOfRow.values()].map((t) => `${scheme}${t}`)),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const apps = new Map<string, AppCandidate>();
    const byRow = new Map<string, AppCandidate>();

    for (const row of rows) {
      const toolkit = toolkitOfRow.get(row.id) ?? null;
      const head = toolkit ? answering.get(`${scheme}${toolkit}`) : undefined;
      const key = head?.id ?? row.id;
      let app = apps.get(key);
      if (!app) {
        const source = byId.get(key) ?? row;
        const entry = toolkit ? null : catalogueEntry(row.id);
        app = {
          key,
          title: entry?.title ?? source.title,
          logo: source.logo,
          provider: toolkit ? brokerProvider : entry ? "catalogue" : "custom",
          present: true,
          answeringId: key,
          rowIds: [],
          toolkit,
          entry,
          authScheme: toolkit ? (head?.authScheme ?? null) : source.authScheme,
          accountMode: toolkit ? (head?.accountMode ?? null) : null,
          hasCredential: source.credentialId !== null,
          ownerGrants: source.ownerGrants,
          vouched: true,
        };
        apps.set(key, app);
      }
      app.rowIds.push(row.id);
      byRow.set(row.id, app);
    }
    return byRow;
  }

  /**
   * An app with no row: a catalogue entry nobody added, or a brokered app nobody enabled.
   *
   * `key` is the id enabling it would mint — the entry's key, or the broker's prefix and the slug
   * (`composio-<slug>`, `arcade-<Toolkit>`) as `addBrokeredApp` names a row — so a request filed
   * now names the row the approval creates.
   */
  function absent(input: {
    key: string;
    title: string;
    logo?: string | null;
    provider: AppProvider;
    toolkit?: string | null;
    entry?: CatalogueEntry | null;
    vouched?: boolean;
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
      ownerGrants: null,
      vouched: input.vouched ?? true,
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
    const slug = slugOfId(key);
    if (toolkitOfFor(brokerProvider, `${scheme}${slug}`) !== slug) return null;
    const apps = listed === undefined ? await readDirectory(directory) : listed;
    const app = apps?.find((candidate) => candidate.slug === slug);
    if (app)
      return absent({
        key: `${idPrefix}${app.slug}`,
        title: app.name,
        logo: app.logo,
        provider: brokerProvider,
        toolkit: app.slug,
      });
    /*
     * An id in the broker's namespace that the directory cannot vouch for is still an app somebody
     * once enabled — a grant can outlive its row — so it is named by its slug rather than dropped.
     * A bare word that matches nothing is not an app at all.
     */
    if (isBrokeredId(key))
      return absent({
        key,
        title: slug,
        provider: brokerProvider,
        toolkit: slug,
        vouched: false,
      });
    return null;
  }

  /**
   * One app by whatever a caller called it: a server id, a catalogue key, a brokered app's slug
   * with or without its id prefix (`composio-`, `arcade-`), or the app's name. Null for a word that
   * names no app here or in the directory.
   *
   * A SLUG IS MATCHED AS TYPED FIRST, THEN LOWERCASED. Arcade's toolkit names are case-sensitive
   * (`Gmail`), so the word as the caller typed it is the one that can reach them; Composio's slugs
   * are lowercase, so the lowercased word is the one that always reached those, and still does.
   *
   * A NAME FINDS WHAT IS ENABLED BEFORE WHAT COULD BE. "Google Drive" is the title of the built-in
   * `google-drive` entry and of a brokered row alike; on a deployment that enabled the brokered one
   * and never added the built-in, the name is about the app that is there, and answering with the
   * entry instead would call it switched off and file a request to enable something nobody needs.
   * So an exact id or key is taken as it was given, and a bare name is matched against the rows
   * first — the one this Bot holds, where two rows share it — and only then against the catalogue.
   */
  async function candidateFor(
    app: string,
    directory: AppDirectory | undefined,
    granted: Set<string>,
  ): Promise<AppCandidate | null> {
    const asked = app.trim();
    if (!asked) return null;
    const lower = asked.toLowerCase();
    const rows = await allRows();
    const byRow = await appsByRow(rows);
    const enabled = [...new Set(byRow.values())];

    const byId = byRow.get(asked);
    if (byId) return byId;

    const typed = slugOfId(asked);
    const slug = slugOfId(lower);
    for (const wanted of new Set([typed, slug]))
      for (const candidate of enabled)
        if (candidate.toolkit === wanted) return candidate;

    const keyed = catalogueEntry(lower);
    if (keyed)
      return byRow.get(keyed.key) ?? absentFor(keyed.key, undefined, null);

    const titled = enabled.filter(
      (candidate) => candidate.title.toLowerCase() === lower,
    );
    const held = titled.find((candidate) =>
      [candidate.key, ...candidate.rowIds].some((id) => granted.has(id)),
    );
    if (held ?? titled[0]) return held ?? titled[0] ?? null;

    const entry = CATALOGUE.find((item) => item.title.toLowerCase() === lower);
    if (entry) return absentFor(entry.key, undefined, null);

    const listed = await readDirectory(directory);
    const named =
      (typed !== slug
        ? listed?.find((candidate) => candidate.slug === typed)
        : undefined) ??
      listed?.find(
        (candidate) =>
          candidate.slug === slug || candidate.name.toLowerCase() === lower,
      );
    if (named) return absentFor(`${idPrefix}${named.slug}`, undefined, listed);
    return absentFor(isBrokeredId(lower) ? lower : asked, undefined, listed);
  }

  /**
   * The server halves of a Bot's MCP grants, each with whether any of its grants an administrator
   * made. A server whose every grant is the owner's reads `false`: see `plugin_grants.granted_as`.
   */
  async function grantsByServer(
    agentId: string,
  ): Promise<Map<string, { byAdmin: boolean }>> {
    const grants = await database
      .select({ ref: pluginGrants.ref, grantedAs: pluginGrants.grantedAs })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.kind, "mcp"), eq(pluginGrants.agentId, agentId)),
      );
    const servers = new Map<string, { byAdmin: boolean }>();
    for (const grant of grants) {
      const serverId = grant.ref.split("/")[0] ?? "";
      if (!serverId) continue;
      const byAdmin = grant.grantedAs !== "owner";
      servers.set(serverId, {
        byAdmin: byAdmin || (servers.get(serverId)?.byAdmin ?? false),
      });
    }
    return servers;
  }

  /** The server halves of a Bot's MCP grants. */
  async function grantedServerIds(agentId: string): Promise<Set<string>> {
    return new Set((await grantsByServer(agentId)).keys());
  }

  /** Who owns a Bot that still stands: a person's id, or null for one nobody owns or none at all. */
  async function botOwnerOf(agentId: string): Promise<string | null> {
    const [row] = await database
      .select({ ownerUserId: agentProfiles.ownerUserId })
      .from(agentProfiles)
      .where(
        and(
          eq(agentProfiles.agentId, agentId),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .limit(1);
    return row?.ownerUserId ?? null;
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
                eq(brokeredConnections.provider, brokerProvider),
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
                eq(brokeredConnections.provider, brokerProvider),
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

  /**
   * The owner of a published Team Bot, when the person looking is somebody else; null for any other
   * Bot, or for its owner. The same publication `credentialActorFor` reads before it decides whose
   * account a call goes out on.
   */
  async function teamBotOwnerFor(
    agentId: string,
    userId: string,
  ): Promise<string | null> {
    const [row] = await database
      .select({ ownerUserId: agentProfiles.ownerUserId })
      .from(teamBotPublications)
      .innerJoin(
        agentProfiles,
        eq(agentProfiles.agentId, teamBotPublications.agentId),
      )
      .where(
        and(
          eq(teamBotPublications.agentId, agentId),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .limit(1);
    const owner = row?.ownerUserId ?? null;
    return owner && owner !== userId ? owner : null;
  }

  /**
   * The servers this person lets one Team Bot use their own account on without asking: an
   * "always" or a not-yet-spent "once" for this Bot, or a default for every Bot.
   */
  async function standingConsents(
    userId: string,
    agentId: string,
  ): Promise<Set<string>> {
    const [forBot, forEvery] = await Promise.all([
      database
        .select({ serverId: teamBotConsents.serverId })
        .from(teamBotConsents)
        .where(
          and(
            eq(teamBotConsents.userId, userId),
            eq(teamBotConsents.agentId, agentId),
          ),
        ),
      database
        .select({ serverId: teamBotConsentDefaults.serverId })
        .from(teamBotConsentDefaults)
        .where(eq(teamBotConsentDefaults.userId, userId)),
    ]);
    return new Set([...forBot, ...forEvery].map((row) => row.serverId));
  }

  /**
   * Every candidate described for one person and one Bot.
   *
   * THE ACCOUNT IS THE ONE THE CALL WILL USE. On somebody else's published Team Bot, a personal
   * app's calls go out on the owner's account wherever the owner has one — connected, withdrawn or
   * refused alike, exactly as `credentialActorFor` decides from `connectedServers` — and only
   * otherwise on the person's own, after they allow it. So the owner's connection decides the state
   * there, and a teammate is never offered a Connect that changes nothing, nor told `ready` over a
   * call that will stop to ask them first without saying so.
   *
   * EXCEPT WHERE THE OWNER GAVE THE APP THEMSELVES. A grant the Bot's owner made always runs on the
   * asking person's own account (see `plugin_grants.granted_as`), so where every grant this Bot holds
   * on the app is the owner's, the owner's connection is not asked about and the person's own is.
   *
   * `ownerGrantsAllowed` is whether an administrator left this person able to give their own apps
   * to their own Bots at all — the `ownerApps` capability — and true where nobody asked.
   */
  async function describe(
    apps: AppCandidate[],
    input: {
      userId: string | null;
      agentId: string;
      composioConfigured: boolean;
      sharedAudience?: SharedAudienceCheck;
      ownerGrantsAllowed?: boolean;
    },
  ): Promise<AppInspection[]> {
    const { userId } = input;
    const owner = userId ? await teamBotOwnerFor(input.agentId, userId) : null;
    const mayGiveOwn =
      userId !== null &&
      input.ownerGrantsAllowed !== false &&
      (await botOwnerOf(input.agentId)) === userId;
    const [grants, connections, ownerConnections, consented, pending] =
      await Promise.all([
        grantsByServer(input.agentId),
        connectionFacts(apps, userId),
        owner ? connectionFacts(apps, owner) : null,
        owner && userId
          ? standingConsents(userId, input.agentId)
          : new Set<string>(),
        userId
          ? pendingRequestsFor(
              userId,
              input.agentId,
              apps.map((app) => app.key),
            )
          : [],
      ]);
    const personalIn = (
      found: Awaited<ReturnType<typeof connectionFacts>>,
      app: AppCandidate,
    ) =>
      brokeredProvenance(app.provider) && app.toolkit
        ? found.personalBrokered.get(app.toolkit)
        : app.provider === "catalogue"
          ? app.rowIds
              .map((id) => found.personalHeld.get(id))
              .find((value) => value !== undefined)
          : undefined;
    return Promise.all(
      apps.map(async (app) => {
        const ids = [app.key, ...app.rowIds];
        const held = ids.flatMap((id) => {
          const grant = grants.get(id);
          return grant ? [grant] : [];
        });
        const givenByOwner =
          held.length > 0 && held.every((grant) => !grant.byAdmin);
        const teamAccount = app.toolkit
          ? connections.deploymentBrokered.get(app.toolkit)
          : undefined;
        const sharedUsable = teamAccount?.usable === true;
        const own = personalIn(connections, app);
        const owners =
          ownerConnections && !givenByOwner
            ? personalIn(ownerConnections, app)
            : undefined;
        const personal = owners ?? own;
        const known: AppAccessFacts = {
          provider: app.provider,
          present: app.present,
          composioConfigured: input.composioConfigured,
          authScheme: app.authScheme,
          accountMode: app.accountMode,
          catalogueAuth: app.entry?.auth ?? null,
          hasCredential: app.hasCredential,
          granted: held.length > 0,
          ownerGrants: app.ownerGrants,
          mayGiveOwn,
          personal: personal === undefined ? null : { usable: personal.usable },
          shared: teamAccount ? { usable: sharedUsable } : null,
          sharedAdmitted: null,
        };
        const account = accountOf(known);
        /*
         * Asked only where it can change the answer: a Shared app this Bot holds, whose team account
         * is there, for a named person. The gate is asked again on every call; this is what it would
         * say now.
         */
        const facts: AppAccessFacts =
          account === "shared" &&
          sharedUsable &&
          known.granted &&
          userId &&
          input.sharedAudience &&
          app.answeringId
            ? {
                ...known,
                sharedAdmitted: await input.sharedAudience({
                  botId: input.agentId,
                  serverId: app.answeringId,
                  actorId: userId,
                }),
              }
            : known;
        const state = appAccessState(facts);
        const holder = owners !== undefined ? "owner" : "you";
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
            authScheme: brokeredProvenance(app.provider)
              ? app.authScheme
              : null,
            accountMode: app.accountMode,
            state,
            unavailable: unavailableReason(facts),
            accountHolder: account === "personal" ? holder : null,
            asksFirst:
              state === "ready" &&
              account === "personal" &&
              holder === "you" &&
              owner !== null &&
              !ids.some((id) => consented.has(id)),
            granted: facts.granted,
            ownerGrants: ownerGrantsOf(facts),
            givenByOwner,
            needsConnect:
              state === "owner_grantable" &&
              account === "personal" &&
              !facts.personal?.usable,
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
          rowIds: app.rowIds,
          toolkit: app.toolkit,
          entry: app.entry,
          sharedUsable,
          vouched: app.vouched,
        };
      }),
    );
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

  /** See `closeAppAccessRequest` below. */
  async function closeRequest(input: {
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
      sharedAudience?: SharedAudienceCheck;
      ownerGrantsAllowed?: boolean;
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
      const listed = missing.some(isBrokeredId)
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
      sharedAudience?: SharedAudienceCheck;
      ownerGrantsAllowed?: boolean;
    }): Promise<AppInspection | null> {
      const candidate = await candidateFor(
        input.app,
        input.directory,
        await grantedServerIds(input.agentId),
      );
      if (!candidate) return null;
      const [described] = await describe([candidate], input);
      return described ?? null;
    },

    /**
     * The apps this person could give their own Bots, as the New Bot sheet and a Bot's page offer
     * them: switched on and usable, opened to owners ({@link ownerGrantsOf}), and — for an app that
     * runs on each person's own account — connected by this person with a key nobody refused.
     *
     * NOT ABOUT ANY ONE BOT. Whether a given Bot is theirs to give to is asked where it is given; this
     * is the list of what they hold. Sorted by name.
     */
    async giveableApps(input: {
      userId: string;
      composioConfigured: boolean;
    }): Promise<GiveableApp[]> {
      const apps = [...new Set((await appsByRow(await allRows())).values())];
      const connections = await connectionFacts(apps, input.userId);
      const giveable: GiveableApp[] = [];
      for (const app of apps) {
        const own =
          brokeredProvenance(app.provider) && app.toolkit
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
          granted: false,
          ownerGrants: app.ownerGrants,
          mayGiveOwn: true,
          personal: own ? { usable: own.usable } : null,
          shared: null,
          sharedAdmitted: null,
        };
        if (unavailableReason(facts) !== null) continue;
        if (ownerGrantsOf(facts) !== "any") continue;
        const account = accountOf(facts);
        if (account === "personal" && !own?.usable) continue;
        giveable.push({
          key: app.key,
          displayName: app.title,
          logo: app.logo,
          account,
        });
      }
      return giveable.sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      );
    },

    /**
     * Who may give an app to a Bot, as an administrator chose it, or null to put the default for its
     * account back. Written on every row at the app's url, so a duplicate row answers the same, and
     * recorded in the trail. Answers false for an app with no row.
     */
    async setOwnerGrants(input: {
      serverId: string;
      ownerGrants: OwnerGrants | null;
      by: string;
    }): Promise<boolean> {
      const [row] = await database
        .select({ url: mcpServers.url, ownerGrants: mcpServers.ownerGrants })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.serverId))
        .limit(1);
      if (!row) return false;
      await database
        .update(mcpServers)
        .set({ ownerGrants: input.ownerGrants, updatedAt: new Date() })
        .where(eq(mcpServers.url, row.url));
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: input.serverId,
        payload: {
          actor: input.by,
          change: "owner_grants_changed",
          from: row.ownerGrants,
          to: input.ownerGrants,
        },
      });
      return true;
    },

    /**
     * Every tool the app's answering row advertises, as grant refs, and whether each is a read.
     *
     * A READ IS WHAT `classifyTool` CALLS ONE, the same answer the call gate and the Plugins page
     * give. For a brokered or custom app that is the exact word `read` in `effect` and nothing
     * else, so a tool nobody classified is never handed out as a read. For an app this deployment
     * ships it is also anything advertised that the reviewed entry does not list as a write — which
     * this used to miss, reading `effect` alone, so a one-press approval of a built-in app whose
     * listing records no effect found no reads at all and refused.
     */
    async appTools(
      serverId: string,
    ): Promise<{ ref: string; read: boolean }[]> {
      const rows = await database
        .select({ name: mcpTools.name, effect: mcpTools.effect })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, serverId))
        .orderBy(asc(mcpTools.name));
      const entry = catalogueEntry(serverId);
      return rows.map((row) => ({
        ref: `${serverId}/${row.name}`,
        read: classifyTool(entry, row.name, true, row.effect) === "read",
      }));
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

    /** How many requests this person has waiting, across every app and Bot. */
    async countPendingAppAccessRequests(requestedBy: string): Promise<number> {
      const [row] = await database
        .select({ count: count() })
        .from(appAccessRequests)
        .where(
          and(
            eq(appAccessRequests.requestedBy, requestedBy),
            eq(appAccessRequests.status, "pending"),
          ),
        );
      return row?.count ?? 0;
    },

    /**
     * Claim a pending request for an approval about to be carried out: closed as approved, by this
     * administrator, before anything is changed — or null when somebody else answered it first.
     *
     * THE CLAIM COMES FIRST SO NOTHING CAN ANSWER IT UNDERNEATH THE CHANGE. Approving switches an
     * app on and grants a Bot its tools, and used to close the request only afterwards; a dismiss or
     * a withdrawal landing in between closed it first, the approve's close found nothing, and the
     * Bot kept a grant under a request that read dismissed, with no `app_access.approved` in the
     * trail. Claimed here by the same conditional update every close is, the approval is the answer
     * the moment it starts, and anybody else closing meanwhile finds it answered and loses with a
     * 409 — before the change, not after it.
     *
     * NOT A ROW LOCK HELD ACROSS THE CHANGE, which is the other way to get this and the wrong one
     * here. The change is made through the store on connections of its own, and a transaction kept
     * open around it is the shape `db/client.ts` warns about: every pooled connection inside such a
     * transaction, each waiting for a second, is a hang under load and an immediate one on a pool
     * of one.
     *
     * An approval that cannot be carried out puts the request back with
     * {@link releaseAppAccessRequest}, so it waits again with the step that is missing.
     */
    async claimAppAccessRequest(input: {
      id: string;
      by: string;
    }): Promise<AppAccessRequestRecord | null> {
      return closeRequest({ id: input.id, status: "approved", by: input.by });
    },

    /**
     * Put back a request {@link claimAppAccessRequest} claimed and the approval then could not carry
     * out. Only this administrator's claim, and only while it still reads approved.
     *
     * A REQUEST FILED AGAIN MEANWHILE IS THE ONE THAT WAITS. The person saw theirs answered, and the
     * partial unique index lets them file the same request again; two cannot both be pending, so
     * this one is closed as cancelled instead — the same request, already waiting under the other id.
     */
    async releaseAppAccessRequest(input: { id: string; by: string }) {
      const claimed = and(
        eq(appAccessRequests.id, input.id),
        eq(appAccessRequests.status, "approved"),
        eq(appAccessRequests.resolvedBy, input.by),
      );
      try {
        await database
          .update(appAccessRequests)
          .set({ status: "pending", resolvedAt: null, resolvedBy: null })
          .where(claimed);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        await database
          .update(appAccessRequests)
          .set({ status: "cancelled", resolvedAt: new Date() })
          .where(claimed);
      }
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
    closeAppAccessRequest: closeRequest,

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
          | "app_access.refused"
          | "app_access.owner_granted"
          | "app_access.owner_revoked"
          | "shared_use.owner_approved"
          | "shared_use.owner_withdrawn";
      },
    ): Promise<void> {
      await recordAuditEvent(auditStore, {
        ...event,
        targetType: "mcp_server",
      });
    },
  };
}
