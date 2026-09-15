import { Composio } from "@composio/core";
import {
  type AuthConfigOutcome,
  type BrokerApp,
  type BrokerConnection,
  type BrokerField,
  BrokerRefusalError,
  type ComposioBroker,
  type FieldScheme,
  flagOf,
  isFieldScheme,
} from "./broker";
import {
  type ComposioAction,
  type ComposioActions,
  type ComposioResult,
  LISTING_LIMIT,
  vendorSentence,
} from "./composio";

/**
 * The one file in `server/src` that imports `@composio/core`, and what it owes the rest of them.
 *
 * `./composio` describes calling an action and `./broker` describes everything that has to be true
 * before one can be called; both are written as narrow projections that name no vendor type, so
 * that the SDK's shape — its constructor, its retries, its zod schemas and whatever the next
 * version renames — is confined here. This module is the adapter that satisfies both from one
 * client. A second importer of `@composio/core` under `server/src` would undo that, because the
 * point of a single import site is that a version bump has exactly one file to be read against.
 *
 * NO SESSION IS EVER CREATED, AND THAT IS A SECURITY BOUNDARY RATHER THAN A PREFERENCE. The SDK's
 * `composio.create(...)` and `sessions.create(...)` open a Composio tool-router session, and a
 * session brings Composio's own hosted surface with it — a remote shell and a Python sandbox that
 * this deployment neither asked for, cannot see into, and could not audit if a model reached them.
 * Everything below is a plain per-call request carrying a user id. A `create` of a session
 * anywhere in this file is a defect, not an optimisation, and it will not look like one: the
 * session API is the shortest path to most of what this file does the long way.
 *
 * EVERY LISTING PASSES AN EXPLICIT LIMIT AND EVERY LISTING IS READ TO THE END OF ITS CURSOR.
 * Composio's default page is 20, which is smaller than the number of actions Gmail alone publishes,
 * and through the SDK's tool wrapper the default did a second thing as well: `getRawComposioTools`
 * set `important=true` whenever a toolkit query arrived with no limit, no tags and no search
 * (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), so an omitted limit silently narrowed
 * the answer to the vendor's own "important" subset and nothing in the result said a filter had
 * been applied. {@link LISTING_LIMIT} is the documented page ceiling and therefore the fewest round
 * trips a listing can be read in.
 *
 * AND THE LIMIT IS A PAGE RATHER THAN THE ANSWER, WHICH IS WHAT CHANGED. Two of the four listings
 * here used to meet a full page and refuse it, because the SDK wrapper around them could not ask
 * for a second — one takes no cursor, the other drops the response's. That was never true of the
 * vendor: both raw endpoints carry `cursor` and `next_cursor`, and Composio publishes more than
 * {@link LISTING_LIMIT} toolkits, so the catalogue refusal fired on every call and the app picker
 * showed an operator nothing at all. All four now go through {@link everyRowOf}, which follows the
 * cursor until the vendor stops offering one and refuses rather than truncates when it cannot.
 *
 * THE API KEY NEVER LEAVES THIS FILE. It arrives as {@link createComposioClient}'s only argument,
 * goes straight into the vendor's constructor, and is held from there on by the vendor's client
 * inside a closure. Nothing below logs it, no thrown message quotes it, and neither of the two
 * returned objects carries a field that could be read back to it — they expose eight methods and
 * no state. A key in a log line is a key in a log aggregator, and a key in an error message is a
 * key in an audit row and in a model's context.
 */

/**
 * One tool as the SDK's SINGLE-TOOL call hands it over, in as much detail as anything here reads.
 *
 * Declared structurally rather than imported as `Tool`, for the same reason the seams it feeds are
 * structural: a field this file does not read is a field a vendor rename cannot break. `toolkit`
 * is optional because the SDK spells it optional — see {@link ComposioActions.execute} below for
 * what is done when it is in fact missing.
 *
 * THIS IS THE ONE ROW THE SDK STILL VALIDATES, AND IT IS NO LONGER TWO. `Tools.transformToolCases`
 * ends in `ToolSchema.parse(...)` (`@composio/core` 0.18.1, `src/models/Tools.ts:193`), a throwing
 * parse rather than the warn-only `transform()` every other answer here goes through, and
 * `getRawComposioToolBySlug` runs it (`:719`). The LISTING used to as well (`:561`) and does not
 * any more: it reads {@link VendorToolRow} off the raw client, because the wrapper that ran the
 * parse is also the wrapper that could not be paged. So `ToolkitSchema` spelling that inner `slug`
 * required (`src/types/tool.types.ts:12-16`) is a guarantee this declaration may still rest on,
 * and it is a guarantee about exactly one call.
 *
 * WHAT THIS FILE HANDS ON IS STILL `unknown`, WHICH IS WHERE THAT ARGUMENT ALWAYS STOPPED BEING
 * TRUE. A parse is a fact about one method of one version of one package, and what these
 * declarations govern is {@link ComposioVendor} — the seam a test satisfies with a literal and the
 * shape the next version will be read against. Running it shows the gap is not academic: a
 * `description` of 42 crosses into `./composio` as the `string` this said it was and reaches
 * `.replaceAll` in `./store` as a bare `TypeError`. A declaration is an assertion and not a check.
 */
type VendorTool = {
  slug: string;
  description?: unknown;
  inputParameters?: unknown;
  tags?: string[];
  version?: unknown;
  toolkit?: { slug: string };
};

/**
 * One tool as the LISTING hands it over, which is the wire's own spelling and nobody's parse.
 *
 * SNAKE_CASE BECAUSE THIS IS COMPOSIO'S ANSWER RATHER THAN THE SDK'S RESTATEMENT OF IT. The listing
 * reads `client.tools.list` directly — see {@link ComposioVendor} for why it has to — so nothing
 * renames `input_parameters` on the way here and nothing runs `ToolSchema` over it. Both halves of
 * that are deliberate. The rename was never a service: `transformToolCases` re-spelled the field
 * and `ToolSchema.parse` then STRIPPED every schema key its `ParametersSchema` did not name —
 * `if`, `then`, `else`, `examples`, every `x-` extension at the root, and `deprecated` and
 * `contentEncoding` per property (`@composio/core` 0.18.1, `src/types/tool.types.ts:77-174`) —
 * before any caller could see them. What a model is shown is now what Composio published; see
 * {@link ComposioAction.inputParameters}, where that loss was written down as unavoidable.
 *
 * AND EVERY FIELD IS DECLARED AT WHAT THE WIRE CAN HOLD, because with the parse gone there is
 * nothing between Composio and {@link actionOf} at all. `slug` widens for exactly that reason:
 * `ToolSchema` required it and nothing does now, and `actionOf` was already checking it anyway.
 * `tags` stays narrow on the same argument it always stood on, which never involved the parse —
 * `./composio` refuses a `tags` that is not a list of labels where it reads them, container and
 * contents both, and a check on both sides of one seam is a check nobody maintains.
 */
type VendorToolRow = {
  slug?: unknown;
  description?: unknown;
  input_parameters?: unknown;
  tags?: string[];
  version?: unknown;
};

/**
 * One catalogue row as the vendor hands it over, which is the wire's own spelling and nobody's map.
 *
 * `meta` is where all of it lives and every field of it is optional, which is not the SDK being
 * cautious: Composio genuinely publishes toolkits with no logo, no description and no category.
 * See {@link ComposioBroker.listApps} below for what each absence becomes.
 *
 * SNAKE_CASE AND `unknown` THROUGHOUT, BECAUSE THE TRANSFORMER THIS WAS WRITTEN AGAINST IS GONE.
 * The catalogue reads `client.toolkits.list` directly — see {@link ComposioVendor} for why it has
 * to — so `transformToolkitListResponse` no longer stands between Composio and {@link appOf}, and
 * three things it was doing have to be accounted for rather than assumed.
 *
 * IT RENAMED, so the count is `tools_count` here and the category's own word is `name`
 * (`@composio/client` 0.1.0-alpha.76, `resources/toolkits.d.ts:405-435`). That rename was the one
 * thing in this projection easiest to get silently wrong — a count read off the wrong key is a
 * plausible zero rather than an error — which is why {@link appOf} is where it is read and why a
 * test asserts the figure rather than the field.
 *
 * IT REBUILT `meta` AND THE `categories` LIST, spreading each into a fresh literal and mapping
 * every entry (`@composio/core` 0.18.1, `src/utils/transformers/toolkits.ts:21-34`). Those were
 * this file's two structural guarantees and they were real: a `meta` of null and a `categories` of
 * "crm" each raised a `TypeError` from that line when 0.18.1 was run, which is why neither was
 * declared `unknown` and neither was checked. Nothing raises now. A `meta` that is a string reads
 * as an app with no description, no logo, no categories and no count, and a `categories` that is a
 * string reads as an app in no category — two silent, plausible answers about a real app. Both are
 * declared at what the wire can hold and both are refused in {@link appOf}.
 *
 * AND IT NEVER VALIDATED, which is the part that does not change. `transform()` checks with
 * `safeParse` and, where that fails, logs a warning and returns the unvalidated object anyway
 * (`src/utils/transform.ts:26-36`), so `ToolKitItemSchema` spelling `name` required and the count a
 * number always described the answer Composio MEANS to send rather than the one that arrived. Every
 * wire-valued field was already `unknown` on that argument and stays so: the slug, which is the
 * only name this deployment has for an app; the name, which is the only thing to show a person
 * choosing between apps; the description, the logo, each category's word, and the count.
 */
type VendorToolkit = {
  slug?: unknown;
  name?: unknown;
  meta?: unknown;
  no_auth?: unknown;
  auth_schemes?: unknown;
  composio_managed_auth_schemes?: unknown;
};

/**
 * One toolkit read on its own, which this file wants for exactly one thing: what it asks a person.
 *
 * ONE FIELD, BECAUSE ONE FIELD IS WHAT IS READ. The per-app retrieve answers everything the
 * catalogue row does and a good deal more, and naming any of it here would be this file declaring
 * knowledge of a shape nothing below opens.
 *
 * `unknown` FOR THE REASON EVERY OTHER VENDOR TYPE IN THIS FILE SAYS SO. What hangs off
 * `auth_config_details` is a list of modes, each carrying the fields its scheme wants, and every
 * one of those is copied across verbatim — so the declaration would be an assertion about the wire
 * rather than a fact about it. {@link ComposioBroker.connectionFields} reads it a step at a time,
 * and refuses at whichever step it stops being able to read rather than showing the shorter form
 * that is left.
 */
type VendorToolkitDetail = {
  auth_config_details?: unknown;
};

/**
 * One auth config as the vendor hands it over, which is three fields because all three decide.
 *
 * `name` IS THE ONLY PROVENANCE THERE IS. Composio publishes no field saying which client created a
 * config, and the listing is scoped to the project rather than to this deployment, so a config an
 * operator made by hand in the dashboard comes back beside the ones made here and is otherwise
 * identical. The name is the one field this deployment chooses, which is why {@link CONFIG_SUFFIX}
 * is written into it and why every decision below reads it.
 *
 * `status` because a DISABLED config is still a config: it answers the listing, it satisfies the
 * "does one exist" question, and a connect link minted against it does not work. The two facts have
 * to be separable or an app with a disabled config reads as an app that is ready.
 *
 * BOTH OF THOSE ARE DECLARED AS THE WIRE CAN SEND THEM RATHER THAN AS THE SDK SPELLS THEM, for the
 * reason the toolkit row above gives at length: `transformAuthConfigRetrieveResponse` copies
 * `name` and `status` across verbatim inside a warn-only `transform()`
 * (`@composio/core` 0.18.1, `src/utils/transformers/authConfigs.ts:29-58`), so
 * `AuthConfigRetrieveResponseSchema` requiring a string name and an `ENABLED`/`DISABLED` enum is
 * not something this file can rest on. A null name reaches {@link madeHere}, and a status the
 * enum does not contain reaches the choice of config to connect against — where "not ENABLED" and
 * "disabled" are different facts and only one of them is worth telling an operator.
 *
 * `id` IS DECLARED THE SAME WAY, AND THE GUARD IT WAS WAITING FOR IS WRITTEN. {@link readableConfigs} makes
 * that check, so the declaration no longer claims more than the wire promises. It is the one of the
 * three whose absence sends a request: a delete named with `undefined` asks Composio to remove
 * whatever it cares to, and this deployment then records that the app was withdrawn.
 *
 * THE ROW BEING AN OBJECT AT ALL IS THE ONE THING THAT IS NOT IN DOUBT.
 * `transformAuthConfigRetrieveResponse` reads `authConfig.toolkit.logo` while building every row
 * (`@composio/core` 0.18.1, `src/utils/transformers/authConfigs.ts:41`), so a row that is not an
 * object raises a `TypeError` inside the vendor's own code and never arrives. All three fields
 * below are `unknown` for the opposite reason: the same function copies them across verbatim.
 */
type VendorAuthConfig = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
};

/**
 * The connected-account statuses this file knows how to ask for, as the literals the SDK admits.
 *
 * The whole enum is named rather than the two or three in use, because the point of the two lists
 * below is that they are CHOICES: a reader comparing them can see which statuses each question
 * leaves out, and a status added by a vendor version shows up here as a name nothing mentions
 * rather than as an answer that quietly got narrower. Written as literals for the reason the
 * previous `"ACTIVE"[]` was: the vendor's parameter is an enum and a widened `string[]` does not
 * satisfy it.
 */
type VendorAccountStatus =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

/*
 * WHERE THE LINE BETWEEN "READ AT ITS TYPE" AND "READ OUT OF `unknown`" IS DRAWN, AND WHY IT MOVED.
 *
 * Everything below used to be read out of `unknown` — containers and fields alike — on one argument:
 * `transform()` validates with `safeParse`, logs a warning where it fails, and returns the
 * unvalidated object anyway (`@composio/core` 0.18.1, `src/utils/transform.ts:26-36`), so a
 * TypeScript declaration over a wire value is an assertion and not a check.
 *
 * THAT ARGUMENT IS TRUE OF THE FIELDS AND FALSE OF THE SHAPES AROUND THEM, which a round of running
 * the SDK against malformed answers established rather than reasoned about. `transform()` returns
 * whatever its TRANSFORMER built, and every one of these transformers builds its result by
 * dereferencing the raw answer — `response.items.map(...)`, `item.meta.categories`,
 * `authConfig.toolkit.logo`, `response.auth_config.id`. So the containers and the rows inside them
 * are the vendor's own construction and cannot arrive malformed; only the values copied ACROSS
 * those lines can, and those are exactly the fields declared `unknown` above. Guards were written
 * for both halves, and the ones covering the shapes were branches no answer could reach, standing
 * where the next reader would take them for what was keeping them safe.
 *
 * WHAT KEEPS THEM SAFE IS `askVendor`. A shape the SDK could not read raises inside the SDK, and
 * the `TypeError` row in {@link vendorRefusal} turns that into a sentence — one guard, at the layer
 * where the fault actually surfaces, covering every shape rather than the four somebody listed.
 *
 * REFUSING RATHER THAN FILLING IN, WHICH IS THE WHOLE OF THE ARGUMENT FOR THE FIELDS. A `?? ""`, a
 * `String(x)` or a cast does not make a malformed answer safe; it converts a fault this deployment
 * could have reported into an answer it gives wrongly, and the wrong answers are not small ones —
 * an app with no name in an administrator's picker, an action with no slug put in front of a model,
 * and the one that was actually happening: a delete sent with `undefined` where an account id belongs,
 * answered by Composio however it likes, after which the audit trail records that a person's access
 * was withdrawn and nothing had been. Every reader below therefore answers null on anything it
 * cannot read, and every caller turns that null into a sentence naming what Composio sent.
 */

/**
 * The remedy every shape refusal here ends with, because it is the same act in every one of them.
 *
 * None of these is a misconfiguration. The key is right, the request is right and the answer
 * arrived; what changed is the shape of it, which is a thing nobody operating this deployment can
 * correct from any page it has. Saying so is the difference between an operator reading their own
 * settings for an hour and an operator upgrading a package.
 */
const VENDOR_SHAPE_REMEDY =
  "That is a change in what Composio answers rather than a setting an operator can correct, so upgrading this deployment's @composio/core is what fixes it.";

/**
 * WHAT COMPOSIO PUT SOMEWHERE, NAMED IN A SENTENCE A READER CAN ACT ON.
 *
 * Every refusal below says what arrived where something else belonged, because "Composio's answer
 * was not a shape this deployment reads" sends whoever is holding the page looking through a vendor
 * dashboard with nothing to look for.
 *
 * THE VALUE IS NEVER QUOTED, AND THAT IS THE POINT OF THE FUNCTION RATHER THAN AN INTERPOLATION. A
 * listing row carries a person's mailbox address, an account handle and whatever else the vendor
 * chose to put on it, and a refusal from here is read off an admin page, written into an app's
 * `lastError` and put in front of a model. The shape is the part that is safe to say and is also
 * the only part that helps: a reader who knows a list arrived where an object belongs knows which
 * vendor change they are looking at.
 *
 * AND THE EMPTINESS IT REPORTS IS THE ONE THE CALLER JUDGED, WHICH IT WAS NOT. Every caller reaches
 * this function on the branch {@link textOf} sent it down, and `textOf` decides on the TRIMMED
 * value while this tested `value === ""` — so a padded blank, which is the shape a wire value
 * actually arrives in, was refused for being empty and then described as "a string". "Composio sent
 * a string where the id belongs" is a sentence with no finding in it: a string is what an id IS, so
 * the reader is told the field was right and the call refused anyway. The two branches now agree on
 * what blank means, and they say which of the two blanks arrived, because an id that is three
 * spaces and an id that is absent are different things to go looking at in a dashboard.
 */
function sent(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") {
    if (value === "") return "an empty string";
    return value.trim() === "" ? "a string of blank space" : "a string";
  }
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * A vendor status named as itself, because an enum value is the one wire value worth quoting.
 *
 * {@link sent} withholds what it is given for a reason that does not reach here: an auth config's
 * status is one of a closed set of vendor enum names, carries nobody's data, and IS the finding —
 * "Composio called it PENDING" is something an operator can search their dashboard and the vendor's
 * changelog for, where "Composio sent a string" is something they can only shrug at.
 *
 * AND THE ARGUMENT ONLY HOLDS WHILE THE VALUE IS ACTUALLY ONE OF THOSE NAMES, which is the hole
 * this closes. Every caller reaches this function on the branch taken precisely BECAUSE the value
 * is not one of the words the code expects — so what arrives is not "an enum name Composio has
 * added", it is whatever came off the wire: a gateway's HTML error page, a stack trace, a sentence
 * carrying a person's mailbox address, a megabyte of it. That string was interpolated whole into a
 * refusal that is read off an admin page, written into an app's `lastError` and put in front of a
 * model.
 *
 * SO THE SHAPE OF AN ENUM NAME IS THE TEST, and anything that is not one is described by
 * {@link sent} like every other wire value in this file. A vendor enum name is a short run of
 * letters, digits and underscores; nothing that fails that is a word an operator could search a
 * changelog for, which was the entire argument for quoting it.
 */
const VENDOR_ENUM_NAME = /^[A-Za-z0-9_]{1,40}$/;

function named(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return VENDOR_ENUM_NAME.test(text) ? `"${text}"` : sent(value);
}

/*
 * THE CONTAINER OF A LISTING IS THE ONE THING BELOW THAT IS NOT READ OUT OF `unknown`, AND THE
 * REASON IS THAT THE SDK PROVES IT.
 *
 * There used to be a `hasFields` predicate and an `itemsOf` reader here, and every listing passed
 * its answer through them before touching a field — on the argument the row types give at length,
 * that a TypeScript interface over a wire value is an assertion rather than a check. That argument
 * is correct about the FIELDS and wrong about the CONTAINER, which running `@composio/core` 0.18.1
 * settles rather than reasons about. Every list transformer dereferences the answer before
 * returning it: `response.items.map(...)` in `transformAuthConfigListResponse`
 * (`src/utils/transformers/authConfigs.ts:79`), in `transformConnectedAccountListResponse`
 * (`connectedAccounts.ts:113`). So a container of the wrong shape — null, a bare list where an
 * envelope belongs, an `items` that is a string — dies inside the vendor's code and NEVER arrives
 * here. Each of those guards was therefore a branch no input could reach, sitting where the next
 * reader would take it for the thing keeping them safe.
 *
 * WHAT KEEPS THEM SAFE IS ONE LAYER DOWN NOW. The vendor's crash is a bare `TypeError`, and
 * {@link vendorRefusal} translates it into a sentence naming what did not happen and the one act
 * that changes it — which catches every malformed container, including the shapes nobody here
 * thought to enumerate.
 *
 * AND IT IS TWO OF THE FOUR LISTINGS NOW RATHER THAN ALL OF THEM, WHICH IS THE COST OF PAGING THE
 * OTHER TWO. The catalogue and the action listing read `@composio/client` directly — a generated
 * client that parses the body and returns it — so nothing dereferences their answers before this
 * file does. The same two shapes therefore reach this code rather than dying in the vendor's, and
 * {@link pageOf} answers them at exactly those two call sites. The argument above still holds
 * everywhere it is made: a guard is written where an input can reach it and nowhere else.
 *
 * SO THE DECLARATIONS BELOW ARE READ AT THEIR TYPES, and each one says which vendor line makes it
 * true. The fields inside them stay `unknown`, because the warn-only `transform()` really does copy
 * those across whatever they turn out to be.
 */

/**
 * One field as the non-empty string it has to be, or null where the vendor sent anything else.
 *
 * EMPTY COUNTS AS ABSENT because every caller of this reads an identifier — a slug, an id, a name
 * this file matches a suffix against — and an empty identifier is unusable in exactly the way a
 * missing one is, while being the one that reads as present at every glance.
 *
 * AND THE STRING THAT COMES BACK IS THE ONE THAT WAS JUDGED, which it was not. This decided
 * emptiness on the TRIMMED value and answered the PADDED one, so " " was correctly refused while
 * " ac_1 " was accepted and handed on with its spaces — a guard that checked one thing and passed
 * along another. What that reached is the whole of this file: a padded id is what an auth-config
 * delete and an account withdrawal NAME, so Composio is asked to remove an object nobody has;
 * a padded slug is what an enabled app records into its url and what an action list writes into
 * `mcp_tools`; and a padded app slug on the vendor's own answer compares unequal to the app the
 * caller was gated on, refusing a call that was about the right app the whole time. Trimming is
 * not tidying here — it is answering with the identifier rather than with the identifier plus
 * whatever the wire wrapped it in.
 */
function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * How many pages of one listing this deployment will read before it stops and says so.
 *
 * THE BOUND IS AGAINST A VENDOR THAT NEVER STOPS, not against a large answer. What it guards is a
 * cursor that keeps being handed back, which without a ceiling is a request that never returns: a
 * person waiting on a page they pressed disconnect from, and a process holding every row it has
 * read so far.
 *
 * REACHING IT IS A REFUSAL AND NEVER A TRUNCATION, which is the property the whole guard exists for
 * — see {@link everyRowOf}. A ceiling that answered with what it had would be the page ceiling
 * again, one order of magnitude further out and harder to notice.
 *
 * IT WAS 50, AND 50 WAS ARGUED FROM TWO NARROW LISTINGS THAT ARE NO LONGER THE ONLY ONES. The
 * number was justified by one app's authorization configs and one person's accounts for one app:
 * at {@link LISTING_LIMIT} rows a page a second page is extraordinary there and a fiftieth is not
 * a data set. The app CATALOGUE is not that listing. Composio publishes more than
 * {@link LISTING_LIMIT} toolkits today, so it is a listing whose SECOND page is the ordinary case,
 * and a ceiling reasoned about from the narrow two would be sitting on top of a healthy answer
 * rather than above it.
 *
 * 200 IS CHOSEN AGAINST THE PAGE THE VENDOR MIGHT ACTUALLY SEND rather than the one asked for, and
 * that is the whole of the arithmetic. Asking for {@link LISTING_LIMIT} does not oblige Composio to
 * answer with it — the cursor is documented as "a base64 encoded string of the page and limit"
 * (`@composio/client` 0.1.0-alpha.76, `resources/toolkits.d.ts:469-478`), so the page size is the
 * vendor's to settle. At the page asked for, 200 is 200,000 rows, two orders of magnitude past any
 * catalogue Composio has published. At the vendor's OWN default page of twenty it is 4,000 rows,
 * which still clears today's catalogue with room — where 50 pages of twenty is 1,000, which is
 * today's catalogue exactly, and a ceiling that lands on the real answer is a healthy vendor turned
 * into a refusal. And 200 sequential requests is still a request that ends.
 *
 * ONE NUMBER FOR ALL FOUR LISTINGS, because the two narrow ones lose nothing by it: they refuse a
 * runaway cursor after 200 pages instead of 50, and there is no state in which a real answer to
 * either of those questions is even a second page. A per-listing ceiling would be a second number
 * to reason about in exchange for tightening a bound that nothing genuine approaches.
 *
 * AND IT IS THE NUMBER OF PAGES THAT ARE READ, WHICH IS NOT WHAT IT USED TO BE. The test stood
 * ahead of the line recording the page it was counting, so the set held one fewer than had
 * arrived and the refusal fired on the two-hundred-FIRST page while telling its reader two hundred.
 * A ceiling is a number somebody reasons about; stating one and doing another makes it the one
 * number here nobody can check.
 */
const PAGE_CEILING = 200;

/**
 * The listing a refusal is about, as the two clauses every sentence below is built from.
 *
 * WRITTEN AT THE CALL SITE for the same reason {@link VendorCall}'s outcome is: what could not be
 * told is a fact about the question being asked — "whether this person is connected" is not
 * something {@link everyRowOf} can know — and composing it beside the call keeps it true.
 */
type Listing = {
  /** The listing as a noun phrase: "this person's gmail accounts". */
  noun: string;
  /** What could not be told, as a clause following "so": "whether one exists could not be read". */
  consequence: string;
};

/**
 * EVERY ROW OF A LISTING THE VENDOR PAGES, or a refusal rather than a fragment read as the whole.
 *
 * EVERY LISTING IN THIS FILE COMES THROUGH HERE NOW, AND TWO OF THEM USED TO REFUSE INSTEAD. This
 * paragraph said that `fetchDirectory` met a full page and refused, that `./composio` did the same
 * with a full action listing, and that both were right to: "the SDK offers no cursor to ask for a
 * second page with, so an answer at the ceiling and an answer past it are indistinguishable and no
 * second request could tell them apart". The reasoning was sound and the premise was wrong. It was
 * a fact about the WRAPPER — `ToolListParamsSchema` names no cursor and
 * `transformToolkitListResponse` drops the response's — and never about the request, which the raw
 * client has always been able to compose: both list params carry `cursor` and both responses carry
 * `next_cursor` (`@composio/client` 0.1.0-alpha.76, `resources/toolkits.d.ts:467-478` and
 * `:322-326`, `resources/tools.d.ts:421-432` and `:200-204`). The cost of the mistake was not
 * theoretical: Composio publishes more than {@link LISTING_LIMIT} toolkits, so the catalogue
 * refusal fired on the first call every time and the app picker showed an operator nothing at all.
 * See {@link ComposioVendor}, where both of those listings now name the raw client.
 *
 * THE OTHER TWO WERE ALWAYS EXPRESSIBLE THROUGH THE WRAPPER: `AuthConfigListParamsSchema` and
 * `ConnectedAccountListParamsSchema` both name a `cursor` (`@composio/core` 0.18.1,
 * `src/types/authConfigs.types.ts:124-131`, `src/types/connectedAccounts.types.ts:259-266`), both
 * models forward it (`src/models/AuthConfigs.ts:95`, `src/models/ConnectedAccounts.ts:118`) and
 * both transformers fill `nextCursor` in from the response's `next_cursor`
 * (`src/utils/transformers/authConfigs.ts:80`, `connectedAccounts.ts:116`).
 *
 * AND THE CALLER THAT DECIDES IT IS `revoke`. Refusing a truncated listing would be honest and
 * would also mean that the person it happened to could never disconnect: every attempt would meet
 * the same page and the same refusal, with their grants standing the whole time. The removal of an
 * app is the same shape one level up. Reading the rest is the answer that finishes the job, and
 * refusing is what is left for the cases where reading the rest is not possible — which is what the
 * three refusals below are, and why none of them can be reached by a caller carrying a partial
 * answer that reports itself complete.
 *
 * THE FIRST REQUEST CARRIES NO CURSOR FIELD AT ALL rather than an undefined one, which is what
 * {@link everyRowOf}'s callers spread for: a `cursor: undefined` would reach the vendor's `parse`
 * as a key, and an explicit undefined is not something this file needs to make the SDK have an
 * opinion about.
 *
 * THERE WAS A FOURTH REFUSAL HERE AND IT MOVED RATHER THAN DIED, which is the correction the raw
 * client forces. It stood at the top of this loop for a page that is not an envelope at all, and
 * for the two SDK listings no answer can reach it: both transformers begin `response.items.map(...)`
 * (`src/utils/transformers/authConfigs.ts:79`, `connectedAccounts.ts:113`), so a null, a bare list
 * and an `items` that is not one all raise a `TypeError` inside the vendor's own code, answered
 * where it happens — see the `TypeError` row in {@link vendorRefusal}. Nothing dereferences the
 * answer on the two RAW listings, so for those the same shapes reach this loop, and
 * `rows.push(...answered.items)` over a string is "string is not iterable" with nothing in it a
 * person can act on. {@link pageOf} is where that is answered, at the two call sites that need it,
 * rather than as a branch every listing pays for and two of them cannot reach.
 *
 * What is left below are the three faults every one of the four can hand over, all of them about
 * the cursor, because the cursor is the one field nothing on any of these paths checks.
 *
 * AND A QUESTION ALREADY ANSWERED STOPS HERE, WHICH IS WHAT `enough` IS FOR. Paging made three of
 * this file's answers complete and made one of them FAILABLE: {@link ComposioBroker.isConnected}
 * returns a boolean, and the first page carrying a single row has settled it — no cursor Composio
 * could send next, and no fiftieth page, can turn that `true` into anything else. Reading on
 * anyway put the two cursor refusals and the page ceiling in front of a person whose account had
 * already been found, so a fault on a page nobody needed decided the answer to a question nobody
 * still had. The default reads every page, because that is what a withdrawal and a config listing
 * genuinely need; a caller that says when it has enough is a caller that cannot be failed after it
 * has its answer.
 *
 * CHECKED WHERE THE ROWS LAND AND BEFORE THE CURSOR IS LOOKED AT, deliberately. Reading the cursor
 * first and stopping afterwards would keep every one of the three refusals reachable on the page
 * that already answered the question, which is the whole of what this closes.
 */
async function everyRowOf<Row>(
  listing: Listing,
  page: (
    cursor: string | undefined,
  ) => Promise<{ items: Row[]; nextCursor?: unknown }>,
  enough: (rows: Row[]) => boolean = () => false,
): Promise<Row[]> {
  const rows: Row[] = [];
  const followed = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const answered = await page(cursor);
    rows.push(...answered.items);
    if (enough(rows)) return rows;

    /*
     * ABSENT AND NULL BOTH MEAN THE END. The auth-config schema spells the field nullable and the
     * connected-account one spells it nullish, and a transformer that met no `next_cursor` writes
     * `response.next_cursor ?? null`.
     *
     * AND SO DOES A CURSOR WITH NOTHING IN IT, WHICH IS THE CORRECTION AND WAS THE COSTLIEST
     * REFUSAL IN THIS FILE. The claim above used to be that absent and null are "the two the vendor
     * actually sends" — which is not something this deployment can know, and the installed types
     * say otherwise: all four list responses declare `next_cursor?: string | null`
     * (`@composio/client` 0.1.0-alpha.76, `resources/auth-configs.d.ts:248`,
     * `connected-accounts.d.ts:4987`, `toolkits.d.ts:326`, `tools.d.ts:204`), so `""` is type-legal
     * on the wire, and `?? null` does not catch it. It therefore arrived here, failed
     * {@link textOf}, and became a refusal — one that kills `revoke`, `authorize`,
     * `ensureAuthConfig`, `deleteAuthConfig` and `isConnected` for EVERY app at once, permanently,
     * over a field whose whole content is that there is nothing in it.
     *
     * A CURSOR NAMES A POSITION, AND THE BLANK ONE NAMES NONE. It is exactly what this loop sends
     * when it has no position — the first request omits the field — so following it would ask for
     * page one again, and the repeat guard below would then answer the vendor's empty string with
     * a sentence accusing it of sending the same page twice. There is no reading of `""` under
     * which a second request could reach anything the first did not. So it is the end of the
     * listing, which is the same rule {@link textOf} already applies to every other identifier
     * here, applied to the one field that had been left out of it.
     *
     * WHICH IS NOT COERCION, AND THE DIFFERENCE IS THE TEST BELOW IT. A cursor that is a number, an
     * object or a list is a position this deployment cannot express and CANNOT rule out being real,
     * so it is still the refusal it always was: one page read as the whole answer is the mistake
     * this function exists to prevent. What changed is only the string that says nothing.
     */
    const next = answered.nextCursor;
    if (next === undefined || next === null) return rows;

    const follow = textOf(next);
    if (follow === null) {
      if (typeof next === "string") return rows;
      throw new BrokerRefusalError(
        `Composio sent ${sent(next)} where the cursor to the next page of ${listing.noun} belongs, so ${listing.consequence}: there are more of them than arrived and no cursor this deployment can ask for the rest with. ${VENDOR_SHAPE_REMEDY}`,
      );
    }

    /*
     * A CURSOR ALREADY FOLLOWED IS A LOOP AND NOT A PAGE. Nothing here can tell a vendor bug from a
     * proxy answering from a cache, and both end the same way: the same rows for ever. Refusing on
     * the second sight of one is what keeps a person's disconnect a request that returns.
     */
    if (followed.has(follow)) {
      throw new BrokerRefusalError(
        `Composio answered the same page of ${listing.noun} twice, so ${listing.consequence}: following its cursor did not advance, so the rest of them cannot be reached. ${VENDOR_SHAPE_REMEDY}`,
      );
    }
    followed.add(follow);

    /*
     * COUNTED AFTER THE PAGE IS RECORDED, so the number in the sentence is the number of pages that
     * happened — see {@link PAGE_CEILING} for the off-by-one this order closes.
     *
     * AND THE ROWS ARE THE ONES THAT ARRIVED. The sentence asserted `at ${LISTING_LIMIT} rows each`,
     * which is the page this deployment ASKED FOR and not one thing it measured: Composio is free
     * to answer fifty pages of one row, and a reader told the listing was fifty thousand rows long
     * would be reading a figure nothing had counted. What is said now is what was collected.
     */
    if (followed.size >= PAGE_CEILING) {
      throw new BrokerRefusalError(
        `Composio has answered ${PAGE_CEILING} pages of ${listing.noun}, ${rows.length} rows in all, and is still offering another, so ${listing.consequence}: this deployment stops there rather than read on, because what is left cannot be told from a listing that never ends. ${VENDOR_SHAPE_REMEDY}`,
      );
    }
    cursor = follow;
  }
}

/**
 * ONE PAGE OFF THE RAW CLIENT, CHECKED FOR BEING A PAGE, in the shape {@link everyRowOf} reads.
 *
 * THE TWO SDK LISTINGS DO NOT NEED THIS AND THE TWO RAW ONES CANNOT DO WITHOUT IT. Every answer the
 * wrapper hands over has already been dereferenced inside the vendor's package — both transformers
 * open with `response.items.map(...)` — so a malformed envelope there is a `TypeError` raised
 * inside `@composio/core` and translated by {@link vendorRefusal} with a sentence about a package
 * upgrade. `@composio/client` is a generated client: it parses the body and returns it. Nothing
 * looks at `items` before this file does.
 *
 * SO THE TWO SHAPES THE WRAPPER USED TO CATCH ARE CAUGHT HERE, and they are the same two:
 * an answer that is not an envelope, and an `items` that is not a list of rows. Both would
 * otherwise reach `rows.push(...answered.items)` as a bare `TypeError` naming a vendor field —
 * the crash-wearing-a-refusal's-clothes that every sentence in this file exists not to be.
 *
 * OUTSIDE {@link askVendor} RATHER THAN INSIDE IT, deliberately, and it is the reason this is a
 * function rather than four lines at each call site. That wrapper goes around the `await vendor.*`
 * AND NOTHING ELSE, which is what makes "a throw reaching `vendorRefusal` came out of the vendor's
 * code" true by construction; a refusal composed here is this file's own reading, and it already
 * carries an authored sentence.
 *
 * THE CURSOR IS RENAMED AND NOT READ. `next_cursor` is the wire's spelling and `nextCursor` is what
 * {@link everyRowOf} looks for, and it is carried across as `unknown` — every check on it belongs
 * there, where the three faults it can carry are enumerated and answered together for all four
 * listings.
 */
async function pageOf<Row>(
  listing: Listing,
  ask: () => Promise<{ items?: unknown; next_cursor?: unknown } | null>,
): Promise<{ items: Row[]; nextCursor?: unknown }> {
  const answered = await ask();
  /*
   * A BARE LIST IS EXCLUDED HERE AND NOT LEFT TO THE `items` GUARD, which is the same correction
   * every other container in this file has already had. `typeof [] === "object"` and `[] !== null`,
   * so a page that arrived as a bare list satisfied this test, fell through to the one below, and
   * was refused with "Composio sent nothing where the rows of the app catalogue belong" — a sentence
   * about an envelope whose rows did not arrive, told of an answer that held no envelope at all. An
   * operator reading it goes looking for a listing that came back short; there was no listing.
   *
   * AND IT IS THE LIKELIER OF THE TWO SHAPES RATHER THAN AN EXOTIC ONE. The SDK transformers these
   * two listings stopped going through returned bare arrays, so "a list where a page belongs" is
   * precisely what a drift back towards them would put on the wire — the one shape this guard's own
   * sentence is written for and the one it could not see.
   */
  if (
    answered === null ||
    typeof answered !== "object" ||
    Array.isArray(answered)
  ) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(answered)} where a page of ${listing.noun} belongs, so ${listing.consequence}: what came back is not a listing at all. ${VENDOR_SHAPE_REMEDY}`,
    );
  }
  if (!Array.isArray(answered.items)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(answered.items)} where the rows of ${listing.noun} belong, so ${listing.consequence}: what came back is not a listing at all. ${VENDOR_SHAPE_REMEDY}`,
    );
  }
  return { items: answered.items as Row[], nextCursor: answered.next_cursor };
}

/**
 * Where each field scheme sits in the order a person would rather meet them.
 *
 * A RECORD KEYED BY {@link FieldScheme} RATHER THAN A LIST OF THEM, because the compiler counts the
 * keys of a record and counts nothing at all about a list. This was a `readonly FieldScheme[]`
 * spelling the same four names a second time, which is precisely what the comment on
 * {@link FIELD_SCHEME_NAMES} argues against: the same set stated twice, where a member added to one
 * of them and not the other typechecks perfectly. An element type refuses a name that is not a
 * scheme and says nothing whatever about a scheme left out.
 *
 * AND THE ONE LEFT OUT FAILS OPEN, MORE QUIETLY HERE THAN THERE. A fifth scheme added to the names
 * and not given a rank here would match nothing in the pick below, so every app publishing it would
 * fall through to `unsupported` — and the directory route hides an unsupported app, so those apps
 * would simply leave the picker: no refusal for anyone to read, no operator sentence, and no failing
 * test. `Record<FieldScheme, number>` does not compile until the new scheme has a place, which is
 * the whole of the protection, and the reason the pick goes through {@link isFieldScheme} rather
 * than through a second list of names.
 *
 * THE ORDER ITSELF IS THE PERSON'S AND NOT THE WIRE'S, and it is unchanged: a plain key first,
 * because it is the one they are likeliest to already hold, then the other three ways of spelling a
 * secret they have to go and assemble.
 */
const FIELD_SCHEME_ORDER: Record<FieldScheme, number> = {
  API_KEY: 0,
  BEARER_TOKEN: 1,
  BASIC: 2,
  BASIC_WITH_JWT: 3,
};

/**
 * The schemes a managed config can actually send somebody to a page for, as the VENDOR names them.
 *
 * WHICH IS THE WHOLE OF WHAT `consent` CLAIMS. That kind means one thing below: create a
 * `use_composio_managed_auth` config and mint a link the person visits. Composio publishes the set
 * of schemes a link exists for and calls it exactly that — `RedirectableAuthSchemeSchema` is
 * `z.enum([OAUTH1, OAUTH2])` (`@composio/core` 0.18.1,
 * `src/types/connectedAccountAuthStates.types.ts:15-18`) — so a managed scheme outside it has no
 * page to send anybody to, whatever else is true of it.
 *
 * `DCR_OAUTH` IS NOT HERE AND IS NOT AN OMISSION. The vendor leaves it out of that enum and this
 * file drives it through its own kind — `self-registering`, a CUSTOM config whose client registers
 * itself at connect time — so it is read off {@link VendorToolkit.auth_schemes} below rather than
 * off the managed list.
 */
const REDIRECTING_SCHEMES = ["OAUTH2", "OAUTH1"];

/**
 * The scheme Composio publishes for an app that asks nobody for anything.
 *
 * THE FLAG AND THE SCHEME ARE TWO SPELLINGS OF ONE FACT, and only the second is guaranteed. A
 * toolkit needing no authentication publishes `NO_AUTH` among its schemes; `no_auth` is an
 * additional boolean the catalogue MAY carry, and `ToolKitItemSchema` spells it optional. Reading
 * only the flag made an app that published the scheme without it `unsupported` — whose sentence
 * claims the app wants an OAuth application registered here, which is the opposite of true — and
 * `routes.ts` then hid the app from the picker over it.
 */
const NO_AUTH_SCHEME = "NO_AUTH";

/**
 * The words out of an `unknown`, which is all a vendor list promises — and a refusal for the rest.
 *
 * ABSENT IS AN ANSWER AND UNREADABLE IS NOT, WHICH IS THE WHOLE OF THE CORRECTION. Composio
 * genuinely lists toolkits with no scheme beside them at all, and {@link connectionOf} reads that
 * as an app nothing here can connect — a true thing to say about a real row. This used to answer
 * the same empty list for an `auth_schemes` that arrived as a string, and for a list one of whose
 * members was not a word: the unreadable answer and the honest absence became the same sentence,
 * and an unsupported app is HIDDEN from the picker, so the one nobody could act on was also the one
 * nobody could see. On the managed list it is louder still — an app whose consent screen would have
 * asked a person for nothing drops a rank and starts asking them to go and find a key.
 *
 * A MEMBER IS GUARDED AS HARD AS THE LIST, because dropping the ones that are not words leaves a
 * shorter list that reads exactly like a shorter list the app published, and the decision below is
 * made on which words are in it.
 *
 * AND THE WORD IS THE TRIMMED ONE, WHICH IS WHY THE MEMBER GOES THROUGH {@link textOf}. A scheme is
 * the NAME of a flow: it is compared against the literals below and recorded on the app's row when
 * somebody enables it, so a padded `" OAUTH2 "` is the app's own scheme wearing whatever the wire
 * wrapped it in, and `"  "` is the one unusable value that reads as present at every glance.
 *
 * `where` IS THE NOUN PHRASE THE SENTENCE IS BUILT AROUND, so the two call sites differ in the one
 * thing that differs between them: which of an app's two scheme lists could not be read.
 */
function labelsOf(value: unknown, where: string): string[] {
  const listed = value ?? [];
  if (!Array.isArray(listed)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(value)} where ${where} belong. This deployment reads that list to decide which flow the app gets, and an app that publishes no scheme at all is ordinary and shows as one nothing here can connect — so a list that is not a list would show as that same app, missing from the picker for a reason nobody could act on. ${VENDOR_SHAPE_REMEDY}`,
    );
  }
  return listed.map((entry: unknown, index: number) => {
    const scheme = textOf(entry);
    if (scheme === null) {
      throw new BrokerRefusalError(
        `Composio sent ${sent(entry)} where scheme ${index + 1} of ${where} belongs, and a scheme is the word this deployment matches against the flows it knows how to run. Leaving out the ones that are not words makes a shorter list, which reads exactly like a shorter list the app published. ${VENDOR_SHAPE_REMEDY}`,
      );
    }
    return scheme;
  });
}

/**
 * One step of the connection form's read that Composio answered with a shape nothing here can open.
 *
 * WHY THIS IS A REFUSAL AND NOT AN EMPTY FORM is the argument {@link labelsOf} makes about an app's
 * scheme lists, arriving where it costs the most. {@link ComposioBroker.connectionFields}
 * reads the boxes an app asks for a step at a time off `unknown` — the modes, the recorded one's
 * `fields`, the initiation block inside that, and the two lists of rows inside that — and every
 * step of it answered an empty list for a shape it could not make sense of. An empty list is a
 * sentence some modes truthfully say. A step that arrived as something else says only that Composio
 * moved the shape, and the two reached the browser as the same empty form: a person presses submit
 * on it, {@link ComposioBroker.connectWithFields} creates a connection carrying no credential at
 * all, Composio answers `ACTIVE` because it does not grade what it is given, and the first call
 * made with the account is what discovers anything is wrong.
 *
 * NOT THE SENTENCE FOR A MODE THE APP HAS STOPPED PUBLISHING, which is the other half of the same
 * confusion. That one is a real drift between the recorded scheme and the vendor, and its remedy is
 * an administrator's: remove the app and add it again so the scheme is recorded afresh. Nothing an
 * administrator can do fixes a shape Composio changed, and handing them that remedy sends them to
 * re-add an app whose publication never moved — after which the re-add reads the same unreadable
 * answer and records the same word.
 */
function unreadableForm(was: unknown, where: string): BrokerRefusalError {
  return new BrokerRefusalError(
    `Composio sent ${sent(was)} where ${where} belongs, and this deployment reads that answer to draw the boxes a person types their credential into. An app that asks for nothing and an answer this deployment cannot read would be the same empty form, and submitting an empty form makes a connection carrying no credential at all that Composio accepts and the first tool call discovers — so no form was drawn. ${VENDOR_SHAPE_REMEDY}`,
  );
}

/**
 * Which flow an app gets, and why that order.
 *
 * NO AUTHENTICATION FIRST, AND IT IS NOT A PREFERENCE. Composio refuses an auth config for such a
 * toolkit outright — "Cannot create an auth config for toolkit hackernews because it does not
 * require authentication" — so an app that says so has no other reading available, whatever else it
 * publishes beside it. It says so in either of two places; see {@link NO_AUTH_SCHEME}.
 *
 * Then managed OAuth, because it asks the person for nothing at all — and MANAGED OAUTH IS READ
 * RATHER THAN COUNTED, which is the difference between a consent and a dead end. This tested the
 * LENGTH of the managed list, so a list holding any word at all became `consent`: the app got a
 * Composio-managed config and a person got sent to a link mint for a scheme with no page behind it.
 * {@link REDIRECTING_SCHEMES} is the vendor's own answer to which words have one.
 *
 * Then self-registering OAuth, which asks nobody for anything: the client registers itself at
 * consent time. Then a scheme whose secret the person already holds. What is left wants an OAuth
 * client registered by whoever runs this deployment, and there is nowhere here to put one, so it is
 * named rather than attempted.
 *
 * AND "UNSUPPORTED" IS A VERDICT RATHER THAN A PLACE TO PUT WHAT COULD NOT BE READ. `routes.ts`
 * hides an unsupported app from the picker, and the enable route answers its `reason` — so a row
 * whose shape this file could not read used to leave the catalogue silently, under a sentence
 * telling an administrator the app wants an OAuth application when nothing here had established
 * that. Every unreadable shape now refuses, which stops the whole catalogue for the reason
 * {@link appOf} gives at length: one refusal an operator can act on is worth more than several
 * hundred rows, one of which is a guess.
 */
export function connectionOf(row: VendorToolkit): BrokerConnection {
  /*
   * THE APP IS NAMED OFF THE ROW RATHER THAN HANDED IN, because a refusal out of {@link labelsOf}
   * travels up through {@link appOf} and onto an operator's page, where "this app" is a sentence
   * with nothing to look for in it. {@link appOf} refuses a row with no readable slug before it
   * reaches here, so the fallback is for the one caller that is a test.
   */
  const at = textOf(row.slug) ?? "this app";
  const offered = labelsOf(
    row.auth_schemes,
    `the authentication schemes ${at} offers`,
  );
  const managed = labelsOf(
    row.composio_managed_auth_schemes,
    `the authentication schemes Composio holds ${at}'s own credentials for`,
  );

  /*
   * AND A FLAG THIS FILE CANNOT READ IS NOT THE SAME AS ONE THE APP DOES NOT PUBLISH. Most rows
   * carry no `no_auth` at all and reading that as "this app needs authenticating" is the right
   * answer, which is what {@link flagOf}'s default keeps — and the scheme list below carries the
   * same fact for every toolkit that publishes it. A `no_auth` that is PRESENT and is not a
   * boolean has no such reading: `"true" === true` is false, so the vendor saying an app needs
   * nothing arrived at the very check that acts on it as the vendor having said nothing — and the
   * app is then enabled down a path Composio refuses outright ("Cannot create an auth config for
   * toolkit hackernews because it does not require authentication"), or a person is sent to a form
   * for a credential the app has no use for.
   */
  const flagged = flagOf(row.no_auth, false);
  if (flagged === null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row.no_auth)} where its flag saying whether ${at} needs authenticating at all belongs, and that one field decides the whole of the flow: an app flagged this way is one Composio REFUSES an authorization config for, whatever else it publishes beside the flag. A value this deployment cannot read is not the app's silence on the question, so it is not read as one. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  if (flagged || offered.includes(NO_AUTH_SCHEME)) return { kind: "no-auth" };

  if (managed.some((scheme) => REDIRECTING_SCHEMES.includes(scheme))) {
    return { kind: "consent" };
  }
  if (offered.includes("DCR_OAUTH")) return { kind: "self-registering" };

  const field = offered
    .filter((scheme) => isFieldScheme(scheme))
    .sort(
      (left, right) => FIELD_SCHEME_ORDER[left] - FIELD_SCHEME_ORDER[right],
    )[0];
  if (field) return { kind: "fields", authScheme: field };

  /*
   * THE SENTENCE NAMES WHAT WAS ACTUALLY PUBLISHED, INCLUDING THE MANAGED WORDS NOTHING ELSE READS.
   * A managed list of schemes that do not redirect is now the commonest way to reach this branch,
   * and a reason built from `auth_schemes` alone would tell an administrator the app published
   * nothing — about a row that published something this deployment simply cannot drive.
   */
  const published = [...new Set([...offered, ...managed])];
  return {
    kind: "unsupported",
    reason: published.length
      ? `${published.join(", ")} needs an OAuth application registered by whoever runs this deployment, and this deployment holds no place to put its own OAuth client for a brokered app.`
      : "Composio published no authentication scheme for this app, so there is no flow this deployment could run, and its own OAuth client is not something this deployment can register.",
  };
}

/**
 * One catalogue row checked into the app an administrator picks from, or a refusal saying why not.
 *
 * A ROW THIS FILE CANNOT READ STOPS THE WHOLE CATALOGUE, for the reason the full-page guard in
 * {@link buildComposioClient} gives at length: the directory is held for ten minutes and both the
 * picker and the enable route read the held copy, so a row quietly dropped is an app missing from a
 * search and an app whose Add button reports that Composio does not publish it. One refusal an
 * operator can act on is worth more than several hundred rows, one of which is a guess.
 *
 * THE ABSENCES THAT ARE REAL ANSWERS ARE STILL ANSWERS. Composio genuinely publishes toolkits with
 * no description, no logo, no category and no count, and each of those is a fact about the app
 * rather than a fault in the answer — so an absent one becomes the value that reads honestly on a
 * screen, exactly as it did before. What is refused is the other thing: a field that is PRESENT and
 * is not what it is declared to be. A count that arrived as the string "63" is not a count, and
 * `Number(x)` over it would turn a vendor change into a plausible figure nobody would question.
 *
 * THE ROW'S SHAPE IS CHECKED AGAIN, AND THAT IS THE RAW CLIENT RATHER THAN A CHANGE OF MIND. Two
 * refusals used to open this function — one for a row that is not an object, one for a row with no
 * meta — and they were deleted because neither could be reached: `transformToolkitListResponse`
 * read `item.meta.categories` while building each row (`@composio/core` 0.18.1,
 * `src/utils/transformers/toolkits.ts:27`) and `Toolkits.getToolkits` rethrew everything as
 * `ComposioToolkitFetchError` (`src/models/Toolkits.ts:70-82`), so a catalogue this deployment
 * could not read never became a row here at all. The catalogue does not go through that function
 * any more — see {@link ComposioVendor} — and both shapes now arrive.
 *
 * BOTH ARE BACK RATHER THAN LEFT TO THE FIELD READS, and the reason is the category guard three
 * screens down, which was deleted on the same reasoning and restored after it was RUN. `("gmail")
 * .slug` is `undefined` and not a throw, so a row that is a bare string would be refused with
 * "Composio sent nothing where the slug of row 1 of Composio's app catalogue belongs" — a sentence
 * that sends an operator looking in a dashboard for an app with a missing slug, about an answer
 * that had no app in it. A guard whose absence is argued from a dereference that does not
 * dereference is not a guard anything should rest on.
 */
function appOf(row: VendorToolkit, position: number): BrokerApp {
  const at = `row ${position + 1} of Composio's app catalogue`;

  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row)} where ${at} belongs, and a catalogue row is an object carrying an app's slug and name. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const slug = textOf(row.slug);
  if (slug === null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row.slug)} where the slug of ${at} belongs. The slug is the only name this deployment has for an app — it is what enabling one records and what every later call names — so the directory was not shown, rather than shown with an app nothing could be done with. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const name = textOf(row.name);
  if (name === null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row.name)} where the name of ${at} belongs, and ${slug} is a slug rather than a title, so there is nothing to show an administrator choosing between apps. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  /*
   * `meta` IS CHECKED FOR BEING AN OBJECT, WHICH IT DID NOT USED TO BE AND NOW HAS TO BE.
   *
   * The argument for taking it on trust was `transformToolkitListResponse`: it read
   * `item.meta.categories` while building each row and then spread the result into a fresh literal
   * (`@composio/core` 0.18.1, `src/utils/transformers/toolkits.ts:24-38`), so a meta that was
   * absent or null raised there and every meta that did arrive was an object whatever the wire had
   * sent. That was a guarantee about the transformer, it was written down as one, and the catalogue
   * no longer goes through it — see {@link ComposioVendor}, where the toolkit listing names the raw
   * client because the wrapper could not be paged.
   *
   * WHAT THE ABSENT GUARD WOULD COST IS FOUR SILENT ABSENCES RATHER THAN A CRASH, which is the
   * worse of the two. `meta.description` off the string "productivity" is `undefined`, not a throw,
   * and so are the logo, the categories and the count — so a row this file cannot read would show
   * on an administrator's screen as a real app that publishes nothing, indistinguishable from the
   * many that genuinely publish little. Absent IS an answer here, which is exactly why a meta that
   * is present and is not a meta cannot be allowed to look like one.
   */
  const rawMeta = row.meta;
  if (
    typeof rawMeta !== "object" ||
    rawMeta === null ||
    Array.isArray(rawMeta)
  ) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row.meta)} where ${slug}'s description, logo, categories and action count belong. Every one of those is a thing an app is allowed to publish none of, so a row whose metadata is not readable at all would show as a real app that publishes nothing rather than as the answer this deployment could not read. ${VENDOR_SHAPE_REMEDY}`,
    );
  }
  const meta = rawMeta as {
    description?: unknown;
    logo?: unknown;
    categories?: unknown;
    tools_count?: unknown;
  };

  const description = meta.description ?? "";
  if (typeof description !== "string") {
    throw new BrokerRefusalError(
      `Composio sent ${sent(meta.description)} where ${slug}'s description belongs. An app that publishes none is ordinary and reads as a gap on the page; an app whose description is not text is an answer this deployment cannot show. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const logo = meta.logo ?? null;
  if (typeof logo !== "string" && logo !== null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(meta.logo)} where ${slug}'s logo belongs, and this deployment puts that value in an image address. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  /*
   * NEITHER THE LIST NOR THE ENTRIES IN IT ARE ANYBODY'S CONSTRUCTION NOW, so both are checked.
   *
   * The list used to be the transformer's: `item.meta.categories?.map(category => ({ slug:
   * category.id, name: category.name }))` (`@composio/core` 0.18.1,
   * `src/utils/transformers/toolkits.ts:27-30`) has no `.map` for a `categories` that is not a
   * list, and that half genuinely held when it was run. It does not hold through the raw client,
   * where nothing maps this field at all — a `categories` of "productivity" would simply read as an
   * app in no category, which is a state real apps are in.
   *
   * THE ENTRY GUARD WAS ALREADY BACK, AND FOR A REASON WORTH KEEPING IN VIEW. It had been deleted
   * on the ground that "a category that is null throws on `.id`, and everything that survives is an
   * object". Only the first clause was ever true: `("crm").id` is `undefined`, not a throw, and so
   * is `(7).id` — so a primitive survived the map as `{ slug: undefined, name: undefined }`, and
   * the whole catalogue was refused with "Composio sent nothing where the name of gmail's category
   * 1 belongs" about a value that was the string "crm". An operator reading that goes looking in a
   * dashboard for a category with a missing name, and there is no such category.
   *
   * SO THE SHAPE IS TESTED BEFORE THE FIELD IS READ, twice over, and the three faults get the three
   * sentences they are. The vendor's own word is `name` on both spellings of this row
   * (`@composio/client` 0.1.0-alpha.76, `resources/toolkits.d.ts:425-435`), which is why that is
   * the one field read.
   */
  const listed = meta.categories ?? [];
  if (!Array.isArray(listed)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(meta.categories)} where ${slug}'s categories belong, and the catalogue shows an app's categories as the words a person chooses by. An app in no category is ordinary; a list of them that is not a list is an answer this deployment cannot show. ${VENDOR_SHAPE_REMEDY}`,
    );
  }
  const categories = listed.map((entry: unknown, index: number) => {
    const at = `${slug}'s category ${index + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new BrokerRefusalError(
        `Composio sent ${sent(entry)} where ${at} belongs, and a category is an object carrying the word a person picks an app by. ${VENDOR_SHAPE_REMEDY}`,
      );
    }
    const label = textOf((entry as { name?: unknown }).name);
    if (label === null) {
      throw new BrokerRefusalError(
        `Composio sent ${sent((entry as { name?: unknown }).name)} where the name of ${at} belongs. The catalogue shows an app's categories as the words a person chooses by, so a category with no name is a blank one of those. ${VENDOR_SHAPE_REMEDY}`,
      );
    }
    return label;
  });

  /*
   * `tools_count` IS THE WIRE'S OWN KEY AND `toolsCount` WAS THE WRAPPER'S RESTATEMENT OF IT
   * (`@composio/client` 0.1.0-alpha.76, `resources/toolkits.d.ts:405-408`;
   * `@composio/core` 0.18.1, `src/utils/transformers/toolkits.ts:34`). Reading the old key off the
   * new answer is the one mistake in this function that would not look like one: every count would
   * be `undefined`, every count would default to zero, and every app in the picker would say it
   * publishes no actions — a plausible figure on a page whose whole job is to show one. Which is
   * why it is a number a test asserts rather than a field a type checks.
   */
  const actionCount = meta.tools_count ?? 0;
  if (typeof actionCount !== "number" || !Number.isFinite(actionCount)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(meta.tools_count)} where ${slug}'s action count belongs. The count is shown BEFORE anybody enables an app, because it is the difference between a small addition and a rewrite of what a model sees, so a figure derived from a value that is not a number is the one number here nobody would think to question. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  return {
    slug,
    name,
    description,
    logo,
    categories,
    actionCount,
    connection: connectionOf(row),
  };
}

/**
 * One auth config with the two fields every decision here turns on, checked.
 *
 * `status` IS CARRIED ACROSS UNCHECKED ON PURPOSE, which is the one field of the three this reader
 * does not settle. {@link ComposioBroker.authorize} is its only reader and it has three answers to
 * give rather than two — enabled, disabled, and a word the vendor has invented since — so a check
 * here could only collapse the third into one of the first two, which is the exact defect being
 * closed. It is left as `unknown` so the reader has to say what it does with it.
 */
type CheckedAuthConfig = {
  id: string;
  name: string;
  status: unknown;
};

/**
 * That status as the WORD it is, so the test and the sentence about it are about the same value.
 *
 * THE TWO READINGS OF THIS ONE FIELD DISAGREED, AND THE DISAGREEMENT REACHED AN OPERATOR AS A
 * SENTENCE CONTRADICTING ITSELF. Both callers tested the RAW value — `=== "ENABLED"` to pick the
 * config a connection is made against, `!== "DISABLED"` to sort the rest — while {@link named}
 * quotes the TRIMMED one. So a status of `" ENABLED "` was refused for not being ENABLED and then
 * reported as `"ENABLED", which is neither ENABLED nor DISABLED`: a claim the reader can see is
 * false, ending in a remedy — upgrade the package — that is nobody's act on the page they are
 * standing on, about a config Composio calls enabled and this deployment made.
 *
 * IT COSTS MORE THAN THE SENTENCE. A padded `" ENABLED "` is an app nobody can connect at all,
 * through either door, for as long as the vendor pads it; a padded `" DISABLED "` is a disabled
 * config an operator is never told to go and enable. This is the same argument {@link textOf} makes
 * for every identifier in this file and {@link labelsOf} makes for a scheme name — the value is the
 * word, and the padding is whatever the wire wrapped it in — arriving at the one field that had
 * been left out of it.
 *
 * NULL FOR ANYTHING THAT IS NOT A WORD, which keeps the third answer this type exists to preserve:
 * a status that is absent, or that arrived as a number or an object, is neither ENABLED nor
 * DISABLED and is sorted by both callers exactly as it was before.
 */
function statusOf(config: CheckedAuthConfig): string | null {
  return textOf(config.status);
}

/**
 * One app's auth configs split into the ones a decision can be made about and the ones it cannot.
 *
 * EVERY ROW IS CHECKED AND NOT ONLY THE ONES THAT TURN OUT TO BE OURS, because which ones are ours
 * is precisely what the name decides. A row whose name cannot be read cannot be sorted into "made
 * here" or "somebody's dashboard work", and both of the guesses are damaging in opposite
 * directions: read as somebody else's, {@link ComposioBroker.ensureAuthConfig} creates a second
 * config beside it and splits one app's connections in two; read as ours,
 * {@link ComposioBroker.deleteAuthConfig} deletes an object nobody here chose and every account
 * anybody had connected against it.
 *
 * PARTITIONED RATHER THAN THROWN, WHICH IS THE SAME CORRECTION {@link withdrawableAccounts}
 * ALREADY CARRIES ONE LEVEL DOWN, ARRIVING HERE A WAVE LATE. This checked every row on the way out
 * of the listing and threw on the first one it could not read, so a single unreadable config row
 * was a permanent block on everything behind it: a person pressing disconnect got the same throw
 * every time, for ever, because the row will be exactly as unreadable on the next attempt and
 * nothing they can reach changes it. That is not the safe end of the trade — it is the SAME defect
 * as a false success, pointing the other way, which is the finding the accounts path was corrected
 * for and this one was left standing on.
 *
 * WHAT A CALLER IS OWED IS BOTH HALVES: every config this file CAN decide about, decided about, and
 * a refusal counting the ones it cannot. Which half matters differs per caller and is therefore
 * settled at each of the four rather than here — a withdrawal acts on what it can name and reports
 * the rest, a creation must not put a second config beside a row that might already be ours, and a
 * connect link minted against a readable config of ours is right whatever else the listing held.
 *
 * AND ONE ID IS ONE CONFIG, HOWEVER MANY TIMES THE LISTING NAMED IT — the other half
 * {@link withdrawableAccounts} had and this did not. The paging loop guards against a repeated
 * CURSOR and not a repeated ROW, and a page boundary crossed while a config is being created, or a
 * proxy stitching two overlapping pages together, hands one id over twice with the cursor
 * advancing normally each time. The second delete of one config then meets Composio's "there is no
 * such auth config", which arrives as a refusal — so {@link ComposioBroker.deleteAuthConfig}
 * counted a removal that had in fact completed as a partial one and refused to finish removing the
 * app, every time, over a duplicate that is still there on the retry. It also inflates the count
 * both that method and {@link ComposioBroker.authorize} put in front of an operator, and sends the
 * same id twice in the withdrawal's `authConfigIds` filter.
 *
 * THE FIRST SIGHTING KEEPS ITS PLACE, exactly as it does for accounts; the caller sorts on the id
 * afterwards, so the order two callers see is the same one either way.
 */
function readableConfigs(
  rows: VendorAuthConfig[],
  toolkit: string,
): { configs: CheckedAuthConfig[]; unreadable: BrokerRefusalError[] } {
  const configs: CheckedAuthConfig[] = [];
  const alreadyRead = new Set<string>();
  const unreadable: BrokerRefusalError[] = [];

  rows.forEach((row, position) => {
    const at = `row ${position + 1} of Composio's authorization configs for ${toolkit}`;

    const id = textOf(row.id);
    if (id === null) {
      unreadable.push(
        new BrokerRefusalError(
          `Composio sent ${sent(row.id)} where the id of ${at} belongs, and the id is the whole of what a deletion names. Nothing was sent for that row, because a delete without one asks Composio to remove whatever it cares to while this deployment records that the app was withdrawn. ${VENDOR_SHAPE_REMEDY}`,
        ),
      );
      return;
    }

    /*
     * THE REPEAT IS DROPPED BEFORE THE NAME IS READ, AND THE ORDER IS THE WHOLE OF IT.
     *
     * This test used to sit BELOW the name guard, so a second sighting of an id already accepted
     * was still pushed into `unreadable` if THAT COPY's name was unreadable — which contradicts the
     * invariant stated above, ONE ID IS ONE CONFIG HOWEVER MANY TIMES THE LISTING NAMED IT. The
     * paged listing repeating `ac_1` across a page boundary is the exact race that comment is
     * written for, and the repeat can perfectly well arrive as `{ id: "ac_1", name: null }` — a
     * rename in flight in the dashboard, or a proxy stitching two partial reads.
     *
     * WHAT THAT COST IS A REFUSAL AFTER THE WORK WAS ALREADY DONE. `configs` held the one readable
     * `ac_1` and `unreadable.length` was 1, so `deleteAuthConfig` and `revoke` — which both act on
     * what they can name and then report the rest — deleted the config, succeeded, and THEN threw
     * "…and the app has not been fully withdrawn", over a config that was already gone.
     * `removeServer` therefore left the app's row standing behind a completed removal.
     *
     * Read the id, settle whether this row is new, and only then ask anything else of it.
     */
    if (alreadyRead.has(id)) return;
    alreadyRead.add(id);

    const name = textOf(row.name);
    if (name === null) {
      unreadable.push(
        new BrokerRefusalError(
          `Composio sent ${sent(row.name)} where the name of ${at} belongs, and the name is the only thing that says whether this deployment made a config or an operator built it by hand in Composio's dashboard. Neither guess is safe: one splits this app's connections across two configs, and the other deletes a config nobody here chose along with every account connected against it. ${VENDOR_SHAPE_REMEDY}`,
        ),
      );
      return;
    }

    configs.push({ id, name, status: row.status });
  });

  return { configs, unreadable };
}

/**
 * This person's accounts split into the ones a withdrawal can name and the ones it cannot.
 *
 * THE ID IS THE WHOLE OF WHAT A WITHDRAWAL NAMES, which is why it is read at all.
 * {@link ComposioBroker.revoke} deletes by id and then answers `true`, and `store.ts` writes that
 * answer into the audit trail as this person's access having been withdrawn before deleting the one
 * row in this deployment naming which app they had connected. An id-less account reaching the
 * delete is a request to withdraw `undefined` — which the vendor is free to read as anything at all
 * — followed by a `true`, a trail entry, and a live grant with nothing left pointing at it.
 *
 * PARTITIONED RATHER THAN THROWN, AND THAT IS THE CORRECTION. This reader used to refuse, and the
 * caller mapped EVERY row through it before sending a single delete — so one row whose id Composio
 * omitted threw ahead of the first withdrawal, and the next attempt met the same row and threw in
 * the same place. A person with three grants and one unreadable row could not withdraw any of them,
 * ever, while being told to try again. That replaced a false success with a permanent block, which
 * is the same defect pointing the other way.
 *
 * WHAT A PERSON IS OWED IS BOTH HALVES: every grant this deployment CAN name withdrawn, and a
 * sentence counting the ones it cannot. The second half is not a thing they can retry — the row
 * will be unreadable next time too — so the refusal names the dashboard rather than the button
 * they just pressed.
 *
 * A ROW THAT IS NOT AN OBJECT IS NOT A CASE HERE, and that is the SDK's doing rather than an
 * omission. `transformConnectedAccountResponse` reads `response.auth_config.id` while building
 * every row (`@composio/core` 0.18.1, `src/utils/transformers/connectedAccounts.ts:60`), so a
 * non-object row raises a `TypeError` inside the vendor's own code and never reaches this function
 * — see the `TypeError` row in {@link vendorRefusal}, which is where that answer is now given.
 *
 * ONE ID IS ONE WITHDRAWAL, HOWEVER MANY TIMES THE LISTING NAMED IT. The paging loop above guards
 * against a vendor repeating a CURSOR and not against it repeating a ROW, and those are different
 * faults: a page boundary crossed while an account is created or deleted, or a proxy stitching two
 * overlapping pages together, hands the same account id over twice with a cursor that advanced
 * normally every time. The second delete of one account then meets Composio's "there is no such
 * account", which arrives here as a refusal — so {@link ComposioBroker.revoke} counted a
 * withdrawal that had in fact completed as a partial one, threw over it, and left the person's
 * connection row standing to be pressed again. Every retry meets the same duplicate. Deduplicating
 * is not tidying the listing: it is the difference between one account and two.
 *
 * THE FIRST SIGHTING KEEPS ITS PLACE, so the order the deletes go out in is still the listing's,
 * which is the order {@link buildComposioClient}'s sort makes stable.
 */
function withdrawableAccounts(
  rows: { id?: unknown }[],
  toolkit: string,
): { ids: string[]; nameless: BrokerRefusalError[] } {
  const ids: string[] = [];
  const alreadyNamed = new Set<string>();
  const nameless: BrokerRefusalError[] = [];

  rows.forEach((row, position) => {
    const id = textOf(row.id);
    if (id === null) {
      nameless.push(
        new BrokerRefusalError(
          `Composio sent ${sent(row.id)} where the id of row ${position + 1} of its ${toolkit} accounts for this person belongs, and the id is the whole of what a withdrawal names. Nothing was sent for that account, because a delete without one is a request this deployment cannot describe, after which the audit trail would record that this person's access had ended while their grant stood. ${VENDOR_SHAPE_REMEDY}`,
        ),
      );
      return;
    }
    if (alreadyNamed.has(id)) return;
    alreadyNamed.add(id);
    ids.push(id);
  });

  return { ids, nameless };
}

/**
 * Composio's own verdict on one withdrawal, as a refusal wherever it is not a yes.
 *
 * THE VENDOR TELLS US WHEN THE DELETE DID NOT HAPPEN AND NOTHING WAS LOOKING. `success` is a
 * required field of `ConnectedAccountDeleteResponse` — see the declaration on
 * {@link ComposioVendor}'s `connectedAccounts.delete` — and the answer used to be thrown away
 * unread. A 200 whose body says `success: false` therefore became a withdrawn account in
 * {@link ComposioBroker.revoke}'s count, a `true` out of that method, and a
 * `vendorRevocationRequested: true` in the audit trail, over a grant Composio had just said it had
 * not touched. That is the same class of lie as the unflagged delete before it and the one-page
 * listing before that, arriving through the one door left unwatched: the reply.
 *
 * WHICH DOES NOT BLUR "ASKED" INTO "DONE", and the distinction is worth being exact about because
 * the whole audit field rests on it. `success: true` still claims no more than it ever did — the
 * account is gone at the broker and the revocation job was started — and whether Google honoured it
 * happens afterwards, out of sight, with no supported way to poll. What `success: false` adds is
 * the other end: Composio did not delete the account, so there is no job and nothing was asked of
 * the provider at all. Reading it narrows the set of things `true` can be covering up rather than
 * widening what `true` means.
 *
 * TWO SENTENCES, BECAUSE THEY ARE TWO DIFFERENT FACTS ABOUT TWO DIFFERENT THINGS. "Composio said
 * no" is a fact about this account: the account is still there, a second press reaches it, and the
 * caller's own count already says to press again. "Composio answered with something where its
 * verdict belongs" is a fact about the package — nobody holding an admin page can correct the shape
 * of a reply, and pressing disconnect again would be answered identically — so it carries
 * {@link VENDOR_SHAPE_REMEDY} instead. Collapsing the two would send an operator to press a button
 * for a condition no button changes.
 *
 * NULLABLE IN THE PARAMETER THOUGH THE DECLARATION SAYS OTHERWISE. The generated client parses the
 * body and returns it, and there are two answers for which it hands over no body at all.
 *
 * AND NO BODY AT ALL IS NOT A REFUSAL, WHICH IS THE CORRECTION AND THE OPPOSITE MISTAKE TO THE ONE
 * ABOVE. `defaultParseResponse` resolves a 204 to `null` — "fetch refuses to read the body when the
 * status code is 204" — and a JSON reply carrying `content-length: 0` to `undefined`
 * (`@composio/client` 0.1.0-alpha.76, `src/internal/parse.ts:16-42`). Neither of those ever reaches
 * a non-2xx: the client throws `APIError` for every `!response.ok` before parsing
 * (`src/client.ts:539`), so an answer arriving here at all is Composio having accepted the request.
 * A 204 is therefore the vendor saying it did the delete and has nothing to add, and the guard
 * added for `success: false` read it as the one shape it could not tell apart from a failure —
 * turning a withdrawal that HAPPENED into a partial-withdrawal refusal, over a grant that was in
 * fact ended. That is the same lie as the one this function exists to stop, pointing the other way.
 *
 * WHICH IS NOT THE SAME AS A BODY THAT ARRIVED WITHOUT THE FIELD. `{}` is Composio answering with a
 * document whose verdict is missing, and a document this deployment cannot read is a fact about the
 * package rather than an outcome — so it stays in the unreadable branch below. What is exempted
 * here is the narrower thing the client documents: no document.
 *
 * AND A BODY THAT IS NOT A DOCUMENT IS A THIRD THING AGAIN, WHICH THE LAST BRANCH USED TO SPEAK FOR.
 * The same parse that hands over `{}` hands over whatever else the body held, so a reply that is a
 * bare string or a list reaches this read too — and `("deleted").success` is `undefined`, not a
 * throw. The refusal then said "Composio sent nothing where its verdict belongs, and that field is
 * the only thing in the reply that says whether the account was deleted": a claim about a reply with
 * one field missing, made about an answer that was not a reply. The shape is the whole finding, and
 * it was the one part the sentence did not name. The parameter widens to `unknown` for the same
 * reason — a declaration naming `{ success?: unknown }` over a wire value is the assertion this file
 * refuses to make everywhere else.
 */
function withdrawalDeclined(
  answer: unknown,
  toolkit: string,
): BrokerRefusalError | null {
  if (answer === null || answer === undefined) return null;
  if (typeof answer !== "object" || Array.isArray(answer)) {
    return new BrokerRefusalError(
      `Composio sent ${sent(answer)} where its reply to the withdrawal of one of this person's ${toolkit} accounts belongs, so there is no field in it saying whether the account was deleted at all. This deployment cannot tell a withdrawal that happened from one that did not, so the account is reported as still standing rather than counted as ended. ${VENDOR_SHAPE_REMEDY}`,
    );
  }
  const verdict = (answer as { success?: unknown }).success;
  if (verdict === true) return null;
  if (verdict === false) {
    return new BrokerRefusalError(
      `Composio answered the withdrawal of one of this person's ${toolkit} accounts with success: false, so it did not delete the account and started no revocation of the grant behind it. Nothing was asked of the provider for that account, whatever this deployment would otherwise have recorded. Disconnecting again asks Composio for it a second time.`,
    );
  }
  return new BrokerRefusalError(
    `Composio sent ${sent(verdict)} where its verdict on the withdrawal of one of this person's ${toolkit} accounts belongs, and that field is the only thing in the reply that says whether the account was deleted at all. This deployment cannot tell a withdrawal that happened from one that did not, so the account is reported as still standing rather than counted as ended. ${VENDOR_SHAPE_REMEDY}`,
  );
}

/**
 * One tool row as the action this deployment holds, with the one check the SDK's schema leaves open.
 *
 * THE VENDOR USED TO VALIDATE THIS ROW AND NO LONGER DOES, WHICH IS WHY THE GUARDS ARE ALL HERE.
 * `transformToolCases` ends in `ToolSchema.parse(...)` — a THROWING parse rather than the
 * warn-only `transform()` every other listing goes through (`@composio/core` 0.18.1,
 * `src/models/Tools.ts:193`) — and the listing used to run through it (`:561`). It does not any
 * more: `getRawComposioTools` is the one method of the vendor's tool model that cannot be paged,
 * so the listing reads `client.tools.list` and {@link VendorToolRow} is the wire's own shape. Five
 * refusals once stood here for five shapes that parse caught — a description that is a number, an
 * input schema that is a string of JSON, tags that are not all labels, a version that is a number,
 * and a row that is not an object at all — and each was deleted as unreachable. Four of the five
 * had already come back, on the argument below. The fifth, the container, comes back with this
 * change, because there is nothing at all between Composio and this function now.
 *
 * THE ARGUMENT THAT BROUGHT THE OTHER FOUR BACK IS THE SAME MISTAKE AS THE DELETED CATEGORY GUARD
 * IN {@link appOf}, CORRECTED THE SAME WAY. "The SDK validates this" is a fact about one method of
 * one version, and it is not a fact about {@link ComposioVendor}, which is the seam this function
 * actually sits on and the shape a test satisfies with a literal. Running it settles what the
 * difference costs: a `description` of 42 and an input schema of "not-a-schema" both travel through
 * here untouched into {@link ComposioAction}, whose declared types say they cannot. What they reach
 * is not a refusal. `storableTools` writes
 * `(tool.description ?? "").replaceAll(NUL, "")` and `tool.version?.replaceAll(NUL, "")`
 * (`./store`), so a description or a version that is not a string is a bare
 * "42.replaceAll is not a function" thrown from outside every vendor `try` in this file — a crash
 * wearing a refusal's clothes, which is the one outcome none of this file's sentences may become.
 * An `inputParameters` that is not an object is quieter and worse: it is stored as the app's input
 * schema and then shown to a model as Composio's own.
 *
 * SO THE THREE WIRE VALUES THIS FILE HANDS ON ARE CHECKED HERE, BESIDE THE SLUG, and `tags` is not
 * — `./composio` already refuses a `tags` that is not a list where it reads them, and a check on
 * both sides of one seam is a check nobody maintains.
 *
 * WHAT THE SCHEMA DOES NOT SETTLE IS THE FOURTH. `slug: z.string()` is satisfied by the
 * empty string, and an action's slug is not a label: it becomes `mcp_tools.name`, which is NOT NULL
 * and half that table's primary key, it is what a grant points at, and it is what a later call
 * sends back to Composio. An empty one is a row that cannot be written and a call that names
 * nothing, so it is refused here.
 *
 * A PLAIN `Error` RATHER THAN A `BrokerRefusalError`, because this listing's failures are not
 * answered to a route. `./composio` records them in an app's `lastError` for an administrator to
 * read on its Plugins page, and `listingSentence` passes an authored message through untouched.
 */
function actionOf(
  row: VendorToolRow,
  position: number,
  toolkit: string,
): ComposioAction {
  const at = `row ${position + 1} of Composio's action list for ${toolkit}`;

  /*
   * THE CONTAINER, FOR THE REASON {@link appOf}'S ROW GUARD IS BACK ONE FUNCTION UP. `ToolSchema`
   * refused a row that is not an object and nothing does now. Read without it, `("GMAIL").slug` is
   * `undefined` rather than a throw, so a listing of bare strings would be refused with "Composio
   * sent nothing where the slug of row 1 ... belongs" — an administrator sent to look for an action
   * with a missing name, about an answer that had no action in it.
   */
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(
      `Composio sent ${sent(row)} where ${at} belongs, and an action is an object carrying the name a call to it uses, so the list was not refreshed and the tools already held are untouched. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const slug = textOf(row.slug);
  if (slug === null) {
    throw new Error(
      `Composio sent ${sent(row.slug)} where the slug of ${at} belongs, and the slug is what calling the action names, so the list was not refreshed and the tools already held are untouched. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  /*
   * ABSENT IS AN ANSWER AND PRESENT-AND-WRONG IS NOT, which is the same split {@link appOf} makes
   * over a catalogue row. Composio genuinely publishes actions with no description and no version,
   * and one that publishes no parameters at all arrives with none — the SDK normalizes a `{}` to
   * absent before parsing. Each of those reaches `./composio` as the absence it is and is defaulted
   * where a column has a default. What is refused is the other thing: a field that is THERE and is
   * not what this file has told `./composio` it is.
   *
   * AND `null` IS THE WIRE'S OTHER SPELLING OF ABSENT, WHICH ALL THREE OF THESE USED TO REFUSE.
   * That directly contradicted the file this seam reports to: `./composio`'s version guard exempts
   * `null` on purpose and writes down why — "refusing it would turn a healthy refresh into a total
   * failure for every app that publishes one" — and the three reads it makes of these fields are
   * `description ?? ""`, `inputParameters ?? {}` and `version?.trim()`, every one of them already
   * null-safe. So the layer that had no trouble with a null was protected by a layer that refused
   * it, and the refusal is not a dropped field: {@link ComposioBroker}'s listing stops whole, so
   * every OTHER action on the app keeps neither its effect nor its version, and the grants pointing
   * at them are stranded until a vendor this deployment does not control stops sending a null.
   *
   * NORMALIZED HERE RATHER THAN HANDED ON, because {@link ComposioAction} spells all three
   * optional-and-typed, and a `null` travelling under that declaration is the same untrue assertion
   * these guards exist to stop. `undefined` is what an absence is on this side of the seam.
   *
   * `tags` IS STILL NOT READ HERE AT ALL, for the reason {@link VendorToolRow} gives: `./composio`
   * refuses a `tags` that is not a list of labels where it reads them — and exempts a null there on
   * exactly this argument — and a check on both sides of one seam is a check nobody maintains.
   */
  const description = row.description ?? undefined;
  if (description !== undefined && typeof description !== "string") {
    throw new Error(
      `Composio sent ${sent(description)} where the description of ${at} belongs, and that value is written into this app's tools and read back as text, so the list was not refreshed and the tools already held are untouched. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  /*
   * `input_parameters` IS THE WIRE'S KEY AND `inputParameters` WAS THE WRAPPER'S — see
   * {@link VendorToolRow}. Reading the old one off the new answer would put no schema on any
   * action, which `./composio` treats as the ordinary case of an action that publishes none: every
   * tool would reach a model with an open schema and nothing would report a fault.
   */
  const inputParameters = row.input_parameters ?? undefined;
  if (
    inputParameters !== undefined &&
    (typeof inputParameters !== "object" || Array.isArray(inputParameters))
  ) {
    throw new Error(
      `Composio sent ${sent(inputParameters)} where the input schema of ${at} belongs, and this deployment stores that value as the action's schema and shows it to a model as Composio's own. An action offered with a schema that is not one is a call nothing can get right, so the list was not refreshed and the tools already held are untouched. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  const version = row.version ?? undefined;
  if (version !== undefined && typeof version !== "string") {
    throw new Error(
      `Composio sent ${sent(version)} where the version of ${at} belongs, and the version is what a later call to this action asks Composio for, so the list was not refreshed and the tools already held are untouched. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  /*
   * Mapped field by field rather than spread, so what crosses the seam is the four things
   * `./composio` documents and not whatever else the vendor's tool object happens to carry.
   */
  return {
    slug,
    description,
    inputParameters: inputParameters as Record<string, unknown> | undefined,
    tags: row.tags,
    version,
  };
}

/**
 * WHAT THIS DEPLOYMENT WAS DOING WHEN A VENDOR CALL REFUSED, so a translated refusal can say.
 *
 * A CONDITION AND AN OUTCOME ARE TWO DIFFERENT HALVES OF A SENTENCE, and only one of them is the
 * vendor's. "This person already holds an account for gmail" is what Composio determined; "so their
 * connection to gmail was not begun" is what this deployment did about it, and a reader needs both
 * — the first to know why asking again will not help, the second to know what state they are in
 * now. The vendor cannot supply the second, because it does not know which of this file's ten calls
 * it was answering.
 *
 * WRITTEN AT THE CALL SITE AS A FINISHED CLAUSE, in the past tense, so that it reads after "so"
 * without any sentence below having to conjugate it. That is also what keeps the outcomes honest:
 * each one is composed beside the call it describes, where whether anything was sent is a fact
 * rather than a guess.
 */
type VendorCall = {
  /** What did not happen, as a clause following "so": "the app catalogue was not read". */
  outcome: string;
  /** The app the call is about, or null where the question names no app at all. */
  app: string | null;
};

/**
 * The vendor's own name for the condition it raised, or null where it raised something anonymous.
 *
 * READ OFF `name` RATHER THAN ASKED WITH `instanceof`, which is a deliberate choice and not a
 * shortcut. Every error class in `@composio/core` 0.18.1 ends its constructor by assigning its own
 * `name` (`src/errors/*.ts`), so the name is the vendor's published discriminator and is stable
 * across the package boundary; `instanceof` is not, because it is identity on a constructor and
 * therefore hostage to a second copy of the package anywhere in the tree. The SDK makes the same
 * judgement about its own classes — `isRequestAbortError` falls back to `constructor.name` and
 * `name` and says why: "dual-package-hazard cases" (`src/errors/SDKErrors.ts`). `./composio`'s
 * `isSchemaMismatch` reaches for a shape rather than a class for the same reason.
 *
 * AND IT IS WHAT LETS THE TABLE BE A TABLE. Naming eight classes as values would mean importing
 * eight symbols from the vendor into the one file whose whole argument is that the vendor's surface
 * is confined — and a version that renames one would then be a compile error in a switch that is
 * meant to degrade to "not a condition this file knows" rather than to fail the build.
 */
function conditionOf(error: unknown): string | null {
  /*
   * AND THE NAME THAT COMES BACK IS THE ONE THAT WAS JUDGED, which it was not. This decided
   * emptiness on the TRIMMED value and answered the PADDED one — {@link textOf}'s own defect, on
   * the value that decides which of eight authored remedies a reader gets. The switch below
   * compares against literals, so a name the package or a proxy padded matched none of them and
   * every condition this file translates fell through to "Composio said nothing about why", which
   * sends an operator to check a key that is fine.
   */
  return textOf((error as { name?: unknown } | null | undefined)?.name);
}

/**
 * A VENDOR CONDITION AS A SENTENCE THIS DEPLOYMENT WROTE, or null where there is none to write.
 *
 * THE DEFECT THIS CLOSES IS THAT ALMOST NOTHING WAS TRANSLATED. `routes.ts` answers a thrown broker
 * error by reaching for the vendor's own sentence and, finding none, telling the reader that
 * Composio said nothing about why and that an administrator should check this deployment's Composio
 * key. That is exactly right about a socket that hung up. It is wrong twice over about a condition
 * `@composio/core` raised by name: the key is fine — the call that failed usually went out through
 * a listing that had just succeeded on the same key — and several of these states are settled at
 * the vendor, so the "and try again" half of the advice is an instruction to repeat something that
 * will answer identically for ever. The worst of them is the first row below: a person who already
 * has an account for an app was told to check an API key and retry.
 *
 * ONE SENTENCE PER CONDITION AND NO SENTENCE SHARED, which is the property its test asserts in both
 * directions. A translation that gave two conditions one wording would be worse than leaving both
 * alone: the reader would be handed a remedy that is right for somebody else's failure and would
 * have no way to tell, where an untranslated failure at least says plainly that nothing is known.
 *
 * NULL WHERE COMPOSIO'S OWN SERVER EXPLAINED ITSELF, WHICH IS THE LIMIT ON DOING THIS AT ALL.
 * `routes.ts` reads `brokerSentence` first and `vendorSentence` second, so a refusal authored here
 * HIDES the vendor's message rather than joining it. Several of the SDK's classes are wrappers
 * around whatever the API returned — `ComposioFailedToCreateConnectedAccountLink` keeps the
 * `BadRequestError` as its `cause` (`src/models/ConnectedAccounts.ts`), and `vendorSentence` reaches
 * through exactly that nesting — so translating one of those unconditionally would replace a
 * specific server sentence with this deployment's general one. Where the vendor said something a
 * reader can use, the error goes on untouched and the vendor gets the last word.
 *
 * THE ORIGINAL IS KEPT AS `cause` on every refusal, for whoever is reading a log rather than a page.
 * It is never quoted into the message: the file's promise about {@link BrokerRefusalError} is that
 * its sentence is safe to show anybody who could have made the request, and a vendor error object
 * out of `connectedAccounts.link` carries the request that was being minted.
 *
 * WHAT IS DELIBERATELY NOT HERE, because the route's default answer is the correct one for it:
 * `ComposioToolkitFetchError`, which `Toolkits.getToolkits` wraps around EVERY catalogue failure
 * including its own validation one, and whose message is the bare "Failed to fetch toolkits" — the
 * key and the status page genuinely are the remedy; and `ComposioToolExecutionError`, the same
 * wrapper one call further on, whose `cause` carries the server's own words for `vendorSentence` to
 * find and whose own message `./composio`'s {@link VENDOR_PLACEHOLDER} already refuses to pass on.
 */
function vendorRefusal(
  error: unknown,
  call: VendorCall,
): BrokerRefusalError | null {
  if (vendorSentence(error) !== null) return null;

  const app = call.app ?? "the app";
  const outcome = call.outcome;
  const refusal = (message: string): BrokerRefusalError =>
    new BrokerRefusalError(message, { cause: error });

  switch (conditionOf(error)) {
    /*
     * THE ONE THAT WAS DOING THE MOST DAMAGE. `connectedAccounts.link` lists this person's active
     * accounts for the config before it mints anything and refuses where it finds one
     * (`@composio/core` 0.18.1, `src/models/ConnectedAccounts.ts`), which is this deployment's own
     * rule met one layer down — one person holds one account per app, because the call that runs an
     * action names the person and not the account. So it is a settled fact rather than a moment,
     * and "check the key and try again" is advice that cannot ever come true.
     */
    case "ComposioMultipleConnectedAccountsError":
      return refusal(
        `Composio answered that this person already holds a connected account for ${app}, so ${outcome}. That is a settled state at Composio rather than a moment that passes — asking again meets the same answer — and what clears it is disconnecting the account they already hold, on this deployment's Connected accounts page, before another is attached.`,
      );

    /*
     * ACCESS RULES ARE NOT SOMETHING THIS FILE SENDS, which is the whole of why this one is worth a
     * sentence. The SDK raises it when the server rejects ACL fields on an account that is not
     * shared, and nothing here asks for sharing — so the reader must not go looking through this
     * deployment's settings for a field it does not have. The config in Composio's dashboard is
     * where the sharing is decided and where an operator can change it.
     */
    case "ComposioAclOnlyForSharedError":
      return refusal(
        `Composio refused account-sharing rules on an account that is not a shared one, so ${outcome}. This deployment attaches every account to one person and asks for no sharing, so the rules are on the authorization config rather than on anything sent from here: an operator changing how ${app} is shared in Composio's own dashboard is what clears it.`,
      );

    /*
     * REACHED ONLY WHERE THE SERVER SAID NOTHING, by the guard at the top of this function. What is
     * left when it is reached is still worth far more than the route's default, because of what has
     * already happened by the time this call is made: the auth configs were listed through the same
     * key moments earlier and one of them was found enabled. So the two things the default sends an
     * operator to check are both already proven, and the two things a person needs to know — that
     * they were not sent anywhere, and that their consent is unspent — are facts about this
     * particular call that no general sentence carries.
     */
    case "ComposioFailedToCreateConnectedAccountLink":
      return refusal(
        `Composio would not mint a connect link for ${app} and said nothing about why, so ${outcome}. Nobody was sent to a consent screen and no consent was spent. This deployment's key and its authorization config for the app were both read through successfully moments earlier, so neither of those is what to check; Composio's status page is.`,
      );

    /*
     * THE SDK'S OWN SCHEMA REFUSING, ON EITHER SIDE OF THE WIRE. `ValidationError` is raised by
     * nearly every model here — the auth-config create, the connected-account listing and link, the
     * tool listing and the execute all `safeParse` what they are handed and what comes back — and in
     * both directions it means the same thing: this deployment's copy of `@composio/core` and
     * Composio's API no longer agree. It is the one condition below whose remedy is a package
     * rather than a page, which is why it shares its wording with the shape refusals above.
     */
    case "ValidationError":
      return refusal(
        `This deployment's @composio/core refused the request or Composio's answer against its own schema, so ${outcome} — either before Composio was asked or after it had replied. Nothing an operator can set corrects that and the key is not what to check: upgrading this deployment's @composio/core is what fixes it.`,
      );

    /*
     * NOTHING IS WRONG AT COMPOSIO, WHICH IS THE ENTIRE MESSAGE. A cancelled request is a caller's
     * own abort, so sending somebody to a key or a status page is sending them to look at two things
     * that are working. The one honest thing to add is the ambiguity: a call cancelled in flight may
     * or may not have been acted on at the vendor, and this deployment cannot tell which.
     */
    case "ComposioRequestCancelledError":
      return refusal(
        `The request was cancelled before Composio answered, so ${outcome} as far as this deployment can tell — and how far it had got when the cancellation landed is exactly what it cannot tell. Nothing is wrong at Composio and nothing needs setting here; asking for it again is what settles which of the two it was.`,
      );

    /*
     * THE ACCOUNT IS GONE AT THE VENDOR, WHICH THIS DEPLOYMENT'S ROWS DO NOT KNOW. `tools.execute`
     * maps API error code 1803 onto this class (`src/errors/ToolErrors.ts`), and what it reports is
     * a person whose `composio_connections` row still stands over an account Composio no longer
     * holds — a grant withdrawn at Google, or an account removed in the dashboard. Retrying reaches
     * neither; connecting again is what puts an account back under the row.
     */
    case "ComposioConnectedAccountNotFoundError":
      return refusal(
        `Composio holds no connected account for this person and ${app}, so ${outcome}. A grant withdrawn at the provider and an account removed in Composio's own dashboard both read exactly like this, and a retry reaches neither: connecting ${app} again on this deployment's Connected accounts page is what restores it.`,
      );

    /*
     * THE ACTION COULD NOT BE FETCHED, WHICH IS NOT THE SAME CLAIM AS THE ONE THIS USED TO MAKE.
     *
     * The sentence here read "Composio no longer publishes that action", on the strength of the
     * class's name. The name does not carry that: `getRawComposioToolBySlug` wraps its whole
     * retrieve in a try whose catch rethrows EVERYTHING except a cancellation as this class —
     * `throw new ComposioToolNotFoundError(\`Unable to retrieve tool with slug ${"${slug}"}\`, { cause: error })`
     * (`@composio/core` 0.18.1, `src/models/Tools.ts:709-721`) — and `tools.execute` resolves
     * through that same method (`:1163`). So a 500, a 429, a refused key, a socket that hung up and
     * an action genuinely withdrawn all arrive under one name, and nothing on the error tells them
     * apart. An outage was being reported to an administrator as a catalogue change, with an
     * instruction to press Refresh at a vendor that was not answering.
     *
     * WHAT CAN HONESTLY BE SAID IS THAT IT COULD NOT BE FETCHED, AND WHICH TWO READINGS THAT HAS.
     * The refresh stays in the sentence because a withdrawn action is the commonest of them and
     * the refresh is the only act that settles it — but it is named as the remedy for ONE of the
     * readings rather than as the remedy, and the reader is given the fact that separates them:
     * whether every other action of every other app is failing too. That is a thing they can look
     * at, which "no longer publishes" was not.
     *
     * THE VENDOR'S OWN WORDS STILL WIN WHERE THERE ARE ANY. Where the failure underneath was an API
     * error carrying a server sentence, the guard at the top of this function has already returned
     * null and none of this is reached — so what this row answers is the half of the class that
     * explained itself least.
     */
    case "ComposioToolNotFoundError":
      return refusal(
        `Composio would not hand that action over at the version this deployment recorded for it, so ${outcome}. This deployment's @composio/core reports an action Composio has withdrawn and a request for one that failed — a timeout, a dropped connection, a 500, a refused key — under one condition and says nothing that tells the two apart, so neither can this deployment. Refreshing ${app}'s tools on its Plugins page records what Composio publishes now, which settles it where the action is gone; where every action of every app is failing the same way, it is the request rather than the action, and Composio's status page is where that shows.`,
      );

    /*
     * A RECORDED VERSION OF "latest" IS A ROW THAT NEEDS REWRITING, not a call that needs repeating.
     * The SDK refuses `latest` for a tool executed one at a time (`src/models/Tools.ts`), and the
     * version travelling with a call is whatever the listing wrote down for the action, so the fix
     * is on the row rather than at Composio.
     */
    case "ComposioToolVersionRequiredError":
      return refusal(
        `Composio refuses a call whose toolkit version is "latest", and that is the version travelling with this one, so ${outcome}. A dated version is recorded when an app's actions are listed, so refreshing ${app}'s tools on its Plugins page replaces "latest" with a version Composio will accept.`,
      );

    /*
     * AN ANSWER THE VENDOR'S OWN PACKAGE COULD NOT READ, WHICH IS THE ROW THE FILE HAD BACKWARDS.
     *
     * This used to be classified as a bug of this deployment's — see the note now on
     * {@link askForEach} — on the premise that a `TypeError` is what a program's own mistake looks
     * like and never something Composio can reply. Running `@composio/core` 0.18.1 falsifies that
     * outright. Its list transformers dereference the answer before returning it, so a malformed
     * reply dies inside the vendor's code and arrives here as a bare `TypeError`:
     * `response.items.map(transformAuthConfigRetrieveResponse)` off a bare list or an `items` that
     * is a string (`src/utils/transformers/authConfigs.ts:79`), `authConfig.toolkit.logo` off a row
     * that is not an object (`:41`), and the same two shapes at
     * `src/utils/transformers/connectedAccounts.ts:113` and `:60` and at `src/models/Tools.ts:561`.
     * Five vendor answers, five `TypeError`s, none of them this deployment's doing.
     *
     * IT IS TRANSLATED HERE BECAUSE HERE IS WHERE IT SURFACES. {@link askVendor} wraps the
     * `await vendor.*` and nothing else, so a throw reaching this function came out of the vendor's
     * code by construction rather than by inspection — which is exactly the distinction the guards
     * this replaces were trying to make one layer too late, in readers the SDK never let them reach.
     *
     * WHAT THE READER IS TOLD IS DELIBERATELY NOT A THING TO TRY. Nobody holding an admin page can
     * correct the shape of a reply, and "try again" would be advice to repeat a request that will
     * be answered identically; the one act that changes anything is a package upgrade, and the two
     * things the route's default sends an operator to check are both already proven fine — the
     * request went out and Composio replied to it. The crash itself is carried as `cause` and never
     * quoted: a sentence that reads like a stack trace is what every refusal here exists not to be.
     */
    case "TypeError": {
      const about = call.app === null ? "" : ` for ${call.app}`;
      return refusal(
        `Composio's answer${about} was a shape this deployment's @composio/core could not read, so ${outcome}. The failure was raised inside the vendor's own package as it read the reply, so the request went out and Composio answered it: neither the key nor anything on this deployment's pages is what to check. ${VENDOR_SHAPE_REMEDY}`,
      );
    }

    default:
      return null;
  }
}

/**
 * One vendor call, with whatever it refuses with translated on the way out.
 *
 * WRAPPED AROUND THE `await vendor.*` AND NOTHING ELSE, which is the discipline that makes this
 * safe to apply everywhere. Everything else inside these methods is this file's own reading and
 * refusing, and those already carry authored sentences; passing one back through
 * {@link vendorRefusal} could only find a name it does not know, but the narrower scope is what
 * makes that true by construction rather than by inspection.
 *
 * A CALL WITH NO ENTRY HERE IS THE FAILURE MODE THE TABLE IN THE TESTS EXISTS FOR. TypeScript has
 * no checked exceptions, so nothing enumerates the calls that translate and nothing notices a new
 * one that does not; the seam's own test walks every method of both projections and fails the
 * method that forgot.
 */
async function askVendor<T>(
  call: VendorCall,
  ask: () => Promise<T>,
): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    const refusal = vendorRefusal(error, call);
    if (refusal !== null) throw refusal;
    throw error;
  }
}

/**
 * Every reason a set-wide refusal collected, in one value a `cause` can hold.
 *
 * ALL OF THEM, WHICH IS THE CORRECTION. The two loops below used to throw with `cause: refused[0]`,
 * so a person with five accounts of which three refused left one reason attached and two discarded
 * — and the sentence those throws carry is a COUNT, deliberately, because a count is the thing a
 * reader can act on. The reasons were therefore the only place the detail existed at all, and two
 * thirds of it was being dropped on the floor.
 *
 * CARRIED RATHER THAN LOGGED, and that is this file's rule rather than a preference. A vendor error
 * out of `connectedAccounts.link` or an account delete carries the request it was made for, and a
 * console line is a line in an aggregator; nothing in this module logs a vendor object, for the same
 * reason nothing in it logs the key. A `cause` travels to whoever is already holding the failure.
 *
 * ONE REFUSAL STAYS ITSELF. Wrapping a single error in an `AggregateError` would make every reader
 * unwrap a list to find one thing, and `store.ts` already reads `error.cause` directly.
 */
function everyRefusal(refused: unknown[]): unknown {
  if (refused.length === 1) return refused[0];
  return new AggregateError(
    refused,
    `Composio refused ${refused.length} of the requests this call made.`,
  );
}

/**
 * What this adapter needs of `@composio/core`'s client, written as a shape rather than as a class.
 *
 * A TEST SATISFIES IT WITH AN OBJECT LITERAL, which is the entire argument for it and the reason
 * {@link buildComposioClient} takes one of these instead of an API key. The vendor's own client
 * cannot be constructed without a key and answers nothing without a network, so an adapter that
 * built its own client would be an adapter no test could reach — and this is the file where the
 * field names, the argument order and the refusal below would go wrong unnoticed.
 *
 * Every member is written with METHOD syntax deliberately. Method parameters are compared
 * bivariantly, so a real `Composio` — whose signatures carry optional request-options arguments
 * and wider parameter types than the calls here use — satisfies this without a cast.
 *
 * THE TWO DELETES ARE NOT `Composio`'s, AND THAT IS THE ONE PLACE THIS SHAPE DIVERGES FROM IT. Both
 * of the vendor's own wrappers hard-code the request body they send — `this.client.authConfigs
 * .delete(nanoid, undefined, requestOptions)` and the same line for connected accounts
 * (`@composio/core` 0.18.1, `src/models/AuthConfigs.ts:303-311` and
 * `src/models/ConnectedAccounts.ts:532-540`) — so through them the `revoke_on_delete` parameter
 * cannot be passed at all, and both calls soft-delete while the grant at Google or Slack stands. So
 * the shape below asks for the underlying client's signature instead, and
 * {@link createComposioClient} satisfies it from `composio.getClient()`. See
 * {@link ComposioBroker.revoke} for what that flag is and what its absence made this deployment
 * claim.
 */
export type ComposioVendor = {
  tools: {
    /**
     * Every action of one app, one page at a time, THROUGH THE RAW CLIENT RATHER THAN THE WRAPPER.
     *
     * `getRawComposioTools` was here and could not be paged. `ToolListParamsSchema` names no cursor
     * field at all (`@composio/core` 0.18.1, `src/types/tool.types.ts:257-266`) and the method ends
     * `tools.items.map(...)` (`src/models/Tools.ts:561`), dropping the response's `next_cursor`
     * before any caller sees it — so through the wrapper a page at {@link LISTING_LIMIT} and a
     * listing longer than one were the same array, and `./composio` refused rather than commit a
     * fragment as the whole truth about an app. The raw client is the difference: `ToolListParams`
     * carries `cursor`, "a base64 encoded string of the page and limit", and `ToolListResponse`
     * carries `next_cursor` (`@composio/client` 0.1.0-alpha.76, `resources/tools.d.ts:421-432` and
     * `:200-204`). The request IS expressible, and {@link everyRowOf} makes it.
     *
     * WHAT THE WRAPPER WAS DOING THAT THIS HAS TO KEEP DOING IS TWO PARAMETERS AND ONE NO-OP.
     * `toolkit_versions` is the SDK's own `toolkitVersions` config, which defaults to "latest"
     * (`src/utils/config-defaults/ConfigDefaults.node.ts`) and was forwarded on every listing it
     * made (`src/models/Tools.ts:548`); it decides which `version` each action comes back with,
     * which is the value a later call sends back to Composio, so it is passed here as the literal
     * the default is. `important` is the one this file already knew about and is now simply not
     * named: the wrapper set it to "true" whenever a toolkit query carried no limit (`:505-515`),
     * which NARROWS the answer to a featured subset that nothing in the answer declares. And the
     * no-op is `applyDefaultSchemaModifiers`, which returns its argument untouched unless
     * `dangerouslyAllowAutoUploadDownloadFiles` is on (`:242-248`); it defaults off
     * (`ConfigDefaults.node.ts`) and {@link createComposioClient} does not turn it on — which is
     * the premise `./composio`'s file-upload guard is written on.
     *
     * AND `ToolSchema.parse` IS GONE WITH IT, WHICH IS A GAIN AND A COST, BOTH WRITTEN DOWN
     * ELSEWHERE. The gain is that the parse STRIPPED every schema key its `ParametersSchema` did
     * not name before any caller could see it — see {@link ComposioAction.inputParameters}, where
     * that loss was recorded as unavoidable and where the fix was named as this exact call. The
     * cost is that nothing validates the row: {@link actionOf} carries every check now, including
     * the container, and {@link pageOf} carries the envelope.
     */
    list(query: {
      toolkit_slug: string;
      limit: number;
      toolkit_versions: "latest";
      /** Where the last page left off, ABSENT on the first request rather than undefined. */
      cursor?: string;
    }): Promise<{
      /**
       * `unknown` BECAUSE NOTHING HAS LOOKED AT IT, which is the difference between this listing
       * and the two the SDK still serves. Their transformers open `response.items.map(...)`, so a
       * malformed envelope dies inside the vendor's package; a generated client parses the body and
       * returns it. {@link pageOf} is where that is answered.
       */
      items?: unknown;
      /** The vendor's own word for "there is another page", read by {@link everyRowOf}. */
      next_cursor?: unknown;
    } | null>;
    getRawComposioToolBySlug(
      slug: string,
      options?: { version?: string },
    ): Promise<VendorTool>;
    execute(
      slug: string,
      body: {
        arguments: Record<string, unknown>;
        userId: string;
        version: string;
        /**
         * WHICH ACCOUNT OF THE PERSON'S TO RUN IN, absent where any of theirs will do.
         *
         * `ToolExecuteParams` carries it and `Tools.execute` forwards it to the client
         * (`@composio/core` 0.18.1), so this is the wire's own field rather than one this
         * deployment composes. Why a verification cannot go without it is written at
         * {@link ComposioActions.execute}: a person and an app do not name an account, and one
         * person may hold several for one app.
         */
        connectedAccountId?: string;
      },
    ): Promise<ComposioResult>;
  };
  toolkits: {
    /**
     * The app catalogue, one page at a time, THROUGH THE RAW CLIENT FOR THE SAME REASON.
     *
     * AND THIS IS THE ONE THAT WAS BROKEN IN FRONT OF PEOPLE. `Toolkits.getToolkits` does forward a
     * `cursor` (`@composio/core` 0.18.1, `src/models/Toolkits.ts:68`) — so the wrapper could ASK
     * for a second page — but `transformToolkitListResponse` returns `response.items.map(...)`, a
     * bare array (`src/utils/transformers/toolkits.ts:16-43`), so there is no cursor to put in it.
     * One half of a pager is not a pager, and `fetchDirectory` refused a full page because it could
     * not tell a complete catalogue from a truncated one. Composio publishes more than
     * {@link LISTING_LIMIT} toolkits, so that refusal fired on the FIRST call, every time, and an
     * operator opening the app picker saw no apps at all. `ToolkitListResponse` carries
     * `next_cursor` and `ToolkitListParams` carries `cursor` (`@composio/client` 0.1.0-alpha.76,
     * `resources/toolkits.d.ts:322-326`, `:467-478`), so the whole request was expressible the
     * entire time.
     *
     * `sort_by` IS THE WIRE'S SPELLING OF WHAT WAS `sortBy`, and it still matters even though the
     * listing is no longer finite. What it buys now is order rather than coverage: the rows reach a
     * picker in the order Composio thinks people want them, and the page ceiling in
     * {@link PAGE_CEILING} is the one case left where being cut off is possible at all.
     *
     * NO SEARCH TERM, WHICH IS THE SAME DECISION FOR A DIFFERENT REASON THAN BEFORE. It used to be
     * that the SDK's params named no search field and the parse stripped what it did not name, so a
     * term passed here would vanish before the request. `ToolkitListParams` DOES name `search`
     * (`:480-484`), so that is no longer the argument. The argument is that the catalogue is held
     * for ten minutes and searched in this process by both of its callers — the picker and the
     * enable route's slug check — and a per-term request would be a per-term cache. Searching over
     * the held rows is this deployment's own job and stays so.
     */
    list(query: {
      limit: number;
      sort_by: "usage";
      /** Where the last page left off, ABSENT on the first request rather than undefined. */
      cursor?: string;
    }): Promise<{
      /** `unknown` for the reason the action listing's is — see {@link pageOf}. */
      items?: unknown;
      /** The vendor's own word for "there is another page", read by {@link everyRowOf}. */
      next_cursor?: unknown;
    } | null>;
    /**
     * ONE app, read for the one thing the catalogue listing does not carry: what it asks a person.
     *
     * The listing above answers which apps exist and which scheme each of them authenticates with;
     * it does not answer which boxes a form for that scheme needs. That is published per app and it
     * moves — one app wants a key, the next wants a key and a workspace subdomain — so it is asked
     * for at the moment a person presses Connect rather than derived from anything held here. See
     * {@link ComposioBroker.connectionFields}.
     *
     * NO PAGE AND NO CURSOR, because a toolkit is one object rather than a listing: this is the one
     * vendor read in this file where there is no second page to be mistaken for the whole answer.
     */
    retrieve(slug: string): Promise<VendorToolkitDetail>;
  };
  authConfigs: {
    list(query: {
      toolkit: string;
      limit: number;
      /**
       * Ask for the disabled ones too, ALWAYS, which is why this is the literal and not a boolean.
       *
       * The vendor's listing returns enabled configs unless asked otherwise
       * (`AuthConfigListParamsSchema.showDisabled`, `@composio/core` 0.18.1,
       * `src/types/authConfigs.types.ts:124-131`), and a config this listing cannot see is a config
       * {@link ComposioBroker.ensureAuthConfig} creates a second of — which is the exact split that
       * method exists to prevent, arriving through the one door it was not watching. Every question
       * this file asks of the listing is better served by seeing a disabled config and saying so:
       * creation must not duplicate it, deletion must remove it, and consent must refuse against
       * it rather than mint a link that cannot work.
       */
      showDisabled: true;
      /**
       * Where the last page left off, ABSENT on the first request rather than undefined.
       *
       * `AuthConfigListParamsSchema` names it and `AuthConfigs.list` forwards it
       * (`@composio/core` 0.18.1, `src/types/authConfigs.types.ts:124-131`,
       * `src/models/AuthConfigs.ts:95`), which is the fact that decides how a truncated answer is
       * handled here: the catalogue refuses a full page because it has no way to ask for the next
       * one, and this listing does. See {@link everyRowOf}.
       */
      cursor?: string;
    }): Promise<{
      items: VendorAuthConfig[];
      /**
       * The vendor's own word for "there is another page", which was being discarded at this type.
       *
       * `unknown` RATHER THAN `string | null`, because the transformer writes `response.next_cursor
       * ?? null` (`src/utils/transformers/authConfigs.ts:80`) and that is the wire's value with no
       * check on it — a numeric cursor reaches {@link everyRowOf} exactly as Composio sent it, which
       * is the one shape that could be read as the end of a listing that has not ended.
       *
       * `AuthConfigListResponseSchema` carries it (`@composio/core` 0.18.1,
       * `src/types/authConfigs.types.ts:129-133`) and
       * `transformAuthConfigListResponse` fills it in from `next_cursor` on every answer
       * (`src/utils/transformers/authConfigs.ts:72-80`). Omitting it here did not make the
       * truncation go away; it made it unobservable, because a field a projection does not name is
       * a field no caller and no test of a caller can ask about. {@link everyRowOf} reads it, and
       * follows it until the vendor stops offering one — so a listing at {@link LISTING_LIMIT} is
       * no longer a fragment this file can mistake for the whole answer.
       */
      nextCursor?: unknown;
    }>;
    /**
     * Create one auth config, and hand back the id Composio gave it.
     *
     * `Promise<unknown>` UNTIL NOW, AND THE ANSWER WAS NEVER LOOKED AT. That was read as harmless
     * because nothing here needs the id — the next listing finds the config by its name. It is not:
     * `transformCreateAuthConfigResponse` builds what this resolves to by dereferencing
     * `response.auth_config.id` and `response.toolkit.slug` (`@composio/core` 0.18.1,
     * `src/utils/transformers/authConfigs.ts:96-106`), so a drift in the answer's SHAPE raises a
     * `TypeError` inside the vendor's package — after the create has gone out and been answered.
     * {@link ComposioBroker.ensureAuthConfig} then reported that no config had been created, over a
     * config standing at Composio that nothing in this deployment names. Reading the reply is what
     * makes the difference between "nothing was created" and "something may have been" a fact
     * rather than an assumption.
     *
     * `id?: unknown` FOR THE REASON EVERY OTHER FIELD IN THIS PROJECTION IS ONE: the `transform()`
     * around it is the warn-only kind (`src/utils/transform.ts:26-36`), so
     * `CreateAuthConfigResponseSchema` spelling the id a required string is the answer Composio
     * MEANS to send rather than a fact about the one that arrived.
     *
     * NULLABLE THOUGH THE VENDOR'S OWN DECLARATION IS NOT, exactly as the account delete below is:
     * the generated client parses the body and returns it, and reading a field off a `null` would
     * be a crash carrying a sentence that reads like a stack trace.
     */
    create(
      toolkit: string,
      /**
       * THE UNION, BECAUSE THE MANAGED TYPE IS RIGHT FOR ONE KIND OF APP AND WAS SENT FOR ALL OF
       * THEM. A self-registering app has no Composio-owned OAuth client behind it and a key app
       * has no consent screen to send anybody to, so both are created as custom configs — carrying
       * the scheme, and never a credential, which is per-connection rather than per-config. The
       * managed shape has no field to name a scheme with, which is why this is a union of two
       * shapes rather than one shape with an optional field.
       */
      options:
        | { type: "use_composio_managed_auth"; name: string }
        | {
            type: "use_custom_auth";
            authScheme: FieldScheme | "DCR_OAUTH";
            name: string;
            /**
             * EMPTY, AND PRESENT, WHICH IS NOT THE CONTRADICTION IT LOOKS LIKE.
             *
             * Neither config this deployment creates carries a secret — a self-registering app
             * needs none and a key app's key belongs to each connection made against the config
             * rather than to the config — but `CreateCustomAuthConfigParamsSchema` spells
             * `credentials` REQUIRED (`@composio/core` 0.18.1,
             * `src/types/authConfigs.types.ts:52-65`) and `AuthConfigs.create` `safeParse`s its
             * options before it builds a body (`src/models/AuthConfigs.ts:132-137`). So an absent
             * field is not "no credentials sent"; it is a `ValidationError` raised inside the
             * vendor's package with no request made at all. The empty record is what carries
             * nothing THROUGH that check, and the type says so rather than leaving the next reader
             * to discover it from a failed enable.
             */
            credentials: Record<string, never>;
          },
    ): Promise<{ id?: unknown } | null>;
    /**
     * Delete one auth config, and ask for the upstream credentials on it to be revoked too.
     *
     * THE SAME TRAP AS THE ACCOUNT DELETE BELOW, one level up. The endpoint "soft-deletes an
     * authentication configuration" and revokes "the upstream credentials of every connection using
     * this auth config" only when the flag is passed (`@composio/client` 0.1.0-alpha.76,
     * `resources/auth-configs.d.ts:60-72` and `:651-659`), so a delete without it leaves every
     * grant that was ever made against this config alive at the provider.
     *
     * WHICH IS WHY IT IS PASSED HERE EVEN THOUGH THE ACCOUNTS WERE ALREADY ASKED FOR INDIVIDUALLY.
     * Removing an app revokes each connected person first and drops the config last, and that loop
     * reaches exactly the people this deployment has a `composio_connections` row for. An account
     * whose row drifted — cleared by a confirm that Composio answered `false` to, or lost with a
     * database this deployment restored — is invisible to it and still live at the vendor. This is
     * the one call that reaches those, and there is nothing on this config that removing the app is
     * not meant to end.
     *
     * AND ITS REPLY CARRIES NO VERDICT, WHICH IS WHY THIS ONE IS NOT READ WHERE THE ACCOUNT DELETE
     * BELOW IS. That is the obvious question to ask of a call whose answer is awaited and dropped —
     * {@link ComposioBroker.revokeAccount} exists to argue that not throwing is not the same as
     * having been done, and the same gap one level up would have `removeServer` deleting the app's
     * row behind a config that is still standing. It was asked and the answer is in the vendor's own
     * type: `AuthConfigDeleteResponse` has exactly one field, an OPTIONAL `revoke_job_id`, and no
     * `success` (`@composio/client` 0.1.0-alpha.76, `resources/auth-configs.d.ts:377-385`). The
     * account delete's `ConnectedAccountDeleteResponse` does carry `success: boolean` (`:7447-7451`),
     * which is what {@link withdrawalDeclined} reads. There is nothing here to read, so `unknown`
     * is the honest declaration rather than a field this deployment would be inventing.
     *
     * WHAT THE REPLY DOES SAY IS THAT THE REVOCATION IS A BACKGROUND JOB. `revoke_job_id` is
     * "present only when `revoke_on_delete=true`", and the vendor's own comment on it says to track
     * the job and its per-connection results in the Composio dashboard because "a programmatic
     * endpoint to poll this job is not yet generally available". So a clean return here means the
     * config was deleted and the upstream revocations were STARTED — not that they finished. That
     * limit belongs to Composio rather than to this deployment, and it is why `removeServer`'s
     * promise is the one it makes: every account is asked to be withdrawn before anything here is
     * deleted, which is as far as the vendor lets anybody go.
     */
    delete(id: string, params: { revoke_on_delete: true }): Promise<unknown>;
  };
  connectedAccounts: {
    list(query: {
      userIds: string[];
      toolkitSlugs: string[];
      /**
       * Which statuses this particular question is about — see {@link CONNECTED} and
       * {@link REVOCABLE}, which are the only two answers this file gives.
       */
      statuses: VendorAccountStatus[];
      /**
       * Both sharing models, ALWAYS, which is why this is the literal and not the enum.
       *
       * OMITTING IT IS NOT "NO OPINION", in exactly the way an omitted limit is not. The parameter
       * defaults to private accounts only (`ConnectedAccountListParamsSchema.accountType`,
       * `@composio/core` 0.18.1, `src/types/connectedAccounts.types.ts:286-293`), so a person whose
       * account for an app is a SHARED one reads as not connected, is told to connect an app they
       * already have, and — far worse — is invisible to the revoke, which then reports that there
       * was nothing to withdraw while their grant stands. Neither of the two questions this file
       * asks has any reason to care how an account is shared: the gate is about whether this person
       * can act through the app, and the revoke is about ending every account they can act through.
       */
      accountType: "ALL";
      /**
       * Which authorization configs the question is about, ABSENT where it is about all of them.
       *
       * THE TWO QUESTIONS DIFFER HERE TOO, AND ONLY ONE OF THEM MAY ACT. `authConfigIds` is a
       * parameter of the listing (`ConnectedAccountListParamsSchema.authConfigIds`,
       * `@composio/core` 0.18.1, `src/types/connectedAccounts.types.ts:260-264`) forwarded as
       * `auth_config_ids` (`src/models/ConnectedAccounts.ts:117`), and omitting it asks about every
       * config in the project — this deployment's and an operator's hand-made ones alike. That is
       * the right question for {@link ComposioBroker.isConnected}, which only reads whether a person
       * can act through the app, and the wrong one for {@link ComposioBroker.revoke}, which deletes
       * what it finds: see there for why an account on somebody else's config is not this
       * deployment's to end.
       *
       * NEVER THE EMPTY ARRAY. A caller with no configs of its own has nothing to scope TO, and an
       * empty filter is the shape most likely to be read as no filter at all by whatever is on the
       * far side — which would be the unscoped listing arriving through the parameter added to
       * prevent it. `revoke` answers before it asks in that case.
       */
      authConfigIds?: string[];
      limit: number;
      /**
       * Where the last page left off, ABSENT on the first request rather than undefined.
       *
       * `ConnectedAccountListParamsSchema` names it and `ConnectedAccounts.list` forwards it
       * (`@composio/core` 0.18.1, `src/types/connectedAccounts.types.ts:259-266`,
       * `src/models/ConnectedAccounts.ts:118`). This is the listing the paging matters most for:
       * {@link ComposioBroker.revoke} answers `true` for "this person's access has ended", and one
       * page of their accounts is not the set of their accounts. See {@link everyRowOf}.
       */
      cursor?: string;
    }): Promise<{
      /**
       * The id is the only field read off an account, and it is read off the wire unchecked.
       *
       * `transformConnectedAccountResponse` spreads the raw item and overrides the fields it
       * renames (`@composio/core` 0.18.1, `src/utils/transformers/connectedAccounts.ts:52-66`), so
       * `id` arrives exactly as Composio sent it inside the same warn-only `transform()` as
       * everything else here. An account with no id is the one shape the revoke below cannot act
       * on, and {@link withdrawableAccounts} is what says so about it.
       *
       * THE ROW ITSELF IS AN OBJECT BY CONSTRUCTION, which is why only the field is in doubt. The
       * same function reads `response.auth_config.id` (`:60`) on its way to building each row, so a
       * row that is not an object raises inside the vendor's code and never reaches this listing.
       */
      items: { id?: unknown }[];
      /**
       * The same truncation signal as the auth-config listing above, from the same vendor schema.
       *
       * `ConnectedAccountListResponseSchema` spells it `nullish`
       * (`src/types/connectedAccounts.types.ts:297-303`) and the transformer sets it on every
       * answer (`src/utils/transformers/connectedAccounts.ts:109-117`). It matters more here than
       * anywhere else in this file: {@link ComposioBroker.revoke} answers `true` for "this
       * person's access has ended", and it used to have seen only one page of the accounts it
       * would have to end. {@link everyRowOf} follows it until there is none left.
       */
      nextCursor?: unknown;
    }>;
    /**
     * Mint one person's connect link against one auth config, with the page to come back to.
     *
     * `link` RATHER THAN `initiate`, AND RATHER THAN `toolkits.authorize`. All three end at a
     * redirect url, and only the choice between them decides whether this deployment keeps working.
     * `toolkits.authorize` takes a user id, a toolkit and an optional auth config id and has no
     * parameter for a callback at all (`@composio/core` 0.18.1, `src/models/Toolkits.ts:333-338`),
     * which is why consent used to end on Composio's hosted page — the address below has nowhere
     * to travel on that call. `initiate` does carry one (`:249`), but the endpoint under it is
     * retired for Composio-managed OAuth on redirectable schemes — cutover 2026-05-08 for new
     * organizations and 2026-07-03 for the rest, after which it throws
     * `ComposioLegacyConnectedAccountsEndpointRetiredError` (`src/models/ConnectedAccounts.ts:146-160`)
     * — and `use_composio_managed_auth` is exactly what {@link ComposioBroker.ensureAuthConfig}
     * creates. `link` is the vendor's own named replacement for that combination, carries the
     * callback, and answers in the same shape.
     *
     * TAKING THE AUTH CONFIG ID IS NOT A COST HERE. It is the one thing `toolkits.authorize` was
     * doing for us, and it did it by listing the configs and creating one at Composio's managed
     * defaults where it found none — which this deployment already does for itself, at enable
     * time, named so an operator can find it in their dashboard. The listing below is that same
     * read; the creation is not repeated, because an app with no config is a state to report
     * rather than one to paper over.
     */
    link(
      userId: string,
      authConfigId: string,
      options: { callbackUrl: string },
    ): Promise<{ redirectUrl?: unknown }>;
    /**
     * Create one person's account from the secret they typed, WITHOUT a consent screen anywhere.
     *
     * THE RAW CLIENT FOR THE REASON BOTH DELETES ARE RAW, and a sharper one. `@composio/core`'s
     * `connectedAccounts.initiate` is the wrapper over this endpoint, and the endpoint under it is
     * retired for the managed-auth path — it throws
     * `ComposioLegacyConnectedAccountsEndpointRetiredError` (`@composio/core` 0.18.1,
     * `src/models/ConnectedAccounts.ts:146-160`) — while `link`, which replaced it, mints a consent
     * url and has nowhere to put a typed value at all. What this flow needs is neither: the person
     * has already typed their credential into a form here, so there is no screen to send them to
     * and nothing to come back from. `@composio/client`'s own create takes the state directly
     * (`0.1.0-alpha.76`, `resources/connected-accounts.d.ts:33`, `:7502-7511`), which is the whole
     * of what this call is.
     *
     * NO `validate_credentials`, AND ITS ABSENCE IS DELIBERATE RATHER THAN AN OVERSIGHT. The
     * parameter exists on the same body and the vendor marks it EXPERIMENTAL (`:7505-7509`).
     * Whether a typed key actually works is settled here by making a call with it rather than by
     * asking Composio to grade it, because a connection Composio accepts is not a connection that
     * works: a wrong value comes back `ACTIVE`.
     *
     * `id` AND `status` READ AS `unknown`, for the reason every other vendor field in this
     * projection is. The generated client declares both as required
     * (`ConnectedAccountCreateResponse`, `:121-146`), which is the schema's promise about what
     * Composio means to send rather than a fact about what arrived — and the id is the one field
     * this whole call exists to answer, so a missing one is a refusal here rather than an
     * `undefined` handed on as the account somebody is meant to be able to undo.
     */
    create(body: {
      auth_config: { id: string };
      /**
       * The person, and the secret they typed, in the shape the vendor's own builder assembles.
       *
       * `state` IS `unknown` BECAUSE WHAT GOES IN IT IS THE APP'S QUESTION RATHER THAN THIS FILE'S
       * ANSWER. The generated client declares it as a fourteen-member union keyed on the scheme,
       * each member's `val` carrying whatever fields that app publishes plus `[k: string]: unknown`
       * (`@composio/client` 0.1.0-alpha.76, `resources/connected-accounts.d.ts:7551`, `:8083-8086`)
       * — so naming a shape here would be this file asserting which boxes an app asks for, which is
       * exactly the thing {@link ComposioBroker.connectionFields} exists to go and ask.
       */
      connection: { user_id: string; state: unknown };
    }): Promise<{ id?: unknown; status?: unknown }>;
    /**
     * Delete one connected account, and ask for the grant behind it to be revoked too.
     *
     * WITHOUT THE FLAG THIS CALL DOES NOT REVOKE ANYTHING, and that is the vendor's own description
     * of it: it "soft-deletes a connected account by marking it as deleted in the database", which
     * "prevents the account from being used for API calls but preserves the record"
     * (`@composio/client` 0.1.0-alpha.76, `resources/connected-accounts.d.ts:59-72`). The refresh
     * token at Google or Slack survives that untouched. Every path in this deployment that claims
     * to end somebody's access — a person disconnecting, an administrator removing an app, a person
     * being offboarded — runs through here, so an unflagged delete made all three of those claims
     * false at once and wrote `true` into the audit trail beside them.
     *
     * WHAT THE FLAG BUYS IS A REQUEST AND NOT A RESULT, which is the whole reason
     * {@link ComposioBroker.revoke}'s answer is named the way it is. The upstream revocation runs as
     * a background job; the response carries its `revoke_job_id` and the vendor documents that no
     * generally available endpoint polls it (`:7447-7459`). Nothing here can say the provider tore
     * the refresh token up, and nothing here pretends to.
     *
     * BUT THE ANSWER DOES SAY WHETHER COMPOSIO DID ITS OWN HALF, AND THAT WAS BEING DISCARDED.
     * `ConnectedAccountDeleteResponse` carries a REQUIRED `success: boolean`, "indicates whether
     * the connected account was successfully deleted" (`@composio/client` 0.1.0-alpha.76,
     * `resources/connected-accounts.d.ts:7445-7459`). This used to be `Promise<unknown>`, read for
     * nothing, on the argument that no field on the answer could support a stronger claim than "we
     * asked". That argument is true of the REVOCATION and false of the DELETE: a 200 carrying
     * `success: false` is Composio saying it did not delete the account, so the background job the
     * flag asks for was never started either — and {@link ComposioBroker.revoke} answered `true`
     * over the top of it while the grant stood at the provider. Reading it is not a stronger claim
     * than "we asked"; it is the difference between having asked and having been refused.
     *
     * DECLARED `success?: unknown` RATHER THAN AT THE VENDOR'S OWN `boolean`, for the reason every
     * other field in this projection is: the generated client parses the body and hands it over, so
     * "required" is the schema's promise about what Composio means to send rather than a fact about
     * what arrived. {@link withdrawalDeclined} is where the three answers are told apart.
     *
     * `revoke_job_id` IS DELIBERATELY NOT READ, and its absence is deliberately not a refusal. The
     * same declaration marks it optional and says it is present "only when `revoke_on_delete=true`"
     * — which says when it CAN appear, not that it always does — so a guard on it would turn every
     * withdrawal Composio accepted into a permanent failure the first time they stopped sending it,
     * which is the shape of mistake this file has already made twice in the other direction.
     *
     * NULLABLE AND OPTIONAL THOUGH THE VENDOR'S OWN DECLARATION IS NEITHER, because the generated
     * client has two answers it resolves with no document: a 204 becomes `null` and a JSON reply
     * carrying `content-length: 0` becomes `undefined` (`@composio/client` 0.1.0-alpha.76,
     * `src/internal/parse.ts:16-42`). Declaring this at the vendor's `ConnectedAccountDeleteResponse`
     * would be the same assertion-over-a-wire-value every other field here refuses to make, and it
     * would hide the one case {@link withdrawalDeclined} has to tell from a refusal.
     */
    delete(
      id: string,
      params: { revoke_on_delete: true },
    ): Promise<{ success?: unknown } | null | undefined>;
  };
};

/**
 * The suffix every auth config this deployment creates carries, so a reader can tell whose it is.
 *
 * An auth config is visible in Composio's own dashboard beside any that were made by hand there,
 * and the two are otherwise indistinguishable. The name is the only field this deployment gets to
 * choose, so it is where the provenance goes.
 */
const CONFIG_SUFFIX = "(OpenBot)";

/**
 * How many different unrecognised statuses one refusal names before it stops naming them.
 *
 * The set it bounds is as large as the app's config listing, which is paged — see
 * {@link everyRowOf} — so without a bound the length of an operator's refusal is decided by how
 * many authorization configs somebody made. Five is past the number of distinct words this can
 * plausibly be about: `AuthConfigRetrieveResponseSchema` names two, and a vendor that has invented
 * five more at once is a package upgrade rather than a sentence to read.
 */
const STATUSES_NAMED = 5;

/**
 * Whether this deployment made that auth config, which is the question every decision here turns on.
 *
 * THE SUFFIX IS WRITTEN FOR EXACTLY THIS AND WAS NOT BEING READ. Both callers used to take the
 * first row of an unordered listing, and the two consequences are of different sizes. Removing an
 * app deleted whatever came back first — which can be a config an operator built by hand, with
 * their own scopes and their own tool restrictions, taking every account on it down with it.
 * Beginning a connection attached a person to whatever came back first — which can be a
 * configuration nobody here chose and this deployment cannot see or tighten. And because the order
 * is the vendor's, the two calls can resolve DIFFERENT rows, so an app could be removed while
 * people kept connecting against a config the removal left behind.
 *
 * MATCHED ON THE END OF THE NAME rather than on the whole of it, because the rest of the name is an
 * app's title as an administrator saw it at enable time and titles are edited. The suffix is the
 * part this file writes. Trailing whitespace is tolerated for the same reason it is tolerated
 * anywhere a human-edited string is compared: a name that picked up a space in a dashboard is the
 * same config.
 *
 * IT TAKES A {@link CheckedAuthConfig} AND NOT A {@link VendorAuthConfig}, which is what makes this
 * one line honest. A predicate cannot refuse — it answers true or false — so reading a name the
 * vendor may not have sent here could only ever have meant silently answering `false`, and `false`
 * from this function means "somebody else's config": untouched by a removal, and satisfying the
 * check that stops a second one being created. {@link readableConfigs} is where the absence becomes a
 * sentence instead, upstream of every caller.
 */
function madeHere(config: CheckedAuthConfig): boolean {
  return config.name.trimEnd().endsWith(CONFIG_SUFFIX);
}

/**
 * The statuses that answer "is this person connected", which is the narrow question of the two.
 *
 * ACTIVE ONLY. An `INITIATED` account is somebody who started an authorization and never finished
 * it, and an `EXPIRED` or `REVOKED` one is a grant that no longer opens anything; counting any of
 * them as connected tells a person their app is wired up and then fails every call they make with
 * it.
 */
const CONNECTED: VendorAccountStatus[] = ["ACTIVE"];

/**
 * The statuses that answer "what is there to revoke", which is a deliberately wider question.
 *
 * THE TWO QUESTIONS ARE NOT THE SAME ONE, AND TREATING THEM AS ONE LEFT GRANTS STANDING. This used
 * to be a single ACTIVE listing shared by both, on the argument that "connected" and "there is
 * something to revoke" are the same fact. They are not. A half-finished consent can already have
 * been granted at the provider with the callback never delivered; an `EXPIRED` account is an access
 * token that lapsed and a refresh token that did not; an `INACTIVE` one is a live grant the vendor
 * has set aside. None of them should tell a person they are connected, and every one of them is
 * something whose withdrawal is the entire point of pressing disconnect.
 *
 * `REVOKED` IS THE ONE STATUS LEFT OUT, and left out on purpose rather than forgotten. It is the
 * only value that positively says the grant is already gone, so including it would have this
 * deployment delete a tombstone and then record that it ended somebody's access — the one way the
 * audit field can be made to lie in the direction nobody would check.
 */
const REVOCABLE: VendorAccountStatus[] = [
  "INITIALIZING",
  "INITIATED",
  "ACTIVE",
  "FAILED",
  "EXPIRED",
  "INACTIVE",
];

/**
 * How long one catalogue answer is served to everybody who asks for it.
 *
 * THE CATALOGUE IS READ ONCE PER SEARCH KEYSTROKE OTHERWISE, WHICH IS WHAT THIS IS ABOUT. The admin
 * picker debounces its search field and then asks `/composio/apps`, and that route filters in this
 * process precisely because Composio's toolkit listing takes no search term — so every distinct term
 * a person types is another request for the whole directory, a few hundred rows of it, to answer a
 * question about one. Typing "linear" pulls the catalogue four or five times, and enabling the app
 * afterwards pulls it once more.
 *
 * TEN MINUTES BECAUSE OF WHAT GOES STALE IN IT. The rows are Composio's published toolkits: an app
 * is added to their catalogue or its action count moves every so often, never within one
 * administrator's sitting, and the worst a stale row can do here is show a description or a count
 * that is a few minutes behind. Held for a working session it would be a cache nobody could explain
 * to an operator whose new app is missing; held for seconds it would not survive the debounce it
 * exists for.
 */
const DIRECTORY_TTL_MS = 10 * 60 * 1000;

/**
 * The held catalogue as a copy nobody else holds, which is what makes handing it out safe.
 *
 * WHAT WAS HANDED OUT WAS THE CACHE ITSELF. One array of one set of row objects was returned to
 * every caller for ten minutes, so a route that sorted the rows in place reordered the catalogue for
 * everybody, and one that edited a row — a title trimmed for display, a description truncated —
 * edited what the next caller would read as Composio's answer. Nothing does that today, which is
 * precisely the problem with leaving it: the first caller that does will have changed a cache it
 * had no idea it was holding, and the fault will surface in the NEXT request rather than its own.
 *
 * `categories` AND `connection` ARE BOTH COPIED, because a shallow spread of the row would hand
 * either of them on by reference. This used to copy the array and say it was "the one field here
 * that is not a primitive", which is what let the other one through: {@link BrokerConnection} is an
 * object in every one of its five shapes, so the row's spread carried one object out of the cache
 * and into every caller for the whole ten minutes — the exact sharing this function exists to end,
 * surviving in the field it is worst in. `connection` is what the app picker hides an `unsupported`
 * app by and what the enable route branches on to decide whether to create an authorization config
 * at all, so a caller that edited the object it was handed would be editing what those two
 * decisions read of every later caller's rows.
 *
 * SPREAD RATHER THAN NAMED PER KIND, so that adding a member to the union — or a field to one of
 * them — cannot quietly reintroduce the sharing. The spread of a union widens to the union, which
 * is the one shape here a `switch` on `kind` would have to be kept in step with by hand.
 *
 * COPIED RATHER THAN FROZEN, which was the other candidate. Freezing would make the sharing safe by
 * making a mutation throw, but the type says `BrokerApp[]` and a caller is entitled to sort a list
 * it was given; turning a reasonable caller into a `TypeError` is a worse answer than a few hundred
 * small objects, which is nothing beside the request this cache exists to avoid.
 */
function copyOf(apps: Promise<BrokerApp[]>): Promise<BrokerApp[]> {
  return apps.then((held) =>
    held.map((app) => ({
      ...app,
      categories: [...app.categories],
      connection: { ...app.connection },
    })),
  );
}

/**
 * Both seams, over one vendor client.
 *
 * TAKING THE VENDOR OBJECT RATHER THAN A KEY IS THE SEAM. It is what lets every test of this
 * file's own decisions — which limit went out, which field became which, which call was refused
 * before it was made — run against an object literal and never a socket. {@link createComposioClient}
 * is the one line that turns a key into a vendor, and it is deliberately too thin to have a bug in.
 *
 * The vendor is captured in a closure rather than stored on either returned object, so neither
 * `actions` nor `broker` offers a route back to the client or to the key it holds.
 *
 * @param now The clock the catalogue's lifetime is measured against, injected for the same reason
 * the vendor is. A test that could not move the clock could only assert the cache's hit by counting
 * calls and would have to sleep ten minutes to assert its expiry, so the window would be the one
 * thing here no test could reach. It is a parameter of the builder rather than of
 * {@link ComposioBroker.listApps}, because the seam's callers are routes and none of them has an
 * opinion about what time it is.
 */
export function buildComposioClient(
  vendor: ComposioVendor,
  now: () => number = Date.now,
): {
  actions: ComposioActions;
  broker: ComposioBroker;
} {
  /**
   * This person's accounts for this app, in whichever states the ASKING question is about.
   *
   * ONE LISTING WITH THE STATUSES AS ITS ARGUMENT, rather than one listing both callers share.
   * They shared one until it turned out that the shared answer was wrong for one of them: see
   * {@link CONNECTED} and {@link REVOCABLE} for why "is this person connected" and "what is there
   * to revoke" are different questions. What they do share is everything a drift between them
   * would come from — the breadth of `accountType`, the limit, and the fact that both ask about one
   * person and one app — so the difference between them is exactly the list of statuses and is
   * visible at both call sites.
   *
   * AND SO ARE THE OTHER TWO THINGS THE TWO QUESTIONS DO NOT SHARE, for the same reason the
   * statuses are. `configs` is which authorization configs the answer is about — every one of them
   * for the gate, and only this deployment's for the withdrawal, because the withdrawal ACTS on
   * what it finds. `enough` is when the rows in hand already settle the question, which is true of
   * a boolean the moment one row arrives and never true of a set of accounts to end. Both are
   * written at the call sites below, beside the statuses, so that the whole of the difference
   * between the two questions is one argument list a reader can compare.
   */
  const accountsFor = async (
    userId: string,
    toolkit: string,
    statuses: VendorAccountStatus[],
    asked: {
      configs?: string[];
      enough?: (rows: { id?: unknown }[]) => boolean;
    } = {},
  ): Promise<{ id?: unknown }[]> => {
    /*
     * EVERY PAGE UNLESS THE CALLER SAYS OTHERWISE, READ HERE RATHER THAN AT EITHER CALLER, so that
     * the two questions cannot drift on the one thing they do share. A truncated listing is the
     * wrong answer to both of them for the same reason: `false` claims somebody has no account for
     * an app when nobody looked at all of them, and a withdrawal that saw one page ends fewer
     * grants than it reports. What a caller may say is that it has ENOUGH — see {@link everyRowOf}
     * — which is not truncation: it is a question that has been answered.
     *
     * THE ROWS GO BACK AS ROWS, WHICH IS NARROWER THAN WHAT THIS USED TO HAND OVER. It read every
     * id here, and the two callers do not want the same thing: `isConnected` is a COUNT — the id is
     * nothing it reads — so taking ids on its behalf turned an account Composio described without
     * one into a thrown refusal against a person who is, in fact, connected. Reading the ids is the
     * withdrawal's business, and it is done there, where a row that cannot be named is something to
     * report alongside the grants that were ended rather than something to stop them.
     */
    const rows = await everyRowOf(
      {
        noun: `this person's ${toolkit} accounts`,
        consequence:
          "neither whether they are connected nor what there is to withdraw could be read",
      },
      (cursor) =>
        askVendor(
          {
            outcome: `this person's ${toolkit} accounts were not read`,
            app: toolkit,
          },
          () =>
            vendor.connectedAccounts.list({
              userIds: [userId],
              toolkitSlugs: [toolkit],
              /*
               * COPIED, BECAUSE WHAT THE CALLERS PASS IN IS {@link CONNECTED} OR {@link REVOCABLE}
               * ITSELF. Every other list in this body is built here — `[userId]`, `[toolkit]`, and
               * `asked.configs`, which is a fresh `map` — and this one was the adapter's own
               * module-level constant handed straight over the seam to the vendor's package. A
               * recipient that sorts, de-duplicates or appends to the array it was given would not
               * spoil one listing; it would rewrite the constant for the life of the process, after
               * which `isConnected` — the gate `./access` asks before running somebody's action —
               * and the withdrawal's own filter would both be asking a question nobody wrote down,
               * in the next request rather than this one. It is the same reasoning {@link copyOf}
               * applies to the catalogue rows, with no expiry to bound it.
               */
              statuses: [...statuses],
              accountType: "ALL",
              // Spread for the reason the cursor is: an explicit `undefined` reaches the vendor's
              // `parse` as a key, and "about every config" is said by not naming any.
              ...(asked.configs === undefined
                ? {}
                : { authConfigIds: asked.configs }),
              limit: LISTING_LIMIT,
              ...(cursor === undefined ? {} : { cursor }),
            }),
        ),
      asked.enough,
    );
    return rows;
  };

  /**
   * Every auth config Composio holds for one app, ours and anybody else's alike, in one order.
   *
   * THE LISTING IS SCOPED TO THE PROJECT AND NOT TO THIS DEPLOYMENT, which is the correction. An
   * auth config is scoped to the project the API key belongs to — so nothing here is hidden from
   * this listing, and that was read as "everything it returns is ours". It is not: an operator with
   * the same project open in Composio's dashboard can create configs for the same app by hand, for
   * purposes this deployment knows nothing about. {@link madeHere} is the only thing that tells the
   * two apart, and every caller below is about an object one of them must not touch.
   *
   * THE UNCLAIMED ROWS ARE RETURNED RATHER THAN DROPPED HERE, which is the part that moved. The
   * filter used to live on the way out, so "no configs at all" and "configs, none of them ours"
   * reached every caller as the same empty array — and telling those two apart is the whole of what
   * {@link ComposioBroker.deleteAuthConfig} was missing, and then of what
   * {@link ComposioBroker.revoke} was missing a wave later, on the same distinction, one function
   * away. The `ours` filter is still offered, beside rather than instead of the rest, because a
   * caller that can only see its own configs is a caller that cannot notice the other two states.
   *
   * SORTED SO THAT TWO CALLERS AGREE. The vendor's order is not documented, and the whole failure
   * being fixed here is two calls resolving different rows; a total order on the id makes the
   * choice this file makes a stable one, whoever asks and whenever.
   *
   * BY CODE UNIT RATHER THAN BY `localeCompare`, WHICH IS THE WHOLE POINT OF THE SORT RATHER THAN A
   * QUIBBLE WITH IT. `localeCompare` called with no locale collates in the HOST's, and the hosts
   * are not one host: "ac_B" comes before "ac_a" by code unit and after it under an English
   * collation, and the two callers this order exists to keep in step — a person pressing Connect
   * and an administrator pressing Remove — need not be answered by the same process, the same
   * container or the same build of ICU. An order that two machines can disagree about is not an
   * order two callers agree on. `<` is the same total order everywhere, which is the only property
   * asked of it here.
   *
   * THREE PARTS RATHER THAN A LIST, AND THAT IS A GUARD AGAINST THIS FILE'S OWN HISTORY. Each of
   * the four callers below has to answer three different questions about one listing — what is
   * ours, what is standing that is not, and what could not be read at all — and every defect this
   * function has been corrected for was one caller answering one of them while its neighbour, one
   * function away, answered it differently or not at all. A shape that hands over only `ours`
   * lets a caller not notice the other two; this one cannot be destructured without saying so.
   */
  const configsFor = async (
    toolkit: string,
  ): Promise<{
    /** Every readable row, ours and anybody else's alike, deduplicated and in one order. */
    held: CheckedAuthConfig[];
    /** The subset of `held` carrying {@link CONFIG_SUFFIX}, which is what this deployment claims. */
    ours: CheckedAuthConfig[];
    /** One refusal per row that could be sorted into neither, which is never nothing. */
    unreadable: BrokerRefusalError[];
  }> => {
    /*
     * EVERY PAGE, BECAUSE A CONFIG ON THE SECOND ONE IS STILL OURS. Read one page and the two
     * callers below are wrong in the two opposite directions {@link madeHere} describes:
     * `ensureAuthConfig` finds none and creates the second config it exists to prevent, and
     * `deleteAuthConfig` leaves one standing, reports a clean removal, and lets `removeServer`
     * delete the app's row over the top of a live grant.
     */
    const rows = await everyRowOf(
      {
        noun: `this deployment's authorization configs for ${toolkit}`,
        consequence:
          "whether one exists is not something this deployment can tell",
      },
      (cursor) =>
        askVendor(
          {
            outcome: `this deployment's authorization configs for ${toolkit} were not read`,
            app: toolkit,
          },
          () =>
            vendor.authConfigs.list({
              toolkit,
              limit: LISTING_LIMIT,
              showDisabled: true,
              ...(cursor === undefined ? {} : { cursor }),
            }),
        ),
    );
    /*
     * CHECKED BEFORE THE FILTER AND NOT AFTER IT, which is the order the whole guard turns on. The
     * filter's question IS the name, so a row checked only once it had been kept would be a row
     * sorted by a field nobody had read — see {@link madeHere} for what each of the two guesses
     * costs. Every row therefore passes {@link readableConfigs} first, including the ones that turn
     * out to belong to an operator's own dashboard work.
     */
    const { configs, unreadable } = readableConfigs(rows, toolkit);
    const held = configs.sort((one, other) =>
      one.id < other.id ? -1 : one.id > other.id ? 1 : 0,
    );
    return { held, ours: held.filter(madeHere), unreadable };
  };

  /**
   * Ask for every one of them and answer with what refused, rather than stopping at the first.
   *
   * A THROW MID-LOOP ABANDONS GRANTS THAT ARE STILL LIVE. Both callers below are deleting a set of
   * things that each independently hold somebody's access, and an exception out of the second of
   * five leaves three untouched and unmentioned — while the caller is told only about the one that
   * failed, so nothing in the answer says the loop did not finish. Attempting all of them makes the
   * failure a statement about a set: this many were asked for and this many refused.
   *
   * SERIALLY RATHER THAN TOGETHER, for the same reason every other call here goes out one at a
   * time: the vendor rate-limits, and a person with several accounts is not a reason to open
   * several connections. The order is the listing's, which is sorted.
   *
   * EVERY REFUSAL IS ANSWERED AND NOT ONLY THE FIRST. What the callers do with this list is throw a
   * COUNT — "two of three were withdrawn and the rest refused" — because a count is what a reader
   * can act on, which makes the reasons the only place the detail lives. Returning them all is what
   * lets {@link everyRefusal} put all of them on the failure the caller raises; the previous version
   * collected them and both callers then read `refused[0]`, so the second and third reason existed
   * for the length of one expression and were then dropped.
   *
   * EVERY FAILURE IS A REFUSAL HERE, AND THE CLASSIFICATION THAT USED TO SIT IN THIS LOOP HAS MOVED
   * ONE LAYER DOWN. There was an `isOurFault` test in the catch that re-threw a `TypeError`, a
   * `ReferenceError` or a `RangeError` rather than counting it, on the premise that those are what
   * a program's own mistake looks like and are never "a thing Composio can reply". The premise is
   * false — see the `TypeError` row in {@link vendorRefusal} for the five vendor shapes that raise
   * exactly that from inside `@composio/core`'s own transformers — so its effect was inverted: a
   * vendor fault escaped the loop as a bug of ours, abandoning every account after it unasked, and
   * the person was handed a crash instead of a sentence.
   *
   * IT MOVED RATHER THAN BEING RETUNED because this loop cannot make the distinction and
   * {@link askVendor} can. Every `ask` below is one `await vendor.*` wrapped by that function, so
   * whether a fault came from inside the vendor's code is a fact about the call stack there, where
   * here it could only ever have been guessed at from an error class.
   */
  const askForEach = async <T>(
    items: T[],
    ask: (item: T) => Promise<unknown>,
  ): Promise<unknown[]> => {
    const refused: unknown[] = [];
    for (const item of items) {
      try {
        await ask(item);
      } catch (error) {
        refused.push(error);
      }
    }
    return refused;
  };

  /**
   * The catalogue answer this process is currently serving, and the moment it was asked for.
   *
   * A PROMISE RATHER THAN THE ROWS, WHICH IS THE WHOLE ANSWER TO CONCURRENCY. The entry is written
   * before the request is answered, so a second caller arriving while the first is still in flight
   * finds it and awaits the same request. Holding the resolved rows instead would leave the window
   * this cache exists to close wide open: three people opening the picker together, or one person's
   * debounce firing twice, are exactly the case where nothing is cached yet, and each of them would
   * start their own catalogue fetch and then overwrite each other's answer.
   *
   * IT IS PER BUILT CLIENT, not per module. This adapter is built once per deployment key, so in
   * this process that is one cache; in a test it is one cache per {@link buildComposioClient}, which
   * is what lets each test below start from nothing without an API for emptying it.
   */
  let heldDirectory: { at: number; apps: Promise<BrokerApp[]> } | null = null;

  /**
   * The catalogue as the vendor answers it, EVERY PAGE OF IT, mapped to the rows a person picks from.
   *
   * IT USED TO BE ONE PAGE AND A REFUSAL, AND THAT REFUSAL IS THE BUG THIS FUNCTION WAS FIXED FOR.
   * It asked for {@link LISTING_LIMIT} rows, met exactly that many, and threw — because a full page
   * and a truncated one are the same array and it believed no second request could tell them apart.
   * Composio publishes more than {@link LISTING_LIMIT} toolkits, so the condition was true on every
   * call and the app picker showed an operator nothing at all, with a sentence explaining why a
   * partial directory would be worse. The reasoning was right and the premise was false: the raw
   * client has a cursor for this listing and always did. See {@link ComposioVendor} and
   * {@link everyRowOf}.
   *
   * SORTED BY USAGE, AND NO SEARCH TERM — see {@link ComposioVendor}, where both are argued now
   * that neither is holding a finite page together.
   *
   * THROWN FROM INSIDE THE FETCH, WHICH IS WHAT KEEPS A FAILURE OUT OF THE CACHE. Every refusal
   * below — a cursor that cannot be followed, a page that is not a page, a row that cannot be read
   * — rejects the promise `listApps` holds, and `listApps` drops an entry whose request rejected.
   * A fragment committed here would be a fragment served for ten minutes to BOTH callers: an
   * administrator searching for an app past the cut is told nothing matched, and the enable route,
   * which checks a slug against this same directory, tells them a real app is not one Composio
   * lists.
   */
  const fetchDirectory = async (): Promise<BrokerApp[]> => {
    const listing: Listing = {
      noun: "Composio's app catalogue",
      consequence: "the directory was not shown",
    };
    const toolkits = await everyRowOf<VendorToolkit>(listing, (cursor) =>
      pageOf(listing, () =>
        askVendor(
          { outcome: "the app catalogue was not read", app: null },
          () =>
            vendor.toolkits.list({
              limit: LISTING_LIMIT,
              sort_by: "usage",
              // Spread rather than an explicit undefined, for the reason `everyRowOf` gives: a
              // `cursor: undefined` is a key on the wire, and "the first page" is said by omission.
              ...(cursor === undefined ? {} : { cursor }),
            }),
        ),
      ),
    );

    /*
     * Each absence becomes the value that reads honestly on an administrator's screen, and each
     * PRESENT field that is not what it is declared to be becomes a refusal — see {@link appOf},
     * where both halves of that and every sentence live. An empty description shows as no
     * description; a null logo is the field's documented way of saying the vendor published none,
     * which renders as a gap rather than as a broken image.
     *
     * The categories are the DISPLAY names rather than the slugs, because this list is read by a
     * person choosing an app and "Productivity" is what they are choosing by.
     *
     * A MISSING COUNT BECOMES ZERO, WHICH IS THE ONE IMPERFECT ANSWER HERE. `actionCount` is a
     * number and the shape offers no way to say "not published", so a toolkit that publishes no
     * count reads as an app with no actions. It is the conservative direction — it understates
     * the size of a change rather than overstating it — and Composio publishes a count for every
     * toolkit measured, so this is a guard against the vendor rather than a routine case. A count
     * that arrives as something other than a number is the different case and is refused.
     */
    return toolkits.map(appOf);
  };

  const actions: ComposioActions = {
    async listActions(toolkit, page): Promise<ComposioAction[]> {
      /*
       * A PAGE OF NOTHING IS NOT A PAGE, AND THE REASON IT IS REFUSED HAS MOVED.
       *
       * It used to be a fact about the wrapper: `getRawComposioTools` composed its request with
       * `...(limit ? { limit } : {})` (`@composio/core` 0.18.1, `src/models/Tools.ts:536`) over a
       * schema spelling the field `z.number().optional()` with no floor
       * (`src/types/tool.types.ts:257`), so a zero was not sent short — it was not sent at all, and
       * Composio's own page of twenty came back looking exactly like everything a small app
       * publishes. The raw client passes a zero through, so what a zero means now is Composio's to
       * say rather than a silent substitution.
       *
       * IT IS STILL REFUSED, AND THE ARGUMENT IS THE ONE THAT DID NOT DEPEND ON THE WRAPPER. The
       * page is required on this seam precisely so that no layer supplies one quietly; a caller
       * asking for no rows is a caller with a fault, and a fault is a thing to report rather than a
       * thing to correct on their behalf. What changed with paging is that the limit is now a PAGE
       * SIZE rather than the whole listing — {@link everyRowOf} reads on until the cursor stops —
       * so a small one costs requests rather than actions. A zero would cost every request there
       * is, or none.
       */
      if (!Number.isInteger(page.limit) || page.limit < 1) {
        throw new Error(
          `A page of ${page.limit} rows is not a page Composio can be asked for, so ${toolkit}'s action list was not refreshed and the tools already held are untouched. The page a listing asks for is required on this seam so that no layer supplies one quietly, and a request for no rows is a fault to report rather than one to correct on a caller's behalf.`,
        );
      }

      /*
       * EVERY PAGE, WHICH IS WHAT THIS SEAM COULD NOT DO UNTIL THE LISTING LEFT THE WRAPPER.
       * `./composio` used to meet a listing at {@link LISTING_LIMIT} and refuse it, for the reason
       * the catalogue above used to: an app with exactly that many actions and one with more of
       * them answer identically, and committing the second deletes every action past the cut from
       * `mcp_tools` under a refresh that reported success. That refusal is gone with this, and the
       * guard it cannot be confused with — `store.ts`'s empty-listing guard — stays where it is.
       */
      const listing: Listing = {
        noun: `${toolkit}'s actions`,
        consequence: `${toolkit}'s action list was not refreshed and the tools already held are untouched`,
      };
      const tools = await everyRowOf<VendorToolRow>(listing, (cursor) =>
        pageOf(listing, () =>
          askVendor(
            {
              outcome: `${toolkit}'s action list was not refreshed and the tools already held are untouched`,
              app: toolkit,
            },
            () =>
              vendor.tools.list({
                toolkit_slug: toolkit,
                limit: page.limit,
                // The SDK's own default, forwarded on every listing it made, and the thing that
                // decides which `version` each action carries. See {@link ComposioVendor}.
                toolkit_versions: "latest",
                ...(cursor === undefined ? {} : { cursor }),
              }),
          ),
        ),
      );

      return tools.map((row, position) => actionOf(row, position, toolkit));
    },

    async execute(call, args): Promise<ComposioResult> {
      /*
       * THE TOOL IS RESOLVED BEFORE IT IS RUN, AND THAT COSTS A ROUND TRIP ON PURPOSE.
       *
       * Composio's execute takes the slug alone — its REST parameters have no toolkit field — so
       * the pair the caller was gated on cannot travel on the wire, and the obligation
       * {@link ComposioActions.execute} writes down has to be discharged here instead. The
       * resolved tool carries the app the vendor will actually run it against, so asking for it
       * first is what makes the check possible at all.
       *
       * `tools.execute` resolves the same tool again internally, so this is a second request
       * rather than a saved one. It buys the one thing a single request cannot: a mismatch that is
       * refused before anything runs, rather than discovered in an audit row afterwards.
       *
       * AND IT IS TAKEN AT ITS DECLARED TYPE, WHICH IS THE ONE ANSWER IN THIS FILE MOST SAFE TO DO
       * THAT WITH. `getRawComposioToolBySlug` ends in `this.transformToolCases(tool)` (`@composio/core`
       * 0.18.1, `src/models/Tools.ts:719`), whose last act is `ToolSchema.parse(...)` — a throwing
       * parse — so what resolves here is an object satisfying that schema or a `ZodError` that
       * `./composio` recognises and answers with a package remedy. An answer that is not an object,
       * and a `toolkit` that is present and not an object, both die at that parse; two refusals
       * stood here for exactly those and neither could be reached.
       */
      const resolved = await askVendor(
        {
          outcome: `${call.slug} was not resolved and nothing was run`,
          app: call.toolkit,
        },
        () =>
          vendor.tools.getRawComposioToolBySlug(call.slug, {
            version: call.version,
          }),
      );

      /*
       * AN UNREADABLE APP IS NOT THE SAME FACT AS NO APP, AND THEIR REMEDIES DIFFER. The mismatch
       * refusal below ends by telling an administrator to refresh this app's tools, which is right
       * for a slug recorded against a url that has since changed and useless for an SDK that has
       * begun answering a different shape. So a toolkit whose slug is not a usable name is refused
       * as what it is rather than folded into "no app at all", where it would arrive wearing a
       * remedy that cannot work.
       *
       * AND IT IS STILL READ, DESPITE `ToolkitSchema` SPELLING THE SLUG REQUIRED, for the reason
       * {@link actionOf} reads the action's own: `z.string()` is satisfied by the empty string, so
       * a passing parse still admits an app with no name — which would compare unequal to every
       * toolkit and refuse this call as a mismatch with nothing on the other side of the sentence.
       */
      /*
       * `?? undefined` BECAUSE ABSENT ALREADY HAS A SENTENCE HERE AND `null` IS THE OTHER SPELLING
       * OF IT. The mismatch refusal below already says "no app at all" for an action the vendor
       * attributes to nothing, so absence is an answer on this path rather than a fault. Exempting
       * only `undefined` read a `null` as an app that was PRESENT and then took `.slug` off it —
       * `null is not an object (evaluating 'answeredApp.slug')`, thrown from outside every vendor
       * `try` in this file, which `./composio` puts into a model's context and an audit row as this
       * deployment's account of what happened. That is the same `undefined`-only exemption the
       * three field guards in {@link actionOf} carried, failing the loud way instead of the total
       * one.
       */
      const answeredApp = resolved.toolkit ?? undefined;
      let ran: string | undefined;
      if (answeredApp !== undefined) {
        /*
         * `answeredSlug` RATHER THAN `named`, WHICH IS ONLY A RENAME AND IS WORTH ONE LINE. This
         * binding was called `named` and shadowed the module helper of that name for the rest of
         * the block — so {@link named} was unreachable here, and an edit reaching for it would have
         * been calling a string. Nothing was wrong today; the next change to this block is what the
         * rename is for.
         */
        const answeredSlug = textOf(answeredApp.slug);
        if (answeredSlug === null) {
          throw new Error(
            `Composio sent ${sent(answeredApp.slug)} where the slug of the app ${call.slug} belongs to should be, so nothing was run: a name this deployment cannot read is not one it can compare with ${call.toolkit}. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        ran = answeredSlug;
      }

      if (ran !== call.toolkit) {
        /*
         * REFUSED RATHER THAN FORWARDED, and both apps are named.
         *
         * The gate in `./access` cleared this run against the app the connection's url names
         * NOW; the slug was recorded by a listing made at some earlier time. Where the two
         * disagree — a url edited between a refresh and a call — forwarding runs one person's
         * Gmail action under a gate that only ever examined their Slack connection. A reader
         * holding only one of the two names cannot tell which of the two is the wrong one, so
         * both go in the sentence. An app the vendor did not name at all is the same refusal:
         * this deployment cannot show that the call is about the app it was gated on.
         */
        throw new Error(
          `${call.slug} was not sent to Composio: this connection is for ${call.toolkit}, and Composio resolves that action to ${
            ran ?? "no app at all"
          }. Refreshing this app's tools on its Plugins page recovers it where the action was recorded against a url that has since changed.`,
        );
      }

      return askVendor(
        { outcome: `${call.slug} was not run`, app: call.toolkit },
        () =>
          vendor.tools.execute(call.slug, {
            arguments: args,
            userId: call.userId,
            version: call.version,
            /*
             * SPREAD RATHER THAN PASSED AS `undefined`, which is the same care every other optional
             * on this wire gets here — see the cursor on the listings above. What the vendor is
             * handed for "any account of theirs" is a body with no such key, not a key holding
             * nothing, so a client that distinguishes the two cannot read an absent pin as a
             * request for an account called undefined.
             */
            ...(call.connectedAccountId === undefined
              ? {}
              : { connectedAccountId: call.connectedAccountId }),
          }),
      );
    },
  };

  const broker: ComposioBroker = {
    /**
     * The catalogue, from memory where this process asked for it less than ten minutes ago.
     *
     * BOTH CALLERS READ THE SAME HELD ANSWER, AND THE SECOND OF THEM IS THE INTERESTING ONE. The
     * search route filters the directory in this process, so caching it is what stops a debounced
     * search field from pulling a few hundred rows once per term. The enable route then reads the
     * directory again to check that the slug it was handed is one Composio lists, and that read
     * comes out of the same cache — which is the right answer rather than a concession, because
     * the slug being checked is one this deployment handed the browser out of THIS cache moments
     * earlier. The check exists to refuse a slug the catalogue never published — a request composed
     * by hand, or a row left over from a url somebody edited — and a ten-minute-old catalogue
     * settles that question exactly as well as a fresh one. The case it gives up is an app Composio
     * withdrew within the window, whose cost is one `mcp_servers` row for an app that answers
     * nothing, removable on the page that added it; the case it buys is that pressing Add does not
     * re-read a catalogue the picker just read.
     *
     * A FAILURE IS NEVER HELD. The entry is dropped when its request rejects, so a vendor that
     * refused once is asked again by the next caller rather than refusing from memory for ten
     * minutes — the failures here are an unset or wrong API key and Composio being down, and the
     * first two are fixed by an operator who then presses the button again, which must be allowed
     * to work. The callers already sharing that one in-flight request do share its failure, which
     * is the truth about their request: they asked while it was being answered.
     *
     * THERE IS NO INVALIDATION, AND THE DESIGN ASKED FOR ONE. It wanted the directory "refreshable
     * by an explicit reload", and that is not built: the lifetime above is the whole of the
     * freshness story. Nothing in this deployment reloads a catalogue today — no page, route or job
     * has such a control — so the method would have no caller, and an invalidation API with no
     * caller is an untested path that reads like a guarantee. The moment a reload button exists,
     * this is where it attaches.
     */
    async listApps(): Promise<BrokerApp[]> {
      const held = heldDirectory;
      if (held && now() - held.at < DIRECTORY_TTL_MS) return copyOf(held.apps);

      /*
       * Stamped when the request goes out rather than when it comes back, so a slow catalogue is
       * held for slightly less than the full window rather than for the window plus its own
       * latency. Written into the slot before it is awaited, which is what a concurrent caller
       * finds.
       */
      const entry = { at: now(), apps: fetchDirectory() };
      heldDirectory = entry;
      /*
       * The drop on failure, registered here rather than written as a try/catch around an await so
       * that this method hands every caller the one shared promise. `heldDirectory === entry`
       * because a later request may already have replaced this one, and clearing that would throw
       * away a good answer over an old failure.
       */
      entry.apps.catch(() => {
        if (heldDirectory === entry) heldDirectory = null;
      });
      return copyOf(entry.apps);
    },

    async ensureAuthConfig({
      toolkit,
      name,
      connection,
    }): Promise<AuthConfigOutcome> {
      /*
       * NOTHING AT ALL FOR AN APP THAT NEEDS NO AUTHENTICATION, AND THAT IS THE VENDOR'S RULE
       * RATHER THAN A SHORTCUT. Composio refuses an auth config for such a toolkit — "Cannot
       * create an auth config for toolkit hackernews because it does not require authentication.
       * You can use its tools directly without creating a connected account." — so the listing
       * below is not even worth making: there is nothing to find and nothing to create.
       */
      if (connection.kind === "no-auth") return "not-needed";

      /*
       * AND A REFUSAL BEFORE ANY WRITE for the one kind this deployment cannot drive. The sentence
       * is the derivation's own, which named the scheme and what it wants; a refusal here that
       * invented a second sentence would drift from the one the picker filters on.
       */
      if (connection.kind === "unsupported") {
        throw new BrokerRefusalError(
          `${toolkit} was not enabled: ${connection.reason}`,
        );
      }

      /*
       * IDEMPOTENT BY LOOKING FIRST, because a second config is not a duplicate — it is a split.
       * A person's existing connection is created against one particular auth config, so creating
       * another and connecting the next person to that leaves two populations of connections for
       * one app, and removing "the" config later drops half of them.
       *
       * THE LOOK IS FOR ONE THIS DEPLOYMENT MADE, WHICH IS NARROWER THAN "ANY". It used to be any,
       * and the two ways that was wrong pull in opposite directions. A disabled config of ours was
       * invisible to the listing, so this created the very second config it exists to prevent — and
       * then `authorize` refused, because it looked with the same blind listing and found the app
       * had no config at all. A config an operator made by hand, meanwhile, satisfied the check and
       * this created nothing, leaving every later decision here pointed at an object nobody here
       * chose. Asking for our own answers both: the disabled one counts, and somebody else's does
       * not.
       *
       * WHICH MEANS AN APP CAN END UP WITH TWO CONFIGS, ONE OF THEM SOMEBODY ELSE'S, and that is
       * the intended outcome rather than a tolerated one. Adopting a hand-made config would have
       * this deployment mint people's connections against scopes and tool restrictions it cannot
       * see, and delete it when the app is removed. A config of our own, named, is the thing every
       * decision in this file can actually reason about.
       *
       * This is a read followed by a write and therefore not atomic: two administrators pressing
       * enable at the same instant can both find nothing and both create. Composio offers no
       * create-if-absent, so the window is the vendor's rather than this deployment's, and the
       * cost of losing that race is a spare config rather than a lost connection — spare rather
       * than orphaned, because both carry the suffix and `deleteAuthConfig` takes every one of
       * ours.
       */
      const { ours, unreadable } = await configsFor(toolkit);
      /*
       * AND THE ANSWER SAYS THE CONFIG WAS REUSED RATHER THAN SAYING NOTHING, which is what stops
       * the caller recording a scheme this branch did not establish. What stands here was created
       * as whatever it was created as, possibly by an enable months ago against a catalogue answer
       * the vendor has since changed — see {@link ComposioBroker.ensureAuthConfig}.
       */
      if (ours.length > 0) return "standing";

      /*
       * AND A ROW THAT COULD NOT BE READ IS NOT A ROW THAT IS NOT OURS. This is the one of the four
       * callers that must NOT act on what it can name and report the rest — see
       * {@link readableConfigs} for why the other three do. What it would be acting on is a
       * CREATION, and a config created beside a row that is in fact ours under a name Composio sent
       * unreadably is the second config this whole method exists to prevent: two populations of
       * connections for one app, and a removal later that drops half of them. Finding nothing of
       * ours in a listing this deployment could not read is not the same as finding nothing.
       */
      if (unreadable.length > 0) {
        throw new BrokerRefusalError(
          `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read, so whether one of them is already its own is not something it can tell — and the app was not enabled, rather than a second config being created beside one that may already be there. ${VENDOR_SHAPE_REMEDY}`,
          { cause: everyRefusal(unreadable) },
        );
      }

      /*
       * THE OUTCOME NO LONGER CLAIMS NOTHING WAS CREATED, BECAUSE THIS CALL CANNOT KNOW THAT.
       *
       * It said "no authorization config was created for gmail", and {@link vendorRefusal} reads
       * every condition out through that clause — including the `TypeError` row, which is reached
       * exactly when the vendor's own transformer could not read a reply it had already received.
       * So the one condition most likely to mean the config EXISTS was the one telling an
       * administrator it did not, and nothing in this deployment then named the object standing at
       * Composio. What is true of every condition here is the half that is said now: the app is not
       * enabled, and what is at Composio is not something this call can report.
       */
      const configName = `${name} ${CONFIG_SUFFIX}`;

      /*
       * WHICH TYPE OF CONFIG, AND THE MANAGED ONE IS RIGHT FOR EXACTLY ONE OF THE THREE KINDS THAT
       * REACH HERE. It was sent for all of them, and only one of the failures announced itself:
       * Composio has no OAuth client of its own for a self-registering app, so the managed path
       * answers 404 and the app is simply unconnectable — which is what made Linear's MCP app
       * impossible to attach. A key app's was quiet and worse: the config was accepted, and every
       * person enabled onto it was then sent to a consent screen that had nothing to ask them for.
       *
       * AND NEITHER CUSTOM BRANCH CARRIES A CREDENTIAL, which is the point rather than an omission.
       * A self-registering app needs none by definition — the vendor registers a client of its own
       * at connect time. A key app needs none HERE because the key is one person's: it belongs to
       * each connection made against this config, which is per-deployment, and a key written onto
       * it would be one person's secret shared by everybody the app is enabled for.
       */
      const options =
        connection.kind === "consent"
          ? ({ type: "use_composio_managed_auth", name: configName } as const)
          : ({
              type: "use_custom_auth",
              authScheme:
                connection.kind === "self-registering"
                  ? ("DCR_OAUTH" as const)
                  : connection.authScheme,
              name: configName,
              /*
               * THE EMPTY RECORD IS THE VENDOR'S PRICE FOR SENDING NOTHING — see the field's own
               * comment on {@link ComposioVendor}. Omitting it is a `ValidationError` raised before
               * any request, which reads as a refusal to enable rather than as the secret-free
               * config this branch is for.
               */
              credentials: {},
            } as const);

      const created = await askVendor(
        {
          outcome: `the app is not enabled, and whether an authorization config for ${toolkit} now stands at Composio is not something this deployment can tell`,
          app: toolkit,
        },
        () => vendor.authConfigs.create(toolkit, options),
      );

      /*
       * THE REPLY IS READ, WHICH IS THE HALF THAT WAS MISSING. Composio names the config it just
       * made, and the answer was awaited and dropped — so an answer carrying no id at all was a
       * successful enable of an app whose config this deployment could not show existed. It is not
       * an id anything here needs: the next listing finds the config by its name. It is the only
       * evidence in the reply that the creation this method reports actually happened, and a method
       * that returns nothing has no other way to have checked.
       *
       * AND THE REFUSAL SAYS WHAT IS PROBABLY TRUE RATHER THAN WHAT WOULD BE TIDY. The request went
       * out and Composio replied to it, so a config very likely IS standing there — saying "none
       * was created" would be the same lie the outcome above stopped telling. The remedy is the
       * button they just pressed, because {@link ComposioBroker.ensureAuthConfig} is idempotent
       * through the name: a second enable finds the suffix and adopts what is there.
       */
      if (textOf(created?.id) === null) {
        throw new BrokerRefusalError(
          `Composio answered the creation of an authorization config for ${toolkit} with ${sent(created?.id)} where the new config's id belongs, so this deployment cannot show that the config it just asked for exists and the app is not enabled. The request went out and Composio replied to it, so one may well be standing there: enabling ${toolkit} again finds it rather than making a second, because a config whose name ends with ${CONFIG_SUFFIX} is one this deployment claims. ${VENDOR_SHAPE_REMEDY}`,
        );
      }

      // Made here, as `connection`'s scheme, which is what lets the caller record that scheme.
      return "created";
    },

    async deleteAuthConfig(toolkit): Promise<void> {
      /*
       * EVERY CONFIG OF OURS, AND NOTHING THAT IS NOT OURS.
       *
       * This used to delete whichever row the vendor happened to return first, on the reasoning
       * that {@link ComposioBroker.ensureAuthConfig} creates at most one, so a second one must be
       * somebody's dashboard work and must be left alone. The reasoning was right and the code did
       * the opposite of it: with no test of the name, "the first row" is as likely to BE the
       * hand-made config — deleting it, and with it every account anybody had connected against it.
       * Reading the name inverts that. Anything without the suffix is untouched whatever order it
       * arrives in, and everything with it goes, which is also the only way the spare config from a
       * lost enable race is ever cleaned up.
       *
       * QUIET WHERE THERE IS NOTHING OF OURS TO DELETE, because removing an app has to be able to
       * happen twice. An app can be removed, re-enabled and removed again, two administrators can
       * press the button together, and an app enabled before this deployment created configs at all
       * has none to drop. In every one of those the end state is the one that was asked for, so a
       * throw would report a failure while the caller got exactly what they wanted.
       *
       * AND QUIET USED TO MEAN QUIET OVER A CONFIG THAT WAS STILL STANDING, which is the failure
       * being closed here. "Nothing of ours" and "nothing at all" are not the same state, and the
       * listing could not tell a caller which one it was in: rename a config in Composio's
       * dashboard — drop the suffix, or edit the app's title past it — and every decision in this
       * file stops recognising the object it made. `ensureAuthConfig` would create a second beside
       * it, `authorize` would refuse against it, and this returned normally, after which
       * `removeServer` deleted the app's row. The config and every grant made against it outlive
       * the removal with nothing in this deployment naming them, and an administrator is told the
       * app was withdrawn.
       */
      const { held, ours, unreadable } = await configsFor(toolkit);
      if (ours.length === 0 && held.length > 0) {
        /*
         * REPORTED, NOT DELETED AND NOT SWALLOWED, AND THE THIRD OPTION IS THE ONLY HONEST ONE.
         *
         * Deleting anyway is the worse half of the same guess {@link madeHere} exists to stop: a
         * row with a readable name that does not carry the suffix is as likely to be an operator's
         * own dashboard work — their scopes, their tool restrictions, and every account anybody
         * connected against it — as it is to be ours under a new name. Nothing in the row tells
         * them apart, which is why nothing here chooses.
         *
         * WHICH IS THE SAME REASONING AS THE UNREADABLE NAME IN {@link readableConfigs} AND NOT THE SAME
         * CASE. There the ambiguity is about ADDRESSING: the field that decides ownership did not
         * arrive, so no row can be sorted and the removal cannot begin. Here every name arrived and
         * every row is legible; what is in doubt is whether this deployment's own config is among
         * them under a title somebody edited. So the refusal is narrower than that one — it fires
         * only where the removal found nothing it could claim, and stays quiet where a config of
         * ours was found and dropped beside somebody else's, which is the contract
         * {@link ComposioBroker.deleteAuthConfig} states.
         *
         * IT IS A BLOCK, AND THE BLOCK IS THE POINT. The app's row survives this throw —
         * `removeServer` deletes it only after this returns — so the app stays on its Plugins page
         * and stays removable, which is the one thing a silent success took away. The remedy is an
         * operator's and it is one act in a dashboard: rename the config back so it ends with the
         * suffix and remove the app again, which finishes the withdrawal, or satisfy yourself that
         * it is your own and delete it there, which is the only way anything can tell this
         * deployment that the config it made is genuinely gone.
         *
         * A COUNT AND THE SUFFIX, because together they are the whole of what an operator has to
         * look at: how many objects are standing, and the exact string that would have claimed
         * them. The names are not quoted — a config's title is an app name an administrator typed
         * and this file's refusals quote no vendor field it does not have to.
         *
         * AND IT CLAIMS NOTHING ABOUT WHAT THIS DEPLOYMENT ONCE MADE. An app enabled before this
         * deployment created configs at all never had one, which the quiet case above names, so a
         * sentence opening "the config this deployment made" would be a guess in the one place a
         * guess is what is being refused. What is said is only what was just read.
         */
        /*
         * AND AN UNREADABLE ROW IS ITS OWN CLAUSE HERE FOR THE REASON IT IS ONE BELOW, which is the
         * half this refusal was missing. `readableConfigs` sorts EVERY row into one of two piles, so
         * "legible and carrying nobody's suffix" and "not legible at all" are two facts about one
         * listing and arrive together as readily as either arrives alone. Written as a throw that
         * names only the first, the sentence closed by promising that taking the unclaimed config
         * out of the dashboard leaves this app with nothing standing "after which the removal goes
         * through" — and with a row in the other pile that is false: the next press meets the
         * refusal at the end of this method, raised over exactly those rows. An operator sent to do
         * one act and told it finishes the job is the one thing a refusal must not do, and the
         * clause that would have said otherwise was suppressed by a branch about different rows.
         */
        const alsoUnreadable =
          unreadable.length > 0
            ? ` Composio also described ${unreadable.length} more of its ${toolkit} authorization configs with no id or no name, so one of those may be this deployment's own under an answer it could not read: until those are read in Composio's own dashboard too, neither reading settles what is standing and the removal does not go through on the strength of the one above alone.`
            : "";
        throw new BrokerRefusalError(
          `Removing ${toolkit} found none of this deployment's own authorization configs at Composio, and Composio holds ${held.length} for ${toolkit} whose name does not carry ${CONFIG_SUFFIX} — so nothing was deleted and the app has not been withdrawn, rather than a config this deployment cannot show is its own being deleted along with every account connected against it. Nothing here can tell one of ours, renamed in Composio's dashboard, from an operator's own work. If it is this deployment's, the grants made against it are still live, and renaming it to end with ${CONFIG_SUFFIX} lets removing the app again withdraw them. If it is an operator's, only taking it out of that dashboard leaves this app with nothing standing, after which the removal goes through.${alsoUnreadable}`,
          unreadable.length > 0
            ? { cause: everyRefusal(unreadable) }
            : undefined,
        );
      }

      /*
       * AND A LISTING WHOSE ONLY ROWS ARE UNREADABLE IS ITS OWN STATE, WHICH IS THE BRANCH THE
       * OTHER THREE CALLERS HAVE AND THIS ONE DID NOT.
       *
       * `readableConfigs` sorts every row into one of two piles, so "nothing legible at all" is a
       * listing where `held` is empty and `unreadable` is not — which the branch above cannot reach,
       * because it requires `held.length > 0`. What was left to answer it was the partial-withdrawal
       * throw at the end of this method, reached with an empty `ours`: "Composio removed 0 of this
       * deployment's 0 authorization configs for linear and the app has not been fully withdrawn."
       * Both figures are counts of a set nothing read, and "fully" asserts that some of it was
       * withdrawn. Nothing was. The only finding is the rows, and their remedy is a reading in
       * Composio's dashboard rather than the button that was just pressed — it will be exactly as
       * unreadable next time.
       *
       * STILL A REFUSAL, WHICH IS THE HALF THAT DOES NOT MOVE. `removeServer` deletes the app's row
       * only after this returns, so the app stays on its Plugins page and stays removable; a quiet
       * return here would file the app away over rows that may be this deployment's own configs,
       * holding live grants, under an answer it could not read.
       */
      if (ours.length === 0 && unreadable.length > 0) {
        throw new BrokerRefusalError(
          `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read and none of the rest is one it made, so whether any of them is this deployment's own is not something it can tell and nothing was deleted. The app has not been withdrawn, rather than a config this deployment cannot show is its own being deleted along with every account connected against it: reading those rows in Composio's own dashboard is what says whether anything this deployment made is still standing. ${VENDOR_SHAPE_REMEDY}`,
          { cause: everyRefusal(unreadable) },
        );
      }

      /*
       * THE REPLY IS AWAITED AND DROPPED, AND THAT IS NOT THE ASKED-VS-DONE GAP IT LOOKS LIKE.
       * `AuthConfigDeleteResponse` has no `success` field to read — see the declaration on
       * {@link ComposioVendor} for the citation and for what its one optional field means. A throw
       * is the whole of what this call can report, which is why `askForEach` collecting throws is
       * the whole of what is checked.
       */
      const refused = await askForEach(ours, (config) =>
        askVendor(
          {
            outcome: `one of this deployment's authorization configs for ${toolkit} was not removed`,
            app: toolkit,
          },
          () =>
            vendor.authConfigs.delete(config.id, { revoke_on_delete: true }),
        ),
      );
      if (refused.length > 0 || unreadable.length > 0) {
        /*
         * LOUD, because the caller is `removeServer` and the thing it is in the middle of is taking
         * an app away from everybody. A config left standing is a live grant that the removal was
         * supposed to end, and the app's row is deleted after this returns — so a swallowed failure
         * here is the one state nothing in this deployment can find again. The count is the whole
         * message: an operator who can see that one of two configs went knows that pressing remove
         * again finishes the job rather than repeating it. Every refusal the loop met travels as
         * `cause` — see {@link everyRefusal} — because the count is deliberately all the sentence
         * says, which leaves the reasons nowhere else to live.
         *
         * AND AN UNREADABLE ROW LANDS HERE RATHER THAN AHEAD OF THE DELETES, which is the half that
         * moved. Every config of ours is dropped first and the rows that could not be sorted are
         * reported after — {@link readableConfigs} says why at length: refusing before the first
         * delete meant one unreadable row made an app permanently unremovable, with the readable
         * configs of ours standing the whole time. It is still a refusal, so `removeServer` does
         * not delete the app's row and the app stays on its Plugins page.
         *
         * TWO CLAUSES BECAUSE THEY ARE TWO REMEDIES. A config Composio refused is one a second press
         * reaches. A row it described with no id or no name is not — it will be exactly as
         * unreadable next time — so the only instruction that helps names the dashboard rather than
         * the button the operator just pressed.
         */
        const removed = ours.length - refused.length;
        const left: string[] = [];
        if (refused.length > 0) {
          left.push("Removing it again asks only for what is left.");
        }
        if (unreadable.length > 0) {
          left.push(
            `Composio described ${unreadable.length} more of its ${toolkit} authorization configs with no id or no name, so nothing here can tell whether one of those is this deployment's own under an answer it could not read: reading them in Composio's own dashboard is what says whether anything this deployment made is still standing.`,
          );
        }
        throw new BrokerRefusalError(
          `Composio removed ${removed} of this deployment's ${ours.length} authorization configs for ${toolkit} and the app has not been fully withdrawn. ${left.join(" ")}`,
          { cause: everyRefusal([...refused, ...unreadable]) },
        );
      }
    },

    async authorize({
      userId,
      toolkit,
      returnUrl,
    }): Promise<{ redirectUrl: string }> {
      /*
       * THE CONFIG THIS DEPLOYMENT ALREADY MADE, AND NO SECOND ONE MADE HERE.
       *
       * `ensureAuthConfig` creates it when an administrator enables the app, which is what makes
       * this a read. Creating one here instead would mint it at the moment somebody presses
       * Connect, unnamed for this deployment and invisible in the dashboard until the first person
       * happened to try — and where a config already existed for an app enabled twice, a second
       * one would split one app's connections across two configs, so removing "the" config later
       * would drop half of them.
       *
       * NONE IS A STATE WITH A REMEDY, NOT A NULL TO WORK AROUND. It is the app enabled before
       * this deployment created configs at all, or a config deleted by hand in Composio's
       * dashboard. Neither is something a person pressing Connect can fix, so the sentence names
       * the app and the administrator's step rather than leaving them at a link that would attach
       * their account to a configuration nobody here chose.
       *
       * AND "NONE" MEANS NONE OF OURS, which is the correction. The read used to take whichever row
       * the vendor returned first, so an app whose only config was one an operator built by hand
       * read as ready and this minted somebody's connection against it — scopes this deployment
       * cannot see, tool restrictions it cannot read, and an object it must not delete. A
       * connection is a lasting attachment to whatever config it was made against, so guessing here
       * is not a guess that can be corrected later.
       */
      const { ours, unreadable } = await configsFor(toolkit);
      if (ours.length === 0) {
        /*
         * A ROW THIS FILE COULD NOT READ IS NOT AN APP WITH NO CONFIG, AND THE REMEDIES ARE
         * DIFFERENT PEOPLE'S. The sentence below sends an administrator to remove the app and add
         * it again, which is right where the listing was legible and said there is none of ours —
         * and wrong here, because the row that could not be sorted may BE ours, in which case
         * removing the app meets {@link ComposioBroker.deleteAuthConfig}'s own refusal and adding
         * it again is refused by `ensureAuthConfig` for the same reason. Nobody should be sent
         * round a loop that cannot close.
         *
         * WHAT IS NOT DIFFERENT IS THAT NOTHING IS MINTED. A link is a lasting attachment to one
         * particular config, so a person is never sent anywhere on the strength of a listing this
         * deployment could not read — see {@link readableConfigs}, where a config of OURS that was
         * read is enough to go on whatever else the listing held.
         */
        if (unreadable.length > 0) {
          throw new BrokerRefusalError(
            `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read and none of the rest is one it made, so there is nothing it can show is its own to connect an account against and nobody was sent anywhere. ${VENDOR_SHAPE_REMEDY}`,
            { cause: everyRefusal(unreadable) },
          );
        }
        throw new BrokerRefusalError(
          `This deployment has no authorization config at Composio for ${toolkit}, so there is nothing to connect an account against. An administrator removing the app on its Plugins page and adding it again creates one.`,
        );
      }

      /*
       * A DISABLED CONFIG IS NOT A CONFIG TO CONNECT AGAINST, and it is now visible enough to say
       * so. The listing asks for disabled configs — it has to, or the creation above duplicates one
       * — which means this is the first read that can meet one. A link minted against it does not
       * work, so sending a person to the vendor would spend their consent and end with nothing
       * attached; and nothing they can do from the page they are on changes it, because enabling a
       * config happens in Composio's dashboard.
       *
       * THE FIRST OF SEVERAL, WHICH IS A CHOICE AND NOT AN ACCIDENT. More than one enabled config
       * of ours means a lost enable race, and both are equally ours and equally valid. What
       * mattered about the old "first row" was that the order was the vendor's and the next caller
       * could get a different one; the listing is sorted on the id, so this is the same config for
       * every person and for the removal that later drops all of them.
       */
      const config = ours.find((held) => statusOf(held) === "ENABLED");
      if (!config) {
        /*
         * "DISABLED" IS A CLAIM, AND IT IS ONLY THIS DEPLOYMENT'S TO MAKE WHEN COMPOSIO MADE IT.
         *
         * The test above is `=== "ENABLED"`, so everything that is not that word fell through here
         * — and that is three different states wearing one sentence. A config Composio calls
         * DISABLED is genuinely disabled and the remedy below is genuinely the remedy. A config
         * with no status at all, or one carrying a word this deployment's `@composio/core` has
         * never heard of, is a config whose state is UNKNOWN, and telling an operator it is
         * disabled sends them to a dashboard to enable something that may already be enabled — and
         * where it is, they are left with a page insisting on a fact they can see is false and
         * nothing else to try.
         *
         * BOTH ARE STILL A REFUSAL, WHICH IS THE PART THAT DOES NOT CHANGE. Nothing here mints a
         * link against a config it cannot show is enabled: consent spent against a config that
         * turns out to be disabled attaches nothing and cannot be spent again without asking the
         * person to go round the loop a second time. What the status decides is which sentence a
         * person reads, not whether they are sent.
         *
         * The status is quoted where there is one, for the reason {@link named} gives: it is a
         * closed set of vendor enum names, it carries nobody's data, and it is the one fact an
         * operator can search a dashboard and a changelog for.
         */
        /*
         * `unsettled` RATHER THAN `unreadable`, WHICH IS A RENAME AND ALSO THE THIRD CLAUSE BELOW.
         *
         * This list was called `unreadable` and SHADOWED the one `configsFor` answers — the refusals
         * for rows it could sort into neither pile — for the whole of this block. The two are not the
         * same set and they are not about the same rows: this one holds configs of OURS whose status
         * is a word neither ENABLED nor DISABLED, and the outer one holds rows whose id or name never
         * arrived at all. So the outer set was unreachable from the only place its clause could have
         * been written, and the clause is missing from this refusal while both siblings that collect
         * the same list carry theirs. The identical block in
         * {@link ComposioBroker.connectWithFields} already names its local `unsettled` for exactly
         * this reason, and is the copy this one is now spelled like.
         */
        const unsettled = ours.filter((held) => statusOf(held) !== "DISABLED");
        /*
         * AND THE TWO STATES ARRIVE TOGETHER, SO NEITHER ONE TAKES THE OTHER'S TURN. These were a
         * chain — report the unsettled rows, otherwise report the disabled ones — and the paragraph
         * above says in its own words why that cannot hold: `ours` is a SET, and more than one
         * config of ours is the ordinary outcome of a lost enable race that this method is written
         * around. One DISABLED config beside one carrying a word this deployment's `@composio/core`
         * has never heard of satisfies both conditions, and the chain answered with the unsettled
         * sentence alone — whose only remedy is a package upgrade, which is nobody's act on the page
         * the reader is standing on. The act that would actually have got them connected is enabling
         * the disabled config in Composio's dashboard, and it was withheld because a different row
         * said something unreadable.
         *
         * TWO CLAUSES BECAUSE THEY ARE TWO REMEDIES, in the shape
         * {@link ComposioBroker.deleteAuthConfig} and {@link ComposioBroker.revoke} both use for the
         * same reason. The refusal itself does not move: nothing here mints a link against a config
         * it cannot show is enabled, whichever of the two is true.
         */
        const left: string[] = [];
        const disabled = ours.length - unsettled.length;
        if (disabled > 0) {
          left.push(
            `Composio calls ${disabled} of this deployment's ${ours.length} authorization configs for ${toolkit} disabled, and an administrator can enable it in Composio's dashboard, or remove the app on its Plugins page and add it again.`,
          );
        }
        if (unsettled.length > 0) {
          /*
           * EVERY STATUS THAT WAS ACTUALLY READ, AND NONE OF THEM SPEAKING FOR THE REST. The
           * sentence counted the whole set and quoted `unsettled[0]` — "Composio describes 3 of
           * this deployment's configs as PENDING" is a claim about three rows established of one,
           * and an operator searching their dashboard for the word they were handed would never
           * reach the two that say something else. Each distinct word once, so two configs wearing
           * one status do not read as two findings.
           *
           * AND THE LIST IS BOUNDED, for the reason {@link named} bounds each word. This set is as
           * large as the listing, which is paged; a refusal whose length is decided by how many
           * configs an app has is a refusal nothing downstream can hold.
           */
          const words = [
            ...new Set(unsettled.map((held) => named(held.status))),
          ];
          /*
           * AND THE TAIL COUNTS IN THE NUMBER'S OWN WORDS. "and 1 other words" was the unpluralised
           * spelling, in a sentence whose very next clause conjugates its own verb on the same
           * count — so the one refusal that has to be trusted about an authorization config could
           * not get its own arithmetic to read. See {@link STATUSES_NAMED} for why there is a tail
           * at all.
           */
          const shown = words.slice(0, STATUSES_NAMED);
          const unnamed = words.length - shown.length;
          const said =
            unnamed > 0
              ? `${shown.join(", ")} and ${unnamed} other word${unnamed === 1 ? "" : "s"}`
              : shown.join(", ");
          left.push(
            `Composio describes ${unsettled.length} of this deployment's ${ours.length} authorization configs for ${toolkit} as ${said}, which ${words.length === 1 ? "is" : "are"} neither ENABLED nor DISABLED, so whether a connection begun against one could complete is not something this deployment can tell. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        /*
         * AND THE ROWS NOTHING COULD SORT ARE THE THIRD CLAUSE, WHICH THE SHADOW HAD TAKEN AWAY.
         *
         * A row whose id or name never arrived may BE a config of this deployment's that Composio
         * calls ENABLED, in which case "no config here could be shown to be enabled" is true of what
         * was read and the remedy above it — go and enable the disabled one — is an act against the
         * wrong object, or against nothing at all. It is a third fact about a third set of rows, so
         * it is a third independent clause rather than a chain, for the reason the paragraph above
         * gives: two facts about two different rows cannot take turns.
         */
        if (unreadable.length > 0) {
          left.push(
            `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read, so whether one of THOSE is a config of this deployment's that Composio calls enabled is outside what either reading settles: reading those rows in Composio's own dashboard is what says whether there is one here to connect against at all. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        throw new BrokerRefusalError(
          `No authorization config this deployment holds at Composio for ${toolkit} could be shown to be enabled, so no link was made: consent spent against a config that turns out to be disabled attaches nothing and cannot be spent again without sending this person round the loop a second time. ${left.join(" ")}`,
          unreadable.length > 0
            ? { cause: everyRefusal(unreadable) }
            : undefined,
        );
      }

      /*
       * THE RETURN ADDRESS IS THE WHOLE POINT OF THIS CALL, and it is the caller's rather than
       * this file's: the adapter knows Composio, and where a person belongs afterwards is a fact
       * about this deployment's own pages. It is never logged and never quoted in the refusal
       * below, for the reason the url itself is not.
       *
       * NO `allowMultiple`, WHICH LEAVES THE VENDOR ENFORCING THE RULE THIS DEPLOYMENT ALREADY
       * STATES. One person holds one account per app here, because the call that runs an action
       * names the person and not the account — so with two accounts attached, which mailbox a Bot
       * reads would be Composio's choice and nothing here could say which one it had been. The
       * route refuses a second connection before it ever reaches this method, and that refusal is
       * the sentence a person reads; this is the same rule one layer further down, where the
       * vendor is the only party that can still see an account this deployment's rows have lost
       * track of. `toolkits.authorize` passed `allowMultiple: true` unconditionally — the SDK
       * calls it a "magic function" for exactly that — which is the opposite of what this
       * deployment wants.
       *
       * THE ANSWER IS AN OBJECT BY CONSTRUCTION AND ITS ONE FIELD IS NOT. `link` builds what it
       * returns with `createConnectionRequest(client, response.connected_account_id, INITIATED,
       * response.redirect_url)` inside a try that turns anything thrown into
       * `ComposioFailedToCreateConnectedAccountLink` (`@composio/core` 0.18.1,
       * `src/models/ConnectedAccounts.ts:420-453`), and that builder assembles a literal
       * (`src/models/ConnectionRequest.ts:39-43`). So a refusal for "Composio answered something
       * that is not an object" could not be reached — the vendor either hands over its own object
       * or raises a class {@link vendorRefusal} already translates. What the builder copies across
       * untouched is the url, which is why that is the field still read.
       */
      const request = await askVendor(
        {
          outcome: `this person's connection to ${toolkit} was not begun`,
          app: toolkit,
        },
        () =>
          vendor.connectedAccounts.link(userId, config.id, {
            callbackUrl: returnUrl,
          }),
      );

      const redirectUrl = request.redirectUrl;
      /*
       * PRESENT AND NOT A URL IS THE SHAPE THE ABSENCE GUARD BELOW CANNOT SEE. `!redirectUrl` is
       * false for an object, a number and a list alike, so each of those would be returned as the
       * `redirectUrl: string` this method promises and put in a `Location` header — a page nobody
       * can visit, handed to a person as the consent screen they were sent to.
       */
      if (
        redirectUrl !== undefined &&
        redirectUrl !== null &&
        typeof redirectUrl !== "string"
      ) {
        throw new BrokerRefusalError(
          `Composio sent ${sent(redirectUrl)} where the page to send this person to for ${toolkit} belongs, so nobody was sent anywhere. ${VENDOR_SHAPE_REMEDY}`,
        );
      }
      /*
       * AND THE URL IS THE ONE THAT WAS JUDGED, WHICH IT WAS NOT — the defect {@link textOf} is
       * written against, on the one value in this file that leaves the process in a `Location`
       * header.
       *
       * `!redirectUrl` is false for a string of blank space, so "   " cleared this guard and the
       * shape guard above it and was answered as the `redirectUrl: string` this method promises: a
       * person who pressed Connect is redirected to nothing, having been told they were being sent
       * to the app's own consent screen. And a url that arrived PADDED was handed back with its
       * padding, which is not an address either — the space is percent-encoded or the redirect is
       * refused outright. Every identifier on this path is read through {@link textOf} for exactly
       * this reason; this was the field that was not.
       *
       * THE SHAPE GUARD STAYS AHEAD OF IT, because the two states have different sentences. An
       * object or a number where a url belongs is a vendor change with a package remedy; no url at
       * all is an ordinary fact about an auth scheme, and blank is that fact spelled the other way.
       */
      const page = textOf(redirectUrl);
      if (page === null) {
        /*
         * The SDK spells `redirectUrl` nullable because not every auth scheme has one — an API-key
         * toolkit is connected by typing a secret, not by visiting a page. This deployment's
         * enablement flow sends a person to a url, so no url is nothing to do rather than a
         * success, and the sentence says which app it was about. The url itself is never quoted
         * anywhere, here or elsewhere: whoever opens it attaches an account to this person's
         * connection, so it is handed to the browser that asked and then forgotten.
         */
        throw new BrokerRefusalError(
          `Composio began a connection to ${toolkit} but answered with no page to visit, so there is nothing to send this person to. An app that is connected by entering a credential rather than by visiting a page cannot be connected from here.`,
        );
      }
      return { redirectUrl: page };
    },

    async isConnected({ userId, toolkit }): Promise<boolean> {
      /*
       * A COUNT, AND NOTHING IS READ OFF A ROW TO REACH IT. An ACTIVE account Composio described
       * without an id is still an ACTIVE account: this person can act through the app, which is the
       * whole of what this gate asks. Reading the id here used to turn that into a refusal, so a
       * field this question never looks at decided its answer.
       *
       * AND IT STOPS AT THE FIRST ROW, WHICH IS THE SAME CORRECTION ONE LEVEL OUT. This method
       * answers a boolean, and a boolean settled by page one cannot be improved by page two — but
       * reading on left the answer exposed to three faults that belong to pages nobody needed: a
       * cursor Composio sent as a number, a cursor it repeated, and the fiftieth page of a listing
       * that will not end. Each of those threw at a person whose ACTIVE account had already been
       * found and told them the vendor's shape was wrong, and `store.ts` deletes their connection
       * row on a `false` — so a question that had been answered `true` was made failable by the
       * machinery that made the `false` complete. Paging is still what makes the `false` honest:
       * with no row yet, the next page is the only thing that can settle it, so it is read.
       *
       * ASKED OF EVERY CONFIG, WHICH IS WHERE THIS DIVERGES FROM `revoke` BELOW. A person whose
       * only account for the app sits on a config an operator built by hand can still act through
       * the app — the call that runs an action names the person and the toolkit, not the account —
       * so scoping this to configs of ours would refuse somebody who is, in fact, connected. This
       * method only READS; the one that acts is the one that has to be narrow.
       */
      return (
        (
          await accountsFor(userId, toolkit, CONNECTED, {
            enough: (rows) => rows.length > 0,
          })
        ).length > 0
      );
    },

    async revoke({ userId, toolkit }): Promise<boolean> {
      /*
       * THE ANSWER IS WHAT WAS ASKED FOR, not whether the call threw. `false` here means there was
       * nothing to withdraw, which is what the audit trail's `vendorRevocationRequested` is for: a
       * reader has to be able to tell an account this deployment acted on from one that outlives it
       * somewhere else.
       *
       * ASKED FOR, RATHER THAN DONE, AND THE FIELD IS NAMED FOR THAT. The delete carries
       * `revoke_on_delete`, which is what turns it from a record-keeping soft-delete into an actual
       * withdrawal — and what it starts is a background job the vendor gives no supported way to
       * poll. So the account is gone at the broker by the time this returns and nothing here can
       * call with it again; whether Google has torn up the refresh token happens afterwards. `true`
       * claims exactly that much. See {@link ComposioVendor} for the two declarations this rests on.
       *
       * EVERY ACCOUNT, not the first, and in every state that could still be a grant. One person
       * can hold more than one account for one app — two mailboxes, or a stale account beside a
       * fresh one, or a shared account beside their own — and each of them is access this
       * deployment's calls could run under. See {@link REVOCABLE} for why the listing here is wider
       * than the one behind `isConnected`.
       *
       * AND EVERY ACCOUNT MEANS EVERY ACCOUNT ON A CONFIG THIS DEPLOYMENT MADE, WHICH IS NARROWER
       * THAN WHAT THIS USED TO DELETE. The listing was asked by person, app and "all account
       * types" and by nothing else, so it returned accounts attached to authorization configs an
       * operator built by hand in Composio's dashboard — for purposes this deployment knows nothing
       * about, on scopes it cannot see, and, with `accountType: "ALL"`, including the SHARED ones
       * that other people are acting through. Every one of those was then deleted with
       * `revoke_on_delete`, which tears the grant up at Google or Slack. One person pressing
       * disconnect on their own settings page ended somebody else's integration.
       *
       * WHICH IS THE PRINCIPLE {@link ComposioBroker.deleteAuthConfig} ALREADY STATES, ARRIVING
       * ONE LEVEL DOWN. That method refuses to delete a config it cannot show is this
       * deployment's, on the reasoning that an operator's dashboard work is not ours to destroy —
       * and the accounts hanging off that config are the same work. {@link madeHere} is the only
       * thing that tells the two apart, so it decides both.
       *
       * NOTHING AT ALL IS NOTHING TO WITHDRAW, AND IT IS ANSWERED WITHOUT ASKING. An app Composio
       * holds no configs for never had a connection begun through it — {@link
       * ComposioBroker.authorize} mints every link against a config of this deployment's and
       * refuses where there is none — so there is nothing here that this deployment granted.
       * Answering before the listing is also what keeps the empty filter off the wire; see
       * `authConfigIds` on {@link ComposioVendor} for why an empty one must never be sent.
       *
       * BUT "NOTHING OF OURS" IS NOT THAT STATE, AND ANSWERING `false` TO IT WAS THE SEVENTH ROUTE
       * TO A REVOCATION THAT DID NOT REVOKE. The reasoning above is sound about an app with no
       * configs and cannot tell that app from this one: an operator renames a config in Composio's
       * dashboard — drops the suffix, or edits the app's title past it — and this deployment's own
       * live grants read as somebody else's work. `false` then means "there was nothing to
       * withdraw", `store.ts` writes `vendorRevocationRequested: false` into the audit trail and
       * deletes the `composio_connections` row, and the person's grant stands at Google with
       * nothing in this deployment naming it. The trail records that no withdrawal was even asked
       * for, which is the one direction nobody thinks to check.
       *
       * {@link ComposioBroker.deleteAuthConfig} REFUSES IN EXACTLY THIS STATE, and two halves of
       * one operation cannot disagree about one condition. Its reading is the right one and this is
       * the half that moves: the app's configs are legible, none of them carries the suffix, and
       * nothing in the row says whether that is an operator's own work or ours under a title
       * somebody edited. A refusal leaves the connection row standing, which is what keeps the
       * person's grant findable, and names the same one act in a dashboard that the removal does.
       *
       * `false` STILL MEANS WHAT IT SAID, and now only where it is true: Composio holds nothing for
       * this app, so this deployment granted nothing through it.
       */
      const { held, ours, unreadable } = await configsFor(toolkit);
      if (ours.length === 0 && held.length > 0) {
        /*
         * THE UNREADABLE ROWS TRAVEL WITH THIS SENTENCE RATHER THAN WAITING FOR A PRESS THAT NEVER
         * GETS TO THEM. The refusal below is written for `ours.length === 0 && unreadable.length >
         * 0`, and as a second consecutive throw it is reachable only where `held.length === 0` —
         * so a listing carrying one renamed config AND one row nothing could sort reported the
         * rename alone, and closed by telling this person that renaming it "lets disconnecting
         * again withdraw them". It does not: the account listing is scoped to the configs this
         * method can name, and a row in the other pile is one it never was. The same clause is
         * appended independently to the partial-withdrawal sentence further down, which is the
         * shape this should always have had.
         */
        const alsoUnreadable =
          unreadable.length > 0
            ? ` Composio also described ${unreadable.length} of its ${toolkit} authorization configs in a way this deployment cannot read, so any grant of theirs on one of those is outside the question either reading settles, and renaming the config above is not on its own enough to end everything they hold: reading those rows in Composio's own dashboard is what says whether anything is left.`
            : "";
        throw new BrokerRefusalError(
          `Disconnecting ${toolkit} found none of this deployment's own authorization configs at Composio, and Composio holds ${held.length} for ${toolkit} whose name does not carry ${CONFIG_SUFFIX} — so nothing was withdrawn and this person's access has not ended, rather than their connection being forgotten here while their grant stands. Nothing here can tell one of ours, renamed in Composio's dashboard, from an operator's own work. If it is this deployment's, this person's grants on it are live, and renaming it to end with ${CONFIG_SUFFIX} lets disconnecting again withdraw them. If it is an operator's, this deployment granted nothing through it and only that dashboard can end what it holds.${alsoUnreadable}`,
          unreadable.length > 0
            ? { cause: everyRefusal(unreadable) }
            : undefined,
        );
      }
      /*
       * AND A ROW THAT COULD NOT BE READ IS NOT A ROW THAT IS NOT OURS — the same distinction one
       * field further in. A config whose id or name Composio sent unreadably cannot be put in the
       * account listing's filter, so any grant of this person's sitting on it is invisible to
       * everything below and a `false` would be the same false trail entry as the rename above.
       * Where there IS something of ours it is withdrawn first and this is reported afterwards, for
       * the reason {@link readableConfigs} gives; here there is nothing to withdraw first.
       */
      if (ours.length === 0 && unreadable.length > 0) {
        throw new BrokerRefusalError(
          `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read and none of the rest is one it made, so whether this person holds a grant on one of this deployment's own could not be told and nothing was withdrawn. Their access has not been shown to end. ${VENDOR_SHAPE_REMEDY}`,
          { cause: everyRefusal(unreadable) },
        );
      }
      if (ours.length === 0) return false;
      const accounts = await accountsFor(userId, toolkit, REVOCABLE, {
        configs: ours.map((config) => config.id),
      });
      /*
       * THE READABLE ONES GO FIRST AND THE UNREADABLE ONES ARE REPORTED AFTERWARDS. Reading the ids
       * of all of them before sending any delete is what made one unnameable row a permanent block
       * on a person's disconnect — see {@link withdrawableAccounts}. Partitioning puts the withdrawal
       * back in front of the report, which is the order a person's grants actually need.
       */
      const { ids, nameless } = withdrawableAccounts(accounts, toolkit);

      /*
       * AND NOTHING TO WITHDRAW IS ITS OWN STATE, WHICH IS THE BRANCH EVERY SIBLING OF THIS METHOD
       * HAS AND THIS ONE DID NOT.
       *
       * A config of ours that IS readable, no account of this person's on it, and a row nothing
       * could sort beside it: the partial-withdrawal throw below was what answered, and what it
       * said was "Composio withdrew 0 of this person's 0 accounts for gmail". Both figures are
       * counts of a set nothing measured, in the one sentence a reader is meant to act on, and
       * "withdrew" asserts that a withdrawal happened. None did, and none was there to happen.
       * {@link ComposioBroker.deleteAuthConfig} was corrected for the identical sentence about
       * configs — "removed 0 of this deployment's 0" — and this is that count one listing further
       * in, reached from the other end.
       *
       * STILL A REFUSAL, for the reason that method's branch is one. A grant of this person's may
       * sit on the config behind the row nothing could sort, and the account listing was never
       * scoped to it — so `store.ts` must not delete the row naming which app they connected on the
       * strength of a question nothing asked.
       *
       * THE OTHER HALF OF "NOTHING TO WITHDRAW" IS NOT A REFUSAL AND IS ANSWERED BELOW. Every row
       * legible, none of this person's accounts on any of them, is the ordinary state of a person
       * who is not connected — `false`, which is what the ending of this method already says.
       */
      if (ids.length === 0 && nameless.length === 0 && unreadable.length > 0) {
        throw new BrokerRefusalError(
          `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read, and this person holds no account on any of the ones it could read, so nothing was withdrawn and their access has not been shown to end. Whether they hold a grant on one of THOSE is outside what either reading settles and disconnecting again meets the same answer: reading those rows in Composio's own dashboard is what says whether anything is left. ${VENDOR_SHAPE_REMEDY}`,
          { cause: everyRefusal(unreadable) },
        );
      }

      /*
       * WHAT CAME BACK IS READ, WHICH IS THE HALF THAT USED TO BE MISSING. Not throwing is not the
       * same as having been done: Composio answers a delete with a `success` saying whether it
       * performed one, and a `false` there means the account is still attached and no revocation
       * job was started. It is counted as a refusal — into the same list a thrown vendor error
       * lands in — so that the sentence below reports it as an account that was not withdrawn,
       * which is exactly what it is. See {@link withdrawalDeclined}.
       *
       * INSIDE THE LOOP AND OUTSIDE {@link askVendor}, deliberately. `askVendor` wraps the
       * `await vendor.*` and nothing else, because everything it translates is a fault raised
       * inside the vendor's package; the refusal below is this file's own reading of a reply that
       * arrived intact, and it already carries an authored sentence.
       */
      const refused = await askForEach(ids, async (id) => {
        const answer = await askVendor(
          {
            outcome: `one of this person's ${toolkit} accounts was not withdrawn`,
            app: toolkit,
          },
          () => vendor.connectedAccounts.delete(id, { revoke_on_delete: true }),
        );
        const declined = withdrawalDeclined(answer, toolkit);
        if (declined !== null) throw declined;
      });

      if (refused.length > 0 || nameless.length > 0 || unreadable.length > 0) {
        /*
         * A PARTIAL WITHDRAWAL IS A FAILURE AND NOT A `true`, and the reason is the row this throw
         * protects. `store.ts` revokes and only then deletes the `composio_connections` row, which
         * is the only thing in this deployment that names which app this person connected. Answer
         * `true` here on a partial and that row is deleted, the trail records a disconnection, and
         * the account this call could not end is left live with nothing pointing at it — the exact
         * state the store's revoke-before-delete order exists to make impossible. Throwing leaves
         * the row standing, so pressing disconnect again is a second attempt with everything the
         * first one had, and the accounts already gone are no longer in the listing, so the retry
         * converges rather than repeating.
         *
         * WHICH IS ALSO WHY IT IS NOT A `true` WITH A GRUMBLE. Nothing was disconnected in the
         * sense the person asked about: their app still answers. The count is in the sentence
         * because "some of your accounts were withdrawn" is the one thing a reader cannot work out
         * for themselves, and EVERY refusal the loop met is kept as `cause` for whoever is reading
         * a log rather than a page — see {@link everyRefusal} for why all of them rather than the
         * first, which is what this used to keep.
         *
         * AND THE TWO WAYS A GRANT SURVIVES ARE NOT THE SAME ADVICE. An account Composio refused is
         * one a second press reaches, which is what "disconnecting again" is worth saying about. An
         * account it described with no id is not: the row will be as unnameable next time, so the
         * only honest instruction is the one that does not run through this page at all.
         *
         * WHICH IS WHY THEY ARE TWO INDEPENDENT CLAUSES AND NOT A CHAIN. They were an `if`/`else
         * if`, so one person holding both kinds — a nameless row beside a refused one, which is one
         * listing away from either on its own — was told only that "disconnecting again meets them
         * unchanged". That sentence is true of the row with no id and false of the refused account
         * sitting next to it, and it is the sentence deciding whether they press the button again:
         * the one remedy that would actually have ended the refused grant was withheld by the
         * presence of a row it says nothing about. Two facts about two different accounts cannot
         * take turns. {@link ComposioBroker.deleteAuthConfig} writes the identical pair as two
         * independent `if`s one method up, and the paragraph above already described these as two
         * remedies — the chain was the only thing disagreeing.
         *
         * THE REACHABLE REMEDY GOES FIRST, matching that method's order, because it is the one the
         * reader can act on from the page they are standing on.
         *
         * AND THE DENOMINATOR IS THE ACCOUNTS, NOT THE ROWS. It was `accounts.length`, which is how
         * many rows the listing handed over, and a listing that named one account twice is a
         * listing with more rows than accounts — see {@link withdrawableAccounts}. "Withdrew 1 of
         * this person's 2 accounts" over one account that is gone is a count nothing measured, in
         * the sentence a reader is meant to act on. The two halves this call actually holds are the
         * accounts it could name and the ones it could not, and their sum is the set.
         */
        const accountsHeld = ids.length + nameless.length;
        const left: string[] = [];
        if (refused.length > 0) {
          left.push(
            "Disconnecting again asks only for the accounts that are left.",
          );
        }
        if (nameless.length > 0) {
          left.push(
            `Composio described ${nameless.length} of them with no id at all, so this deployment has no way to name those in a withdrawal and disconnecting again meets them unchanged: removing them in Composio's own dashboard is what ends them.`,
          );
        }
        /*
         * AND A CONFIG ROW THAT COULD NOT BE READ IS ITS OWN CLAUSE, because it is a fact about a
         * different thing from all of the above. Every sentence before this one counts ACCOUNTS
         * that were looked at; this one says that the set of accounts looked at may not have been
         * the set — a config of this deployment's, sitting behind a row whose id or name Composio
         * sent unreadably, is one the listing was never scoped to. The grants already withdrawn
         * stay withdrawn, which is why this arrives after them rather than instead of them.
         */
        if (unreadable.length > 0) {
          left.push(
            `Composio also described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read, so any grant of theirs on one of those was never in the question and disconnecting again meets the same answer: reading those configs in Composio's own dashboard is what says whether anything is left.`,
          );
        }
        throw new BrokerRefusalError(
          `Composio withdrew ${ids.length - refused.length} of this person's ${accountsHeld} accounts for ${toolkit} and their access to it has not been shown to end. ${left.join(" ")}`,
          { cause: everyRefusal([...refused, ...nameless, ...unreadable]) },
        );
      }

      /*
       * THE ACCOUNTS WITHDRAWN, WHICH IS THE SAME NUMBER BY A HONESTER ROUTE. Reaching this line
       * means nothing refused and nothing was nameless, so the rows and the accounts differ only
       * where the listing repeated one — and `true` is a claim about having asked the vendor to
       * withdraw something, which is exactly what `ids` counts.
       */
      return ids.length > 0;
    },

    /**
     * What the app itself says it wants typed in, mapped onto the boxes a form can draw.
     *
     * READ A STEP AT A TIME OFF `unknown`, for the reason every other vendor read here is: the
     * detail's `auth_config_details` is copied across verbatim, so a mode that is not a list and a
     * field row that is not an object are both shapes the wire can send.
     *
     * AND EVERY ONE OF THOSE STEPS REFUSES RATHER THAN ANSWERING `[]`, WHICH IS WHAT
     * {@link unreadableForm} IS FOR AND WHY IT IS ONE SENTENCE FOR ALL OF THEM. `[]` here says one
     * thing and one thing only: this app's scheme publishes nothing to fill in, which is a true
     * thing about a real app. Every step of this read used to answer it for a shape it could not
     * make sense of as well — a `fields` that is not an object, an initiation block that arrived as
     * the rows that used to sit inside it, a `required` that stopped being a list — so an app that
     * asks for nothing and an answer nothing here can open were the same empty form in the browser,
     * and the argument two paragraphs down for why that form must never be drawn applied to both.
     *
     * AND A SCHEME THIS APP NO LONGER PUBLISHES IS A THIRD ANSWER AGAIN, WITH A REMEDY OF ITS OWN.
     * The scheme is the RECORDED one and is never re-derived — that is the whole point of the
     * column, and the store's own column comment says so — so "Composio does not publish this mode
     * for this app" is exactly the drift between the row and the vendor that recording it
     * anticipates, and it used to surface as a form with no boxes in it. A person presses submit
     * on that form, {@link ComposioBroker.connectWithFields} creates a connection
     * carrying no credential at all, Composio answers `ACTIVE` because it does not grade what it is
     * given, and the first call made with the account is what discovers anything is wrong. An empty
     * form is also, from the person's end, a box they cannot fill in. So the two states are told
     * apart here: no such mode refuses and names the recorded one — an administrator's remedy,
     * because the recorded scheme is only theirs to rewrite — while a mode that exists and
     * publishes nothing visible still answers `[]`, and a mode whose published shape cannot be read
     * refuses with the upgrade that is the only thing which fixes a vendor changing shape.
     *
     * REQUIRED AND OPTIONAL IN THAT ORDER, because the order is what a person reads down. The
     * vendor publishes them as two lists and the required ones are the ones that stop the form; a
     * form that interleaved them, or put the optional base-url box above the key, would be asking
     * somebody to hunt for the field they came to fill in.
     */
    async connectionFields({ toolkit, authScheme }): Promise<BrokerField[]> {
      const detail = await askVendor(
        {
          outcome: `what ${toolkit} asks for could not be read, so there is nothing to show`,
          app: toolkit,
        },
        () => vendor.toolkits.retrieve(toolkit),
      );

      /*
       * THE ANSWER IS AN OBJECT BEFORE ANYTHING IS READ OFF IT, and the guard is not ceremony.
       * `("perplexityai").auth_config_details` is `undefined` rather than a throw, so a retrieve
       * that answered a bare string reached the refusal below wearing the sentence about a mode the
       * app has stopped publishing — about an answer that had no app in it at all.
       */
      if (
        typeof detail !== "object" ||
        detail === null ||
        Array.isArray(detail)
      ) {
        throw unreadableForm(
          detail,
          `Composio's own description of ${toolkit}`,
        );
      }

      /*
       * AND THE LIST OF MODES IS THE SAME TWO ANSWERS ONE FIELD IN. An `auth_config_details` that
       * is not a list became no modes at all, and no modes means the recorded one is not among
       * them — so an answer this deployment could not read arrived as the drift the refusal below
       * is written about, with a remedy that cannot work on it.
       */
      const listed = detail.auth_config_details ?? [];
      if (!Array.isArray(listed)) {
        throw unreadableForm(
          detail.auth_config_details,
          `the connection modes ${toolkit} publishes`,
        );
      }

      /*
       * AND A MODE THAT IS NOT A DOCUMENT IS THE SAME TWO ANSWERS ONE STEP FURTHER IN. `("API_KEY")
       * .mode` is `undefined` rather than a throw, so an entry that stopped being an object compared
       * unequal to the recorded scheme exactly as an app that had dropped it would, and the refusal
       * below sent an administrator to remove the app and add it again — against a list whose next
       * reading is the same unreadable shape, so the re-add records the same word and the app comes
       * back refusing identically.
       *
       * AN ENTRY THAT IS ABSENT IS NOT THAT AND IS NOT REFUSED: a hole in the list is a mode the
       * vendor left out, which is simply not the mode being looked for, and the sentence below is
       * the true one about it.
       *
       * AND THE UNREADABLE ONES ARE COLLECTED RATHER THAN THROWN, WHICH IS THE PARTITION-RATHER-
       * THAN-THROW DISCIPLINE THIS FILE ALREADY APPLIES AT {@link readableConfigs} AND
       * {@link withdrawableAccounts}, ARRIVING AT THE ONE READER THAT WAS STILL EAGER. This was a
       * `.map()` that threw, so EVERY entry was validated before `.find()` ever selected the mode
       * being asked for — and one drifted entry anywhere in the list took down a mode that was
       * perfectly readable. An app enabled as `API_KEY` whose retrieve answers
       * `[{ mode: "API_KEY", fields: {…complete…} }, "OAUTH2"]` has an intact mode at index 0 and a
       * bare string at index 1, and everybody pressing Connect on that app was blocked permanently
       * — "no form was drawn … upgrading @composio/core is what fixes it" — over a mode nobody
       * asked about. Nothing they can reach changes the next reading, which is the same shape.
       *
       * SO THE WANTED MODE IS LOOKED FOR FIRST AND THE REST ARE REPORTED ONLY IF IT IS NOT FOUND.
       * Where it is found, an entry this deployment could not read is a mode it was not asked to
       * draw. Where it is NOT found, the unreadable entries are the reason the refusal must not be
       * the drift sentence below: one of them may BE the mode, and telling an administrator the app
       * has dropped it would send them to re-add against a list that reads identically next time.
       */
      const unreadableModes: unknown[] = [];
      let mode: { mode?: unknown; fields?: unknown } | undefined;
      for (const [index, candidate] of listed.entries()) {
        if (candidate === undefined || candidate === null) continue;
        if (typeof candidate !== "object" || Array.isArray(candidate)) {
          unreadableModes.push({ index, candidate });
          continue;
        }
        const entry = candidate as { mode?: unknown; fields?: unknown };
        /*
         * THE MODE IS A SCHEME NAME, SO IT IS THE TRIMMED ONE — the rule {@link labelsOf} states
         * for every other scheme this file reads and the one site that was comparing the raw value.
         * A scheme is the NAME of a flow: it is matched against the word recorded on the app's row
         * when somebody enabled it, so a padded `" API_KEY "` is the app's own mode wearing whatever
         * the wire wrapped it in. Read raw it compared unequal to the recorded word exactly as a
         * mode the app had DROPPED would, and the refusal below then sent an administrator to remove
         * the app and add it again — which records the same padded word and comes back refusing
         * identically, which is a loop that cannot close.
         */
        if (textOf(entry.mode) === authScheme) {
          mode = entry;
          break;
        }
      }

      /*
       * AND A MODE THAT WAS NOT FOUND BESIDE ENTRIES THAT COULD NOT BE READ IS NOT "THE APP DROPPED
       * IT". This is the refusal an eager walk would have raised, reached only where it is the true
       * thing to say: the wanted mode is not among what this deployment CAN read, and what it cannot
       * read is where the answer may be. It is the vendor's shape that changed, so it carries the
       * vendor's remedy rather than the administrator's.
       */
      if (mode === undefined && unreadableModes.length > 0) {
        throw unreadableForm(
          unreadableModes[0],
          `${unreadableModes.length} of the ways of connecting ${toolkit}, one of which may be the ${authScheme} one`,
        );
      }
      /*
       * THE REMEDY IS AN ADMINISTRATOR'S BECAUSE THE RECORDED SCHEME IS ONLY THEIRS TO REWRITE.
       * Nothing a person pressing Connect can do changes which mode this app was enabled as, and
       * nothing on this path may quietly pick a different one — a form drawn for whatever Composio
       * publishes today, in front of an authorization config created for the word on the row, is
       * the same disagreement one layer further in. Removing the app and adding it again is the one
       * path that records the scheme afresh, so it is the one named.
       */
      if (mode === undefined || mode === null) {
        throw new BrokerRefusalError(
          `Composio no longer publishes a ${authScheme} connection for ${toolkit}, and ${toolkit}'s authorization config here was created as ${authScheme}, so there is nothing to ask this person for — and an empty form is a box they cannot fill in and a connection carrying no credential at all. An administrator removing the app on its Plugins page and adding it again is what records the scheme Composio publishes for it now.`,
        );
      }
      /*
       * EVERY REMAINING STEP TELLS AN ABSENCE FROM AN ANSWER IT CANNOT READ, which is the whole of
       * what {@link unreadableForm} is for. A mode that publishes no `fields`, no initiation block
       * or an empty list of rows is saying it asks a person for nothing, and `[]` is the true
       * reading of that. A `fields` that is not an object, an initiation block that arrived as the
       * list of rows that used to sit inside it, and a `required` that stopped being a list are
       * three different vendor changes, none of which is that sentence, and all three used to be
       * written down as it.
       */
      const asked = mode.fields ?? {};
      if (typeof asked !== "object" || asked === null || Array.isArray(asked)) {
        throw unreadableForm(
          mode.fields,
          `the fields ${toolkit}'s ${authScheme} connection publishes`,
        );
      }
      const initiation =
        (asked as { connected_account_initiation?: unknown })
          .connected_account_initiation ?? {};
      if (
        typeof initiation !== "object" ||
        initiation === null ||
        Array.isArray(initiation)
      ) {
        throw unreadableForm(
          (asked as { connected_account_initiation?: unknown })
            .connected_account_initiation,
          `what ${toolkit} asks for when a connection to it is made`,
        );
      }

      /*
       * THE REQUIRED LIST AND THE OPTIONAL ONE ARE ASKED SEPARATELY, because they are separately
       * published and a guard on one says nothing about the other — and the required one is the one
       * that stops a form, so a required list read as empty is a form a person can submit blank.
       */
      const published = initiation as {
        required?: unknown;
        optional?: unknown;
      };
      const rowsOf = (value: unknown, which: "required" | "optional") => {
        const asRows = value ?? [];
        if (!Array.isArray(asRows)) {
          throw unreadableForm(
            value,
            `the ${which} fields ${toolkit} asks a person to fill in`,
          );
        }
        return asRows;
      };
      /*
       * REQUIRED FIRST, WHICH IS AN ORDER RATHER THAN A CONVENIENCE — see the deduplication below,
       * where it is what decides which of two rows sharing a name survives.
       */
      const rows = [
        ...rowsOf(published.required, "required"),
        ...rowsOf(published.optional, "optional"),
      ];

      const drawn = rows
        .filter((row, index) => {
          /*
           * THE ROW IS AN OBJECT BEFORE A FIELD IS READ OFF IT, WHICH IS THE ONE CONTAINER IN THIS
           * FILE THAT WAS NOT ASKED.
           *
           * Every other one is: the catalogue row, its `meta`, each category, the action row, the
           * toolkit detail, the list of modes, the mode itself, the `fields` object and the
           * initiation block inside it. The rows hanging off that block were not, and nothing here
           * throws for it — `("generic_api_key").user_visible` is `undefined`, so a row that arrived
           * as a string passes the visibility read as an ordinary shown field and reaches the type
           * guard below, which refuses it with "Connecting this app is not something this deployment
           * can offer yet". That is a verdict about the APP, it carries no remedy at all, and the
           * thing it describes is a package whose shape moved. The remedy for that is the one
           * {@link unreadableForm} ends every other step of this read with.
           *
           * ABSENT IS NOT EXEMPTED HERE, WHICH IS WHERE THIS DIFFERS FROM THE MODE LIST ABOVE. A
           * hole in THAT list is simply a mode the vendor left out and the `find` below it says the
           * true thing about it; a hole in THIS one is a field the form would silently be one box
           * short of, and there is no reading of `null` under which a person is being asked for
           * nothing in particular.
           */
          if (typeof row !== "object" || row === null || Array.isArray(row)) {
            throw unreadableForm(
              row,
              `field ${index + 1} of what ${toolkit}'s ${authScheme} connection asks a person to fill in`,
            );
          }

          /*
           * A FIELD COMPOSIO HIDES IS ONE COMPOSIO FILLS IN, AND `!== false` HID THE WRONG STATE.
           * An absent `user_visible` means show it, which is most of the catalogue and stays. A
           * present `"false"` is Composio saying the opposite and reading as "show it" — a box
           * drawn for a tenant id or an instance name the person has no way to know, which they
           * then leave blank and submit as an empty value under a key the app does read.
           */
          const visible = flagOf(row?.user_visible, true);
          if (visible === null) {
            throw new BrokerRefusalError(
              `${toolkit} describes ${textOf(row?.displayName) ?? textOf(row?.name) ?? "one of the values it asks for"} with ${sent(row?.user_visible)} where the flag saying whether that field is shown to the person filling the form in belongs. A field Composio hides is one Composio fills in itself, so a flag this deployment cannot read is the difference between a form and a form with a box nobody can answer. ${VENDOR_SHAPE_REMEDY}`,
            );
          }
          return visible;
        })
        .map((row) => {
          /*
           * A TYPE THIS DEPLOYMENT CANNOT DRAW IS A REFUSAL RATHER THAN A TEXT BOX. Every required
           * field measured across the catalogue is a plain string, so this is a guard against the
           * vendor rather than a routine case — and the failure it prevents is somebody typing a
           * path into a box labelled Certificate and being told they are connected.
           *
           * AND THE NAME IS IN THE SAME GUARD, because it is the least guarded field here and the
           * only one that travels. `label`, `help` and `default` all pass through {@link textOf}
           * and are read by a person; the name is sent back to Composio verbatim and is the key
           * {@link ComposioBroker.connectWithFields} spreads into the connection's `val`. Coerced
           * with `String(...)`, a row carrying `type: "string"` and no name drew a box literally
           * called "undefined" and then submitted whatever was typed in it under that key — a value
           * no app reads, in a connection Composio accepts.
           */
          /*
           * AND THE TYPE IS READ THE WAY THE NAME BESIDE IT IS, which is the half this guard did
           * not have. `row.type !== "string"` was the RAW value while the name one line up goes
           * through {@link textOf}, so a padded `" string "` was refused with "a box this
           * deployment can draw is a string" — about a field whose type IS a string, in a sentence
           * whose own words say so. A type is a keyword and not prose: the value is the word, and
           * the padding is whatever the wire wrapped it in.
           */
          const name = textOf(row?.name);
          if (textOf(row?.type) !== "string" || name === null) {
            throw new BrokerRefusalError(
              `${toolkit} asks for ${textOf(row?.displayName) ?? "a value"} as ${sent(row?.type)} under the name ${sent(row?.name)}, which cannot be filled in here: a box this deployment can draw is a string, and a box whose answer can be sent back has a name. Connecting this app is not something this deployment can offer yet.`,
            );
          }

          /*
           * AND ONE NAME IS THE PROTOCOL'S RATHER THAN THE APP'S, WHICH IS THE SAME GUARD ONE STEP
           * FURTHER ON: a box whose answer cannot be sent must not be drawn.
           *
           * {@link ComposioBroker.connectWithFields} puts what somebody types into the `val` of the
           * connection state, beside the `status` that says what is being created — the shape the
           * vendor's own `AuthScheme` builder assembles (`@composio/core` 0.18.1,
           * `src/models/AuthScheme.ts:84-94`). `status` is therefore a word the call itself owns,
           * and BOTH answers to a field published under that name are wrong. Sent, it replaces the
           * state this deployment is asking Composio to create, from a request that looks like an
           * ordinary connection. Withheld — which is what that call now does, writing its own word
           * last — it is a box somebody filled in whose value no app will ever read, the very
           * failure the name guard directly above exists to prevent.
           *
           * SO THE APP IS REFUSED RATHER THAN PART OF ITS FORM, and the sentence names the field,
           * which is the vendor's own text read off the list just fetched and the only thing an
           * administrator can act on.
           */
          if (name === "status") {
            throw new BrokerRefusalError(
              `${toolkit} publishes a field called ${name}, which is the word this deployment uses to tell Composio what state a connection is being created in, so a value typed into it either overwrites that word or is never sent at all. Neither is a box worth drawing. ${VENDOR_SHAPE_REMEDY}`,
            );
          }
          /*
           * THE TRIMMED VALUE IS WHAT REACHES THE FORM, because the trimmed value is what was
           * judged. This tested `textOf(row.default)` and emitted `String(row.default)`, so a
           * default Composio padded passed the test on its trimmed form and arrived in the box with
           * its padding — the same disagreement between guard and return that {@link vendorSentence}
           * was corrected for, one field away from a value somebody then submits as typed.
           */
          const suggested = textOf(row.default);

          /*
           * THE TWO FLAGS THAT DESCRIBE THE BOX ARE READ THE SAME WAY THE TYPE AND THE NAME ARE,
           * AND FOR THE SAME REASON. `row.required === true` and `row.is_secret === true` answered
           * "no" to an absent flag, which is right and is most of the catalogue, and answered "no"
           * to a PRESENT `"true"` as well — the vendor's yes and the vendor's silence collapsed
           * into one value at the point either is acted on.
           *
           * `required` IS THE SHARPER OF THE TWO BECAUSE THE CONNECT ROUTE NOW ENFORCES IT. The
           * guard that refuses a submission omitting a required field reads this boolean and no
           * other, so a vendor publishing `"true"` would make that guard wave through the exact
           * submission it exists to refuse: an account created with the credential missing out of
           * it, which Composio answers `ACTIVE` for because it does not grade what it is given, and
           * which the first tool call is the first thing to notice.
           *
           * `is_secret` IS THE QUIETER ONE AND NOT THE SMALLER ONE. Read as a no, the box for
           * somebody's API key is drawn as ordinary text: typed in plain sight, left on the screen,
           * and offered to whatever fills fields in.
           */
          const required = flagOf(row.required, false);
          if (required === null) {
            throw new BrokerRefusalError(
              `${toolkit} describes ${name} with ${sent(row.required)} where the flag saying whether that field has to be filled in belongs. Read as a no — which is what a value this deployment cannot read would otherwise become — a field ${toolkit} requires is drawn as one a person may leave blank, and what they submit is an account Composio accepts with the credential missing out of it. ${VENDOR_SHAPE_REMEDY}`,
            );
          }

          const secret = flagOf(row.is_secret, false);
          if (secret === null) {
            throw new BrokerRefusalError(
              `${toolkit} describes ${name} with ${sent(row.is_secret)} where the flag saying whether that field holds a secret belongs. Read as a no, the box is drawn as ordinary text, so whatever goes in it — a key, a token — is typed in plain sight and left on the screen. ${VENDOR_SHAPE_REMEDY}`,
            );
          }

          return {
            name,
            label: textOf(row.displayName) ?? name,
            help: textOf(row.description) ?? "",
            required,
            secret,
            ...(suggested === null ? {} : { default: suggested }),
          };
        });

      /*
       * ONE NAME IS ONE BOX, HOWEVER MANY OF COMPOSIO'S LISTS PUBLISHED IT — the half
       * {@link readableConfigs} and {@link withdrawableAccounts} already carry, arriving here a
       * wave late and for a sharper reason than either.
       *
       * THE NAME IS A KEY AND NOT A LABEL. `required` and `optional` are published separately, so
       * nothing at Composio stops one field appearing in both, and concatenated as they arrive that
       * app draws TWO boxes carrying the same name — with different labels, different help and
       * different defaults, because the two rows are different rows. A person fills both in; the
       * form collects what they typed under the field's name; the second box silently overwrites
       * the first, and which of the two values reached the vendor is not recorded anywhere. The
       * same name twice also passes straight through the connect route's published-names check, so
       * nothing downstream is in a position to notice.
       *
       * THE FIRST SIGHTING KEEPS ITS PLACE, as it does for configs and accounts — and here that is
       * a decision as well as a convention, because required is spread first: a name published in
       * both lists is drawn as the REQUIRED one. That is the safe direction. Read as optional, a
       * credential the app cannot do without becomes a box the connect route lets somebody leave
       * blank, and what that makes is the credential-less account that route's required guard
       * exists to refuse.
       */
      /*
       * `drawnNames` RATHER THAN `named`, WHICH IS ONLY A RENAME AND IS WORTH ONE LINE — for the
       * second time in this file, and this one came back through a merge after the first had been
       * diagnosed. This binding shadowed the module helper {@link named} for the whole of this
       * method, so the function every refusal in the file quotes a vendor enum through was
       * unreachable from the one place a new refusal here would reach for it, and an edit that did
       * would have been calling a Set. `resolved.toolkit`'s reader says the same thing about the
       * same word one method up; nothing is wrong today, and the next change to this block is what
       * both renames are for.
       */
      const drawnNames = new Set<string>();
      return drawn.filter((field) => {
        if (drawnNames.has(field.name)) return false;
        drawnNames.add(field.name);
        return true;
      });
    },

    /**
     * One person's account made from what they typed, and the ONE call here that drops its error.
     *
     * THIS IS THE SINGLE PLACE THIS FILE'S CAUSE-CARRYING RULE REVERSES, AND IT SAYS SO ON PURPOSE.
     * The rule the module comment states and every other path keeps is that a vendor error is never
     * logged and always carried as `cause`, precisely because the object holds the request it was
     * made for and whoever is reading a log rather than a page deserves it. On every other call
     * that request is a link mint or a delete. On this one it is somebody's API key: the body below
     * carries the value they pasted into the form, and an `APIError` out of a create carries the
     * body. So the catch reads the vendor's sentence through the one door {@link vendorSentence}
     * owns and then drops the object entirely — not attached, not rethrown, nothing left for a
     * handler further out to serialize.
     *
     * WHAT THAT COSTS IS THE DIAGNOSTIC TRAIL ON THE FLOW PEOPLE MOST OFTEN MISTYPE, AND THE COST IS
     * ACCEPTED KNOWINGLY. A key pasted with a newline, a token from the wrong workspace, a secret
     * for the staging tenant — these are the ordinary failures here, and this leaves nothing behind
     * about any of them. What an operator gets instead is Composio's own sentence and the request
     * id inside it, which is what Composio's dashboard searches on: enough to ask the vendor about
     * that attempt, and not enough to rebuild it here. A `cause` that made the next mistyped key
     * easier to explain would put every correctly typed one in a log for as long as the log is kept.
     *
     * NOT {@link askVendor}, WHICH IS THE SAME DECISION SEEN FROM THE OTHER SIDE. That function is
     * what every other vendor call in this file goes through, and every refusal it builds attaches
     * the original — see {@link vendorRefusal}, where the `cause` is the point. Routing this call
     * through it would be the rule applying here by default, which is the one place it must not.
     *
     * NO VERIFICATION HERE, AND THE ABSENCE IS NOT AN OVERSIGHT. Composio does not grade a submitted
     * key: a connection created with an obviously wrong value comes back `ACTIVE`. Whether the
     * credential works is settled by making a call with it, which is why this answers the
     * `accountId` — so whoever does that can take back exactly the account it made and nothing else.
     * See {@link ComposioBroker.revokeAccount}.
     */
    async connectWithFields({
      userId,
      toolkit,
      authScheme,
      values,
    }): Promise<{ accountId: string }> {
      /*
       * THIS DEPLOYMENT'S OWN CONFIG, FOR THE REASON {@link ComposioBroker.authorize} READS ONE: an
       * account is a lasting attachment to whatever config it was made against, so attaching
       * somebody to an operator's hand-made config — scopes this deployment cannot see, tool
       * restrictions it cannot read, an object it must not delete — is not a guess that can be
       * corrected afterwards.
       */
      const { ours, unreadable } = await configsFor(toolkit);
      if (ours.length === 0) {
        /*
         * A ROW THIS FILE COULD NOT READ IS NOT AN APP WITH NO CONFIG, AND IT IS THE SAME TWO
         * REMEDIES {@link ComposioBroker.authorize} TELLS APART. "Remove the app and add it again"
         * is right where the listing was legible and said none of these is ours, and wrong here:
         * the row that could not be sorted may BE ours, in which case the removal meets
         * {@link ComposioBroker.deleteAuthConfig}'s own refusal and the re-enable meets
         * `ensureAuthConfig`'s. That is an administrator sent round a loop that cannot close, and
         * this method used to hand them exactly that sentence.
         *
         * NO `cause` ON ANY OF THE REFUSALS IN THIS METHOD, which is the local rule rather than the
         * file's. Not one of the four refusals this config read can raise carries a vendor object at
         * all — they are this file's own reading of a listing — but attaching
         * `everyRefusal(unreadable)` here, as `authorize` correctly does, would put an error chain
         * on the one method whose call frame holds somebody's API key, and the whole of this
         * method's doc comment is about not doing that. The count is the finding, and the count is
         * in the sentence.
         */
        if (unreadable.length > 0) {
          throw new BrokerRefusalError(
            `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read and none of the rest is one it made, so there is nothing it can show is its own to connect an account against and what was typed into the form was not sent anywhere. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        throw new BrokerRefusalError(
          `This deployment has no authorization config at Composio for ${toolkit}, so there is nothing to connect an account against and nothing was sent. An administrator removing the app on its Plugins page and adding it again creates one.`,
        );
      }

      /*
       * THE ENABLED ONE, WHICH IS THE SAME CHOICE {@link ComposioBroker.authorize} MAKES AND FOR ONE
       * REASON MORE. `configsFor` lists with `showDisabled: true` — it has to, or `ensureAuthConfig`
       * creates a second config beside one it cannot see — so `ours[0]` could perfectly well be a
       * DISABLED config, and an account created against one cannot work. Reading that state only
       * after the create is the wrong order on this path more than on any other: the body of that
       * request is the key somebody just pasted in, so the refusal has to arrive BEFORE the
       * credential leaves this process rather than after Composio has been handed it and declined.
       *
       * AND IT IS THE SAME CONFIG THE CONSENT PATH WOULD HAVE PICKED, which is the other half.
       * Two configs from a lost enable race, the first of them disabled, and `ours[0]` against
       * `find(ENABLED)` attach one app's accounts to two different configs depending on which door
       * a person came through — after which removing "the" config drops half of them.
       */
      const config = ours.find((held) => statusOf(held) === "ENABLED");
      if (!config) {
        /*
         * "DISABLED" IS ONLY THIS DEPLOYMENT'S CLAIM TO MAKE WHEN COMPOSIO MADE IT, for the reason
         * spelled out at length in {@link ComposioBroker.authorize}: the test above is
         * `=== "ENABLED"`, so a config with no status and a config wearing a word this deployment's
         * `@composio/core` has never heard of both fall through here, and telling an operator those
         * are disabled sends them to enable something that may already be enabled.
         */
        /*
         * AND TWO INDEPENDENT CLAUSES FOR THE REASON {@link ComposioBroker.authorize} GIVES AT
         * LENGTH, which is worth repeating here only because this block is a COPY of that one rather
         * than a call to it: the chain lived in both methods, so the suppression did too. A person
         * typing their key into an app holding one DISABLED config beside one unsettled row was told
         * to upgrade a package — while the act that would have got the key accepted, enabling the
         * disabled config in Composio's dashboard, went unsaid. It is not even that person's act,
         * which is exactly why the sentence has to carry it rather than choose.
         */
        const unsettled = ours.filter((held) => statusOf(held) !== "DISABLED");
        const left: string[] = [];
        const disabled = ours.length - unsettled.length;
        if (disabled > 0) {
          left.push(
            `Composio calls ${disabled} of this deployment's ${ours.length} authorization configs for ${toolkit} disabled, and an administrator can enable it in Composio's dashboard, or remove the app on its Plugins page and add it again.`,
          );
        }
        if (unsettled.length > 0) {
          const words = [
            ...new Set(unsettled.map((held) => named(held.status))),
          ];
          /*
           * AND THE TAIL COUNTS IN THE NUMBER'S OWN WORDS. "and 1 other words" was the unpluralised
           * spelling, in a sentence whose very next clause conjugates its own verb on the same
           * count — so the one refusal that has to be trusted about an authorization config could
           * not get its own arithmetic to read. See {@link STATUSES_NAMED} for why there is a tail
           * at all.
           */
          const shown = words.slice(0, STATUSES_NAMED);
          const unnamed = words.length - shown.length;
          const said =
            unnamed > 0
              ? `${shown.join(", ")} and ${unnamed} other word${unnamed === 1 ? "" : "s"}`
              : shown.join(", ");
          left.push(
            `Composio describes ${unsettled.length} of this deployment's ${ours.length} authorization configs for ${toolkit} as ${said}, which ${words.length === 1 ? "is" : "are"} neither ENABLED nor DISABLED, so whether an account connected against one could work is not something this deployment can tell. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        /*
         * AND THE ROWS NOTHING COULD SORT ARE THE THIRD CLAUSE, for the reason
         * {@link ComposioBroker.authorize} gives beside the identical one: a row whose id or name
         * never arrived may be a config of this deployment's that Composio calls ENABLED, so the
         * dashboard reading is a finding this sentence has and the disabled clause does not carry.
         * No `cause`, which is this method's own standing rule — the count is the finding and the
         * count is in the sentence, because the call frame this refusal is raised in holds somebody's
         * API key.
         */
        if (unreadable.length > 0) {
          left.push(
            `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read, so whether one of THOSE is a config of this deployment's that Composio calls enabled is outside what either reading settles: reading those rows in Composio's own dashboard is what says whether there is one here to connect against at all. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        throw new BrokerRefusalError(
          `No authorization config this deployment holds at Composio for ${toolkit} could be shown to be enabled, so nothing was sent and what was typed into the form did not leave this deployment. ${left.join(" ")}`,
        );
      }

      let created: { id?: unknown };
      try {
        created = await vendor.connectedAccounts.create({
          auth_config: { id: config.id },
          connection: {
            user_id: userId,
            /*
             * THE SCHEME AND THE TYPED VALUES, IN THE SHAPE THE VENDOR'S OWN BUILDER ASSEMBLES.
             * `AuthScheme.APIKey` and its siblings all return `{ authScheme, val: { status:
             * ACTIVE, ...fields } }` (`@composio/core` 0.18.1, `src/models/AuthScheme.ts:84-94`),
             * and the field NAMES are Composio's own — published per app by
             * {@link ComposioBroker.connectionFields} and sent back verbatim, because a name this
             * file renamed on the way through is a box somebody filled in that no app ever reads.
             *
             * AND `status` IS THE PROTOCOL'S WORD, SO IT IS WRITTEN LAST. The vendor's builder
             * spreads the fields OVER it, which is safe only while no field is called `status` —
             * and the names in `values` are the vendor's own, so that is a fact about somebody
             * else's catalogue rather than an invariant of this call. Spread first and set after,
             * the one word saying what this request is asking Composio to create cannot be
             * displaced by a value arriving under the same name, whatever published it.
             *
             * WHICH IS THE SECOND OF TWO GUARDS AND NOT THE ONLY ONE. {@link
             * ComposioBroker.connectionFields} refuses to draw a box named `status` at all, so a
             * value under that name cannot come from a form, and the connect route sends only names
             * that list published. This method is callable without either, and what it protects is
             * the one field here that cannot be recovered from anything else in the request.
             */
            state: {
              authScheme,
              val: { ...values, status: "ACTIVE" },
            },
          },
        });
      } catch (error) {
        /*
         * ONLY THE SENTENCE LEAVES THIS BLOCK. `vendorSentence` is the one door in this deployment
         * for reading a vendor's own words, and reading it is the whole of what `error` is used
         * for: it is not attached, not rethrown and not named below this line.
         */
        const said = vendorSentence(error);
        throw new BrokerRefusalError(
          said === null
            ? `Composio did not accept the connection to ${toolkit} and said nothing this deployment can pass on. The failure arrived through this deployment's @composio/core with no sentence of Composio's on it, which is what an outage, a cancelled request and a reply the package could not read all look like from here — and the failure itself was dropped rather than recorded, because on this one call the object carrying it also carries what was typed into the form. Nothing was attached. Composio's own dashboard logs the attempt, and asking again is what settles whether the request ever landed.`
            : `Composio refused the connection to ${toolkit}: ${said} Nothing was attached. Nothing further about this attempt is kept here, because what the failure carried was the value typed into the form — the request id in Composio's own words above is what their dashboard searches on.`,
        );
      }

      /*
       * NO ID IS NOT A CONNECTION, HOWEVER THE REPLY READS. The id is the whole of what this method
       * answers and the only thing a caller can undo its own work with, so handing back an
       * `undefined` cast to a string would leave an account standing at Composio that nothing on
       * this deployment can name, made from a credential somebody typed a moment ago. The dashboard
       * is named because it is the only place that account can now be seen and removed.
       */
      const accountId = textOf(created?.id);
      if (accountId === null) {
        throw new BrokerRefusalError(
          `Composio answered the connection to ${toolkit} with no account id, so this deployment cannot name the account it just asked for and cannot take it back. An account may be standing at Composio over this: ${toolkit} in Composio's own dashboard is where it can be seen and removed. ${VENDOR_SHAPE_REMEDY}`,
        );
      }

      return { accountId };
    },

    /**
     * ONE account ended by id, and NOT {@link ComposioBroker.revoke}, which is the whole decision.
     *
     * `revoke` ends every account a person holds for an app. That is right for what it serves — a
     * person ending their access, where any account left behind is access that still answers — and
     * it is wrong for a verification undoing what it just made. The two read identically right up
     * until the local row and Composio have drifted apart, and that is precisely the state a failed
     * verification stands in: a connection that was working, a second account just created from a
     * key that does not work, and a sweep that takes down both. So this method is handed the id and
     * nothing else — nothing is listed, nothing is matched, and no account it was not given can be
     * reached from here.
     *
     * WITH `revoke_on_delete`, FOR THE REASON {@link ComposioVendor}'s `delete` GIVES AND ONE MORE
     * OF ITS OWN. Without the flag the account stops being visible to this deployment and the
     * credential at the far end stands; here that credential is one somebody typed into a form
     * minutes ago, into a page that is about to tell them the connection was not kept.
     *
     * NOTHING IS ANSWERED AND NOTHING IS SWALLOWED. There is no count to report — the id names one
     * account that existed moments ago — so a failure is a failure, and it leaves through
     * {@link askVendor} like every other vendor call in this file.
     *
     * AND "I DID NOT DELETE IT" IS ONE OF THOSE FAILURES, WHICH THE AWAIT USED TO DISCARD. The
     * delete answers `{ success?: unknown }` for the reason {@link ComposioVendor}'s declaration
     * gives: a 200 carrying `success: false` is Composio saying it did NOT delete the account, so
     * no revocation was started and nothing was asked of the provider — the same lie
     * {@link withdrawalDeclined} exists to stop one method away. It matters MORE here than there,
     * because of what this call's caller does with a clean return. The verification step withdraws
     * the account behind a key that failed, and where the withdrawal ITSELF fails it writes the row
     * unverified so the account stays reachable and disconnectable. A `success: false` resolving
     * normally takes the other branch: no row is written, and what is left standing is a live
     * account holding a working-or-not credential that nothing on any screen names and nobody can
     * press disconnect on.
     *
     * ITS OWN SENTENCES RATHER THAN {@link withdrawalDeclined}'s, because that function's two are
     * written around a toolkit and around pressing disconnect again, and this method has neither: it
     * was handed an id, the app is the caller's to name, and the second press it would invite is a
     * button that is not on any page for an account no row points at. What carries across unchanged
     * is the null/undefined exemption — a 204 or a body of content-length zero is the vendor saying
     * it DID delete and having nothing to add, and reading those as a refusal is the same lie
     * pointing the other way.
     */
    async revokeAccount(accountId): Promise<void> {
      const answer = await askVendor(
        {
          outcome:
            "the one account this call was handed was not withdrawn and may be standing at Composio",
          /*
           * NO APP IN THE QUESTION, which is what the id being the whole of it means. The caller
           * holds the toolkit it connected and can say it; this call was given an account.
           */
          app: null,
        },
        () =>
          vendor.connectedAccounts.delete(accountId, {
            revoke_on_delete: true,
          }),
      );

      if (answer === null || answer === undefined) return;
      /*
       * AND A REPLY THAT IS NOT A DOCUMENT IS NOT A DOCUMENT WITH ITS VERDICT MISSING, which is the
       * distinction {@link withdrawalDeclined} draws one method away and for the same reason. The
       * generated client parses the body and hands it over, so a bare string or a list reaches this
       * read; `("deleted").success` is `undefined`, and the last refusal below then reported a reply
       * with one field absent about an answer that held no reply at all.
       */
      if (typeof answer !== "object" || Array.isArray(answer)) {
        throw new BrokerRefusalError(
          `Composio sent ${sent(answer)} where its reply to the withdrawal of the account this connection just made belongs, so there is no field in it saying whether the account was deleted at all. This deployment cannot tell a withdrawal that happened from one that did not, so the account is reported as still standing and the credential behind it as not withdrawn. ${VENDOR_SHAPE_REMEDY}`,
        );
      }
      const verdict = (answer as { success?: unknown }).success;
      if (verdict === true) return;
      if (verdict === false) {
        throw new BrokerRefusalError(
          `Composio answered the withdrawal of the account this connection just made with success: false, so it did not delete the account and started no revocation of the credential behind it. That account is still standing at Composio and the credential behind it is still live there.`,
        );
      }
      throw new BrokerRefusalError(
        `Composio sent ${sent(verdict)} where its verdict on the withdrawal of the account this connection just made belongs, and that field is the only thing in the reply that says whether the account was deleted at all. This deployment cannot tell a withdrawal that happened from one that did not, so the account is reported as still standing and the credential behind it as not withdrawn. ${VENDOR_SHAPE_REMEDY}`,
      );
    },
  };

  return { actions, broker };
}

/**
 * The lines that turn this deployment's API key into a vendor client.
 *
 * Most of what this file decides lives in {@link buildComposioClient}, and this one used to say it
 * therefore had "no decision worth testing". That sentence was wrong twice over and both times in
 * the same way: this is where the SDK's DEFAULTS are accepted or refused, and a default accepted by
 * omission looks exactly like a default nobody thought about. It cost the two deletes their
 * `revoke_on_delete` once — see the describe about which delete the vendor carries — and it left
 * the construction literal below unpinned, so that deleting a line from it phoned out on boot and
 * broke no test. Both are now asserted; the construction literal carries its own note.
 *
 * The key is a parameter here and a private field of the vendor's client thereafter, and no path
 * out of this module carries it — see the module comment. That is also why this returns the seam
 * rather than the vendor: handing `composio` back would put the key on an object any caller could
 * read, so the construction below is asserted by what it DOES, not by a config object a test could
 * inspect.
 *
 * IT IS NO LONGER ONE LINE, AND THE REASON WAS THE TWO DELETES AND IS NOW ALSO THE TWO LISTINGS.
 * `Composio` used to satisfy {@link ComposioVendor} whole, passed straight in. It cannot any more,
 * for two separate faults in the same wrapper. Its own `authConfigs.delete` and
 * `connectedAccounts.delete` send a hard-coded empty body and therefore cannot ask for the upstream
 * revocation, which is the difference between ending somebody's access and filing it away. And its
 * `tools.getRawComposioTools` and `toolkits.get` cannot be paged — one takes no cursor, the other
 * drops the response's — which is the difference between a catalogue and the first thousand rows
 * of one, and which showed an operator an empty app picker. The underlying `@composio/client`
 * answers all four, so those members are satisfied from `getClient()` and the rest from the SDK's
 * own models. A wrapper per member rather than a spread, so that the arrow's own type checks
 * against the shape above — a vendor method whose signature drifted would fail here rather than at
 * the call site.
 *
 * NO NEW IMPORT, WHICH IS WHY THE ONE-IMPORT-SITE RULE SURVIVES THIS. `getClient()` is public on the
 * SDK's own object and the client's types are inferred from it; `@composio/client` is not named
 * anywhere under `server/src`, so a version bump still has exactly this file to be read against.
 */
export function createComposioClient(apiKey: string): {
  actions: ComposioActions;
  broker: ComposioBroker;
} {
  /*
   * THREE ENTRIES, EVERY ONE OF THEM LOAD-BEARING, AND ALL THREE PINNED BY A TEST. What this
   * literal settles is what a boot of this server is allowed to do before it has served anything:
   * which host the key goes to, whether a third party hears about the start-up, and whether a
   * vendor library gets a say in how the process shuts down. Those are deployment facts, not
   * style, and none of them was visible to a test until one was written for them — see
   * `server/tests/composio-adapter.test.ts`, "what constructing the vendor is allowed to do on
   * boot", which watches a stubbed transport and a stubbed `process.on` and fails if any line here
   * is deleted or flipped. Read that test before changing anything below.
   *
   * `apiKey` DOES NOT FAIL WHEN DROPPED, IT FALLS BACK. `getSDKConfig` reads `COMPOSIO_API_KEY`
   * out of the environment and then `api_key` out of `~/.composio/user_data.json`
   * (`@composio/core` 0.18.1, `src/utils/sdk.ts:42-52`), so a literal that lost this line would go
   * on working against whichever account the machine was last logged into, with the configured
   * `config.composioApiKey` silently unused. `baseURL` is deliberately NOT passed for the same
   * reason read the other way: the default is `https://backend.composio.dev`
   * (`src/utils/constants.ts:7`), and the test asserts the origin every request actually goes to,
   * so adding one here is a change that has to be argued for rather than one that slips in.
   */
  const composio = new Composio({
    apiKey,
    /*
     * TRACKING OFF DOES TWO THINGS, AND THE SECOND IS THE ONE THAT IS HARD TO UNDO. It defaults to
     * TRUE (`src/utils/config-defaults/ConfigDefaults.node.ts:5`), and a true value runs
     * `telemetry.setup()` (`src/composio.ts:380-390`). That POSTs an `SDK_INITIALIZED` metric to
     * `https://telemetry.composio.dev/v1/metrics/invocations`
     * (`src/services/telemetry/TelemetryService.ts:4,38-46`) — a third party's analytics, which
     * the operator of a self-hosted install never opted into. And, before that, it installs THREE
     * process-level listeners — `beforeExit`, `SIGINT` and `SIGTERM`
     * (`src/telemetry/Telemetry.ts:66,315-356`) — whose signal handlers flush telemetry, then
     * `removeListener` and `process.kill(process.pid, signal)` to re-raise. Blocking the egress
     * would not undo that half: it would leave a vendor library between an operator's Ctrl-C, or a
     * container runtime's SIGTERM, and this server's exit.
     */
    allowTracking: false,
    /*
     * AND THE BOOT MUST NOT DEPEND ON THE VENDOR'S RELEASE FEED. This defaults to FALSE
     * (`src/composio.ts:113-120`), and a falsy value runs `checkForLatestVersionFromNPM`
     * (`src/composio.ts:399-402`), which fetches `https://registry.npmjs.org/@composio/core/latest`
     * (`src/utils/version.ts:41-43`) as the client is constructed.
     */
    disableVersionCheck: true,
    /*
     * NOTHING ELSE IS PASSED, AND THE REST OF `ComposioConfig` IS ACCEPTED AS IT COMES, which is
     * safe only because of where each default lands — recorded here so the next reader does not
     * have to re-derive it.
     *
     * `dangerouslyAllowAutoUploadDownloadFiles` defaults OFF (`ConfigDefaults.node.ts:4`) and is
     * the premise `./composio`'s file filter is written on; that filter drops every action whose
     * schema stages a file under EITHER setting, so the premise is defended by a tested guard
     * rather than by this literal, and turning the flag on here would be a change to make against
     * that filter. `sensitiveFileUploadProtection`, `fileUploadPathDenySegments`, `fileUploadDirs`
     * and `fileDownloadDir` only bear on uploads and downloads that the same filter means never
     * happen. `provider` defaults to the SDK's `OpenAIProvider`, which this adapter never asks to
     * format anything — every read here goes through the raw client or the SDK's own models.
     * `host` and `defaultHeaders` are telemetry and header cosmetics, and telemetry is off above.
     * `toolkitVersions` defaults to "latest", which is the literal every listing in this file
     * already passes explicitly; see {@link ComposioVendor.tools.list}.
     */
  });
  const client = composio.getClient();

  return buildComposioClient({
    tools: {
      // The listing is the raw client's because the wrapper has no cursor; the single-tool read and
      // the execute stay the SDK's, because both are one call about one action and neither pages.
      list: (query) => client.tools.list(query),
      getRawComposioToolBySlug: (slug, options) =>
        composio.tools.getRawComposioToolBySlug(slug, options),
      execute: (slug, body) => composio.tools.execute(slug, body),
    },
    toolkits: {
      list: (query) => client.toolkits.list(query),
      retrieve: (slug) => client.toolkits.retrieve(slug),
    },
    authConfigs: {
      list: (query) => composio.authConfigs.list(query),
      create: (toolkit, options) =>
        composio.authConfigs.create(toolkit, options),
      delete: (id, params) => client.authConfigs.delete(id, params),
    },
    connectedAccounts: {
      list: (query) => composio.connectedAccounts.list(query),
      link: (userId, authConfigId, options) =>
        composio.connectedAccounts.link(userId, authConfigId, options),
      /*
       * The create is the raw client's for a third reason of its own: the SDK's wrapper over this
       * endpoint is `initiate`, which is retired for the managed-auth path, and `link` above — its
       * replacement — mints a consent url and has nowhere to put a value a person typed.
       *
       * THE ONE ASSERTION IN THIS FUNCTION, AND IT IS ABOUT `state` ALONE. The generated client
       * declares that field as a fourteen-member union keyed on the scheme, each member's `val`
       * ending in `[k: string]: unknown` — which is to say the vendor's own type admits any object
       * once the scheme is picked, and picking it here would be this file asserting which boxes an
       * app asks a person for. {@link ComposioVendor} therefore says `unknown` and the widening is
       * spent here, at the one line where this deployment's projection meets the vendor's schema
       * and nothing else is decided.
       */
      create: (body) =>
        client.connectedAccounts.create(
          body as Parameters<typeof client.connectedAccounts.create>[0],
        ),
      delete: (id, params) => client.connectedAccounts.delete(id, params),
    },
  });
}
