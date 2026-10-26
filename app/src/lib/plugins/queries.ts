import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
// This import closes a cycle: `./provider-vocabulary` imports `pluginsProvider` from this file.
// It is safe for one reason, and the reason is the rule. Both live bindings that cross it —
// `directoryReadFailure` here, `pluginsProvider` there — are `export function` declarations,
// which are fully initialised during module instantiation, so neither can be caught in the
// temporal dead zone whichever module evaluates first; and both are only ever called from inside
// a function body (a `queryFn`, `directoryRouteDecision`), long after both modules have finished
// evaluating. Nothing may call across this import at module scope. A
// `const X = directoryReadFailure("...")` at the top level of this file would reach `VOCABULARY`,
// a lexical `const` in the other module, mid-evaluation: it throws under one evaluation order and
// not the other, so it can pass every test and still fail in a production bundle.
import {
  directoryReadFailure,
  type PluginsProvider,
} from "./provider-vocabulary";

/**
 * Re-exported, not re-declared.
 *
 * The field list is asked for by a POST, so it lives beside its only producer in `./mutations` —
 * a second copy here would be free to drift from the shape that write actually returns.
 */
export type { BrokerField } from "./mutations";

/** A tool one server offers, as the Plugins page sees it. */
export type PluginTool = {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `<serverId>/<name>`. What a grant names. */
  ref: string;
  /** Whether it changes something. Anything not positively known to be a read is a write. */
  effect: "read" | "write";
  /**
   * Whether the vendor warns that it destroys something.
   *
   * Beside {@link effect} rather than folded into it: the rule engine judges reads and writes and
   * gains nothing from a third value, while a person deciding whether to switch an action on is
   * asking a different question. Recorded from the vendor's own labels, so false is an absence of a
   * claim rather than a claim of safety.
   */
  destructive: boolean;
  grantedTo: string[];
};

/**
 * A grant on a tool this server does not currently advertise.
 *
 * Held and not offered: nothing reaches a model, because a Bot is told about a tool only when the
 * grant and the tool list agree. That is a fact about what the vendor advertises today, not about the
 * grant, so it is reported rather than quietly dropped — a connector that starts advertising the name
 * again offers it again.
 */
export type WithdrawnGrant = {
  /** `<serverId>/<toolName>`. What a grant names, and what an administrator revokes. */
  ref: string;
  name: string;
  grantedTo: string[];
};

export type PluginServer = {
  id: string;
  title: string;
  logo?: string | null;
  vendor: string;
  url: string;
  summary: string;
  docsUrl: string;
  /** `first-party` for a reviewed entry, `custom` for one an administrator added by URL. */
  provenance: string;
  hasCredential: boolean;
  toolsRefreshedAt: string | null;
  lastError: string | null;
  /**
   * What the last refresh left out for its names. A warning: the rest were stored. Optional because
   * a server replica older than this field does not send it, mid-rollout.
   */
  skippedTools?: string[];
  addedBy: string | null;
  /**
   * Whether this server registers its own OAuth client (RFC 7591) rather than waiting on an
   * administrator to paste one in.
   */
  dynamicClient: boolean;
  /**
   * How this server's authorization config was CREATED, for the brokered rows that have one.
   *
   * What was written down when somebody enabled the app, not what the catalogue publishes today.
   * The catalogue is the vendor's, and an app it starts advertising under a different scheme has
   * not moved the config this deployment already created — so a screen deciding what a live
   * connection does reads this and never a fresh listing. The vocabulary is the vendor's own scheme
   * literals (`OAUTH2`, `DCR_OAUTH`, `API_KEY`, `NO_AUTH`, and the rest), so it is a string rather
   * than a union this page would have to keep level with Composio's.
   *
   * Null is not an older brokered row. It is a row that is not brokered at all.
   */
  authScheme: string | null;
  tools: PluginTool[];
  /** Empty for a healthy connector. See {@link WithdrawnGrant}. */
  withdrawn: WithdrawnGrant[];
  /**
   * Whether this app is PERSONAL, held one credential per person, or SHARED, with a single
   * deployment-held account that every Bot holding a grant acts as. Null for a server that has
   * never been asked, which reads as personal everywhere today.
   *
   * What a row's {@link PluginConnection.holder} is checked against, and the only place that
   * distinction is decided — a connection row never switches an app between the two on its own.
   */
  accountMode: "personal" | "shared" | null;
  /**
   * Whether a Shared app's one deployment-held account is connected yet.
   *
   * Asked of the server rather than read off the connections list, because a Shared app with
   * nothing connected is not an absence from that list — see `GET /connections`, which lists it
   * anyway so it can be offered a Connect action. Meaningless, and always false, while
   * {@link accountMode} is not `"shared"`.
   */
  sharedVendorConnected: boolean;
  /**
   * Who may give this app to a Bot: any Bot's owner, for their own Bot (`any`), or only an admin
   * (`admin`), with the default for its account filled in. Every person's own account defaults to
   * `any`, as do the built-in Routines; everything else to `admin`.
   */
  ownerGrants: "any" | "admin";
  /** What an admin chose, or null where the default is in force. */
  ownerGrantsChosen: "any" | "admin" | null;
};

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

export type CatalogueItem = {
  key: string;
  title: string;
  vendor: string;
  summary: string;
  docsUrl: string;
  /**
   * Whose credential reaches this server.
   *
   * `deployment-bearer` is a token an administrator holds for everybody, and the only one this page
   * can collect. `user-oauth` is reached as whoever is asking, so each person connects their own
   * account and there is no token to type here. `builtin` is a first-party capability that runs
   * inside this deployment — there is nothing to connect and nothing to type.
   */
  auth: "none" | "deployment-bearer" | "user-oauth" | "builtin";
  /** True for a vendor that gives every customer their own hostname. */
  perInstance: boolean;
};

/** One app in Composio's directory, as the picker shows it. */
export type ComposioApp = {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  /** The size of the decision, shown before enabling. */
  actionCount: number;
  /**
   * How many of those actions the provider classified, how many distinct non-empty scope sets they
   * ask for, and how many carry a scope at all — three more facts of the size-of-the-decision kind.
   *
   * REQUIRED AND NULLABLE, NEVER OPTIONAL, AND NOTHING HERE WRITES `?? 0`. `0` means measured and
   * none, so the coverage warning fires; `null` means the provider does not publish it, so the page
   * says nothing. An optional field makes those the same shape at the call site, and the natural
   * `?? 0` fires a coverage warning on a Composio deployment — a false alarm at exactly the moment
   * somebody is deciding whether to trust an app.
   *
   * An action with no scopes is not its own permission: it is covered by any approval at all, so it
   * joins no group. `scopedActionCount` is what keeps `permissionCount: 1` over two actions from
   * reading as one permission covering both.
   */
  classifiedCount: number | null;
  permissionCount: number | null;
  scopedActionCount: number | null;
  enabled: boolean;
};

export type PluginsPage = {
  catalogue: CatalogueItem[];
  servers: PluginServer[];
  skills: PluginSkill[];
  /**
   * Whether a Bot holding no credential of its own can still call a tool back.
   *
   * True when the deployment has a shared secret configured for it. A grant decides whether a tool
   * is offered to a model at all; this decides whether the call it makes can be authenticated. With
   * neither this nor a credential issued to the Bot, every call is refused before it reaches the
   * grant, the boundary or the audit trail, which is not something a grant switch can show.
   */
  botsMayCallBack: boolean;
  /**
   * The redirect URI to register with a `user-oauth` vendor, exactly as this deployment will send it.
   *
   * From the server rather than assembled here, because it has to match what was registered
   * character for character. Null when the deployment has no public URL and so cannot complete a
   * consent flow at all.
   */
  redirectUri: string | null;
  /**
   * Whether this deployment has Composio configured.
   *
   * A boolean about configuration and never the key: the page needs to know whether the directory
   * can be browsed at all, and that question is answerable without the API key ever leaving the
   * server.
   */
  composioConfigured: boolean;
  /**
   * Whether this deployment's broker authorizes ONE ACTION AT A TIME.
   *
   * A DECLARED CAPABILITY, read with a presence test and never a vendor name. The server computes
   * it from the very expression `/servers/:id/authorize` and the `/arcade/verify` return leg gate
   * on, so a screen that draws the per-action grant list and the routes that serve its buttons
   * cannot key on different facts. Gating on `provider === "arcade"` instead left a broker named
   * arcade whose flow is absent drawing a list whose every Authorize press 503s.
   *
   * Required, like `composioConfigured` and unlike `provider`: a capability is a value the server
   * declares, so the type does not offer "did not say" as a third answer. False on Composio, whose
   * auth config fixes one state for a whole toolkit, so a Composio deployment is unchanged.
   */
  authorizesPerAction: boolean;
  /**
   * Which vendor brokers this deployment's apps, as a NAME. Read it through {@link pluginsProvider}.
   *
   * A screen that FILTERS by brokered-ness needs no provider name: one provider holds rows at a
   * time (spec D3), which is why `brokeredAccountsListedOn` is a predicate over `provenance`. A
   * screen that NAMES a vendor ("Browse Composio", the `/admin/plugins/composio` route,
   * `COMPOSIO_API_KEY`, "Reached through Composio") cannot derive that name from a row, and this
   * field is the only thing that answers it. Separate from `composioConfigured`, which asks whether
   * the directory can be browsed at all.
   *
   * A name, never a key and never a capability: nothing about the vendor key travels with it.
   * Optional because a payload from an older server does not carry it.
   */
  provider?: "composio" | "arcade";
};

/**
 * The provider a payload names, `"composio"` when the server did not say.
 *
 * So a Composio deployment renders byte-identically and a page served by an older server does not
 * blank. Also `"composio"` before the page has loaded.
 */
export function pluginsProvider(
  page: PluginsPage | undefined,
): "composio" | "arcade" {
  return page?.provider ?? "composio";
}

/** What one Bot holds, which is all the runtime needs to offer it. */
export type GrantedPlugins = {
  tools: {
    ref: string;
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

export const pluginKeys = {
  all: ["plugins"] as const,
  page: () => ["plugins", "page"] as const,
  forAgent: (agentId: string) => ["plugins", "for-agent", agentId] as const,
  connections: () => ["plugins", "connections"] as const,
  siblings: (serverId: string) => ["plugins", "siblings", serverId] as const,
  composioApps: (query: string) =>
    ["plugins", "composio", "apps", query] as const,
};

/**
 * One account this person has connected, from their own point of view.
 *
 * DELIBERATELY NON-UNIFORM, because `/api/plugins/connections` concatenates two reads: connections
 * held in this deployment's own vault, and brokered ones Composio keeps on our behalf. The fields a
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
   * Whose account this row is: the signed-in person's own, or the one standing account of a Shared
   * app (see {@link PluginServer.accountMode}) that every Bot holding a grant acts as regardless of
   * who is asking. Undefined on a shape written before the distinction existed, which reads as
   * `"person"` — see {@link personalConnections}, which is what a screen asking "is this mine" reads
   * through rather than comparing against the literal.
   */
  holder?: "person" | "deployment";
  /**
   * Whether the deployment's one shared account is connected, present only on a DEPLOYMENT row.
   *
   * A Shared app's row is listed even when nothing is connected to it yet — see
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
   * It is NOT how a reader learns how an app connects. That comes from {@link PluginServer.authScheme}
   * on the server, and a page deriving it from a connection row instead would be a second answer to
   * a question already carried.
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
  redirectUri: string | null;
};

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
      const response = await client("/api/plugins/connections", {
        fallback: "Couldn't load your connections.",
      });
      return response.json();
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
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connection/siblings`,
        {
          fallback: "Couldn't read which other apps share this connection.",
        },
      );
      const body: Partial<ConnectionSiblings> = await response.json();
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

export function pluginsPageQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.page(),
    queryFn: async (): Promise<PluginsPage> => {
      const response = await client("/api/plugins", {
        fallback: "Plugins could not be loaded.",
      });
      return response.json();
    },
  });
}

/**
 * The active broker's app directory, narrowed by a search term.
 *
 * The term goes to our own endpoint because the vendor's client drops a search parameter and
 * answers with an unfiltered page, so filtering has to happen somewhere that admits to doing it.
 */
export function composioAppsQueryOptions(
  query: string,
  provider: PluginsProvider,
) {
  return queryOptions({
    queryKey: pluginKeys.composioApps(query),
    queryFn: async (): Promise<{ apps: ComposioApp[] }> => {
      const response = await client(
        `/api/plugins/composio/apps?q=${encodeURIComponent(query)}`,
        { fallback: directoryReadFailure(provider) },
      );
      return response.json();
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
    queryFn: async (): Promise<GrantedPlugins> => {
      const response = await client(
        `/api/plugins/for/${encodeURIComponent(agentId)}`,
        { fallback: "Couldn't load this Bot's apps." },
      );
      return response.json();
    },
  });
}
