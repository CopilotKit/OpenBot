import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  policyInitiator,
} from "../computer/policy";
import {
  type CredentialExecutor,
  type CredentialSecretReader,
  type CredentialStore,
  CredentialUnusableError,
  decryptCredentialForUse,
  decryptSecret,
  encryptSecret,
} from "../credentials";
import type { Database } from "../db/client";
import {
  databaseComplaint,
  isQueryFailure,
  reasonWithoutStatement,
  withoutStatement,
} from "../db/query-failure";
import {
  agentProfiles,
  agents,
  composioConnections,
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
  accessFor,
  type ServerAccess,
  ServerUnresolvableError,
} from "./access";
import {
  type BrokerConnection,
  BrokerRefusalError,
  BrokerUnconfiguredError,
  type ComposioBroker,
  type Decides,
  isFieldScheme,
  type RecordedScheme,
  type SchemeKind,
  schemeKind,
} from "./broker";
import {
  type CatalogueEntry,
  catalogueEntry,
  classifyTool,
  customUrlRefusal,
  resolveServerUrl,
  serverCredentialKind,
} from "./catalogue";
import {
  asksForArguments,
  askAction as composioAskAction,
  toolkitOf,
  VERSION_ARG,
} from "./composio";
import { inspectToolArguments } from "./content-governance";
import { type ListedTool, McpServerError } from "./mcp";
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
  /**
   * Whether the vendor warns that this action destroys something.
   *
   * Beside {@link ToolRecord.effect} rather than folded into it: the rule engine judges reads and
   * writes and gains nothing from a third value, while a person deciding whether to switch an action
   * on is asking a different question. Recorded from the vendor's own labels, so false is an absence
   * of a claim rather than a claim of safety.
   */
  destructive: boolean;
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
  logo: string | null;
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
  /**
   * How this server's authorization config was created, for the brokered rows that have one.
   *
   * WHAT WAS WRITTEN DOWN WHEN SOMEBODY ENABLED THE APP, NOT WHAT THE CATALOGUE PUBLISHES TODAY.
   * The catalogue is the vendor's, and an app it starts advertising under a different scheme has
   * not moved the config this deployment already created — so a reader deciding what a live
   * connection does must read this and not a fresh listing. The `authScheme` column carries the
   * same fact and the same warning about which vocabulary it holds: the vendor's own scheme
   * literals (`OAUTH2`, `DCR_OAUTH`, `API_KEY`, `NO_AUTH`, and the rest), never a
   * {@link BrokerConnection} kind.
   *
   * Null is not an older brokered row. It is a row that is not brokered at all.
   */
  authScheme: string | null;
  tools: ToolRecord[];
  /**
   * Grants on tools this server no longer advertises.
   *
   * Empty for a healthy connector. Non-empty is the discrepancy an administrator should be reading
   * about, which is why it is here rather than inferred by a screen comparing two lists.
   */
  withdrawn: WithdrawnGrant[];
};

/**
 * A server row as the surfaces that only need to know where it is see it.
 *
 * Four columns of {@link ServerRecord} and none of what hangs off it, because the callers this is
 * for ask one question: which vendor is this row addressed at. The title travels with the url
 * because their refusals name it — "You already have an account connected to Linear" is the app's
 * name, which is the only one of the two a person has ever seen on a screen.
 */
export type ServerAddress = {
  id: string;
  title: string;
  url: string;
  /**
   * How this row's authorization config was created, for the brokered rows that have one.
   *
   * THE RECORDED SCHEME, NEVER A FRESH CATALOGUE READ. An app's config was created as one
   * particular scheme and every connection standing against that config depends on it, so the
   * connect path has to open the flow this column names rather than the one the catalogue
   * publishes for the app today. Re-derived from a listing instead, a vendor that starts
   * advertising a new scheme would silently move live connections onto a different flow — minting
   * a consent link against a config that holds keys, or asking for a key where a consent screen is
   * waiting.
   *
   * The same vocabulary the column holds, which the schema comment spells out: the vendor's own
   * scheme literals, never a {@link BrokerConnection} kind. Null is not an older brokered row; it
   * is a row that is not brokered.
   */
  authScheme: string | null;
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

/**
 * What one check of somebody's brokered account spent, and what came of it.
 *
 * FOUR OUTCOMES AND NOT A PAIR OF NULLABLE FIELDS, because the fourth one is what the pair could
 * not say and its absence was destructive. `verified: false` used to cover both "the app published
 * nothing safe to try" and "it ran and the vendor refused the key", which is why the action's name
 * travels beside the verdict at all — and a THIRD thing was quietly landing in the second of those:
 * a vendor nobody could reach. `callTool` never throws, so a Composio outage, a socket that closed
 * and a package that cannot parse an answer all arrived as `isError: true` and were read as the
 * vendor rejecting the key. See {@link ActionAnswer} in `./composio` for the reading that settles
 * it, and {@link composioConnections.probeAction} for what each of these may be written down as.
 *
 * `probe` IS THE ACTION A CHECK CAN BE SHOWN TO HAVE SPENT, and it is null on both outcomes where
 * nothing can be shown — which is the whole structural point of this shape rather than a nicety.
 * That field is what the writer records in `probe_action`, and a name beside `verified: false` is
 * the accusation "it ran and the vendor refused your key". An unreachable vendor therefore has no
 * name to give the writer, and cannot make that claim even by mistake; what was attempted is
 * carried separately, for the trail and for the sentence somebody reads.
 */
export type BrokeredProbe =
  /** The app published nothing safe to call, or no row for it is left. Nothing was tried. */
  | { outcome: "nothing"; probe: null }
  /** It ran in this person's account and the vendor took the key. */
  | { outcome: "answered"; probe: string }
  /**
   * It ran in this person's account and the app answered with a failure. `sentence` is Composio's
   * own account of it.
   *
   * AND THAT IS THE WHOLE OF WHAT IT PROVES, WHICH IS WHY IT IS NOT CALLED `refused`. It was, and
   * every reader took the name at its word: the connect path DELETED the account it had made
   * seconds earlier and told the person what they entered did not work, and the re-check path
   * wrote the named-probe-beside-`verified: false` pair, which the settings page draws as "your
   * key was checked and rejected".
   *
   * NOTHING IN THE ENVELOPE SUPPORTS EITHER CLAIM. What arrives is Composio's
   * `{ data, error, successful }` — no HTTP status, no error code, nothing structured about the
   * credential — so a rate limit, a scope the key legitimately lacks for this one action, and a
   * 404 for a resource the read action happens to name are all indistinguishable here from a key
   * the vendor rejected. A person pasting a VALID key into an app that is rate-limiting had their
   * brand-new working connection revoked with a message blaming them, and that is not recoverable
   * by pressing anything: the key has to be fetched and typed again.
   *
   * SO THE TWO DESTRUCTIVE READINGS ARE GONE AND THE NAME NO LONGER INVITES THEM. The account
   * stands, the row records the check as failed with the action it was spent on, and the sentence
   * the person is shown is the app's own words rather than a verdict about their credential. If
   * Composio ever publishes a status or an error code on this envelope, telling the two apart is
   * a fifth outcome and the roster below is what will make somebody decide it everywhere.
   */
  | { outcome: "complained"; probe: string; sentence: string }
  /**
   * The vendor was not reached, or answered something nothing here can read, so NOTHING WAS
   * LEARNED — about the key, and about whether the action ran at all. `attempted` is what would
   * have been spent, which is a fact about this deployment's intent rather than about the account.
   */
  | {
      outcome: "unreachable";
      probe: null;
      attempted: string;
      sentence: string;
    };

/**
 * The four outcomes as a ROSTER, which is what anything enumerating them is checked against.
 *
 * A union is a thing a fifth member can be added to in one line with nothing anywhere failing:
 * every reader of this vocabulary asks `probed.outcome === "complained"` or `=== "unreachable"`, and a
 * chain of equality tests has no opinion about the answer it was not written for. `unreachable` is
 * itself the proof — it was added in round two and the screen that draws these outcomes went on
 * rendering it with the sentence written for a different case. See {@link Decides}.
 *
 * PINNED TO THE UNION IN BOTH DIRECTIONS. `satisfies` holds this list inside the union, so a name
 * misspelled here fails; {@link _ProbeRosterNamesTheWholeUnion} holds the union inside this list, so
 * a member added to the union and not to this roster fails. Neither direction is worth having on its
 * own: the pair is what makes the roster a restatement that cannot drift.
 *
 * SO A FIFTH OUTCOME COSTS TWO STEPS AND CANNOT SKIP EITHER. Adding it to the union fails `tsc`
 * here and at every consumer's `Decides<…>` roster; adding it here to satisfy that then fails the
 * table in `tests/composio-connection-kinds.test.ts`, which reads its rows off this list and has no
 * cell for the new name. The compiler settles what must decide and the table settles what it does.
 */
export const BROKERED_PROBE_OUTCOMES = [
  "nothing",
  "answered",
  "complained",
  "unreachable",
] as const satisfies readonly BrokeredProbe["outcome"][];

/** The other direction of {@link BROKERED_PROBE_OUTCOMES}' pin. Type-only; erased entirely. */
type _ProbeRosterNamesTheWholeUnion = Decides<
  BrokeredProbe["outcome"],
  Record<(typeof BROKERED_PROBE_OUTCOMES)[number], string>
>;

/**
 * THE FOUR STATES A CONNECTION ROW MAY BE LEFT IN, named so the pair can be enumerated.
 *
 * `verified` and `probe_action` are one fact recorded in two columns, and
 * {@link composioConnections.probeAction} enumerates the four readings of that pair in prose. Prose
 * is what the client then modelled as three — the outage and the never-checked case share the
 * mildest pair, and the screen drew one of them with the other's sentence. This is the same four
 * with names, so a consumer that has to decide on them can be held to naming all four.
 *
 * NOT A COLUMN, NEVER WRITTEN ANYWHERE, AND NOT EXPORTED. The row carries the pair; this is the
 * reading of it, and its one job is to be the value type {@link _ProbeOutcomeLeaves} is checked
 * against.
 *
 *   `unchecked` — null probe, not verified. Nothing was tried, so nothing is known about the key.
 *   `consented` — null probe, verified. A consent connection; the vendor's own yes is the evidence.
 *   `checked`   — a named probe, verified. It ran in this account and the vendor took the key.
 *   `failed`    — a named probe, not verified. It ran and the app answered with a failure, and the
 *                 account still stands. The one state an operator has to act on.
 *
 * `failed` RATHER THAN `refuted`, AND THE RENAME IS THE FIX RATHER THAN A TIDY-UP. It was
 * `refuted` — "the vendor refused the key", described in this file as "the accusation" — and
 * nothing that writes this pair can establish that. See {@link BrokeredProbe}'s `complained`
 * member: the envelope the verdict is read out of carries no status and no error code, so the
 * pair says a check was spent and did not come back clean, and it stops there. Everything that
 * renders it says the same, in the app's own words.
 */
type RecordedCheck = "unchecked" | "consented" | "checked" | "failed";

/**
 * WHICH OF THE FOUR A PROBE OUTCOME MAY EVER LEAVE BEHIND, the seam the two vocabularies meet at.
 *
 * Type-only and erased. It is a statement about {@link BrokeredProbe} rather than about any one
 * writer, and it is here because `failed` is the state the whole shape of that type exists to
 * withhold: an outcome carrying no probe name has no name to record, so it cannot reach that pair
 * even by mistake. A fifth outcome has to say which of the four it may leave behind before anything
 * compiles, which is precisely the question that went unasked when `unreachable` was added.
 *
 * THE ANSWERS ARE NARROWED TO {@link RecordedCheck} rather than left as free text, which is what
 * makes this a contract and not a comment: a state invented here that the schema's four do not
 * include fails, and so does one of the four renamed on one side of the seam only.
 */
type _ProbeOutcomeLeaves = Decides<
  BrokeredProbe["outcome"],
  {
    nothing: "untouched";
    answered: "checked";
    complained: "failed";
    unreachable: "untouched";
  },
  RecordedCheck | "untouched"
>;

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
 * A state this deployment's own code says cannot exist, found existing.
 *
 * CRITERION. Nothing here is a vendor's doing, a credential's doing or anything a person asking can
 * act on, so no path may record one of these as though a vendor had misbehaved.
 *
 * REASON. `refreshTools` wrapped the listing, the replace and both audit writes in one `catch` that
 * copied every message into `lastError` and answered `{ tools: 0 }`. A plain `Error` is what the
 * narrowing throws in {@link createPluginStore}'s `connectionTokenFor` raise, so a row that resolved
 * to a brokered credential with no app in its url — or to a per-person credential with no
 * `user-oauth` entry — came out on the Plugins page as a sentence about the vendor, next to a
 * refresh that looked like it had merely failed. An operator reading that is sent to somebody else's
 * status page over a contradiction in our own tables.
 *
 * A class rather than a message, because telling these apart by prose is telling them apart by a
 * substring that a reword would silently change. Distinct from {@link PluginRefusedError}, which is
 * a refusal somebody CAN act on and which does belong in `lastError` — an administrator who has not
 * connected their account is the honest reason a listing did not happen.
 */
export class PluginInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInvariantError";
  }
}

/**
 * Whether a throw is this deployment contradicting itself, rather than anything anybody asked for.
 *
 * CRITERION. Every audience boundary asks THIS instead of listing classes of its own. A fault it
 * answers true for reaches an operator as its own sentence, on a surface only an operator can
 * reach, and reaches everybody else as the fact that the call did not happen — no message, no
 * column names, no instruction about a row.
 *
 * REASON. The distinction already existed and was drawn by hand, once, in each place that
 * remembered to draw it: {@link PluginRefusedError} is relayed verbatim because it is a refusal
 * the asker can act on, and everything else fell into a branch that copies `error.message`
 * onwards. {@link ServerUnresolvableError} was caught by none of them — the refresh route rethrew
 * it into the framework's default handler, which answers a bodiless 500, so the admin page said
 * "That did not work" and named nothing; `grantedTools` put its message in a model's context,
 * where a sentence telling an operator to correct a provenance column became a Bot's explanation
 * to an end user of why their tool failed. Two audiences, one refusal, neither served.
 *
 * {@link PluginInvariantError} is on the same shelf and answers true for the same reason: it is
 * this deployment finding a state its own code says cannot exist. That is not a vendor
 * misbehaving and not a person's to act on mid-call, and its own docblock has said so since it
 * was written — what it lacked was anywhere that asked.
 *
 * A PREDICATE RATHER THAN A SHARED BASE CLASS, because the two live in different modules and must
 * keep doing so: `access.ts` is a leaf that `store.ts` imports, so the shelf cannot be declared
 * once without one of them importing the other back.
 */
/**
 * The one character no PostgreSQL `text` or `jsonb` value can hold, whatever the vendor sent.
 *
 * Not a length limit and not an encoding preference: the server rejects the statement outright,
 * mid-transaction, and the rejection arrives as a query error rather than as anything about the
 * value.
 */
const NUL = "\u0000";

/**
 * A schema this deployment cannot turn into a row, whatever the column would have said.
 *
 * Its own class so the one place that raises it and the one place that contains it are joined by
 * something other than a substring: {@link storableSchema} is the only thrower, and the `try`
 * around the call that turns a listing into rows is the only catcher. Nothing branches on the class
 * — it is recorded the way anything else a vendor's answer could not be made into would be — but
 * naming it keeps a later reader from mistaking it for a fault of this deployment's own.
 */
class SchemaUnstorableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaUnstorableError";
  }
}

/**
 * The same JSON value with every U+0000 gone from it — out of the strings, and out of the keys
 * above them.
 *
 * CRITERION ONE. What is removed is the CHARACTER. A string that merely SPELLS the escape — a
 * backslash and then `u0000`, which is how a JSON Schema excludes control characters and is by far
 * the commonest place those six letters legitimately appear — is handed back untouched.
 *
 * CRITERION TWO. Everything else is rebuilt identical: the same keys, the same nesting, the same
 * scalars.
 *
 * WHAT THIS REPLACED, and why walking the DATA is not a stylistic preference. The strip used to run
 * over the SERIALISED schema — `JSON.stringify(schema).replaceAll("\\u0000", "")` — which is
 * escape-blind by construction. `JSON.stringify` writes a real backslash inside a string value as
 * two of them, so a pattern such as `"[^\u0000-\u001f]"` reached the strip with its backslash
 * doubled and had the TAIL of it eaten, leaving `\-`. That is not a JSON escape, so the
 * `JSON.parse` wrapped around it threw a `SyntaxError` — from a line that sat outside BOTH `try`
 * blocks in `refreshTools`. It left as a bodiless 500 with `lastError` still holding whatever it
 * held before, and on the add path, which refreshes before it answers, it aborted the add AFTER the
 * server row and its audit row had committed.
 *
 * Serialised text cannot tell the byte from the six letters that name it; parsed data can only ever
 * hold one of them. So walking the data is what makes CRITERION ONE expressible at all.
 *
 * A SELF-REFERENTIAL VALUE IS REFUSED rather than quietly truncated, and `ancestors` holds only the
 * chain currently being descended — so one object reached twice side by side is copied twice, which
 * is what a plain JSON document does anyway. Nothing off a wire can be cyclic; a value built inside
 * this process can, and it is a value `jsonb` would refuse in any case. Refused HERE it is a
 * sentence the caller can record; left to the driver it is a statement dump.
 */
function withoutNul(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "string") return value.replaceAll(NUL, "");
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) {
    throw new SchemaUnstorableError(
      "The schema refers back to itself, so it is not a value JSON can hold.",
    );
  }

  ancestors.add(value);
  const stripped: unknown = Array.isArray(value)
    ? value.map((item) => withoutNul(item, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key.replaceAll(NUL, ""),
          withoutNul(nested, ancestors),
        ]),
      );
  ancestors.delete(value);
  return stripped;
}

/**
 * {@link withoutNul} over a schema, answering in the type the column and the row builder use.
 *
 * The walk rebuilds an object as an object and a list as a list, so what comes back is the shape
 * that went in — which is the same promise the `JSON.parse(JSON.stringify(...))` round trip this
 * replaced made about everything except the escape it could not see. The narrowing says out loud
 * what the parameter type already claims.
 */
function storableSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return withoutNul(schema, new Set()) as Record<string, unknown>;
}

/**
 * What a vendor listed, as rows this database will actually take.
 *
 * CRITERION ONE. No two rows carry the same name, whatever the vendor listed.
 *
 * CRITERION TWO. No string reaching the insert contains U+0000, in a column or inside a schema —
 * and nothing else about what the vendor wrote is altered to achieve it, which is a criterion of
 * its own because the first attempt at this one failed it. See {@link storableSchema}.
 *
 * CRITERION THREE. Whatever this raises, its caller catches — see the `try` around the one call
 * site. Everything here runs OUTSIDE the vendor `try` and before the transaction's own, so a throw
 * from here left `refreshTools` unhandled: a bodiless 500, a `lastError` still holding whatever it
 * held before, and an add aborted after its server row and its audit row had already committed.
 *
 * REASON. Both of these used to abort the replace from INSIDE the transaction and OUTSIDE the
 * vendor `try` above it, so they came out of `refreshTools` as a raw `DrizzleQueryError` — whose
 * message is `Failed query: <the whole statement>` followed by `params:` and every value bound to
 * it. That reached an operator's page and the logs as a SQL dump, which is the same disclosure
 * shape as a leaked credential one layer out, and it left `lastError` holding whatever was there
 * before: stale, or null, on a refresh that had in fact failed.
 *
 * FIXED BY NOT REACHING THE DATABASE WITH IT, rather than by catching it better. A vendor that
 * names one action twice is answering about one action — `mcp_tools`' `(server_id, name)` primary
 * key says so, and the first listing is as good an answer as the second, so the duplicate is
 * dropped rather than made into an error somebody has to act on. A control character in a
 * description is not content anybody wants to keep either. What is left after this is a
 * transaction that fails for reasons that are genuinely not the vendor's, which is what the
 * comment on the replace has always claimed.
 *
 * FIRST OCCURRENCE WINS, and the order is the vendor's own. Anything else needs a rule for which
 * of two identical names is the real one, and there is no such rule.
 */
function storableTools(serverId: string, listed: ListedTool[]) {
  const byName = new Map<
    string,
    {
      serverId: string;
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      effect: "read" | "write" | null;
      destructive: boolean;
      version: string | null;
    }
  >();

  for (const tool of listed) {
    const name = tool.name.replaceAll(NUL, "");
    if (byName.has(name)) continue;
    byName.set(name, {
      serverId,
      name,
      /*
       * Defaulted where the COLUMN has a default, because that is what the previous mapping leaned
       * on: it passed these two straight through, so a transport handing back undefined got the
       * `""` and `{}` the schema declares. Reading a method off the value instead would turn the
       * same absence into a TypeError thrown from outside the vendor `try`. Both fields are
       * required by `McpTool` and supplied by every transport here; this keeps the tolerance the
       * insert already had rather than adding a new answer.
       */
      description: (tool.description ?? "").replaceAll(NUL, ""),
      /*
       * By walking the parsed schema rather than its serialised text, because only one of those two
       * can tell the character from the six letters that name it. See {@link storableSchema}: this
       * used to strip the escape out of `JSON.stringify`'s output, which ate the tail of every
       * legitimately-escaped backslash and left a string `JSON.parse` refused.
       */
      inputSchema: storableSchema(tool.inputSchema ?? {}),
      /*
       * What the vendor said, when the vendor said anything.
       *
       * Only Composio publishes an effect and a version, and an MCP server publishes a
       * destructive hint — see `mcp.ts`. All three stay null or false for a transport that says
       * nothing, and `classifyTool` reads null as silence rather than as a value, which is what
       * leaves Notion and Drive classified by their reviewed write list exactly as they were.
       */
      effect: tool.effect ?? null,
      destructive: tool.destructive ?? false,
      version: tool.version?.replaceAll(NUL, "") ?? null,
    });
  }

  return [...byName.values()];
}

export function isDeploymentFault(error: unknown): error is Error {
  return (
    error instanceof ServerUnresolvableError ||
    error instanceof PluginInvariantError ||
    /*
     * A query this database refused is on the shelf for the reason the other two are: it is not a
     * vendor's doing, it is not the asker's to act on, and its message is the one thing here that
     * must not travel. The replace in `refreshTools` was fixed at its own site; every other query
     * on the call path — the advertised-tool read, the connection gate, the vault read, the locked
     * credential swap — throws the same shape into a `catch` that copies `error.message` onward,
     * so answering it here is what makes the four audiences agree without four more branches.
     *
     * Callers that SHOW the sentence to an operator must still ask {@link withoutStatement} for
     * it rather than reading `.message`; this predicate settles who may be told, not what.
     */
    isQueryFailure(error)
  );
}

/** The operator-facing sentence for a fault on that shelf, with no statement in it. */
export function deploymentFaultSentence(error: Error): string {
  return withoutStatement(error);
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
 * A server with no catalogue entry is not reconciled either, and the two shapes that reach here do
 * so for different reasons. A brokered app's actions are classified from the vendor's own
 * per-action label rather than from a list here, so there is no hand-written under-inclusion to
 * find. A server an administrator added by URL has neither a label nor a list, so every tool it
 * offers is already a write and there is no wrongly-permitted read to reconcile.
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
 * The two things an actor field says when the actor is not a person, and they are not the same
 * thing.
 *
 * CRITERION. A field whose purpose is to name who did something must never be written as the empty
 * string. An absent field reads as absent; `""` reads as a value, so a reader grouping the trail by
 * actor gets a person called nothing, and every count of "acts by X" is quietly wrong about them.
 *
 * `deployment` is a positive answer: nobody was asking because the deployment itself acted — a
 * shared credential, a public endpoint, a refresh it ran on its own behalf immediately after an app
 * was added. `unattributed` is the opposite, and the distinction is the whole point of having two:
 * something happened that SHOULD have had a person behind it and this deployment could not say who.
 * `identifyActor` answers `{ id: "" }` for exactly that, and the run is then refused — which is
 * precisely the moment the trail is worth reading, so it must not be the moment it goes blank.
 *
 * Neither is an address, so neither can collide with a user id: every actor written here otherwise
 * is `users.id` or the email a session resolved to.
 *
 * NOT THE SAME AXIS AS `initiator_kind`, and a row carrying both is not contradicting itself.
 * `initiator_kind` answers what set a run in motion; this field answers whose account it reached
 * and who can be named for it. So `initiator_kind: "person"` beside `actor: "unattributed"` reads
 * correctly as a person-initiated request whose person this deployment could not identify. That is
 * the honest reading, and it is the reason this is NOT recorded as `deployment`: that would assert
 * the call went out on the deployment's own credential, and it did not go out at all.
 *
 * `DEPLOYMENT_INITIATOR`'s own doc claims the case of "refusing a caller it could not identify",
 * which overlaps this one and would answer it the other way. Nothing sends it there — the tool path
 * defaults its initiator to person and `identifyActor` returns an empty id rather than a deployment
 * — so the overlap is in the prose, not in the behaviour. It is left alone deliberately rather than
 * resolved by widening either vocabulary unilaterally; whoever owns that constant should narrow its
 * sentence, or a third initiator kind should exist, and neither is this branch's call to make.
 */
const DEPLOYMENT_ACTOR = "deployment";
const UNATTRIBUTED_ACTOR = "unattributed";

/**
 * Whose account this call went out as, for the trail.
 *
 * Reads the resolved descriptor rather than re-deriving from the entry's auth kind. That derivation
 * had no answer for a Composio app — the entry is null, so it fell through to `deployment` for a call
 * that ran in one person's own mailbox, which is the trail being wrong about the one thing a
 * per-person connector exists for.
 *
 * A person-reached server with no actor is `unattributed` and never `deployment`: the call did not
 * go out on a shared credential, it did not go out at all, and naming the deployment would assert
 * an attribution that never happened. See {@link DEPLOYMENT_ACTOR}.
 */
const reachedAsFor = (access: ServerAccess, actorId: string): string =>
  access.reachedAs === "person"
    ? actorId || UNATTRIBUTED_ACTOR
    : DEPLOYMENT_ACTOR;

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
    /*
     * A redirect is a refusal, not a detour to be followed.
     *
     * `tokenUrl` is pinned in the catalogue because this request carries the deployment's client
     * secret and somebody's refresh token, and following a 302 would hand both to whatever address
     * the answer named. Manual leaves the 3xx as the response, which is not `ok`, so it falls into
     * the refusal below. The same guard the authorization-code redemption in `oauth.ts` uses.
     */
    redirect: "manual",
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
 * Whether a value read back out of the vault is a client this deployment can actually present.
 *
 * Guarding the parse is only half of the question. `JSON.parse` answers for SYNTAX, and the
 * `as OAuthClient` cast behind it answers for nothing at all — so a row holding
 * `{"client_id":"","client_secret":""}`, which is what a hand-repair or a half-written row leaves,
 * parses cleanly and yields a client whose `clientId` is `undefined`.
 *
 * SHAPE AND SYNTAX ARE ONE CONCERN, which is why all three readers ask this beside their parse
 * rather than only around it: either way the deployment holds a client it cannot use, and the
 * operator's signal has to survive both. `unusableClient` is that signal, and it is deliberately
 * distinct from `noClient`'s holding none.
 *
 * The shape half earns the check by ending WORSE than the syntax half beside it. An `undefined`
 * client id is sent to the vendor, the vendor answers `invalid_client`, and
 * {@link refuseAndReplaceEvictedClient} reads that as the vendor having disowned our registration —
 * so a corrupt LOCAL row replaces the deployment-wide client every existing consent was granted
 * against, and reports it as the vendor's doing rather than naming the credential that broke.
 *
 * The id has to be there; the secret only has to be a string. A public client registered
 * dynamically proves itself with PKCE and is stored with an empty secret ON PURPOSE —
 * `registerDynamicClient` checks the id exactly this way and defaults the secret to `""` — so
 * demanding a non-empty secret here would refuse every self-registering entry in the catalogue.
 */
function isUsableClient(value: unknown): value is OAuthClient {
  if (typeof value !== "object" || value === null) return false;
  const { clientId, clientSecret } = value as Partial<OAuthClient>;
  return (
    typeof clientId === "string" &&
    clientId !== "" &&
    typeof clientSecret === "string"
  );
}

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

/**
 * The names that read as "tell me who this key belongs to".
 *
 * A PREFERENCE AND NOT THE RULE. What makes an action safe to probe with is decided by
 * {@link createPluginStore}'s `probeActionFor` on the vendor's own labels; this is only which of the
 * safe ones to reach for first. An identity call is the cheapest request an app has and the one
 * whose failure most clearly means "this key is wrong" rather than "that record does not exist" —
 * but sampling fifteen key-based apps in the live catalogue, only four publish one, so a chooser
 * that INSISTED on this shape would refuse to probe most of the apps this deployment offers.
 *
 * Anchored at the end, because these are suffixes of a prefixed action name — `STRIPE_GET_ME`,
 * `LINEAR_GET_ME` — and an unanchored match would take `SLACK_PROFILE_SET` for an identity read.
 */
const IDENTITY_ACTION = /(_GET_ME|_PROFILE|_CURRENT_USER|_USER_INFO|_WHOAMI)$/;

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
  /**
   * Composio the broker, absent on a deployment that has not configured one.
   *
   * OPTIONAL BECAUSE ITS ABSENCE IS A STATE RATHER THAN A MISCONFIGURATION. An unset
   * `COMPOSIO_API_KEY` is the documented default: where it is unset there is nothing to connect,
   * nothing to grant and no brokered tool for a Bot to call, and what is left on screen is one row
   * that goes nowhere under More apps on the admin Plugins page. So the store is constructible
   * without one and every path that needs one says so by raising {@link BrokerUnconfiguredError}.
   * A required field would make every caller that never enables an app — the routes, the tests
   * above — invent a broker to get a store.
   */
  broker?: ComposioBroker;
  /** Where the vendor sends people back; needed to (re)register a dynamic client. */
  redirectUri?: string;
};

/**
 * The literal recorded on the row, which is the scheme a later call must keep using.
 *
 * TYPED AS {@link RecordedScheme} RATHER THAN `string`, so that what this writes and what
 * {@link schemeKind} recognises are held to one set by the compiler. A literal spelled here that
 * the reader does not know would be read as `unreadable` — a key app that connects nobody, or a
 * consent app no confirm can verify — and nothing but this annotation would say so.
 */
function schemeFor(connection: BrokerConnection): RecordedScheme | null {
  switch (connection.kind) {
    case "consent":
      return "OAUTH2";
    case "self-registering":
      return "DCR_OAUTH";
    case "fields":
      return connection.authScheme;
    case "no-auth":
      return "NO_AUTH";
    case "unsupported":
      return null;
  }
}

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
  // No default, unlike the seams above: there is no real implementation in this tree to fall back
  // to, and a deployment with no Composio key is supposed to have no broker. See `./broker`.
  const broker = options.broker;

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
   *
   * WHICH OF THE TWO IS DECIDED BY CLASS. {@link CredentialUnusableError} is the one thing the vault
   * raises that means the credential is gone, and everything else that can come out of this call is
   * a fault: a query this database refused, a connection it would not open, an envelope that would
   * not decrypt. Those are rethrown untouched, which puts a query failure on the
   * {@link isDeploymentFault} shelf where the four audiences already agree about it.
   *
   * WHAT THIS USED TO BE, and why the difference is not cosmetic. It asked whether `error.message`
   * CONTAINED "revoked" or "not found". drizzle's message for a failed query begins `Failed query:
   * select "encrypted_value", "revoked_at" from "credentials" …` — the column this very read selects
   * — so every database fault on the vault read matched the first substring and was converted into
   * `onRevoked`: a `PluginRefusedError`, which is the one class this codebase relays VERBATIM. A
   * Postgres that was down told the model the credential had been withdrawn, told a browser the same
   * through the routes that pass a refusal out as a 400, and wrote it into `mcp_servers.last_error`
   * for an operator to act on — sending somebody to re-add a credential that was never the problem
   * while the real fault was reported nowhere. The same argument {@link TokenRefusedError} carries a
   * `code` for: a decision that reads prose is one rewording away from being wrong in silence, and
   * this one did not even need the rewording.
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
      if (error instanceof CredentialUnusableError) {
        throw new PluginRefusedError(onRevoked, null);
      }
      throw error;
    }
  }

  /**
   * The token one call goes out with, and whose it is — decided from `access.credential`, so that
   * this function and the audit row cannot disagree about whose account a call ran in.
   *
   * For a `deployment-token` server this is what it always was: the one credential an administrator
   * gave the server, used for everybody. A `none` server reaches the same branch and finds nothing
   * to decrypt, which is the right answer for an endpoint that takes no credential at all.
   *
   * For a `brokered` server there is no token here AT ALL. The deployment's one key belongs to the
   * transport and never travels through this function, so nothing here can leak it into a connection
   * object, an error or an audit row. What this function contributes instead is the two refusals
   * that have to happen before a call is spent at the broker: a run nobody is attributed for, and an
   * asker who has not connected the app — so a person is told their own next step rather than shown
   * the broker's error about an account it cannot find. A third refusal sits between those two, for
   * a brokered row whose url names no Composio app; nothing in the product creates such a row, so no
   * person's situation reaches it.
   *
   * For a `person-oauth` server it is the asker's own, and every branch that cannot prove it has the
   * asker's grant refuses. There is deliberately no fallback. A fallback is the one bug this design
   * exists to make impossible: answering out of whatever the deployment, or the last person to
   * connect, happened to be able to see — which returns a confident answer assembled from documents
   * the person asking cannot open, and looks exactly like a correct answer.
   *
   * Nothing is cached on any path, and only on the `person-oauth` one is that a decision. There, the
   * refresh token is exchanged for an access token per call and the access token is thrown away, so
   * there is no stored copy of anybody's access for a disconnect to have to find. That costs a round
   * trip to the vendor's token endpoint on every call, which is the price of revocation being
   * complete by construction rather than by cleanup. The other two paths have nothing to cache: a
   * `deployment-token` is decrypted out of the vault per call, and a `brokered` key is never held
   * here at all.
   */
  async function connectionTokenFor(
    row: {
      id: string;
      title: string;
      credentialId: string | null;
      /*
       * NO `authScheme` HERE, DELIBERATELY. The scheme that decides whether a brokered call needs a
       * connection row is the APP'S, read through `brokeredAppScheme` below — and this row's own
       * column is the near-miss that reading replaced. A field kept here for convenience would be
       * the wrong answer sitting in the parameter list of the function that must not use it.
       */
    },
    entry: CatalogueEntry | null,
    actorId: string,
    access: ServerAccess,
  ): Promise<{ token?: string }> {
    /*
     * A brokered app, where the deployment holds one key and Composio keeps the accounts apart.
     *
     * Refused HERE rather than in the transport, for the two reasons the `user-oauth` branch below
     * is: a person gets a sentence naming the step they can take, and no call is spent at the
     * vendor finding out. The transport refuses an unattributed run again as a last line, so
     * deleting either that guard or this one has to turn a test red. The unconnected case has no
     * such twin: the transport has no notion of a connection at all, so the last line there is
     * Composio itself — which is what refusing locally earns its place for, since it turns the
     * broker's error about an account it cannot find into a sentence naming the person's own next
     * step.
     *
     * The throw between the two is a third refusal, but not one anybody can act on: it fires only
     * for a brokered row whose url names no Composio app, which nothing in the product can create.
     * It is what keeps this gate keyed on the app the url names, and its own comment says why
     * neither fallback is available.
     *
     * There is no token. The key belongs to the transport and never travels through this function, so
     * nothing here can leak it into a connection object, an error or an audit row.
     */
    if (access.credential === "brokered") {
      if (!actorId) {
        throw new PluginRefusedError(
          `${row.title} runs in the account of the person asking, and this run is not attributed to anybody.`,
          null,
        );
      }

      /*
       * Narrowing, and a refusal that is genuinely reachable.
       *
       * `access.toolkit` is the app slug read off this row's url in `access.ts`, and it is NULL
       * whenever that url does not name a Composio app — `accessFor` still answers `brokered` for
       * any row whose provenance column says composio, so `{ credential: "brokered", toolkit: null }`
       * is a state a hand-edited or restored row really produces. The test beside `accessFor`
       * asserts it, and `plugin-store.integration.test.ts` gates this branch end to end.
       *
       * A throw rather than a fallback, for the reason the `user-oauth` narrowing below throws: both
       * alternatives fail open. Falling back to `row.id` checks the connection against a spelling
       * nothing dials, and skipping the gate spends the deployment's shared key on a connector whose
       * whole purpose is to keep one person's account out of another's. The compiler forces SOME
       * narrowing here — drizzle's `eq` will not take `string | null` — but only the test named
       * above stops that narrowing from being the fallback.
       */
      if (!access.toolkit) {
        throw new PluginInvariantError(
          `${row.id} resolves to a brokered credential with no Composio app in its url.`,
        );
      }

      /*
       * AN APP THAT NEEDS NO AUTHENTICATION HAS NO ROW TO FIND, AND CANNOT EVER HAVE ONE.
       *
       * `composio_connections` is the whole of the permission for a brokered call, and every row in
       * it means one thing: this person granted this deployment access to their account at this
       * app. A `NO_AUTH` app has no account and no consent — Composio refuses even to hold an
       * authorization config for one — so nobody presses Connect and nothing could write the row.
       *
       * THE ALTERNATIVE WAS WRITING ONE ANYWAY, and it is worse than it looks. Offboarding reads
       * this table to find what to revoke, the audit trail reads it to say what somebody had, and
       * disconnect reads it to know what to end. Rows where no person consented and no account
       * exists are indistinguishable, a year on, from rows where somebody did.
       *
       * The scheme is the one RECORDED when the app was enabled rather than a fresh read of the
       * catalogue: a vendor that re-labels an app must not turn a gate off underneath a deployment
       * that is already running.
       *
       * AND IT IS THE APP'S RECORDED SCHEME, NOT THIS ROW'S, WHICH IS THE SAME KEYING THE GATE
       * BELOW ALREADY USES.
       *
       * CRITERION. Whether a brokered call needs a connection row is decided by the app the url
       * names, out of the one row that answers for it — see {@link brokeredAppRow}.
       *
       * REASON. This read `row.authScheme`, the column on whichever row the call was dialled
       * through, while the gate two lines down looks the connection up by TOOLKIT. Two rows may
       * name one app, so the two halves of one decision were about different rows — and this half
       * fails open: a duplicate row recording `NO_AUTH` at a key app's url skips the per-person gate
       * entirely, and the deployment's own Composio key runs a call for somebody who connected
       * nothing. The other direction merely refuses a call that could have gone through. A gate and
       * its exemption have to be keyed on the same thing, and the gate's key is the app.
       *
       * ONE SMALL READ PER BROKERED CALL, which is the price of that. `mcp_servers` holds one row
       * per connector on any deployment, and the call it guards is a network round trip to the
       * vendor.
       */
      if ((await brokeredAppKind(access.toolkit)) === "none") return {};

      /**
       * WHAT THAT GATE ANSWERS FOR EACH KIND OF APP, WRITTEN DOWN BECAUSE THE LINE ABOVE DOES NOT.
       *
       * Type-only and erased; see {@link Decides}. This was the ONE scheme read in the file that
       * compared a raw literal instead of asking {@link schemeKind}, so the vocabulary it decided on
       * was not the vocabulary it read: `NO_AUTH` was a CONSENT-kind scheme, and this line exempted
       * it from inside that member while every other consumer of `consent` demanded a row. One
       * member answered two ways is the drift a closed vocabulary exists to make impossible, and the
       * cost was paid next door — {@link confirmBrokeredConnection} asked the classifier, was told
       * `consent`, and wrote the verified connection row this gate and the connect route both exist
       * to keep out of that table. `none` is now its own member, and this asks for it by name.
       */
      type _NoAuthGateDecides = Decides<
        SchemeKind,
        {
          key: "demands a connection row, because a key app has an account to hold one";
          consent: "demands a connection row, because somebody consented and the row is that grant";
          none: "lets the call through with no row at all — there is no account, so there is nothing anybody could have granted";
          unreadable: "demands a connection row, which is the closed direction and the right one";
        }
      >;

      /*
       * Keyed on the app the call will run in, which is the one the url names.
       *
       * `row.id` is a display key and nothing holds it equal to the slug in the url, so a row named
       * `gmail` at `composio://slack` passed this gate on a Gmail connection and then ran a Slack
       * action — the person having connected an app they were never asked about.
       */
      const [connected] = await database
        .select({ toolkit: composioConnections.toolkit })
        .from(composioConnections)
        .where(
          and(
            eq(composioConnections.toolkit, access.toolkit),
            eq(composioConnections.userId, actorId),
          ),
        )
        .limit(1);

      if (!connected) {
        throw new PluginRefusedError(
          `You have not connected your ${row.title} account. Connect it in Settings and ask again.`,
          null,
        );
      }

      return {};
    }

    if (access.credential !== "person-oauth") {
      const token = row.credentialId
        ? await secretFor(
            row.credentialId,
            `${row.id} needs a credential this deployment no longer holds. An administrator has to add it again.`,
          )
        : undefined;
      return { token };
    }

    /*
     * Narrowing, not a second decision.
     *
     * `access.credential === "person-oauth"` is derived in `access.ts` from exactly this auth kind,
     * so the branch above has already established it — but the derivation runs through a lookup
     * table the compiler cannot follow back to `entry`. Nothing below re-decides whether this is a
     * per-person server; it only reads the OAuth details that kind carries.
     *
     * A throw rather than a fallback. If the descriptor and the entry ever did disagree, answering
     * out of the deployment's own credential is precisely the failure the comment above this function
     * says must be impossible.
     */
    if (entry?.auth.kind !== "user-oauth") {
      throw new PluginInvariantError(
        `${row.id} resolves to a per-person credential with no user-oauth catalogue entry.`,
      );
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
      /*
       * Decrypted outside the guard below, so that `secretFor`'s own refusal for a revoked or
       * missing row is not caught here and relabelled. Only the parse is guarded.
       */
      const decrypted = await secretFor(server.credentialId, unusableClient);
      let parsed: unknown;
      try {
        parsed = JSON.parse(decrypted);
      } catch {
        /*
         * Unreadable is the same as none, exactly as it is for {@link heldOAuthClient} and
         * {@link storedOAuthClient}: there is nothing here to present to a vendor. Those two answer
         * null because their callers are deciding whether a consent flow can start; this one is
         * already mid-call, and its every caller would have to turn a null into this same refusal
         * on the next line — so it raises it.
         *
         * THE PARSER'S OWN WORDS ARE NEVER CARRIED. `JSON.parse` reports failure by quoting the
         * input it choked on, and the input here is the DECRYPTED OAuth client. Rethrowing it puts
         * a fragment of the client secret — under Bun's parser, the whole of it when the stored
         * value is a bare token — into the `mcp.call_failed` payload and into
         * `mcp_servers.last_error`, two durable stores that the Plugins page draws for anybody who
         * can read it.
         *
         * A reader should conclude that the signal is not lost, only the bytes: `unusableClient`
         * says the deployment holds a client it cannot use, which is distinct from `noClient`'s
         * holding none, and it names connecting again as what replaces it. An operator can tell
         * the credential is broken; nobody learns what was in it.
         */
        throw new PluginRefusedError(unusableClient, null);
      }
      /*
       * The same refusal for a value that parsed and is not a client — see {@link isUsableClient},
       * which is where the criterion and the reason live, because all three readers share both.
       *
       * Raised rather than answered null, for the reason above: this caller is mid-call. It is the
       * third throw in a row here — `noClient`, then the parse, then this — and that is the shape
       * of the contract rather than a repetition to collapse. Each names a different state of the
       * deployment's credential, and only the sentence is shared between the last two.
       */
      if (!isUsableClient(parsed)) {
        throw new PluginRefusedError(unusableClient, null);
      }
      return { client: parsed, registeredAt: server.registeredAt };
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
      const parsed: unknown = JSON.parse(
        await decryptSecret(encryptionKey, held.encryptedValue),
      );
      // A value that parsed and is not a client is unreadable in the same way and for the same
      // caller — see {@link isUsableClient}. Null, because that is what this reader's caller acts
      // on: it goes and registers one, which is the answer to holding none.
      return isUsableClient(parsed) ? parsed : null;
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
      const parsed: unknown = JSON.parse(
        await decryptCredentialForUse(
          encryptionKey,
          credentials,
          row.credentialId,
        ),
      );
      // A client that parsed and is not one is as unusable as the revoked or missing row the catch
      // below answers for, and is the same none to every caller — see {@link isUsableClient}.
      return isUsableClient(parsed) ? parsed : null;
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

  /**
   * A brokered app's row is not something another add path may write through.
   *
   * CRITERION. `addServer` and `addCustomServer` refuse outright when the id they are about to
   * upsert already holds a row {@link accessFor} answers `brokered` for. Both of those paths write a
   * url of their own choosing, and neither may write one over an app somebody is connected to.
   *
   * REASON. The url is the ONLY place the app slug is written down. `connectionTokenFor` reads it to
   * decide whose account a call runs in, `removeServer` reads it to find the accounts to end at
   * Composio, and `retireConnectionsFor` finds a person's rows by the same string — so the moment
   * another path rewrites that url, every `composio_connections` row behind it stands for an app
   * nothing in this deployment can name any more. Consent that no operation can withdraw is the one
   * state this feature must not reach, and it is reachable by two ordinary administrative acts.
   *
   * REFUSED RATHER THAN REPAIRED, WHICH IS NOT THE ANSWER THE OTHER DIRECTION GETS.
   * {@link addBrokeredApp} converts a row it lands on, because there the url it writes is the app
   * and the row comes out saying so. Here the opposite is true: writing `provenance = "custom"`
   * alongside the new url would make the row self-consistent and lose the accounts just the same.
   * Consistent and orphaned is no better than contradictory and orphaned, so there is nothing to
   * write — only an act to decline.
   *
   * AND THE ADMINISTRATOR IS LEFT A REAL STEP. Removing the app ends every account at the vendor on
   * the way out and takes the row with it, after which the name is free for an endpoint. The
   * refusal says that, because the alternative reading — "this name is taken forever" — is not true
   * and would send somebody editing the database.
   *
   * ASKED WITH NO ENTRY, the reading {@link removeServer} uses, and for its reason: an entry can
   * only ever SUPPRESS the brokered answer, so passing one a colliding id looked up would hide the
   * brokered state of the very row most in need of protecting.
   */
  function requireNotBrokered(
    serverId: string,
    existing:
      | { provenance: string; url: string; authScheme: string | null }
      | undefined,
  ) {
    if (!existing) return;
    if (accessFor(existing, null).credential !== "brokered") return;
    throw new CustomServerRefusedError(
      `${serverId} is a Composio app this deployment has enabled, and people may have connected their accounts to it. Remove the app first — which ends those accounts at Composio — and the name is then free.`,
    );
  }

  async function requireServer(serverId: string) {
    const [row] = await database
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!row) throw new CatalogueEntryUnknownError(serverId);

    // Null for a custom server, and every caller handles that by assuming the worst about it.
    const entry = catalogueEntry(row.id);
    if (row.provenance === "first-party" && !entry) {
      // The row outlived its catalogue entry, which means a build removed a vendor while a
      // deployment still had it added. Refused rather than reached: the pinned host that made it
      // admissible no longer exists to check against, so there is nothing left that says this URL
      // is one we agreed to talk to.
      throw new CatalogueEntryUnknownError(row.id);
    }
    /*
     * Resolved here so every caller reads the same answer.
     *
     * Three call sites used to derive their own — the transport, the credential and the audit row —
     * and a Composio app made all three of them wrong at once. One derivation means they cannot
     * disagree, and `access.ts` is the only place a new kind of server has to be taught about.
     */
    return { row, entry, access: accessFor(row, entry) };
  }

  /** What a row that answers for an app is asked for: which row it is, and how the app connects. */
  type BrokeredAppRow = { id: string; authScheme: string | null };

  /**
   * The one `mcp_servers` row that answers for the app a url names: its id, and its scheme.
   *
   * KEYED ON THE URL, which is where a brokered row records which app it is; `mcp_servers.id` is a
   * display name and nothing holds the two equal. A row called `gmail` at `composio://slack` would
   * have somebody's Slack key attached to a scheme read off Gmail's row — and, through the id this
   * also answers, a probe chosen off Gmail's action list and spent on their Slack key. That stake is
   * shared by every caller: {@link connectBrokeredWithFields}, {@link recheckBrokeredConnection},
   * {@link confirmBrokeredConnection} and {@link disconnectBrokered} read the scheme,
   * {@link probeBrokeredConnection} reads the id.
   *
   * AND ORDERED, BECAUSE THE URL IS NOT A KEY. `mcp_servers.url` has no unique index behind it, so
   * two rows may name one app and `limit(1)` over them is the planner's choice rather than an
   * answer. Each caller used to take it unordered and separately: the same person, the same app, and
   * five readings free to disagree with each other and with themselves between two page loads. What
   * that costs is a live key connection refused in words about a sign-in screen nobody used —
   * "connect it the way it asks for", over an app connected exactly the way it asked — and, on the
   * id, a Re-check the listing offers off the app's own row whose press resolves to the OTHER row,
   * finds no action published there and reports that nothing could be tried: the `checkable`/`probe`
   * deadlock, reached through the duplicate rather than through a composed id.
   *
   * SO THE READ IS ONE FUNCTION AND NOT A RULE EACH CALLER REPEATS. The lower id answers, which is
   * the rule {@link brokeredConnectionsFor} names the app by, so the row the page shows an app under
   * is the row every one of these reads off — and a sixth caller cannot re-derive the choice
   * differently, because there is nothing here to re-derive.
   *
   * NULL FOR AN APP WITH NO ROW AT ALL, and that is an answer rather than a gap: a person can hold
   * an account at an app this deployment has since removed, nothing names the scheme it was
   * connected under any more, and every caller treats the null as "not an app we hold a key for" —
   * or, for the probe, as "there is no app left to check".
   */
  async function brokeredAppRow(
    toolkit: string,
  ): Promise<BrokeredAppRow | null> {
    const url = `composio://${toolkit}`;
    return (await brokeredAppRowsAt([url])).get(url) ?? null;
  }

  /**
   * The same answer for several urls at once, and the ONE PLACE the ordering rule is written.
   *
   * THE RULE IS SQL'S `order by id` AND THE FIRST ROW SEEN PER URL, which is what
   * {@link brokeredAppRow} asks for one app and what {@link brokeredConnectionsFor} and
   * {@link listServers} ask for many. Those three had their own spellings of it, and one of them —
   * the listing — spelled it as a JavaScript `<` over rows it had already fetched. That is UTF-16
   * code unit order; this is the deployment's collation. They agree for ASCII on a `C` database and
   * are free to disagree anywhere else, and where they disagreed the settings page named an app
   * under one row while every read behind its buttons was about another. So the rule is a function
   * and the callers have nothing left to re-derive.
   *
   * A URL WITH NO ROW IS SIMPLY ABSENT from the map, which is the null {@link brokeredAppRow}
   * answers and the connection {@link brokeredConnectionsFor} drops: a person can hold an account
   * at an app this deployment has since removed, and there is no row to name it by.
   *
   * EMPTY IN, EMPTY OUT AND NO QUERY, because `inArray` with no values is a statement no database
   * needs to be asked.
   */
  async function brokeredAppRowsAt(
    urls: string[],
  ): Promise<Map<string, BrokeredAppRow>> {
    const answering = new Map<string, BrokeredAppRow>();
    if (urls.length === 0) return answering;
    const rows = await database
      .select({
        id: mcpServers.id,
        url: mcpServers.url,
        authScheme: mcpServers.authScheme,
      })
      .from(mcpServers)
      .where(inArray(mcpServers.url, urls))
      .orderBy(asc(mcpServers.id));
    for (const row of rows) {
      if (!answering.has(row.url)) {
        answering.set(row.url, { id: row.id, authScheme: row.authScheme });
      }
    }
    return answering;
  }

  /** {@link brokeredAppRow}'s scheme, for the callers that ask only what the app is connected with. */
  async function brokeredAppScheme(toolkit: string): Promise<string | null> {
    return (await brokeredAppRow(toolkit))?.authScheme ?? null;
  }

  /**
   * What that scheme decides, which is what every caller actually branches on.
   *
   * ONE CLASSIFICATION OVER ONE ROW, and the second half of what {@link brokeredAppRow} is for.
   * That function ends the disagreement about WHICH ROW answers for an app; this one ends the
   * disagreement about what its column MEANS. They were separate questions and were answered
   * separately: four callers each asked {@link isFieldScheme} and treated everything else — a
   * consent scheme, a literal from another deployment, a null — as one answer, and only three of
   * them could survive being wrong about it. The confirm is the fourth, and it WRITES.
   *
   * SO THE THIRD ANSWER TRAVELS, rather than being flattened at the call site. See
   * {@link SchemeKind}: `unreadable` is what a caller needs in order to fail closed, and a boolean
   * cannot carry it.
   */
  async function brokeredAppKind(toolkit: string): Promise<SchemeKind> {
    return schemeKind(await brokeredAppScheme(toolkit));
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

      /*
       * Not over a brokered row. See {@link requireNotBrokered} for what such a row would lose.
       *
       * Unreachable from the shipped product as it stands — `addBrokeredApp` mints `composio-<slug>`
       * and no catalogue entry is spelled that way — and asked anyway, because the row the check is
       * about is by definition one that arrived some other way: a hand edit, a restore, a build
       * whose catalogue named an app a past build brokered. This path writes the catalogue's url
       * over whatever is there, which is exactly the write that strands the accounts.
       */
      const [existing] = await database
        .select({
          provenance: mcpServers.provenance,
          url: mcpServers.url,
          // Part of what `accessFor` resolves a row with — see there. Nothing on this path reads
          // the answer's `reachedAs`, but the column travels with the other two so no caller has
          // to know which of the four answers the one it wants depends on.
          authScheme: mcpServers.authScheme,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, resolved.entry.key));
      requireNotBrokered(resolved.entry.key, existing);

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
             * THE WHOLE IDENTITY THE CATALOGUE DECIDES, not the url alone.
             *
             * These three columns and the url are one statement — this row is that reviewed entry —
             * and an update that moved one of them and left the rest was a row describing two
             * different servers at once. `provenance` is read by `requireServer`, which refuses a
             * `first-party` row with no entry, and by `accessFor`, which reads it whenever there is
             * no entry to overrule it; `vendor` is what the first-party rule is checked against.
             * Left behind, a row that arrived by another path kept saying so at an address only the
             * catalogue chose — so every surface that asks how a server got here answered with the
             * way it USED to get here.
             *
             * The entry wins over the row everywhere else too (see `accessFor`), so this is that
             * same order written down at the one moment the row is being established rather than
             * read.
             */
            title: resolved.entry.title,
            vendor: resolved.entry.vendor,
            provenance: "first-party",
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

      /*
       * Nor may it take the name of a screen. `/admin/plugins/composio` is a static route — the app
       * directory's own page — and a static route is matched ahead of `/admin/plugins/$key`, so a
       * server sitting at this id would be listed and then open somebody else's page instead of its
       * own. Brokered servers are `composio-<slug>` and no catalogue entry is called this, which
       * leaves a hand-typed id as the only way to reach it.
       */
      if (input.id === "composio") {
        throw new CustomServerRefusedError(
          "composio is the name of this deployment's own Composio screen, so a server added there could never be opened. Choose another.",
        );
      }

      /*
       * NOR THE NAMESPACE THE BROKERED ROWS ARE MINTED IN, which is the reservation above one step
       * further out.
       *
       * CRITERION. No server added by URL may take an id beginning `composio-`, whether or not a row
       * is sitting there today.
       *
       * REASON. {@link addBrokeredApp} composes its id as `composio-<slug>` from the app an
       * administrator enabled, so that space is already spoken for by a path that writes
       * `composio://` urls into it. Unreserved, the two paths write one row: enabling an app over a
       * typed endpoint, or typing an endpoint over an app somebody is connected to. The second of
       * those is the one that cannot be undone — see {@link requireNotBrokered} — and this is what
       * stops either from arising in the first place, rather than catching them one row at a time.
       *
       * A PREFIX RATHER THAN A LOOKUP OF WHAT IS ENABLED TODAY. "Is there a brokered row at this id"
       * is a question whose answer changes: an app removed this morning frees the name, and the next
       * press of Add takes it back from whoever typed it in between. The namespace is what a reader
       * of a grant or a policy rule can rely on without asking the database what year it is.
       *
       * It is the same objection the curated-slug refusal above makes, and the same one
       * `addBrokeredApp` records for its own id: the id prefixes every tool name and is what a grant
       * and a policy rule are written against, so a row shadowing another path's namespace inherits
       * rules that were written about something else.
       */
      if (input.id.startsWith("composio-")) {
        throw new CustomServerRefusedError(
          `Names beginning composio- belong to the Composio apps this deployment enables, so ${input.id} is not a name a server added by URL can take. Choose another.`,
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
        .select({
          url: mcpServers.url,
          credentialId: mcpServers.credentialId,
          // Read for the refusal below. The namespace rule above already keeps this path away from
          // every id `addBrokeredApp` mints; this is the same rule asked of the ROW, which is what
          // covers one that arrived before the namespace was reserved, or by restore.
          provenance: mcpServers.provenance,
          // The third of what `accessFor` resolves a row with. See there.
          authScheme: mcpServers.authScheme,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.id));

      /*
       * Before the address rule below, because it is the stronger statement about the same write.
       *
       * That one is about a credential being carried to an address, and it lets an add through when
       * no token is involved. This one is about the address ITSELF being the only record of which
       * app a set of connections belongs to, and no absence of a credential makes that write
       * survivable. See {@link requireNotBrokered}.
       */
      requireNotBrokered(input.id, existing);

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
             * WHAT THE ROW NOW IS, written beside the address that made it that.
             *
             * `vendor` is derived from the url on the way in, so leaving it behind while the url
             * moved left the column naming a host this row no longer addresses — and it is what the
             * first-party rule is checked against, not a caption. `provenance` is the same fact one
             * level up: a row whose entry a build removed still reads `first-party`, and
             * `requireServer` refuses exactly that shape as a vendor it can no longer check a pinned
             * host for. Adding it by URL is what makes it a typed address rather than a reviewed
             * one, so this is the act that settles the column.
             *
             * The one conversion this cannot make is out of a brokered row, which is refused above
             * rather than written here: there the url is the only record of which app a set of
             * consents belongs to, so a rewrite loses them whatever else is written alongside.
             */
            vendor: new URL(input.url).hostname,
            provenance: "custom",
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
     * Enable one app of the broker's catalogue, which is a third way for a server to arrive.
     *
     * NO URL IS TAKEN FROM A CALLER, WHICH IS WHY THERE IS NO HOST RULE HERE. `addCustomServer`
     * guards the address because the address is what an administrator typed and what a credential
     * would then be spent at; this one composes `composio://<slug>` itself, and a brokered row is
     * never dialled at a host at all — the transport reads the app off that url and asks Composio,
     * over the deployment's own key. So the only thing left to check about the url is that it says
     * what this call meant, and {@link toolkitOf} is what checks it: the slug goes in, the url comes
     * back out through the very function `accessFor` will read it with, and a slug those two
     * disagree about is refused rather than stored. A pattern written here instead would be a second
     * opinion about the shape of an app name, and the reading that decides which app a call runs
     * against is the one that has to be satisfied.
     *
     * THE AUTH CONFIG COMES BEFORE THE ROW, in that order and not the other. An auth config is what
     * a person's connection is then created against, so a row written first is an app an
     * administrator can see on the page, grant to a Bot and press Connect on, with nothing at the
     * vendor for any of it to attach to. Asking first is also what makes a failure leave nothing
     * behind: the broker throws, this call throws, and no row, no action and no audit entry claims
     * an app was enabled. {@link ComposioBroker.ensureAuthConfig} is idempotent precisely so that
     * enabling an app twice — two administrators, or a retried request — is allowed to do this.
     *
     * THE ID IS PREFIXED AND THE URL IS NOT. `composio-linear` is what prefixes tool names and what
     * a grant and a policy rule are written against, so it must not land on a curated entry's key —
     * which `accessFor` refuses outright as a row claiming to be two servers at once — nor on one of
     * the ids the integration suite reserves for its own fixtures: `gmail`, `notion`, `bot_helper`.
     * The prefix puts every brokered row out of reach of all of them. WHICH APP THE ROW IS still
     * comes off the url and only off the url, because that is where `accessFor` and the brokered
     * gate behind it both read it from; the id names the row and never the app, and nothing may
     * start reading one as the other.
     */
    async addBrokeredApp(input: {
      slug: string;
      title: string;
      logo?: string | null;
      by: string;
      /**
       * How this app connects, resolved from the catalogue row the administrator chose.
       *
       * Taken rather than derived here, because the caller has already read it off that row and a
       * second derivation is a second answer — the one thing {@link BrokerConnection} exists to
       * prevent. It decides what config is created at the vendor, and it is what this row records.
       */
      connection: BrokerConnection;
    }): Promise<ServerRecord> {
      // Before anything at all. A deployment with no key has no catalogue for this app to have been
      // chosen from, so there is nothing here to half-do and nothing to say but the setting.
      if (!broker) throw new BrokerUnconfiguredError();

      const url = `composio://${input.slug}`;
      if (toolkitOf(url) !== input.slug) {
        throw new CustomServerRefusedError(
          `${input.slug} is not a name a Composio app can have. An app is named in letters, numbers, underscores and hyphens, because that name is read back out of this row's url to decide which app a call is against.`,
        );
      }

      /*
       * WHAT THE ROW ALREADY SAYS, READ BEFORE ANYTHING IS WRITTEN, because after the upsert this
       * question cannot be asked any more — the insert below would have answered it.
       *
       * It is the scheme the app's ANSWERING row records, which is what every brokered reader
       * resolves and is not always the row the upsert names. See {@link brokeredAppRow}.
       */
      const recorded = await brokeredAppScheme(input.slug);

      const configured = await broker.ensureAuthConfig({
        toolkit: input.slug,
        name: input.title,
        connection: input.connection,
      });

      /*
       * THE SCHEME THIS ENABLE MAY WRITE DOWN, WHICH IS NOT ALWAYS THE ONE THE CATALOGUE RESOLVES.
       *
       * CRITERION. What this row records is what the authorization config standing at Composio was
       * created as — never what today's catalogue says the app could be connected with.
       *
       * REASON. {@link ComposioBroker.ensureAuthConfig} reuses a config of ours whatever scheme it
       * holds, and it used to say nothing about having done so, so every path here wrote the
       * catalogue's answer. An app enabled while Composio published only a key, and later given
       * managed OAuth, came out of a second press of Add recording `OAUTH2` beside a config that is
       * still `API_KEY`: `brokeredAppKind` then says `consent`, so `connectBrokeredWithFields`
       * refuses every submission while `authorize` mints consent links against a key config — the
       * exact "sent to a consent screen that had nothing to ask them for" failure that method's own
       * comment describes. And pressing Add again could never repair it, because the reuse is what
       * caused it.
       *
       * `standing` IS THEREFORE THE ONE ANSWER THAT KEEPS WHAT WAS THERE, and it falls back to the
       * catalogue only where nothing was recorded at all — a row restored without the column, or an
       * app whose config was made before this deployment recorded one. A guess is the best available
       * answer there and it is no worse than what stood before; everywhere else the recorded word
       * wins.
       *
       * AND `created` MAY WRITE FREELY, connections or no connections: the config those connections
       * were made against is gone from Composio — that is why one had to be created — so the new
       * scheme is the only true thing to record about the app.
       */
      const scheme =
        configured === "standing"
          ? (recorded ?? schemeFor(input.connection))
          : schemeFor(input.connection);

      /*
       * THE COMPOSED NAME IS SPELLED WHERE IT IS MINTED AND IS GIVEN NO BINDING TO BE REUSED FROM.
       *
       * It used to be `const id`, and everything below this statement then had a plausible-looking
       * server id to reach for — which is how four review rounds each moved one site onto the
       * resolved row and left the next one standing. See {@link _EnableNamesTheRow}: after this
       * statement there is exactly one id in scope, and it is the answering row's.
       */
      await database
        .insert(mcpServers)
        .values({
          id: `composio-${input.slug}`,
          title: input.title,
          logo: input.logo ?? null,
          // The broker, whoever publishes the app behind it. `vendor` is what the first-party rule
          // is checked against, and Composio is who this deployment is actually talking to.
          vendor: "Composio",
          url,
          provenance: "composio",
          // Nothing for the vault to hold. A brokered call runs as the person asking, on their own
          // connection at the vendor, which is a `composio_connections` row rather than a secret.
          credentialId: null,
          /*
           * What the config standing at Composio was created AS, which is the scheme every later
           * connection against it has to keep using.
           *
           * THE RESOLVED ONE AND NOT THE CATALOGUE'S, WHICH THIS BRANCH USED TO WRITE UNGUARDED.
           * The write-once rule below protects only the UPDATE, and this INSERT fires exactly when
           * no row stands at the composed id — which is not the same as no row standing for the
           * APP. In the two-rows-at-one-url state this method is built around, a restored or
           * hand-added `gmail` at `composio://gmail` holding `API_KEY` and live key connections is
           * untouched by the guard: the insert at `composio-gmail` fired, wrote `OAUTH2`, and
           * `composio-gmail` sorts first, so `brokeredAppRowsAt` made the new row the answering
           * one. `confirmBrokeredConnection` then classified the app `consent`, saw `verified:
           * false` on a key row, and wrote `verified: true, probeAction: null` over it — erasing a
           * recorded failed check on the next page load. See the derivation of `scheme` above.
           */
          authScheme: scheme,
          addedBy: input.by,
        })
        .onConflictDoUpdate({
          target: mcpServers.id,
          set: {
            title: input.title,
            logo: input.logo ?? null,
            url,
            /*
             * WRITTEN BESIDE THE URL, BECAUSE THE TWO ARE ONE FACT AND A ROW HOLDING HALF OF IT IS
             * NOT A SERVER AT ALL.
             *
             * CRITERION. Every row this method leaves behind says `composio`, whatever it said
             * before. The url above and this column are what `accessFor` reads to answer that a call
             * is brokered and which app it is against, and no path may write one without the other.
             *
             * REASON. This branch rewrote the url and left `provenance` standing, so enabling an app
             * at an id a custom server already held produced a row reading `custom` at a
             * `composio://` address. That is not a display inconsistency: `accessFor` answers
             * `deployment-token` for it, so the transport dialled the row as an ordinary MCP
             * endpoint on the deployment's own credential while the Composio screen went on
             * attaching people's real accounts to the app its url named. The per-person gate was not
             * weakened but SKIPPED — `connectionTokenFor` only ever asks for a connection down the
             * brokered branch — which is the whole property this connector exists for. And
             * `removeServer` finds the accounts to end at the vendor through that same answer, so it
             * revoked nothing and reported the connector gone.
             *
             * A CONVERSION HERE, A REFUSAL IN THE OTHER DIRECTION, and the asymmetry is the point.
             * What this method writes IS the app — the auth config stands at Composio before the row
             * is touched, and the url names the app the connections will be keyed on — so a row it
             * lands on comes out saying exactly what it now is, with nothing lost. Going the other
             * way, the url being overwritten is the only record of which app a set of consents
             * belongs to, and no column written alongside brings it back; see
             * {@link requireNotBrokered}.
             *
             * `vendor` for the same reason one notch quieter: it is what the first-party rule is
             * checked against, and a row reached over the broker whose vendor column still names the
             * host somebody typed is answering that rule about a server this deployment no longer
             * dials.
             */
            provenance: "composio",
            vendor: "Composio",
            addedBy: input.by,
            updatedAt: new Date(),
            /*
             * `credential_id` is neither written here nor cleared here.
             *
             * Every row this method creates has none and no path in this module attaches one, so
             * there is nothing for an enable to set. Clearing it anyway would matter in the single
             * case it could apply — a pointer that arrived by hand edit or restore — because
             * `removeServer` retires a server's secret by reading it off this column, and a null
             * written over it leaves that secret live with nothing left to name it.
             */
            /*
             * `auth_scheme` is not written here either, and for a neighbouring reason.
             *
             * This is the branch a second press of Add takes, and the scheme is the one thing on
             * the row that live connections depend on rather than merely display. Rewriting it
             * here would move them; the statement below rewrites it only where there are none.
             */
          },
        });

      /*
       * WHICH ROW THIS DEPLOYMENT WILL ANSWER FOR THE APP WITH, RESOLVED ONCE AND FOR EVERYTHING
       * BELOW.
       *
       * CRITERION. After the upsert, every act of this method — the scheme it records, the actions
       * it lists, the row it files on the trail and the record it hands its caller back — is about
       * the row {@link brokeredAppRow} names for this app. The composed `composio-<slug>` is what
       * the statement above MINTS and is a stand-in for nothing.
       *
       * REASON. `mcp_servers.url` has no unique index, deliberately — see {@link brokeredAppRow} —
       * so the row this method names and the row every brokered reader resolves are allowed to be
       * different rows, and in the ordinary two-rows-at-one-url state they are. Every act keyed on
       * the composed id was then an act performed somewhere nothing looks. FOUR ROUNDS OF REVIEW
       * EACH MOVED ONE OF THEM AND LEFT THE NEXT STANDING: the probe was resolved by url, then
       * `brokeredAppRow` was introduced and the probe and the confirm routed through it, then the
       * scheme WRITE was moved here — and the actions went on being listed under the composed name
       * the whole time. That last one is the deadlock the single-row rule exists to close: the
       * chooser reads actions by server id, finds none on the answering row, so `checkable` is
       * false on every page load, the browser draws no Re-check button, and the one press that
       * could earn the app a verdict can never be made.
       *
       * THE ROW IS RE-READ RATHER THAN ASSUMED, because the upsert may have created it, found it,
       * or landed beside an older row that sorts first — and which of those happened is exactly what
       * decides the answer. The composed name is respelled as the fallback for the unreachable case
       * of a row this method has just written not being found at its own url, which would mean the
       * insert above and this read disagree about what was stored; it is respelled rather than held
       * in a binding so that nothing below can take it by mistake.
       */
      const answering =
        (await brokeredAppRow(input.slug))?.id ?? `composio-${input.slug}`;

      /**
       * WHICH ROW EACH ACT OF AN ENABLE NAMES, WRITTEN DOWN BECAUSE NOTHING ELSE CAN SAY IT.
       *
       * Type-only and erased; see {@link Decides}. Every other roster in this file is keyed on a
       * vocabulary the compiler already knows — {@link SchemeKind}, {@link BrokeredProbe} — and
       * this one is keyed on the acts of a single method, because the drift being pinned is not a
       * branch that forgot a member but a SITE that reached for the wrong name. There is no type
       * whose inhabitants are "the things an enable does", so the checklist is the union and the
       * roster is what forces an answer out of it: a sixth act added to `BrokeredEnableAct` fails
       * `tsc` here until somebody says which row it is about, and the two legal answers are a closed
       * pair rather than free text so the seam cannot drift in the direction it has drifted four
       * times.
       *
       * `minted` IS THE ANSWER FOR EXACTLY ONE ACT, and that is the whole shape of the rule. The
       * upsert has to be keyed on the composed name — it is what converts a row an administrator
       * typed at that id into the brokered app it now is, which is a property with its own test —
       * and every act after it is about the row the readers read.
       */
      type BrokeredEnableAct =
        | "upsert"
        | "scheme"
        | "actions"
        | "trail"
        | "answer";
      type _EnableNamesTheRow = Decides<
        BrokeredEnableAct,
        {
          upsert: "minted";
          scheme: "answering";
          actions: "answering";
          trail: "answering";
          answer: "answering";
        },
        "minted" | "answering"
      >;

      /*
       * WRITTEN EXACTLY WHERE A CONFIG WAS MADE TO WRITE IT ABOUT, AND NEVER OVER A STANDING ONE.
       *
       * A row's scheme is what its authorization config was created as, and every connection made
       * against that config depends on it. Re-enabling must not rewrite it underneath them: a
       * vendor that starts publishing managed OAuth for an app somebody connected by key would,
       * one press of Add later, leave this deployment minting consent links against a config full
       * of keys.
       *
       * THE GUARD WAS "NOBODY HAS CONNECTED YET" ALONE, AND THAT HALF CANNOT SETTLE IT. It reasoned
       * that with no connections there is nothing to strand, so the rewrite is safe and is how an
       * operator picks up a vendor's change without removing and re-adding the app. The second
       * clause was false, for one reason: {@link ComposioBroker.ensureAuthConfig} REUSES a config of
       * ours whatever scheme it holds and creates nothing, so a press of Add does not pick the
       * vendor's change up — it records a word beside a config that never moved. An app enabled as
       * `API_KEY` and given managed OAuth by the vendor came out of that press recording `OAUTH2`
       * against a key config, which makes `connectBrokeredWithFields` refuse every submission while
       * `authorize` mints consent links that ask for nothing — and pressing Add again can never
       * repair it, because the reuse is the cause.
       *
       * SO BOTH CLAUSES STAND, AND EACH CLOSES WHAT THE OTHER CANNOT. Nothing connected means no
       * connection is moved by the write; a config this call actually CREATED means there is a
       * config that was made as the word being written. `standing` writes nothing whatever the
       * connection count, and remove-and-re-add is then the one act that genuinely changes an app's
       * scheme, because it is the one that deletes the config.
       *
       * AND IT IS WRITTEN ON THE ROW THAT ANSWERS FOR THE APP, WHICH IS NOT ALWAYS THE ONE THE
       * UPSERT NAMED.
       *
       * CRITERION. After this call, the scheme {@link brokeredAppScheme} answers with for the app is
       * the scheme the authorization config standing at Composio was created as.
       *
       * REASON. The statement was keyed on the composed `composio-<slug>` while every reader of this
       * column finds the app by its URL. Where those are two rows the write and the reads were about
       * different rows: an app enabled with a key that every reader calls a consent app. What the
       * person then meets is the connect form refusing them in a sentence about a sign-in screen
       * that does not exist for this app, and a Re-check button that will not press. A writer keyed
       * on a composed id has not recorded the fact; it has recorded it somewhere nothing looks.
       */
      const connections = await database
        .select({ userId: composioConnections.userId })
        .from(composioConnections)
        .where(eq(composioConnections.toolkit, input.slug))
        .limit(1);

      if (configured !== "standing" && connections.length === 0) {
        await database
          .update(mcpServers)
          .set({ authScheme: scheme, updatedAt: new Date() })
          .where(eq(mcpServers.id, answering));
      }

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        /*
         * THE ROW A READER WOULD GO AND LOOK AT, which is the one this deployment answers for the
         * app with and not the one the upsert happened to key on. Where those differ the composed
         * row exists too, so a trail naming it would send somebody to a row whose scheme, whose
         * actions and whose Re-check button are all somewhere else — and `url` below names the app
         * itself, so nothing about which app was enabled is lost by naming the answering row here.
         */
        targetId: answering,
        payload: {
          actor: input.by,
          change: "mcp_server_added",
          server: answering,
          url,
          // Named for the same reason the custom path names its own: "who enabled an app whose
          // actions nobody reviewed" is a question somebody will ask, and the answer should not
          // require knowing how ids were spelled in a past build.
          provenance: "composio",
        },
      });

      /*
       * Refreshed now for the reason the paths above are: the page that enabled the app can show
       * what it offers, and a broker that will not list it says so here rather than at first use.
       *
       * ONTO THE ANSWERING ROW, which is the site this whole block is about. `mcp_tools.server_id`
       * is what {@link probeActionFor} reads actions by and what {@link listServers} joins them on,
       * and every brokered caller hands those the id resolved above — so actions written under the
       * composed name are actions nothing in the brokered path can see.
       */
      await this.refreshTools(answering);
      const added = (await this.listServers()).find(
        (server) => server.id === answering,
      );
      if (!added) throw new CatalogueEntryUnknownError(answering);
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
     * A THIRD KIND OF ACCESS THAT IS NOT A SECRET. A brokered app holds no per-person secret at all
     * — Composio keeps the accounts and the deployment sends a user id — so the only thing standing
     * between a person and their mailbox is a `composio_connections` row, and that table references
     * nothing that would cascade it. Removing the app therefore left every one of them behind, and
     * adding the app back turned them live again without anybody being asked. That row goes too —
     * and before it goes, the account it stands for is ended at Composio, because clearing the row
     * alone shuts a gate and leaves the mailbox attached. The deployment's auth config for the app
     * goes last, once nobody is connected to it any more.
     *
     * The revokes go first. These are writes on two tables and the store exposes no transaction that
     * spans both, so the order decides what a failure between them leaves: revoke-then-delete leaves
     * a server whose secrets no longer work and which removing again will finish off, while
     * delete-then-revoke leaves live secrets no server references and no operation can reach.
     */
    async removeServer(serverId: string, by: string): Promise<void> {
      const [existing] = await database
        .select({
          credentialId: mcpServers.credentialId,
          // Read so the brokered connections below can be keyed on the app the url names, which is
          // the same key the call gate uses. See there for why the row id will not do.
          provenance: mcpServers.provenance,
          url: mcpServers.url,
          // The third of what `accessFor` resolves a row with. See there.
          authScheme: mcpServers.authScheme,
        })
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
            vendorRevocationRequested: false,
          },
        });
      }

      /*
       * The third kind of access, which is not a secret at all: everybody's brokered connection.
       *
       * CRITERION. Removing an app must leave nobody holding brokered access to it, so that adding
       * it back again grants nothing until each person has consented afresh.
       *
       * REASON. `composio_connections` is the whole gate on a brokered call and it references
       * nothing — not `mcp_servers`, not `users` — so nothing cascaded it and removing the app left
       * every row standing. Two ordinary administrative acts, remove and add back, then restored
       * everybody's access at a url the second act chose, with nobody asked again and no screen
       * saying it had happened. Consent that reattaches by itself is not consent.
       *
       * KEYED ON THE APP THE URL NAMES, exactly as `connectionTokenFor` keys the gate. `row.id` is a
       * display key and nothing holds it equal to the slug in the url, so a delete by id would clear
       * some other app's connections, or none, for the very row shape that gate already refuses to
       * trust. `accessFor` is asked rather than the url parsed here, so this cannot drift from it.
       *
       * ASKED WITH NO ENTRY, deliberately, and that is not the entry-wins order being dodged. An
       * entry can only ever SUPPRESS this answer — `accessFor` returns a null toolkit for every row
       * that has one — so passing the entry a colliding id looks up would hide the brokered state of
       * the one row most in need of clearing, and would now refuse outright the very row this method
       * exists to get rid of, leaving the collision unremovable. Nothing is dialled here, so there is
       * no vendor for an entry to protect; the only question is which app's consent rows this row's
       * own url stands for.
       *
       * Before the server row goes, for the reason the revokes above are: what a failure between
       * two writes leaves has to be the recoverable half. A connection cleared with the app still
       * present is fixed by removing it again; an app deleted with the connections standing is
       * reachable by no operation at all, because the toolkit was only ever readable off its url.
       *
       * AND THE ACCOUNT IS ENDED AT THE VENDOR, not merely forgotten here. Deleting the row closes
       * the gate this deployment owns and does nothing whatever to the account: the person's
       * mailbox stays attached at Composio, the grant stays live, and an administrator who pressed
       * "remove" was told the connector was gone. So every connected person is revoked through the
       * broker first, exactly as {@link disconnectBrokered} revokes for one — the same
       * shape at the scale of an app.
       *
       * REVOKE BEFORE DELETE, ALWAYS, and the argument is the one that method makes. The row is the
       * only thing here that names which app this person connected, so a delete that ran first
       * would leave a failed revoke with nothing to revoke under: a live grant on somebody's
       * mailbox that no operation in this deployment can reach. The other order costs a repeat of
       * an administrative act nobody minds repeating. Dead and reachable beats live and
       * unreachable.
       *
       * WHICH MAKES THE FAILURE LOUD. Nothing is caught around the revokes: a broker that will not
       * answer ends this method with the rows still standing and the app still present, rather than
       * letting it report an ending that did not happen.
       *
       * THE AUTH CONFIG GOES LAST, after every account is dead and every row is gone, for the same
       * reasoning one step out. An orphaned auth config grants nobody anything — it is a shape this
       * deployment holds at Composio, not an account — while a live account whose config has
       * already been deleted is access that nothing left here can end.
       */
      const toolkit = existing ? accessFor(existing, null).toolkit : null;

      if (toolkit) {
        /*
         * Read before anything is deleted, because the revokes below need the people and the rows
         * are where the people are. Sorted, so two removals of the same app revoke in the same
         * order and write their trail rows in the same order.
         */
        const connected = await database
          .select({ userId: composioConnections.userId })
          .from(composioConnections)
          .where(eq(composioConnections.toolkit, toolkit))
          .orderBy(asc(composioConnections.userId));

        /*
         * What the broker was actually asked for each of them, kept so the trail below records the
         * answer rather than the call. False where there is no broker at all: a deployment whose
         * key has since been unset can still remove the app, and it could not have been calling it
         * either way — but nothing was asked of Composio and the row must not claim otherwise.
         */
        const vendorRevocationRequested = new Map<string, boolean>();
        for (const connection of connected) {
          vendorRevocationRequested.set(
            connection.userId,
            broker
              ? await broker.revoke({ userId: connection.userId, toolkit })
              : false,
          );
        }

        await database
          .delete(composioConnections)
          .where(eq(composioConnections.toolkit, toolkit));

        for (const connection of connected) {
          await recordAuditEvent(auditStore, {
            eventType: "mcp.account_disconnected",
            targetType: "mcp_server",
            /*
             * THE APP, not this row's id, and the same key `retireConnectionsFor` files under.
             *
             * CRITERION. Every `mcp.account_disconnected` row a brokered connection produces is
             * keyed on the app at the broker, whichever act produced it, so one query answers
             * what happened to one person's brokered access.
             *
             * REASON. The two acts that can end such a connection were keyed differently: this
             * one on `mcp_servers.id`, offboarding on `composio_connections.toolkit` — which is
             * all that row records and all that is left once the server row is gone. Nothing
             * holds the two strings equal, so on any renamed row half the trail is filed under a
             * name the other half never mentions, and the disagreement is invisible everywhere
             * they happen to match.
             *
             * THE APP IS WHAT WAS CONSENTED TO. The gate is `(toolkit, user_id)`, the delete
             * above is by toolkit, and the row outlives the server row entirely; the id is a
             * display key that may not exist by the time somebody asks. Which server row was
             * removed is not lost — the `configuration.changed` row written below names it.
             */
            targetId: toolkit,
            payload: {
              actor: by,
              server: toolkit,
              owner: connection.userId,
              // The same three-way distinction the vault loop above draws, and the same answer: an
              // administrator took the whole app away and the person did nothing.
              reason: "mcp_server_removed",
              /*
               * What was asked of the vendor, not that a call was made — {@link
               * ComposioBroker.revoke}'s own answer, passed through. True where an account was
               * found and its withdrawal asked for, false where there was none to withdraw or
               * where this deployment has no broker to have asked. The value of the field is
               * exactly that a reader can tell an account this deployment acted on from one that
               * outlives it somewhere else, so a constant here would be worse than none. It says
               * "requested" because that is the strongest thing the vendor's answer supports:
               * the upstream withdrawal runs as a background job nothing here can poll.
               */
              vendorRevocationRequested:
                vendorRevocationRequested.get(connection.userId) ?? false,
            },
          });
        }

        // Last of all, for the reason above, and skipped entirely on a deployment with no
        // broker to have made one.
        if (broker) await broker.deleteAuthConfig(toolkit);
      }

      const released = await database.transaction(async (transaction) => {
        const removed = await transaction
          .delete(pluginGrants)
          .where(
            and(
              eq(pluginGrants.kind, "mcp"),
              eq(sql`split_part(${pluginGrants.ref}, '/', 1)`, serverId),
            ),
          )
          .returning({ ref: pluginGrants.ref, agentId: pluginGrants.agentId });
        await transaction.delete(mcpServers).where(eq(mcpServers.id, serverId));
        return removed.sort((left, right) => left.ref.localeCompare(right.ref));
      });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: serverId,
        payload: {
          actor: by,
          change: "mcp_server_removed",
          server: serverId,
          ...(released.length > 0
            ? {
                releasedGrants: released.map((grant) => grant.ref),
                bots: [...new Set(released.map((grant) => grant.agentId))],
              }
            : {}),
        },
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
      const { row, entry, access } = await requireServer(serverId);

      /*
       * Who the trail says asked for this listing, which is not the same value as who to list AS.
       *
       * CRITERION. The two audit rows below must never name an actor of `""`.
       *
       * REASON. `actorId` does double duty: it selects the person's credential where listing needs
       * one, and it is copied into those rows. The add paths pass neither, deliberately — nobody can
       * have connected an app in the second it is added, and the comment above this method says why
       * requiring one there was wrong. So the absence is permanent and correct for the credential,
       * and meaningless for the trail, which was left writing `actor: ""` on every row an add
       * produced. The deployment refreshing on its own behalf is a real answer and `reachedAs`
       * already spells it that way; see {@link DEPLOYMENT_ACTOR}. Held separately rather than
       * defaulting the parameter, because defaulting it would hand `connectionTokenFor` a person
       * called "deployment" to look a grant up by.
       */
      const auditActor = actorId || DEPLOYMENT_ACTOR;

      // How a row is reached is resolved once, in `requireServer`. Derived from the entry here,
      // a Composio app — which has no entry — was dialled as MCP at `composio://gmail`.
      const transport = transportFor(access.transport);

      /*
       * A brokered row with no app in its url has nobody to ask, and saying so is not the transport's
       * job.
       *
       * CRITERION. A listing this deployment could not even attempt must not be committed as a
       * refresh, and must not be written down as a vendor's answer.
       *
       * REASON. `accessFor` answers `brokered` for every row whose provenance column says so, and
       * reads the app slug off the url — so `{ credential: "brokered", toolkit: null }` is a real
       * state, which a hand edit or a restored backup produces and nothing in the product does.
       * `connectionTokenFor` already refuses it, but only where listing needs a credential, and a
       * brokered listing needs none: the broker publishes an action's schema to anybody. So the gate
       * was skipped on exactly the path that reaches the vendor with no app named, and the transport
       * answered `[]` — indistinguishable, one line later, from an app that advertises nothing.
       *
       * READ AS FIELDS, not as a transport. `credential` and `toolkit` are both resolved in
       * `access.ts` and this asks nothing about which protocol is underneath: any broker reached
       * without an app named is unroutable, which is the property `toolkit` is documented to carry.
       * A `transport === "composio"` test here would put back the per-call-site derivation that
       * module exists to have removed.
       */
      if (access.credential === "brokered" && !access.toolkit) {
        throw new PluginInvariantError(
          `${row.id} resolves to a brokered credential with no app in its url, so there is nothing to ask what it offers.`,
        );
      }

      /*
       * ASKING THE VENDOR, and the only part of this method whose failure is a vendor's.
       *
       * CRITERION. What lands in `lastError` must be something a vendor, a credential or a person
       * could have caused. An invariant this deployment violated and a fault in its own database must
       * not read as a vendor misbehaving.
       *
       * REASON. This used to be one `try` around everything below as well — the wholesale replace,
       * the server-row update and both audit writes — with a `catch` that copied any message into
       * `lastError` and answered `{ tools: 0 }`. So a statement timeout, a duplicate-key refusal or an
       * `audit_events` insert that would not go in all reported a vendor that had in fact answered
       * correctly, and reported it beside actions the refresh had already committed. Narrowing that
       * by error class would be narrowing by prose; narrowing it by SHAPE is what this split does, so
       * a line added below cannot quietly acquire a vendor's excuse.
       */
      let listed: ListedTool[];
      try {
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
          ? (await connectionTokenFor(row, entry, actorId, access)).token
          : undefined;

        listed = await transport.listTools({
          url: effectiveUrl(row, entry),
          token,
        });
      } catch (error) {
        /*
         * Ours rather than a vendor's, asked as one question about the whole shelf.
         *
         * CRITERION. Nothing on the `isDeploymentFault` shelf is written into `lastError`, and
         * nothing raised from here carries a statement or a bound value.
         *
         * WHAT THIS USED TO BE, and why the difference is not cosmetic. It read `error instanceof
         * PluginInvariantError` — which was DEAD, and its own comment named two throws that cannot
         * arrive here: `connectionTokenFor` is only called when `transport.listNeedsCredential`,
         * which is false for `composio`, the only brokered transport, so the brokered narrowing
         * cannot fire inside this `try`; and the `person-oauth` narrowing is unreachable because
         * `accessFor` answers that credential only for a `user-oauth` entry. So the line could be
         * deleted with every test still green while the arrival it should have been catching —
         * a query of ours failing — went straight past it into the column below.
         *
         * A QUERY FAILURE IS THE REACHABLE ONE. `connectionTokenFor`'s vault read, its connection
         * lookup and its locked credential swap all run inside this `try` for an MCP listing, and
         * each throws a `DrizzleQueryError` whose message is the statement plus every value bound
         * to it. Recorded, that put a SQL dump in the column the Plugins page draws, under a
         * heading that says a vendor said it. Raised as an invariant of ours, with the driver's
         * complaint and none of the query.
         */
        if (isDeploymentFault(error)) {
          throw isQueryFailure(error)
            ? new PluginInvariantError(
                `${row.id}: asking this app what it offers failed on a query of this deployment's own, so nothing about the app was learned and nothing it holds was changed. ${databaseComplaint(error)}`,
              )
            : error;
        }

        /*
         * ASKED THROUGH THE ONE DOOR, like the `storableTools` catch forty lines below that writes
         * the same column.
         *
         * `McpServerError` in the old test was doing nothing — it extends `Error`, so the second arm
         * answered for it — and what the whole expression amounted to was
         * `error instanceof Error ? error.message : String(error)`, which is precisely the reflex
         * {@link reasonWithoutStatement} exists to replace: it reads `.message` directly and so walks
         * straight past {@link withoutStatement}.
         *
         * NOTHING REACHABLE CHANGES BEHAVIOUR HERE TODAY, and that is the reason to write it rather
         * than an argument against. The guard above answers every query failure before this line, so
         * the shape whose message must never travel cannot arrive by any path anybody can name. What
         * CAN arrive is a wrapper — `composio.listTools` rethrows `new Error(listingSentence(...))`,
         * and `listingSentence` falls through to the thrown message verbatim — and a wrapper carries
         * no `query` and no `params` of its own, so it is on nobody's shelf and answers to nobody's
         * check. "No thrower reachable today" was also true of the credential envelope before the
         * rotation path started writing one; the door costs nothing and does not need to be
         * rediscovered at the next site.
         */
        const message = reasonWithoutStatement(error);
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

      /*
       * An empty listing never destroys what a real listing recorded.
       *
       * CRITERION ONE. An empty answer must not be committed as a healthy refresh where doing so
       * would delete actions this deployment holds, and must not clear `lastError`.
       *
       * CRITERION TWO. "This app advertises nothing" stays recordable: an app with nothing held has
       * nothing to lose, so the empty answer falls through to the replace below and commits — a
       * refresh stamp, no error, no actions.
       *
       * REASON. The replace below is a delete and an insert, so an empty answer committed here
       * deletes every `mcp_tools` row for the server, taking the recorded `effect`, `destructive`
       * and `version` with it. `version` is the one that cannot be reconstructed: `callTool` refuses
       * an action without it, so a refresh that reported success broke every subsequent call, and
       * the grants survived pointing at rows that no longer existed — absent from `listServers`, and
       * revived only by a later refresh that worked.
       *
       * WHAT USED TO REACH THIS LINE, and no longer does. `composio.listTools` once answered `[]`
       * for a url naming no app and for a deployment with no Composio client installed, neither of
       * which is a vendor's answer, and the second of those is the state of every real deployment.
       * Both throw now, so that particular arrival is closed at the seam rather than here. The guard
       * stays because its argument never depended on who sent the empty answer.
       *
       * KEPT RATHER THAN TRUSTED, and that asymmetry is the whole argument. Holding actions the vendor
       * has withdrawn is visible and reversible: the next listing replaces them. Deleting actions the
       * vendor never withdrew is neither — `mcp_tools` is shared, so it is every replica at once, and
       * only a refresh from a deployment that can actually reach the vendor puts it back. That holds
       * for any vendor that suddenly lists nothing, whatever made it do so, which is why removing
       * this would reopen the same data loss for a different reason.
       *
       * THE SEAM REQUIREMENT this leans on, and it is satisfied: a transport that could not ask
       * anybody must THROW rather than return `[]`. `composio.listTools` opens with two throws that
       * say which of the two it is — no app in the url, no client installed — and no transport has
       * an early `return []` left in it at all: `builtin-routines` answers a static list, and `mcp`
       * and `google-drive-rest` hand back only what a request returned. So an empty listing reaching
       * this line is a vendor's own answer, which is what the sentence below says. Nothing here asks
       * which transport it is talking to, and nothing has to: the requirement is met at each seam
       * rather than branched on here.
       */
      if (listed.length === 0) {
        const held = await database
          .select({ name: mcpTools.name })
          .from(mcpTools)
          .where(eq(mcpTools.serverId, serverId));

        if (held.length > 0) {
          await database
            .update(mcpServers)
            .set({
              // Named as the state it is, because "listed nothing" and "would not answer" send an
              // operator to different places, and reaching this line settles which one it was: a
              // listing that could not be made throws and lands in the `catch` above instead. So
              // this sentence must not send anybody to check their configuration — that is the
              // other state's sentence, written by the transport that refused. No
              // `toolsRefreshedAt`: that column says when this deployment last learned what the app
              // offers, and it did not learn it here.
              lastError: `This app was asked and answered with no actions at all, so the ${held.length} already recorded for it were kept rather than deleted. Check whether it still publishes them, then refresh again.`,
              updatedAt: new Date(),
            })
            .where(eq(mcpServers.id, serverId));
          // What the app advertises, which is what it advertised before: the honest count, because
          // nothing was replaced.
          return { tools: held.length };
        }
      }

      /*
       * TURNING THE VENDOR'S ANSWER INTO ROWS, which is still the vendor's answer and so is still
       * caught.
       *
       * CRITERION. Nothing a vendor can put in a listing leaves this method as an uncaught throw,
       * and nothing a vendor can put in a listing half-applies the add that called it.
       *
       * REASON. Names are deduplicated and vendor text is made storable before a transaction is
       * opened on any of it, because both of those failures used to abort the replace from inside
       * one — see {@link storableTools}. Moving the work earlier moved the THROW earlier with it,
       * to a line between the two `try` blocks and covered by neither. A schema that this could not
       * make storable then left `refreshTools` raw: the refresh route has no mapping for it, so the
       * admin page got a bodiless 500 and `lastError` kept whatever it held before; and `addServer`
       * refreshes before it answers, so the add died AFTER its server row and its audit row had
       * committed, leaving a configured app nobody had finished configuring.
       *
       * RECORDED RATHER THAN RAISED, which is the same answer the vendor `try` gives, because this
       * is the same kind of event: the app was reached, it answered, and its answer is not something
       * this deployment can write down. The actions it already holds are kept, no `toolsRefreshedAt`
       * is stamped — nothing was learned — and the add completes with the failure on the row for an
       * administrator to read.
       *
       * `withoutStatement` rather than `error.message`, so that the one shape whose message must
       * never travel cannot reach the column even from a line that should never produce one.
       */
      let storable: ReturnType<typeof storableTools>;
      try {
        storable = storableTools(serverId, listed);
      } catch (error) {
        const reason =
          error instanceof Error ? withoutStatement(error) : String(error);
        await database
          .update(mcpServers)
          .set({
            // Capped where every other quoted failure in this file is capped, and for the same
            // reason: part of this sentence comes from elsewhere and none of it is a promise about
            // length.
            lastError:
              `This app answered with an action whose schema could not be stored as it arrived, so the actions already recorded for it were kept rather than replaced. ${reason}`.slice(
                0,
                400,
              ),
            updatedAt: new Date(),
          })
          .where(eq(mcpServers.id, serverId));
        return { tools: 0 };
      }

      /*
       * COMMITTING WHAT THE VENDOR SAID. Nothing from here down is a vendor's doing, so nothing
       * from here down is recorded as one — see the criterion on the vendor `try` further up, and
       * the one on the `try` immediately above this, which is the last thing here that still is.
       *
       * ONE STEP, because the paragraph above promises the held actions are left alone.
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
       * Rolled back together, the Bots go on using what they were granted — and the fault raises
       * rather than being copied into `lastError`, because a transaction this database would not take
       * is not something the vendor did.
       */
      try {
        await database.transaction(async (transaction) => {
          await transaction
            .delete(mcpTools)
            .where(eq(mcpTools.serverId, serverId));
          if (storable.length > 0) {
            await transaction.insert(mcpTools).values(storable);
          }
        });
      } catch (error) {
        /*
         * A database failure, with the statement and its parameters left behind.
         *
         * CRITERION. Nothing raised from here carries the SQL or the values bound to it.
         *
         * REASON. drizzle wraps every failure as a `DrizzleQueryError`, whose message is
         * `Failed query:` followed by the whole statement and then every parameter — here, the
         * vendor's entire tool list. That message is what an unhandled throw puts in the logs and
         * what any caller that prints an error puts on a screen. A SQL dump on an error path is
         * the same disclosure shape as a credential leak one layer out, and it is gratuitous: the
         * driver's own complaint says what went wrong without any of it.
         *
         * RAISED, NOT RECORDED, which is what the paragraph above this transaction argues for and
         * is now true rather than merely intended: with duplicate names and unstorable text
         * removed before the statement is built, what is left is this database refusing something
         * this deployment's own schema says it will take, and `lastError` is where a VENDOR's
         * answer goes.
         */
        throw new PluginInvariantError(
          `${row.id}: the actions this app listed were not stored, so what it already had is unchanged. ${databaseComplaint(error)}`,
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
       * what it names is what is actually left over — and only ever after a listing that was
       * committed, because the guard above returns before this on an empty answer that would have
       * named every grant the app holds.
       */
      // The names as STORED, so a grant is compared against a row that exists: a duplicate the
      // vendor listed twice is one row, and a name is spelled here the way the insert spelled it.
      const advertised = new Set(storable.map((tool) => tool.name));
      const stranded = [...(await mcpGrantsForServers([serverId])).entries()]
        .filter(([ref]) => !advertised.has(ref.slice(serverId.length + 1)))
        .sort(([left], [right]) => left.localeCompare(right));

      if (stranded.length > 0) {
        await recordAuditEvent(auditStore, {
          eventType: "configuration.changed",
          targetType: "mcp_server",
          targetId: serverId,
          payload: {
            actor: auditActor,
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
            actor: auditActor,
            change: "unlisted_tools_advertised",
            server: serverId,
            tools: unlisted,
            note: "Advertised by this server and not named in its reviewed write list, so each is offered to models as a read. This vendor has no read-only scope behind that list, so anything here that writes should be added to the entry.",
          },
        });
      }

      // What was recorded, which is what "this app offers N actions" means on the page. Counting
      // the listing instead reported a duplicate the vendor named twice as two actions the
      // deployment holds, when `mcp_tools` holds one row for it.
      return { tools: storable.length };
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

      /*
       * HOW EACH APP CONNECTS, WHICH IS A FACT ABOUT THE APP AND NOT ABOUT THE ROW BESIDE IT.
       *
       * CRITERION. Every row here whose url names a Composio app reports the scheme
       * {@link brokeredAppScheme} answers for that app — so two rows at one url report one answer,
       * and it is the answer {@link connectBrokeredWithFields} will act on.
       *
       * REASON. The browser forks on this field: `brokered-account-row.tsx` draws a consent button,
       * a form or a "nothing to connect" sentence out of it, and the press then lands in a store
       * method that resolves the app by its URL. Reported off each row's own column those were two
       * readings of one fact — a form drawn from this row and a submission refused by the other
       * row's scheme, telling somebody to connect the app the way it asks for over an app they were
       * asked exactly that way. {@link serverAddress} answers the same field the same way, so the
       * page that lists an app and the route that connects it cannot come apart either.
       *
       * ONE EXTRA READ FOR THE WHOLE LIST, and none where the deployment has enabled no apps.
       */
      const brokeredApps = await brokeredAppRowsAt(
        rows.filter((row) => toolkitOf(row.url) !== null).map((row) => row.url),
      );

      return rows.map((row) => {
        const entry = catalogueEntry(row.id);
        return {
          id: row.id,
          title: row.title,
          logo: row.logo,
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
          // The app's, for a row whose url names one; this row's own column for everything else,
          // which is a null on every server that is not brokered. See the read above.
          authScheme: toolkitOf(row.url)
            ? (brokeredApps.get(row.url)?.authScheme ?? null)
            : row.authScheme,
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
                effect: classifyTool(entry, tool.name, true, tool.effect),
                destructive: tool.destructive,
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
     * Where one server is, by id, and nothing that hangs off it.
     *
     * WHY IT EXISTS BESIDE {@link listServers}. Three routes asked that one for a single row's url
     * — the brokered branch of connect, and the confirm and disconnect pair behind
     * `brokeredAppFor` — and it answers by running three queries and materialising every server,
     * every tool and every grant in the deployment. Confirm is the sharp end: both brokered account
     * screens call it from an effect on mount, so opening a large app's page read the whole tool and
     * grant table to ask whether one row is brokered. None of the three looks at a tool or a grant.
     *
     * THE URL IS THE ROW'S OWN, read out of the column rather than composed from the id. The whole
     * brokered feature rests on the two being allowed to differ: `addBrokeredApp` writes
     * `composio://<slug>` and names the row for it, but nothing holds them equal afterwards, and a
     * row called `gmail` at `composio://slack` is exactly the shape the connection gate was once
     * keyed on the wrong half of. The catalogue reconciliation {@link effectiveUrl} applies for
     * `listServers` is deliberately not applied here, and changes no answer: it only ever
     * substitutes the pinned host of a first-party entry, and neither reading of such a row names a
     * Composio app.
     *
     * `undefined` for an id naming no row, which is what the `.find` over the whole list answered
     * before — so a route that refused an unknown id still refuses it, in the same words.
     *
     * AND THE SCHEME IS THE APP'S, NOT THIS ROW'S, WHICH IS THE ONE FIELD HERE THAT IS NOT ABOUT A
     * ROW AT ALL.
     *
     * CRITERION. For a row whose url names a Composio app, `authScheme` is what
     * {@link brokeredAppScheme} answers for that app.
     *
     * REASON. The connect route forks on this field — a form for a key app, a consent link for a
     * consent one, a refusal for a no-auth one — and the store method that fork leads to,
     * {@link connectBrokeredWithFields}, reads the scheme off the row that answers for the APP. Two
     * rows may name one app, so those were two different reads of one fact: the page draws a form
     * off this row and the submission is refused by the other row's scheme, in a sentence telling
     * somebody to connect an app the way it asks for — over an app they were just asked exactly
     * that way. The id and the title stay this row's own, because those name the row the page
     * opened; the scheme is a fact about the app, and the app has one answer.
     *
     * ONE EXTRA READ, AND ONLY FOR A BROKERED URL. A row that names no app takes the read it always
     * took.
     */
    async serverAddress(serverId: string): Promise<ServerAddress | undefined> {
      const [row] = await database
        .select({
          id: mcpServers.id,
          title: mcpServers.title,
          url: mcpServers.url,
          authScheme: mcpServers.authScheme,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
        .limit(1);
      if (!row) return undefined;
      const toolkit = toolkitOf(row.url);
      if (!toolkit) return row;
      return { ...row, authScheme: await brokeredAppScheme(toolkit) };
    },

    /**
     * Where every added server is, for the one caller whose question is about the whole set.
     *
     * A SECOND READ RATHER THAN {@link serverAddress} IN A LOOP, and rather than one method serving
     * both. The app directory asks which of Composio's apps are already enabled here, which has no
     * id to look up — answered a row at a time it would be one query per app in the directory. And
     * it needs strictly less than the row read hands back: the app comes off the url, so an id and
     * a title would be nothing but two fields a reader could take the app out of by mistake. The
     * directory route's own comment says why that matters — the url is where the transport reads
     * which app a call is against, and the id is a row name that happens to look similar.
     *
     * Ordered, so two readings of an unchanged deployment answer alike.
     */
    async serverUrls(): Promise<string[]> {
      const rows = await database
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .orderBy(asc(mcpServers.id));
      return rows.map((row) => row.url);
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

    /**
     * Whether this deployment has an app by this id.
     *
     * The narrowest question a caller can ask about a server, and deliberately not `listServers`,
     * which materialises every tool and every grant in the deployment to answer. One row, one
     * column, one limit — this runs on the grant path, which is a person waiting on a switch.
     *
     * Existence only. Whether the app currently ADVERTISES a given tool is a different question and
     * is not asked here: a grant naming a tool a server has stopped offering is a supported state
     * ({@link GrantOnWithdrawnTool}), held and not offered, because what a vendor advertises today
     * is not what somebody decided yesterday. A grant naming no app at all is not that state.
     */
    async serverExists(serverId: string): Promise<boolean> {
      if (!serverId) return false;
      const [row] = await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
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
      await database.transaction(async (transaction) => {
        await transaction
          .delete(pluginGrants)
          .where(
            and(eq(pluginGrants.kind, "skill"), eq(pluginGrants.ref, slug)),
          );
        await transaction.delete(skills).where(eq(skills.slug, slug));
      });
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
     * Which brokered apps this person has connected, for the same settings page.
     *
     * A SECOND METHOD RATHER THAN A WIDER {@link connectionsFor}, because the two answer out of
     * different tables for a reason the schema is built on: a `user-oauth` connection is a pointer
     * into the vault, and a brokered one holds no secret at all because Composio keeps the account
     * (see {@link brokeredConnection}). Reading only the vault side is what left a brokered
     * connection invisible to the browser, so the settings screen could not honestly say whether
     * somebody was connected.
     *
     * THE SERVER ID IS JOINED, NOT SPELLED. `addBrokeredApp` writes the app into the url, and every
     * later call resolves against that url — so matching on it asks the row what it is, where
     * composing `composio-${toolkit}` by hand would re-derive the id from a convention nothing
     * holds it to. It is the reasoning the directory route already uses when it reads a row's
     * toolkit off its url rather than off its id. An app this deployment has since removed
     * therefore drops out of the answer, which is the honest result: there is no server row left
     * for a page to name.
     *
     * `scope` IS EMPTY for the reason {@link confirmBrokeredConnection} sets out: Composio grants
     * none that it tells us about, and the field exists to record what the vendor said it granted
     * rather than what we suppose. It is returned all the same, so the fields this shares with
     * {@link connectionsFor} — `serverId`, `scope`, `connectedAt` — line up and one screen can draw
     * both kinds of row. What comes back here is a SUPERSET of that shape rather than the same one:
     * `verified` and `verifiedAt` ride along too, and only on a brokered row, because only a
     * brokered row is a thing this deployment can re-check.
     *
     * `verified` AND `verifiedAt` COME ALONG BECAUSE "connected" IS NOT A PRESENT TENSE HERE.
     * Composio never re-checks a key somebody typed in: it answers ACTIVE for as long as the row
     * exists, whatever the vendor on the other side now thinks of that credential. So a page drawn
     * off `connectedAt` alone would assert something this deployment has not known since the day it
     * was written. These two fields are what lets it say when the claim was last earned instead —
     * "connected with a key you provided, last checked 13 Sep". What the pair separates is a
     * CHECKED key connection from an unchecked one, and nothing more: which KIND of connection a
     * row is comes from the app's recorded {@link ServerRecord.authScheme}, which the page branches
     * on first, and not from anything answered here.
     *
     * `probe` IS THE ACTION THE LAST CHECK SPENT, READ OUT OF THE ROW. The pair above says whether a
     * key connection was ever checked; it cannot say WHY one was not, and three different
     * situations share the one word `false`. Until this field, only the answer to a connect or a
     * re-check could tell them apart — so a page reload lost the distinction, and the worst of the
     * three degraded into the mildest: a row saying the key was accepted without being checked, over
     * an account whose key the vendor had actually REFUSED.
     *
     * IT IS STORED BECAUSE IT IS A FACT ABOUT A MOMENT, NOT ABOUT TODAY'S METADATA. This field was
     * once derived here, by asking {@link probeActionFor} which action this deployment WOULD check
     * the app with; the argument for that was that the chooser holds every condition the probe
     * itself runs on, so the two could not disagree. They cannot disagree AT AN INSTANT, and that is
     * all it establishes. `verified` records a check made against the app's action listing as it
     * stood THEN, and the chooser answers from the listing as it stands NOW — and `POST
     * /servers/:id/refresh` is a generic administrator's route keyed on a server id, of which
     * `composio-<slug>` is one, so an ordinary press of Refresh moves the second without touching
     * the first. It is the very press the Composio transport tells an operator to make when an
     * action appears or gains the version that makes it callable. So: somebody connects a key to an
     * app that publishes nothing safe to try it on, and the row honestly says the key was accepted
     * unchecked. An administrator presses Refresh. From that page load on, the derivation named an
     * action, and the row drew the sentence written for a REFUSED key — your key was checked against
     * this app and rejected, the account it was checked in still stands, so disconnect it. Every
     * clause of that is false for somebody whose key was never tried, it tells them to take down a
     * connection that works, and it persists: it is what every page load says until they press
     * Re-check.
     *
     * SO THE WRITER RECORDS WHAT IT SPENT AND THIS READS IT BACK. {@link recordBrokeredConnection}
     * is the single writer, every path into it knows the action it spent or that it spent none, and
     * {@link composioConnections.probeAction} is where that goes. Read together with `verified`, the
     * column tells four states apart, and no inference is made in any of them:
     *
     *   no probe, not verified   — nothing was tried: at the time of the check the app published
     *                              nothing safe to spend a key on. A fact about the app, not the
     *                              key. A key row written before the column existed reads this way
     *                              too, for the reason that column gives.
     *   no probe, verified       — a CONSENT connection. The vendor's own yes at its own screen is
     *                              the evidence, no call was ever made against the account, and so
     *                              there is no action to name.
     *   a probe, verified        — it ran in this person's account and the vendor took the key.
     *   a probe, NOT verified    — it ran and the vendor refused the key, and the account it ran in
     *                              is still standing. A live account with a bad key behind it.
     *
     * AND THE LAST LINE IS A RECORD RATHER THAN AN INFERENCE, which is the whole of what changed.
     * The caveat that stood here used to argue the state into existence: a key connection is ALWAYS
     * probed at connect time, a probe that fails withdraws the account it just made, so an
     * unverified row under an app that HAS a probe must be a refusal whose withdrawal failed — or
     * else a re-check the vendor refused, which leaves the person's own older account alone. That
     * reasoning was sound about the rows it described and said nothing about the row a refresh had
     * quietly moved underneath it. What the row now warrants, it warrants by having been written:
     * the check ran, it spent this action, and the vendor refused.
     *
     * WHICH PATH WROTE IT IS STILL NOT RECOVERABLE, and a reader must not invent one. The column
     * records what was spent, not who spent it, and the two writers of that pair end differently: a
     * connect withdraws the account it had just made and only leaves the row where Composio refused
     * to take it back, while a re-check never withdraws anything, because the account predates the
     * press and is the person's own. So a page may say the key was refused and the account stands;
     * a page that goes on to blame a failed withdrawal is right on the connect path and FALSE on the
     * re-check, where nothing ever tried to remove anything.
     *
     * `checkable` IS THE OTHER QUESTION, AND IT TRAVELS SEPARATELY BECAUSE COLLAPSING THE TWO IS
     * WHAT DEADLOCKED THE SETTINGS SCREEN. "What did the check SPEND" is a fact about the past, and
     * `probe` answers it. "Does this app have anything to check with TODAY" is a fact about the
     * present, and this answers that — out of {@link probeActionFor}, asked of the APP rather than
     * of the connection. The two agreed for as long as `probe` was derived: one field, one moment,
     * two questions nobody ever had to tell apart. They part company the instant it became a
     * record, which is the same instant it started being right about the past.
     *
     * THE DEADLOCK IN FULL, BECAUSE IT DOES NOT SELF-HEAL. The page gates its Re-check button on
     * whether there is anything to check with, and it read `probe` for that. Somebody connects a
     * key to an app that publishes nothing safe to spend it on: the check spends nothing, the row
     * records null, and both of those are correct and permanent. An administrator presses Refresh,
     * the app gains a safe versioned read, and the button is STILL withheld — because the record
     * still says, truthfully, that nothing was spent. And pressing that button is the only thing in
     * this product that can ever put an action into the record. The state is stable, wrong, and
     * unreachable from inside itself: the single act that would end it is the act being withheld.
     *
     * SO A CALLER TAKES THE PAST FROM ONE AND THE PRESENT FROM THE OTHER, and must take neither out
     * of the other one. A screen drawing its SENTENCE off `checkable` would accuse a key nobody
     * tried, which is the defect the recorded column was made for; a screen gating its BUTTON on
     * `probe` is the deadlock above. Neither field is a weaker spelling of the other, and the
     * moment one is asked to answer both questions the two failures simply trade places.
     *
     * WHICH COSTS ONE QUERY PER CONNECTED APP, AND THAT IS THE RIGHT PRICE. Making `probe` a stored
     * column took the per-row call out and left a listing that was one query; this puts it back —
     * on top of the two the rows themselves now take, which the body below says why.
     * The alternative is to fold the chooser's rule into the join — vendor-labelled read, not
     * destructive, no required inputs, a recorded version — and that rule has no honest spelling in
     * SQL: `required` is the vendor's own JSON Schema stored unchanged, and deciding whether it is
     * a non-empty list of names is a thing JavaScript does and a `json` operator does badly. So
     * folding it in means writing the rule a SECOND time, in a second language, over the same rows,
     * and this file already records what a rule in two places costs: while the version condition
     * sat in one of them, an app whose chosen action had no version connected honestly as "nothing
     * was tried" and reloaded as "your key was checked and rejected". {@link probeActionFor} is the
     * one authority on what can be checked, and a listing that asks it N times cannot disagree with
     * the probe that asks it once. N is the apps ONE person has connected — a handful of indexed
     * reads by server id, made in parallel — behind a settings page and not on any hot path.
     *
     * `verifiedAt` STAYS NULL WHERE IT IS NULL, unlike `connectedAt`, which collapses to `""`
     * because a row cannot exist without one and the fallback is unreachable. Null here is
     * reachable and it means something: never checked. Folding it into `""` would hand the page a
     * row that was checked at a time nobody recorded, which is a different fact and not one this
     * table ever holds. Note also what {@link composioConnections.verified} sets out about the rows
     * migration 0038 backfilled: their `verifiedAt` is the moment of consent, not the moment of a
     * probe, so a caller must not read every timestamp here as "this connection answered then".
     */
    async brokeredConnectionsFor(userId: string): Promise<
      {
        serverId: string;
        scope: string;
        connectedAt: string;
        verified: boolean;
        verifiedAt: string | null;
        probe: string | null;
        checkable: boolean;
      }[]
    > {
      const connections = await database
        .select({
          toolkit: composioConnections.toolkit,
          connectedAt: composioConnections.connectedAt,
          verified: composioConnections.verified,
          verifiedAt: composioConnections.verifiedAt,
          probeAction: composioConnections.probeAction,
        })
        .from(composioConnections)
        .where(eq(composioConnections.userId, userId));

      /*
       * THE APP IS RESOLVED PER CONNECTION, NOT JOINED TO IT, BECAUSE THE URL IS NOT A KEY.
       *
       * CRITERION. One connection is one row out of here, whatever `mcp_servers` holds.
       *
       * REASON. This read used to be an inner join on `mcp_servers.url = 'composio://' || toolkit`,
       * and nothing in the schema makes that column unique — the one `uniqueIndex` in
       * `db/schema/plugins.ts` is `skills_slug_key` on `skills.slug`. A join answers one row per
       * PAIR, so a second row at an app's url listed the same account twice: two rows on the
       * settings page saying the same app under two different server ids, each offering to
       * disconnect the single connection standing behind both. And it is not an exotic state — it
       * is what any database looks like the moment a row at `gmail` sits beside the
       * `composio-gmail` an administrator really added, which is how a development database
       * routinely looks.
       *
       * A UNIQUE INDEX WOULD BE THE OTHER FIX AND IS THE WRONG ONE. Two rows at one address is a
       * state this product means to allow — a deployment holding two accounts at one vendor adds
       * the same URL twice under two ids with two credentials, and `addCustomServer` refuses only a
       * re-add that MOVES an existing id's address. Constraining the column would forbid that for
       * everybody to tidy a display defect, and the migration that added it would fail outright on
       * any deployment already holding a duplicate, taking the whole boot with it.
       *
       * SO THE LOWER ID ANSWERS FOR THE APP, and it is a rule rather than whatever the scan met
       * first: a page that redrew under a different `serverId` each load would be offering buttons
       * keyed on a value moving underneath it. The same rule decides the scheme reads — see
       * {@link brokeredAppScheme} — so nothing in this file can name one row for an app while
       * something else names another.
       *
       * AND "LOWER" IS THE DATABASE'S OWN WORD FOR IT, WHICH IS WHY THE ORDER IS IN THE QUERY. This
       * read took its rows unordered and picked the smallest with a JavaScript `<`, which compares
       * UTF-16 code units and nothing else, while {@link brokeredAppRow} asks for `order by id`
       * under whatever collation the deployment's database runs. Those two agree for ASCII on a `C`
       * database and are free to disagree everywhere else — a linguistic collation reorders case and
       * punctuation, and byte order and code-unit order part company above the BMP. One rule spelled
       * in two languages is two rules, and where they parted the page drew an app under one server
       * id while the Re-check button beside it, the probe behind that button and the scheme that
       * decides whether the button appears at all were about the other row: the same defect the
       * single read was written to end, reached through the collation instead of through the query.
       * So the resolution is {@link brokeredAppRowsAt} and not a rule spelled again here: it is the
       * same function {@link brokeredAppRow} answers one app out of, which is what makes the row
       * this page draws an app under the row every read behind its buttons is about.
       *
       * A CONNECTION WITH NO ROW AT ITS URL IS STILL LISTED BY NOTHING, which is what the inner
       * join answered and what the missing `serverId` below drops. A person can hold an account at
       * an app this deployment has since removed, and the settings page has no row to draw for it.
       */
      const named = await brokeredAppRowsAt(
        connections.map((row) => `composio://${row.toolkit}`),
      );

      const rows = connections
        .flatMap((row) => {
          const serverId = named.get(`composio://${row.toolkit}`)?.id;
          return serverId === undefined ? [] : [{ ...row, serverId }];
        })
        // By server id, as the join's own `order by` was, so this read and `connectionsFor` hand the
        // route two lists ordered alike. Compared as plain strings rather than through a collation,
        // for the reason the route gives where it merges them: the order only has to be the same
        // one every time.
        .sort((left, right) => {
          if (left.serverId < right.serverId) return -1;
          return left.serverId > right.serverId ? 1 : 0;
        });

      return await Promise.all(
        rows.map(async (row) => ({
          serverId: row.serverId,
          scope: "",
          connectedAt: iso(row.connectedAt) ?? "",
          verified: row.verified,
          verifiedAt: iso(row.verifiedAt),
          // The name alone, because that is what the four states are told apart by; the version the
          // check was made at is the caller-of-the-call's business, and this read makes none.
          probe: row.probeAction,
          /*
           * WHETHER, NOT WHICH. The chooser names an action and this keeps only the yes or no,
           * because the yes or no is the whole of the question being asked: is there anything to
           * spend a key on. Carrying the name would put a second action name on a row that already
           * has one, inches from the field that records what was actually spent — and the first
           * reader to draw a sentence off the wrong one re-opens the defect that made `probe` a
           * record. A boolean cannot be mistaken for a record of anything.
           */
          checkable: (await this.probeActionFor(row.serverId)) !== null,
        })),
      );
    },

    /**
     * Whether this person has one brokered app connected, and since when.
     *
     * THE ROW IS A CACHE OF COMPOSIO'S ANSWER, not a record of a flow this deployment watched
     * finish. Nothing here holds a secret for a brokered app: the vendor keeps the account, and
     * what {@link composioConnections} holds is the sentence "Composio said yes when we asked",
     * written down so that every later call can be gated without a round trip. That makes drift
     * possible by construction — somebody can end the connection in Composio's own dashboard, and
     * this row would go on saying yes — and it is why {@link confirmBrokeredConnection} asks the
     * vendor again rather than trusting what is here. Calling confirm on any page load is
     * therefore how a row that drifted heals.
     *
     * Read by the pair, because the pair is the primary key: an app has many people's connections
     * and a person has many apps, and the only question anybody asks is about one of each.
     */
    async brokeredConnection(input: {
      toolkit: string;
      userId: string;
    }): Promise<{ connectedAt: string } | null> {
      const [row] = await database
        .select({ connectedAt: composioConnections.connectedAt })
        .from(composioConnections)
        .where(
          and(
            eq(composioConnections.toolkit, input.toolkit),
            eq(composioConnections.userId, input.userId),
          ),
        )
        .limit(1);

      if (!row) return null;
      return { connectedAt: iso(row.connectedAt) ?? "" };
    },

    /**
     * The action a key verification should call against this app, and the version to call it at.
     *
     * THIS CHOOSES THE ONE ACTION THAT WILL BE CALLED WITH SOMEBODY'S JUST-TYPED API KEY, which is
     * what makes it the most dangerous line in the verification: whatever comes back from here runs
     * against a stranger's account, once, purely to find out whether their key works. So the two
     * safety conditions below are BOTH non-negotiable, and neither is a stricter spelling of the
     * other.
     *
     * READ EFFECT, because a probe must not change anything. The label is the vendor's own and not
     * a guess of ours: `effectOf` answers `read` only where Composio sent `readOnlyHint`, and
     * everything unlabelled was already recorded as a write, so `read` here means Stripe or Linear
     * or Notion said so. `destructive` is checked beside it rather than trusted to be implied — the
     * two are separate columns precisely so a vendor can say both things, and a row that somehow
     * says read AND destructive is a row this deployment has no business calling unasked.
     *
     * ZERO REQUIRED INPUTS, because there is nothing to invent an argument from. A probe happens
     * before this deployment knows anything about the account beyond the key, so a required customer
     * id or query has no honest value to carry, and a made-up one turns "is this key good" into
     * "does this identifier exist" — which fails for a perfectly good key.
     *
     * BOTH, NEVER EITHER, and the live catalogue is why this sentence is here rather than a comment
     * saying the checks are belt-and-braces. The first argument-less action on Stripe's own list is
     * `STRIPE_CREATE_BILLING_METER_EVENT_SESSION`. A probe chosen on "takes no arguments" alone —
     * the condition that looks sufficient, because it is the one that makes a call possible at all —
     * would therefore write to somebody's account to find out whether their key works. The read
     * effect is the whole of what stands between those two names.
     *
     * AND A RECORDED VERSION, WHICH IS PART OF "CAN THIS BE CALLED AT ALL" AND NOT A DETAIL OF THE
     * CALLER. Composio refuses an execution without a specific version and rejects `latest`, so the
     * transport refuses before dialling where none travels with the call — and Composio publishes
     * some actions with no version at all. An action this deployment recorded without one is
     * therefore an action nothing here can spend a key on, which is the same kind of fact as a
     * required input: not unsafe, just not callable. The version is SELECTED AND RETURNED for the
     * caller that has to send it, so the choice and the call cannot come apart.
     *
     * THE CONDITION LIVES IN THE FILTER RATHER THAN AFTER THE CHOICE, so there is ONE predicate for
     * one question. While it sat downstream — read by the probe, unknown to everything else — there
     * were two, and the weaker of them was what the connections listing derived its `probe` field
     * from: an app whose chosen action had no version connected honestly as "nothing was tried",
     * then reloaded as "your key was checked and rejected". That listing no longer derives that
     * field from here — {@link brokeredConnectionsFor} reads what the check RECORDED, because no
     * derivation from today's metadata can be right about yesterday's check. It still asks this
     * function a question, but a present-tense one: whether the app has anything to check with now,
     * kept as a yes or no beside the record. A split predicate would therefore no longer put a
     * false sentence on a settings page; it would show up in two worse places — a probe that chose
     * an action it then refused to send, and a button offered over an app nothing can be spent on.
     * A filter also lets the search CONTINUE: a versionless
     * candidate is passed over for the next safe read rather than short-circuiting the whole app to
     * "nothing to try", so an app that can be checked is.
     *
     * NULL IS AN ANSWER AND NOT A FAILURE. Of fifteen key-based apps sampled, most publish some safe
     * argument-less read and PostHog publishes none at all, so an app that cannot be probed is an
     * ordinary app rather than a broken one. What a caller does about it — and running the probe at
     * all — belongs to the verification path; this function only chooses.
     */
    async probeActionFor(
      serverId: string,
    ): Promise<{ name: string; version: string } | null> {
      // Ordered, because the fallback below is "the first candidate" and Postgres promises no order
      // without one: an unordered read would make which action gets called with somebody's key a
      // property of whichever plan the server happened to pick.
      const actions = await database
        .select({
          name: mcpTools.name,
          inputSchema: mcpTools.inputSchema,
          effect: mcpTools.effect,
          destructive: mcpTools.destructive,
          version: mcpTools.version,
        })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, serverId))
        .orderBy(asc(mcpTools.name));

      // One pass, and it yields the pair rather than the row: an action that survives every
      // condition below has a version by definition, and building the answer here is what carries
      // that fact into the type instead of leaving the caller to re-check it.
      const safe = actions.flatMap((action) => {
        if (action.effect !== "read" || action.destructive) return [];
        // Null in the column and blank in the data are the same nothing, and neither is a version
        // the transport can put on a call.
        const version = action.version?.trim();
        if (!version) return [];
        /*
         * THE WHOLE SCHEMA IS ASKED, NOT ITS TOP-LEVEL `required`. This read `schema?.required` and
         * passed over the action only for a non-empty list there — so an action whose required
         * arguments are published under `allOf`/`anyOf`/`$ref`, which is how a generated toolkit
         * ordinarily writes them, was selected as argument-less, called with `{}`, and answered with
         * the vendor's validation error. That arrives at `probeConnection` as `answered: true,
         * isError: true`, which is the `refused` verdict — a valid key declared bad, and on connect
         * the account created seconds earlier deleted behind it. See {@link asksForArguments} for
         * which keywords bear on an empty object and why the unreadable shapes answer yes.
         */
        if (asksForArguments(action.inputSchema)) return [];
        return [{ name: action.name, version }];
      });

      const identity = safe.find((action) => IDENTITY_ACTION.test(action.name));
      return identity ?? safe[0] ?? null;
    },

    /**
     * Write down that this person holds this brokered app, and how well that is known.
     *
     * ONE WRITER SO THE VERIFIED AND UNVERIFIED PATHS CANNOT DRIFT INTO TWO ROW SHAPES. What says
     * how well a connection is known is a SET of fields and not a column: `verified` is meaningless
     * without the moment it was earned, and `verified_at` without the flag is a date on a claim
     * nobody made. Every path that records a connection therefore comes through here rather than
     * spelling that set for itself — {@link confirmBrokeredConnection} with `true` today, and the
     * verify path, which is the caller `false` exists for, when a probe against a key connection
     * comes back unanswered. Two call sites each writing the set by hand is how one of them comes
     * to set the flag and leave the timestamp null, or to move `connected_at` on a confirm that
     * healed a row nothing changed; spelled once, a reader asking what shape a connection row takes
     * has one answer and every path takes it.
     *
     * `verified` IS THE CALLER'S CLAIM AND `verifiedAt` FOLLOWS FROM IT, never the other way round.
     * True means the caller has evidence as of now — the vendor's own yes at the end of a consent
     * screen, or a call that went out and came back — so the timestamp is stamped here rather than
     * passed in, and it is the moment of the write because that is the moment the evidence was in
     * hand. False takes the timestamp back to null rather than leaving the old one standing: a row
     * that has stopped being verified must not keep a date saying when it last was, because the one
     * sentence the page builds out of the pair — "last checked 13 Sep" — would then be drawn for a
     * connection this deployment is no longer claiming anything about.
     *
     * `connected_at` IS LEFT ALONE, which is the whole reason this is an upsert with an explicit
     * `set` rather than a delete and an insert. The person connected when they connected; a write
     * that moved it would make every page load look like a fresh connection on their own settings
     * page, and would erase the one date the row holds that nothing else in this deployment knows.
     *
     * AND THE STAMP IT WROTE IS WHAT IT ANSWERS, for the same reason the caller does not pass one
     * in. A caller that needs the moment — {@link recheckBrokeredConnection}, which hands it to the
     * browser as the date the row's sentence is drawn from — would otherwise have to read the row
     * back and hope it was reading its own write. The timestamp is still this writer's; what
     * changed is that it is no longer thrown away.
     *
     * `only` IS WHETHER THIS WRITE MAY CREATE A CONNECTION, AND ONE CALLER MUST SAY NO.
     *
     * CRITERION. With `only: "a row that is still there"` this method never inserts. It updates a
     * row that exists and answers `wrote: false` for one that does not, and the caller decides what
     * to do about that.
     *
     * REASON. {@link recheckBrokeredConnection} reads the row first, deliberately, "because the
     * writer below is an upsert, so a re-check that probed first would INSERT a connection for
     * somebody who has none". That read and this write straddle a LIVE VENDOR CALL of several
     * seconds, and nothing held the row still across it. A person pressing Re-check and then
     * Disconnect in another tab — or a concurrent {@link confirmBrokeredConnection} getting `false`
     * from Composio and deleting the row — had the revoke complete at Composio and the row deleted,
     * and then this in-flight upsert PUT IT BACK. `composio_connections` is the whole of the
     * permission a brokered call is decided on, so what the re-insert restores is access to an
     * account the person has just disconnected, drawn on every screen as connected.
     *
     * THE GUARD IS ON THE WRITE RATHER THAN A LOCK ACROSS THE CALL, because the call is somebody
     * else's and may take as long as it likes. A connection this write did not find is one nothing
     * happened to: the probe's answer is about an account the person no longer has here.
     *
     * `probeAction` IS PASSED IN, UNLIKE THE TIMESTAMP, BECAUSE ONLY THE CALLER KNOWS IT. It is the
     * action this check SPENT — the probe's name, or null where none was spent — and it is required
     * rather than optional so that a new path cannot record a connection while staying silent about
     * what it tried. Every existing caller knows the answer without looking anything up: a consent
     * confirm spent nothing and passes null, and both probing paths pass the name the probe returned
     * them, which is null there too when the app published nothing safe to call.
     *
     * IT IS PART OF THE SAME SET AS THE FLAG AND THE STAMP, which is the reason it is written here
     * and nowhere else. `verified` alone says a check did not pass and cannot say what it was; this
     * column is what separates "the app published nothing to try" from "it ran and the vendor said
     * no", and a row carrying one of the three without the others is a shape no reader downstream
     * has reasoned about. It used to be derived on read instead, from the app's action listing as
     * that listing stood at the moment of the read — see {@link brokeredConnectionsFor}, where the
     * refresh that broke the derivation is written out.
     */
    async recordBrokeredConnection(input: {
      toolkit: string;
      userId: string;
      verified: boolean;
      probeAction: string | null;
      /** See the paragraph on `only` above. Absent is the ordinary upsert. */
      only?: "a row that is still there";
    }): Promise<{ verifiedAt: Date | null; wrote: boolean }> {
      const verifiedAt = input.verified ? new Date() : null;
      // The one set, spelled once, so the conditional write below and the upsert cannot drift into
      // two row shapes. `probeAction` is overwritten rather than left standing, for `verifiedAt`'s
      // reason: the pair describes ONE check, and a row keeping the action an earlier check spent
      // beside the verdict of a later one would name a call this row's own state did not come from.
      const set = {
        verified: input.verified,
        verifiedAt,
        probeAction: input.probeAction,
        updatedAt: new Date(),
      };

      if (input.only === "a row that is still there") {
        /*
         * AN UPDATE AND NEVER AN INSERT, and `returning` is how "there was a row" is ANSWERED rather
         * than assumed. An update that matches nothing is not a failure — it is the row having been
         * deleted while the vendor was being asked — and the caller has a sentence for that.
         */
        const written = await database
          .update(composioConnections)
          .set(set)
          .where(
            and(
              eq(composioConnections.toolkit, input.toolkit),
              eq(composioConnections.userId, input.userId),
            ),
          )
          .returning({ userId: composioConnections.userId });
        return { verifiedAt, wrote: written.length > 0 };
      }

      await database
        .insert(composioConnections)
        .values({
          toolkit: input.toolkit,
          userId: input.userId,
          verified: input.verified,
          verifiedAt,
          probeAction: input.probeAction,
        })
        .onConflictDoUpdate({
          target: [composioConnections.toolkit, composioConnections.userId],
          set,
        });
      return { verifiedAt, wrote: true };
    },

    /**
     * Spend one call on this person's key, and say what the vendor made of it.
     *
     * ONE PROBE, TWO CALLERS, AND THE ANSWER TO "WHAT DOES A FAILED PROBE MEAN" LIVES HERE ONCE.
     * {@link connectBrokeredWithFields} probes a key somebody has just typed;
     * {@link recheckBrokeredConnection} probes one this deployment has held for days. Both have to
     * choose the action the same way, send it the same way, and read the vendor's answer the same
     * way — and a second copy of that reading is how one of them comes to treat a rejected key as a
     * connection that merely could not be checked. What the two callers do NEXT is all that differs,
     * and it is all either of them keeps for itself: one withdraws the account it just made, the
     * other leaves an account it did not make alone.
     *
     * FOUR ANSWERS AND NOT A BOOLEAN, because `verified: false` means several different things
     * about somebody's key and the flag separates none of them. They are enumerated on
     * {@link BrokeredProbe}, which is where a reader should go; the one worth repeating at the call
     * this method makes is the fourth.
     *
     * A VENDOR THAT WAS NOT REACHED IS NOT A VENDOR THAT SAID NO, and this is the one place that
     * can tell. `callTool` answers with a result rather than throwing, and `isError` is true for all
     * three of the failures it documents — so read as a verdict here, a Composio outage, a socket
     * that closed, a `@composio/core` that cannot parse what came back and a run attributed to
     * nobody were every one of them "the vendor refused this key". What that cost is at the callers
     * and it was the worst thing this feature did: on connect the account somebody had just made
     * was deleted at the vendor and they were told what they entered did not work; on re-check a
     * live, working connection was stripped of its verification and marked as holding a bad key.
     * {@link ActionAnswer} is what the transport now answers beside the result, and this method
     * asks for it by calling `askAction` rather than `callTool`.
     *
     * A FAILURE IS RETURNED RATHER THAN THROWN, which is the one thing this function does not
     * decide. Its two callers end a bad key differently — one undoes an account and refuses, the
     * other writes the row unverified and refuses — so a throw here would force the undo on both or
     * neither. What it owes them is the vendor's sentence and the name of what was tried.
     *
     * NOTHING IS WRITTEN, NOTHING IS AUDITED, AND NO ACCOUNT IS TOUCHED. This is a question asked of
     * the vendor; recording the answer belongs to whoever asked it.
     */
    async probeBrokeredConnection(input: {
      toolkit: string;
      userId: string;
      /**
       * THE ACCOUNT TO SPEND IT IN, where the caller has one in mind.
       *
       * {@link connectBrokeredWithFields} has just made an account and is asking about THAT key; a
       * person and an app do not name it, because one person may hold several accounts for one app
       * and the vendor picks which a call runs in. Unpinned, a bad key was verified by the person's
       * other, working account — and the same defect the other way round condemned a good key, and
       * deleted the account it made, on the strength of some other account of theirs being broken.
       *
       * ABSENT FOR A RE-CHECK, AND THAT IS A GAP RATHER THAN A CHOICE. `composio_connections`
       * records no account id — the row is keyed on the person and the app — so a press of Re-check
       * has nothing to pin to and asks the vendor the same app-level question it always did. It is
       * the milder half: a re-check writes a verdict but takes nothing away, and its refusal tells
       * the person their key is wrong rather than removing anything they hold.
       */
      accountId?: string;
    }): Promise<BrokeredProbe> {
      /*
       * THE ONE ACTION THIS DEPLOYMENT WILL SPEND THE KEY ON, chosen from what the app published.
       *
       * Composio accepts a key without ever trying it, so "connected" at the vendor is not evidence
       * that the credential works — and a row written on that acceptance is a gate every later
       * brokered call passes for a key that cannot answer. {@link probeActionFor} is what keeps the
       * call safe: the vendor must have labelled the action a read and it must take no arguments,
       * and both matter because the first argument-less action on Stripe's own list creates a
       * billing session. It answers the VERSION beside the name, because Composio refuses an
       * execution without a specific one — so an action recorded without a version is one the
       * chooser passes over rather than one this method discovers it cannot call. Null is an
       * ordinary answer — see that method — and it is the FIRST of the three states above.
       *
       * NOTHING IS ASKED A SECOND TIME HERE, AND THAT IS THE POINT. Every condition on whether an
       * action can be spent on a key lives in the chooser, so the action this method sends is the
       * action the chooser said was sendable, whole. A version re-read here would be a second
       * predicate for one question, and the weaker of two predicates is what once had a reloaded
       * page tell somebody their untried key had been rejected — in the days when the connections
       * listing answered by asking the chooser too. It no longer does: what a page says about a
       * check is what the check recorded, and what it recorded is the name this method returns.
       *
       * AND THE APP IS RESOLVED BY ITS URL, THE WAY EVERY OTHER BROKERED LOOKUP HERE IS — through
       * {@link brokeredAppRow}, which is the one read that decides it. The url is where a brokered
       * row records which app it is; `mcp_servers.id` is a display name and nothing holds the two
       * equal — which is exactly why {@link connectBrokeredWithFields}, {@link
       * recheckBrokeredConnection} and {@link disconnectBrokered} all key on the url, and why {@link
       * brokeredConnectionsFor} resolves on it rather than spelling `composio-${toolkit}` by hand.
       * Composing it here made this method the one place that re-derived the id from a convention,
       * and it put the two halves of the `checkable`/`probe` split back into disagreement on any
       * row where they differ: the listing answered `checkable` off the app's real row while this
       * answered off an id addressing nothing, so the button was offered and the press could never
       * find anything to spend — the Re-check deadlock the split exists to prevent, reached from
       * the other end. Worse where the composed id DID hit something: a row called `composio-gmail`
       * at `composio://slack` would have this choose a stranger's probe off another app's listing
       * and spend their key on it. A row this deployment has since removed drops out here as null,
       * which is the same honest answer the listing gives for it: there is no app left to check.
       *
       * AND THE SHARED READ RATHER THAN A URL QUERY OF ITS OWN, because `mcp_servers.url` has no
       * unique index and an unordered `limit(1)` over it is not an answer. A second row at the app's
       * url — the ordinary state of any database where a fixture sits beside the `composio-` row an
       * administrator really added — had this resolve to whichever row the scan met first while the
       * listing named the app by the lower id, which is the SAME deadlock one step along: Re-check
       * offered off the app's own row, and the press landing on a row that publishes no action and
       * reporting there was nothing to try. One function decides which row answers for an app, so
       * nothing here can name one row while something else names another.
       */
      const app = await brokeredAppRow(input.toolkit);

      const candidate = app ? await this.probeActionFor(app.id) : null;
      if (candidate === null) {
        return { outcome: "nothing", probe: null };
      }

      /*
       * THE TRANSPORT DIRECTLY, AND NOT `callTool` ABOVE. This deployment's own `callTool` checks a
       * grant, evaluates the policy and writes an `mcp.call_*` row, and there is no Bot here to
       * check a grant for, no policy context to evaluate and no Bot to attribute a row to. What
       * holds this narrow is structural rather than disciplinary: no endpoint, no arguments, and an
       * action chosen from recorded metadata rather than from anything a request said. See
       * `mcp.connection_verified` in `./audit`, which records the same three properties as the
       * reason this call may skip the checks the ordinary path cannot — and which names both of
       * this function's callers as the whole of who may make it.
       *
       * THE VERSION IS NOT AN ARGUMENT. It travels under the transport's reserved key, which the
       * Composio transport strips before anything reaches the vendor and asserts that it did, so
       * what Composio is handed is the action and an empty argument object.
       */
      const { result, answered } = await composioAskAction(
        {
          url: `composio://${input.toolkit}`,
          actorId: input.userId,
          // Spread rather than passed as `undefined`, so "any account of theirs" reaches the wire
          // as a body with no such key. See {@link ComposioActions.execute}.
          ...(input.accountId === undefined
            ? {}
            : { accountId: input.accountId }),
        },
        candidate.name,
        { [VERSION_ARG]: candidate.version },
      );

      /*
       * THE READING, AND IT IS THE WHOLE OF WHAT THIS METHOD DECIDES. `answered` is the transport's
       * own statement that Composio ran the action in the account and said how it went; `isError`
       * then says what it said. Anything else is an outage or an answer this deployment could not
       * read, and neither is evidence about a key — so the action's NAME is withheld from those,
       * because the name beside `verified: false` is the accusation and only a call that can be
       * shown to have run may make it.
       */
      if (!answered) {
        return {
          outcome: "unreachable",
          probe: null,
          attempted: candidate.name,
          sentence: result.text,
        };
      }

      /*
       * AND `isError` SAYS THAT THE CALL WENT BADLY, NOT THAT THE KEY IS BAD. The envelope this is
       * read out of is `{ data, error, successful }` and nothing more: a 429, a scope this one
       * action needs and the key legitimately lacks, and a 404 for a resource the read action names
       * all arrive here identically to a credential the vendor rejected. So the outcome is named
       * for what was observed — the app complained — and the two readings that treated it as a
       * verdict about the credential are gone from both callers. See {@link BrokeredProbe}.
       */
      return result.isError
        ? {
            outcome: "complained",
            probe: candidate.name,
            sentence: result.text,
          }
        : { outcome: "answered", probe: candidate.name };
    },

    /**
     * Ask Composio whether this person's account is really attached, and write down the answer.
     *
     * THE VENDOR IS ASKED, NOT THE BROWSER. The return trip from a consent screen is an ordinary
     * redirect carrying nothing signed, so a person arriving back on the page is not evidence that
     * they finished the flow, nor that the account they finished it with is the one a row would
     * claim. A confirm that wrote a row because somebody came back would hand every later brokered
     * call a gate that passes for an account nobody has — and the first anyone would hear of it is
     * the vendor's own error about a connection it cannot find, at the moment a Bot was asked to do
     * something.
     *
     * SO THE ANSWER NO LEAVES NO ROW BEHIND. `false` from {@link ComposioBroker.isConnected} is a
     * positive claim that there is no account, and the honest local state for that claim is an
     * absence — so a row already sitting here is deleted rather than left standing. Leaving it
     * would have the settings list go on drawing "Connected" for an account nobody has, and would
     * go on passing the gate every later brokered call is decided on, while the app's own detail
     * page asks the vendor and says the opposite.
     *
     * AND THAT DELETION FILES NO TRAIL ENTRY. Nobody disconnected anything here: the grant ended
     * somewhere else, and this is our record catching up with a fact. {@link disconnectBrokered}
     * owns `mcp.account_disconnected` and files it for the act it performed; a second filer here
     * would have the trail claim an act that did not happen, credited to whichever page load
     * happened to notice.
     *
     * UPSERT RATHER THAN INSERT, keyed on the pair the table itself is keyed on. This is safe to
     * call repeatedly and is meant to be: because the row is only a cache of the vendor's answer
     * (see {@link brokeredConnection}), a row that drifted out of step — an account ended in
     * Composio's own dashboard, a connect this deployment missed the callback for — is healed by
     * the next confirm on any page load, in whichever direction it drifted: by the upsert here
     * where the vendor says yes, and by the delete above where it says no.
     *
     * AND THE YES WRITES A VERDICT ONLY WHERE CONSENT IS THE CHECK, which is the one thing a reader
     * of this method has to carry away. `verified: true` beside a null `probeAction` is not a
     * neutral heal: it is a NAMED one of the four states {@link composioConnections.probeAction}
     * enumerates — the consent state — and this method runs from an effect on mount, so writing it
     * unconditionally meant every page load restated it over whatever a real check had recorded.
     * For a key connection that erased the record, worst of all over "a named probe beside
     * `verified: false`", the live account with a bad key behind it that is the one state somebody
     * must act on; and it re-dated `verified_at` to the page load, so the row claimed a check on a
     * day nothing was checked. The yes itself does not bear on a key: {@link
     * ComposioBroker.isConnected} says an account is attached, Composio takes a key when it is
     * typed and never tests it again, so for a key app that answer is what the row's existence
     * already said. The branch is on the scheme recorded on the app's row, classified through {@link
     * brokeredAppKind} as {@link connectBrokeredWithFields} and {@link recheckBrokeredConnection}
     * classify theirs, and a key row already here is left untouched — the evidence about a key is a
     * call, and those two are the only writers of this row's verdict. A key app the vendor holds an
     * account for with no row here still gets one, written UNCHECKED, because the row is the gate
     * every later brokered call passes through and the only thing Disconnect works off.
     *
     * AND THE FLAG IS WRITTEN FOR A CONSENT APP RATHER THAN FOR ANYTHING THAT IS NOT A KEY APP. A
     * scheme this deployment cannot read — a null, or a literal nothing here writes — is neither
     * kind, and it takes the key app's treatment: nothing recorded is overwritten, and a person the
     * vendor holds an account for still gets the row that is their permission. See {@link
     * SchemeKind} for why that third answer has to travel rather than be flattened into the second.
     *
     * `scope` IS EMPTY BECAUSE COMPOSIO GRANTS NONE THAT IT TELLS US ABOUT. The field exists so a
     * later refusal for want of a permission can be explained by what the vendor actually granted,
     * and Composio's connection answer is a boolean with no scope in it. Writing a plausible claim
     * there — the app's full access, say — would put words in the vendor's mouth in the one field
     * whose whole job is to say what it said.
     *
     * `reconnected` IS FALSE FOR THE SAME REASON, and trivially so. The flag distinguishes somebody
     * replacing a grant from somebody making one, and the only confirms that reach the trail are
     * the ones that found no row at all — so there was nothing here to replace.
     *
     * AND THE EVENT IS WRITTEN ONLY WHERE THE ROW IS NEW. This method runs on every page load
     * rather than only when a person acts, so an event per yes from the vendor would file ten
     * "account connected" rows for somebody who opened the connector page ten times having
     * connected once. A confirm that heals a row nothing changed is a read, and the trail records
     * acts: where a row was already there the connection has been recorded once already, by the
     * confirm that first found none.
     */
    async confirmBrokeredConnection(input: {
      toolkit: string;
      userId: string;
    }): Promise<{ connected: boolean }> {
      // Before anything, and for the reason `addBrokeredApp` says it first too: a deployment with
      // no key has no broker to have connected anybody at, so there is nothing here to ask.
      if (!broker) throw new BrokerUnconfiguredError();

      const connected = await broker.isConnected({
        userId: input.userId,
        toolkit: input.toolkit,
      });
      if (!connected) {
        // Deleted rather than left alone, because the row is only the vendor's last answer: an
        // account ended in Composio's own dashboard reaches this deployment as the no above and
        // as nothing else, and a row that outlived it would go on saying yes about an account the
        // vendor has just denied.
        await database
          .delete(composioConnections)
          .where(
            and(
              eq(composioConnections.toolkit, input.toolkit),
              eq(composioConnections.userId, input.userId),
            ),
          );
        return { connected: false };
      }

      /*
       * READ BEFORE THE WRITE, because the upsert leaves nothing behind that tells the two cases
       * apart, and whether a row was already here is the whole of what decides if anybody acted.
       *
       * AND THE VERDICT IS READ BESIDE THE ROW'S EXISTENCE, which is the consent arm's business.
       * `verified` here is the difference between "this deployment has already recorded the
       * vendor's yes" and "it has not", and the write below is conditioned on it so that a mount
       * cannot re-date a consent that was recorded days ago. The column is read directly rather
       * than through {@link brokeredConnection}, which answers with the connection date alone.
       */
      const [held] = await database
        .select({ verified: composioConnections.verified })
        .from(composioConnections)
        .where(
          and(
            eq(composioConnections.toolkit, input.toolkit),
            eq(composioConnections.userId, input.userId),
          ),
        )
        .limit(1);
      const existing = held !== undefined;

      /*
       * THE SCHEME ON THE APP'S ROW, WHICH IS WHAT DECIDES WHETHER THE YES ABOVE IS A CHECK.
       *
       * Keyed on the url and on the one row that answers for it — see {@link brokeredAppRow} — which
       * is the read {@link connectBrokeredWithFields} and {@link recheckBrokeredConnection} both
       * make: `mcp_servers.id` is a display name and nothing holds the two equal, so a row called
       * `gmail` at `composio://slack` would decide a Slack confirm on Gmail's scheme, and a second
       * row at the app's own url would have this confirm branch on a scheme the re-check beside it
       * disagrees with. Asked through {@link brokeredAppKind} rather than compared as a string, so
       * the schemes this branches on cannot drift from the schemes that have a key behind them.
       *
       * AND THE QUESTION IS "IS THIS A CONSENT APP", NOT "IS THIS NOT A KEY APP", which are the same
       * question only if the column can always be read.
       *
       * CRITERION. `verified: true` is written here for an app this deployment KNOWS connects by
       * consent, and for no other.
       *
       * REASON. This branched on {@link isFieldScheme} alone, so every other answer — a consent
       * scheme, a literal from a deployment that knew other names, a NULL — fell into the consent
       * arm by elimination. A null is not a consent app: it is a column this deployment cannot read,
       * which {@link mcpServers.authScheme} calls a row that is not brokered and which the row that
       * ANSWERS for an app is perfectly free to carry — no unique index stands behind that url, so
       * the row an enable wrote its scheme onto is not always the row found here. Confirm runs from
       * an effect on mount, so the elimination wrote `verified: true` with a fresh `verified_at` and
       * a null probe over that row on every page load: a verdict about evidence nobody has, dated to
       * the day somebody opened a page, over whatever a real check had recorded. The other two
       * readers of this column already fail closed on the null — {@link recheckBrokeredConnection}
       * refuses the press, {@link disconnectBrokered} claims no revocation — so the one caller that
       * could not survive being wrong was the only one failing open.
       *
       * SO AN UNREADABLE SCHEME IS TREATED AS A KEY APP IS, and that is the cautious half in both
       * directions: nothing already recorded is overwritten, and the row that is the gate is still
       * written where the vendor holds an account nothing here has a row for.
       */
      const kind = await brokeredAppKind(input.toolkit);

      /**
       * WHAT THIS CONFIRM ANSWERS FOR EACH KIND OF APP, WRITTEN DOWN BECAUSE THE CHAIN CANNOT BE.
       *
       * Type-only and erased; see {@link Decides}. The chain below tests ONE member and then tests
       * something else — `kind === "none"`, `kind === "consent"`, then `!existing` — so there is no
       * position where the compiler has this vocabulary narrowed away and nothing here would fail
       * for a fifth member.
       * This is the caller that WRITES, and it is the one that could not survive being wrong: it
       * runs from an effect on mount, so whatever it decides for a member nobody named is decided
       * again on every page load.
       *
       * EVERY CELL IS NOW ASSERTED RATHER THAN DECLARED. `consent` used to be written as what the
       * code did rather than as what it should do — the re-stamp of `verified_at` on an
       * already-consented row was a live finding — and `none` did not exist as a member at all, so
       * a no-auth app was classified `consent` and got that same write on every mount. See the
       * table in `tests/composio-connection-kinds.test.ts`, which drives each of these four against
       * the running code.
       */
      type _ConfirmDecides = Decides<
        SchemeKind,
        {
          key: "leaves an existing row exactly as it is; records a new one as unchecked";
          consent: "records the vendor's yes as a verification the first time, and leaves an already-consented row alone";
          none: "writes nothing and files nothing — there is no account here for a row to be about";
          unreadable: "treated as a key app is — nothing already recorded is overwritten";
        }
      >;

      /*
       * AND THE CONSENT WRITE HAPPENS ONCE, WHICH IS THE OTHER HALF OF "A MOUNT DOES NOT RE-DECIDE".
       *
       * CRITERION. `verified: true` is written for a consent app only where this deployment has not
       * already recorded it. A row already carrying that verdict is left exactly as it is, its
       * `verified_at` included.
       *
       * REASON. The arm was unconditional, and this method runs from an effect on mount — so every
       * page load re-stamped `verified_at` to the moment of the load. The flag never changed, so
       * nothing looked wrong; what was destroyed was the DATE, which for a consent connection is
       * the day somebody finished at the vendor's own screen and is a fact nothing else in this
       * deployment records. The row's own sentence, "last checked 1 Sep", became "last checked
       * today" on a day nothing was checked, and the real date could not be recovered from anywhere.
       * {@link recheckBrokeredConnection} refuses to probe a consent app in order to protect exactly
       * that date; a confirm that re-stamped it on every mount destroyed from the inside what that
       * refusal protects from the outside. Two earlier fixes made this arm conditional for the key
       * case and then for the unreadable case and left the consent case — the one the arm is
       * actually FOR — writing on every load.
       *
       * AND A ROW NOT YET CARRYING THE VERDICT IS STILL HEALED, once. A consent app whose row was
       * written by some other path — a key-era connect, an enable that changed the app's scheme
       * afterwards — reads `false` with a null date, which is the pair "nobody has checked" and is
       * not true of a consented account. The vendor's yes above is the check for this kind of app,
       * so it is recorded, with the stamp of the moment it was first recorded here, and the next
       * mount finds the verdict already present and writes nothing.
       */
      /*
       * AN APP THERE IS NOTHING TO CONNECT TO GETS NO ROW, WHICH IS THE OTHER TABLE'S RULE APPLIED
       * HERE FOR THE FIRST TIME.
       *
       * CRITERION. Nothing is written and nothing is filed for a `none` app, whatever the vendor
       * answered about it.
       *
       * REASON. `NO_AUTH` used to be a member of the CONSENT list, so the classifier called it
       * consent and the arm below wrote `verified: true` with a fresh `verified_at` for it — on
       * every page load, because this runs from an effect on mount. That is precisely the row the
       * connect route refuses to create for these apps and the row the per-person gate is written to
       * do without: `composio_connections` is the whole of the permission for a brokered call, and
       * every row in it means one thing, that this person granted this deployment access to their
       * account at this app. There is no account — Composio refuses even to hold an authorization
       * config for a no-auth toolkit — and there is no grant, so a year on, offboarding, the trail
       * and the Disconnect button could not tell those rows from ones somebody really made.
       *
       * THE NEGATIVE HEAL ABOVE STILL RAN, and deliberately: a row left behind by the version that
       * wrote them is removed by the first mount that finds the vendor holding no account, which is
       * every mount for an app like this.
       */
      if (kind === "none") return { connected: true };

      if (kind === "consent" && !held?.verified) {
        // VERIFIED, BECAUSE A CONSENT SCREEN IS A VERIFICATION AND NOT A LESSER KIND OF ONE. The
        // vendor has just answered that this person's account is attached, which is the same
        // question a probe goes and asks; that the evidence arrived through a consent flow rather
        // than through a call this deployment made does not make it weaker. Writing on the column
        // defaults instead left every consent connection reading `false` with a null `verified_at` —
        // the pair a key somebody typed in and nobody ever checked reads — so the settings page could
        // not tell the two apart. Written through the single writer above rather than here, so this
        // path and the verify path cannot come to write two different row shapes; see
        // {@link composioConnections.verified}.
        await this.recordBrokeredConnection({
          toolkit: input.toolkit,
          userId: input.userId,
          verified: true,
          // NOTHING WAS SPENT TO EARN THAT FLAG, and that is what the null records rather than an
          // absence of information. A consent connection is verified by the vendor's own yes at its
          // own screen; no action of the app's is ever called against it, here or later, so there is
          // no name to write and there never will be. The derived field could not say so — it
          // answered with whatever the app happened to publish — and a consent row was listed as
          // having been checked with an action nothing had called.
          probeAction: null,
        });
      } else if (kind !== "consent" && !existing) {
        /*
         * A KEY APP THE VENDOR HOLDS AN ACCOUNT FOR AND NOTHING HERE HAS A ROW FOR: recorded as
         * UNCHECKED, which is the honest one of the four states for it. The account was made
         * somewhere this deployment did not watch — in Composio's own dashboard, or by a connect
         * whose row was lost — so no key of theirs has ever been tried from here, and null beside
         * `false` is exactly "nothing was spent". The row still has to exist: it is the gate every
         * later brokered call passes through, and the only thing Disconnect works off.
         *
         * AND AN APP WHOSE SCHEME CANNOT BE READ IS WRITTEN THE SAME WAY, for the same sentence
         * one word weaker: nothing here has ever checked this account, and nothing here knows what
         * checking it would even mean. `false` beside a null claims neither a check nor a refusal,
         * which is the only pair that is true of it — and the row is still the permission, so a
         * person whose account Composio holds does not lose their access to a column nobody wrote.
         */
        await this.recordBrokeredConnection({
          toolkit: input.toolkit,
          userId: input.userId,
          verified: false,
          probeAction: null,
        });
      }
      /*
       * AND AN EXISTING KEY ROW IS LEFT EXACTLY AS IT IS, which is the whole of what this branch
       * does and the reason there is a branch at all.
       *
       * THIS RUNS FROM AN EFFECT ON MOUNT. Both brokered account screens confirm on every page
       * load, so whatever is written here is written again every time somebody opens the page —
       * and `verified: true` beside a null `probeAction` is not a neutral heal. It is one of the
       * four states {@link composioConnections.probeAction} enumerates, and specifically the
       * CONSENT one: "the vendor's own yes is the evidence and no call was ever made against the
       * account". Written over a key row it erased the record of the last check and replaced it
       * with that sentence, including over the worst state this feature has — a named probe beside
       * `verified: false`, "it ran, the vendor refused the key, and the account is still standing"
       * — which is the one state an operator has to act on. It also moved `verified_at` to the
       * moment of the page load, so the row's own sentence, "last checked 13 Sep", named a day on
       * which nothing was checked.
       *
       * BECAUSE THE YES IS NOT EVIDENCE ABOUT A KEY. {@link ComposioBroker.isConnected} answers
       * that an account is attached, which for a key app is what the row's existence already said:
       * Composio takes a key when it is typed and never tests it again — the whole reason the probe
       * exists — so nothing in that answer bears on whether the key still works. Consent is the one
       * scheme where the vendor's yes IS the check, and it earns the flag above for that reason
       * alone. The evidence about a key is a call, and the two places that make one — {@link
       * connectBrokeredWithFields} and {@link recheckBrokeredConnection} — are the only writers of
       * this row's verdict. This one records what it learned by not writing.
       *
       * THE NEGATIVE HEAL IS UNTOUCHED, for all three kinds. A vendor answering NO still deletes the
       * row above, which is what a confirm on a key app is still worth running for.
       *
       * AND AN EXISTING ROW UNDER AN UNREADABLE SCHEME IS LEFT ALONE FOR A STRICTLY WIDER REASON.
       * For a key app the yes is not evidence; for an app whose scheme nothing here can read, it is
       * not known WHAT the yes is evidence of. Both answers are the same act — write nothing — and
       * it is the only act available that cannot claim more than was learned.
       */

      if (!existing) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_connected",
          targetType: "mcp_server",
          // The app, which is all a brokered connection is keyed on — the same id
          // `retireConnectionsFor` files its rows under, so one query answers what happened to one
          // person's access to one app however it ended.
          targetId: input.toolkit,
          payload: {
            actor: input.userId,
            server: input.toolkit,
            scope: "",
            reconnected: false,
          },
        });
      }

      return { connected: true };
    },

    /**
     * Connect this person with the secret they typed, and write down everything except the secret.
     *
     * THE VALUES TRAVEL IN ONE DIRECTION AND THE WHOLE METHOD IS BUILT AROUND THAT. They arrive on
     * the request, they are handed to {@link ComposioBroker.connectWithFields}, and they reach
     * Composio. Nothing else here is given them: not the row, not the audit payload, not a log
     * line, not a thrown error — the broker's own doc comment is where that promise is kept on the
     * far side, and it is the one call in this tree that rethrows with no `cause` precisely because
     * the vendor's error object holds the key. Every other participant in this method is a
     * long-lived, widely-readable record, so a credential landing in one is not a leak somebody can
     * clean up afterwards; it is a leak with a retention schedule.
     *
     * THE SCHEME IS THE ONE RECORDED ON THE APP'S ROW, never a fresh read of the catalogue and
     * never a value a caller passed. It is what this deployment's authorization config was created
     * AS, and a connection is attached to that config: a second derivation is a second answer — a
     * key sent as `BASIC` against a config made for `API_KEY` — which is the reasoning {@link
     * ComposioBroker.connectionFields} gives for taking the scheme rather than resolving it, one
     * step earlier in the same flow.
     *
     * AND AN APP WHOSE SCHEME IS NOT A FIELD SCHEME IS REFUSED BEFORE THE KEY TRAVELS. A consent
     * app, a `NO_AUTH` app and an app this deployment could not resolve at all have no form and
     * nothing to attach typed values to, so sending them on would spend somebody's credential on a
     * config that cannot hold it — and would do it having already taken the secret out of the
     * request. {@link isFieldScheme} is asked rather than the string compared, for the reason it
     * exists: one list, read by the guard and by the type, so the schemes this admits cannot come
     * apart from the schemes the broker's signature takes.
     *
     * `connected` IS THE LITERAL `true` BECAUSE THERE IS NO OTHER WAY OUT OF HERE. Unlike {@link
     * confirmBrokeredConnection}, which asks a question the vendor may answer no to, this performs
     * an act: it either made the connection or it threw. A `boolean` would invite a caller to
     * branch on a `false` this method cannot produce.
     *
     * `probe` IS RETURNED BESIDE `verified` BECAUSE THE FLAG ALONE NOW MEANS THREE DIFFERENT THINGS,
     * AND THE BROWSER READS THIS FIELD TO CHOOSE ITS SENTENCE. While the row was written `false`
     * unconditionally the flag had one meaning — nobody has checked — and a screen could say so from
     * the flag alone. With a probe that can fail there are three states, and two of them share the
     * flag:
     *
     *   null probe, `verified: false`   — nothing was tried, so nothing is known about the key.
     *                                     Either this app publishes nothing safe to call, or the
     *                                     check could not be made — Composio unreachable, or an
     *                                     answer this deployment could not read. "It was accepted
     *                                     without being checked" is true of both, which is why
     *                                     they share the state; `checkable` on the listing is what
     *                                     tells the person whether pressing Re-check can ever help,
     *                                     and the trail carries the outage under `unreachable`.
     *   named probe, `verified: true`   — the action ran in this person's account and answered.
     *   named probe, `verified: false`  — it ran, the vendor said no, and the account could not be
     *                                     withdrawn. The key is BAD and the row exists anyway.
     *
     * That last one is the worst state this feature has, and under the old wording a person in it
     * would be told their key was never checked — when it was checked, the vendor rejected it, and
     * this deployment failed to undo the account it made. INFERRING THE STATE CLIENT-SIDE FROM
     * `verified` IS EXACTLY WHAT THIS FIELD EXISTS TO PREVENT: there is nothing in the flag that
     * separates "nothing to try" from "tried and failed", so a browser deriving a sentence from it
     * would tell one of those two people the opposite of what happened. The audit row carries the
     * same distinction under `action`, for a reader of the trail rather than of the screen.
     */
    async connectBrokeredWithFields(input: {
      toolkit: string;
      userId: string;
      values: Record<string, string>;
    }): Promise<{ connected: true; verified: boolean; probe: string | null }> {
      // First, and for `confirmBrokeredConnection`'s reason: a deployment with no key has nobody to
      // connect anybody at, and the refusal must happen before the values are touched at all.
      if (!broker) throw new BrokerUnconfiguredError();

      // Keyed on the url and on the one row that answers for it — see `brokeredAppScheme`. It is
      // the same reasoning the connection gate in `connectionTokenFor` is keyed on, and for the
      // sharper version of the same stake: a row called `gmail` at `composio://slack` would have
      // somebody's Slack key attached to a scheme read off Gmail's row.
      /**
       * WHAT THIS CONNECT ANSWERS FOR EACH KIND OF APP, AND FOR EACH OUTCOME OF ITS OWN CHECK.
       *
       * Type-only and erased; see {@link Decides}. Two vocabularies meet in this one method — the
       * scheme decides whether it will run at all, and {@link BrokeredProbe} decides what the run
       * leaves behind — and each is read here by an equality test that a new member would sail
       * past. `isFieldScheme` is asked rather than {@link schemeKind}, so the two answers that are
       * not `key` reach one refusal by elimination; the roster is what says so out loud.
       */
      type _ConnectWithFieldsDecides = Decides<
        SchemeKind,
        {
          key: "connects, then checks the key it was just handed";
          consent: "refuses — not an app this deployment connects with values somebody types";
          none: "the same refusal — an app that needs no credential has nowhere to put one";
          unreadable: "the same refusal, reached by elimination rather than by decision";
        }
      >;
      type _ConnectWithFieldsRecords = Decides<
        BrokeredProbe["outcome"],
        {
          nothing: "the account stands, recorded unchecked with a null probe";
          answered: "the account stands, recorded verified under the probe's name";
          complained: "the account stands, recorded unchecked under the probe's name, and the press reports what the app said";
          unreachable: "the account stands, recorded unchecked, with the attempt on the trail";
        }
      >;
      const authScheme = await brokeredAppScheme(input.toolkit);
      if (!isFieldScheme(authScheme)) {
        throw new BrokerRefusalError(
          `${input.toolkit} is not an app this deployment connects with values somebody types, so nothing was sent. Open the app on the Plugins page and connect it the way it asks for; if it is not listed there at all, an administrator has to enable it first.`,
        );
      }

      const { accountId } = await broker.connectWithFields({
        userId: input.userId,
        toolkit: input.toolkit,
        authScheme,
        values: input.values,
      });

      /*
       * THE CHECK, WHICH IS THE SAME ONE A RE-CHECK MAKES AND IS SPELLED ONCE FOR THAT REASON.
       *
       * {@link probeBrokeredConnection} chooses the action out of what the app published — with the
       * version the listing recorded for it, which is part of what makes it choosable — calls it
       * with no arguments and reads what came back.
       * What belongs to THIS path and to no other is what happens next: an account this call has
       * just made, which a key the vendor rejects must not be allowed to leave standing. A re-check
       * runs the identical probe against an account that already existed and leaves it alone, and
       * those two undo behaviours are exactly why the shared part stops where it does.
       *
       * `probe: null` IS THE FIRST OF THE THREE STATES THIS METHOD REPORTS — the app published
       * nothing safe to call, or nothing at a version this deployment recorded, so the key was
       * never tried. It is an ordinary answer and not a failure; see that method.
       */
      const probed = await this.probeBrokeredConnection({
        toolkit: input.toolkit,
        userId: input.userId,
        /*
         * THE ACCOUNT THIS CALL JUST MADE, which is the only account this check is about. A person
         * and an app do not name one: Composio takes an account per key, somebody may hold several
         * for one app, and the vendor picks which a call runs in. So an unpinned probe verified a
         * key that does not work against the person's OTHER account — writing `verified` on the
         * strength of a call the new key never touched — and, the same defect pointing the other
         * way, condemned a perfectly good key and deleted the account it had just made because
         * some older account of theirs was broken. The undo below has always been keyed on this id;
         * this is what makes the check about the same account as the withdrawal.
         */
        accountId,
      });

      // Read before the write, for `confirmBrokeredConnection`'s reason: the record below is an
      // upsert, so it leaves nothing behind that tells a first key from a replacement, and whether
      // a row was already here is the whole of what `reconnected` says. The route that reaches
      // this today refuses a second account for the same app, which makes a constant `false`
      // accidentally true — but the guard lives in another file and this method is callable
      // without it, so the trail would be claiming, on that guard's word, something it never
      // checked.
      const existing = await this.brokeredConnection({
        toolkit: input.toolkit,
        userId: input.userId,
      });

      /*
       * THE CONNECT IS ON THE TRAIL BEFORE THE OUTCOME IS READ, AND THAT IS WHAT MOVING IT BUYS.
       *
       * The account exists by this line — `connectWithFields` above either made it or threw — and
       * from here the method has four ways out, one of which is the throw in the branch below.
       * Filed after that branch, this row was written on three of the four: a `complained` check
       * left a live account at Composio, a `composio_connections` row, and an
       * `mcp.connection_verified` row saying a check did not come back clean, with NOTHING saying
       * the account had ever been connected. `complained` is the ordinary outcome of a rate limit
       * or of one refused scope rather than an exotic one, so the trail lost the connect on the
       * path most likely to be walked — and the `mcp.account_disconnected` row filed when that
       * person later presses Disconnect had no counterpart to pair against.
       *
       * ABOVE `recordBrokeredConnection` RATHER THAN BELOW IT, because what this row asserts is
       * that the ACCOUNT was made, which the broker call above has already established, and not
       * that this deployment finished writing its own row about it. The two arms below disagree
       * about what that row says and agree about this.
       */
      await recordAuditEvent(auditStore, {
        eventType: "mcp.account_connected",
        targetType: "mcp_server",
        // The app, the same id `confirmBrokeredConnection` and `retireConnectionsFor` file under,
        // so one query answers what happened to one person's access to one app however it began
        // and however it ended.
        targetId: input.toolkit,
        payload: {
          actor: input.userId,
          server: input.toolkit,
          /*
           * EMPTY, AND PRESENT, which is the whole of what this field does on a brokered row.
           *
           * All three writers of `mcp.account_connected` now agree on the key. {@link
           * recordConnection} carries what a vendor granted a `user-oauth` grant, and both brokered
           * writers carry `""` — a brokered connection has no scopes at all, because Composio holds
           * the grant and never tells this deployment what it covers.
           *
           * WRITING NOTHING IS NOT THE SAME AS WRITING THAT. This one wrote no key, so the same app
           * connected by two people came back as `''` from {@link confirmBrokeredConnection} and as
           * NULL from here, in a table whose entire purpose is being queried — and with nothing in
           * either row saying which writer made it, a reader cannot tell an absent scope from an
           * empty one, or either from a row written before the field existed.
           */
          scope: "",
          reconnected: existing !== null,
          /*
           * THE NAMES AND NEVER THE VALUES. What a reader of the trail needs is which app somebody
           * connected and what it asked them for; the values are the credential itself, and an
           * audit row is exactly the kind of long-lived, widely-readable record they must never
           * reach.
           */
          fields: Object.keys(input.values).sort(),
        },
      });

      if (probed.outcome === "complained") {
        /*
         * THE ACCOUNT THIS CALL MADE IS LEFT STANDING, AND THAT REVERSES WHAT THIS BRANCH USED TO DO.
         *
         * It read the outcome as "the vendor refused the key" and acted on it: `revokeAccount` on
         * the id just created, then a refusal telling the person what they entered did not work.
         * The premise was that nothing should be left behind on a key that does not work — which is
         * a good rule for the fact it names and was being applied to a fact nobody had established.
         * A complaint is Composio saying the CALL failed, out of an envelope with no status and no
         * error code in it (see {@link BrokeredProbe}), so a 429 on the identity read, a scope this
         * one action wants, or a 404 for a resource it names all arrived here as "your key is wrong"
         * and destroyed a connection that had just been made correctly.
         *
         * THE TWO MISTAKES DO NOT COST THE SAME, WHICH IS WHAT SETTLES IT. Keeping the account of a
         * genuinely bad key leaves a live row at Composio that can do nothing, that every screen
         * here draws as unverified with the app's own words beside it, and that Disconnect ends in
         * one press. Deleting the account of a good key costs the person the key itself: it is gone
         * from Composio, it was never stored here, and getting back is fetching it from the vendor
         * and typing it again. One is a press, the other is an errand — so the recoverable mistake
         * is the one this branch is willing to make.
         *
         * SO THE STATE THIS WRITES IS THE ONE THE `probe` FIELD WAS ADDED FOR, reached now by the
         * ordinary path rather than only by a failed undo: the row exists, it is unverified, it
         * names the action the check was spent on, and the sentence carries what the app said. What
         * it no longer carries is a verdict about the credential, here or on any screen that draws
         * it.
         */
        await this.recordBrokeredConnection({
          toolkit: input.toolkit,
          userId: input.userId,
          verified: false,
          // THE ACTION THAT WAS TRIED, which is the half of this state the flag cannot hold. It is
          // the whole of what separates this row on a later page load from a key nobody ever tried,
          // and it is the same name the audit row below carries under `action`, for a reader of the
          // trail rather than of a screen.
          probeAction: probed.probe,
        });

        /*
         * AND THE TRAIL SAYS SO TOO, WHICH IS THE HALF THE SENTENCE BELOW CANNOT REACH. The refusal
         * is told to one person in one moment; what outlives it is an unverified row and a live
         * account at the vendor, and the person who most needs to know both exist is an operator
         * reading this trail a week later. Filed BEFORE the throw for the only reason that matters
         * here: every way out of this branch is that throw, so a row written after it is a row
         * never written.
         *
         * `action` IS THE PROBE THAT WAS TRIED, and it is what tells this row from the unchecked
         * one. Both say `verified: false`; only the name separates "this app published nothing safe
         * to call" from "it ran and the app answered with a failure".
         */
        await recordAuditEvent(auditStore, {
          eventType: "mcp.connection_verified",
          targetType: "mcp_server",
          targetId: input.toolkit,
          payload: {
            actor: input.userId,
            action: probed.probe,
            verified: false,
          },
        });

        /*
         * AND THE SENTENCE REPORTS RATHER THAN ACCUSES. It said "what you entered did not work",
         * which is the one thing this branch cannot know. What it can say is all true: a check was
         * spent, here is what the app answered, the account is still there, and here are the two
         * presses that end it either way.
         */
        throw new PluginRefusedError(
          `${input.toolkit} was connected, and the check this deployment then ran against it did not come back clean: ${probed.sentence} That may be the key, and it may be the app — what came back does not say which — so the account is left standing and recorded as unchecked. Re-check it on the Plugins page once, and if it still will not answer, disconnect it and connect it again with a fresh key.`,
          null,
        );
      }

      /*
       * ONE OUTCOME EARNS THE FLAG AND THE OTHER TWO REACHING HERE DO NOT, which is the whole of
       * what is decided below. A probe that ran and answered is evidence the key works, exactly as
       * the vendor's yes at the end of a consent screen is evidence for {@link
       * confirmBrokeredConnection}. An app that published nothing safe to call is the honest
       * unchecked state {@link composioConnections.verified} documents. And a vendor that could
       * not be reached is the SAME unchecked state, arrived at a different way — which is the one
       * thing a reader of this branch has to take away, so it is written out rather than left to
       * the union.
       *
       * AN OUTAGE IS AN ABSENCE OF EVIDENCE AND THE ROW HAS A STATE FOR THAT. It is not a fourth
       * thing to store: `probe_action` records the action a check SPENT, and a call that reached
       * nobody spent none, so null beside `verified: false` says exactly what is true — this key
       * has not been checked. What it must never become is the other `verified: false`, the one
       * with a name beside it, because that pair is the accusation "it ran and the vendor refused
       * your key" and the settings page draws it as such. {@link BrokeredProbe} withholds the name
       * from this outcome so the writer below cannot record it even by accident.
       *
       * AND THE ACCOUNT STAYS, which is the half the person would not get back. The undo above is
       * for a key the vendor REFUSED; a key nobody could ask about is very probably fine, and
       * deleting somebody's account because Composio was down destroys the thing they just made to
       * tell them something that was never established. The Re-check button is what settles it
       * afterwards — the app publishes an action, so the settings page offers one — and this is why
       * the connect answers rather than refusing: nothing went wrong with what they typed.
       *
       * Written through the single writer below rather than spelled here, so this path and the
       * confirm path cannot drift into two row shapes — `verified_at` follows from the flag there
       * and is not passed in.
       */
      const probe = probed.probe;
      const verified = probed.outcome === "answered";

      await this.recordBrokeredConnection({
        toolkit: input.toolkit,
        userId: input.userId,
        verified,
        // What was spent, which is the name on a probe that ran and the null that IS the first of
        // the three states: this app published nothing safe to try the key on. `verified` is
        // derived from this same value a few lines above, so the row cannot claim a check with an
        // action beside a flag that says nothing checked it, or the other way about.
        probeAction: probe,
      });

      /*
       * THE CHECK ITSELF, ON THE TRAIL, WHETHER OR NOT ONE HAPPENED.
       *
       * Filed on every connection rather than only where a probe ran, because "this app published
       * nothing safe to call, so the key was never tried" is the fact a reader most needs and the
       * one nothing else records. `action` is the null the response field is: it separates an
       * unchecked connection from a checked one, which `verified: false` alone cannot.
       *
       * THE FAILED UNDO ABOVE FILES THE SAME ROW BEFORE IT THROWS, so the worst state this feature
       * has — a live account, an unverified row, and a withdrawal the vendor refused — is no longer
       * named only in a sentence one person read once. The clean undo files nothing, and the reason
       * is written out at that branch: this trail records state that persists, and a row there
       * would cost the failed-undo row the one meaning that makes it worth reading.
       *
       * UNDER THE APP SLUG, which is the id `mcp.account_connected` above, {@link
       * confirmBrokeredConnection}, {@link disconnectBrokered} and {@link retireConnectionsFor} all
       * file under — so the two rows this method can write about one person's access to one app
       * come back in ONE query, however that access began and however it ended. This row was filed
       * under the SERVER row's id instead, on the reasoning that it is about an ACTION of a server
       * rather than about access; that is true and it cost the reader the only question anybody
       * asks this trail, which was answered half by one id and half by the other. Nothing goes with
       * the change: the server id is `composio-` and the slug, and the action is in the payload.
       *
       * AND THE OUTAGE IS NAMED HERE BECAUSE THE ROW CANNOT NAME IT. Two different things leave
       * this method with a null `action` — an app that publishes nothing safe to call, and a check
       * that could not be made — and on `composio_connections` they are one state, correctly: both
       * mean the key is unchecked, and neither says anything about the key. A reader of the TRAIL
       * is asking a different question, "was a check attempted and what became of it", and
       * `unreachable` is the whole of the difference, in Composio's own words. Present only on the
       * outage, so its absence is as informative as its value.
       *
       * AND CAPPED WHERE EVERY OTHER QUOTED FOREIGN STRING IN THIS FILE IS CAPPED, which this one
       * alone was not. `passableSentence` decides whether a candidate is worth repeating and says
       * nothing whatever about length; `askAction` then caps at `MAX_RESULT_CHARS`, which is 20_000
       * and is a bound written for a model's context window rather than for a row. So the sentence
       * arriving here can be fifty times what `refreshTools`' two `lastError` writes, the failed
       * undo's own reason a hundred lines up, and `callTool`'s two `failure` fields each allow
       * themselves — and `@composio/client` builds an `APIError` message out of an entire response
       * body, so a multi-kilobyte one is the ordinary arrival and not a contrived one.
       *
       * WHY THIS ROW AND NOT ANOTHER. `audit_events` is append-only by trigger, it is exported, and
       * it is kept for the deployment's whole retention window: a `lastError` written too long is
       * overwritten by the next refresh, and this is not. Whatever lands here cannot be cleaned up
       * afterwards, which makes the one uncapped write in the file the one that could least afford
       * to be.
       */
      await recordAuditEvent(auditStore, {
        eventType: "mcp.connection_verified",
        targetType: "mcp_server",
        targetId: input.toolkit,
        payload: {
          actor: input.userId,
          action: probe,
          verified,
          ...(probed.outcome === "unreachable"
            ? { unreachable: probed.sentence.slice(0, 400) }
            : {}),
        },
      });

      return { connected: true, verified, probe };
    },

    /**
     * Try a key this deployment already holds, because somebody pressed the button that asks.
     *
     * A BUTTON, AND NEVER A PAGE-LOAD EFFECT. Composio never re-checks a key: it accepts one when it
     * is typed and says nothing about it again, so a row that was verified in March goes on saying
     * so after the key behind it was rotated, revoked or let expire. Nothing but this can correct
     * that — which is exactly the argument somebody will use for calling it from an effect when the
     * settings page mounts, and it is the wrong conclusion. The call this makes is spent against the
     * PERSON'S OWN rate limit at the vendor, on their account, so verifying on every render would
     * burn somebody's quota at Linear to redraw one word on a page they were only passing through.
     * {@link confirmBrokeredConnection} is the one that runs on mount, and it asks Composio a
     * question about its own records; this one goes out to the app.
     *
     * A RE-CHECK IS NOT A CONNECT, AND THE DIFFERENCE IS THE WHOLE METHOD. It runs against an
     * account that already exists: it must not create one, it must not withdraw one when the probe
     * fails — the person's account stays, it is their KEY that is wrong — and it must change
     * nothing here but the verification and its timestamp. {@link connectBrokeredWithFields} does
     * undo its account on a bad key, and it is right to: the account is a thing it had just made,
     * seconds earlier, for a key that turned out not to work. Here the account predates the press by
     * days, the person asked to have it CHECKED, and taking it away to tell them their key is wrong
     * would destroy the thing they are trying to repair. The shared probe stops short of both
     * behaviours for that reason.
     *
     * A PROBE THAT RAN AND FAILED RAISES, AND DOES NOT COME BACK AS `verified: false`. Those two
     * answers are not different spellings of one outcome. `false` is also what an app that publishes
     * nothing safe to call produces, and a row handed the flag alone cannot tell "the vendor
     * rejected your key" from "there was nothing here to try" — so it would draw the unchecked
     * sentence, and drop the Re-check button, for the one person who most needs it: somebody who has
     * just fixed their key and pressed it. The refusal carries Composio's own sentence, which is the
     * whole of what they can act on. The ONLY legitimate `verified: false` from here is the one that
     * arrives with `probe: null` saying there was nothing to check with.
     *
     * NOTHING TO PROBE WRITES NOTHING AT ALL, and answers with the row as it stands. A check that
     * could try nothing has learned nothing, and writing `false` on that would take the date off a
     * connection verified at a consent screen — a fact nothing else in this deployment records,
     * erased by a button that claims to check one. So the answer is what the row says after the
     * press, and `probe` is what says whether the press was able to try anything.
     *
     * THE ROW IS READ BEFORE THE VENDOR IS CALLED, and its absence is a refusal. The writer below is
     * an upsert, so a re-check that probed first and recorded the answer would INSERT a connection
     * for somebody who has none — the row that is the whole of the gate every later brokered call
     * passes through, created by a button that only asks a question. The probe itself would be spent
     * on an account the vendor does not hold, and would come back "no connected account found": this
     * deployment's own state, shown to somebody as though their key had been rejected.
     *
     * NO BROKER IS REFUSED BEFORE ANY OF IT, though nothing here calls the broker. The broker and the
     * transport are built from the same key, so a deployment without one has neither — and the probe
     * would come back as the transport's "Composio is not configured for this deployment", which
     * this method would otherwise report as the vendor rejecting a perfectly good key, and would
     * write the row unverified on the strength of it.
     *
     * AND A CONNECTION WITH NO KEY BEHIND IT IS REFUSED HERE RATHER THAN IN THE BROWSER. There is
     * nothing to re-check on a consent connection: the person authenticated at the vendor's own
     * screen, this deployment holds no credential of theirs, and the row's `verified_at` is the
     * date that screen earned — a fact nothing else here records. A probe spent on it would be a
     * call against their account that this method then reads as evidence about a key that does not
     * exist, and the likely failure would write `verified: false` with a null timestamp: a button
     * that claims to CHECK a connection, destroying the only record that one was ever checked. That
     * is precisely what the nothing-to-probe branch above is written to protect, and an app that
     * happens to publish a safe action walks straight past it. The screen does not offer the button
     * for a consent app, but a route takes POSTs and not only button presses, so the refusal
     * belongs where {@link connectBrokeredWithFields} puts its own: on the SCHEME RECORDED ON THE
     * APP'S ROW, asked through {@link isFieldScheme} so the schemes this admits cannot drift from
     * the schemes that have a key to admit.
     */
    async recheckBrokeredConnection(input: {
      toolkit: string;
      userId: string;
    }): Promise<{
      verified: boolean;
      verifiedAt: string | null;
      probe: string | null;
    }> {
      if (!broker) throw new BrokerUnconfiguredError();

      // Keyed on the url and on the one row that answers for it — see `brokeredAppKind`. It is the
      // read `connectBrokeredWithFields`, `confirmBrokeredConnection` and `disconnectBrokered` all
      // make, for the same stake: a row called `gmail` at `composio://slack` would decide a Slack
      // re-check on Gmail's scheme. Anything but a key refuses, a scheme nothing here can read
      // included — there is no key recorded to re-check, and the sentence below is the same one
      // either way.
      /**
       * WHAT THIS RE-CHECK ANSWERS FOR EACH KIND OF APP, AND FOR EACH OUTCOME OF THE CHECK.
       *
       * Type-only and erased; see {@link Decides}. `!== "key"` is a boolean read of a three-member
       * vocabulary: it happens to fail closed for both of the other two today, which is why nothing
       * has gone wrong here yet and also why a fourth member would inherit that answer without
       * anybody choosing it. The probe roster below is the vocabulary this method reads FOUR ways,
       * and it is the one that has already been added to once.
       */
      type _RecheckDecides = Decides<
        SchemeKind,
        {
          key: "spends a call against the key this deployment holds";
          consent: "refuses — there is no key here to re-check";
          none: "the same refusal — there is no account, let alone a key, to check";
          unreadable: "the same refusal, which is the closed direction";
        }
      >;
      type _RecheckRecords = Decides<
        BrokeredProbe["outcome"],
        {
          nothing: "writes nothing and files nothing; answers the held row beside a null probe";
          answered: "records verified under the probe's name, and files the check";
          complained: "records unchecked under the probe's name, files the check, then reports what the app said";
          unreachable: "writes nothing and files nothing; refuses with Composio's own sentence";
        }
      >;
      if ((await brokeredAppKind(input.toolkit)) !== "key") {
        throw new PluginRefusedError(
          `${input.toolkit} is not an app this deployment holds a key for, so there is nothing here to re-check. It was connected at ${input.toolkit}'s own sign-in screen, and if it has stopped working, disconnecting it on the Plugins page and connecting it again is what fixes it.`,
          null,
        );
      }

      const [held] = await database
        .select({
          verified: composioConnections.verified,
          verifiedAt: composioConnections.verifiedAt,
        })
        .from(composioConnections)
        .where(
          and(
            eq(composioConnections.toolkit, input.toolkit),
            eq(composioConnections.userId, input.userId),
          ),
        )
        .limit(1);

      if (!held) {
        throw new PluginRefusedError(
          `You have no connection to ${input.toolkit} here, so there is nothing to re-check. Connect it on the Plugins page and it will be checked as it is made.`,
          null,
        );
      }

      const probed = await this.probeBrokeredConnection(input);

      /*
       * THE VENDOR WAS NOT REACHED, SO THE RECORD OF THE LAST CHECK IS LEFT EXACTLY WHERE IT IS.
       *
       * This is the branch the whole four-state reading exists for on this path. A failed probe
       * used to mean one thing here — "the vendor rejected the key it is holding" — so an outage,
       * a socket that closed, or a `@composio/core` that could not parse an answer cleared
       * `verified`, dropped `verified_at` (the only record anywhere that this connection was ever
       * checked, and the date the page prints) and wrote the named probe beside the `false`, which
       * is the accusation. Every person who pressed the button while Composio was down was told
       * their key had been refused, over a row that had been verified minutes earlier.
       *
       * NOTHING IS WRITTEN, WHICH IS STRONGER THAN WRITING SOMETHING HONEST. A press that learned
       * nothing may not move a record: there is no state for "we could not ask" on the row, and
       * there should not be — the row says what is known about the key, and an outage changes
       * nothing about that. It is the same restraint as the nothing-to-probe branch below, and
       * nothing is filed on the trail for the same reason it gives.
       *
       * AND IT RAISES RATHER THAN ANSWERING, which is where it parts from that branch. Somebody
       * pressed a button and is owed the truth about what happened to their press: the check did
       * not happen, and here is Composio's own sentence about why. Answering with the held row
       * instead would report the state as though the press had confirmed it.
       */
      if (probed.outcome === "unreachable") {
        throw new PluginRefusedError(
          `${input.toolkit} could not be checked just now: ${probed.sentence} Nothing here changed — your connection is still recorded exactly as the last check left it — so pressing Re-check again when Composio is answering is the whole of the retry.`,
          null,
        );
      }

      /*
       * NOTHING WAS TRIED, SO NOTHING IS WRITTEN AND NOTHING IS FILED. The row keeps whatever it
       * held — a consent verification and its date, or the honest unchecked pair — and the answer
       * reports that state beside the null probe that says why this press could not improve on it.
       * `mcp.connection_verified` records an account exercised with a REAL CALL; a row filed here
       * would make the one event that means "a key was tried" also mean "somebody pressed a button".
       */
      if (probed.outcome === "nothing") {
        return {
          verified: held.verified,
          verifiedAt: iso(held.verifiedAt),
          probe: null,
        };
      }

      // What the press spent, which from here on is a name: both outcomes left are a call that ran
      // and a vendor that answered about it.
      const probe = probed.probe;

      /*
       * THE ANSWER IS WRITTEN FOR BOTH OUTCOMES, and through the single writer for its reason: the
       * flag and its timestamp are one set, and a second hand spelling that set is how one of them
       * comes to leave a date standing on a claim nobody is making any more. A key the vendor has
       * just rejected stops being verified HERE — that is the state this button exists to correct,
       * in the direction nothing else in the product can move it.
       */
      const verified = probed.outcome === "answered";
      const { verifiedAt, wrote } = await this.recordBrokeredConnection({
        toolkit: input.toolkit,
        userId: input.userId,
        verified,
        // The action this press spent. Never null on this path: the nothing-to-probe branch above
        // returns before reaching the writer, precisely so that a check which could try nothing
        // writes nothing at all.
        probeAction: probe,
        /*
         * AND IT MAY NOT CREATE THE CONNECTION IT IS RECORDING A CHECK OF. The read at the top of
         * this method refuses a person with no row, deliberately, because this writer is an upsert —
         * but that read and this write straddle the vendor call above, which is live and takes
         * seconds. A Disconnect landing in that window revoked the grant at Composio and deleted the
         * row, and this upsert then put the row back: `composio_connections` is the whole of the
         * permission a brokered call is decided on, so the re-insert restored access to an account
         * the person had just ended, and drew the app as connected again.
         */
        only: "a row that is still there",
      });

      /*
       * THE ROW WENT WHILE COMPOSIO WAS BEING ASKED, SO NOTHING IS RECORDED AND NOTHING IS FILED.
       *
       * The two ways here are a Disconnect in another tab and a concurrent confirm that Composio
       * answered `false` for and which deleted the row. Both are somebody or something ENDING this
       * connection, and a verification row filed afterwards would be the trail recording a check of
       * an account that no longer exists — beside `mcp.account_disconnected` for the same app, in
       * whichever order the two happened to land.
       *
       * AND IT SAYS SO RATHER THAN ANSWERING QUIETLY, for the reason the outage branch above does:
       * somebody pressed a button and is owed the truth about their press. The answer is not the
       * probe's verdict, because the thing it was a verdict about is gone.
       */
      if (!wrote) {
        throw new PluginRefusedError(
          `Your connection to ${input.toolkit} was disconnected while this check was still running, so nothing was recorded about it: what the check found is about an account you no longer have here. Connect ${input.toolkit} again on the Plugins page if that was not what you meant.`,
          null,
        );
      }

      /*
       * AND THE TRAIL CARRIES THE CHECK, whichever way it went, filed BEFORE the refusal below for
       * the reason the connect path files its own row before its throw: every way out of a failure
       * is that throw, so a row written after it is a row never written. `action` is the probe that
       * ran, which is what separates this from a connection nothing was ever tried on.
       *
       * FILED UNDER THE APP'S BARE SLUG, as every row in this family is — the same id
       * `confirmBrokeredConnection`, `connectBrokeredWithFields` and `retireConnectionsFor` file
       * under — so one query still answers what happened to one person's access to one app.
       *
       * THE ROW NAMES A PERSON AND NO BOT, because none ran: this is somebody checking their own
       * account. See `mcp.connection_verified` in `./audit`, whose safety argument names a person
       * re-checking their own connection as one of the two callers this call may ever have.
       */
      await recordAuditEvent(auditStore, {
        eventType: "mcp.connection_verified",
        targetType: "mcp_server",
        targetId: input.toolkit,
        payload: {
          actor: input.userId,
          action: probe,
          verified,
        },
      });

      if (probed.outcome === "complained") {
        /*
         * THE APP'S OWN SENTENCE, AND THE TWO FACTS AROUND IT: the row here now says unchecked, and
         * their account was left exactly as it was. The second half is what makes the retry one step
         * rather than three — there is nothing to disconnect and nothing to reconnect, only this
         * button to press again once whatever the sentence names has passed.
         *
         * AND IT REPORTS WHAT CAME BACK RATHER THAN RULING ON THE KEY. This said "would not answer
         * with the key it is holding", which reads as the vendor having rejected the credential —
         * and the envelope the outcome is decided from carries no status and no error code, so a
         * rate limit and a bad key are the same answer here. See {@link BrokeredProbe}. Moving the
         * row to unchecked is still right and is still the thing this button exists to do: whatever
         * the failure was, the check did not come back clean, so a standing `verified: true` is no
         * longer supported and must not keep standing.
         */
        throw new PluginRefusedError(
          `The check this deployment ran against ${input.toolkit} did not come back clean: ${probed.sentence} That may be the key and it may be the app — what came back does not say which — so your connection here is recorded as unchecked until a check does come back clean. Nothing was disconnected: press Re-check again in a few minutes, and fix the key at ${input.toolkit} if it keeps answering the same way.`,
          null,
        );
      }

      return { verified: true, verifiedAt: iso(verifiedAt), probe };
    },

    /**
     * End this person's brokered account at the vendor, and then forget where it was.
     *
     * REVOKE BEFORE DELETE, AND THAT ORDER IS THE WHOLE METHOD. The row is the only thing in this
     * deployment that says which app this person connected: the app is read off
     * `composio_connections`, and a revoke needs it. Delete first and a revoke that then fails
     * leaves a live grant on somebody's mailbox that no operation here can reach, because the one
     * value it would have to be revoked under is gone. The other order costs nothing by
     * comparison — a revoke that throws leaves the row standing, the person presses disconnect
     * again, and the second attempt has everything the first one had.
     *
     * WHICH ALSO MEANS THE FAILURE IS LOUD. Nothing is caught here: a broker that will not answer
     * ends this call, and no row and no trail entry claims an account was disconnected when the
     * account is still live.
     *
     * `vendorRevocationRequested` IS WHAT WAS ASKED FOR, NOT THAT A CALL WAS MADE — {@link
     * ComposioBroker.revoke}'s own answer, passed through. True where an account was found and its
     * withdrawal asked for, false where there was none to withdraw, and the value of the field is
     * exactly that a reader can tell an account this deployment acted on from one that outlives it
     * somewhere else.
     *
     * IT SAYS "REQUESTED" BECAUSE THE VENDOR'S ANSWER SUPPORTS NOTHING STRONGER, and the field was
     * renamed from `vendorRevoked` when that turned out to be false in the plainest way: the
     * adapter behind it was soft-deleting the account and asking for no upstream revocation at all,
     * so every row saying a grant had been withdrawn described one still live at Google. The ask is
     * now made; what a broker can promise synchronously is that the account is gone at Composio and
     * that the provider has been asked, because the withdrawal itself runs as a background job with
     * no supported way to poll it.
     *
     * EXCEPT WHERE THE APP IS ONE SOMEBODY TYPED A KEY INTO, AND THERE IT IS FALSE BY CONSTRUCTION
     * RATHER THAN BY WHAT THE VENDOR FOUND. `revoke_on_delete` asks the PROVIDER to end a grant,
     * which is a real request for a consent account — Google or Slack acts on it — and a
     * meaningless one for an API key. There is no grant behind a key to withdraw: the value is
     * still valid at the app and still works for anyone holding it, so the account ends at Composio
     * and nothing was asked of anybody else. Saying otherwise would be the one row in this trail
     * nobody could rely on, which is the failure the paragraph above describes arriving a second
     * time by a different road — a withdrawal recorded for something that was never granted. So the
     * scheme recorded on the app's row decides this field for a field connection, and the broker's
     * own answer decides it for every other.
     *
     * THE SCHEME IS THE ONE ON THE APP'S ROW, for {@link connectBrokeredWithFields}' reason: it is
     * what this deployment's authorization config was created AS and what the account was attached
     * to, and a fresh read of the catalogue is a second answer — a key connection described as
     * consent because the vendor has since started publishing managed OAuth for the app. The
     * person's half of this fact is already written on the disconnect row they are shown: their key
     * still works at the app, and rotating it there is what ends it. This is the trail's half of
     * the same sentence.
     *
     * THE VENDOR IS ASKED WHETHER OR NOT A ROW IS HERE. The row is a cache of Composio's answer
     * and never the account itself (see {@link brokeredConnection}), so its absence is not
     * evidence that the grant is gone: the confirm above deletes it on any `false` from the
     * vendor, and a person whose row was cleared that way can still be holding a live account at
     * Composio with nothing left here pointing at it. Asking anyway is the only operation in this
     * deployment that can end such a grant, and it costs nothing where there is genuinely nothing
     * to withdraw — the broker answers `false` and says so. Skipping the revoke for want of a
     * local row would make the safe half of disconnect unreachable for exactly the person who
     * needs it, on the strength of a cache we already know drifts.
     *
     * BUT THE TRAIL RECORDS ONLY A DISCONNECT THAT HAPPENED. The event is filed where something
     * actually ended — a row deleted here, or a grant withdrawn at the vendor — and not otherwise.
     * A call that found no row and withdrew no grant disconnected nothing, and an
     * `mcp.account_disconnected` row for it tells whoever reads the trail that somebody's account
     * ended at a moment when nobody's did. It is the criterion
     * {@link confirmBrokeredConnection} files its own event under, one act the other way round:
     * the trail records acts, and a call that changed nothing performed none.
     *
     * WHICH IS NOT THE SAME QUESTION AS `vendorRevocationRequested`. A row here with no grant at
     * the vendor is a disconnect — the gate this deployment decides every brokered call on was
     * open, and this call closed it — so the event is filed, saying
     * `vendorRevocationRequested: false`. A grant at the vendor
     * with no row here is a disconnect too, and the weightier of the two, because somebody's live
     * account was ended; the event is filed for that as well. Only where both are absent is there
     * no act to record, and the two cases stay legible in the trail because the field still says
     * which of them happened.
     *
     * SO THE FILING IS DECIDED ON THE BROKER'S OWN ANSWER AND NOT ON THE FIELD, because for a field
     * connection the two part company on purpose. A key account the vendor found and ended with no
     * row here is an act — somebody's live connection stopped existing — and gating the event on a
     * value that is false by construction would leave exactly that act unrecorded. The field
     * answers what was asked of the provider; `ended` answers whether anything was there.
     */
    async disconnectBrokered(input: {
      toolkit: string;
      userId: string;
      by: string;
      /**
       * Why the account ended, which is the closed pair and not free text. A brokered account ends
       * in exactly two ways — the person disconnecting their own, and the person being removed
       * from the People screen, which is the word {@link retireConnectionsFor} already files its
       * own rows under. A reader asking the trail which of the two happened can be answered only
       * if it is the same word every time, so the type is the pair rather than whatever sentence a
       * caller happened to spell.
       */
      reason: "self" | "person_removed";
    }): Promise<{ vendorRevocationRequested: boolean }> {
      if (!broker) throw new BrokerUnconfiguredError();

      /*
       * Keyed on the url and on the one row that answers for it — see {@link brokeredAppKind}.
       * It is the read {@link connectBrokeredWithFields} makes, for the same stake: a row called
       * `gmail` at `composio://slack` would have this disconnect reading Gmail's scheme to describe
       * what happened to a Slack account.
       *
       * AN APP WITH NO ROW HERE IS NOT A FIELD APP, AND NEITHER IS ONE WHOSE SCHEME CANNOT BE READ.
       * A person can hold an account at Composio for an app this deployment has since removed — the
       * row is a cache and the removal takes no grant with it — and the revoke below is the one
       * operation that can still end it. Nothing names the scheme it was connected under any more,
       * so the honest reading is the broker's own answer, which is what both of those fall through
       * to: the field below is a claim that this deployment asked the vendor to withdraw something,
       * and an app it cannot say holds a key is one whose withdrawal it has to report as asked.
       */
      /**
       * WHAT THIS DISCONNECT CLAIMS ON THE TRAIL FOR EACH KIND OF APP.
       *
       * Type-only and erased; see {@link Decides}. `=== "key"` collapses three answers into two,
       * and the collapse is deliberate here rather than accidental: the field below is a claim that
       * this deployment asked the VENDOR to withdraw something, and an app it cannot say holds a key
       * is one whose withdrawal it has to report as asked. That is a decision about `unreadable`,
       * and this roster is where it is written down as one.
       */
      type _DisconnectDecides = Decides<
        SchemeKind,
        {
          key: "claims no vendor revocation — nothing at the vendor holds this key";
          consent: "reports the vendor's own withdrawal as asked for";
          none: "reports whatever the vendor says it ended, which for an app with no account is nothing";
          unreadable: "reports it as asked for too, which is the claim that cannot be too weak";
        }
      >;
      const fieldScheme = (await brokeredAppKind(input.toolkit)) === "key";

      // Whether there was an account to end at all, which is what decides if anybody was
      // disconnected. Named apart from the field below because for a key the two differ: something
      // ended, and nothing was asked of the provider.
      const ended = await broker.revoke({
        userId: input.userId,
        toolkit: input.toolkit,
      });

      const vendorRevocationRequested = fieldScheme ? false : ended;

      // `returning` because whether a row was here is half of what decides if anybody was
      // disconnected, and a delete that answered nothing would leave the two cases indistinguishable.
      const [deleted] = await database
        .delete(composioConnections)
        .where(
          and(
            eq(composioConnections.toolkit, input.toolkit),
            eq(composioConnections.userId, input.userId),
          ),
        )
        .returning({ toolkit: composioConnections.toolkit });

      if (deleted || ended) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_disconnected",
          targetType: "mcp_server",
          targetId: input.toolkit,
          payload: {
            actor: input.by,
            server: input.toolkit,
            // Whose account this was, which is not always who ended it: an administrator
            // offboarding somebody and a person disconnecting themselves write the same shape of
            // row, and only these two fields tell them apart.
            owner: input.userId,
            reason: input.reason,
            vendorRevocationRequested,
          },
        });
      }

      return { vendorRevocationRequested };
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
     * AND THE BROKERED CONNECTIONS, which are neither a credential nor a join row. Composio holds
     * the account, so there is no secret in the vault to find and the `composio_connections` row is
     * itself the permission — the only thing deciding whether a call may go out as this person.
     * Sweeping the vault alone therefore left that gate passing for somebody who had been removed.
     *
     * NOT VENDOR-SIDE REVOCATION FOR THE VAULT HALF. That needs the OAuth client and the vendor's
     * revoke endpoint, and it belongs with disconnect. Those rows are the half that stops us
     * holding the secret; the grant at Google outlives it until somebody revokes it there. Said
     * plainly rather than implied, because the difference matters to whoever has to answer for it.
     *
     * THE BROKERED HALF DOES END IT AT THE VENDOR, because there is no secret of ours to stop
     * holding: clearing the row alone would shut the gate this deployment owns and leave the
     * mailbox attached at Composio, which is "we removed their access" being untrue of the only
     * thing that matters, for the person it matters most about. So every app this person connected
     * is revoked through the broker, exactly as {@link disconnectBrokered} revokes for one and
     * {@link removeServer} for a whole app.
     *
     * REVOKE BEFORE DELETE, ALWAYS. The row is the only thing that names which apps this person
     * had, and it outlives the `users` row precisely so offboarding can still find them — which
     * was the table's whole justification and until now was theoretical. A delete that ran first
     * would leave a failed revoke with nothing to revoke under: a live grant on a departed
     * person's mailbox that no operation in this deployment can reach. The other order costs a
     * repeat of an act nobody minds repeating. Nothing is caught around the revokes either, so a
     * broker that will not answer ends this method with the rows still standing rather than
     * letting it report an ending that did not happen.
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
            vendorRevocationRequested: false,
          },
        });
      }

      await database
        .delete(mcpUserCredentials)
        .where(eq(mcpUserCredentials.userId, userId));

      /*
       * Every app this person connected at the broker, where there is no secret to scan the vault
       * for.
       *
       * CRITERION. After this returns, no brokered call may go out on this person's behalf.
       *
       * REASON. A brokered connection is not a credential: Composio holds the account and this
       * deployment sends a user id, so the vault sweep above finds nothing and `composio_connections`
       * is the entire gate. Reading only the vault therefore retired nothing for somebody whose only
       * connector was brokered, reported that as a retirement, and left the `(toolkit, user_id)` gate
       * passing for a person who no longer exists — their access outliving them, which is the first
       * thing anybody asks about a per-person connector. The table's own docblock justifies its shape
       * by this path, so the shape was carrying a promise nothing kept.
       *
       * FOUND HERE AND NOWHERE ELSE, which is what the missing foreign key buys. The row survives the
       * `users` row precisely so this can still name what the person had after they are gone — the
       * same argument the vault lookup above makes, from the side that has no vault row. It is also
       * why the guard at the top of this method is load-bearing rather than defensive: `not null`
       * admits the empty string, so a row at `(toolkit, "")` is legal, and retiring "nobody" must not
       * be what deletes it.
       *
       * COUNTED, because the number is what "we removed their access" claims. Retiring twice stays
       * quiet on its own: the rows are gone, so the second call finds none.
       *
       * READ BEFORE ANYTHING IS DELETED, because the revokes below need the apps and the rows are
       * where the apps are — the reason the docblock gives for revoking first. Sorted, so two
       * retirements of the same person revoke in the same order and write their rows in the same
       * order.
       */
      const brokered = await database
        .select({ toolkit: composioConnections.toolkit })
        .from(composioConnections)
        .where(eq(composioConnections.userId, userId))
        .orderBy(asc(composioConnections.toolkit));

      /*
       * What the broker was actually asked for each app, kept so the trail below records the answer
       * rather than the call. False where there is no broker at all: a deployment whose key has
       * since been unset can still offboard somebody, and it could not have been calling Composio
       * either way — but nothing was asked there and the row must not claim otherwise.
       *
       * ONE APP'S REFUSAL IS ONE APP'S REFUSAL, and until now it was everybody's. A throw out of
       * `revoke` left this loop before the delete and before the trail, so three accounts already
       * withdrawn at Composio kept their rows and got no row on the trail. That was survivable while
       * repeating the act did nothing — and #574 made repeating it the documented recovery, so the
       * second pass asks again for those three, Composio answers `false` because the accounts are
       * gone, and each writes `vendorRevocationRequested: false` about a withdrawal this deployment
       * asked for and got. That field exists to tell an account we acted on from one that outlives
       * us somewhere else; those three rows say the wrong one.
       *
       * So the answer is kept per app and the refusal is held rather than thrown. Every app is still
       * asked — a later one is not punished for an earlier one — and the first refusal is rethrown
       * below, so the act still fails loudly and the administrator still gets a 500.
       */
      const withdrawn: { toolkit: string; requested: boolean }[] = [];
      const refusals: unknown[] = [];
      for (const connection of brokered) {
        try {
          withdrawn.push({
            toolkit: connection.toolkit,
            requested: broker
              ? await broker.revoke({ userId, toolkit: connection.toolkit })
              : false,
          });
        } catch (error) {
          /*
           * Held, and the row deliberately left standing.
           *
           * "An offboarding the vendor refuses leaves the connection standing" is the existing
           * criterion and it is unchanged: the row is the only thing naming which app this person
           * connected, repeating the act is the recovery, and repeating it is only possible while
           * the row is there. What changes is that the rule now applies to the app it is about
           * rather than to every app in the same act.
           */
          refusals.push(error);
        }
      }

      /*
       * Only the apps that answered, which is the other half of the same correction.
       *
       * Deleting by user id would take the rows of apps that were refused or never reached, and
       * those are exactly the rows the recovery needs. Deleting none — what a throw used to do —
       * leaves a row and an open `(toolkit, user_id)` gate for an account that is already gone at
       * Composio, so the table claims a connection this person does not have.
       */
      if (withdrawn.length > 0) {
        await database.delete(composioConnections).where(
          and(
            eq(composioConnections.userId, userId),
            inArray(
              composioConnections.toolkit,
              withdrawn.map((entry) => entry.toolkit),
            ),
          ),
        );
      }

      for (const connection of withdrawn) {
        retired += 1;
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_disconnected",
          targetType: "mcp_server",
          // The app, which for a brokered connection is all the row records. The `mcp_servers` row
          // it belongs to may have been removed already, and the connection outlives that too.
          targetId: connection.toolkit,
          payload: {
            actor: by,
            server: connection.toolkit,
            owner: userId,
            reason: "person_removed",
            /*
             * What was asked of the vendor, not that a call was made — {@link
             * ComposioBroker.revoke}'s own answer, passed through, and the one place this half
             * differs from the vault loop above. There the grant at Google outlives our copy of
             * the secret and nothing was asked of anybody, so the field can only say false; here
             * there was no secret of ours and the account itself was deleted at Composio with its
             * withdrawal asked for, or there was nothing to ask about, or there was no broker to
             * ask. The value of the field is exactly that a reader can tell those apart, so a
             * constant here would be worse than none.
             */
            vendorRevocationRequested: connection.requested,
          },
        });
      }

      /*
       * Loud, after every app has been asked and every answer recorded.
       *
       * The first, because the route turns this into a 500 and one sentence is what reaches the
       * administrator; the rest are the same act failing more than once, and the trail above already
       * says which apps did not end. Thrown last rather than first so a refusal on one app cannot
       * cost the record of another — which is the whole of this change.
       */
      if (refusals.length > 0) throw refusals[0];

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
      initiator?: AuditInitiator;
    }): Promise<{ text: string; isError: boolean }> {
      const [serverId, ...rest] = input.ref.split("/");
      const toolName = rest.join("/");
      if (!serverId || !toolName) {
        throw new PluginRefusedError(`${input.ref} is not a tool.`, null);
      }

      /*
       * Who the trail says made this call, which is not what the call is made AS.
       *
       * `input.actorId` stays the value every gate is decided on, and the empty string must go on
       * matching no grant and no connection anywhere. This is only what the row says: a run nobody
       * could be attributed to is `unattributed` rather than blank, on the criterion at
       * {@link DEPLOYMENT_ACTOR}, and never `deployment` — a run this deployment could not put a
       * name to is not the deployment having acted.
       */
      const auditActor = input.actorId || UNATTRIBUTED_ACTOR;

      const decision = await this.decide("mcp", input.ref, input.botId);
      if (!decision.allowed) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          ...(input.initiator ? { initiator: input.initiator } : {}),
          payload: {
            actor: auditActor,
            bot: input.botId,
            server: serverId,
            tool: toolName,
            refusal: "not_granted",
            reason: decision.reason,
          },
        });
        throw new PluginRefusedError(decision.reason, null);
      }

      const { row, entry, access } = await requireServer(serverId);

      const advertised = await database
        .select({
          name: mcpTools.name,
          inputSchema: mcpTools.inputSchema,
          effect: mcpTools.effect,
          destructive: mcpTools.destructive,
          version: mcpTools.version,
        })
        .from(mcpTools)
        .where(
          and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
        )
        .limit(1);

      const effect = classifyTool(
        entry,
        toolName,
        advertised.length > 0,
        advertised[0]?.effect,
      );

      const args = withoutEmptyOptionals(
        input.args,
        advertised[0]?.inputSchema as Record<string, unknown> | undefined,
      );

      /*
       * The version this action was listed at, handed to the transport that needs one.
       *
       * Under a reserved key rather than as a parameter on the shared signature, because that
       * signature is MCP's and three other transports implement it. The Composio transport strips
       * the key before anything reaches the vendor, and asserts that it did.
       *
       * A `__version` in the model's own arguments is not an argument: it is this key, and no
       * vendor publishes it. So it is stripped unconditionally, whatever its value, and that strip
       * is the whole protection. The recorded version is then merged into arguments that provably
       * cannot carry the key, which makes both spread orders identical: the merge order has no
       * reachable failure mode. Do not read the strip as belt-and-braces on top of an ordering
       * guarantee — the ordering is the redundant half, and removing the strip is what would let a
       * model choose which revision of an action runs.
       *
       * Absent when the app has not been refreshed since the column existed, and because the key
       * was stripped there is then no version at all for the transport to read, which is what makes
       * its refusal hold rather than guessing — a guessed version is a call against an action's
       * other behaviour.
       */
      const { [VERSION_ARG]: _dropped, ...modelArgs } = args;
      const vendorArgs = advertised[0]?.version
        ? { ...modelArgs, [VERSION_ARG]: advertised[0].version }
        : modelArgs;

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
        /*
         * The real one, and this is the path where it is not neutral. A routine's turn reaches its
         * tools through here, carrying the initiator its run assertion was signed with, so this is
         * where `initiator.kind == "routine"` becomes a rule a deployment can actually write. A
         * chat turn arrives with none and reads as a person.
         */
        initiator: policyInitiator(input.initiator),
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
        actor: auditActor,
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
        reachedAs: reachedAsFor(access, input.actorId),
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
          ...(input.initiator ? { initiator: input.initiator } : {}),
          payload: decided,
        });
      }
      if (!verdict.forward) {
        throw new PluginRefusedError(verdict.reason, verdict.matched);
      }

      /**
       * Structural policy answers whether this Bot may call this tool. Content inspection answers
       * whether the arguments would carry a credential out of the deployment. It runs after policy
       * and before credentials are read or a vendor is contacted, and its result contains paths and
       * categories only: never the values it refused.
       *
       * IT IS ASKED ABOUT WHAT WOULD BE SENT, WHICH IS `vendorArgs` AND NOT `args`.
       *
       * CRITERION. The object this inspection judges is the object handed to the transport below,
       * identically — not a version of it taken before the reserved key was stripped and the
       * recorded one merged in.
       *
       * REASON. It was asked about `args`, so the gate and the call were about two different
       * objects, and they came apart in both directions. Whatever is merged in below the strip left
       * this deployment WITHOUT HAVING BEEN LOOKED AT, which is not a boundary at all — it is a
       * boundary around a neighbouring value. And the reserved key, which is stripped
       * unconditionally and provably reaches no vendor, was still judged: a model that put anything
       * credential-shaped under `__version` had its granted call refused and its person told the
       * arguments carry credential material, over material that was never going anywhere and a
       * refusal no rule of this deployment's asked for.
       */
      const contentDecision = inspectToolArguments(vendorArgs);
      if (!contentDecision.safe) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          ...(input.initiator ? { initiator: input.initiator } : {}),
          payload: {
            ...decided,
            decision: { ...decided.decision, carriedOut: false },
            refusal: "sensitive_tool_arguments",
            contentInspection: {
              reason: contentDecision.reason,
              findings: contentDecision.findings,
            },
          },
        });
        throw new PluginRefusedError(
          contentDecision.reason === "sensitive_content"
            ? "The tool call was refused because its arguments contain credential material."
            : "The tool call was refused because its arguments could not be inspected safely.",
          null,
        );
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
        const { token } = await connectionTokenFor(
          row,
          entry,
          input.actorId,
          access,
        );
        const vendor =
          injectedVendor ?? transportFor(access.transport).callTool;
        const result = await vendor(
          {
            url: effectiveUrl(row, entry),
            token,
            actorId: input.actorId,
            botId: input.botId,
          },
          toolName,
          vendorArgs,
        );
        await recordAuditEvent(auditStore, {
          eventType: result.isError ? "mcp.call_failed" : "mcp.call_succeeded",
          targetType: "mcp_tool",
          targetId: input.ref,
          ...(input.initiator ? { initiator: input.initiator } : {}),
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
          ...(input.initiator ? { initiator: input.initiator } : {}),
          payload: {
            ...decided,
            /*
             * Asked through {@link withoutStatement}, because not every throw in this block is a
             * vendor's sentence.
             *
             * The vendor's own words are what this field is for and are kept. But every query on
             * the way here throws a `DrizzleQueryError` whose message is our statement and its
             * bound values — credential ids, user ids, server ids — and `audit_events` is read by
             * an operator and exported. A dump in the row that records a failed call is the same
             * disclosure the tool-list replace was fixed for, in the trail rather than on a page.
             */
            failure: (error instanceof Error
              ? withoutStatement(error)
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
