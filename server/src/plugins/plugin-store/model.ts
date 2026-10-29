import { and, eq, sql } from "drizzle-orm";
import type { ApprovalGate } from "../../approvals/types";
import type { AuditStore } from "../../audit";
import type { ActionPolicy } from "../../computer/policy";
import type {
  CredentialSecretReader,
  CredentialStore,
} from "../../credentials";
import type { Database } from "../../db/client";
import { isQueryFailure, withoutStatement } from "../../db/query-failure";
import { pendingAuthorizations } from "../../db/schema";
import type { CheckPrivateShare } from "../../proactive/private-share";
import {
  BROKERED_PROFILE,
  type BrokerProvider,
  type ServerAccess,
  ServerUnresolvableError,
} from "../access";
import type {
  BrokerConnection,
  ComposioBroker,
  Decides,
  RecordedScheme,
} from "../broker";
import { type CatalogueEntry, resolveServerUrl } from "../catalogue";
import { type ListedTool, McpServerError } from "../mcp";
import type { AccountMode } from "../shared-accounts";
import type { SharedUseGate } from "../shared-use-store";

/**
 * The plugin store's model: its record types, errors, how a tool schema is stored, the token
 * exchange and the OAuth client shape. Split out of `../store.ts`; that file re-exports what it
 * always exported, so its importers did not change.
 */

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
export function grantTargetType(kind: PluginKind): string {
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
  /** What the last stored listing left out for its names; a warning, never a failure. */
  skippedTools: string[];
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
  /**
   * Whose account a brokered app acts in: each person's own, or the one the deployment holds.
   * Null on a row that needs no account at all, and on every row that is not brokered.
   */
  accountMode: "personal" | "shared" | null;
  /**
   * Whether a Shared app's deployment-held account is connected yet.
   *
   * ALWAYS FALSE WHILE {@link accountMode} IS NOT `"shared"`, even where a deployment row happens
   * to stand at the app's url: a Personal app never acts in that account, so reporting it as
   * connected would tell the page something that changes nothing a call does.
   */
  sharedVendorConnected: boolean;
  /**
   * Who may give this app to a Bot, with the default for its account filled in: any Bot's owner
   * (`any`), or only an administrator (`admin`). See `ownerGrantsOf`.
   */
  ownerGrants: "any" | "admin";
  /** What an administrator chose, or null where the default above is in force. */
  ownerGrantsChosen: "any" | "admin" | null;
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
  /**
   * Whose account the app this row names is used under: each person's own, or one the deployment
   * holds for everybody.
   *
   * THE APP'S, READ OFF THE ROW THAT ANSWERS FOR IT, exactly as {@link authScheme} is. Two rows may
   * name one app and only one of them decides whose account it is, so a page that drew the Shared
   * treatment off the row it opened could show one answer while every connect, grant and call
   * behind its buttons acted on the other. Null is a row that is not brokered, and also a brokered
   * row whose app has no answering row left to say.
   */
  accountMode: AccountMode | null;
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
export type _ProbeRosterNamesTheWholeUnion = Decides<
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
export type RecordedCheck = "unchecked" | "consented" | "checked" | "failed";

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
export type _ProbeOutcomeLeaves = Decides<
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
export const NUL = "\u0000";

/**
 * A schema this deployment cannot turn into a row, whatever the column would have said.
 *
 * Its own class so the one place that raises it and the one place that contains it are joined by
 * something other than a substring: {@link storableSchema} is the only thrower, and the `try`
 * around the call that turns a listing into rows is the only catcher. Nothing branches on the class
 * — it is recorded the way anything else a vendor's answer could not be made into would be — but
 * naming it keeps a later reader from mistaking it for a fault of this deployment's own.
 */
export class SchemaUnstorableError extends Error {
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
export function withoutNul(value: unknown, ancestors: Set<object>): unknown {
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
export function storableSchema(
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
 *
 * CRITERION FOUR. No row carries a name a model cannot be offered, and every name left out for that
 * reason comes back in `skipped`, once, spelled as the vendor listed it — so the caller can say
 * which actions were not recorded rather than leave their absence for somebody to notice.
 */
export function storableTools(
  serverId: string,
  listed: ListedTool[],
): { rows: StorableTool[]; skipped: string[] } {
  const byName = new Map<string, StorableTool>();
  const skipped = new Set<string>();

  for (const tool of listed) {
    const name = tool.name.replaceAll(NUL, "");
    /*
     * THE GUARD THAT MAKES THE OFFERED NAME OFFERABLE, placed at the one seam every transport's
     * listing passes through on its way into the database.
     *
     * A model tool name may only match `^[a-zA-Z0-9_-]+$`, and `name` is spliced into one by
     * {@link toolNameFor}. Nothing used to check: Arcade's dotted `qualified_name` was recorded
     * whole and the refusal arrived much later and somewhere else entirely — as a 400 on the model
     * request naming `tools[47]`, with no mention of the app, the action or the refresh that
     * recorded it. A person reading that has nothing to act on.
     *
     * SKIPPED AND NAMED, NOT REFUSED. This used to throw, which cost the whole listing for one
     * name: the MCP spec allows a dot in a tool name, so a custom server with a single dotted
     * action stored none of its others on an add and froze its list on every refresh after. The
     * guarantee that matters — the name never reaches a model — holds either way; what skipping
     * changes is that the rest of the app keeps working. The name comes back to the caller, which
     * says on the app's own page what was left out.
     */
    if (!OFFERABLE_TOOL_NAME.test(name)) {
      skipped.add(name);
      continue;
    }
    if (byName.has(name)) continue;
    byName.set(name, {
      serverId,
      name,
      /*
       * The vendor's spelling where the transport drew a distinction, and the same string where it
       * did not — which is the whole of what absence means here. See {@link ListedTool.vendorName}.
       */
      vendorName: (tool.vendorName ?? name).replaceAll(NUL, ""),
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

  return { rows: [...byName.values()], skipped: [...skipped] };
}

/** One row {@link storableTools} hands to the `mcp_tools` insert. */
export type StorableTool = {
  serverId: string;
  name: string;
  vendorName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: "read" | "write" | null;
  destructive: boolean;
  version: string | null;
};

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
 * The OAuth error code for a refresh token the vendor will no longer honour (RFC 6749 §5.2): it was
 * revoked, it expired, or the person withdrew the grant. Nothing this deployment can do brings it
 * back — only the person consenting again — so the connection is recorded as withdrawn, the state
 * every screen already reads as Reconnect.
 */
export const INVALID_GRANT = "invalid_grant";

/**
 * A transaction, as the writes in this module hand one to each other.
 *
 * Named because two writes here are one decision — a secret in the vault, and the pointer that says
 * what it is for — and the only way to say that is to run both on the same executor. `select`,
 * `insert` and `update` alone would do for {@link CredentialExecutor}; this needs `execute` too, for
 * the advisory lock that serialises the client path.
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * THE ONLY SHAPE A MODEL TOOL NAME MAY TAKE, as the model API enforces it: `^[a-zA-Z0-9_-]+$`.
 *
 * Declared here beside {@link toolNameFor}, which is the function that has to satisfy it, and
 * applied in {@link storableTools}, which is the one door every transport's listing goes through and
 * which leaves out — and reports — any name that fails it. The prefix and separator this module
 * splices in are themselves made of these characters, so a `name` that passes is an offered name
 * that passes.
 */
export const OFFERABLE_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

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

export const iso = (value: Date | string | null): string | null =>
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
export const DEPLOYMENT_ACTOR = "deployment";
export const UNATTRIBUTED_ACTOR = "unattributed";

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
export const reachedAsFor = (access: ServerAccess, actorId: string): string =>
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
export function effectiveUrl(
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
export const TOKEN_TIMEOUT_MS = 10_000;

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
export function isUsableClient(value: unknown): value is OAuthClient {
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
export type StoredClient = { client: OAuthClient; registeredAt: Date | null };

/**
 * How long a freshly stored OAuth client is left alone after `invalid_client`.
 *
 * Re-registering once per refusal is right for one call and wrong for a deployment: a vendor that is
 * simply down answers every exchange `invalid_client`, and every tool call anywhere then mints a
 * client of its own, because each of them is the first refusal IT has seen. A client younger than
 * this was already the product of a re-registration, so registering again inside the window is
 * amplification rather than recovery — the honest answer is the vendor's refusal, unedited.
 */
export const CLIENT_REREGISTRATION_BACKOFF_MS = 5 * 60_000;

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
export const IDENTITY_ACTION =
  /(_GET_ME|_PROFILE|_CURRENT_USER|_USER_INFO|_WHOAMI)$/;

/**
 * Every broker's id namespace, reserved together. See {@link BROKERED_PROFILE} in `./access` for
 * what a profile holds and why it lives there; this is only the list this file reserves off it.
 */
export const BROKERED_ID_PREFIXES = Object.values(BROKERED_PROFILE);

/**
 * Every broker's screen name, reserved together, for the reason {@link BROKERED_ID_PREFIXES} is.
 *
 * THE KEYS, NOT A SECOND LITERAL LIST. `/admin/plugins/composio` is the app directory's own page and
 * `/admin/plugins/arcade` is the Arcade one, and a static route is matched ahead of
 * `/admin/plugins/$key` on both — so a server sitting at either id would be listed and then open
 * somebody else's page instead of its own. Spelled as its own list, this reservation would be the
 * one somebody adds a broker to {@link BROKERED_PROFILE} without adding to.
 */
export const BROKERED_SCREEN_NAMES = Object.entries(BROKERED_PROFILE);

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
  approvalGate?: ApprovalGate;
  /**
   * The owner's permission before a connector call sends content to other people.
   * See plugins/share-target.ts and proactive/private-share.ts. Absent asks nothing.
   */
  privateShareCheck?: CheckPrivateShare;
  /** Who may steer a run that uses a Shared app's account. Absent, every shared call is refused. */
  sharedUse?: SharedUseGate;
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
    /** `accountGone` as `McpCallResult` carries it: the vendor lost the account this call ran in. */
  ) => Promise<{ text: string; isError: boolean; accountGone?: true }>;
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
  /**
   * Which broker this deployment runs, which is the slice of `brokered_connections` this store
   * reads and the word its connection writer stamps on every row it mints.
   *
   * THE ONE PLACE THE VENDOR IS NAMED. Every read of `brokered_connections` below and the insert in
   * {@link createPluginStore}'s `recordBrokeredConnection` used to spell `composio` for themselves —
   * eleven comparisons that were each correct while there was one broker and each silently wrong on
   * the day there were two. They now all read this. A deployment running Arcade whose store was
   * still filtering on `composio` would not fail: it would read an empty slice, write rows nobody
   * reads back, and leave the "the other provider holds rows" refusal permanently unfired while the
   * offboarding sweep swept the wrong table slice. That is the failure this field exists to make
   * impossible to reach by accident.
   *
   * REQUIRED, UNLIKE `broker` ABOVE, BECAUSE FORGETTING IT HAS NO SYMPTOM. An absent `broker` says
   * one true thing — this deployment has not configured one — and every path that needs it raises.
   * An absent provider would have had to be guessed, and the only guess available was `composio`:
   * an Arcade deployment built by forgetting this field would then read and write the COMPOSIO slice
   * of `brokered_connections`, hand its own rows back through a composio filter, and APPEAR TO WORK.
   * Spec D3's "the other provider holds rows" refusal would never fire, because nothing would ever
   * be filed under the other name, and the offboarding sweep would sweep a slice that is not this
   * deployment's. Nothing goes red. There is no error to raise later, so the compiler asks now.
   *
   * SO THERE IS NO DEFAULT ANYWHERE — not here, not in {@link createPluginStore}, not in a test
   * helper. A function that cannot reach the provider takes it as a parameter; a second answer to
   * "which provider" is a second thing that can be wrong while agreeing with nothing. `activeProvider`
   * in `./broker` decides it from configuration at the one deployment boundary that knows.
   */
  brokerProvider: BrokerProvider;
  /** Where the vendor sends people back; needed to (re)register a dynamic client. */
  redirectUri?: string;
  /**
   * What this deployment calls itself (`DEPLOYMENT_ID`, else the tenant package id). The prefix of
   * a shared account's vendor identity, read only when an app is switched to Shared.
   */
  deploymentId?: string;
};

/** One in-flight Arcade authorization attempt, as the table stores it. */
export type PendingAuthorization = typeof pendingAuthorizations.$inferSelect;

/**
 * WHY A BROKERED ACCOUNT'S ROW WENT, as the trail spells it, and a closed set rather than free
 * text for the reason {@link PluginStore.disconnectBrokered} gives: a reader asking the trail
 * WHICH of these happened can be answered only if it is the same word every time.
 *
 * ONE SET ACROSS EVERY WRITER OF `mcp.account_disconnected`, so that `clearEndedSiblings` — which
 * writes for all of them — takes the word rather than re-deciding it. Each writer still narrows
 * this to the words IT may use; nothing takes the whole union as its own input.
 */
export type BrokeredDisconnectReason =
  /** The person disconnected their own account. */
  | "self"
  /** The person was removed from the People screen; {@link PluginStore.retireConnectionsFor}. */
  | "person_removed"
  /** An administrator disconnected the deployment's account for a Shared app. */
  | "admin"
  /** The app was switched between Personal and Shared, retiring the old mode's accounts. */
  | "mode_switched"
  /** A consent's context moved on and the verifier withdrew the retired identity's app. */
  | "context_changed"
  /** The app itself was removed; {@link PluginStore.removeServer}. */
  | "mcp_server_removed";

/** One app's connection, as far as sibling-finding needs to know it. */
export type ConnectionFootprint = {
  /** The toolkit, spelled as the vendor spells it. Compared exactly, never case-folded. */
  app: string;
  /** The identity the connection is held under at the vendor. */
  vendorUserId: string;
  /**
   * The vendor's own AUTH PROVIDER the connection is held under (`google`), not the broker's name.
   *
   * NAMED `authProvider` AND NEVER `providerId`, because `provider` in this file means the BROKER —
   * `brokered_connections.provider` is read a few lines below this one — and that collision has
   * already been paid for once in an audit payload. See {@link ConnectedAppBroker.authProviderOf},
   * which is where this value comes from and which is likewise not the toolkit name.
   */
  authProvider: string;
};

/**
 * The apps that share `of`'s connection, which are the apps sharing BOTH its vendor identity AND
 * its AUTH PROVIDER. NEVER THE PROVIDER ALONE (spec D26).
 *
 * REASON. An Arcade connection is keyed `(user_id, provider_id)`, and this deployment holds MANY
 * vendor identities: each person's own, PLUS ONE RANDOM IDENTITY PER SHARED APP, minted by
 * `mintDeploymentVendorUserId`. So shared Gmail and shared Slack, both using Google, do NOT share
 * a connection: their `user_id`s differ. A computation keyed on `provider_id` alone would warn
 * about apps that WILL NOT BE TOUCHED, which trains people to dismiss the warning that matters.
 * Silently ending two connections when somebody asked to end one is the failure to avoid.
 *
 * The auth provider is compared case-insensitively, as the adapter's `connectionsFor` does; the app
 * name is not, because Arcade toolkit case is never normalised. The answer never contains `of`
 * itself, and is sorted so two callers see the same list. This function ACTS ON NOTHING.
 */
export function connectionSiblings(
  of: ConnectionFootprint,
  among: readonly ConnectionFootprint[],
): string[] {
  const provider = of.authProvider.toLowerCase();
  const found = new Set<string>();
  for (const other of among) {
    if (other.app === of.app) continue;
    if (other.vendorUserId !== of.vendorUserId) continue;
    if (other.authProvider.toLowerCase() !== provider) continue;
    found.add(other.app);
  }
  return [...found].sort();
}

/** Raw `execute` rows are snake_case and carry timestamps as whatever the driver decoded. */
export function pendingAuthorizationFromRow(
  row: Record<string, unknown>,
): PendingAuthorization {
  const when = (v: unknown) =>
    v === null || v === undefined ? null : new Date(v as string | Date);
  return {
    actorId: row.actor_id as string,
    serverId: row.server_id as string,
    action: row.action as string,
    holder: row.holder as PendingAuthorization["holder"],
    userId: (row.user_id as string | null) ?? null,
    vendorUserId: row.vendor_user_id as string,
    authId: (row.auth_id as string | null) ?? null,
    createdAt: when(row.created_at) as Date,
    completedAt: when(row.completed_at),
    outcome: (row.outcome as PendingAuthorization["outcome"]) ?? null,
  };
}

/**
 * The instant a caller names an authorization attempt by, as a `Date`, or a refusal naming the
 * field.
 *
 * THE DECLARED TYPE IS `Date` AND THE VALUE IS NOT ALWAYS ONE. `PendingAuthorization.createdAt` is
 * typed `Date` and is one while it stays in this process, but an attempt that has been through
 * JSON — serialised into a job, a cache or a cross-process hop and parsed back — carries an ISO
 * STRING under a `Date` annotation. Handed to drizzle, that string reaches
 * `PgTimestamp.mapToDriverValue`, which calls `.toISOString()` on it and raises
 * `TypeError: value.toISOString is not a function` from inside the driver: a failure that names
 * neither the field nor the caller. An ISO string names the same instant perfectly well, so it is
 * accepted; anything that names NO instant is refused HERE, where the message can say what was
 * wrong, rather than running as a query that silently matches nothing.
 */
function attemptInstant(createdAt: Date | string): Date {
  const instant =
    createdAt instanceof Date
      ? createdAt
      : typeof createdAt === "string"
        ? new Date(createdAt)
        : new Date(Number.NaN);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(
      `An authorization attempt's created_at must be a Date or an ISO timestamp, not ${JSON.stringify(createdAt) ?? String(createdAt)}.`,
    );
  }
  return instant;
}

/**
 * The condition that names ONE actor's attempt by the `created_at` a caller holds.
 *
 * MATCHED AT MILLISECOND PRECISION ON BOTH SIDES, BECAUSE THE TWO SIDES DO NOT CARRY THE SAME ONE.
 * `created_at` is a `timestamptz`, which PostgreSQL keeps to the MICROSECOND, and the `Date` the
 * driver hands back carries MILLISECONDS. A row stored at `…13.407577` is read back as
 * `…13.407Z`, and an exact `=` against that `Date` matches NOTHING — so the mint writes no
 * `auth_id`, and per {@link pendingAuthorizations}, "an attempt holding null can never complete":
 * a silently dead attempt that waits out its fifteen minutes.
 *
 * {@link createPluginStore}'s `claimAuthorizationAttempt` writes `date_trunc('milliseconds', now())`
 * for exactly this reason, but THAT ONLY HOLDS FOR THE ONE WRITER THAT REMEMBERS. The column's
 * default is `now()` at full precision, which is what drizzle's inferred insert type invites any
 * other writer — a fixture, a backfill, a future route — to take. Truncating the COLUMN in the
 * comparison holds whatever wrote the row, which is why the invariant lives here rather than in
 * the schema: it needs no migration and no writer's cooperation.
 *
 * TRUNCATING CAN NEVER MATCH A DIFFERENT ROW: `actor_id` is the table's PRIMARY KEY, so there is at
 * most one attempt per actor and `created_at` is the staleness guard on that one row, never a
 * selector among several. It still refuses a value naming an OLDER attempt, which is what stops a
 * late discard from deleting the replacement that took the key.
 */
export function attemptNamed(actorId: string, createdAt: Date | string) {
  return and(
    eq(pendingAuthorizations.actorId, actorId),
    sql`date_trunc('milliseconds', ${pendingAuthorizations.createdAt}) = ${attemptInstant(createdAt).toISOString()}::timestamptz`,
  );
}

/**
 * The literal recorded on the row, which is the scheme a later call must keep using.
 *
 * TYPED AS {@link RecordedScheme} RATHER THAN `string`, so that what this writes and what
 * {@link schemeKind} recognises are held to one set by the compiler. A literal spelled here that
 * the reader does not know would be read as `unreadable` — a key app that connects nobody, or a
 * consent app no confirm can verify — and nothing but this annotation would say so.
 */
export function schemeFor(connection: BrokerConnection): RecordedScheme | null {
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
export function withoutEmptyOptionals(
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
