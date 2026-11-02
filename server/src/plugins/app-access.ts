import { type BrokerProvider, brokeredProvenance } from "./access";
import { schemeKind } from "./broker";
import type { CatalogueEntry } from "./catalogue";

/**
 * Whether one person can use one work app through one Bot, and if not, what the next step is and
 * whose it is.
 *
 * WHY THIS EXISTS AS ONE ANSWER. Every fact it reads already had a home: whether the app is
 * enabled is a row in `mcp_servers`, whether the broker is configured is a key in the environment,
 * whether the Bot holds the app is `plugin_grants`, whether the person connected is
 * `brokered_connections` or `mcp_user_credentials`, and whether a Shared app has its team account
 * is a deployment row in `brokered_connections`. Each screen that wanted to say "you can use this"
 * re-derived it from whichever of those it had loaded, and the Bot page had none of the
 * connection facts at all — so it listed what a Bot holds with no word about whether the person
 * looking could use any of it. Resolved here, once, from the same tables every gate reads, and sent
 * to the browser as a word it draws rather than a rule it recomputes.
 *
 * NOTHING HERE ASKS A VENDOR. "Connected" is what this deployment last recorded — the `verified`
 * and `probe` columns a connect or a re-check wrote, the `revoked_at` a withdrawal set — exactly
 * as `GET /api/plugins/connections` reports it. A connection that died at the vendor since then
 * reads as `ready` until the next call or re-check finds out; asking the vendor on every page load
 * would be a network call per app per person per render, which is the cost those columns exist to
 * avoid.
 */

/**
 * The eight things a person can be told about one app on one Bot.
 *
 * `ready` — usable now, as far as this deployment knows.
 * `not_connected` — enabled and held, and this app is used under each person's own account, which
 * this person has not connected. Theirs to fix.
 * `reconnect` — they connected once, and the connection is withdrawn or its key was refused. Theirs
 * to fix.
 * `shared_not_connected` — a Shared app whose one team account is not connected, or whose key was
 * refused. Only an administrator can connect it.
 * `shared_not_approved` — a Shared app whose team account is connected, on a Bot that reaches more
 * people than an administrator approved for that account. Every call is refused by the shared-use
 * gate, which files the administrator's request itself; nothing is left for a press to ask.
 * `disabled` — switched off at the deployment: no row, the broker not configured, or an app that
 * still needs something only an administrator can supply.
 * `not_granted` — enabled, and this Bot holds none of its tools. Only an administrator can grant.
 * `owner_grantable` — enabled, this Bot holds none of its tools, and the person looking owns the Bot
 * and may give it the app themselves, because the app's rule ({@link ownerGrantsOf}) lets owners
 * decide. Theirs to do, so nothing is filed.
 */
export const APP_ACCESS_STATES = [
  "ready",
  "not_connected",
  "reconnect",
  "shared_not_connected",
  "shared_not_approved",
  "disabled",
  "not_granted",
  "owner_grantable",
] as const;

export type AppAccessState = (typeof APP_ACCESS_STATES)[number];

/** What an administrator would be asked to do. See `app_access_requests`. */
export type AppAccessRequestKind = "enable" | "grant" | "connect_shared";

/**
 * Which request each state files, and null where the next step is the person's own.
 *
 * A TABLE RATHER THAN A BRANCH, so the compiler asks the question again for any state added later.
 * The browser never names a kind: it asks for access, and the server files the kind this table
 * names for the state it computed.
 */
export const REQUEST_KIND_FOR: Record<
  AppAccessState,
  AppAccessRequestKind | null
> = {
  ready: null,
  not_connected: null,
  reconnect: null,
  shared_not_connected: "connect_shared",
  shared_not_approved: null,
  disabled: "enable",
  not_granted: "grant",
  owner_grantable: null,
};

/**
 * Who may give an app to a Bot: the Bot's owner, for their own Bot (`any`), or only an
 * administrator (`admin`). See `mcp_servers.owner_grants`.
 */
export type OwnerGrants = "any" | "admin";

/** Whose account the app's calls land in. */
export type AppAccount =
  /** Each person's own, which each person connects. */
  | "personal"
  /** One team account the deployment holds, which only an administrator connects. */
  | "shared"
  /** No person's account: a deployment token, a server added by URL, or no credential at all. */
  | "deployment";

/**
 * How the account is connected, for the screen that starts it: the deployment's own OAuth flow, a
 * broker's consent screen, a broker's key form, or nothing to connect.
 */
export type AppConnect = "oauth" | "consent" | "key" | null;

/**
 * Where the app comes from, which decides what enabling it takes.
 *
 * A BROKERED APP IS NAMED BY ITS BROKER, `composio` or `arcade`, and every rule below asks
 * {@link brokeredProvenance} rather than comparing to one of them, so the two are read alike.
 */
export type AppProvider = BrokerProvider | "catalogue" | "custom";

/** One app as the Bot page and the chat card draw it. */
export type AppAccess = {
  /** The server id the app has, or the one enabling it would mint. What a request names. */
  key: string;
  /**
   * The app's own name — "Gmail", never "Composio Gmail" and never a humanised `composio-gmail`.
   * A brokered row's title is the directory's name for the app; a catalogue row's is the entry's.
   */
  displayName: string;
  logo: string | null;
  provider: AppProvider;
  account: AppAccount;
  connect: AppConnect;
  /** The row's recorded scheme, for a brokered app; null otherwise. */
  authScheme: string | null;
  /** The app's mode, off its answering row; null for an app that is not brokered. */
  accountMode: "personal" | "shared" | null;
  state: AppAccessState;
  /** Why nobody can use the app, when `state` is `disabled`; null otherwise. See {@link Unavailable}. */
  unavailable: Unavailable | null;
  /**
   * Whose own account a personal app's calls go out on for this person: theirs, or — on somebody
   * else's published Team Bot whose owner connected the app — the owner's, which only the owner can
   * reconnect. Null where the app is not used under a person's own account.
   *
   * THE SAME ANSWER `credentialActorFor` GIVES A CALL, read without its side effects: the owner's
   * account wherever the owner has one, and otherwise the person's own.
   */
  accountHolder: "you" | "owner" | null;
  /**
   * Whether the first call on the person's own account through somebody else's Team Bot will stop
   * to ask them to allow it, because they have given that Bot no standing consent. The state is
   * still `ready`: the question is asked in the conversation, and answering it is the next step.
   */
  asksFirst: boolean;
  /** Whether this Bot holds any of the app's tools. */
  granted: boolean;
  /** Who may give the app to a Bot, with the default for its account filled in. */
  ownerGrants: OwnerGrants;
  /**
   * Whether every grant this Bot holds on the app was made by the Bot's owner, and so may be taken
   * back by them too. False where the Bot holds nothing, or where an administrator gave any of it.
   */
  givenByOwner: boolean;
  /**
   * Whether giving the app to the Bot (`owner_grantable`) has to start with connecting the person's
   * own account, because the app runs on it and they have none, or one the vendor refused. False in
   * every other state.
   */
  needsConnect: boolean;
  /**
   * When the account this app runs in for this person was connected — their own, or the team's for
   * a Shared app — and null where none is, or where no account is involved.
   *
   * FOR THE ONE FACT THE STATE CANNOT ALWAYS CARRY. The call that finds an account lost at the
   * vendor now deletes its row, so the state says so itself from then on; a refusal written before
   * that, over a row that still stands, reads `ready` here and its card says Reconnect anyway. This
   * is how that card tells "lost since the refusal" from "connected again since the refusal": a
   * connection newer than the refusal is the reconnection, and the live state wins.
   */
  connectedAt: string | null;
  /** The request a press of Request access files for this state, and null where there is none. */
  requestKind: AppAccessRequestKind | null;
  /**
   * This person's pending request for exactly that kind, if they already asked. A pending request
   * of another kind is left out: it asks for something this state no longer needs.
   */
  request: { id: string; kind: AppAccessRequestKind; createdAt: string } | null;
};

/**
 * Everything the state is decided from, gathered by the store. Each field is a fact some table
 * already holds; nothing here is a judgement.
 */
export type AppAccessFacts = {
  provider: AppProvider;
  /** Whether a row stands for the app at all. */
  present: boolean;
  /** Whether this deployment has its broker's key, for a brokered app. */
  composioConfigured: boolean;
  /** The scheme the app's answering row records, for a brokered app. */
  authScheme: string | null;
  accountMode: "personal" | "shared" | null;
  /** The catalogue entry's auth, for an app this deployment ships. */
  catalogueAuth: CatalogueEntry["auth"] | null;
  /** Whether the row holds a credential: the OAuth client, or the deployment's token. */
  hasCredential: boolean;
  granted: boolean;
  /** The app's `owner_grants` column, null where an administrator never chose. */
  ownerGrants: OwnerGrants | null;
  /**
   * Whether the person asking may give their own apps to this Bot: they own it (a Bot with no owner
   * — a package's public Bot — is nobody's to give to), and no administrator has switched the
   * feature off for them. Whether THIS app may be given is {@link ownerGrantsOf}'s answer, not this.
   */
  mayGiveOwn: boolean;
  /** This person's own connection, or null where they have none. */
  personal: { usable: boolean } | null;
  /** The deployment's account at a Shared app, or null where none is connected. */
  shared: { usable: boolean } | null;
  /**
   * Whether the shared-use gate would let this person's calls through this Bot reach the team
   * account, or null where nobody asked — no person named, or not a Shared app.
   */
  sharedAdmitted: boolean | null;
};

/** The facts that say whose account an app runs on, and so what its owner rule defaults to. */
type AccountFacts = Pick<
  AppAccessFacts,
  "provider" | "authScheme" | "accountMode" | "catalogueAuth"
>;

/** Whose account, from the same facts `accessFor` resolves a call with. */
export function accountOf(facts: AccountFacts): AppAccount {
  if (brokeredProvenance(facts.provider)) {
    if (schemeKind(facts.authScheme) === "none") return "deployment";
    return facts.accountMode === "shared" ? "shared" : "personal";
  }
  if (facts.provider === "catalogue")
    return facts.catalogueAuth?.kind === "user-oauth"
      ? "personal"
      : "deployment";
  return "deployment";
}

/**
 * Who may give this app to a Bot: what an administrator chose, or the default for its account.
 *
 * OWNERS DECIDE BY DEFAULT ONLY WHERE THE APP RUNS ON THE ASKER'S OWN ACCOUNT. A Bot given somebody's
 * Gmail by its owner reads, for anybody else who talks to it, that person's own Gmail and nothing
 * more — so letting the owner decide hands nobody anything they did not already have. The built-in
 * Routines have no account at all and run as whoever scheduled them, the same shape, and "every
 * morning…" has to work on a Bot made five minutes ago. Everything else reaches one account that is
 * not the asker's — the deployment's token, a Shared team account, a server that needs no credential
 * and so answers everybody alike — and giving a Bot that is an administrator's decision until an
 * administrator says otherwise.
 */
export function ownerGrantsOf(
  facts: AccountFacts & { ownerGrants: OwnerGrants | null },
): OwnerGrants {
  if (facts.ownerGrants) return facts.ownerGrants;
  if (facts.catalogueAuth?.kind === "builtin") return "any";
  return accountOf(facts) === "personal" ? "any" : "admin";
}

export function connectOf(facts: AppAccessFacts): AppConnect {
  if (brokeredProvenance(facts.provider)) {
    const kind = schemeKind(facts.authScheme);
    return kind === "consent" || kind === "key" ? kind : null;
  }
  return facts.catalogueAuth?.kind === "user-oauth" ? "oauth" : null;
}

/**
 * Whether the deployment has what it needs for anybody to use the app, before any grant or
 * connection is asked about; null when it does, and the reason when it does not.
 *
 * THE REASONS ARE THE ONES APPROVING AN `enable` REQUEST HAS TO ANSWER, so the approve route reads
 * this too and refuses with the step that is missing rather than recording an approval nothing
 * changed.
 */
export type Unavailable =
  | "absent"
  | "composio_unconfigured"
  | "scheme_unreadable"
  | "oauth_client_missing"
  | "token_missing";

export function unavailableReason(facts: AppAccessFacts): Unavailable | null {
  if (!facts.present) return "absent";
  if (brokeredProvenance(facts.provider)) {
    if (!facts.composioConfigured) return "composio_unconfigured";
    if (schemeKind(facts.authScheme) === "unreadable")
      return "scheme_unreadable";
    return null;
  }
  const auth = facts.catalogueAuth;
  if (auth?.kind === "user-oauth") {
    /*
     * A client that registers itself on first use is ready the moment the row exists; a manual
     * one waits for an administrator to paste it in, and until then nobody can connect — the
     * connect route answers that with the same sentence for everybody.
     */
    if (auth.clientRegistration !== "dynamic" && !facts.hasCredential)
      return "oauth_client_missing";
    return null;
  }
  if (auth?.kind === "deployment-bearer" && !facts.hasCredential)
    return "token_missing";
  return null;
}

/**
 * The rule, in the order a person meets the obstacles: the deployment first, then the Bot, then
 * the account — and, for a team account, whether this Bot's audience was approved for it.
 *
 * A KEY THE VENDOR REFUSED READS AS `reconnect`, AND AN UNCHECKED ONE AS `ready`. The store
 * reduces each connection to `usable` the way `brokeredConnectionsFor` sets out its four states: a
 * probe that ran and was refused is a dead key; no probe at all is a key accepted without being
 * tried, which is exactly what the settings page says about it too.
 */
export function appAccessState(facts: AppAccessFacts): AppAccessState {
  if (unavailableReason(facts) !== null) return "disabled";
  if (!facts.granted)
    return facts.mayGiveOwn && ownerGrantsOf(facts) === "any"
      ? "owner_grantable"
      : "not_granted";
  const account = accountOf(facts);
  if (account === "deployment") return "ready";
  if (account === "shared") {
    if (!facts.shared?.usable) return "shared_not_connected";
    return facts.sharedAdmitted === false ? "shared_not_approved" : "ready";
  }
  if (!facts.personal) return "not_connected";
  return facts.personal.usable ? "ready" : "reconnect";
}
