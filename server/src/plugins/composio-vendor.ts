import {
  BrokerAccountGoneError,
  BrokerAccountHeldError,
  type BrokerApp,
  type BrokerConnection,
  BrokerRefusalError,
  type FieldScheme,
  flagOf,
  isFieldScheme,
} from "./broker";
import { type ComposioAction, vendorSentence } from "./composio";
import type { AccountRef } from "./shared-accounts";

/**
 * What Composio's API hands back, and how it is read: the vendor shapes, the parsers that turn a
 * response into OpenBot's own types, paging, and the mapping from a vendor's refusal to a sentence.
 *
 * Split out of `./composio-adapter`, which keeps the SDK client and the methods it is called
 * through. Nothing here imports `@composio/core`: these read plain objects, so they are exercised
 * with literals, and the adapter remains the one file under `server/src` that imports the SDK.
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
export type VendorTool = {
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
export type VendorToolRow = {
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
export type VendorToolkit = {
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
export type VendorToolkitDetail = {
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
export type VendorAuthConfig = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  /**
   * What the config was created to ask for, where Composio publishes it, and `unknown` because it
   * is copied across verbatim like the three above.
   *
   * IT IS A PROPERTY OF THE CONFIG RATHER THAN OF AN ACCOUNT, which is the whole of why
   * {@link ComposioBroker.grantsFor}'s answer is one state for a toolkit: the scope set is fixed
   * when the config is created and every account connected against it holds exactly that set.
   */
  scopes?: unknown;
};

/**
 * One connected account as the listing hands it over, narrowed to the fields this file reads.
 *
 * `id` and `data` are read by the withdrawal and by {@link ComposioBroker.accountName}.
 * `authConfig` is read by {@link ComposioBroker.grantsFor} alone, for the id of the config the
 * account was minted against, because that config — and no other — fixes the scopes the account
 * holds. `transformConnectedAccountResponse` builds it on every row from the raw
 * `auth_config` (`@composio/core` 0.18.1, `src/utils/transformers/connectedAccounts.ts:55-62`), and
 * it is `unknown` for the reason every other field here is: the transform is warn-only.
 */
export type AccountRow = { id?: unknown; data?: unknown; authConfig?: unknown };

/**
 * The id of the auth config one account was minted against, or null where Composio did not name it.
 *
 * NULL RATHER THAN A REFUSAL, BECAUSE ITS ONE READER REPORTS RATHER THAN ACTS — the reasoning of
 * {@link scopesOf}, one field along. An account whose config cannot be named is still an account,
 * and what is lost is only the description of what it holds.
 */
export function configIdOf(row: AccountRow): string | null {
  const config = row.authConfig;
  if (!config || typeof config !== "object") return null;
  return textOf((config as { id?: unknown }).id);
}

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
export type VendorAccountStatus =
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
export const VENDOR_SHAPE_REMEDY =
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
export function sent(value: unknown): string {
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

export function named(value: unknown): string {
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
export function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * Who an error sentence is about, named the way the holder it acts for would read it.
 *
 * A DEPLOYMENT HOLDS NO "PERSON" TO BE TOLD ABOUT. The sentences below were all written for a
 * person pressing Connect or Disconnect on their own settings page, and every one of them says so
 * in the words "this person" — which is simply wrong where the account acted for is the
 * deployment's own shared one, with nobody's personal credential anywhere behind it.
 */
export const whose = (account: AccountRef) =>
  account.holder === "deployment"
    ? "this deployment's shared account"
    : "this person";

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
export type Listing = {
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
export async function everyRowOf<Row>(
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
export async function pageOf<Row>(
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
export function unreadableForm(
  was: unknown,
  where: string,
): BrokerRefusalError {
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
export function appOf(row: VendorToolkit, position: number): BrokerApp {
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
    /*
     * THREE EXPLICIT NULLS, AND NEVER `?? 0`. Composio's toolkit listing publishes no behaviour
     * classification and no per-action scope sets, so this deployment has not measured them here —
     * which is a different fact from having measured them and found none. A zero would say the
     * second, and the page would fire its coverage warning on every Composio app: a false alarm at
     * exactly the moment somebody is deciding whether to trust one. See {@link BrokerApp}.
     */
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
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
export type CheckedAuthConfig = {
  id: string;
  name: string;
  status: unknown;
  /** The scope set this config was created with, as {@link scopesOf} could read it. */
  scopes: string[];
};

/**
 * The scope names on an auth config row, and the EMPTY LIST for everything else.
 *
 * NOT A REFUSAL, BECAUSE ITS ONE READER REPORTS RATHER THAN ACTS. Every other field this file
 * reads off a config decides something destructive or something a person is sent through — which
 * id to delete, which config to mint a consent against — so a shape that cannot be read is a thing
 * to stop on. Scopes are carried on a {@link GrantState}, which is a description handed to a page:
 * Composio publishes none at all for a key-scheme config, so "no scope set published" is the
 * ordinary case and not a fault, and an app somebody is plainly connected to must not become
 * unreportable because the field arrived as a string.
 *
 * ONE PASS, AND THE NON-STRINGS ARE DROPPED RATHER THAN RENDERED. A scope is a name sent to a
 * provider; `String({})` is not one, and a list half of whose entries were invented here is worse
 * than a shorter list.
 */
function scopesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const name = textOf(entry);
    if (name !== null) names.push(name);
  }
  return names;
}

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
export function statusOf(config: CheckedAuthConfig): string | null {
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
export function readableConfigs(
  rows: VendorAuthConfig[],
  toolkit: string,
): { configs: CheckedAuthConfig[]; unreadable: BrokerRefusalError[] } {
  /*
   * ONE SLOT PER CONFIG, HOLDING WHICHEVER COPY OF IT COULD BE READ.
   *
   * ONE ID IS ONE CONFIG HOWEVER MANY TIMES THE LISTING NAMED IT, and the invariant is about the
   * CONFIG rather than about the first row that happened to mention it. Two orderings of one
   * repeated id therefore have to answer the same, and the previous shape — dedup on first
   * sighting, then read the name — answered them differently: good copy first and unreadable
   * repeat second was right, unreadable copy first and good copy second claimed the id for the
   * unreadable one and the readable copy returned at the dedup test, so the config never reached
   * `configs` at all. `deleteAuthConfig` then left standing a config the other ordering would have
   * deleted.
   *
   * THE POSITION IS THE FIRST SIGHTING'S AND THE VERDICT IS THE BEST COPY'S, which is what a slot
   * buys over a `Set`: a later readable copy REPLACES an unreadable one in place, so neither the
   * order two callers see nor the count of what could not be read depends on which copy the paging
   * happened to hand over first. A readable copy is never replaced — a second reading of a config
   * this deployment has already read tells it nothing new.
   *
   * A ROW WITH NO ID HAS NO SLOT TO SHARE, because the id is the whole of what identifies a config:
   * two id-less rows are two rows nothing can say are one, so each keeps its own place in the list
   * and its own refusal.
   */
  const settled: (CheckedAuthConfig | BrokerRefusalError)[] = [];
  const slotOf = new Map<string, number>();

  rows.forEach((row, position) => {
    const at = `row ${position + 1} of Composio's authorization configs for ${toolkit}`;

    const id = textOf(row.id);
    if (id === null) {
      settled.push(
        new BrokerRefusalError(
          `Composio sent ${sent(row.id)} where the id of ${at} belongs, and the id is the whole of what a deletion names. Nothing was sent for that row, because a delete without one asks Composio to remove whatever it cares to while this deployment records that the app was withdrawn. ${VENDOR_SHAPE_REMEDY}`,
        ),
      );
      return;
    }

    /*
     * THE ID IS READ FIRST AND THE SLOT IS FOUND BEFORE ANYTHING ELSE IS ASKED OF THE ROW.
     *
     * A repeat whose verdict is already settled readable is dropped here, which is the half that
     * was already right: the listing repeating `ac_1` across a page boundary can perfectly well
     * hand the repeat over as `{ id: "ac_1", name: null }` — a rename in flight in the dashboard,
     * or a proxy stitching two partial reads — and counting that as a config this deployment could
     * not read cost a refusal AFTER THE WORK WAS ALREADY DONE. `configs` held the one readable
     * `ac_1` and `unreadable.length` was 1, so `deleteAuthConfig` and `revoke` — which both act on
     * what they can name and then report the rest — deleted the config, succeeded, and THEN threw
     * "…and the app has not been fully withdrawn", over a config that was already gone.
     * `removeServer` therefore left the app's row standing behind a completed removal.
     */
    const slot = slotOf.get(id);
    if (slot !== undefined && !(settled[slot] instanceof BrokerRefusalError)) {
      return;
    }

    const name = textOf(row.name);
    if (name === null) {
      // The first copy of this id that could not be read keeps the slot; a second one adds nothing
      // to what a caller can act on and would count one config twice.
      if (slot === undefined) {
        slotOf.set(id, settled.length);
        settled.push(
          new BrokerRefusalError(
            `Composio sent ${sent(row.name)} where the name of ${at} belongs, and the name is the only thing that says whether this deployment made a config or an operator built it by hand in Composio's dashboard. Neither guess is safe: one splits this app's connections across two configs, and the other deletes a config nobody here chose along with every account connected against it. ${VENDOR_SHAPE_REMEDY}`,
          ),
        );
      }
      return;
    }

    const config: CheckedAuthConfig = {
      id,
      name,
      status: row.status,
      scopes: scopesOf(row.scopes),
    };
    if (slot === undefined) {
      slotOf.set(id, settled.length);
      settled.push(config);
      return;
    }
    // The readable copy of a config an earlier row could not describe, in that row's place.
    settled[slot] = config;
  });

  const configs: CheckedAuthConfig[] = [];
  const unreadable: BrokerRefusalError[] = [];
  for (const verdict of settled) {
    if (verdict instanceof BrokerRefusalError) unreadable.push(verdict);
    else configs.push(verdict);
  }

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
export function withdrawableAccounts(
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
export function withdrawalDeclined(
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
export function actionOf(
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
     *
     * RAISED AS ITS OWN CLASS, BECAUSE THE ACCOUNT IT REPORTS IS ONE THIS DEPLOYMENT MAY NOT KNOW
     * ABOUT. The connect route refuses a second connection itself wherever it holds a row, so this
     * only reaches it where the row is missing: a fresh or upgraded install, or two installs
     * signing in as one person against one Composio key. See {@link BrokerAccountHeldError}: the
     * route asks again and records the account rather than passing this sentence on.
     *
     * AND THE SENTENCE NO LONGER SENDS ANYBODY TO DISCONNECT IT. It used to name this deployment's
     * Connected accounts page as the place to end the account, which is false exactly when this
     * fires: with no row here, that page draws the app as not connected and offers no Disconnect.
     */
    case "ComposioMultipleConnectedAccountsError":
      return new BrokerAccountHeldError(
        `Composio answered that this person already holds a connected account for ${app}, so ${outcome}. That is a settled state at Composio and not a moment that passes, so asking for another link meets the same answer. It is an account this person is already connected through, whether or not this deployment has recorded it yet.`,
        { cause: error },
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
      /*
       * Raised as its own class so the tool call that met it can put Reconnect in front of the
       * person rather than this sentence alone. See {@link BrokerAccountGoneError}.
       */
      return new BrokerAccountGoneError(
        `Composio holds no connected account for this person and ${app}, so ${outcome}. A grant withdrawn at the provider and an account removed in Composio's own dashboard both read exactly like this, and a retry reaches neither: connecting ${app} again on this deployment's Connected accounts page is what restores it.`,
        { cause: error },
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
export async function askVendor<T>(
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
export function everyRefusal(refused: unknown[]): unknown {
  if (refused.length === 1) return refused[0];
  return new AggregateError(
    refused,
    `Composio refused ${refused.length} of the requests this call made.`,
  );
}
