import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
} from "../computer/policy";
import {
  type CredentialExecutor,
  type CredentialSecretReader,
  type CredentialStore,
  decryptCredentialForUse,
  decryptSecret,
  encryptSecret,
} from "../credentials";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  // Aliased: `credentials` is already the injected vault interface in this module, and the table and
  // the interface are two different things to reach for.
  credentials as credentialRows,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  skills,
  skillTools,
} from "../db/schema";
import {
  type CatalogueEntry,
  catalogueEntry,
  classifyTool,
  customUrlRefusal,
  resolveServerUrl,
  serverCredentialKind,
} from "./catalogue";
import { McpServerError } from "./mcp";
import { registerDynamicClient } from "./oauth";
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

/**
 * What a grant is a grant OF.
 *
 * `bot` is one Bot's permission to hand work to another, and it lives here rather than in a table of
 * its own on purpose: an administrator already understands "this Bot may use that", a fork's policy
 * layer already applies to grants, and reachability between Bots is the same kind of decision as
 * reachability to a vendor's tools. A second table would be a second thing to reason about and a
 * second thing for a fork to reimplement.
 */
export type PluginKind = "mcp" | "skill" | "bot";

/**
 * What an audit row about a grant is a row ABOUT.
 *
 * A mapping rather than a ternary, because a ternary quietly labelled everything that was not an MCP
 * tool a skill. Adding a third kind made that wrong rather than merely terse: a grant letting one Bot
 * address another would have been filed in the trail as a skill, which is the sort of small lie an
 * investigation trips over months later.
 */
function grantTargetType(kind: PluginKind): string {
  if (kind === "mcp") return "mcp_tool";
  if (kind === "bot") return "agent";
  return "skill";
}

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

/**
 * A grant naming a tool this server does not currently advertise.
 *
 * Held and not offered. `listForAgent` reads the grant against the tool list, so nothing reaches a
 * model — but that is a property of what the vendor is advertising today rather than of the grant, and
 * it changes the moment the vendor advertises the name again. Google's Drive entry says so in its own
 * comment: the REST transport is one line from being swapped back to MCP, and "tool names match
 * Google's MCP server exactly, so grants survive the swap in either direction".
 *
 * So it is reported rather than pruned. A grant is the record of a decision somebody made, and the
 * refresh that would have deleted it is not a safe place to decide from: the tool list is replaced by
 * a `delete` and then an `insert`, and a vendor answering with an empty list is a success, so one bad
 * answer would revoke every grant on that server and stamp the refresh as healthy.
 */
export type WithdrawnGrant = {
  /** `<serverId>/<toolName>`, exactly as the grant is stored. */
  ref: string;
  /** The tool half, for a screen that already has the server. */
  name: string;
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
  /**
   * Whether the catalogue entry registers its own OAuth client (RFC 7591) rather than waiting on
   * an administrator to paste one in. So the admin screen can hide the paste-a-client form where
   * there is nothing for it to collect.
   */
  dynamicClient: boolean;
  tools: ToolRecord[];
  /**
   * Grants on tools this server no longer advertises.
   *
   * Empty for a healthy connector. Non-empty is the discrepancy an administrator should be reading
   * about, which is why it is here rather than inferred by a screen comparing two lists.
   */
  withdrawn: WithdrawnGrant[];
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
  /**
   * The tools this skill says it needs, as `<serverId>/<toolName>` refs.
   *
   * A declaration, not a grant: what a Bot may call is `grantedTo` on the tool side and nothing here.
   * See the comment on `skillTools` in the schema for why that separation is load-bearing.
   */
  tools: string[];
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
    /**
     * What this skill says it needs, as refs. Never a superset of `tools` above in effect: selection
     * intersects the two, because a skill naming a tool the Bot lacks must load nothing rather than
     * make it callable.
     */
    tools: string[];
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
 * The vendor's `error` code, when a token endpoint refuses an exchange.
 *
 * {@link INVALID_CLIENT} is the one code this module ACTS on rather than reports, so it has to
 * survive as a value. It used to travel inside the sentence, which meant the recovery in
 * {@link createPluginStore}'s `refuseAndReplaceEvictedClient` hung on a substring of prose written for a
 * person to read: rewording the sentence — translating it, dropping the parenthesis — would have
 * turned self-registration off with every test still green. A field cannot be reworded by accident.
 */
export class TokenRefusedError extends McpServerError {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "TokenRefusedError";
  }
}

/**
 * The vendor saying the CLIENT is the problem, rather than the grant. RFC 6749 §5.2.
 *
 * Told apart from every other refusal because it is the only one a deployment can do anything about
 * on its own: a client it issued to itself, it can issue again.
 */
export const INVALID_CLIENT = "invalid_client";

/**
 * A transaction, as the writes in this module hand one to each other.
 *
 * Named because two writes here are one decision — a secret in the vault, and the pointer that says
 * what it is for — and the only way to say that is to run both on the same executor. `select`,
 * `insert` and `update` alone would do for {@link CredentialExecutor}; this needs `execute` too, for
 * the advisory lock that serialises the client path.
 */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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

/**
 * Advertised tool names this deployment's write list does not name, where that list is the whole
 * barrier.
 *
 * WHY THIS IS WORTH A ROW. {@link classifyTool} reads an advertised name absent from `writeTools` as
 * a READ. So under-inclusion is the failure mode of that list, and it is silent: a write the vendor
 * offers and the entry forgot is offered to a model as a read, and nothing anywhere says so. Notion's
 * entry says reconciling its list against the live tool list "is required, not cosmetic" — this is
 * the mechanical half of that, so the reconciliation is somebody reading a trail rather than somebody
 * remembering.
 *
 * Only where the list stands alone. A vendor that expresses SCOPES has something behind the list: a
 * tool missing from Drive's `writeTools` still cannot write, because `drive.readonly` refuses it at
 * the vendor. Naming those would be noise in front of the one case that has no second barrier at all
 * — Notion, whose access is per-page on a consent screen and whose `scopes` are therefore empty.
 *
 * A server with no catalogue entry is not reconciled either, and for the opposite reason: nothing
 * reviewed says any tool of theirs only reads, so all of them are already writes.
 *
 * Sorted, so two readings of the same listing produce the same row.
 */
export function unlistedAdvertisedTools(
  entry: CatalogueEntry | null,
  advertised: readonly string[],
): string[] {
  if (!entry || entry.writeTools.length === 0) return [];
  if (entry.auth.kind !== "user-oauth" || entry.auth.scopes.length > 0) {
    return [];
  }
  const writes = new Set(entry.writeTools);
  return advertised.filter((name) => !writes.has(name)).sort();
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
 * `builtin` is the third case and the only one with no credential at all, so it answers for itself:
 * Routines touches the asker's own rows and says so, while Mailbox opens one mailbox belonging to
 * the deployment and says that instead. The entry decides, rather than this expression guessing from
 * the kind, because a builtin reached as the deployment but recorded as the asker would put
 * somebody's id on a row describing access that was never theirs.
 */
const reachedAsFor = (
  entry: CatalogueEntry | null,
  actorId: string,
): string => {
  if (entry?.auth.kind === "user-oauth") return actorId;
  if (entry?.auth.kind === "builtin") {
    return entry.auth.reachedAs === "actor" ? actorId : "deployment";
  }
  return "deployment";
};

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
 * The vendor's error body is deliberately not passed through — it is written for whoever registered
 * the client, not for the person who asked a Bot a question, and it can name the client id. Its
 * `error` CODE is, though, and only that: `invalid_client` is what tells a client the vendor has
 * forgotten apart from a grant somebody withdrew, and those two have entirely different answers.
 * It goes out as a field on {@link TokenRefusedError} as well as in the sentence, because the field
 * is the copy the recovery reads.
 *
 * Exported for its own tests rather than for a caller. Every path through the store reaches it as
 * the default `exchangeRefreshToken`, and the store's own suites inject a stub in its place — which
 * leaves what this function does with a REAL vendor reply, honest or garbled, untested unless it can
 * be called directly.
 */
export async function exchangeRefreshTokenOverHttp(input: {
  tokenUrl: string;
  client: OAuthClient;
  refreshToken: string;
}): Promise<AccessToken> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.client.clientId,
  });
  // A public (DCR) client proves itself without one, and some vendors refuse an unexpected empty
  // field outright. The same guard the authorization-code redemption in `oauth.ts` uses.
  if (input.client.clientSecret) {
    params.set("client_secret", input.client.clientSecret);
  }

  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!response.ok) {
    /*
     * The code, when the refusal is JSON and carries one. Read defensively: a token endpoint that
     * is refusing may be refusing with an HTML error page, and a parse failure here would replace
     * the vendor's status — the one fact we do have — with a syntax error.
     */
    const refusal = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    /*
     * Capped where it is read, because everything downstream of here shows it to somebody: the
     * person who asked, the model, the connector's `lastError` on the admin page, and an audit
     * payload. It is a short token in the protocol and vendor-controlled in fact, and nothing on
     * those paths is a promise about length.
     */
    const code =
      typeof refusal?.error === "string" ? refusal.error.slice(0, 64) : null;
    throw new TokenRefusedError(
      `The vendor would not renew this access (${response.status}).${code ? ` (${code})` : ""}`,
      code,
    );
  }

  /*
   * A 200 is not a promise of JSON, and this branch used to read it as one.
   *
   * The refusal above already parses defensively; the success branch did not, so a CDN interstitial
   * or a maintenance page answering 200 with HTML threw a SyntaxError from here — out through
   * `callTool`, which records the failure with the thrower's message, and the parser's message
   * quotes the body it choked on. So a vendor's HTML reached an audit payload and the person who
   * asked, as a crash rather than as the refusal every other unusable reply produces.
   */
  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
  } | null;
  if (!body) {
    throw new McpServerError(
      "The vendor answered this renewal with something other than a token.",
    );
  }
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new McpServerError("The vendor renewed this access with no token.");
  }
  return {
    accessToken: body.access_token,
    expiresInSeconds:
      typeof body.expires_in === "number" ? body.expires_in : undefined,
    /*
     * Only when the vendor sent one, and only a non-empty one.
     *
     * A rotating vendor replies with a new refresh token and invalidates the one it was shown; a
     * vendor that does not rotate sends none. Reading an absent or empty field as a rotation would
     * repoint a working connection at nothing.
     */
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token
        ? body.refresh_token
        : undefined,
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

/**
 * The client and when the vault row holding it was written.
 *
 * The date is not about the client: it is how long ago this deployment last introduced itself, which
 * is the one thing that distinguishes a client the vendor has evicted from one a re-registration
 * minted moments ago. Null only for a row that has since disappeared, which the read refuses first.
 */
type StoredClient = { client: OAuthClient; registeredAt: Date | null };

/**
 * How long a freshly stored OAuth client is left alone after `invalid_client`.
 *
 * Re-registering once per refusal is right for one call and wrong for a deployment: a vendor that is
 * simply down answers every exchange `invalid_client`, and every tool call anywhere then mints a
 * client of its own, because each of them is the first refusal IT has seen. A client younger than
 * this was already the product of a re-registration, so registering again inside the window is
 * amplification rather than recovery — the honest answer is the vendor's refusal, unedited.
 */
const CLIENT_REREGISTRATION_BACKOFF_MS = 5 * 60_000;

/** What a vendor's token endpoint gave back for a refresh token. */
export type AccessToken = {
  accessToken: string;
  expiresInSeconds?: number;
  /**
   * The refresh token to present next time, from a vendor that rotates.
   *
   * Absent from Google's replies and present in every one of Notion's. When it is here it is the
   * only one that still works — the token just spent is dead at the vendor — so it has to be
   * persisted before the access token beside it is used for anything.
   */
  refreshToken?: string;
};

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
   *
   * `revoke` is part of it because a key holds at most one live credential now. `removeServer`
   * retires the server's token, and the two write paths here replace rather than add, so re-adding a
   * server or re-authorizing a connection does not meet its own leftover on
   * `credentials_active_key_idx`.
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
    connection: {
      url: string;
      token?: string;
      actorId?: string;
      botId?: string;
    },
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }>;
  /** Trading a refresh token for a short-lived access token. Defaults to a real HTTP exchange. */
  exchangeRefreshToken?: (input: {
    tokenUrl: string;
    client: OAuthClient;
    refreshToken: string;
  }) => Promise<AccessToken>;
  /** RFC 7591 self-registration, for entries whose clientRegistration is dynamic. */
  registerClient?: (input: {
    registrationUrl: string;
    redirectUri: string;
  }) => Promise<OAuthClient | null>;
  /** Where the vendor sends people back; needed to (re)register a dynamic client. */
  redirectUri?: string;
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
  const registerClient = options.registerClient ?? registerDynamicClient;

  /*
   * One exchange at a time per (server, person). A rotating vendor invalidates the refresh
   * token it was shown, so two concurrent calls that both present the old one would have the
   * second refused through no fault of anybody's. The chain serialises them; the map entry is
   * removed when the chain drains so the map cannot grow past the set of active connections.
   */
  const exchangeChains = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = exchangeChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    exchangeChains.set(key, next);
    /*
     * The refusal belongs to the caller, who is holding `next` and will see it. This branch exists
     * only to forget the key, so it swallows before it cleans up: `next.finally(…)` on its own
     * derives a SECOND rejected promise that nobody is holding, and a refused call — a withdrawn
     * credential, say — then surfaces as an unhandled rejection somewhere unrelated.
     */
    void next
      .catch(() => {})
      .finally(() => {
        if (exchangeChains.get(key) === next) exchangeChains.delete(key);
      });
    return next;
  }

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
   * Every MCP grant belonging to these servers, whether or not the tool is still advertised.
   *
   * {@link grantsFor} asks about refs somebody already has, which is the wrong question when the
   * point is to find the ones nothing else knows about: called with the advertised refs it can only
   * ever return a subset of them, so a grant on a withdrawn tool is invisible by construction.
   *
   * Matched on the server half in the query rather than by reading every grant and splitting here.
   * `split_part` rather than a `LIKE` prefix, because a server id is text a person can choose for a
   * custom server and `%` in one would silently widen the match.
   */
  async function mcpGrantsForServers(serverIds: string[]) {
    if (serverIds.length === 0) return new Map<string, string[]>();
    const rows = await database
      .select({ ref: pluginGrants.ref, agentId: pluginGrants.agentId })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "mcp"),
          inArray(sql`split_part(${pluginGrants.ref}, '/', 1)`, serverIds),
        ),
      );
    const byRef = new Map<string, string[]>();
    for (const row of rows) {
      byRef.set(row.ref, [...(byRef.get(row.ref) ?? []), row.agentId]);
    }
    return byRef;
  }

  /** The refs each of these skills declares, keyed by skill id. Skills with none are absent. */
  async function toolsDeclaredBy(skillIds: string[]) {
    if (skillIds.length === 0) return new Map<string, string[]>();
    const rows = await database
      .select()
      .from(skillTools)
      .where(inArray(skillTools.skillId, skillIds))
      .orderBy(asc(skillTools.ref));
    const bySkill = new Map<string, string[]>();
    for (const row of rows) {
      bySkill.set(row.skillId, [...(bySkill.get(row.skillId) ?? []), row.ref]);
    }
    return bySkill;
  }

  /**
   * Which of these refs name a tool this deployment has actually seen.
   *
   * Asked when a skill is saved, so a typo is refused where it was written rather than becoming a
   * skill that quietly selects nothing. Not asked at run time: a refresh deletes and rewrites a
   * server's tool rows, so a ref can be legitimately absent for a moment, and a run must read that as
   * "load nothing" rather than as a failure.
   */
  async function knownToolRefs(refs: string[]) {
    if (refs.length === 0) return new Set<string>();
    // Narrowed in the query to the servers actually named, rather than reading the whole catalogue
    // and filtering here. A deployment aiming at a thousand tools should not scan all of them to
    // check three.
    const servers = [...new Set(refs.map((ref) => ref.split("/")[0] ?? ""))];
    const rows = await database
      .select({ serverId: mcpTools.serverId, name: mcpTools.name })
      .from(mcpTools)
      .where(inArray(mcpTools.serverId, servers));
    const known = new Set(rows.map((row) => `${row.serverId}/${row.name}`));
    return new Set(refs.filter((ref) => known.has(ref)));
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

    /*
     * Whether this person has connected at all, which is a refusal worth reaching before anything
     * queues behind another call. WHICH credential they hold is read again inside the critical
     * section below, because a reconnection can move it while this call waits its turn — and even
     * when the row stays put, the secret inside it does not.
     */
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

    // Held before the critical section, because narrowing does not survive into a closure and this
    // is where the entry is known to be a `user-oauth` one.
    const { tokenUrl } = entry.auth;
    const { title } = entry;
    /*
     * Where to register again, for a vendor that issues its own clients — and undefined for one an
     * administrator registered with by hand, where there is nothing this deployment could do about a
     * client the vendor no longer honours.
     */
    const registrationUrl =
      entry.auth.clientRegistration === "dynamic"
        ? entry.auth.registrationUrl
        : undefined;

    /*
     * What to tell the person when the deployment holds no client they can be called on, in the
     * words of whoever can actually change that.
     *
     * A hand-registered client is an administrator's paperwork — they pasted it in from the vendor's
     * console, and only they can paste one in again. A self-registered one is nobody's paperwork:
     * there is no console entry to re-create, and the deployment introduces itself again the next
     * time somebody connects. Naming an administrator there would send the person to somebody with
     * no step to take, which is worse than saying nothing.
     */
    const noClient = registrationUrl
      ? `${title} has no OAuth client for this deployment, so this cannot be called. Connect ${title} again in Settings: the deployment registers itself with the vendor when somebody connects.`
      : `${title} has no OAuth client registered for this deployment, so this cannot be called. An administrator has to add one.`;
    const unusableClient = registrationUrl
      ? `${title} has no usable OAuth client for this deployment. Connect ${title} again in Settings: the deployment registers itself with the vendor on the next connect.`
      : `${title} has no usable OAuth client for this deployment. An administrator has to add one again.`;
    /**
     * What to say when the vendor has forgotten the client this person's grant was issued under.
     *
     * The same register as the two above, and the same instruction, because it is the same situation
     * from the person's side: nothing they can be called on. What is different is that the
     * deployment CAN do its half — introduce itself again — and has, by the time this is thrown. So
     * the sentence says that too, otherwise "connect again" reads as a thing to keep trying.
     *
     * Their refresh token is not carried across. A grant belongs to the client it was issued to (RFC
     * 6749 §6, §10.4), so re-presenting it under the new client is a request a conforming vendor
     * refuses — and one that only ever appears to work against a vendor whose acceptance would
     * itself be the vulnerability. A new consent is the only thing that produces a usable grant.
     */
    const clientReplaced = `${title} no longer recognises this deployment's OAuth client, so this cannot be called. The deployment has registered itself again — connect ${title} again in Settings.`;

    if (!row.credentialId) {
      // The person did their part; the deployment has not. Refused before anything queues, because
      // a deployment holding no client has the same answer for everybody asking.
      throw new PluginRefusedError(noClient, null);
    }

    /**
     * The client as the deployment holds it right now, or the refusal for holding none.
     *
     * Read from the server row each time rather than from the row this call came in with: a retry
     * that registered again — this connection's own, a moment ago — replaced it, and the pointer
     * carried in from before the queue names the evicted one.
     */
    async function currentClient(): Promise<StoredClient> {
      /*
       * When the client was stored comes back with it, from the vault row itself rather than from a
       * column of our own. It is what the retry below measures its backoff against, and a left join
       * keeps it one query: a server pointing at nothing is the refusal on the next line, and a
       * pointer to a row that is no longer there is `secretFor`'s to refuse.
       */
      const [server] = await database
        .select({
          credentialId: mcpServers.credentialId,
          registeredAt: credentialRows.createdAt,
        })
        .from(mcpServers)
        .leftJoin(
          credentialRows,
          eq(credentialRows.id, mcpServers.credentialId),
        )
        .where(eq(mcpServers.id, row.id))
        .limit(1);
      if (!server?.credentialId) {
        throw new PluginRefusedError(noClient, null);
      }
      return {
        client: JSON.parse(
          await secretFor(server.credentialId, unusableClient),
        ) as OAuthClient,
        registeredAt: server.registeredAt,
      };
    }

    /*
     * The exchange, one call at a time for this connection, reading the connection fresh inside.
     *
     * Both halves of what goes out are read in here rather than carried in from above, because both
     * can move while this call waits its turn. The refresh token rotates, and the token read a
     * moment ago is then already spent — presenting it would be refused by the vendor for no reason
     * the person could act on. The client is replaced by a re-registration, and presenting the
     * evicted one would have every queued call discover that separately and register around it.
     *
     * TWO things serialise this, and they are not redundant. The map above queues calls made in THIS
     * process; the row lock below serialises the whole deployment. Only the lock is a correctness
     * property — a second replica has a map of its own and is not in ours — and the map is what
     * keeps a burst of calls on one connection from piling N transactions onto that one row lock,
     * each of them holding a pooled connection while it waits its turn.
     *
     * An evicted client is handled AFTER the transaction rather than inside it. Nothing about
     * re-registering needs this person's lock — the client is per server — and doing it inside would
     * have a second pooled connection opened while this one holds a row lock, which is the shape the
     * pool note in `db/client.ts` is about.
     */
    return await serialized(`${row.id}:${actorId}`, async () => {
      /*
       * The client, read before the transaction opens rather than inside it.
       *
       * It is per SERVER and is not what the lock protects, and reading it here keeps the vault read
       * off a second pooled connection while this call holds one open for the whole exchange. Still
       * inside the critical section, so the ordering that matters is unchanged: a queued call reads
       * the client after whatever ran before it replaced it.
       */
      const stored = await currentClient();

      /*
       * The vault row, locked for as long as the token it holds is being spent.
       *
       * A rotating vendor kills the refresh token it was shown, so two replicas that both read the
       * stored token and both present it do not merely race: the second presentation looks to the
       * vendor like a stolen token being replayed, and refresh-token-reuse detection answers it by
       * revoking the whole token family. The connection is then bricked, and nobody did anything
       * wrong. `SELECT … FOR UPDATE` is what makes the second replica wait for the first, exactly as
       * a person reconnecting already waits (`credentials.rotate`).
       *
       * Yes, the lock is held across an HTTP call to the vendor — bounded by the exchange's own
       * timeout. That is the point rather than an oversight: the lock IS the cross-replica
       * serialisation, and a lock released before the exchange would serialise nothing.
       *
       * The read comes AFTER the lock, never before. A replica that woke from the lock and used a
       * token it had read on the way in would present the one the first replica just spent, which is
       * the very double-spend this exists to prevent.
       */
      try {
        return await database.transaction(async (transaction) => {
          const [current] = await transaction
            .select({
              credentialId: mcpUserCredentials.credentialId,
              scope: mcpUserCredentials.scope,
            })
            .from(mcpUserCredentials)
            .where(
              and(
                eq(mcpUserCredentials.serverId, row.id),
                eq(mcpUserCredentials.userId, actorId),
              ),
            )
            .limit(1);

          // Disconnected while this call was queued. The same sentence as above: nothing is broken,
          // and connecting again is the thing to do.
          if (!current) {
            throw new PluginRefusedError(
              `You have not connected your ${title} account. Connect it in Settings and ask again.`,
              null,
            );
          }

          const [locked] = await transaction
            .select({
              encryptedValue: credentialRows.encryptedValue,
              revokedAt: credentialRows.revokedAt,
            })
            .from(credentialRows)
            .where(eq(credentialRows.id, current.credentialId))
            .for("update");
          /*
           * A row that is gone or revoked, said the way `secretFor` says it: withdrawn access is
           * nobody's fault and connecting again is the step. Reached by a replica that waited here
           * while somebody disconnected, as well as by one that was told after the fact.
           */
          if (!locked || locked.revokedAt) {
            throw new PluginRefusedError(
              `Your ${title} access was withdrawn. Connect it again in Settings.`,
              null,
            );
          }
          const refreshToken = await decryptSecret(
            encryptionKey,
            locked.encryptedValue,
          );

          const minted = await exchangeRefreshToken({
            tokenUrl,
            client: stored.client,
            refreshToken,
          });

          /*
           * A vendor that sent nothing back, or sent back the token we presented, rotated nothing —
           * and writing either would be inventing a rotation, at the cost of a needless
           * re-encryption of every connection on every call.
           */
          if (minted.refreshToken && minted.refreshToken !== refreshToken) {
            /*
             * The vendor rotated the grant: the token we were just shown is now the only valid one.
             * Persisting it is not optional bookkeeping — failing to would strand the connection on
             * the next call — so a failure here refuses THIS call rather than returning an access
             * token whose refresh token is already spent.
             *
             * In this transaction, so it commits with the lock that made the exchange ours: written
             * outside it, the next replica in line would wake to the token this one just spent.
             */
            await rotateConnectionToken(
              {
                credentialId: current.credentialId,
                refreshToken: minted.refreshToken,
              },
              transaction,
            );
          }

          return { token: minted.accessToken };
        });
      } catch (error) {
        /*
         * Outside the transaction, so the row lock is already released and the vault read this does
         * is not a second connection held behind this one's.
         *
         * Rethrows anything that is not the vendor disowning our client, which is every ordinary
         * failure: a withdrawn grant, a vendor being down, a disconnect mid-queue.
         */
        return await refuseAndReplaceEvictedClient({
          error,
          clientRegisteredAt: stored.registeredAt,
          registrationUrl,
          serverId: row.id,
          refusal: clientReplaced,
        });
      }
    });
  }

  /**
   * The vendor has disowned this deployment's client: fix the deployment, refuse the call.
   *
   * `invalid_client` is the vendor saying the CLIENT is the problem, and for a client the deployment
   * issued to itself there is nobody to tell — no console entry an administrator could re-create, so
   * every connection to that server would otherwise sit behind a refusal nothing here can act on.
   * Introducing itself again is the same act as the first registration, and it is worth doing: it is
   * what makes the next CONSENT possible.
   *
   * IT DOES NOT MAKE THIS CALL POSSIBLE, and this function used to pretend otherwise. It registered a
   * new client and re-presented the same refresh token under it. A refresh token is bound to the
   * client it was issued to — RFC 6749 §6 has the token endpoint verify exactly that, and §10.4 is
   * why — so a conforming vendor refuses the retry, and the only vendor it can work against is one
   * whose acceptance would itself be the vulnerability. So the grant is never carried across, and the
   * person is told the one thing that helps: connect again.
   *
   * The re-registration is still bounded by {@link CLIENT_REREGISTRATION_BACKOFF_MS}, and that bound
   * is the whole protection here rather than a nicety. This runs for any non-admin's tool call, and
   * it REPLACES the client every other connection in the deployment is bound to; a vendor that is
   * simply down answers every exchange `invalid_client`, so without the window one outage would have
   * each call in turn rotate the deployment-wide client. A client younger than the window is the
   * product of the last refusal's re-registration, and is left exactly alone.
   *
   * Always throws. The refusal it raises when it did register is the caller's answer; anything it
   * cannot act on is rethrown untouched, because the vendor's own words are better than ours.
   */
  async function refuseAndReplaceEvictedClient(input: {
    error: unknown;
    /** When the client that was just refused was stored. */
    clientRegisteredAt: Date | null;
    registrationUrl: string | undefined;
    serverId: string;
    /** What to tell the person once the deployment has registered itself again. */
    refusal: string;
  }): Promise<never> {
    const { error, registrationUrl, serverId } = input;
    /*
     * The code, off the error itself. Never the sentence: that is written for a person, and a
     * recovery that read it would be one rewording away from silently never running again.
     */
    const code = error instanceof TokenRefusedError ? error.code : null;
    const { redirectUri } = options;
    if (code !== INVALID_CLIENT || !registrationUrl || !redirectUri) {
      throw error;
    }

    const registeredAt = input.clientRegisteredAt;
    if (
      registeredAt &&
      Date.now() - registeredAt.getTime() < CLIENT_REREGISTRATION_BACKOFF_MS
    ) {
      throw error;
    }

    const fresh = await registerClient({ registrationUrl, redirectUri });
    // The vendor would not have us either. The first refusal is the one worth reporting: it says
    // what actually stopped the call, where this one says what stopped the recovery.
    if (!fresh) throw error;

    await persistOAuthClient({ serverId, client: fresh, by: "deployment" });
    throw new PluginRefusedError(input.refusal, null);
  }

  /**
   * Point one person's connection at a new refresh token, revoking the one it replaces.
   *
   * For a person connecting, which is where a new row earns its keep: what they held before this is
   * still a live grant at the vendor, and the revocation is how it stops being one. A vendor's own
   * rotation is the other case entirely, and goes through {@link rotateConnectionToken}.
   *
   * Upserted on the pair, so it is the same act whether they are connecting or reconnecting. The
   * credential the row used to point at is revoked in the same breath: a refresh token nothing
   * points at is still a live grant at the vendor, and leaving it behind would mean somebody had two
   * valid grants and could only ever see one of them to withdraw it.
   *
   * Says whether it replaced something, which is the one fact the caller writing the trail needs
   * and cannot recover afterwards.
   *
   * ONE TRANSACTION, because these are two writes and one decision. The secret goes into the vault
   * and the connection row is pointed at it; separately, a failure between them leaves the pointer
   * naming the credential the rotation had just revoked — a connection that reads as live on the
   * settings page and refuses every call, with the person's actual grant retired and no way back to
   * it. `credentials.rotate` and `credentials.create` already accept the caller's executor for
   * exactly this, and the pointer write runs on the same one.
   */
  async function swapUserCredential(input: {
    serverId: string;
    userId: string;
    refreshToken: string;
    scope: string;
  }): Promise<{ replaced: boolean }> {
    const key = {
      kind: "mcp_user_token" as const,
      provider: input.serverId,
      keyId: input.userId,
    };
    const value = {
      ...key,
      metadata: { server: input.serverId, scope: input.scope },
      // Encrypted before the transaction opens: it is arithmetic, and it has no business happening
      // while a pooled connection is held open behind row locks.
      encryptedValue: await encryptSecret(encryptionKey, input.refreshToken),
    };

    return await database.transaction(async (transaction) => {
      /*
       * `credentials_active_key_idx` holds one live credential per key, so a second insert for the
       * same person and server would be refused. Asked of the key rather than of the connection row,
       * because the row can name a credential that has already been revoked while the key itself is
       * free, and it is the key the index constrains.
       */
      const live = await credentials.findLiveByKey(key, transaction);
      const stored = live
        ? await credentials.rotate(
            { ...value, previousCredentialId: live.id },
            transaction,
          )
        : await credentials.create(value, transaction);

      await transaction
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

      return { replaced: live !== null };
    });
  }

  /**
   * Carry a connection over to the refresh token the vendor rotated to.
   *
   * In place, in the vault row the connection already points at — deliberately NOT the swap
   * {@link swapUserCredential} performs. A rotating vendor issues a new refresh token on every
   * exchange, so a swap here would mint a row and revoke a row per tool call, forever, on the
   * hottest path there is. And the revocation would have nothing to withdraw: the token just spent
   * was dead at the vendor the moment it answered, so the only live grant is the one being written.
   *
   * Deliberately WITHOUT the `mcp.account_connected` row, for the same reason as ever: rotation is
   * the vendor's plumbing, not a person's act, and a trail that records it as one reads as a
   * re-consent that nobody performed.
   *
   * The scope and the row are left alone. Nothing about what the vendor granted has changed — only
   * which token presents it.
   */
  async function rotateConnectionToken(
    input: {
      credentialId: string;
      refreshToken: string;
    },
    /**
     * The transaction the caller spent the token in, and this write belongs to it.
     *
     * The caller holds a `FOR UPDATE` lock on the very row being written. On its own pooled
     * connection this write would be a second session waiting for a lock only the caller can
     * release, and the caller cannot release it while awaiting this — so it would hang to the
     * statement timeout rather than rotate.
     */
    executor?: CredentialExecutor,
  ): Promise<void> {
    await credentials.updateSecret(
      input.credentialId,
      await encryptSecret(encryptionKey, input.refreshToken),
      executor,
    );
  }

  /** The one vault key a server's OAuth client is ever stored under. */
  const oauthClientKey = (serverId: string) => ({
    kind: "mcp_oauth_client" as const,
    provider: serverId,
    keyId: `oauth-client-${serverId}`,
  });

  /**
   * One writer at a time for one server's OAuth client, across the whole deployment.
   *
   * Everything that stores a client reads "is there a live one" and then writes accordingly, and the
   * gap between those two used to be unserialised. `POST /connect` is `requireUser`, so two people
   * pressing Connect on a fresh connector is not a rare interleaving: both read no live client, and
   * then the second `create` meets the first on `credentials_active_key_idx` as a raw 23505 — a 500
   * where a consent URL belonged — or, when there was a client to replace, the second `rotate` finds
   * its own predecessor already revoked and says so.
   *
   * An ADVISORY lock rather than a row lock, because the thing being protected is the ABSENCE of a
   * row as much as a row: there is nothing to lock `FOR UPDATE` on a first registration. Held for
   * the transaction, so it is released by the commit or the rollback and never by us forgetting.
   *
   * `hashtext` collisions are harmless here. Two servers sharing a hash would take turns registering
   * clients, which is slower and not wrong.
   */
  async function withOAuthClientLock<T>(
    serverId: string,
    work: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`oauth-client-${serverId}`}))`,
      );
      return await work(transaction);
    });
  }

  /**
   * {@link storedOAuthClient}'s question, asked on the caller's own transaction.
   *
   * The same question deliberately — the server row's pointer, and the row it names being live —
   * because the callback redeems against `oauthClientFor`, which reads exactly that. A read that
   * accepted a live client the server row does NOT name would hand somebody a consent screen for a
   * client the callback then cannot find, and the connect would fail after the vendor said yes.
   *
   * On the transaction rather than through `storedOAuthClient` because the caller is inside
   * {@link withOAuthClientLock} and holding a pooled connection: a read on a second connection would
   * be a session queueing behind sessions that cannot finish until it returns.
   */
  async function heldOAuthClient(
    transaction: Transaction,
    serverId: string,
  ): Promise<OAuthClient | null> {
    const [server] = await transaction
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!server?.credentialId) return null;

    const [held] = await transaction
      .select({
        encryptedValue: credentialRows.encryptedValue,
        revokedAt: credentialRows.revokedAt,
      })
      .from(credentialRows)
      .where(eq(credentialRows.id, server.credentialId))
      .limit(1);
    if (!held || held.revokedAt) return null;

    try {
      return JSON.parse(
        await decryptSecret(encryptionKey, held.encryptedValue),
      ) as OAuthClient;
    } catch {
      // Unreadable is the same as none: there is nothing to send anybody to consent with.
      return null;
    }
  }

  /**
   * The two writes that store a client, on one transaction: the vault row, and the pointer to it.
   *
   * One transaction because they are one decision. Separately, a failure between them leaves
   * `mcp_servers.credential_id` naming the credential the rotation had just revoked — a connector
   * that looks configured on every screen and cannot complete a consent flow.
   *
   * The caller is expected to hold {@link withOAuthClientLock}, which is what makes the read below
   * safe to act on.
   */
  async function writeOAuthClient(
    input: { serverId: string; client: OAuthClient },
    transaction: Transaction,
  ): Promise<{ replaced: boolean }> {
    const key = oauthClientKey(input.serverId);
    const value = {
      ...key,
      metadata: { server: input.serverId, clientId: input.client.clientId },
      encryptedValue: await encryptSecret(
        encryptionKey,
        JSON.stringify(input.client),
      ),
    };

    const live = await credentials.findLiveByKey(key, transaction);
    const stored = live
      ? await credentials.rotate(
          { ...value, previousCredentialId: live.id },
          transaction,
        )
      : await credentials.create(value, transaction);

    await transaction
      .update(mcpServers)
      .set({ credentialId: stored.id, updatedAt: new Date() })
      .where(eq(mcpServers.id, input.serverId));

    return { replaced: live !== null };
  }

  /**
   * The trail row for a client this deployment now holds.
   *
   * Written AFTER the transaction that stored it, not inside. The audit store has its own handle on
   * the database, so writing from inside would open a second pooled connection while the first is
   * held — the shape the pool note in `db/client.ts` warns about, and the one that turns a busy
   * deployment into a hang. A trail row lost to a crash in that window is a worse trade than a
   * deadlock, but only just, and this way round the client is at least the thing that is certain.
   */
  async function recordClientRegistered(
    input: { serverId: string; client: OAuthClient; by: string },
    replaced: boolean,
  ): Promise<void> {
    await recordAuditEvent(auditStore, {
      eventType: "mcp.oauth_client_registered",
      targetType: "mcp_server",
      targetId: input.serverId,
      payload: {
        actor: input.by,
        server: input.serverId,
        // The id, never the secret. It identifies the client that was registered, which is what
        // somebody reading the trail needs in order to check it against the vendor's console.
        clientId: input.client.clientId,
        replaced,
      },
    });
  }

  /**
   * Store the deployment's OAuth client for a `user-oauth` server, whoever obtained it.
   *
   * Both halves go into one encrypted value, so a single vault read yields a usable client. The id is
   * copied into `metadata` as well — it is not a secret, and a page listing what the deployment holds
   * should be able to name it without decrypting anything.
   *
   * Replacing a client revokes the previous one rather than orphaning it, so "what does this
   * deployment hold" keeps having one answer per server. Nobody's connection breaks in the sense that
   * matters here — a refresh token is the person's — but nobody's connection SURVIVES either: a grant
   * belongs to the client it was issued to, so replacing the client is asking everybody to connect
   * again. That is why the two callers that replace one both say so to whoever is listening.
   *
   * Shared by an administrator pasting one in and by the deployment registering its own, so `by` is
   * the only difference between the two in the trail — which is the honest one.
   */
  async function persistOAuthClient(input: {
    serverId: string;
    client: OAuthClient;
    by: string;
  }): Promise<void> {
    const { entry } = await requireServer(input.serverId);
    if (entry?.auth.kind !== "user-oauth") {
      throw new CustomServerRefusedError(
        `${input.serverId} is not reached with an OAuth client.`,
      );
    }

    const { replaced } = await withOAuthClientLock(
      input.serverId,
      (transaction) =>
        writeOAuthClient(
          { serverId: input.serverId, client: input.client },
          transaction,
        ),
    );

    await recordClientRegistered(input, replaced);
  }

  /**
   * The deployment's OAuth client for a server as it stands, or null if there is none to read.
   *
   * Decrypted, because both halves are needed: the id to build a consent URL and the secret to
   * redeem the code it comes back with. Held for the length of one request, like every other secret
   * this module reads.
   */
  async function storedOAuthClient(
    serverId: string,
  ): Promise<OAuthClient | null> {
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
      // nothing to send anybody to consent with, and the answer is to obtain one again.
      return null;
    }
  }

  /**
   * The credential a server is being pointed at is of the kind that server can spend.
   *
   * Both add paths dereference the pointer before they return, so this is checked where the pointer
   * is accepted rather than where it is used. `mcp` is the only kind that answers "this server's own
   * token". A `mcp_user_token` is one person's grant and a `mcp_oauth_client` identifies the
   * deployment to a vendor; spending either here uses a credential on behalf of somebody who never
   * agreed to it, which is the same objection `POST /api/admin/credentials` already makes when it
   * refuses to mint those two by hand.
   *
   * The shape is checked before the lookup because `credentials.id` is a `uuid` column, so a value
   * that is not one makes the query itself fail rather than return no rows, and the caller gets a
   * database error where a refusal belongs.
   *
   * One message for both "wrong kind" and "no such credential", deliberately. A caller who can tell
   * those apart can ask this endpoint which credential ids are real.
   */
  async function requireCredentialOfKind(
    serverTitle: string,
    serverId: string,
    credentialId: string,
    kind: "mcp" | null,
  ): Promise<void> {
    /*
     * A server that takes no credential when it is added is refused here rather than at the caller,
     * so that offering an id is one question with one answer wherever it is asked. The wording says
     * what is true of both kinds that reach it: a `user-oauth` server's client arrives through the
     * call that mints it, and a server needing no credential has nothing to be given.
     */
    if (!kind) {
      throw new CustomServerRefusedError(
        `${serverTitle} takes no credential when it is added.`,
      );
    }

    const looksLikeId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        credentialId,
      );
    /*
     * Live, as well as the right kind and the right owner.
     *
     * A revoked credential cannot be decrypted, so attaching one only ever produced a server that
     * fails on its next call. Refusing it here says so at the moment somebody can still act on it,
     * and it closes the case where a token was retired precisely because it should stop being used.
     */
    const [named] = looksLikeId
      ? await database
          .select({
            kind: credentialRows.kind,
            provider: credentialRows.provider,
          })
          .from(credentialRows)
          .where(
            and(
              eq(credentialRows.id, credentialId),
              isNull(credentialRows.revokedAt),
            ),
          )
      : [];

    /*
     * Whose it is, as well as what it is.
     *
     * `provider` is the server a token was minted for: `storeMcpToken` sets it to the server id and
     * is the only way the plugins screen makes one. Without this, any `mcp` row in the vault could
     * be attached to any server, and since the refresh spends it against that server's address, a
     * token given to one vendor was deliverable to another. Reading a credential back is otherwise
     * impossible by design, so this closes the one field that accepts a reference to a secret rather
     * than the secret itself.
     */
    if (named?.kind !== kind || named.provider !== serverId) {
      throw new CustomServerRefusedError(
        "That is not a credential this server can use. Add the server's own token instead.",
      );
    }
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

      /*
       * The pointer is checked here for the same reason it is on the path below: the refresh that
       * runs before this returns dereferences whatever it names.
       *
       * What that reaches is narrower on this path, because the URL is the catalogue's rather than
       * the caller's, so a credential cannot be delivered to an address somebody chose. That is a
       * property of today's catalogue rather than of this function: the one entry it holds is
       * `user-oauth`, and the catalogue's own comment invites a fork to re-add the vendors that were
       * taken out. The first `deployment-bearer` entry restores the full shape, so the check belongs
       * here now rather than in the review that re-adds one.
       */
      const credentialId = input.credentialId?.trim() || undefined;
      if (credentialId) {
        await requireCredentialOfKind(
          resolved.entry.title,
          resolved.entry.key,
          credentialId,
          serverCredentialKind(resolved.entry),
        );
      }

      await database
        .insert(mcpServers)
        .values({
          id: resolved.entry.key,
          title: resolved.entry.title,
          vendor: resolved.entry.vendor,
          url: resolved.url,
          credentialId: credentialId ?? null,
          addedBy: input.by,
        })
        .onConflictDoUpdate({
          target: mcpServers.id,
          set: {
            url: resolved.url,
            /*
             * Left alone when the caller sends none, rather than cleared.
             *
             * `registerOAuthClient` keeps the client it minted in this column, and adding the server
             * again to change an instance host is not a statement about that client. Clearing it
             * orphaned the credential row, which nothing then revokes, and told everybody who had
             * connected that the deployment has no OAuth client registered. There is no longer a way
             * to hand it back through this call either, since a `user-oauth` entry now refuses a
             * credential id, so the pointer has to survive here.
             */
            ...(credentialId ? { credentialId } : {}),
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

      /*
       * The pointer is checked here because the add is what dereferences it.
       *
       * `refreshTools` runs before this method returns, and for a custom server there is no
       * catalogue entry, so `connectionTokenFor` decrypts whatever `credential_id` names and
       * `listTools` sends it to the URL from this same request. An unchecked pointer therefore is
       * not "a wrong token later", it is this call delivering that secret to an address the caller
       * chose, before any grant, policy check or Bot exists.
       *
       * `mcp` is the only kind that answers "this server's own token". A `mcp_user_token` is one
       * person's grant and a `mcp_oauth_client` identifies the deployment to a vendor; neither is
       * this deployment's bearer token for this server, and spending either here would be using a
       * credential on behalf of somebody who never agreed to it. `POST /api/admin/credentials`
       * already refuses to mint those two by hand for that reason, and its comment says so; this is
       * the same objection at the point they are referenced rather than created.
       *
       * One message for both "wrong kind" and "no such credential", deliberately. A caller who can
       * tell those apart can ask this endpoint which credential ids are real.
       */
      /*
       * A credential is spent at the address it was given to, or not spent.
       *
       * Adding a server that is already here rewrites its URL, and the refresh that follows sends
       * whatever credential it holds to the new one, in the same call. That is the same disclosure
       * as naming another server's token and it needs no trick at all: the token really does belong
       * to this server, and only the address moved. A check on whose credential it is cannot see it,
       * which is why this rule is here and not folded into that one.
       *
       * Refused rather than repaired, because the two harmless readings of the request are both
       * served by something else. Correcting a title or retrying an interrupted add sends the same
       * URL and is unaffected, and genuinely moving a server means the vendor is at a new address,
       * where the honest act is to remove it and add it again with the token that address is
       * supposed to hold.
       *
       * Only this path. A curated server's URL comes from the catalogue rather than the request, so
       * the most a caller can influence is an instance hostname, and that is matched against the
       * vendor's own anchored pattern before anything is stored. Re-adding one cannot point it at an
       * address of the caller's choosing, which is the whole of what this refuses.
       */
      const credentialId = input.credentialId?.trim() || undefined;
      const [existing] = await database
        .select({ url: mcpServers.url, credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.id));

      if (
        existing &&
        existing.url !== input.url &&
        (existing.credentialId || credentialId)
      ) {
        throw new CustomServerRefusedError(
          `${input.id} is already here at a different address and holds a credential. Remove it and add it again, with the token the new address is meant to have.`,
        );
      }

      if (credentialId) {
        // Always `mcp`: a server added by URL is reached with the one token the deployment holds for
        // it, whatever the vendor is, because nothing here knows the vendor.
        await requireCredentialOfKind(
          input.title,
          input.id,
          credentialId,
          "mcp",
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
          credentialId: credentialId ?? null,
          addedBy: input.by,
        })
        .onConflictDoUpdate({
          target: mcpServers.id,
          set: {
            title: input.title,
            url: input.url,
            /*
             * Kept when the caller names none, rather than cleared, for a reason beyond tidiness.
             *
             * Clearing it left the credential live with nothing pointing at it, and `removeServer`
             * retires a token by reading it off the row: with the pointer gone it revoked nothing
             * and deleted the server, so the token outlived the server it was minted for. It could
             * then be attached to a freshly created server at any address, because the rule above
             * compares against a row that no longer existed. Three ordinary acts, and the address
             * this server was entrusted to stopped meaning anything.
             *
             * So the pointer survives, `removeServer` finds it, and a removed server's token is
             * dead rather than loose. Detaching a token without removing the server is not a thing
             * this endpoint does, and nothing asks it to.
             */
            ...(credentialId ? { credentialId } : {}),
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

    /**
     * Remove a server, and stop every secret it was reached with being live.
     *
     * TWO KINDS OF SECRET, and both have to go. The server's own credential is whatever
     * `mcp_servers.credential_id` names — a `mcp` bearer token an administrator added, or, for a
     * `user-oauth` vendor, the deployment's OAuth client, keyed `oauth-client-<serverId>`. Nothing
     * else revokes it, so leaving it behind means re-adding the same server meets its own abandoned
     * row on `credentials_active_key_idx`.
     *
     * The other kind is every PERSON'S grant for this server, keyed `mcp_user_token` on the server id.
     * `mcp_user_credentials` cascades on the server row, so removing the connector used to delete
     * every pointer and leave every refresh token live and unreferenced: reachable from no screen,
     * revoked by no operation, and still a usable grant at the vendor. "We removed the connector" has
     * to be true of the thing that matters, which is the token sitting at the vendor.
     *
     * Revoked rather than deleted, because the vault keeps revoked rows for audit.
     *
     * The revokes go first. These are writes on two tables and the store exposes no transaction that
     * spans both, so the order decides what a failure between them leaves: revoke-then-delete leaves
     * a server whose secrets no longer work and which removing again will finish off, while
     * delete-then-revoke leaves live secrets no server references and no operation can reach.
     */
    async removeServer(serverId: string, by: string): Promise<void> {
      const [existing] = await database
        .select({ credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId));

      /**
       * Whether that token is still live, read rather than inferred from a
       * thrown error, so a token a previous attempt already revoked, or one
       * whose row is gone entirely, is skipped while a database fault still
       * propagates and leaves the server row in place to be removed again.
       *
       * Two queries rather than a join because `mcp_servers.credential_id` is
       * `text` and `credentials.id` is `uuid`, so the two columns do not
       * compare without a cast.
       */
      const [live] = existing?.credentialId
        ? await database
            .select({ id: credentialRows.id })
            .from(credentialRows)
            .where(
              and(
                eq(credentialRows.id, existing.credentialId),
                isNull(credentialRows.revokedAt),
              ),
            )
        : [];

      if (live) {
        await credentials.revoke(live.id);
        await recordAuditEvent(auditStore, {
          eventType: "credential.revoked",
          targetType: "credential",
          targetId: live.id,
          payload: {
            actor: by,
            reason: "mcp_server_removed",
            server: serverId,
          },
        });
      }

      /*
       * Every person's grant for this server, read out of the VAULT rather than through the join
       * table.
       *
       * `credentials.provider` holds the server id for an `mcp_user_token`, so the vault can be asked
       * directly — which matters because the join row is the thing about to be cascaded away, and a
       * grant whose pointer has already gone (a person removed earlier) would otherwise be invisible
       * here too. The same argument `retireConnectionsFor` makes from the other direction.
       */
      const held = await database
        .select({ id: credentialRows.id, keyId: credentialRows.keyId })
        .from(credentialRows)
        .where(
          and(
            eq(credentialRows.kind, "mcp_user_token"),
            eq(credentialRows.provider, serverId),
            isNull(credentialRows.revokedAt),
          ),
        )
        .orderBy(asc(credentialRows.keyId));

      for (const grant of held) {
        await credentials.revoke(grant.id);
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_disconnected",
          targetType: "mcp_server",
          targetId: serverId,
          payload: {
            actor: by,
            server: serverId,
            // Whose it was. `key_id` holds the user id for this kind, and it is the only place left
            // to read it from once the join row has been cascaded away.
            owner: grant.keyId,
            /*
             * Not "they disconnected" and not "they were removed": an administrator took the whole
             * connector away, and the person did nothing. An auditor asking what happened to their
             * access should see which of the three this was.
             */
            reason: "mcp_server_removed",
            vendorRevoked: false,
          },
        });
      }

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

        /*
         * ONE STEP, because the catch below promises that it is one.
         *
         * "The tools already held are left alone" is only true while nothing has been written yet.
         * As two auto-committed statements the delete landed on its own whenever the insert did not:
         * a pod killed mid-refresh, a dropped connection, a statement timeout — or, with no crash at
         * all, a server that answers `tools/list` with the same `name` twice, which `mcp_tools`'
         * `(server_id, name)` primary key refuses as one multi-row insert. `mcp_tools` is shared, so
         * that is every replica at once, and nothing repopulates it: `refreshTools` is only ever
         * called by `addServer`, `addCustomServer` and an administrator pressing Refresh. The
         * connector kept every grant an administrator had made and offered none of them, and
         * `grantedToolGuidance` then told the Bot outright that it holds none of that vendor's tools.
         *
         * Rolled back together, the vendor's bad answer is recorded in `lastError` and the Bots go
         * on using what they were granted, which is what the comment said all along.
         */
        await database.transaction(async (transaction) => {
          await transaction
            .delete(mcpTools)
            .where(eq(mcpTools.serverId, serverId));
          if (tools.length > 0) {
            await transaction.insert(mcpTools).values(
              tools.map((tool) => ({
                serverId,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            );
          }
        });

        await database
          .update(mcpServers)
          .set({
            toolsRefreshedAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(mcpServers.id, serverId));

        /*
         * A grant left pointing at nothing goes in the trail, at the moment it starts pointing at
         * nothing.
         *
         * Reporting it on a screen answers "what is true now", which somebody has to go and look at.
         * This answers "when did it stop being offered, and what was holding it" — the question asked
         * after a transport is swapped back and a name starts resolving again. Without the row, the
         * only record of the gap is its absence.
         *
         * Not a refusal and not an error, so `configuration.changed` rather than a new event type:
         * nothing was denied and the refresh succeeded. Written after the tool list is replaced, so
         * what it names is what is actually left over.
         */
        const advertised = new Set(tools.map((tool) => tool.name));
        const stranded = [...(await mcpGrantsForServers([serverId])).entries()]
          .filter(([ref]) => !advertised.has(ref.slice(serverId.length + 1)))
          .sort(([left], [right]) => left.localeCompare(right));

        if (stranded.length > 0) {
          await recordAuditEvent(auditStore, {
            eventType: "configuration.changed",
            targetType: "mcp_server",
            targetId: serverId,
            payload: {
              actor: actorId,
              change: "grants_not_advertised",
              server: serverId,
              // The refs, because that is what a grant is keyed on and what an administrator revokes.
              refs: stranded.map(([ref]) => ref),
              bots: [...new Set(stranded.flatMap(([, agents]) => agents))],
              note: "Held by a Bot and not offered to any model, because this server no longer advertises the tool. Offered again if it starts.",
            },
          });
        }

        /*
         * Tools the vendor advertises that this deployment's write list does not name.
         *
         * The mechanical half of the reconciliation Notion's catalogue entry says is required. See
         * {@link unlistedAdvertisedTools} for why only that shape of vendor is named here: an
         * advertised tool absent from `writeTools` classifies as a READ, so an under-inclusive list
         * is silent, and for a vendor with no scope strings there is nothing else standing behind it.
         *
         * `configuration.changed` rather than a type of its own, the same as the stranded grants
         * above and for the same reason: nothing was denied and the refresh succeeded. What changed
         * is that the deployment now knows a name it had not classified.
         */
        const unlisted = unlistedAdvertisedTools(entry, [...advertised]);
        if (unlisted.length > 0) {
          await recordAuditEvent(auditStore, {
            eventType: "configuration.changed",
            targetType: "mcp_server",
            targetId: serverId,
            payload: {
              actor: actorId,
              change: "unlisted_tools_advertised",
              server: serverId,
              tools: unlisted,
              note: "Advertised by this server and not named in its reviewed write list, so each is offered to models as a read. This vendor has no read-only scope behind that list, so anything here that writes should be added to the entry.",
            },
          });
        }

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
          .set({
            /*
             * Capped at the same 400 characters `callTool` caps its recorded failure at.
             *
             * Parts of this sentence come from a vendor, and it is drawn on the admin page — neither
             * is a promise about length, and the two paths that show a vendor's words to an operator
             * should not disagree about how much of them to keep.
             */
            lastError: message.slice(0, 400),
            updatedAt: new Date(),
          })
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

      /*
       * Every grant on these servers, not only the ones matching a tool that is still advertised.
       * Asking about the advertised refs answers "who holds what is offered", which cannot report the
       * grants that are the point here — see `mcpGrantsForServers`.
       */
      const grants = await mcpGrantsForServers(rows.map((row) => row.id));
      const advertised = new Set(
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
          dynamicClient:
            entry?.auth.kind === "user-oauth" &&
            entry.auth.clientRegistration === "dynamic",
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
          /*
           * Sorted by ref so the list is stable between reads, which matters because this is the one
           * place a discrepancy is reported and a reader comparing two visits should see the same
           * order.
           */
          withdrawn: [...grants.entries()]
            .filter(
              ([ref]) => ref.startsWith(`${row.id}/`) && !advertised.has(ref),
            )
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([ref, grantedTo]) => ({
              ref,
              name: ref.slice(row.id.length + 1),
              grantedTo,
            })),
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
      const declared = await toolsDeclaredBy(rows.map((row) => row.id));
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
        tools: declared.get(row.id) ?? [],
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
    /**
     * Whether this Bot's run happens in this process, rather than at an endpoint somewhere.
     *
     * Undefined for a Bot nobody has heard of. Asked because a tool this deployment executes can
     * only be offered to a run it builds: a Bot at an endpoint runs its own loop and is handed
     * descriptions of what it may call back for, and handing work to another Bot is not one of them.
     */
    async agentRunsHere(agentId: string): Promise<boolean | undefined> {
      const [row] = await database
        .select({ type: agents.type })
        .from(agents)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        // A deleted Bot is not one anybody may be given, and answering about it at all would say it
        // had existed.
        .where(and(eq(agents.id, agentId), isNull(agentProfiles.deletedAt)))
        .limit(1);
      return row ? row.type === "built_in" : undefined;
    },

    /**
     * Whether this Bot is one somebody could be handed work by, at all.
     *
     * The TARGET of a bot grant, unlike the grantee, may perfectly well run at its own endpoint —
     * being handed work is not the same as being able to hand it on. What it may not be is absent:
     * `ref` is bare text with no foreign key, so a typo stored happily, `message_bot` was offered,
     * and every hop refused as not-granted. That is the same row-that-cannot-work this check exists
     * to stop, arriving from the other side.
     */
    async agentIsRegistered(agentId: string): Promise<boolean> {
      const [row] = await database
        .select({ id: agents.id })
        .from(agents)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .where(and(eq(agents.id, agentId), isNull(agentProfiles.deletedAt)))
        .limit(1);
      return row !== undefined;
    },

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
      /**
       * The tools this skill needs, as `<serverId>/<toolName>` refs. Absent leaves whatever was
       * declared before; an empty array clears it, which is how a skill stops asking for anything.
       */
      tools?: string[];
      by: string;
    }): Promise<void> {
      /*
       * Checked before anything is written, so a save is all-or-nothing from the caller's side: a
       * skill is never left saved with half its declarations because the fourth ref was a typo.
       */
      const declared =
        input.tools === undefined
          ? undefined
          : [...new Set(input.tools.map((ref) => ref.trim()).filter(Boolean))];
      if (declared !== undefined && declared.length > 0) {
        const known = await knownToolRefs(declared);
        const unknown = declared.filter((ref) => !known.has(ref));
        if (unknown.length > 0) {
          throw new PluginRefusedError(
            `No tool by that name has been seen here: ${unknown.join(", ")}. A skill names tools as serverId/toolName, and the server has to have been refreshed at least once.`,
            // No policy rule refused this; the name simply matches nothing. `rule` is what an audit
            // reader is shown as the reason, and inventing one here would put a rule in the trail
            // that nobody wrote.
            null,
          );
        }
      }

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

      /*
       * Replaced wholesale rather than merged. What a skill needs is a set the author is editing, so
       * a save says what it is now; merging would make removing one a thing with no gesture for it.
       */
      if (declared !== undefined) {
        await database
          .delete(skillTools)
          .where(eq(skillTools.skillId, input.slug));
        if (declared.length > 0) {
          await database.insert(skillTools).values(
            declared.map((ref) => ({
              skillId: input.slug,
              ref,
              declaredBy: input.by,
            })),
          );
        }
      }

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "skill",
        targetId: input.slug,
        payload: {
          actor: input.by,
          change: "skill_installed",
          skill: input.slug,
          // Recorded because it is what the skill will pull into a model's context once selection is
          // built. It changes nothing about what may be called; the grant still decides that.
          ...(declared === undefined ? {} : { declares: declared }),
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

    /**
     * The Bots one Bot has been granted, read fresh.
     *
     * NEVER CACHED. Whether one Bot may address another is a decision an administrator can change,
     * and a grant revoked a minute ago has to apply to the next hop rather than after a restart. It
     * is a single indexed read, which is the right price for that.
     */
    /**
     * The Bots this one may hand work to, and can actually reach.
     *
     * FILTERED AT READ TIME, not only when the grant is made. Refusing a new grant to a Bot that
     * runs at its own endpoint stops one being created; it does nothing about the ones already
     * there, or about a Bot that was built in when it was granted and was pointed at an endpoint
     * afterwards. Those rows read as configured and are inert, which is the shape of thing an
     * administrator debugs for an afternoon: the grant is right there in the table and no hop ever
     * happens.
     *
     * The asking side is the one that matters here — a Bot at an endpoint runs its own loop and is
     * never offered this tool — so it is the grantee, `agent_id`, that is checked.
     */
    async botsReachableFrom(agentId: string): Promise<string[]> {
      const rows = await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .innerJoin(agents, eq(agents.id, pluginGrants.agentId))
        .where(
          and(
            eq(pluginGrants.kind, "bot"),
            eq(pluginGrants.agentId, agentId),
            eq(agents.type, "built_in"),
          ),
        );
      return rows.map((row) => row.ref);
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

    /**
     * Register the deployment's OAuth client for a `user-oauth` server.
     *
     * An administrator pasting in what they created at the vendor. The work itself is
     * {@link persistOAuthClient}, which self-registration goes through too — one path, so a client
     * this deployment issued itself is stored, revoked and recorded exactly like a pasted one.
     */
    registerOAuthClient: persistOAuthClient,

    /**
     * The client to send somebody to the vendor with, registering one first if that is this
     * vendor's way of getting one.
     *
     * A dynamically registered client is not paperwork anybody did: there is no console entry to
     * paste, so "none yet" is the ordinary state of a server nobody has connected — and the answer
     * is for the deployment to introduce itself, which is what it would have to do eventually
     * anyway. Where an administrator registers by hand instead, and where the deployment has no
     * public URL to be sent back to, the answer stays null: inventing a client at a vendor that
     * never offered to issue one, or registering a redirect URI that resolves to nothing, would
     * both leave behind a client that can never complete a consent flow.
     *
     * ONE CLIENT PER DEPLOYMENT EVEN WHEN TWO PEOPLE ASK AT ONCE. This is `requireUser`'s handler, so
     * two first connects racing is the ordinary first hour of a connector. Registering twice is not
     * merely wasteful: the loser's consent screen names a client the vault no longer holds, so that
     * person consents and their callback then redeems the code against the client that replaced it —
     * a connect that fails after the vendor already said yes. So the registration happens under
     * {@link withOAuthClientLock}, with the "do we hold one" question asked AGAIN inside it, and the
     * second caller finds the first one's client and is handed the same one.
     *
     * The lock is held across the registration request to the vendor, deliberately. It is one round
     * trip with its own timeout, and a lock released before it would serialise nothing.
     */
    async ensureOAuthClient(
      serverId: string,
      by: string,
    ): Promise<OAuthClient | null> {
      const stored = await storedOAuthClient(serverId);
      if (stored) return stored;

      const { entry } = await requireServer(serverId);
      if (
        entry?.auth.kind !== "user-oauth" ||
        entry.auth.clientRegistration !== "dynamic" ||
        !entry.auth.registrationUrl ||
        !options.redirectUri
      ) {
        return null;
      }
      // Held before the lock, because narrowing does not survive into the closure below.
      const { registrationUrl } = entry.auth;
      const { redirectUri } = options;

      const outcome = await withOAuthClientLock(
        serverId,
        async (transaction) => {
          /*
           * Asked again, under the lock. The read above was a fast path taken without one, and by now
           * the caller we were racing has committed a client of its own — which is the one this
           * deployment holds, so it is the one to consent against.
           */
          const held = await heldOAuthClient(transaction, serverId);
          if (held) return { client: held, registered: false, replaced: false };

          const registered = await registerClient({
            registrationUrl,
            redirectUri,
          });
          if (!registered) return null;

          const { replaced } = await writeOAuthClient(
            { serverId, client: registered },
            transaction,
          );
          return { client: registered, registered: true, replaced };
        },
      );

      if (!outcome) return null;
      // Only what this call actually did. A trail row for handing back somebody else's client would
      // claim a registration that never happened.
      if (outcome.registered) {
        await recordClientRegistered(
          { serverId, client: outcome.client, by },
          outcome.replaced,
        );
      }
      return outcome.client;
    },

    /**
     * Record that one person connected their own account to one server.
     *
     * The credential swap is {@link swapUserCredential}, and this is its only caller: a person
     * connecting or reconnecting is exactly when there is an older grant to revoke. Rotation writes
     * the same connection in place instead ({@link rotateConnectionToken}). What is only here is the
     * audit row: this one IS somebody's act, and the trail should say so.
     */
    async recordConnection(input: {
      serverId: string;
      userId: string;
      refreshToken: string;
      scope: string;
    }): Promise<void> {
      const { replaced } = await swapUserCredential(input);

      await recordAuditEvent(auditStore, {
        eventType: "mcp.account_connected",
        targetType: "mcp_server",
        targetId: input.serverId,
        payload: {
          actor: input.userId,
          server: input.serverId,
          // What the vendor granted, so a later refusal for want of a scope can be explained.
          scope: input.scope,
          reconnected: replaced,
        },
      });
    },

    /**
     * The deployment's OAuth client for a server, or null if none is registered.
     *
     * Reads only. {@link ensureOAuthClient} is the one that will go and get one.
     */
    oauthClientFor: storedOAuthClient,

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
        // Empty, like the browser fields above: an MCP call runs no shell command, but a
        // `deny: contains(command, "rm -rf")` names `command`, and an unbound identifier throws and
        // fails closed — which would refuse every MCP call once a deployment wrote a rule about its
        // shell. An empty command matches no such rule.
        command: "",
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
       * A refusal is written on the POLICY's answer, not on whether the call was then let through.
       *
       * This deployment declining is the whole event, and it is recorded before the throw so that a
       * refusal cannot be lost by the caller's error handling.
       *
       * In `dry-run` the policy still refuses and the mode forwards anyway, which is the whole point
       * of the mode: `evaluateActionPolicy` returns `allowed: false` with `forward: true` so a rule
       * can be tried against live traffic before it starts refusing anybody. Writing this row on
       * `forward` therefore recorded nothing at all on this surface for exactly the traffic an
       * operator switched dry-run on to measure — the browser gateway keys its row on
       * `decision.allowed` and does record it — so `Blocked` on the audit page, and every
       * `eventType=mcp.call_rejected` query behind it, answered "this rule would refuse none of your
       * tool calls" about calls it would refuse. The rule then looked inert, and enforcing it
       * started refusing Bots with no warning in the trail.
       *
       * `decision.carriedOut` is what tells the two rows apart: false is a call this deployment
       * stopped, true is one dry-run recorded and let past. The outcome row below is unchanged, so a
       * forwarded call still says separately whether the vendor answered.
       */
      if (!verdict.allowed) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          payload: decided,
        });
      }
      if (!verdict.forward) {
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
          {
            url: effectiveUrl(row, entry),
            token,
            actorId: input.actorId,
            botId: input.botId,
          },
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
         *
         * Capped like the `isError` branch above, and for the same reason: parts of this sentence
         * came from the vendor, and a failure is not a promise about length.
         */
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_failed",
          targetType: "mcp_tool",
          targetId: input.ref,
          payload: {
            ...decided,
            failure: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 400),
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
