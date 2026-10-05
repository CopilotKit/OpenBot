/**
 * Does this deployment's Composio key actually open Composio?
 *
 * `server/tests/composio-live.test.ts` asks what the vendor does; this asks what THIS KEY can see.
 * They are different questions and only the second one is about an operator's own account: a key
 * with no project behind it, a project that cannot see the app, or a person who never finished the
 * consent page all produce a product that looks configured and answers nothing. So everything below
 * is a read, and every read is one an operator would otherwise make by clicking around Composio's
 * dashboard.
 *
 * IT SEPARATES TWO STATES AND NOT THREE, WHICH IS A CORRECTION TO WHAT THIS DOCBLOCK USED TO CLAIM.
 * The promise was that a key with no project, an app with no authorization config, and an unfinished
 * consent were told apart. Two of those are: the catalogue read answers for the KEY, and the
 * connection read answers for the PERSON. The third was never delivered — nothing here reads an auth
 * config, so an app this deployment has no config for and a person who never consented both print
 * the same "no live connection" line, and the line now names both rather than asserting the second.
 *
 * IT IS NOT READ BECAUSE THERE IS NOTHING HERE TO READ IT WITH, AND THAT IS THE HONEST REASON.
 * `server/src/plugins/broker.ts` gives this script `ensureAuthConfig` and `deleteAuthConfig`, both of
 * which WRITE, and no listing at all; a diagnostic that called the first would create the very object
 * it was asked whether anybody had created, and a read-only diagnostic may not do that. Making the
 * distinction real therefore means a new read on that seam and in its adapter — a change to
 * `server/src`, not to this file, and one nobody should infer from a docblock. Until it exists, an
 * operator separates the two on the app's page under `/admin/plugins`, which is where enabling an app
 * creates the config.
 *
 *     COMPOSIO_API_KEY=... bun run composio:smoke -- --user <id> [--call]
 *
 * IT MINTS NO CONNECT LINK AND CREATES NO SESSION. `broker.authorize` answers a url that attaches
 * an account to whoever opens it, so a diagnostic that printed one would be leaving somebody's
 * mailbox in a terminal scrollback and in whatever captured it; this script never calls it, and a
 * person connects in their own browser through the product instead. Sessions are the other half:
 * `createComposioClient` builds a plain per-call client — see the boundary written down at the top
 * of `server/src/plugins/composio-adapter.ts` — and nothing here reaches past it.
 *
 * THE KEY IS NEVER PRINTED. It is read once, handed to {@link createComposioClient}, and after that
 * every line this script writes goes through {@link redact}, which takes it back out. That is belt
 * and braces on purpose: the adapter promises not to quote the key, but a vendor exception is a
 * foreign object and "this SDK does not put the key in an error" is not a promise this file is in a
 * position to make on the SDK's behalf. Which is why NO vendor call below is made bare — an
 * unhandled rejection, or a synchronous throw nothing caught, is printed by the runtime rather than
 * by this file, and that is the one way out past the redactor. {@link ask} closes it for the reads,
 * which are awaited, and {@link build} closes it for the client constructor, which is not: it was
 * the single call still outside the guarantee, and "every vendor call except one" is not a promise
 * worth making.
 *
 * WHICH STREAM A LINE GOES TO IS DECIDED BY THE EXIT CODE IT EXPLAINS, and that is the whole rule:
 *
 *     A line that explains a non-zero exit is written to STDERR. Every other line is written to
 *     STDOUT.
 *
 * So `smoke > report.txt` keeps a report of what this key can see, and every reason the command
 * failed is still on the terminal beside it. {@link say} is stdout and {@link stop} is stderr, and
 * because {@link stop} exits, no line can be on the wrong one by accident. The rule decides the last
 * pair too: an action that ran and failed puts its own outcome and its log id on stderr, because
 * those two lines are the whole explanation of the 1 this command exits with. The usage and the
 * missing-key refusal are the same rule reached before there is a key to redact, which is why they
 * are the only two that write to the stream directly.
 */
import type { BrokerConnection } from "../server/src/plugins/broker";
import {
  type ComposioResult,
  effectOf,
  LISTING_LIMIT,
  unexplained,
  VENDOR_PLACEHOLDER,
  vendorSentence,
} from "../server/src/plugins/composio";
import { createComposioClient } from "../server/src/plugins/composio-adapter";

/**
 * The app the numbers below are about.
 *
 * One app rather than all of them, because the question is whether a real connection works and a
 * person only ever has one app connected at a time when they are debugging this. Gmail because it
 * is the app this deployment's Composio work has been written against throughout, and because its
 * action count is large enough that a truncated or "important"-filtered listing shows up as an
 * obviously wrong number rather than as a plausible one.
 */
const APP = "gmail";

/**
 * The one action `--call` runs, and why it is safe to run against somebody's real account.
 *
 * A profile read: it answers the address and the message counts, and it touches no message. The
 * slug is named rather than discovered so that what a `--call` does is readable here instead of
 * depending on whatever Composio happens to list first — but the name is not the guarantee. The
 * guarantee is the {@link effectOf} check below, which reads the vendor's own behaviour label at
 * call time and refuses anything that is not marked read-only.
 */
const READ_ACTION = "GMAIL_GET_PROFILE";

const args = process.argv.slice(2);
const userFlag = args.indexOf("--user");
const given = userFlag === -1 ? undefined : args[userFlag + 1];
/*
 * A value that is itself a flag is a missing id rather than a strange one: `--user --call` reads
 * as somebody who forgot the id, and taking `--call` as the user would ask Composio about a person
 * who does not exist and report "no connection" as though that were a finding about them.
 */
const user = given?.startsWith("--") ? undefined : given;
const call = args.includes("--call");

/*
 * The two refusals below are the file's stream rule reached before there is a key to redact, which
 * is the only reason they write to stderr themselves instead of through {@link stop}. Both explain
 * a non-zero exit, so both belong there; neither can be carrying a credential, because one is a
 * constant and the other is only reached when the variable is empty.
 */
if (!user) {
  console.error(
    "Usage: COMPOSIO_API_KEY=... bun run composio:smoke -- --user <id> [--call]\n\n" +
      "The user id is the one this deployment sends Composio as the person a call is for — the\n" +
      "same id `composio_connections` records. --call additionally runs one read-only action as\n" +
      "that person, which only works once they have connected the app in their own browser.",
  );
  process.exit(2);
}

const configured = process.env.COMPOSIO_API_KEY?.trim();
if (!configured) {
  console.error(
    "COMPOSIO_API_KEY is empty or unset, so there is nothing to ask Composio with and every answer below would be an absence rather than a finding. Run it as COMPOSIO_API_KEY=... bun run composio:smoke -- --user <id>.",
  );
  process.exit(1);
}
/*
 * Rebound so that {@link redact}, which is a closure and therefore outside the narrowing above, holds
 * a `string` by declaration rather than by a cast. A cast would be the wrong tool twice over: it
 * asserts what the refusal above already proved, and this is the one variable in the file where
 * silencing the type checker is least welcome.
 */
const key: string = configured;

/**
 * Every line this script writes, with the key taken back out of it.
 *
 * A plain `split`/`join` rather than a regular expression, because a key is an arbitrary string and
 * building a pattern out of one is how a `+` or a `.` in a credential turns a redaction into a
 * mismatch. Applied to the vendor's words as well as to this file's own: the only lines that carry
 * text nobody here wrote are the failure lines, which are exactly the ones worth guarding.
 */
function redact(line: string): string {
  return line.split(key).join("<COMPOSIO_API_KEY>");
}

/** A finding: something this key can see. Stdout, per the rule at the top of this file. */
function say(line: string): void {
  console.info(redact(line));
}

/**
 * The last line of a run that is ending unhappily, on stderr, with the code it is ending with.
 *
 * ONE FUNCTION SO THE RULE CANNOT DRIFT. The stream and the exit used to be chosen separately at
 * every place a run can stop, and they disagreed: the usage and the missing key wrote to stderr and
 * every other stopping point wrote to stdout, with nothing written down anywhere saying which the
 * next one should pick. Tying the two together makes the rule at the top of this file true by
 * construction rather than by everybody remembering it.
 *
 * `never` so the type checker knows the run is over here, which is what lets the callers below stop
 * without a redundant `return` that would read as though the line were only advisory.
 */
function stop(line: string, code: number): never {
  console.error(redact(line));
  process.exit(code);
}

/**
 * One failure, as the line this script prints about it.
 *
 * The MESSAGE, never the object. A caught value from an SDK carries a request, a config and
 * whatever else the vendor attached to it, and `console.error(error)` prints all of it — which is
 * the path by which a key ends up in a terminal and in whatever captured it. So the shape is
 * discarded here and the one human sentence is kept, and even that goes out through {@link redact}.
 *
 * WHICH MESSAGE, THOUGH, IS NOT THE OUTER ONE. `error.message` on a Composio throw is "Error
 * executing the tool GMAIL_GET_PROFILE" — the placeholder `./composio` documents as the sentence
 * never worth passing on, and on a diagnostic it is worse than useless: it names the thing the
 * reader just asked for and says nothing about why the key could not do it. The actionable
 * sentence — "API Key is not valid", "No connected account found for user ID …" — is nested two
 * levels inside `cause`, beside the whole HTTP response. {@link vendorSentence} is the reach that
 * takes that sentence and nothing else, and it is imported rather than rewritten here so that a
 * vendor changing the nesting breaks one place.
 *
 * AND THE PLACEHOLDER IS REFUSED HERE TOO, which is the half this file was missing. The fallback
 * used to be `error.message` unconditionally — so on the one path where the placeholder is what
 * `error.message` holds, a docblock saying the sentence is never worth passing on sat directly
 * above the code that passed it on. {@link VENDOR_PLACEHOLDER} is the same guard the transport uses
 * at the same fork, imported rather than re-spelled so this file cannot drift from `callTool`'s
 * reading of a failure Composio declined to explain.
 *
 * WHAT TO SAY IN THAT SILENCE IS THE CALLER'S TO DECIDE, WHICH IS WHY IT IS A PARAMETER. It used to
 * be {@link unexplained} for everybody, and that function's sentence is about a person's connection
 * — correct for the one caller that hands it an action's name, wrong for every caller that hands it
 * a step. A single fallback could only be right for one of the two, so the fork that already exists
 * at the call sites decides it: {@link ask} passes {@link unexplainedRead} and the action call
 * passes {@link unexplained}. Named rather than inlined so each sentence keeps a docblock saying who
 * it is for.
 *
 * The thrown message is still the fallback where it says anything at all, because a failure that is
 * not a Composio throw — DNS, a proxy, a TLS refusal — carries its whole diagnosis there.
 */
function failed(
  subject: string,
  error: unknown,
  silence: (subject: string) => string,
): string {
  const vendor = vendorSentence(error);
  if (vendor !== null) return `${subject} failed: ${vendor}`;
  const thrown =
    error instanceof Error ? error.message.trim() : String(error).trim();
  return thrown === "" || VENDOR_PLACEHOLDER.test(thrown)
    ? silence(subject)
    : `${subject} failed: ${thrown}`;
}

/**
 * What to say when one of this script's READS failed and Composio explained nothing.
 *
 * NOT {@link unexplained}, AND THAT IS THE CORRECTION. That sentence ends "Check that this app is
 * still connected on its Plugins page", which is the right advice for what it was written for — a
 * named ACTION that failed, where a lapsed connection is the likeliest cause by a wide margin and
 * the reader fixes it in two clicks. Every {@link ask} below was handing it a STEP instead, so
 * "Listing the apps this key can see" and "Listing gmail's actions" both answered with advice about
 * one person's connection. A catalogue that will not list and a key Composio has stopped accepting
 * are faults in the deployment, and the person whose connection that sentence sends the reader to
 * inspect is the one party who cannot do anything about either.
 *
 * SO IT NAMES THE TWO THINGS ACTUALLY IN QUESTION AT THIS STAGE, in the order worth checking: the
 * key this deployment sent, then Composio itself. By the time any read here runs, nothing about
 * anybody's connection has been established or is implicated — the catalogue read does not involve a
 * person at all.
 */
function unexplainedRead(step: string): string {
  return `${step} failed and Composio did not say why. At this stage that is a fault in the key this deployment sent or at Composio, and not in anybody's connection: check COMPOSIO_API_KEY on this deployment, then Composio's status page.`;
}

/**
 * One vendor read, with a thrown failure reported rather than raised.
 *
 * WITHOUT THIS THE READS BELOW GO ROUND THE REDACTOR, which is the one rule this file has. A
 * top-level await that rejects is an unhandled rejection, and the runtime prints the thrown value
 * itself: for a bad key that is the vendor's error object with the 401 body, every response header
 * and two stack traces, none of it through {@link say}. A bad key is also the FIRST thing this
 * script exists to diagnose — so the crash was reserved for exactly the case the script was written
 * for, and the guarantee at the top of this file held only while nothing went wrong.
 *
 * IT EXITS RATHER THAN ANSWERING A SENTINEL, because each read below is a precondition for the ones
 * after it: a catalogue that could not be read makes "no connection" a statement about nothing.
 */
async function ask<T>(attempt: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    stop(failed(attempt, error, unexplainedRead), 1);
  }
}

/**
 * {@link ask} for something that is not awaited, which at present is exactly one call.
 *
 * THE CLIENT CONSTRUCTOR WAS THE ONE VENDOR CALL OUTSIDE THE REDACTOR. Everything else in this file
 * goes through {@link ask}, whose whole purpose is that no thrown vendor object is printed by the
 * runtime instead of by this file — and `createComposioClient` sat bare above it, so a throw there
 * went straight past the guarantee this file's own docblock makes about never printing the key.
 * `ask` could not cover it because `ask` awaits and this does not, so the shape is repeated
 * synchronously rather than the call being made to look asynchronous.
 *
 * WHAT IT CAN ACTUALLY THROW WAS CHECKED BEFORE THIS WAS ADDED, AND THE ANSWER IS "ONE THING, NOT
 * REACHABLE FROM HERE". `new Composio(...)` validates nothing but the key: `getSDKConfig` raises
 * `ComposioNoAPIKeyError` when the key is empty after falling back to the environment and the user
 * config file, and everything after that is object construction (`@composio/core` 0.18.1,
 * `src/composio.ts`). The refusal above means this file never hands it an empty one, and that error's
 * message quotes no key even when it is raised. A malformed `COMPOSIO_BASE_URL` does NOT throw here
 * either — it is carried to the first request and fails there, inside {@link ask} already.
 *
 * SO THIS IS BELT AND BRACES, AND DELIBERATELY SO. The file's guarantee is that the key cannot reach
 * a terminal, and the docblock at the top says why it will not rest that guarantee on the SDK's
 * behaviour: a vendor exception is a foreign object, the constructor runs their telemetry
 * instrumentation and their provider's constructor, and the audit above is true of 0.18.1 rather
 * than of the next version. A guard that costs four lines makes the promise structural instead of
 * something a reader has to re-derive from the vendor's source every bump.
 */
function build<T>(attempt: string, make: () => T): T {
  try {
    return make();
  } catch (error) {
    stop(failed(attempt, error, unexplainedRead), 1);
  }
}

/**
 * One app's resolved connection kind, as the word this script prints for it.
 *
 * READ OFF THE CATALOGUE ROW RATHER THAN DERIVED AGAIN. `connectionOf` in
 * `server/src/plugins/composio-adapter.ts` has already made this decision for every row this
 * listing carries, and it is the decision the directory, the enable path and the connect screen all
 * act on. A second reading of the vendor's schemes here would be a second answer, and a diagnostic
 * whose kinds disagree with the product's is worse than one that prints none.
 *
 * THE SCHEME IS NAMED FOR A `fields` APP BECAUSE IT IS THE HALF THAT MOVES. Which of API_KEY,
 * BASIC, BEARER_TOKEN or BASIC_WITH_JWT an app resolved to decides what the connect form asks a
 * person to type, and an app that has quietly changed scheme is a form drawn for the wrong secret —
 * which "fields" on its own would not show.
 *
 * THE REASON ON AN `unsupported` APP IS NOT PRINTED. It is a paragraph written for one app's page,
 * and there is one per app in a listing that runs to four figures; the tally below is what makes a
 * catalogue full of them legible, and the app's own page is where its sentence is worth reading.
 *
 * AN UNKNOWN KIND PRINTS ITSELF rather than being collapsed into a chosen word, which is why this
 * is not a `switch` with a fallback arm: a kind added to {@link BrokerConnection} after this was
 * written is exactly the thing an operator reading these lines needs to see by name.
 */
function kindOf(connection: BrokerConnection): string {
  return connection.kind === "fields"
    ? `fields: ${connection.authScheme}`
    : kindLabel(connection.kind);
}

/**
 * The kind's own literal, hyphen taken out of the one that reads as two words.
 *
 * ONE VOCABULARY FOR BOTH THE LINES AND THE TALLY, which is the whole reason it is a function: the
 * per-app line and the count are about the same fact, and two spellings of it would read as two
 * different findings on a page an operator is scanning rather than reading.
 */
function kindLabel(kind: BrokerConnection["kind"]): string {
  return kind === "no-auth" ? "no auth" : kind;
}

/** The width a column has to be for the widest thing going in it to fit. */
function widest(values: string[]): number {
  return values.reduce((width, value) => Math.max(width, value.length), 0);
}

const { actions, broker } = build("Opening Composio with this key", () =>
  createComposioClient(key),
);

const apps = await ask("Listing the apps this key can see", () =>
  broker.listApps(),
);
const app = apps.find((candidate) => candidate.slug === APP);
/*
 * THE TRUNCATED CATALOGUE IS NOT CHECKED FOR HERE, BECAUSE IT CANNOT ARRIVE HERE.
 *
 * There used to be a branch below reporting that the catalogue had come back full at
 * {@link LISTING_LIMIT}, and it could never run: `broker.listApps` refuses that answer at its own
 * ceiling and throws, for the reason written down beside the throw — at the ceiling a whole
 * catalogue and a cut-off one are the same array, so a partial directory is not shown at all. So
 * every value of `apps` that reaches this line is shorter than the limit, and the one thing the
 * branch promised to report was the one thing it could never see.
 *
 * WHICH DOES NOT LOSE THE REPORT, and that is why the branch went rather than the refusal being
 * worked around. The refusal's own sentence says the catalogue came back at the largest page this
 * deployment can ask for, and {@link ask} prints it: a run against a truncated catalogue stops on
 * that sentence instead of continuing under a warning. It is the stronger of the two, because the
 * branch would have gone on to report "gmail was not among them" about a listing it had just said
 * it could not trust.
 *
 * The action listing further down keeps its own full-page check, which is NOT the same case:
 * `actions.listActions` is a pass-through with no ceiling refusal in it, so there a full page
 * really can arrive and really does need saying.
 */
say(`Composio listed ${apps.length} apps for this key.`);
/*
 * EVERY APP AND THE KIND IT RESOLVED TO, WHICH IS THE ONE READING THAT CATCHES A CATALOGUE GONE
 * FLAT.
 *
 * `connectionOf` reads a malformed `auth_schemes` as an empty list, so a vendor renaming or
 * reshaping that field resolves EVERY app to `unsupported` — and the directory route hides
 * unsupported apps. From every other angle that failure is silent: the catalogue lists its usual
 * four figures, the route answers 200, not one app is offered, and no sentence anywhere says so.
 * The count printed above is unchanged by it, which is exactly why the count is not enough.
 *
 * THE TALLY IS THE LINE THAT MAKES THE SHAPE VISIBLE AT A GLANCE, and it prints the zeros rather
 * than only the kinds that occurred: "consent 0, self-registering 0, fields 0, no auth 0,
 * unsupported 1540" is a catalogue that has stopped resolving, and it reads as one without anybody
 * scrolling the per-app lines. A tally built only from what was seen would print one cheerful line
 * in that state. The per-app lines are what an operator greps afterwards for the app they came
 * about.
 *
 * SEEDED IN THE ORDER {@link BrokerConnection} DECLARES, AND OPEN AT THE END. The five known kinds
 * are seeded so their zeros are printed; a kind this script has never heard of increments a key
 * that was not seeded and is appended by `Map` where it cannot be missed, rather than being
 * silently dropped by a fixed list of five. The seed is checked against the type rather than
 * spelled as loose strings, so a kind RENAMED there is a compile error here instead of a zero that
 * goes on printing for ever beside the new name.
 *
 * THROUGH {@link say}, LIKE EVERYTHING ELSE. These lines explain a run that got this far rather
 * than a non-zero exit, so the rule at the top of this file puts them on stdout, and going through
 * `say` is what keeps them inside {@link redact}. Nothing of the vendor's object reaches them: a
 * checked slug, a word chosen here, and a number.
 */
const rows = apps.map((candidate) => ({
  slug: candidate.slug,
  kind: kindOf(candidate.connection),
  count: String(candidate.actionCount),
}));
const slugColumn = widest(rows.map((row) => row.slug));
const kindColumn = widest(rows.map((row) => row.kind));
const countColumn = widest(rows.map((row) => row.count));
for (const row of rows) {
  say(
    `${row.slug.padEnd(slugColumn)}  ${row.kind.padEnd(kindColumn)}  ${row.count.padStart(countColumn)} actions`,
  );
}
const KINDS = [
  "consent",
  "self-registering",
  "fields",
  "no-auth",
  "unsupported",
] satisfies BrokerConnection["kind"][];
const tally = new Map<string, number>(
  KINDS.map((kind): [string, number] => [kindLabel(kind), 0]),
);
for (const candidate of apps) {
  const kind = kindLabel(candidate.connection.kind);
  tally.set(kind, (tally.get(kind) ?? 0) + 1);
}
say(
  `Kinds: ${[...tally].map(([kind, count]) => `${kind} ${count}`).join(", ")}.`,
);
if (!app) {
  /*
   * Stated rather than shrugged at. A catalogue that does not contain Gmail is a key pointed at
   * something other than what this script assumes, and reporting "0 actions" for it would read as
   * an empty app rather than as a listing that never included it.
   */
  stop(
    `${APP} was not among them, so the action count and the connection below are about an app this key cannot see.`,
    1,
  );
}
say(`${app.name} publishes ${app.actionCount} actions.`);

const connected = await ask(
  `Asking whether ${user} has a ${APP} connection`,
  () => broker.isConnected({ userId: user, toolkit: APP }),
);
/*
 * BOTH STATES ARE NAMED BECAUSE THIS READ CANNOT TELL THEM APART. `isConnected` is a count of this
 * person's ACTIVE accounts for the app, so it answers `false` for somebody who never consented and
 * equally for an app this deployment has no authorization config for — in the second case there is
 * nothing for a consent to have been made against, and nobody could have connected even if they
 * tried. Sending the reader to the person in that case is sending them to the one party who cannot
 * fix it. See the docblock at the top for why the config is not read here and what reading it would
 * take.
 */
say(
  connected
    ? `${user} has a live ${APP} connection.`
    : `${user} has no live ${APP} connection, and this script cannot say which of two reasons it is. Either no administrator has enabled ${APP} on this deployment, so there is no authorization config for anybody to connect against — check the app's page under /admin/plugins — or the app is enabled and ${user} never finished the consent page, which they do in their own browser; nothing here can do it for them.`,
);

if (!call) {
  say("Nothing was called. Pass --call to run one read-only action.");
  process.exit(0);
}

if (!connected) {
  stop(
    `--call was passed, but there is no connection to call through, so nothing was sent. Connect ${APP} for ${user} first.`,
    1,
  );
}

/*
 * The action is looked up in a real listing rather than called from the constant alone, for the two
 * things only the listing carries: the concrete version, which the SDK refuses to execute without,
 * and the behaviour labels, which are what makes the claim "read-only" checkable instead of
 * asserted in a comment.
 */
const listed = await ask(`Listing ${APP}'s actions`, () =>
  actions.listActions(APP, { limit: LISTING_LIMIT }),
);
/*
 * The count, because it is the number {@link APP} was chosen for: Gmail publishes enough actions
 * that a page truncated at the ceiling, or narrowed to the vendor's "important" subset, reads as an
 * obviously wrong number beside the count the catalogue published — and neither one announces
 * itself. Printing only the catalogue's figure left the comparison this file promises impossible to
 * make.
 */
say(
  listed.length >= LISTING_LIMIT
    ? `Composio answered with ${listed.length} ${APP} actions, which is the whole page it will answer with (${LISTING_LIMIT}), so that listing came back full and is likely cut off.`
    : `Composio listed ${listed.length} of the ${app.actionCount} actions ${app.name} publishes.`,
);
const action = listed.find((candidate) => candidate.slug === READ_ACTION);
if (!action) {
  stop(
    `Composio does not list ${READ_ACTION} for ${APP}, so nothing was called. Pick another read-only action rather than calling one of the writes.`,
    1,
  );
}
const { effect, destructive } = effectOf(action.tags);
if (effect !== "read" || destructive) {
  /*
   * The vendor's label decides, and a disagreement stops the run. `effectOf` treats anything
   * unlabelled as a write, so this also covers the case where Composio stops publishing labels
   * altogether — which would otherwise turn a smoke test into an unreviewed write.
   */
  stop(
    `Composio no longer marks ${READ_ACTION} as read-only, so nothing was called. This script only ever runs a read.`,
    1,
  );
}
if (!action.version) {
  stop(
    `Composio listed ${READ_ACTION} with no version, so no versioned call could be made and nothing was sent.`,
    1,
  );
}

let result: ComposioResult;
try {
  result = await actions.execute(
    {
      toolkit: APP,
      slug: action.slug,
      userId: user,
      version: action.version,
    },
    /*
     * No arguments. A profile read is about the connected account itself, and the one parameter it
     * takes defaults to it — so an empty bag is both the smallest request and the one that cannot
     * accidentally name somebody else's mailbox.
     */
    {},
  );
} catch (error) {
  /*
   * {@link unexplained} rather than {@link unexplainedRead}, and this is the one call site it was
   * written for: the subject is an action's name, and a connection that lapsed between the listing
   * above and this call really is the likeliest reason a run that got this far fails here.
   */
  stop(failed(READ_ACTION, error, unexplained), 1);
}

/*
 * A resolution is not a success. Composio reports most failures by answering with `successful:
 * false` rather than by throwing, and a smoke test that only watched for exceptions would report a
 * working key on top of a call that failed.
 *
 * THE REPORTED SENTENCE GOES THROUGH THE SAME TWO GUARDS A THROWN ONE DOES. `result.error` is the
 * vendor's field and it carries the vendor's placeholder as readily as an exception message does —
 * `callTool` refuses it there for exactly this reason — so "failed: Error executing the tool
 * GMAIL_GET_PROFILE" is a line this script could otherwise print while its own docblock says that
 * sentence is never worth passing on. {@link unexplained} is what is said instead, which is the
 * wording the product uses for the same silence.
 */
const reported = result.error?.trim() ?? "";
const outcome = result.successful
  ? `${READ_ACTION} succeeded.`
  : reported === "" || VENDOR_PLACEHOLDER.test(reported)
    ? unexplained(READ_ACTION)
    : `${READ_ACTION} failed: ${reported}`;
const log = `Log id: ${result.logId ?? "none was returned."}`;

/* The rule at the top of this file: these two lines are the whole explanation of a non-zero exit. */
if (!result.successful) stop(`${outcome}\n${log}`, 1);
say(outcome);
say(log);
process.exit(0);
