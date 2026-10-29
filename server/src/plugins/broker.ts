/**
 * What openbot needs of Composio the BROKER, as against Composio the transport.
 *
 * `./composio` is about calling an action once an app is connected. This file is about everything
 * that has to be true before that: which apps exist to choose from, which of them this deployment
 * has an auth config for, whose account is attached to one, and how a person attaches or detaches
 * theirs. Two different questions, so two different projections rather than one wide client.
 *
 * IT IMPORTS NO VENDOR, AND THAT IS THE POINT OF IT. Not `@composio/core`, not a client, not a
 * schema. Everything below is a name for a shape, so the vendor's package stays confined to the
 * adapter that implements {@link ConnectedAppBroker} — one file, replaceable, and the only place a
 * version bump can reach. A module that named the vendor's types here would put their package on
 * the import graph of every test that touches enablement. `AccountRef`, `BrokerProvider` and
 * `BROKERED_PROFILE`, below, are the only imports that cross this file's boundary, and all three are
 * names this deployment owns, never the vendor's. Two are types; `BROKERED_PROFILE` is a value, and
 * the comment on its import says what that costs.
 */
// This import closes a runtime cycle: `./access` imports `schemeKind` from this file. It is safe
// for two reasons, and the reasons are the rule. `access.ts` reads `schemeKind` only inside a
// function body, and this file reads `BROKERED_PROFILE` only inside a refusal constructor — the
// `BrokerUnconfiguredError` one and the `BrokerReturnUrlError` one — so whichever module evaluates
// first, the other's half-initialised bindings are never touched while either is still evaluating.
// Nothing may call across this cycle at module scope.
// Hoisting a `BROKERED_PROFILE[provider]` destructure out of either constructor, or deriving a
// top-level constant in `access.ts` from `schemeKind`, would read a lexical binding the other module
// has not yet initialised: it throws under one evaluation order and not the other, so it can pass
// every test and still fail at boot. The cycle is deliberate: passing `vendor` and `envVar` in
// would scatter the vocabulary across every call site, which is what keeping `BROKERED_PROFILE` in
// `access.ts` exists to prevent.
import { BROKERED_PROFILE, type BrokerProvider } from "./access";
import type { AccountRef } from "./shared-accounts";

/**
 * The schemes whose secret a PERSON holds and types in, rather than one anybody registers.
 *
 * WRITTEN ONCE AND READ TWICE, BECAUSE A SECOND DECLARATION IS A WAY FOR THE TWO TO DISAGREE. The
 * list is the fact and {@link FieldScheme} is derived from it, so the names the guard tests and the
 * names the type admits cannot come apart. A hand-written union beside a hand-written array is the
 * same set stated twice, and a member added to one of them and not the other typechecks perfectly.
 *
 * AND THE DISAGREEMENT FAILS OPEN, which is why it is worth a derivation rather than a comment
 * asking the next person to keep both in step. {@link isFieldScheme} would answer false for a scheme
 * the type calls valid, and an app whose secret a person types would be read as one nobody types —
 * sent down the consent path, to a vendor screen that has nothing to ask them for.
 */
const FIELD_SCHEME_NAMES = [
  "API_KEY",
  "BASIC",
  "BEARER_TOKEN",
  "BASIC_WITH_JWT",
] as const;

export type FieldScheme = (typeof FIELD_SCHEME_NAMES)[number];

/**
 * Whether a scheme recorded on a row is one whose secret a person types.
 *
 * Takes the column's own type — `string | null` — rather than a `FieldScheme`, because every
 * caller is asking ABOUT a recorded value, and a signature demanding the answer first would push
 * the same `includes` into four call sites.
 */
export function isFieldScheme(scheme: string | null): scheme is FieldScheme {
  return (
    scheme !== null &&
    (FIELD_SCHEME_NAMES as readonly string[]).includes(scheme)
  );
}

/**
 * One vendor flag as the boolean it has to be, or null where Composio sent something else.
 *
 * THREE INPUTS AND TWO ANSWERS IS WHAT `x === true` HAS, AND THE THIRD IS THE ONE THAT MATTERS.
 * Every flag reading it replaced was written that way, which is exactly right about an ABSENT one —
 * Composio genuinely publishes fields with no `required`, no `is_secret` and no `user_visible`, and
 * each of those absences is a fact about the field that the default states honestly. It is not
 * right about a flag that is PRESENT and is not a boolean: `"true" === true` is `false`, so the
 * vendor saying yes and the vendor saying nothing came out of the read as one answer, and the wrong
 * one.
 *
 * SO THE DEFAULT IS THE CALLER'S AND THE WRONG SHAPE IS NOBODY'S. `whenAbsent` is passed rather
 * than assumed because the callers do not agree on it — an unstated `required` is a no, an unstated
 * `user_visible` is a yes, an unstated `file_uploadable` is "this action stages nothing" — and a
 * null comes back for the shape none of them has a reading for, which each turns into a sentence
 * naming what arrived. That is this deployment's rule for every wire value: answer null on what
 * cannot be read, and let the caller say what was lost by it.
 *
 * REFUSING RATHER THAN COERCING, WHICH IS A DECISION AND NOT A DEFAULT. The tempting fix for a
 * `required` of `"true"` is to read the string, and it is wrong on the row beside it: `"false"` is
 * a truthy string, so any coercion that rescues the required field marks every optional one
 * required, and `Boolean("0")` and `Boolean("no")` go the same way. There is no reading of a
 * wrong-shaped flag that is right on both halves — which is the same argument `./composio-adapter`
 * makes about a `Number("63")` and a `String(undefined)`. And a vendor publishing a string where it
 * documents a boolean is a change in the package rather than a setting anybody here can correct, so
 * every sentence built off a null here ends by naming that.
 *
 * IT LIVES HERE RATHER THAN IN `./composio-adapter`, WHICH IS WHERE IT WAS WRITTEN AND WHERE IT WAS
 * ONE CALLER SHORT. `./composio`'s file-staging walk was the last `=== true` in this deployment and
 * could not reach it: the adapter imports `./composio`, so an import the other way is a cycle. Both
 * of them already import this module and neither is imported by it, so one judgement about what a
 * vendor flag is now has one home and the walk that fails OPEN on a wrong shape is held by it.
 */
export function flagOf(value: unknown, whenAbsent: boolean): boolean | null {
  if (value === undefined || value === null) return whenAbsent;
  return typeof value === "boolean" ? value : null;
}

/**
 * The schemes where the VENDOR'S OWN YES is the whole of the check, and nothing here is ever spent.
 *
 * `OAUTH2` and `DCR_OAUTH` are the two consent flows: somebody finishes at the vendor's own screen,
 * the account it attaches is the evidence, and `composio_connections` holds a row saying this
 * person granted this deployment access to it.
 *
 * `NO_AUTH` IS NOT ONE OF THEM, AND USED TO BE. It was put here on the reasoning that an app with no
 * credential has nothing that could be tried either — true, and the wrong half of the question. What
 * this list decides is not "is there anything to probe" but "is the vendor's yes a verification of
 * an ACCOUNT", and a no-auth app has no account at all: Composio refuses even to hold an
 * authorization config for one, nobody ever consents to anything, and there is nothing to withdraw.
 * Two consumers already knew that and said so by comparing the raw string — the per-person gate let
 * such a call through without a row, and the connect route refused to make one — while
 * {@link schemeKind} went on answering `consent`, so the one consumer that asked the classifier
 * wrote, on every page load, the exact row the other two exist to keep out of that table. See
 * {@link NO_CREDENTIAL_SCHEME_NAMES}.
 *
 * WRITTEN AS A LIST FOR {@link FIELD_SCHEME_NAMES}' REASON, and read by {@link schemeKind}. The
 * writer of this column is `schemeFor` in `plugins/store.ts`; a literal it spelled that the reader
 * here did not recognise is the failure this pair exists to make impossible, and
 * {@link RecordedScheme} — that function's return type — is what holds the two to one set.
 */
const CONSENT_SCHEME_NAMES = ["OAUTH2", "DCR_OAUTH"] as const;

export type ConsentScheme = (typeof CONSENT_SCHEME_NAMES)[number];

/**
 * The schemes where there is NOTHING TO CONNECT: no credential, no account, no consent.
 *
 * ONE MEMBER, AND A LIST ANYWAY, for {@link FIELD_SCHEME_NAMES}' reason and because the set is the
 * vendor's rather than ours — `NO_AUTH` is what Composio publishes for the thirty-odd toolkits that
 * need nothing, and it sits beside `API_KEY`, `BASIC`, `BEARER_TOKEN` and `BASIC_WITH_JWT` in its
 * own scheme enum. A second name for the same idea is Composio's to add, and a list is what makes
 * that a one-line change here rather than a search for a string literal.
 *
 * WHAT IT DECIDES IS WHETHER A ROW MAY BE WRITTEN AT ALL. `composio_connections` is the whole of
 * the permission for a brokered call and every row in it means one thing: this person granted this
 * deployment access to their account at this app. There is no account and no grant here, so nothing
 * may be written — which is what the per-person gate and the connect route already acted on, each
 * by comparing this literal itself. They now ask {@link schemeKind}, and so does everything else.
 */
const NO_CREDENTIAL_SCHEME_NAMES = ["NO_AUTH"] as const;

export type NoCredentialScheme = (typeof NO_CREDENTIAL_SCHEME_NAMES)[number];

/**
 * Every literal this deployment ever WRITES to `mcp_servers.auth_scheme`.
 *
 * The return type of the function that composes one, so a scheme no list admits cannot be written
 * down in the first place. Reading is the other half and is deliberately wider: the column is
 * `text`, a row may have been inserted by hand or restored from a deployment that knew other names,
 * and {@link schemeKind} is what says what to do about one of those.
 */
export type RecordedScheme = FieldScheme | ConsentScheme | NoCredentialScheme;

/**
 * What a recorded scheme DECIDES, which is the one vocabulary every caller branches on.
 *
 * FOUR ANSWERS AND NOT TWO, which is the whole reason this exists rather than a second `includes`
 * beside {@link isFieldScheme}. `key` and `consent` are the two kinds of app somebody CONNECTS;
 * `none` is an app there is nothing to connect to at all; and `unreadable` is a column this
 * deployment cannot act on — a null, or a literal nothing here writes — and it is a real state
 * rather than a defensive one: `mcp_servers.url` carries no unique index, so the row that answers
 * for an app is not always the row an enable wrote a scheme onto, and a hand-inserted or restored
 * row carries whatever it carries.
 *
 * AND NEITHER OF THE OTHER TWO IS A SPELLING OF `consent`, WHICH IS THE FAILURE THIS TYPE REPLACES
 * — TWICE. Asking only "is this a key app" makes every other answer consent by elimination, and
 * consent is the one scheme where the vendor's yes IS a verification — so a column nobody could
 * read was writing a verdict about evidence nobody had, on every page load. A caller that cannot
 * tell that answer from consent has no way to fail closed, because it never learns that there was
 * nothing to read. `none` was the same mistake made one level up: `NO_AUTH` sat in the consent
 * LIST, so the classifier itself called it consent, and the two consumers that knew better said so
 * by comparing the raw literal rather than by asking — one vocabulary member answered two ways from
 * inside, which is the drift a closed vocabulary exists to make impossible.
 *
 * WRITTEN AS A ROSTER FOR {@link FIELD_SCHEME_NAMES}' REASON, AND FOR A SECOND ONE. The first is
 * that file's: one list, read by the type and by everything that has to enumerate the members, so
 * the two cannot come apart. The second is what {@link Decides} is for — a hand-written union is
 * something a fourth member can be added to in one line, and NOTHING anywhere then fails, because
 * every consumer of this vocabulary reads it with an `if` chain and an `if` chain has no opinion
 * about the answers it was not written for. The roster is what the witnesses at those consumers are
 * checked against.
 */
export const SCHEME_KINDS = ["key", "consent", "none", "unreadable"] as const;

export type SchemeKind = (typeof SCHEME_KINDS)[number];

/**
 * A CONSUMER'S ANSWER FOR EVERY MEMBER OF A CLOSED VOCABULARY, CHECKED WHERE IT IS WRITTEN DOWN.
 *
 * Type-only and erased entirely: `Answers` is returned unchanged, so an alias declared through this
 * is the object type it was given and nothing reaches the emitted JavaScript. What it buys is the
 * constraint — `Answers extends Record<Vocabulary, string>` is checked at the point the alias names
 * its members, so a vocabulary that gains a member fails at TS2344 on every declaration that does
 * not name the new one, and the error names the missing member.
 *
 * THE PROBLEM IT SOLVES IS THAT `if` CHAINS CANNOT BE EXHAUSTIVE HERE. The usual witness is a
 * `never`-typed binding in a final `else`, and it needs the chain to narrow the value down to
 * nothing — which none of these consumers does: they branch on ONE member (`kind === "consent"`,
 * `kind !== "key"`) and then on something else entirely, so there is no position where the compiler
 * has the vocabulary narrowed away. Three rounds of review have now each taught one consumer about
 * one member and left an adjacent one standing. A declaration that must name every member is the
 * check that an `if` chain cannot be made to carry: it sits beside the branch, it says in words
 * what that branch answers for each member, and it is the thing that reddens when a fourth arrives.
 *
 * THE VALUE OF EACH KEY IS A SENTENCE AND IS READ BY A PERSON, not by the compiler — what is
 * enforced by default is that a key EXISTS for every member. The sentence is what tells the next
 * reader whether the branch beside it still does what the roster claims, and what the table in
 * `tests/composio-connection-kinds.test.ts` enumerates cell by cell.
 *
 * `Value` NARROWS THAT WHERE THE ANSWERS ARE THEMSELVES A CLOSED SET, which is what a roster
 * spanning two vocabularies needs: the keys are one vocabulary and the values are the other, and
 * free text on either side would let the seam drift in the direction the roster exists to pin.
 * Defaulted to `string`, so a roster whose answers are prose says nothing about them.
 */
export type Decides<
  Vocabulary extends string,
  Answers extends Record<Vocabulary, Value>,
  Value extends string = string,
> = Answers;

/** {@link SchemeKind} for a value read out of the column. */
export function schemeKind(scheme: string | null): SchemeKind {
  if (isFieldScheme(scheme)) return "key";
  if (scheme === null) return "unreadable";
  if ((NO_CREDENTIAL_SCHEME_NAMES as readonly string[]).includes(scheme)) {
    return "none";
  }
  if ((CONSENT_SCHEME_NAMES as readonly string[]).includes(scheme)) {
    return "consent";
  }
  return "unreadable";
}

/**
 * One value Composio wants from the person connecting, as Composio itself describes it.
 *
 * Every field here is published per app rather than guessed: `is_secret` says which one to mask,
 * and the description is written for the person filling it in ("Your Firecrawl API key, a token
 * starting with fc-"). `name` is sent back on the wire verbatim and is never shown.
 */
export type BrokerField = {
  name: string;
  label: string;
  help: string;
  required: boolean;
  secret: boolean;
  default?: string;
};

/**
 * The keys of {@link BrokerField} as a ROSTER, which is what anything enumerating them is checked
 * against.
 *
 * A TYPE IS NOT A THING A BROWSER TEST CAN COUNT. `BrokerField` is erased, and the browser holds a
 * SECOND declaration of this shape in `app/src/lib/plugins/mutations.ts` because the two processes
 * share no module. The drift test in `app/tests/connection-fields.test.tsx` therefore needs a value
 * at runtime, and for two rounds it had one it wrote itself — a literal in the test file compared
 * against another literal in the same file, which a key added here passed without a word. This is
 * the value it now imports, so the count is against this declaration rather than against a copy of
 * it somebody remembered to make.
 *
 * PINNED TO THE TYPE IN BOTH DIRECTIONS, for `BROKERED_PROBE_OUTCOMES`' reason one vocabulary along
 * in `./store.ts`. `satisfies` holds this list inside the shape, so a key misspelled here fails;
 * {@link _BrokerFieldKeysNameTheWholeShape} holds the shape inside this list, so a key added to
 * `BrokerField` and not to this roster fails. `Required<…>` is what makes the optional key count —
 * `default` is a key the vendor publishes and the form has to read, and a roster that let optional
 * keys go unnamed would be a roster with a hole in exactly the place a new key is likeliest to land.
 *
 * SO A SEVENTH KEY COSTS TWO STEPS AND CANNOT SKIP EITHER. Adding it to the type fails `tsc` here;
 * adding it here to satisfy that then fails the browser's count, which has no entry for the new name
 * in either its sample field or its list of what the form is observed to DO with a key.
 */
export const BROKER_FIELD_KEYS = [
  "name",
  "label",
  "help",
  "required",
  "secret",
  "default",
] as const satisfies readonly (keyof Required<BrokerField>)[];

/** The other direction of {@link BROKER_FIELD_KEYS}' pin. Type-only; erased entirely. */
type _BrokerFieldKeysNameTheWholeShape = Decides<
  keyof Required<BrokerField>,
  Record<(typeof BROKER_FIELD_KEYS)[number], string>
>;

/**
 * How this deployment would connect somebody to an app — the one fact everything else reads.
 *
 * Derived once from the catalogue, recorded on the app's row at enable time, and read by the
 * picker (which hides `unsupported`), by the enable path (which creates the config this names, or
 * none) and by the connect screen (which draws a link or a form). Deriving it twice is how a
 * single hard-coded choice came to leak into every app in the first place.
 */
export type BrokerConnection =
  | { kind: "consent" }
  | { kind: "self-registering" }
  | { kind: "fields"; authScheme: FieldScheme }
  | { kind: "no-auth" }
  | { kind: "unsupported"; reason: string };

/**
 * One app in the catalogue, as much of Composio's toolkit listing as anything here reads.
 *
 * `logo` is nullable because the vendor publishes none for some toolkits, and an administrator
 * picking from a list of a few hundred apps is better served by a missing image than by a broken
 * one.
 */
export type BrokerApp = {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  /**
   * How many actions the app publishes, shown BEFORE anybody enables it.
   *
   * Because the size is the decision. Enabling an app writes every one of its actions into
   * `mcp_tools` and puts them in front of a model, so the difference between an app with six
   * actions and one with sixty-three is the difference between a small addition and a rewrite of
   * what the model sees. An administrator who learns the number only after enabling has already
   * made the choice this field exists to inform.
   */
  actionCount: number;
  /**
   * How many of those actions the provider itself classified, or null where nobody measured.
   *
   * REQUIRED AND NULLABLE, WHICH IS THE WHOLE POINT OF THE FIELD. `0` means MEASURED, AND NOTHING
   * WAS CLASSIFIED — every action of this app will be approved like a deletion, so the coverage
   * warning fires. `null` means NOT MEASURED — this provider does not publish the fact, so the page
   * says nothing. Those are opposite sentences.
   *
   * An OPTIONAL field makes them the same shape at the call site, and the natural `?? 0` collapses
   * "unmeasured" into "measured none" — firing a coverage warning on a Composio deployment, a false
   * alarm at exactly the moment somebody is deciding whether to trust an app. So every projection
   * states the value, `./composio-adapter` writes an explicit `null`, and NOTHING WRITES `?? 0`.
   */
  classifiedCount: number | null;
  /**
   * How many DISTINCT NON-EMPTY scope sets the app's actions ask for, or null where nobody measured.
   *
   * The count of things that are separately approvable. Two actions asking for the same scopes are
   * one permission; `[a,b]` and `[b,a]` are the same set and so are one too, which is why the sets
   * are SORTED before they are joined.
   *
   * AN ACTION WITH NO SCOPES IS NOT ITS OWN PERMISSION — measured, not chosen. Github's 43 actions
   * all carry an `oauth2` block with no scopes, and one read consent flipped 43 of 43 to
   * `met: true`. So "no scopes" never meant "needs nothing"; it meant "the connection itself is the
   * grant, and any consent covers this". Such an action is not separately approvable, so it joins
   * no group and this count does not move for it. See {@link BrokerApp.scopedActionCount}.
   */
  permissionCount: number | null;
  /**
   * How many actions carry AT LEAST ONE scope, or null where nobody measured.
   *
   * IT EXISTS BECAUSE WITHOUT IT A MIXED APP LIES BY ARITHMETIC. A toolkit of two actions where one
   * asks for scopes and one asks for none reports `permissionCount: 1` across `actionCount: 2`,
   * which reads as ONE PERMISSION COVERING BOTH — while the second is in fact covered by any
   * approval at all. Those are different facts, and this is the field that tells them apart.
   */
  scopedActionCount: number | null;
  /** How somebody would connect to it. See {@link BrokerConnection}. */
  connection: BrokerConnection;
};

/**
 * What {@link ConnectedAppBroker.ensureAuthConfig} found or did, which decides whether its caller may
 * write the scheme it asked for onto the app's row. See that method.
 */
export type AuthConfigOutcome = "created" | "standing" | "not-needed";

/**
 * What one account holds at one app, in THIS DEPLOYMENT'S OWN VOCABULARY rather than a vendor's row.
 *
 * `action` PLUS A STATE PLUS `scopes` IS OPENBOT'S SHAPE AND NOT ARCADE'S. A provider that grants
 * per action answers one of these per action because that is what it knows; a provider that grants
 * per app answers the same state once per action because that is what IT knows, and neither is
 * reading the other's rows. The four states are what a caller can act on — run it, send them to a
 * consent, tell an operator to set something up, say that nothing could be read — and `unknown`
 * carries its own reason because a state nobody could read is a real answer and not a defensive one.
 *
 * A DEGENERATE ANSWER IS NOT AN ABSENT ONE, which is why {@link ConnectedAppBroker.grantsFor} is on
 * the seam rather than behind a nullable sub-surface. Composio's auth config fixes the scope set
 * when it is created, so every action in a toolkit shares one state and one scope list; N identical
 * entries is the honest rendering of a toolkit-wide grant, not a stub standing in for a missing
 * answer.
 *
 * `authorized` SAYS WHY THE ACTION IS USABLE, BECAUSE TWO DIFFERENT FACTS ANSWER IT. `held` is an
 * authorization this account holds — a consent somebody gave, which a later consent screen is
 * talking about. `not-required` is the vendor publishing no authorization for the action at all
 * (Arcade's `Apollo`): it is usable, and no approval ever withheld it or will ever grant it. Both
 * are `authorized` because both can be called; they are told apart because the consent copy's "approving this
 * approves all N" counts only the first, and an action nobody has to approve is not something an
 * approval covers. REQUIRED, not optional: an absent field would quietly read as one of the two.
 */
export type GrantState =
  | {
      action: string;
      state: "authorized";
      scopes: string[];
      authorization: "held" | "not-required";
    }
  | { action: string; state: "needs-consent"; scopes: string[] }
  | { action: string; state: "needs-operator"; missing: string[] }
  | { action: string; state: "unknown"; reason: string };

/**
 * The CORRELATED, POLLABLE AUTHORIZATION FLOW one provider runs and the other does not.
 *
 * THE LINE THIS SUB-SURFACE FALLS ON IS "THIS BROKER RUNS A CORRELATED, POLLABLE AUTHORIZATION
 * FLOW" — NOT "THIS BROKER CAN START A CONSENT", WHICH BOTH DO. {@link ConnectedAppBroker.authorize}
 * therefore stays top-level and must not be tidied in here: its caller is the Composio connect flow
 * in `routes.ts`, and moving it would either break that route or force Composio to declare this
 * sub-surface, which would make the nullability mean nothing.
 *
 * ASKING THE OTHER PROVIDER FOR THE STATUS OF A MINT IS A CATEGORY ERROR RATHER THAN A HARD
 * QUESTION. Composio mints no correlated authorization to poll, and its return leg is an OAuth
 * callback with state handled in `oauth.ts` and never through the broker. A member that existed only
 * to throw would be a provider branch wearing a type's clothes — which is the charge this seam
 * already met once at `accountName`, two implementations of one member answering different
 * questions. That charge does NOT apply to {@link ConnectedAppBroker.grantsFor}, which does not
 * throw.
 *
 * `status` IS NAMED `status` AND NOT `authorizationStatus`: the sub-surface supplies the noun.
 */
export type AuthorizationFlow = {
  /**
   * Where one minted authorization has got to, by the id the mint answered with.
   *
   * NARROWED TO THESE THREE FIELDS AND NOTHING ELSE. A provider's own status reply carries the live
   * access token it issued and the person's full profile beside it, and neither is something a seam
   * this deployment reads in routes and stores should be able to hand on by accident.
   *
   * `signal` IS OPTIONAL ON THE SEAM AND HONOURED BY THE ADAPTER. The caller polls this on a leg
   * where a browser is held open, and a poll COUNT bounds nothing while each call is unbounded —
   * so the caller gives up on its own schedule and says so here, and the adapter hands the signal
   * to the SDK's request options rather than leaving a socket open against a vendor nobody is
   * waiting on any more. A stub that ignores it is behaving correctly: an abandoned call is still
   * abandoned, the signal only makes the abandonment reach the wire.
   */
  status(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ status: string; userId: string | null; scopes: string[] }>;
  /**
   * Match somebody coming back from the provider's screen to the authorization they left through.
   *
   * `handle` IS AN OPAQUE STRING THIS SEAM DOES NOT INTERPRET. It is minted by the adapter, carried
   * by the return leg and handed back here to be recognised; `flow_id` is Arcade's word for it and
   * stops at the adapter. Nothing here parses it, compares it to a scheme or reads a provider out of
   * it.
   *
   * `{ mismatch: true }` RATHER THAN A THROW, because a handle that belongs to somebody else is an
   * ANSWER: it is exactly the case a return leg has to be able to refuse quietly, and a caller
   * cannot tell it from an outage if both arrive as exceptions.
   */
  confirmReturn(
    q: {
      handle: string;
      vendorUserId: string;
    },
    options?: { signal?: AbortSignal },
  ): Promise<{ authorizationId: string } | { mismatch: true }>;
};

/**
 * What this deployment needs of Composio's broker, and nothing more.
 *
 * A NARROW PROJECTION RATHER THAN THEIR CLIENT, for the reason the transport's `ComposioActions` is
 * one: nine methods is a shape a test satisfies with an object literal, so every test about
 * enablement, connection and revocation is a test about this deployment's logic and none of them
 * reaches the network. The vendor's client would drag its constructor, its retries and its schemas
 * into each of those tests, and the first thing every one of them would do is find a way not to
 * dial.
 */
export type ConnectedAppBroker = {
  /**
   * Whether this provider's grant is held by THIS deployment, as opposed to by the vendor.
   *
   * A DECLARED PROPERTY, AND NEVER A `provider === "arcade"` COMPARISON. Every permission check
   * that has to know where a grant lives reads this field off the broker it was handed; none of
   * them asks which vendor it is talking to. `store.ts:1631` is why: a gate and its exemption
   * keyed on different things there, and the exemption failed OPEN — a duplicate row let a call
   * run for somebody who had connected nothing. A vendor-name comparison inside a permission check
   * is that same shape, two answers to one question that nothing forces to agree, and adding a
   * provider would mean finding every such comparison by hand. A property on the seam makes the
   * answer one value per broker and makes a new broker declare it or fail to type-check.
   *
   * TRUE for Composio, whose connection rows and grants live in this deployment's own tables. That
   * is the behaviour it always had, made explicit here rather than changed.
   */
  grantIsLocal: boolean;
  /**
   * The correlated authorization flow, or a DECLARED `null` where this broker runs none.
   *
   * THE FIELD IS REQUIRED AND THE `null` IS A STATEMENT RATHER THAN AN INFERRED ABSENCE. A broker
   * literal that omits it fails to type-check, which is the whole of what this costs and the whole
   * of what it buys. {@link ConnectedAppBroker.grantIsLocal} is the shape being copied and its
   * docblock argues for it in its own words: an optional-shaped capability read with `?.` or
   * `=== undefined` answers for a broker that never declared anything, which is how a gate and its
   * exemption came to key on different things at `store.ts:1631` and the exemption failed OPEN —
   * a call ran for somebody who had connected nothing. Nine stubs omitting `grantIsLocal` were the
   * evidence; an optional member here would reopen that exact shape one field along.
   *
   * SO A ROUTE REACHES IT WITH `if (!broker.authorizations)` — A PRESENCE TEST ON A VALUE THE
   * BROKER DECLARED, and never a vendor name. Which flow a provider runs is the provider's own
   * answer, stated once on the object it hands over.
   *
   * WHAT IT IS AND IS NOT ABOUT: see {@link AuthorizationFlow}. The line is "this broker runs a
   * correlated, pollable authorization flow", NOT "this broker can start a consent" — both do that,
   * through {@link ConnectedAppBroker.authorize}, which stays top-level.
   */
  authorizations: AuthorizationFlow | null;
  /**
   * What this account holds at this app, action by action.
   *
   * THE NEUTRAL SEAM BOTH PROVIDERS ANSWER, and it is one question rather than two: what does this
   * account hold at this app. A provider that grants per action answers from its own rows; a
   * provider whose auth config fixes the scope set when it is created answers the same state once
   * per action, carrying that config's scopes. The second answer is DEGENERATE AND DEGENERATE IS
   * NOT ABSENT — it is what a toolkit-wide grant honestly looks like through this vocabulary, and
   * an implementation that threw instead would be two implementations of one member answering
   * different questions, which is the real bug this seam already found at `accountName`.
   *
   * {@link GrantState} IS THIS DEPLOYMENT'S VOCABULARY AND NOT A VENDOR'S ROW SHAPE. Nothing here
   * is copied across from a provider's listing; see that type.
   */
  grantsFor(q: { toolkit: string; account: AccountRef }): Promise<GrantState[]>;
  /**
   * The VENDOR'S OWN AUTH PROVIDER a connection for this toolkit is held under, or null where the
   * vendor does not say.
   *
   * IT IS NOT THE TOOLKIT NAME, AND THE COINCIDENCE IS NOT THE RULE. Arcade keys a connection on
   * `(user_id, provider_id)` rather than on a toolkit: one Google provider serves `Gmail` and
   * `GoogleCalendar` both. A provider equals the toolkit slug only where an operator named it that
   * way — which `Github`, `Asana` and `Attio` all happen to do, and those are every toolkit in this
   * tree's fixtures and stubs. So a derivation from the toolkit name, or a fallback to it where the
   * vendor is silent, would pass every test here and be wrong about the deployment it was written
   * for. `null` is the honest answer, and its callers leave such an app out rather than guess.
   *
   * WHAT THIS MEMBER ANSWERS WITH IS THE PROVIDER TYPE, AND `provider_id` NAMES THREE DIFFERENT
   * THINGS ON THREE ARCADE OBJECTS. Measured once, in the 2026-10-13 run of
   * `tests/arcade-live.test.ts` against a live Arcade project; nothing in CI re-checks it (see
   * `docs/plugins/arcade.md`):
   *
   * - on a TOOL LISTING, `requirements.authorization.provider_id` is the provider TYPE (`google`) —
   *   this is the one this member reads, and the one it returns;
   * - on a USER-CONNECTION ROW, `provider_id` is the provider INSTANCE id, an operator's
   *   configuration OF a type (`google-openbot`, `arcade-google`, `cpk-poc`). A refusal envelope's
   *   `"provider_id": "cpk-poc"` is an instance too;
   * - on an AUTH-PROVIDER CONFIG the two sit side by side — `id` is the INSTANCE and `provider_id`
   *   is the TYPE — which is the only bridge between the first two, because a connection row
   *   carries no vendor-type field at all: its `provider_type` is `"oauth2"`, the auth SCHEME.
   *
   * SO A CALLER MUST NOT COMPARE THIS ANSWER TO A CONNECTION ROW'S `provider_id`. `"google"` never
   * equals `"google-openbot"`, so that comparison matched zero rows on every real deployment —
   * Arcade's own defaults included, since those are `arcade-google` and `arcade-github` and never
   * the bare type — and it read as "connected to nothing" rather than as an error. A caller wanting
   * rows expands this type into the SET of configured instance ids of that type first; the Arcade
   * adapter's `connectionsFor` is where that is done and why.
   *
   * NAMED `authProviderOf` AND NEVER `providerIdOf`. In this codebase `provider` means the BROKER —
   * {@link BrokerProvider}, `brokered_connections.provider` — and that collision has already been
   * paid for once, when an audit key `provider` was renamed `authProvider` because it meant the auth
   * provider while a column fifty lines away meant the broker.
   *
   * TOP-LEVEL RATHER THAN ON {@link ConnectedAppBroker.authorizations}, because it is not a step in
   * a flow and it is not a question only one provider can answer. Both answer it; see
   * {@link ConnectedAppBroker.grantsFor} for the same line drawn one member along, and for why a
   * DEGENERATE answer — a vendor whose connections are per toolkit, so a toolkit is its own auth
   * provider and the shared set is always empty — is an answer rather than an absence.
   *
   * CASE IS CARRIED THROUGH UNTOUCHED. Whether two providers are the same provider is the caller's
   * comparison to make, and Arcade's toolkit and action case is never normalised here.
   */
  authProviderOf(toolkit: string): Promise<string | null>;
  /** Every app the catalogue offers, which is what an administrator chooses from. */
  listApps(): Promise<BrokerApp[]>;
  /**
   * Make sure this deployment has an auth config for the app, and SAY WHICH OF THE THREE HAPPENED.
   *
   * IDEMPOTENT, AND CALLED AT ENABLE TIME. An auth config is per-deployment rather than per-person —
   * it is the thing a person's connection is then created against — so the natural moment to create
   * it is when an administrator enables the app, and the natural number of times that moment
   * happens is "more than once": an app can be enabled, removed and enabled again, and two
   * administrators can press the button together. An implementation that created a second config
   * on the second call would leave a person's existing connections pointing at the first one.
   *
   * AND IT USED TO SAY NOTHING, WHICH MADE ITS CALLER WRITE DOWN SOMETHING THAT WAS NOT TRUE. The
   * reuse above is total: an implementation finding a config of its own returns having changed
   * nothing, WHATEVER SCHEME that config was created as. `addBrokeredApp` then recorded the scheme
   * the CATALOGUE resolves today on the app's row — so an app enabled while Composio published only
   * a key, and later given managed OAuth by the vendor, came out of a second press of Add with a
   * row saying `OAUTH2` beside a standing config that is still `API_KEY`. From there the connect
   * form refuses every submission in a sentence about a sign-in screen the app does not have, while
   * `authorize` mints consent links against a key config; and pressing Add again can never repair
   * it, because this method will go on finding that config and returning. Only remove-and-re-add
   * could, which is precisely what the caller's own comment claimed a second press made unnecessary.
   *
   * SO THE ANSWER IS WHETHER THE CALLER MAY RECORD THE SCHEME IT ASKED FOR:
   *
   *   `created`     — a config was made, as `connection`'s scheme. That scheme is now the truth.
   *   `standing`    — one of this deployment's own configs was already there and was left alone, so
   *                   what it was created as is NOT something this call established. The caller must
   *                   keep whatever it already recorded rather than writing what it asked for.
   *   `not-needed`  — the app needs no authentication at all, so there is no config and nothing for
   *                   a recorded scheme to disagree with.
   */
  ensureAuthConfig(config: {
    toolkit: string;
    name: string;
    /**
     * Which flow this app was resolved to, which decides what is created and whether anything is.
     *
     * Passed in rather than read here, because the caller has already resolved it from the
     * catalogue row the administrator chose, and a second derivation is a second answer.
     */
    connection: BrokerConnection;
  }): Promise<AuthConfigOutcome>;
  /**
   * Drop this deployment's own auth configs for the app, which is what removing an app has to do.
   *
   * ITS OWN, WHICH IS A NARROWER PROMISE THAN "THE APP'S". An auth config lives in an operator's
   * Composio dashboard beside any they made by hand there, and removing an app from these pages is
   * not a mandate to delete somebody's dashboard work. An implementation has to be able to tell the
   * two apart before it deletes anything, and to leave anything it cannot claim.
   */
  deleteAuthConfig(toolkit: string): Promise<void>;
  /**
   * Begin one person's connection to one app, answering the url they have to visit.
   *
   * THE URL IS A BEARER CAPABILITY. Whoever opens it attaches an account to this person's
   * connection, so it is neither stored nor logged nor put in an audit row: it is handed to the
   * browser that asked for it and then forgotten. A redirect url in a log is somebody else's
   * mailbox for as long as it stays valid.
   *
   * IT ANSWERS THE MINT'S OWN ID BESIDE THE URL, AND THE ID IS REQUIRED AND NULLABLE, NEVER
   * OPTIONAL. `authorizationId` is the handle the vendor gave this one mint, which is what a
   * return leg is checked against (spec D24: the attempt's id must equal the callback's
   * `auth_id`). An OMITTED field is an inferred absence, and the natural `?? something` at a call
   * site turns "this broker mints no id" into a value — an empty string or a made-up id that a
   * verifier would then compare against. A required nullable field makes the `null` a DECLARED
   * STATEMENT, the same shape {@link ConnectedAppBroker.grantIsLocal} and
   * {@link ConnectedAppBroker.authorizations} have in this file, and a call site that holds a
   * null passes it on as null.
   *
   * IT PAIRS WITH {@link ConnectedAppBroker.authorizations}: a broker declaring `null` there
   * answers `null` here, and a broker declaring a flow answers a non-null id on every successful
   * mint. A broker that grew a flow and forgot the id would leave D24 with no source while every
   * type still checked. A broker's authorization tests must verify this pairing.
   */
  authorize(request: {
    account: AccountRef;
    toolkit: string;
    /**
     * Where the vendor sends this person once the consent screen is done with them.
     *
     * REQUIRED, BECAUSE A CONSENT WITH NO RETURN LEG STRANDS SOMEBODY. Without it the flow ends on
     * Composio's own hosted page: the person has consented, nothing here knows it, and the only
     * way back is for them to find this deployment again by hand. An optional field would have
     * made that the default for whichever call site forgot to pass one, which is exactly the state
     * this parameter exists to end.
     *
     * IT IS AN ADDRESS THIS DEPLOYMENT BUILT AND NEVER ONE A CALLER CHOSE. Whoever names it names
     * where a person lands holding a just-completed consent, so a value taken from a request body,
     * a query or a header would be an open redirect with a consent screen in front of it. The one
     * caller builds it from the deployment's configured app URL and narrows the page within it to
     * a known name, the same way this repository's own OAuth `returnTo` is narrowed.
     *
     * AND `string` IS THE WHOLE OF WHAT THE TYPE CAN PROMISE, WHICH IS WHY
     * {@link brokerReturnUrl} EXISTS. "Required" above means "not optional", and `""`, `"   "` and
     * `openbot.example.com/settings/...` are all required values: they satisfy this field and
     * reach the vendor as a callback nobody returns through. Nor can a narrower type fix it — the
     * address is assembled at run time from an environment variable, so the caller holds a
     * `string` and every type an ordinary `string` is assignable to admits the empty one too. The
     * promise this comment makes is therefore kept by the guard below, and a caller hands its
     * address through that before it hands it here.
     */
    returnUrl: string;
    /**
     * The one action this consent is being begun for, for a vendor that grants per action.
     *
     * OPTIONAL, AND IGNORABLE. An adapter whose vendor grants per app, as Composio does, has no use
     * for it and drops it without throwing: handing an action to a broker that cannot use it is
     * not an error, and a caller need not know which kind of broker it holds to call this.
     *
     * `returnUrl` ABOVE STAYS REQUIRED ON THE SEAM EVEN SO. An adapter whose vendor answers with
     * its own return leg may ignore it, but the seam does not relax for that: the next adapter
     * that needs it must not find the field optional because the last one did not.
     */
    action?: string;
  }): Promise<{ redirectUrl: string; authorizationId: string | null }>;
  /** Whether this account is currently attached to this app at the vendor. */
  isConnected(request: {
    account: AccountRef;
    toolkit: string;
  }): Promise<boolean>;
  /**
   * Ask the vendor to withdraw this account's grant, answering WHAT WAS ACTUALLY ASKED.
   *
   * True where this deployment found at least one account and asked the vendor to revoke it, false
   * where there was none to withdraw — not "the call did not throw". The audit trail records that
   * answer as `mcp.account_disconnected`'s `vendorRevocationRequested`, and the whole value of that
   * field is that a reader can tell an account this deployment acted on from one that outlives it
   * somewhere else. A boolean that always said true would make the row a worse record than no row.
   *
   * "REQUESTED" IS AS FAR AS ANY IMPLEMENTATION CAN HONESTLY GO, and the name of the field says so
   * because the first one did not. This boolean used to be called `vendorRevoked` and was written
   * by an adapter that soft-deleted the account and asked for no revocation at all, so a trail that
   * said a grant had been withdrawn recorded one that was still live at Google. What a broker can
   * promise synchronously is that the account is gone at the broker — nothing here can call with it
   * again — and that the upstream withdrawal was asked for; whether the provider honoured it
   * happens afterwards, out of sight of the call that asked. A field that claimed the stronger
   * thing would be the one row in the trail nobody could rely on.
   *
   * A PARTIAL ASK IS A FAILURE RATHER THAN A TRUE. One person can hold more than one account for
   * one app, and an implementation that ended some of them and could not end the rest has not
   * disconnected anybody: their app still answers. It must throw, so that the row this deployment
   * holds — the only thing that names which app to try again against — is still standing when they
   * press disconnect a second time.
   */
  revoke(request: { account: AccountRef; toolkit: string }): Promise<boolean>;
  /**
   * What this app asks a person to type, as Composio publishes it for the scheme.
   *
   * ASKED OF THE VENDOR RATHER THAN WRITTEN DOWN HERE, which is the whole reason it is a call and
   * not a constant. The fields are per app and they move: a form built from one hard-coded "API
   * key" box is right for Firecrawl and wrong for the app that also wants a workspace subdomain,
   * and wrong quietly — the person fills in what they were shown, a connection is created without
   * the value nobody asked them for, and the first tool call is what discovers it. The `help` on
   * {@link BrokerField} is the vendor's own sentence written for the person filling the box in, and
   * it is worth more than anything this deployment could invent about somebody else's console.
   *
   * THE SCHEME IS PASSED IN RATHER THAN RESOLVED HERE, for the reason {@link
   * ConnectedAppBroker.ensureAuthConfig} takes a connection rather than deriving one: the caller
   * already holds the scheme recorded on the app's row at enable time, and a second derivation is a
   * second answer — a form drawn for `BASIC` in front of a config created for `API_KEY`, whose
   * fields the person cannot fill in because they are not the ones their app has.
   */
  connectionFields(request: {
    toolkit: string;
    authScheme: FieldScheme;
  }): Promise<BrokerField[]>;
  /**
   * Connect this person with the secret they typed, answering the account it made.
   *
   * THE ONE CALL WHOSE IMPLEMENTATION MUST RETHROW WITH NO `cause`, WHICH IS AN INVERSION OF THE
   * STANDING RULE AND SAYS SO ON PURPOSE. The rule `composio-adapter.ts` states and every path here
   * keeps is that a vendor error is never logged and always carried as `cause`, precisely because
   * the object holds the request it was made for and whoever is reading a log rather than a page
   * deserves it. On every other call that request is a link mint or a delete. On this one it is
   * somebody's API key. So this is the single place the rule reverses: read the vendor's sentence
   * through the existing door, then drop the object entirely rather than attach it.
   *
   * WHAT THAT COSTS IS THE DIAGNOSTIC TRAIL ON THE FLOW PEOPLE MOST OFTEN MISTYPE, AND THE COST IS
   * ACCEPTED KNOWINGLY. A key pasted with a newline, a token from the wrong workspace, a secret for
   * the staging tenant — these are the ordinary failures here, and they are the ones this leaves
   * nothing behind about. What an operator gets instead is Composio's own sentence and the request
   * id inside it, which is enough to ask the vendor about that attempt and not enough to rebuild it
   * here. A `cause` that made the next mistyped key easier to explain would put every correctly
   * typed one in a log for as long as the log is kept.
   *
   * THE `accountId` IS ANSWERED SO A CALLER CAN UNDO EXACTLY THIS ACCOUNT. A connection made from
   * typed fields is verified before it is kept, and a verification has to be able to take back the
   * thing it just made and nothing else. {@link ConnectedAppBroker.revoke} is the wrong instrument for
   * that — it ends every account this person holds for the app, which is right for somebody ending
   * their access and wrong for a step undoing its own work. The two differ exactly when the local
   * row and Composio have drifted apart: the person already had a connection that works, this
   * attempt made a second one, the verification failed — and a sweep there takes down the
   * connection that was working. See {@link ConnectedAppBroker.revokeAccount}.
   */
  connectWithFields(request: {
    account: AccountRef;
    toolkit: string;
    authScheme: FieldScheme;
    /**
     * What the person typed, keyed by the `name` {@link BrokerField} was published under.
     *
     * THE ONLY SECRET THAT CROSSES THIS SEAM, which is what the no-`cause` rule above is about. The
     * names are sent back on the wire verbatim and are never shown; the values are the person's own
     * credential and belong in no message, no log and no audit row, for the reason the connect url
     * does not.
     */
    values: Record<string, string>;
  }): Promise<{ accountId: string }>;
  /**
   * End ONE account by id, and ask for the grant behind it to be withdrawn too.
   *
   * ONE, WHICH IS THE WHOLE DIFFERENCE FROM {@link ConnectedAppBroker.revoke}. That method sweeps every
   * account a person holds for an app, because what it serves is a person ending their access to
   * it. This serves a caller undoing an account it just made, and the id is the whole of what it
   * names — nothing is listed, nothing is matched, and no account this call was not handed can be
   * reached by it. The narrower instrument exists because the wider one is destructive in precisely
   * the case a verification runs into: a working connection standing beside a failed second
   * attempt.
   *
   * WITH `revoke_on_delete`, WHICH IS WHAT MAKES IT A WITHDRAWAL RATHER THAN A RECORD-KEEPING
   * SOFT-DELETE. Without that flag the account stops being visible to this deployment and the
   * credential at the far end stands — which is the exact state {@link ConnectedAppBroker.revoke}
   * records this deployment once claiming as a revocation, and it is worse here than there: the
   * secret left live is one a person typed minutes ago into a form that then told them the
   * connection had not been kept.
   *
   * NO BOOLEAN, BECAUSE THERE IS NOTHING TO COUNT. `revoke` answers what it found because it
   * searches for it; this is handed the id of an account created moments earlier by the call that
   * answered it, so "there was nothing there" is not an outcome a caller chooses between — it is a
   * failure, and it throws like any other.
   *
   * AND NOTHING IN `store.ts` CALLS IT TODAY, WHICH IS A DECISION AND NOT AN OVERSIGHT. Its one
   * caller was `connectBrokeredWithFields`, undoing the account it had made when the check on that
   * account came back an error — and the premise, that such an error is the vendor rejecting the
   * credential, does not hold: the envelope the verdict is read out of carries no status and no
   * error code, so a rate limit on the check destroyed valid connections. See `BrokeredProbe` in
   * `store.ts`. The capability is kept, tested and ready: if Composio ever publishes something that
   * separates "this key is wrong" from "this call failed", the undo becomes correct again for the
   * first of those and this is what it will be made with. Until then, nothing here may reinstate
   * it on the evidence that is actually available.
   */
  revokeAccount(accountId: string): Promise<void>;
  /** The vendor's display name for the connected account, when it publishes one; null otherwise. */
  accountName(request: {
    account: AccountRef;
    toolkit: string;
  }): Promise<string | null>;
};

/**
 * @deprecated Kept for one release while callers move to {@link ConnectedAppBroker}.
 */
export type ComposioBroker = ConnectedAppBroker;

/**
 * A refusal this deployment authored, whose own message is the whole explanation.
 *
 * THE ROUTE CANNOT TELL AN AUTHORED REFUSAL FROM A VENDOR OUTAGE WITHOUT A TYPE, which is the only
 * reason this class exists. `routes.ts` answers a thrown broker error by reaching into it for the
 * vendor's own sentence and, finding none, saying what a vendor failure deserves to be told —
 * "Composio said nothing about why, check the key, check their status". That advice is wrong twice
 * over for a sentence this deployment wrote itself: Composio was reachable, answered, and the thing
 * that has to change is here rather than there. Every refusal raised below this line is written for
 * the person who will read it and names the step that fixes it, so the one correct thing a route
 * can do with it is pass it through.
 *
 * WHICH MAKES THE CLASS A PROMISE ABOUT THE MESSAGE rather than a category of failure. Nothing is
 * raised as one of these unless its sentence is safe to show anybody who could have made the
 * request — no url that is a bearer capability, no key, no vendor object — because that is exactly
 * what raising it asks the route to do. A failure this file cannot explain stays a plain `Error`,
 * so the route keeps reaching for the vendor's own words instead of inventing better ones.
 */
export class BrokerRefusalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrokerRefusalError";
  }
}

/**
 * The state a deployment with no Composio key is in, raised rather than returned.
 *
 * A STATE, NOT A FAULT, in the same sense `./composio`'s unconfigured listing is one: unset
 * `COMPOSIO_API_KEY` is the documented default, and where it is unset there is nothing to connect,
 * nothing to grant and no brokered tool for a Bot to call — what is left on screen is one row that
 * goes nowhere, under More apps on the admin Plugins page, naming the setting rather than hiding
 * the feature. It is a thrown class rather than a null answer because the broker's methods
 * answer apps, booleans and urls, and there is no value in any of those shapes that means "nobody
 * was asked" — an empty app list is indistinguishable from a catalogue outage, and `false` from
 * {@link ConnectedAppBroker.isConnected} is a positive claim about somebody's account.
 *
 * The setting is named in the message because the message is usually the whole remedy: an operator
 * reading it needs the name of the variable to set, and the one other place this deployment names
 * it is that row on the admin Plugins page, which somebody meeting this error through the API may
 * never have seen.
 *
 * A {@link BrokerRefusalError} BECAUSE IT IS THE ORIGINAL ONE. It was the only authored refusal a
 * route could recognise when this file had one class, and it is a refusal of exactly that kind: a
 * sentence written here, naming the step that fixes it. Keeping its own name is what lets a caller
 * ask for this one state in particular — `store.ts` raises it by name, and `routes.ts` sends its
 * message where no call was made at all.
 */
export class BrokerUnconfiguredError extends BrokerRefusalError {
  /**
   * BOTH ARGUMENTS ARE REQUIRED, AND THAT IS THE FIX. This used to default to Composio, so a call
   * site that passed nothing put `COMPOSIO_API_KEY` on an Arcade deployment. An omission is a
   * compile error now: every site must say which provider it means and who is reading.
   *
   * `reader` IS WHO THE SENTENCE IS FOR. An `operator` can set an environment variable, so the
   * sentence names the ACTIVE provider's variable (from {@link BROKERED_PROFILE}). A `person` can
   * set nothing, and a vendor they do not use and a key they cannot reach is the vendor
   * vocabulary spec D11 keeps off their screen, so theirs names neither.
   */
  constructor(provider: BrokerProvider, reader: "operator" | "person") {
    const { vendor, envVar } = BROKERED_PROFILE[provider];
    super(
      reader === "person"
        ? "Connecting apps isn't set up yet, so nothing was asked. Ask an admin to set it up."
        : `${vendor} is not configured for this deployment, so nothing was asked. Set ${envVar} to make the brokered apps available; until it is set there is nothing to connect, nothing to grant and no ${vendor} tool for a Bot to call, and the admin Plugins page shows one row under More apps that goes nowhere.`,
    );
    this.name = "BrokerUnconfiguredError";
  }
}

/**
 * An account this deployment still has a row for and the vendor no longer holds.
 *
 * ITS OWN CLASS BECAUSE IT IS THE ONE VENDOR CONDITION A PERSON CAN FIX FROM THE CONVERSATION. A
 * grant withdrawn at the provider and an account removed in Composio's dashboard both arrive like
 * this, nothing on this deployment records either — the `brokered_connections` row still stands and
 * the app still reads as ready — and connecting again is the whole remedy. Telling it apart by type
 * is what lets the tool call that met it hand the transcript a card with Reconnect on it instead of
 * a sentence naming a settings page, without anything matching on the sentence.
 *
 * A {@link BrokerRefusalError} because it keeps that class's promise about the message, and because
 * every reader that already prefers an authored sentence goes on preferring this one.
 */
export class BrokerAccountGoneError extends BrokerRefusalError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrokerAccountGoneError";
  }
}

/**
 * An account the vendor ALREADY HOLDS for this person and this app, met while beginning another.
 *
 * {@link BrokerAccountGoneError} TURNED AROUND, AND ITS OWN CLASS FOR THE SAME REASON. That one is
 * a row this deployment still has over an account the vendor no longer holds; this one is an
 * account the vendor holds under a row this deployment does not have. A fresh install, an upgrade
 * that lost the table, or a second install signing in as the same person against the same vendor
 * key all arrive here, and the person sees an app drawn as not connected that the vendor refuses to
 * connect a second time. Telling it apart by type is what lets the connect route ask the vendor
 * once more and RECORD the account it already holds, which is the confirm route's own act, instead
 * of handing the person a refusal that names a Disconnect button their page does not show.
 *
 * A {@link BrokerRefusalError} because it keeps that class's promise about the message, so a
 * reader that never learned this class still passes on a sentence this deployment wrote.
 */
export class BrokerAccountHeldError extends BrokerRefusalError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrokerAccountHeldError";
  }
}

/**
 * A return address that could not bring anybody back, refused before a consent is spent on it.
 *
 * ITS OWN CLASS BECAUSE ITS REMEDY IS ITS OWN. Every other refusal in this file is about the broker
 * — a key that is not set, a config this deployment never made, a consent the vendor answered with
 * no page. This one is about this deployment's own address for itself, and the reader who can act
 * on it is an operator with `OPENBOT_APP_URL` in front of them. A caller that could not tell the
 * two apart would send somebody to check a vendor key that is perfectly fine.
 *
 * A {@link BrokerRefusalError} because it keeps that class's promise about the message: the sentence
 * is written here, names the step that fixes it, and carries no url. Which matters more than usual
 * for this one — the value it is refusing is the thing a bad message would be tempted to quote, and
 * an address is the half of a connect link that says which deployment and which person it is for.
 *
 * TWO SENTENCES, BECAUSE THE READER WHO MEETS THIS IS NOT THE READER WHO CAN FIX IT, and that is
 * the whole of what this class now settles. Both call sites are `requireUser` routes: whoever reads
 * `message` is somebody who pressed Connect, and `OPENBOT_APP_URL` is an environment variable they
 * cannot set and a vendor name is vocabulary spec D11 keeps off their screen — the same division
 * {@link BrokerUnconfiguredError} draws between its `person` and its `operator`. So `message` says
 * what happened and who to ask, and {@link operatorMessage} — which the route logs rather than
 * answers — names the ACTIVE provider and the variable. A single sentence had to fail one of them,
 * and the one it failed was the person: it spelled `Composio` as a literal on a function that took
 * no provider, so the Arcade deployments that are the only ones able to reach the authorize route's
 * refusal were told their failure involved a vendor they do not use.
 *
 * THE OPERATOR'S HALF IS HELD AND NOT RAISED, so {@link brokerSentence} keeps answering with the
 * safe sentence and a route that passes a refusal through cannot pass this one through by accident.
 * Neither half quotes the address, for the reason given on {@link brokerReturnUrl}: a log line is
 * one of the places that message was always promised not to reach.
 */
export class BrokerReturnUrlError extends BrokerRefusalError {
  /**
   * The same refusal written for whoever can act on it, for a log and never for a response body.
   */
  readonly operatorMessage: string;

  constructor(provider: BrokerProvider, address: "unbuilt" | "not-a-web-page") {
    const { vendor } = BROKERED_PROFILE[provider];
    super(
      address === "unbuilt"
        ? "OpenBot has no address to bring you back to, so connecting didn't start. Nothing was asked of your account. Ask an admin to set OpenBot's address."
        : "OpenBot's return address isn't a web address, so connecting didn't start. Nothing was asked of your account. Ask an admin to fix OpenBot's address.",
    );
    this.operatorMessage =
      address === "unbuilt"
        ? `This deployment built no address for ${vendor} to send a person back to, so the connection was not begun rather than begun with nowhere to land. Set OPENBOT_APP_URL to the address this deployment's pages are served from, and connecting an app will have a return leg.`
        : `The address ${vendor} would send a person back to is not a web address, so a consent granted there would end on ${vendor}'s own page with no way back here. Set OPENBOT_APP_URL to this deployment's own origin including the scheme — https://openbot.example.com rather than openbot.example.com.`;
    this.name = "BrokerReturnUrlError";
  }
}

/**
 * The address a person comes back to, checked to be one, or a refusal instead of a link.
 *
 * BEFORE THE CONSENT RATHER THAN AFTER IT, which is the entire value of doing this at all. Past this
 * point the next thing that happens is a vendor page and somebody granting a third party access to
 * their mailbox; a callback that is not a callback is only discovered once they have, by which time
 * the thing that would tell them what went wrong is on the deployment they can no longer reach. So a
 * caller that has no usable address gets a refusal in place of a link, and nobody spends a consent.
 *
 * TWO REFUSALS, BECAUSE THEY ARE TWO DIFFERENT MISTAKES. An empty address is a caller that built
 * none — the guard in front of this one did not run, or ran against the wrong value. An address that
 * is not a web page is a configured one that cannot work: `OPENBOT_APP_URL` set to
 * `openbot.example.com`, which no browser can resolve from the vendor's origin, or to `localhost:3001`,
 * where `localhost:` is read as the scheme. Both are reachable from the settings this deployment
 * actually ships — the variable is an environment string and nothing between it and the vendor looks
 * at it — and both end with the same person on the same hosted page with nowhere to go.
 *
 * IT NAMES THE SETTING AND NOT THE VALUE. The setting is the remedy, and it is the same one whether
 * the address arrived empty or malformed; the value is a page address for one person's connection
 * and belongs in no message, no log and no audit row, for the reason the connect url does not. And
 * it names it to the OPERATOR ALONE: the provider passed in picks that reader's vendor, while the
 * sentence the person reads names neither it nor the variable, which {@link BrokerReturnUrlError}
 * argues at length.
 *
 * WHAT COMES BACK IS THE ADDRESS THAT WAS CHECKED, WHICH IS NOT ALWAYS THE STRING THAT WENT IN. The
 * check reads a parsed address: the emptiness test trims, and parsing drops the spaces and control
 * characters a URL cannot contain — so ` https://openbot.test/…`, an address ending in a newline and
 * one with a tab inside its host all satisfy this guard while denoting something else entirely. A
 * version that approved the parsed address and returned the raw one approved nothing: the padding
 * travelled on to the vendor as part of the callback, which is the person stranded on a vendor page
 * that this function exists to prevent. Returning what was read is what makes the reading binding.
 *
 * THAT IS A READING OF THE ADDRESS AND NOT A CHOICE ABOUT IT. Where somebody lands holding a
 * just-completed consent is a decision this seam keeps in one place, so the destination is still
 * the caller's; a parsed address names the same place a browser handed the original would have gone
 * — the padding was never part of the destination, only of the string. What this cannot do is guess
 * at an address that means nothing, which is why the branch above refuses rather than repairs: a
 * missing scheme is a setting to fix and not whitespace to drop.
 */
export function brokerReturnUrl(
  returnUrl: string,
  provider: BrokerProvider,
): string {
  if (returnUrl.trim() === "") {
    throw new BrokerReturnUrlError(provider, "unbuilt");
  }
  const address = webAddress(returnUrl);
  if (address === null) {
    throw new BrokerReturnUrlError(provider, "not-a-web-page");
  }
  return address.href;
}

/**
 * The address a browser on somebody else's origin could follow — absolute, and http or https — and
 * null for anything else.
 *
 * It answers with the parsed address rather than a boolean so that the one caller can hand back what
 * was actually examined. A predicate would leave the caller holding only the string it was given and
 * no way to tell it apart from the address that string denotes.
 */
function webAddress(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:"
    ? parsed
    : null;
}

/**
 * The broker failures worth explaining to a reader, and null for every other one.
 *
 * NULL RATHER THAN A FALLBACK SENTENCE, which is the whole reason this is a function instead of an
 * `error.message` read at each call site. The only failures whose message this module can vouch for
 * are the ones raised as a {@link BrokerRefusalError}, which is a promise its subclasses make about
 * what they say; a socket that hung up, a 500 from the catalogue and a rate limit are all failures
 * it knows nothing about. A function that answered those with `error.message` would be putting a
 * vendor's object, and whatever it happens to carry, in front of whoever asked.
 *
 * So the caller chooses what to say about a failure it actually has, and this decides only the
 * cases it can decide. The raised error's own message is returned rather than a copy, so there is
 * one wording of each remedy and it lives beside the code that raises it.
 */
export function brokerSentence(error: unknown): string | null {
  return error instanceof BrokerRefusalError ? error.message : null;
}

/** What configuration says about which broker is active, INCLUDING why it says nothing. */
export type ProviderDecision =
  | { kind: "active"; provider: BrokerProvider }
  /** No key is set: this deployment has no broker and never had one through configuration. */
  | { kind: "unconfigured" }
  /**
   * Both keys are set and `OPENBOT_BROKER_PROVIDER` names neither, so configuration proposes two
   * providers and chooses between them nowhere. A legal state — `docs/plugins/arcade.md` says so,
   * and a migrating deployment passes through it — and the one an answer must never be invented
   * for.
   */
  | { kind: "ambiguous"; configured: BrokerProvider[] }
  /** `OPENBOT_BROKER_PROVIDER` names a provider whose key is unset: an operator's typo. */
  | { kind: "misnamed"; named: BrokerProvider };

/**
/**
 * A KEY OF NOTHING IS NO KEY.
 *
 * `ARCADE_API_KEY=` with nothing after it, or a value that is all whitespace, is an operator typo
 * and not a configured credential. Exported because {@link providerDecision}, {@link activeProvider}
 * and `./provider-wiring`'s ambiguity refusal must agree on it exactly: wiring decides that both
 * keys are set and the deployment cannot say which vendor is live, and if it counted a blank key as
 * set while these did not, it would tell an operator holding two EMPTY keys that both are
 * configured. One definition, so they cannot drift apart.
 *
 * `./config` trims every optional environment value and so happens to turn those into `undefined`
 * today, but that is one incidental guard in a distant module standing between a typo and a client
 * built on "", and these functions take config-shaped VALUES rather than an environment, so every
 * other caller (a test, an embedder, a future loader) reaches them untrimmed. What "configured"
 * means for a credential is answered here.
 */
export const credential = (key: string | undefined): boolean =>
  key !== undefined && key.trim() !== "";

/**
 * Which broker this deployment runs, from configuration alone (no database access), AND WHY WHEN
 * NOTHING DOES.
 *
 * THE THREE CAUSES ARE NOT ONE CAUSE, which is why this answers a decision rather than
 * `BrokerProvider | null`. "No key set" is a deployment with no broker and no brokered row of its
 * own; "both keys, nothing named" is a migration in progress, with live rows at one vendor or the
 * other and nothing in configuration saying which; "named but unkeyed" is a typo that must stop the
 * server. A single `null` made all three the same value, and every caller that then wrote
 * `?? "composio"` turned the second one — the only one that can hold Arcade rows — into "Composio
 * is active", which filtered those rows out of existence and left the accounts behind them
 * unrevokable.
 *
 * One key set selects that provider. Both set is legal and expected, since ending an account at the
 * old vendor needs its key, so `brokerProvider` decides between them.
 */
export function providerDecision(c: {
  composioApiKey?: string;
  arcadeApiKey?: string;
  brokerProvider?: BrokerProvider;
}): ProviderDecision {
  const configured: BrokerProvider[] = [];
  if (credential(c.composioApiKey)) configured.push("composio");
  if (credential(c.arcadeApiKey)) configured.push("arcade");
  const named = c.brokerProvider;
  if (named !== undefined) {
    return configured.includes(named)
      ? { kind: "active", provider: named }
      : { kind: "misnamed", named };
  }
  if (configured.length === 1)
    return { kind: "active", provider: configured[0] as BrokerProvider };
  return configured.length === 0
    ? { kind: "unconfigured" }
    : { kind: "ambiguous", configured };
}

/**
 * The active provider, or `null` for every deployment where configuration names none.
 *
 * KEPT FOR THE CALLERS THAT GENUINELY ASK A YES/NO QUESTION — "is there a broker to wire" — and
 * nothing more. A caller that has to NAME a provider when this answers null is asking the question
 * {@link providerDecision} answers, and must take the three causes apart instead of defaulting one
 * of them to a vendor.
 */
export function activeProvider(c: {
  composioApiKey?: string;
  arcadeApiKey?: string;
  brokerProvider?: BrokerProvider;
}): BrokerProvider | null {
  const decision = providerDecision(c);
  return decision.kind === "active" ? decision.provider : null;
}

/**
 * Activating a provider is refused while the OTHER provider still holds `brokered_connections` rows.
 *
 * KEYED ON ROWS, NOT ON KEYS, AND THAT IS THE WHOLE POINT. Both keys set is a legal and expected
 * state, because ending an account at the old vendor needs its key, so a deployment holding both is
 * never misconfigured. What a deployment must not be able to do is switch by editing its environment:
 * `DELETE /servers/:id/connection` revokes at the vendor before it deletes anything local, and a
 * deployment that swapped keys would hold rows for accounts it could no longer end.
 *
 * TAKES A COUNT, NOT A DATABASE. The caller counts the rows belonging to the provider that is not
 * `candidate`; this reads no key, never calls {@link activeProvider} and imports no vendor package.
 */
export function assertActivatable(
  candidate: BrokerProvider,
  otherProviderRows: number,
): void {
  const other = candidate === "arcade" ? "Composio" : "Arcade";
  const self = candidate === "arcade" ? "Arcade" : "Composio";
  /*
   * A COUNT THAT IS NOT A COUNT REFUSES, AND IS NEVER REPEATED BACK. `NaN <= 0` is false, so a
   * `<= 0` test alone lets a NaN through to the sentence below, where it reads as the literal
   * words "NaN brokered connections" — a refusal that tells a person a number they cannot act on.
   * A negative or fractional count is the same failure wearing different clothes: whatever
   * produced it was not counting rows. So the only counts allowed past here are the ones a row
   * count can actually be, and anything else refuses saying what is true — the count was not
   * taken — rather than printing the sentinel it was handed.
   *
   * REFUSING, NOT PROCEEDING, because this guard exists to keep a deployment from reaching the
   * vendor with rows it could no longer revoke. Not knowing how many rows the other provider
   * holds is not the same as knowing it holds none.
   */
  if (!Number.isInteger(otherProviderRows) || otherProviderRows < 0) {
    throw new BrokerRefusalError(
      `${self} cannot be activated: the connections belonging to ${other} could not be counted. Keep both API keys set, check that the database is reachable, and start again; activating without that count could leave accounts nobody can revoke.`,
    );
  }
  if (otherProviderRows === 0) return;
  throw new BrokerRefusalError(
    `${self} cannot be activated while ${otherProviderRows} brokered connection${otherProviderRows === 1 ? "" : "s"} still belong${otherProviderRows === 1 ? "s" : ""} to ${other}. Keep ${other} active — its API key set and OPENBOT_BROKER_PROVIDER=${other.toLowerCase()} — and end those connections first: each person disconnects their own on the connected-accounts page, an administrator disconnects a Shared app's account, or an administrator removes an app, which ends every account connected to it. There is no single action that ends them all. Switching providers by changing the environment would leave accounts nobody can revoke.`,
  );
}
