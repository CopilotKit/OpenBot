import { queryOptions } from "@tanstack/react-query";
import { everyPage } from "@/lib/api/every-page";
import { listBotGrants } from "@/lib/api/generated/bot-grants/bot-grants";
import {
  getConnection,
  getConnectionDisconnectPreview,
  getSharedConnection,
  listConnectedAccounts,
  listConnections,
} from "@/lib/api/generated/connections/connections";
import type {
  App,
  AppTool,
  AppWithdrawnGrant,
  BotGrant,
  Connection,
} from "@/lib/api/generated/model";
import { organizationId } from "@/lib/api/request";

/**
 * Re-exported, not re-declared.
 *
 * The field list is asked for by a POST, so it lives beside its only producer in `./mutations` —
 * a second copy here would be free to drift from the shape that write actually returns.
 */
export type { BrokerField } from "./mutations";

/**
 * An app added here, as the API answers it (listApps). A screen reads `source` for how it was added
 * and `connectsWith` for how a person connects an app from the directory, never a broker's name.
 */
export type PluginServer = App;

/** One action an app offers, and the Bots that may use it. */
export type PluginTool = AppTool;

/**
 * An action Bots were given that the app no longer offers. Held and not offered: a Bot is told about
 * an action only while the app offers it, and it comes back if the app offers it again.
 */
export type WithdrawnGrant = AppWithdrawnGrant;

export type PluginSkill = {
  id: string;
  slug: string;
  /** Whose it is. Null means the deployment's: an administrator looks after it. */
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  grantedTo: string[];
  /**
   * The tools this skill says it needs, as `<serverId>/<toolName>` refs.
   *
   * A declaration, not a grant, and the difference is the whole reason anybody may write a skill:
   * naming a tool here cannot make it callable. Selection intersects this with what the Bot was
   * granted, so a skill naming a tool its Bot does not hold selects the skill and loads nothing.
   * `grantedTo` on the tool side is what decides.
   */
  tools: string[];
};

export type { CatalogueItem } from "@/lib/apps/queries";

/**
 * What one Bot holds and is offered now: each app action whose app still lists it, as
 * `<app id>/<action name>`, and each skill. Read from the Bot's grants (listBotGrants), leaving out an
 * action its app no longer lists and the other Bots it may hand work to.
 */
export type GrantedPlugins = {
  tools: {
    ref: string;
    description: string;
    destructive: boolean;
    read: boolean;
  }[];
  skills: {
    slug: string;
    title: string;
    summary: string;
  }[];
};

/** A Bot's grants as what it holds and is offered now. */
export function grantedPluginsOf(grants: readonly BotGrant[]): GrantedPlugins {
  return {
    tools: grants.flatMap((grant) =>
      grant.kind === "action" && grant.action
        ? [
            {
              ref: grant.ref,
              description: grant.action.description,
              destructive: grant.action.destructive,
              read: grant.action.read,
            },
          ]
        : [],
    ),
    skills: grants.flatMap((grant) =>
      grant.kind === "skill" && grant.skill
        ? [
            {
              slug: grant.skill.slug,
              title: grant.skill.title,
              summary: grant.skill.summary,
            },
          ]
        : [],
    ),
  };
}

export const pluginKeys = {
  all: ["plugins"] as const,
  forAgent: (agentId: string) => ["plugins", "for-agent", agentId] as const,
  connections: () => ["plugins", "connections"] as const,
  sharedConnection: (serverId: string) =>
    ["plugins", "shared-connection", serverId] as const,
  siblings: (serverId: string) => ["plugins", "siblings", serverId] as const,
  accounts: (serverId: string) => ["plugins", "accounts", serverId] as const,
};

/**
 * One account this person has connected, from their own point of view.
 *
 * DELIBERATELY NON-UNIFORM, because listConnections answers two kinds of row: connections held in
 * this deployment's own vault, and brokered ones Composio keeps on our behalf. The fields a
 * settings row draws from — the server id, the scope, the date — line up across both, which is why
 * one type covers both. The pair below does not, so it is optional rather than required: making it
 * required would be a lie the compiler then enforced on every held row.
 */
export type PluginConnection = {
  serverId: string;
  /**
   * Whether the credential behind this row has been withdrawn or deleted, present only on a HELD
   * row — a brokered one keeps no secret here, so it has no equivalent question.
   *
   * A ROW IS NOT ACCESS. Revoking a credential leaves this row pointing at it, and reconnecting
   * moves `credential_id` and `updated_at` without touching `connected_at`, so the presence of a
   * row says nothing about whether the app can be used and nothing visible changes when it can be
   * again. Anything drawing the word "connected" has to read this; anything listing the apps
   * somebody has ever connected does not.
   *
   * Undefined on a brokered row and on any shape written before this existed, and the absence
   * reads as not revoked.
   */
  revoked?: boolean;
  /** What the vendor actually granted, which is not always what was asked for. Empty for brokered. */
  scope: string;
  connectedAt: string;
  /**
   * Whose account this row is: the signed-in person's own (every row {@link connectionsQueryOptions}
   * lists), or the one standing account of a Shared app (see {@link PluginServer.accountMode}), read
   * with {@link sharedConnectionQueryOptions}, that every Bot holding a grant acts as regardless of
   * who is asking. Undefined reads as `"person"`: see {@link personalConnections}.
   */
  holder?: "person" | "deployment";
  /**
   * Whether the deployment's one shared account is connected, present only on a DEPLOYMENT row.
   *
   * A Shared app's account is read even when nothing is connected to it yet — see
   * {@link PluginServer.sharedVendorConnected} — so a reader cannot take the row's presence for a
   * yes. This is the field that answers.
   *
   * NOTE: an unconnected deployment row has no real date for {@link connectedAt} either, which
   * would want that field widened to `string | null` to say so honestly. Left as `string` here
   * instead — `connected-accounts/$key.tsx` hands it straight to `new Date(...)`, and widening
   * turned that red under `bun run typecheck`. A row with nothing connected must therefore be read
   * through this field, not through `connectedAt`, until that caller is dealt with.
   */
  connected?: boolean;
  /**
   * The email of whoever connected the shared account, present only on a DEPLOYMENT row.
   *
   * Null is reachable: nobody has connected it yet, or the row predates this being recorded.
   */
  connectedBy?: string | null;
  /**
   * The vendor's own name for the connected account (an org, a bot, a workspace), present only on
   * a DEPLOYMENT row.
   *
   * Shown instead of a person's name precisely because there isn't one here — the account is the
   * deployment's, and this is what tells one Shared app's row apart from another's otherwise
   * identical "connected" answer.
   */
  displayName?: string | null;
  /**
   * Whether a real call was last made with this credential, present only on a BROKERED row.
   *
   * Only a brokered row has anything to re-check: this deployment holds no secret for it, only a
   * note that Composio said yes, and that note can drift when somebody ends the connection in
   * Composio's own dashboard. A held connection has no equivalent question, so its rows carry
   * neither field, and the absence of the pair is what tells the two READS apart — nothing more.
   *
   * It is NOT how a reader learns how an app connects. That comes from the app's `connectsWith`
   * (listApps), and a page deriving it from a connection row instead would be a second answer to a
   * question already carried.
   */
  verified?: boolean;
  /**
   * When {@link PluginConnection.verified} was last earned, present only on a brokered row.
   *
   * Null is reachable and means never checked, which is why it stays null rather than collapsing
   * the way `connectedAt` does. For the rows an older migration backfilled it is the moment of
   * consent rather than of a probe, so it is not read as "this connection answered then".
   */
  verifiedAt?: string | null;
  /**
   * Which action the last check of this key actually SPENT, present only on a brokered row.
   *
   * A RECORD READ OFF THE ROW, not a reading of what the app publishes now — which is why it
   * survives a reload where the answer to a connect or a re-check cannot, and why nothing the
   * catalogue does afterwards can move it. Read together with {@link PluginConnection.verified} it
   * separates the three situations that share the one word `false`: no probe means nothing was
   * tried, because at the time of the check the app published nothing safe to spend a key on; a
   * probe with `verified` means the check ran and passed; and a probe WITHOUT it means the check
   * ran and the vendor refused the key, over an account that is still standing.
   *
   * A PAST TENSE, AND ONLY THAT. It is what the SENTENCE beneath the row is drawn from. What it
   * must never be asked is whether the key could be checked again — see
   * {@link PluginConnection.checkable}, which is the present-tense answer and a different field
   * because it is a different question.
   *
   * Optional for the same reason the pair above is: that endpoint concatenates two reads, and only
   * the brokered one carries any of this. Undefined is the absence of the field and not a fourth
   * state.
   */
  probe?: string | null;
  /**
   * Whether the app has anything to check this key against TODAY, present only on a brokered row.
   *
   * ASKED OF THE APP AND NOT OF THE CONNECTION, out of the same chooser a real check would use: has
   * this app published an action safe to spend somebody's key on — a vendor-labelled read, not
   * destructive, needing no arguments, recorded at a version that can be called. It is what the
   * Re-check button is drawn from, and nothing else here is.
   *
   * SEPARATE FROM {@link PluginConnection.probe} BECAUSE COLLAPSING THEM DEADLOCKS THE PAGE. While
   * the button read the record, a key connected to an app with nothing to try recorded null, for
   * good — and the button stayed withheld however much the app published later, though pressing it
   * is the only thing that could ever put an action in the record. The past and the present are two
   * questions; the row asks them separately and answers them separately.
   *
   * Optional for the same reason as the fields above, and false and absent mean the same thing to
   * the only reader there is: nothing to press. That is why a screen may flatten this where it
   * passes `probe` through unflattened — a missing verdict and a null verdict are different
   * sentences, while a missing gate and a closed gate are the same gate.
   */
  checkable?: boolean;
};

export type PluginConnections = {
  connections: PluginConnection[];
};

/**
 * One of the person's own connections as listConnections answers it, in the shape the screens
 * read: a held row carries `revoked`, a row the app keeps carries what its last check found.
 */
function personalRow(connection: Connection): PluginConnection {
  return {
    serverId: connection.appId,
    scope: connection.scope ?? "",
    connectedAt: connection.connectedAt,
    holder: "person",
    ...(connection.check === null
      ? { revoked: connection.revoked }
      : {
          verified: connection.check.verified,
          verifiedAt: connection.check.verifiedAt,
          probe: connection.check.checkedAction,
          checkable: connection.check.checkable,
        }),
  };
}

/**
 * The connections that are the signed-in person's own. A Shared app's row is the deployment's, and
 * every screen that asks "is this mine" must never read it as yes.
 */
export function personalConnections(
  rows: PluginConnection[],
): PluginConnection[] {
  return rows.filter((row) => row.holder !== "deployment");
}

/**
 * The signed-in person's own connections.
 *
 * There is no version of this scoped to anybody else: the endpoint answers for whoever is asking,
 * so a page cannot accidentally render somebody else's.
 */
export function connectionsQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.connections(),
    queryFn: async (): Promise<PluginConnections> => {
      const connections = await everyPage(async (cursor) => {
        const page = await listConnections(
          organizationId(),
          "me",
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { fallback: "Couldn't load your connections." },
        );
        return { items: page.connections, nextCursor: page.nextCursor };
      });
      return { connections: connections.map(personalRow) };
    },
  });
}

/**
 * A Shared app's one account, which every Bot using the app acts as: whether it is connected, who
 * connected it and the app's own name for it, with what its last check found. Read only for an app
 * in Shared mode; a person's own connections never carry it.
 */
export function sharedConnectionQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: pluginKeys.sharedConnection(serverId),
    queryFn: async (): Promise<PluginConnection> => {
      const shared = await getSharedConnection(organizationId(), serverId, {
        fallback: "Couldn't load the shared account.",
      });
      return {
        serverId: shared.appId,
        scope: "",
        connectedAt: shared.connectedAt ?? "",
        holder: "deployment",
        connected: shared.connected,
        connectedBy: shared.connectedBy,
        displayName: shared.accountName,
        verified: shared.check?.verified ?? false,
        verifiedAt: shared.check?.verifiedAt ?? null,
        probe: shared.check?.checkedAction ?? null,
        checkable: shared.check?.checkable ?? false,
      };
    },
  });
}

/**
 * What disconnecting this app would also end, as the server computed it.
 *
 * `siblings` are other apps' toolkit names (never this one) and `unanswered` is a COUNT of apps that
 * could not be asked about. A deployment whose broker holds one account per app always answers
 * empty.
 */
export type ConnectionSiblings = { siblings: string[]; unanswered: number };

export function connectionSiblingsQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: pluginKeys.siblings(serverId),
    queryFn: async (): Promise<ConnectionSiblings> => {
      const preview = await getConnectionDisconnectPreview(
        organizationId(),
        "me",
        serverId,
        { fallback: "Couldn't read which other apps share this connection." },
      );
      const body: Partial<ConnectionSiblings> = {
        siblings: preview.alsoEnds,
        unanswered: preview.uncheckedCount,
      };
      /*
       * NARROWED RATHER THAN TRUSTED: an answer that is not this shape is read as "nothing to say",
       * which draws no warning, rather than a throw that takes the whole page down for a sentence.
       */
      return {
        siblings: Array.isArray(body.siblings) ? body.siblings : [],
        unanswered:
          typeof body.unanswered === "number" && body.unanswered > 0
            ? body.unanswered
            : 0,
      };
    },
  });
}

/**
 * Polled grant snapshot for what the active Bot should be offered; call-time checks still enforce.
 */
export function agentPluginsQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: pluginKeys.forAgent(agentId),
    enabled: agentId.length > 0,
    refetchInterval: 15_000,
    queryFn: async ({ signal }): Promise<GrantedPlugins> => {
      const options = { signal, fallback: "Couldn't load this Bot's apps." };
      // Every grant the Bot holds, page after page, so a Bot given a whole large app is read whole.
      const grants = await everyPage(async (cursor) => {
        const page = await listBotGrants(
          organizationId(),
          agentId,
          { limit: 100, ...(cursor ? { cursor } : {}) },
          options,
        );
        return { items: page.grants, nextCursor: page.nextCursor };
      });
      return grantedPluginsOf(grants);
    },
  });
}

/** One of the signed-in person's accounts at an app, as listConnectedAccounts answers it. */
export type BrokeredAccountRecord = {
  /** Which account a Disconnect or Make default press is about. Opaque. */
  id: string;
  /** What the app says the account is: an email address or a login. Null where it said none. */
  identity: string | null;
  /** What the person and their Bots call it: the identity, or "account 2" where there is none. */
  label: string;
  /** The account a Bot uses when it doesn't name one. */
  isDefault: boolean;
  connectedAt: string | null;
};

export type BrokeredAccounts = {
  accounts: BrokeredAccountRecord[];
  /** Whether this app can take another account beside the ones listed. The server decides. */
  canAddAnother: boolean;
};

/**
 * The person's own accounts at one brokered app. The server asks the app each time, so an account
 * connected or ended elsewhere is listed as it stands now.
 */
export function brokeredAccountsQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: pluginKeys.accounts(serverId),
    queryFn: async (): Promise<BrokeredAccounts> => {
      const fallback = "Couldn't list your accounts. Try again in a moment.";
      // Whether another account can be added is the connection's, read beside its accounts.
      const [accounts, connection] = await Promise.all([
        everyPage(async (cursor) => {
          const page = await listConnectedAccounts(
            organizationId(),
            "me",
            serverId,
            { limit: 100, ...(cursor ? { cursor } : {}) },
            { fallback },
          );
          return { items: page.accounts, nextCursor: page.nextCursor };
        }),
        getConnection(organizationId(), "me", serverId, { fallback }),
      ]);
      return { accounts, canAddAnother: connection.canAddAccount };
    },
  });
}
