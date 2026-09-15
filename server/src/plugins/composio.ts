import { brokerSentence, flagOf } from "./broker";
import { type ListedTool, MAX_RESULT_CHARS, type McpCallResult } from "./mcp";

/**
 * The Composio transport: an app somebody enabled, reached as the person asking.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER TRANSPORTS. `mcp` dials somebody else's server and
 * `google-drive-rest` dials Google; both answer to a credential, and whose it is was settled before
 * the connection was built. `builtin-routines` has no credential at all. This one has a credential
 * that is not the answer: the deployment holds ONE Composio key, and which person's Gmail it opens is
 * decided by a user id we send alongside it. So the ACTOR is the authorization here, exactly as it is
 * for Routines, and for the same reason {@link callTool} refuses a run that is not attributed to
 * anybody.
 *
 * THE USER ID IS NEVER AN ARGUMENT. It comes off the connection, which the call path derives from the
 * session. A model that could name a user id could open somebody else's mailbox, and that is not
 * hypothetical: it is the defect OpenTag shipped and fixed three separate times. Nothing below reads
 * `args` looking for an identity, which is what makes it structurally impossible rather than merely
 * checked.
 *
 * It implements the same interface as the other three, as module-level exports, because that is the
 * shape {@link ./transport} resolves: a `TransportKind` maps to a MODULE. Which is also why the client
 * arrives through a setter rather than a constructor — the registry is built at import time, long
 * before anything has read configuration. {@link useComposioClient} is that setter.
 *
 * `index.ts` CALLS IT AT STARTUP, from the one place that holds the key: it builds the client
 * through `./composio-adapter` where `config.composioApiKey` is set and installs the actions seam
 * with it. So on a deployment that has a key `installed` is a real client, and every mention of
 * "the client" below describes wiring that runs. A deployment with no key installs nothing and
 * leaves it null, which is a state this module is written for rather than an outage —
 * {@link listTools} throws a sentence saying so and {@link callTool} refuses with one.
 */

/**
 * The argument key the call path uses to hand this transport the recorded version.
 *
 * A reserved key on `args` rather than a fourth parameter on the shared `callTool` signature, because
 * that signature is MCP's own and three other transports implement it — widening it for one vendor's
 * requirement would put a field on every transport that only one of them can use. Stripped before
 * anything reaches Composio, and asserted stripped, so a vendor never sees a key it did not publish.
 *
 * Underscored so it cannot collide with a real argument name: Composio's schemas are snake_case.
 */
export const VERSION_ARG = "__version";

/**
 * How many rows one PAGE of a listing asks for, which is as many as Composio will answer with.
 *
 * A NUMBER RATHER THAN NO NUMBER, because omitting it is not "no opinion". Composio's page defaults
 * to 20 and Gmail publishes 63 actions, so an omitted limit truncates — and through the SDK wrapper
 * it also NARROWED: `getRawComposioTools` set `important=true` whenever the query named toolkits
 * and gave no limit, no tags and no search (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`),
 * so the short answer was a filtered one and nothing in it said a filter had been applied.
 *
 * 1000 BECAUSE THAT IS THE CEILING, not because it is generous. Both REST parameters document "max
 * allowed is 1000" (`@composio/client` 0.1.0-alpha.76, `resources/tools.d.ts:441-444`,
 * `resources/toolkits.d.ts:483-486`), so this is the fewest round trips a listing can be read in.
 *
 * IT IS A PAGE AND NOT THE LISTING, WHICH IS WHAT CHANGED AND WHY THE REFUSAL BELOW IS GONE. This
 * used to say that one page at the ceiling "is not a page — it is the whole listing, and the only
 * listing expressible here", and {@link listTools} refused a page that came back FULL on the
 * strength of it. That was a fact about the wrapper rather than about the vendor: `ToolListParams`
 * and `ToolkitListParams` both carry a `cursor` and both responses carry a `next_cursor`, and
 * `./composio-adapter` follows them to the end. A listing of exactly this many rows is now an app
 * with a lot of actions, and nothing is truncated by it.
 */
export const LISTING_LIMIT = 1000;

/** One action, as much of Composio's listing as anything here reads. */
export type ComposioAction = {
  slug: string;
  description?: string;
  /**
   * The action's JSON Schema AS COMPOSIO PUBLISHED IT, which for two waves it was not.
   *
   * THIS FIELD USED TO ARRIVE SHORT, AND THE FIX WAS NAMED HERE BEFORE IT WAS MADE. Whatever lands
   * in it is what {@link listTools} puts in front of a model as the vendor's own schema, and
   * `./composio-adapter` filled it from `tools.getRawComposioTools` — the call that ends in
   * `ToolSchema.parse`. Its `ParametersSchema` is a plain `z.object` with no passthrough
   * (`@composio/core` 0.18.1, `src/types/tool.types.ts:134-174`), so every key it did not name was
   * dropped before anything here could see it: `if`, `then`, `else`, `examples` and every `x-`
   * extension at the schema ROOT, and `deprecated` and `contentEncoding` per property
   * (`JSONSchemaPropertySchema`, `:77-131`). This comment recorded that as unavoidable and named
   * the one place it could be avoided — "that same file, by reading `client.tools.list` directly
   * and never running `ToolSchema` over the answer".
   *
   * THAT IS NOW WHAT THE ADAPTER DOES, FOR A REASON THAT HAD NOTHING TO DO WITH THIS FIELD. The
   * wrapper is the one method of the vendor's tool model that cannot be paged, so the listing moved
   * to the raw client to follow Composio's cursor — and the keys came back as a side effect. What
   * this module promises is unchanged and is now worth more: it adds nothing to this schema and
   * removes nothing from it, so what a model is shown is what the vendor published.
   *
   * Absent for the occasional action that publishes none. An action that published `{}` now arrives
   * as `{}` rather than as absent — the SDK normalized that away before parsing
   * (`src/models/Tools.ts:76-93`) and nothing does now — which `./store` records as the open schema
   * an empty one is.
   */
  inputParameters?: Record<string, unknown>;
  /**
   * Behaviour labels mixed in with topical ones. See {@link effectOf}.
   *
   * Absent for an action that publishes none, which lands on write like every other unlabelled one.
   * The vendor spells that absence two ways — no key at all, or a `null` — and the guard in
   * {@link listTools} reads both as the absence they are rather than as a listing it cannot read.
   */
  tags?: string[];
  /** The version calling this action requires — `20260903_00` and the like. */
  version?: string;
};

/**
 * What Composio answers an execute with, as its own SDK defines it.
 *
 * `ToolExecuteResponseSchema` in `@composio/core` 0.18.1 spells all three of these REQUIRED — `data`
 * a record, `error` a nullable string, `successful` a boolean — so the outcome of a call is a field
 * on a resolution and not only a thrown exception. Named here rather than imported so this module
 * keeps no compile-time dependency on the vendor's package; `./composio-adapter` is the one file
 * under `server/src` that imports `@composio/core`, and that is where their types belong.
 *
 * `logId` and `sessionInfo` are the rest of the envelope, carried so the type stays a true statement
 * about what arrives. Nothing here reads them and nothing here shows them to a model.
 */
export type ComposioResult = {
  data: Record<string, unknown>;
  error: string | null;
  successful: boolean;
  logId?: string;
  sessionInfo?: unknown;
};

/**
 * What this module needs of Composio, and nothing more.
 *
 * A narrow projection rather than their client, so a test satisfies it with two functions and the
 * SDK's shape is confined to one place: `./composio-adapter`, which `index.ts` builds from
 * `config.composioApiKey` and installs here at startup. That adapter is the only implementation
 * that reaches Composio; every other one is a stub in the suite.
 *
 * `execute` RESOLVES AN OUTCOME, AND RESOLVING IS NOT SUCCEEDING. This comment used to say the
 * opposite — "resolves or throws, with no error field to check" — and {@link callTool} was written to
 * match the comment rather than the library, which is how a 200 answer carrying `successful: false`
 * came back from this transport as `isError: false`, was audited as `mcp.call_succeeded`, and was
 * handed to the model as though the failure were content. The installed schema is the authority:
 * `successful` is required. Throws still happen too, for a transport fault or a 4xx, so both a
 * resolution and an exception have to be read.
 */
export type ComposioActions = {
  /**
   * Every action of one app, read to the end, in pages the CALLER has to name the size of.
   *
   * `page` is required rather than optional, and that is the whole point of it being here. The
   * original signature took the toolkit alone, so an adapter had nothing to pass a limit through
   * and the SDK's default applied — 20 rows, silently narrowed to the vendor's "important" subset.
   * A required argument makes the page a thing a caller asks for on purpose instead of a thing they
   * get by leaving something out. See {@link LISTING_LIMIT}.
   *
   * WHAT IT NO LONGER BOUNDS IS THE ANSWER. `./composio-adapter` follows Composio's cursor until
   * the vendor stops offering one, so this names how many rows each request carries and not how
   * many actions can come back — which is why the full-page refusal that used to stand in
   * {@link listTools} is gone, and why an implementation that reads one page and stops is a defect
   * nothing about the signature would report.
   */
  listActions(
    toolkit: string,
    page: { limit: number },
  ): Promise<ComposioAction[]>;
  /**
   * One action, of one app, as one person, at one version.
   *
   * THE APP IS PART OF THE CALL AND NOT A CHECK BESIDE IT, which is the whole reason this takes a
   * named record rather than four strings. {@link callTool} resolves the app from the connection's
   * url and the brokered gate in `./access` looks a person's `composio_connections` row up by that
   * same name — and then the call used to go out as the slug alone. A slug is what a LISTING
   * recorded, so a url edited between a refresh and a call was gated on the app it names NOW and
   * run against the app it named THEN: somebody's Slack connection satisfying the gate for a Gmail
   * action that still runs in their Gmail. The gate and the call have to be about one fact.
   *
   * THE VENDOR'S WIRE CANNOT CARRY THE PAIR, so the obligation is written down here instead. The
   * REST parameters have no toolkit field and the client's method takes the slug alone —
   * `execute(toolSlug, params, options)` with `ToolExecuteParams` of `arguments`, `user_id`,
   * `version` and connection overrides (`@composio/client` 0.1.0-alpha.76,
   * `resources/tools.d.ts:41` and `:480-532`) — and the core SDK sends exactly that,
   * `clientWithoutRetries.tools.execute(tool.slug, executeBody)` (`@composio/core` 0.18.1,
   * `src/models/Tools.ts:1013`).
   *
   * SO AN IMPLEMENTATION MUST REFUSE A MISMATCH RATHER THAN FORWARD ONE, and it has what it needs
   * to. `tools.execute` already resolves the tool by slug before running it
   * (`src/models/Tools.ts:1163`, resolver at `:693`), and the resolved tool carries the app the
   * vendor will actually run it against as `Tool.toolkit.slug` (`src/types/tool.types.ts:189`).
   * Where that disagrees with `call.toolkit`, an implementation is required to throw instead of
   * executing — which {@link callTool} already turns into a refusal with a sentence, because a
   * throw out of here is the vendor-reported failure it is written to catch.
   */
  execute(
    call: {
      /** The app the connection's url names, resolved by {@link toolkitOf} at call time. */
      toolkit: string;
      slug: string;
      /** Never from `args`. See the module comment. */
      userId: string;
      version: string;
      /**
       * WHICH ACCOUNT OF THIS PERSON'S THE ACTION RUNS IN, where the caller means one in
       * particular, and absent where any of them will do.
       *
       * A PERSON AND AN APP ARE NOT A NAME FOR AN ACCOUNT. Composio takes one account per set of
       * credentials and one person may hold several for one app — two mailboxes, a stale account
       * beside a fresh one, a key typed again after the first was rotated — so a call naming only
       * the pair runs in WHICHEVER OF THEM THE VENDOR PICKS. For a Bot's ordinary tool call that is
       * the right thing and this stays absent: the person asked for something to be done in their
       * account at the app, and any account they hold is an account they hold.
       *
       * IT IS THE VERIFICATION THAT NEEDS IT, and it needs it absolutely. `probeBrokeredConnection`
       * spends one call to find out whether ONE key works, and the answer is written down as a
       * verdict on the account that key just made: unpinned, a key that does not work is verified
       * by the person's other account, and — the same defect pointing the other way — a good key is
       * condemned, and the account it made deleted, because some other account of theirs is broken.
       * The undo on that path has always been keyed on the account id; this is what makes the CHECK
       * about the same account as the withdrawal.
       *
       * `ToolExecuteParams` carries `connectedAccountId` (`@composio/core` 0.18.1) and the SDK
       * forwards it, so an implementation passes it through rather than resolving anything.
       */
      connectedAccountId?: string;
    },
    args: Record<string, unknown>,
  ): Promise<ComposioResult>;
};

let installed: ComposioActions | null = null;

/**
 * The seam `index.ts` hands this module its client through, once, at startup.
 *
 * A SETTER RATHER THAN A CONSTRUCTOR ARGUMENT, BECAUSE THERE IS NOTHING TO HAND A CLIENT TO. A
 * transport is reached as a MODULE — `transportFor` maps a kind to one — and that registry is built
 * at import time, long before there is configuration to read. So the client is installed globally
 * instead, from the one place that holds the key: `index.ts` builds it from `config.composioApiKey`
 * and calls this with `composio.actions`.
 *
 * `null` is a supported argument, and not only for symmetry: the suite is one process, so a test that
 * installs a stub has to be able to take it back out. It is also the unconfigured state — a
 * deployment with no Composio key installs nothing. What that state produces is not an empty answer:
 * {@link listTools} THROWS and {@link callTool} refuses, both saying which of the two it is, because
 * an empty listing is indistinguishable from an app that advertises nothing and would be committed
 * as one.
 */
export function useComposioClient(client: ComposioActions | null): void {
  installed = client;
}

/**
 * The tool list needs no credential FROM THE CONNECTION, which is not the same as needing none.
 *
 * The sentence here used to be "Composio publishes an action's schema to anybody", and the vendor's
 * own client says otherwise: the listing is an authenticated request carrying the deployment's
 * Composio API key, which the client holds and this module never sees. What is genuinely not
 * required is a PERSON. An action's schema is the same whoever asks, so nothing about whose account
 * is connected has to be settled before listing — which is exactly what this flag is asked to
 * decide by `refreshTools`, and the only thing it decides. See {@link ./transport}.
 */
export const listNeedsCredential = false;

/**
 * Which app this connection is about.
 *
 * The slug lives in the url — `composio://gmail` — rather than in a column of its own, because the url
 * is the field every transport already gets and `effectiveUrl` already owns. Null for anything that is
 * not one of ours, so a misrouted connection lists nothing instead of asking Composio about a
 * hostname.
 *
 * ONE SLUG OR NOTHING, and the strictness is the security property rather than tidiness. This answer
 * becomes `ServerAccess.toolkit` (`./access`), which is the name the brokered gate looks a person's
 * row up by in `composio_connections` — so a url read loosely is somebody's connection to one app
 * satisfying a call against another. Whatever follows the scheme has to be a slug and nothing else:
 * `composio://gmail/messages` used to answer `"gmail/messages"`, taking a path segment for an app.
 *
 * TRIMMED BEFORE THE SLASHES COME OFF, because the other order does not work. `composio://gmail/ `
 * ran the strip against a string whose last character was a space, so the slash was not at the end,
 * nothing matched, and the trim then produced `"gmail/"`.
 *
 * The character class is deliberately not case-folded. `composio_connections.toolkit` documents the
 * column as lower case and this function does not lower-case what it returns; that mismatch is a
 * separate known issue, and matching case-insensitively here keeps this change to the shape of the
 * url rather than quietly settling it.
 */
const TOOLKIT_SLUG = /^[A-Za-z0-9_-]+$/;

export function toolkitOf(url: string): string | null {
  const prefix = "composio://";
  if (!url.startsWith(prefix)) return null;
  const slug = url.slice(prefix.length).trim().replace(/\/+$/, "");
  return TOOLKIT_SLUG.test(slug) ? slug : null;
}

/**
 * What an action does, from the labels Composio publishes with it.
 *
 * SIX LABELS, AND ONLY TWO DECIDE ANYTHING. `readOnlyHint` is the one thing that can produce a read.
 * `destructiveHint` produces a destructive write. `createHint` and `updateHint` are writes, which is
 * also what an unlabelled action is, so reading them buys nothing over the default. `idempotentHint`
 * and `openWorldHint` say nothing about effect — DELETE is idempotent, so treating idempotence as
 * safety would wave through exactly the calls worth asking about.
 *
 * ANYTHING UNLABELLED IS A WRITE. Measured across Gmail, Linear, Calendar, Notion and Slack, every
 * action carried at least one label, so this is a guard against the future rather than the present: an
 * app that labels nothing, or a label added later that this code has never heard of, must land on
 * write. The opposite default would silently classify new actions as safe.
 *
 * DESTRUCTIVE WINS OVER READ-ONLY. Both at once is somebody else's bug, and the strict reading is the
 * only safe one.
 */
export function effectOf(tags: readonly string[] | undefined): {
  effect: "read" | "write";
  destructive: boolean;
} {
  /*
   * AND THE LABEL IS THE WORD, WHICH IS THE SAME READ THE SLUG AND THE VERSION BESIDE IT ALREADY
   * GET. `Set.has` is an identity comparison, so `" destructiveHint "` matches nothing here: a
   * destructive action is recorded with `destructive: false`, on the row that decides whether a Bot
   * is stopped before it runs the action at all, and nothing about the row looks wrong. That is the
   * silent wrong answer the guard one function down was written for, arriving through padding
   * rather than through a shape — and it fails the dangerous way round, because the SAME padding on
   * `readOnlyHint` only costs a read being called a write.
   *
   * The map that calls this already trims the action's slug and its version for the same reason,
   * and the guard that admits the list measures `typeof label !== "string"` and nothing else, so a
   * padded label reaches here exactly as a clean one does.
   */
  const labels = new Set((tags ?? []).map((label) => label.trim()));
  if (labels.has("destructiveHint"))
    return { effect: "write", destructive: true };
  if (labels.has("readOnlyHint")) return { effect: "read", destructive: false };
  return { effect: "write", destructive: false };
}

/**
 * A plain object — a JSON Schema node, a listed action, an execute envelope — or null for anything
 * that is not one, which is the only question three separate readers in this file have of a value
 * the vendor sent. An array answers null, because `typeof [] === "object"` is the trap every one of
 * them would otherwise fall into on its own.
 */
function schemaNode(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * How deep a published schema may nest before this deployment stops walking it and says so.
 *
 * THE BOUND IS AGAINST A SCHEMA THAT NEVER ENDS, not against a complicated one, which is the same
 * argument `./composio-adapter` makes for its page ceiling. The walk below recursed as far as the
 * vendor nested, on the premise that a wire value's depth is bounded by something. Nothing bounds
 * it: a body Composio published, a proxy stitched, or a toolkit generated is as deep as it is, and
 * a stack exhausted inside a walk that sits outside every `try` here is an engine sentence in an
 * administrator's `lastError`.
 *
 * 64 IS PAST ANY SCHEMA A FORM COULD BE DRAWN FROM. `$ref` is not followed — only literal nesting
 * counts — so each level is a real object inside a real object, and the deepest thing Composio
 * publishes is an attachment descriptor three or four in. A toolkit that genuinely needs 65 is a
 * vendor change to read rather than a number to raise.
 */
const SCHEMA_DEPTH = 64;

/**
 * What the walk below answers: whether the action stages a file, or why that could not be settled.
 *
 * THE THIRD ANSWER IS A CLAUSE RATHER THAN A `null`, so the refusal {@link listTools} writes can say
 * WHICH shape stopped the read without this function knowing the app or the action it is about. It
 * reads after "Composio's action list for gmail …", in the present tense, for the reason every
 * outcome clause in `./composio-adapter` is written at the site that knows the fact.
 */
type FileVerdict = boolean | string;

/**
 * Whether an action asks for a file, anywhere in its schema.
 *
 * `file_uploadable` is Composio's own extension keyword, and one of the few the SDK's
 * `JSONSchemaPropertySchema` whitelists rather than strips (`@composio/core` 0.18.1,
 * `src/types/tool.types.ts:89`) — so unlike most of what the vendor publishes, this one is still
 * here to be read. See {@link listTools} for what is done with the answer.
 *
 * WALKED, NOT LOOKED UP. Composio toolkits routinely put the flag behind a `$ref`/`$defs`
 * indirection or inside an `anyOf` variant, which is why the vendor's own predicate recurses
 * through both (`src/utils/modifiers/FileToolModifier.utils.neutral.ts:77-134`). A check that read
 * only the top level of `properties` would answer false for every ref-based schema, which is the
 * majority of the ones that carry a file.
 *
 * WHAT BOUNDS THE LIST IS WHAT THE WIRE CAN CARRY, AND THAT IS NO LONGER WHAT THE SDK KEPT. This
 * comment bounded the list by a strip: a keyword `ParametersSchema` and `JSONSchemaPropertySchema`
 * did not name could not be present to be walked, because `ToolSchema.parse` removed it before any
 * caller saw the schema, so nothing outside those two zod objects needed a branch. That premise
 * belonged to the WRAPPER and the wrapper is gone. `./composio-adapter` reads `client.tools.list`
 * and runs no parse over the answer — it had to, because `getRawComposioTools` is the one method of
 * the vendor's tool model that cannot be paged — so what arrives here is the schema Composio
 * published, whole, which is what {@link ComposioAction.inputParameters} above now promises.
 *
 * SO THE APPLICATORS THE STRIP USED TO REMOVE ARE WALKED, because every one of them is now a place
 * a toolkit can hide a file. `prefixItems`, `contains`, `dependentSchemas`, `propertyNames`,
 * `unevaluatedItems` and `unevaluatedProperties` are 2020-12 applicators and `dependencies` is
 * draft-07's, and none of the seven appears in either zod object. Each was unreachable while the
 * parse stood and reachable the moment it went, and an unwalked one is an action offered to a model
 * under both auto-upload settings whose every call fails at the vendor's staging lookup — the same
 * defect `additionalProperties` was, arriving through six more doors.
 *
 * SEVERAL OF THESE ARE UNIONS RATHER THAN PLAIN SUBSCHEMAS, and no arm needs a case of its own.
 * `additionalProperties`, `unevaluatedItems` and `unevaluatedProperties` union with `boolean`;
 * `items` unions with a tuple array; `dependencies` maps a name to a subschema OR to a list of
 * required property names. The boolean and the string list fall out of {@link schemaNode}, which
 * answers null for both, and the tuple arm is what the second loop's `Array.isArray` is for.
 *
 * Wider than the vendor's predicate by `patternProperties`, `not`, the conditional trio and the
 * seven above, which that one skips: a file staged only under a condition is still a file this
 * deployment cannot stage.
 *
 * AND IT ANSWERS THREE THINGS RATHER THAN TWO, WHICH IS THE GUARD EVERY OTHER READ OF THIS LISTING
 * ALREADY HAD. This returned a boolean, so every shape it could not make sense of came back as "no
 * file here" and the action was offered — the one direction this filter must not fail in. Two
 * shapes reach that: a `file_uploadable` that is not a flag, and a schema nested deeper than
 * {@link SCHEMA_DEPTH}, which this walked as far as the vendor cared to nest it. The second is the
 * worse of the two, because the walk sits OUTSIDE the try that wraps the vendor's call: a schema
 * deep enough to exhaust the stack left through the one door in this function with nothing standing
 * in it, as `RangeError: Maximum call stack size exceeded`, which is the string `refreshTools`
 * writes into the app row's `lastError` for an administrator to read. That sentence names neither
 * the app nor the action, and the engine is not a party anybody can act on. The third answer is a
 * clause saying which of the two it was, and {@link listTools} builds the sentence around it, where
 * the app and the action are both in hand.
 */
function stagesAFile(schema: unknown, depth = 0): FileVerdict {
  if (depth > SCHEMA_DEPTH)
    return `nests more than ${SCHEMA_DEPTH} objects deep`;
  const node = schemaNode(schema);
  if (!node) return false;
  /*
   * THE FLAG IS A VENDOR VALUE AND WAS THE LAST `=== true` IN THIS DEPLOYMENT. `"true" === true` is
   * `false`, so a toolkit publishing the flag as a string left a file-staging action OFFERED —
   * this filter's only fail-open direction, and the one it exists to close. What a model gets is a
   * parameter whose only honest value is an `s3key` nothing here can issue, a call that fails at
   * the vendor's staging lookup every time, and a grant recorded against a name that can never
   * work. See {@link flagOf}: an ABSENT flag is still the app saying it stages nothing, which is
   * most of the catalogue and is why the default is `false` rather than a refusal.
   */
  const flagged = flagOf(node.file_uploadable, false);
  if (flagged === null)
    return "publishes a file_uploadable in it that is not a flag";
  if (flagged) return true;

  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
  ]) {
    const children = schemaNode(node[key]);
    if (!children) continue;
    for (const child of Object.values(children)) {
      const answer = stagesAFile(child, depth + 1);
      if (answer !== false) return answer;
    }
  }

  for (const key of [
    "anyOf",
    "oneOf",
    "allOf",
    "items",
    "prefixItems",
    "contains",
    "additionalProperties",
    "unevaluatedItems",
    "unevaluatedProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ]) {
    const branch = node[key];
    for (const child of Array.isArray(branch) ? branch : [branch]) {
      const answer = stagesAFile(child, depth + 1);
      if (answer !== false) return answer;
    }
  }

  return false;
}

/**
 * Whether an action published under this schema would be refused if it were called with no arguments.
 *
 * WHO ASKS, AND WHAT A WRONG ANSWER COSTS. `probeActionFor` in `store.ts` picks the read action a
 * key check is spent on, and that check is called with an EMPTY argument object. An action that
 * turns out to need an argument answers with the vendor's validation error, which arrives as
 * "Composio ran it and it failed" — indistinguishable at that layer from "the vendor rejected this
 * key". On the connect path that deletes the account created seconds earlier and tells the person
 * what they typed was wrong; on the re-check path it stamps a working connection with the named
 * probe beside `verified: false`, which is the one state the settings page tells an operator to act
 * on. So a false NO here manufactures an accusation against a valid credential.
 *
 * WHICH IS WHY IT FAILS CLOSED, and that is the reverse of what the caller used to do. The filter
 * read `schema.required` at the top level only and its comment reasoned that anything which is not
 * a non-empty list is "no reason to pass this action over" — fail-open in exactly the direction that
 * costs an accusation. A required list published under `allOf`/`anyOf`/`oneOf`, or behind a `$ref`,
 * is the ordinary way a generated toolkit writes one, and every such action passed that filter. The
 * sibling walker {@link stagesAFile} already descends these keywords over these very schemas, on
 * the stated grounds that inspecting only the top level "would answer false for every ref-based
 * schema". A YES costs one candidate out of a list; the fallback is the next safe read, and where
 * there is none the app is simply not checkable, which the page already draws.
 *
 * ONLY THE KEYWORDS THAT BEAR ON AN EMPTY OBJECT ARE WALKED, which is narrower than that sibling
 * and deliberately so. `required` inside `properties`, `patternProperties`, `items`, `$defs`,
 * `dependentSchemas` or draft-07 `dependencies` applies only once something is present, and `{}`
 * presents nothing — descending them would refuse nearly every action over a constraint the call
 * can never trip. What is left is the composition trio, the conditional trio, and the two shapes
 * that cannot be reasoned about at all: a `$ref`, which needs a resolver this deployment does not
 * have, and a `not`, whose arms invert. Both answer YES rather than being walked.
 *
 * AND `anyOf`/`oneOf` ARE TREATED AS `allOf` HERE. Strictly, one satisfiable arm is enough, so an
 * arm with no `required` would make `{}` legal. Deciding that needs the whole arm evaluated rather
 * than its `required` read, and being wrong about it costs the accusation above — so any arm that
 * asks is taken as the action asking.
 *
 * An ABSENT schema is not an unreadable one and answers NO: most of the catalogue's identity reads
 * publish nothing, and a vendor that stated no requirement has stated none. A schema that is present
 * and is not an object is unreadable and answers YES.
 */
export function asksForArguments(schema: unknown, depth = 0): boolean {
  if (depth > SCHEMA_DEPTH) return true;
  if (schema === undefined || schema === null) return false;
  const node = schemaNode(schema);
  if (!node) return true;

  if (node.$ref !== undefined || node.not !== undefined) return true;

  const required = node.required;
  if (required !== undefined) {
    if (!Array.isArray(required)) return true;
    if (required.length > 0) return true;
  }

  for (const key of ["allOf", "anyOf", "oneOf", "if", "then", "else"]) {
    const branch = node[key];
    if (branch === undefined) continue;
    for (const child of Array.isArray(branch) ? branch : [branch]) {
      if (asksForArguments(child, depth + 1)) return true;
    }
  }

  return false;
}

/**
 * Every action this app publishes, in the shape a `tools/list` answer has, plus what we know about it.
 *
 * An action with no schema is still listed, with an open one. The vendor is the right party to reject a
 * bad argument, and an action silently missing from the list reads to an administrator as an app that
 * does not have it. The one exception is an action that asks for a FILE, which is dropped — see the
 * criterion beside the filter below, and note that it turns on the action being uncallable rather
 * than on its schema being unfamiliar.
 *
 * A listing that could not be read at all is a THROW rather than an empty list, for the same reason
 * turned around: an empty list is what an app with no actions looks like, so answering emptily would
 * report a success and strand every grant. What throws is a sentence, never a vendor object. See the
 * catch below.
 *
 * AND SO IS A LISTING NOBODY WAS ASKED FOR, which is the same criterion applied one step earlier.
 * `[]` from a `listTools` means, in `mcp.ts`, `google-drive-rest.ts` and `builtin-routines.ts`
 * alike, "the vendor was asked and advertises no actions" — and `refreshTools` commits that as a
 * healthy refresh. This function used to answer `[]` for a url naming no app and for a deployment
 * with no client installed, neither of which involved asking anybody, and the commit deleted every
 * `mcp_tools` row for the app: the recorded `effect`, `destructive` and, fatally, `version`, which
 * `callTool` refuses to run without and which only a listing can put back. So the two "asked
 * nobody" cases throw, and they throw SEPARATELY, because one sends an operator to this
 * deployment's configuration and the other to the row's url.
 *
 * WHAT IS DELIBERATELY NOT REFUSED IS THE VENDOR'S OWN EMPTY PAGE, and it is worth saying why.
 * `@composio/core` used to manufacture one — `getRawComposioTools` ends `if (!tools) { return []; }`
 * (0.18.1, `src/models/Tools.ts:553-557`), so a response it could not read arrived here as the same
 * `[]` an app with no actions would send — and that particular hazard is gone with the wrapper:
 * `./composio-adapter` reads the raw client and refuses an answer that is not a page rather than
 * turning it into an empty one. What remains is the honest case, a listing Composio really did
 * answer with no rows, and that is answered a layer down rather than here — `store.ts`'s own
 * empty-listing guard keeps every recorded action,
 * its `effect`, its `destructive` and its `version` whenever an app that HAS actions lists none,
 * writes the sentence saying so, and stamps no refresh. Refusing here as well would buy nothing
 * that guard does not already hold, and would cost the case it is careful to allow: an app that
 * genuinely advertises nothing stays recordable, rather than reading as broken for good.
 */
export async function listTools(connection: {
  url: string;
}): Promise<ListedTool[]> {
  const toolkit = toolkitOf(connection.url);
  if (!toolkit) {
    throw new Error(
      `${connection.url} does not name a Composio app, so nothing was asked what it offers. A row reached through this transport is one whose provenance says composio, and its url has to be composio:// followed by an app slug; correct the url on the Plugins page.`,
    );
  }
  if (!installed) {
    /*
     * A STATE, NOT A FAULT, and the sentence has to read as one.
     *
     * `index.ts` installs a Composio client only where `COMPOSIO_API_KEY` is set — see
     * {@link useComposioClient} — so this is what every Composio refresh on a deployment without
     * one answers, by design and not by accident. An operator who reads it as a crash goes looking
     * for a broken vendor; what they need to know is that the connector is not configured here and
     * that nothing was lost.
     */
    throw new Error(
      `Composio is not configured for this deployment, so nothing could be asked what ${toolkit} offers. That is the expected answer until COMPOSIO_API_KEY is configured, and the actions already recorded for this app are kept rather than cleared.`,
    );
  }

  let actions: ComposioAction[];
  try {
    actions = await installed.listActions(toolkit, { limit: LISTING_LIMIT });
  } catch (error) {
    /*
     * THROWN, NOT ANSWERED EMPTY, and with a sentence rather than the vendor's raw object.
     *
     * The two candidate behaviours are not equivalent. `refreshTools` records a throw in the row's
     * `lastError` and leaves the tools it already holds alone; an empty answer is indistinguishable
     * from an app that genuinely publishes no actions, so it would report a success and leave every
     * grant pointing at a name nothing advertises. So a listing this deployment could not read must
     * propagate.
     *
     * What propagates is a sentence. `refreshTools` puts `error.message` on the admin page, and
     * what a listing throws with is nobody's sentence: `@composio/client`'s `APIError` builds its
     * message from the whole response body, and a zod parse's is the issue array as JSON. An
     * operator reading 400 characters of `{"code":"invalid_type","path":[...]}` or of a validation
     * payload learns nothing they can act on, and the same string was reaching a model's context.
     * The original is kept as `cause` for a log.
     *
     * `ToolSchema` USED TO BE THE THROWER NAMED HERE AND IS NO LONGER ON THIS PATH. The listing
     * left the wrapper for the raw client, which runs no parse, so the zod half of that sentence is
     * now about the seam rather than about the adapter — see {@link listingSentence}.
     */
    throw new Error(listingSentence(toolkit, error), { cause: error });
  }

  /*
   * NOTHING IS READ OFF THE ANSWER UNTIL IT IS A LIST, and the check is here rather than assumed
   * from the type. `ComposioActions` is this module's own projection, what satisfies it is
   * `./composio-adapter` mapping an answer off the wire that no type checker here has seen, and a
   * return type is not a promise about what resolves at runtime — a client that answers null, or a
   * bare envelope with the array one level down, is a mistake this file will meet before a type
   * checker does.
   *
   * Both reads below sit OUTSIDE the try that wraps the vendor's call, so before this guard
   * `actions.length` propagated `null is not an object (evaluating 'actions.length')` — which is
   * the string `refreshTools` writes into the row's `lastError` for an administrator to read. What
   * this path owes that reader is a sentence naming the app and saying nothing was lost, so the
   * shape is settled while such a sentence can still be written.
   *
   * THE ELEMENTS ARE CHECKED TOO, AND FOR THE SAME REASON RATHER THAN A DIFFERENT ONE. `[null]`
   * reaches `action.inputParameters` in the filter below and `action.slug` in the map, both
   * outside the try; it is the identical failure one level down, so it is answered here rather
   * than left to produce a different unreadable message. What is checked is only that each
   * element is an object — this module does not validate the vendor's schema, and an action
   * missing a field it does not have is the vendor's business.
   */
  if (
    !Array.isArray(actions) ||
    actions.some((action) => schemaNode(action) === null)
  ) {
    throw new Error(
      `Composio did not answer with an action list for ${toolkit}: what came back was not a list of actions at all. Nothing was refreshed and the actions already recorded for this app are kept.`,
    );
  }

  /*
   * AN ACTION IS OFFERED ONLY IF A MODEL COULD ACTUALLY FILL IN ITS ARGUMENTS.
   *
   * A `file_uploadable` parameter fails that. Under the SDK's default file handling — the flag is
   * `dangerouslyAllowAutoUploadDownloadFiles` and it is off unless a client asks for it
   * (`src/models/Tools.ts:136`, `:242-248`) — the parameter reaches the model as the vendor's
   * internal staging descriptor, `{ name, mimetype, s3key }`. An `s3key` is issued by an upload to
   * Composio's bucket. Nothing in this deployment performs one, and a model has no way to obtain
   * one, so the only value it can produce is invented and the vendor's staging lookup rejects the
   * call. The SDK says as much itself in the warning it logs on that path (`:349-366`).
   *
   * WHY THIS IS NOT THE SAME AS THE SCHEMALESS ACTION BELOW, which is deliberately still offered.
   * There the vendor is the right party to reject a bad argument, and the action might well
   * succeed. Here it cannot: every call is a rejection, and an advertised action that can only
   * fail is worse than an absent one, because an administrator grants it, the audit trail records
   * attempts against it, and the model spends turns retrying with a different invented key.
   *
   * ENABLING AUTO-UPLOAD WOULD NOT FIX IT EITHER, which is why the answer is not "turn the flag
   * on". That flag collapses the parameter to `{ type: 'string', format: 'path' }` — a promise
   * that the SDK will read a local path off this server's disk. A model naming a server-side path
   * is a worse offer than one naming a bucket key, not a better one.
   *
   * IT RUNS BEFORE THE FIELD GUARDS RATHER THAN AFTER THEM, AND THAT ORDER IS THE POINT. Each of
   * the three below is written as a fact about the MAP at the end of this function — a slug that
   * becomes a tool named `undefined`, a `tags` that is not iterable, a `version` whose `trim` is
   * not a function — and the map runs over what this filter returns. Asked of the whole listing
   * they refuse on behalf of an action that never reaches the thing they protect: a file-staging
   * action this deployment was never going to publish took down the refresh of every other action
   * on the app, which is the tool-and-version stranding those refusals exist to prevent, caused by
   * the refusals. The only read this filter makes is `inputParameters`, which the element check
   * above has already settled is reachable, so nothing it needs is owed to a guard below it.
   *
   * WHAT DOES NOT CHANGE IS WHAT THE GUARDS DO WITH WHAT THEY SEE. A malformed field on an action
   * that IS offered is still a total refusal, for the reasons each of them gives, because that one
   * really does reach the map.
   */
  const read = actions.map((action, position) => ({
    action,
    /*
     * NAMED BY ITS SLUG WHERE THERE IS ONE AND BY ITS PLACE WHERE THERE IS NOT, because this runs
     * ABOVE the slug guard and has to — see the paragraph above for why a file-staging action with
     * a broken field must not take the app's refresh down. The three guards below can write
     * `action.slug.trim()` unconditionally; this one cannot, and "action 4 of the listing" is still
     * a row an operator can find in a dashboard.
     */
    named:
      typeof action.slug === "string" && action.slug.trim() !== ""
        ? action.slug.trim()
        : `action ${position + 1} of the listing`,
    verdict: stagesAFile(action.inputParameters),
  }));

  /*
   * A SCHEMA THIS DEPLOYMENT COULD NOT READ TO THE BOTTOM IS A REFUSAL, NOT AN ACTION OFFERED.
   *
   * The two shapes {@link stagesAFile} cannot settle are a `file_uploadable` that is not a flag and
   * a schema nested past {@link SCHEMA_DEPTH}, and read as "no file" they are both an action
   * published to a model whose every call fails at the vendor's staging lookup. That is the exact
   * thing the filter below exists to prevent, so the answer is the one the three field guards after
   * it already give: refuse while a sentence can still name the app and the action, and keep every
   * action, effect, version and grant the app already has.
   *
   * IT IS A TOTAL REFUSAL RATHER THAN A DROP, WHICH IS WHERE THIS PARTS FROM THE FILTER BESIDE IT.
   * Dropping is right for an action this deployment has DECIDED about — a standing decision, taken
   * the same way on every refresh, over a well-formed schema. Nothing was decided here: a short
   * listing is committed as the complete truth about the app, so an action dropped because its
   * schema could not be read is a `version` and an `effect` deleted over a shape nobody looked at.
   */
  const unreadableSchema = read.find((row) => typeof row.verdict === "string");
  if (unreadableSchema) {
    throw new Error(
      `Composio's action list for ${toolkit} carries an input schema for ${unreadableSchema.named} that this deployment could not read to the bottom: it ${unreadableSchema.verdict}. Whether an action stages a file is what decides whether this deployment can offer it at all — one that does is dropped, because a model can only invent the staging key it asks for — so a schema that settles neither is not one to publish an action from. Nothing was refreshed and the actions already recorded for this app are kept rather than replaced by a listing whose schemas could not be read.`,
    );
  }

  const offered = read
    .filter((row) => row.verdict !== true)
    .map((row) => row.action);

  /*
   * AN ACTION WITH NO SLUG BREAKS THE LISTING RATHER THAN BEING DROPPED FROM IT.
   *
   * The slug is the action's whole identity here: it becomes `name` in `mcp_tools`, which is NOT
   * NULL and half the primary key, it is what a grant records, and it is the `slug` {@link callTool}
   * sends back to Composio. Left to the map below it becomes a tool named `undefined` that fails
   * the insert, taking down the refresh of an app whose other sixty actions were fine.
   *
   * NOTHING SPELLS IT REQUIRED ANY MORE, WHICH IS WHY THIS IS A CHECK AND NOT A RESTATEMENT. This
   * said `ToolSchema` required the field, and that was a fact about the wrapper: the listing now
   * reads `client.tools.list` through `./composio-adapter`, which runs no parse, so the only thing
   * between Composio and this line is `actionOf`'s own guard one file over and this one.
   *
   * SKIPPING IT WOULD BE THE WRONG REPAIR, and this file's own distinction between an empty answer
   * and a broken one says why. Dropping the element makes this a SHORT listing, and `refreshTools`
   * commits a listing as the complete truth about the app: the replace is a delete and an insert,
   * so every recorded action missing from it is deleted with its `effect`, `destructive` and
   * `version` — and `version` is the one no refresh can reconstruct where the vendor publishes
   * none. That is a fragment committed as complete, arriving one element at a time; and here
   * nobody could even be told which action went missing, because the thing that names it is the
   * thing that is absent.
   *
   * NOR IS IT THE FILE FILTER'S CASE, which drops actions and is right to, and which now runs
   * ABOVE this. Those are well-formed actions the vendor published in full that this deployment
   * cannot serve — a standing decision about a known action, taken the same way on every refresh —
   * and an action it dropped is one the map never sees, so a missing slug on one of those is not
   * this guard's business. This is an answer that could not be read about an action that WILL be
   * published, which is the criterion the element check above already throws on, one field in.
   *
   * BLANK COUNTS AS ABSENT, for the reason the version below is trimmed: `callTool` would send the
   * padding to Composio as the action's name, and no `mcp_tools` row keyed on whitespace is a name
   * anybody meant to grant.
   */
  if (
    offered.some(
      (action) => typeof action.slug !== "string" || action.slug.trim() === "",
    )
  ) {
    throw new Error(
      `Composio's action list for ${toolkit} contained an action with no slug, which is the name this deployment would have to record it under and send back to call it. Nothing was refreshed and the actions already recorded for this app are kept rather than replaced by a listing this one could not be read from.`,
    );
  }

  /*
   * A SLUG LISTED TWICE IS NOT REFUSED HERE, and that is a decision rather than an omission.
   *
   * `mcp_tools` holds one row per name, so the collision is real — but it is already settled one
   * layer down and in the other direction: `storableTools` in `./store` keys the insert by name
   * and keeps the first occurrence, deliberately, so a vendor that names one action twice records
   * it once under a refresh that stays healthy. Refusing here would turn that refresh into a total
   * failure and strand every grant on the app, which is the loss the refusals around this one
   * exist to prevent. What this function owes that de-duplication is the trimmed name the map
   * below records, so two spellings of one slug collide there rather than surviving as two rows.
   */

  /*
   * AN ACTION'S LABELS ARE READ, SO THEY HAVE TO BE READABLE.
   *
   * {@link effectOf} builds a Set out of this field, and the element check above settles only that
   * the action is an object. A `tags` that is not iterable — `{}`, a number, a bag of labels keyed
   * by index — throws `{} is not iterable` out of the map below, which sits OUTSIDE the try that
   * wraps the vendor's call, so that string is what `refreshTools` writes into the row's
   * `lastError` for an administrator to read.
   *
   * A STRING IS THE HALF THAT DOES NOT THROW, and it is the worse one. `new Set("readOnlyHint")`
   * is that word's characters, no hint matches any of them, and a read-only action is recorded as
   * a write — a classification nobody can see is wrong, on a row an administrator grants from.
   * Defaulting either shape to "write" would make the same silent answer deliberate, so both are
   * refused here while a sentence can still name the action.
   *
   * AND THE LABELS THEMSELVES ARE READ, SO THEY HAVE TO BE LABELS. This guard checked the CONTAINER
   * and trusted its CONTENTS, and that is the third distinct way this one field has been found
   * unheld. {@link effectOf} decides by `Set.has("destructiveHint")`, which is an identity
   * comparison: no object, nested array or number in that set can ever match it, whatever it spells.
   * So `[{ name: "destructiveHint" }]` and `[["destructiveHint"]]` — the two shapes a listing
   * carries when a vendor changes how it spells a label — are not an unreadable field that throws.
   * They are a DESTRUCTIVE action recorded as `destructive: false`, on the row that decides whether
   * a Bot is stopped before it runs the action at all, and nothing about the row looks wrong.
   *
   * That is the string case's silent wrong answer again, one level in and failing the dangerous
   * way round rather than the cautious one, so it is answered the same way and in the same breath.
   * ASKED OF EVERY ELEMENT rather than of any, because a list that is mostly labels with one
   * malformed entry is the shape a vendor actually sends, and it is the one a looser check passes.
   *
   * OF EVERY OFFERED ELEMENT, because the map and the `mcp_tools` row are what the whole argument
   * above is about and neither exists for an action the file filter dropped. See that filter.
   *
   * AND `null` IS ABSENT HERE, FOR THE REASON THE VERSION GUARD BELOW SPELLS OUT ON THE FIELD NEXT
   * DOOR. "This action carries no labels" is a real state with an answer already — {@link effectOf}
   * reads the field as `tags ?? []` and lands an unlabelled action on write, which is what an
   * unlabelled action IS — and `null` is how JSON spells it. Exempting only `undefined` made those
   * two spellings of one absence disagree: the same guard whose whole purpose is to keep an app's
   * recorded actions, effects, versions and grants standing through a listing it cannot read was
   * aborting the app's ENTIRE listing over a field it CAN read, on every refresh, permanently. One
   * action publishing a null took every other action on the app down with it, and no later refresh
   * recovers what the refusal keeps refusing. That is the loss this guard is written to avoid.
   *
   * WHICH IS THE FIELD AND NOT ITS ELEMENTS. A `tags` of `[null]` is still refused: the list is
   * there, and a label that is not a label is the silent misclassification above, not an absence.
   *
   * READ AS `unknown` for the reason the version beside it is — the type is this module's
   * projection and the value is the vendor's.
   */
  const oddTags = offered.find((action) => {
    const tags: unknown = action.tags;
    return (
      tags !== undefined &&
      tags !== null &&
      (!Array.isArray(tags) || tags.some((label) => typeof label !== "string"))
    );
  });
  if (oddTags) {
    throw new Error(
      `Composio's action list for ${toolkit} described ${oddTags.slug.trim()}'s tags as something other than a list of labels, and those labels are the only thing that says whether an action reads or writes and whether it destroys anything. Nothing was refreshed and the actions already recorded for this app are kept rather than replaced by a listing whose effects could not be read.`,
    );
  }

  /*
   * AND THE VERSION BESIDE THEM, WHICH IS READ IN THE SAME MAP AND WAS HELD BY NOBODY.
   *
   * `action.version?.trim()` is the read, and `?.` guards null and undefined and nothing else — so a
   * number, an object, a list or a boolean throws `action.version?.trim is not a function` out of a
   * map that sits OUTSIDE the try wrapping the vendor's call. That engine sentence is exactly what
   * `refreshTools` writes into the row's `lastError` for an administrator to read, which is the
   * failure the labels guard above exists to prevent, on the field immediately next to it.
   *
   * REFUSED RATHER THAN READ AS NO VERSION, which is the other candidate repair and is the wrong
   * one for the reason every refusal on this path is a refusal. Recording the action with no
   * version makes it permanently uncallable and sends its reader to a refresh that writes the same
   * unreadable field back — the loop {@link callTool}'s version refusal already names — and
   * committing the listing at all is a delete and an insert that takes the `version` of every OTHER
   * action on the app with it, which no later refresh reconstructs where Composio publishes none.
   *
   * `null` IS NOT ONE OF THESE, and that is deliberate rather than an oversight in the check. "This
   * action has no version" is a real and common state with an answer already — the action is listed
   * with no version key — and `null` is how JSON spells it. The `?.` in the map has always read it
   * that way; refusing it here would turn a healthy refresh into a total failure for every app that
   * publishes one, which is the loss this guard is written to avoid rather than to cause.
   *
   * Both fields are read as `unknown` for the reason {@link reportedFailure} reads its two that way:
   * the types above are this module's projection and the values are the vendor's.
   *
   * ASKED OF THE OFFERED ACTIONS for the reason the two guards above it are: the map that reads
   * this field, and the `version` column a refresh would wipe, are both about actions that get
   * published, and an action the file filter dropped is published nowhere.
   */
  const oddVersion = offered.find((action) => {
    const version: unknown = action.version;
    return (
      version !== undefined && version !== null && typeof version !== "string"
    );
  });
  if (oddVersion) {
    throw new Error(
      `Composio's action list for ${toolkit} described ${oddVersion.slug.trim()}'s version as something other than a version string, and the version is what this deployment has to send back to call the action at all. Nothing was refreshed and the actions already recorded for this app are kept rather than replaced by a listing whose versions could not be read.`,
    );
  }

  /*
   * AND THE ACTION'S OWN WORDS, WHICH IS THE FOURTH FIELD THE MAP READS AND THE ONE NOBODY HELD.
   *
   * The three guards above were written together and this one was left out, so `description` was
   * the only field in the map below with nothing between the vendor and the row. The map's
   * `description ?? ""` answers for ABSENCE and says nothing about type, which is precisely what
   * `action.version?.trim()` did on the field next door before the guard above it existed.
   *
   * WHAT MEETS IT IS `replaceAll`, ONE MODULE ON. `storableTools` in `./store` writes
   * `(tool.description ?? "").replaceAll(NUL, "")`, so a number, an object or a list throws
   * `(tool.description ?? "").replaceAll is not a function`. That throw IS caught — the `try` around
   * `storableTools` exists so nothing a vendor sent leaves `refreshTools` raw — and what it writes
   * into `lastError` for an administrator to read is "an action whose schema could not be stored as
   * it arrived", followed by the engine's sentence. BOTH HALVES MISLEAD: it was not the schema,
   * nothing names the action, and nothing names the field, so a listing of sixty actions fails
   * whole and the row points at the wrong thing. That is the same tool-and-version stranding the
   * three refusals above exist to prevent, arriving through the one field they skipped.
   *
   * REFUSED RATHER THAN DEFAULTED TO `""`, which is the other candidate repair and is the silent
   * one. The description is what a model reads to decide whether to call the action at all, and
   * `mcp_tools.description` is what an administrator grants against; recording "no description" for
   * an action Composio described is a wrong answer nobody can see, on a row that looks fine. The
   * refusal keeps every action, effect, version and grant the app already has, and says which
   * action it was while the listing that names it is still in hand.
   *
   * `null` IS ABSENCE HERE, for the reason the two guards above give on their own fields. "Composio
   * described this action in no words" is a real state with an answer already — `?? ""` has always
   * read it that way — and `null` is how JSON spells it. Refusing it would abort the whole app's
   * listing over a field that reads fine, permanently, which is the loss rather than the fix.
   *
   * READ AS `unknown` because the type above is this module's projection and the value is the
   * vendor's, and ASKED OF THE OFFERED ACTIONS because the map and the row are only about those.
   */
  const oddDescription = offered.find((action) => {
    const description: unknown = action.description;
    return (
      description !== undefined &&
      description !== null &&
      typeof description !== "string"
    );
  });
  if (oddDescription) {
    throw new Error(
      `Composio's action list for ${toolkit} described ${oddDescription.slug.trim()}'s description as something other than text, and the description is what a model reads to decide whether to call the action at all. Nothing was refreshed and the actions already recorded for this app are kept rather than replaced by a listing whose descriptions could not be read.`,
    );
  }

  /*
   * A FULL PAGE USED TO BE REFUSED HERE, AND THAT REFUSAL IS GONE BECAUSE ITS PREMISE WAS FALSE.
   *
   * It said that `LISTING_LIMIT` is the largest page the vendor's REST parameter allows and that
   * the core SDK offers no cursor to ask for a second one, so an app with exactly that many actions
   * and an app with more of them answer identically — and that committing the second deletes every
   * action past the cut from `mcp_tools` under a refresh that reported success. The consequence was
   * real and the premise was about the WRAPPER. `ToolListParamsSchema` names no cursor, but
   * `@composio/client`'s `ToolListParams` does, and its `ToolListResponse` carries `next_cursor`
   * (0.1.0-alpha.76, `resources/tools.d.ts:421-432`, `:200-204`). `./composio-adapter` reads that
   * client directly and follows the cursor to the end of the listing, so what arrives here is every
   * action the app publishes and a full page is just a large app. A refusal that cannot be told
   * from a healthy answer is one thing; a refusal that fires ON a healthy answer is another, and
   * this had become the second — the same defect, at the same ceiling, that emptied the app picker
   * one file over.
   *
   * NOTHING ELSE MOVED WITH IT. A listing that could not be read at all is still a throw rather than
   * an empty list, for the reason at the top of this function, and `store.ts`'s empty-listing guard
   * still keeps every recorded action when an app that HAS actions lists none. What is no longer
   * claimed is that a listing this long might be a fragment, because it cannot be: the adapter
   * refuses a cursor it cannot follow rather than handing over what it had.
   */

  /*
   * THE FILTER MAY SHORTEN A LISTING AND MAY NOT EMPTY ONE.
   *
   * Dropping an action is a standing decision about an action this deployment cannot serve, taken
   * the same way on every refresh, and the answer is still a listing. Dropping the last one is not
   * that: what leaves here is `[]`, which means "the vendor was asked and advertises nothing"
   * everywhere in this codebase, and `refreshTools` commits it as a healthy refresh — a delete and
   * an insert that takes every recorded action with its `effect`, `destructive` and, fatally, its
   * `version`, which no later refresh reconstructs where Composio publishes none. That is the same
   * tool-and-version wipe the empty answer, the unreadable answer and the slug-less action above
   * all refuse; arriving through this filter does not make it a different event.
   *
   * A vendor answer that was genuinely empty is left alone, because that one IS the vendor
   * advertising nothing and is the sentence `refreshTools` should record. Which is also the one
   * case `store.ts` settles rather than this file: its own empty-listing guard keeps what is held
   * whenever an app that HAS actions recorded answers with none, and lets the empty answer commit
   * where there is nothing to lose. What that guard cannot do is tell an app that listed nothing
   * from an app whose every action this deployment dropped, and the sentence it writes says the
   * first. So the emptying that happens HERE has to be refused HERE, where the count that makes
   * it true is still in hand.
   */
  if (actions.length > 0 && offered.length === 0) {
    throw new Error(
      `Every one of the ${actions.length} actions Composio listed for ${toolkit} asks for a file upload, which this deployment cannot stage, so there is none it can offer. Recording that would say the app advertises nothing and delete every action, effect and version already held for it, so nothing was refreshed and those are kept.`,
    );
  }

  return offered.map((action) => {
    const { effect, destructive } = effectOf(action.tags);
    /*
     * TRIMMED HERE BECAUSE IT IS TRIMMED AT THE OTHER END. {@link callTool} trims the recorded
     * version and refuses an empty one, so a whitespace-only string that counted as a version
     * was written to `mcp_tools` as a version this deployment believes it holds and was then
     * permanently uncallable — and the refusal its caller reads names a refresh, which records
     * the same blank again. Recording exactly what `callTool` will send is what closes that
     * loop; a blank becomes no version, which is the state whose refusal says so truthfully.
     *
     * WHAT THE `?.` GUARDS IS ABSENCE AND NOT TYPE, which is why this line is no longer the only
     * thing standing between the vendor's field and a `trim` that is not a function. A version
     * that is neither absent nor a string is refused above, beside the labels, where a sentence
     * can still name the action; here it cannot arrive.
     */
    const version = action.version?.trim();
    return {
      /*
       * TRIMMED FOR THE REASON THE VERSION BESIDE IT IS. The guard that admitted this action
       * measured `slug.trim()`, so padding was never what made it a name — but the padded string
       * was what got recorded: `mcp_tools.name` is NOT NULL and half the primary key, it is what
       * a grant points at, and {@link callTool} sends it back to Composio as the action's slug.
       * A row keyed on " GMAIL_SEND " is a different action from the one an administrator
       * granted and one Composio has never heard of.
       */
      name: action.slug.trim(),
      /*
       * WHAT THE `??` ANSWERS FOR IS ABSENCE AND NOT TYPE, which is why this line is no longer the
       * only thing between the vendor's field and `store.ts`'s `replaceAll`. A description that is
       * neither absent nor text is refused above, beside the version, where a sentence can still
       * name the action; here it cannot arrive. What is left for this line is the real absence —
       * no key, or a `null` — and `""` is the honest answer to it: the vendor said nothing, so this
       * deployment says nothing rather than inventing a sentence a model reads as the action's own.
       */
      description: action.description ?? "",
      /*
       * NOT GUARDED ABOVE, AND THAT IS A DECISION RATHER THAN THE SAME OMISSION AGAIN. Every other
       * field in this object has a reader that would break on the wrong shape: `slug` a name the
       * insert needs, `tags` a `Set` and an identity comparison, `version` and `description` a
       * `trim` and a `replaceAll`. A schema has no such reader. `parametersFor` in `./tools` says
       * outright that anything which is not an object schema is offered as an open one — the vendor
       * is the right party to reject a bad argument — and `storableSchema` in `./store` walks any
       * shape into the `jsonb` column. So an unreadable schema already has an answer that keeps the
       * action callable, and refusing the app's whole listing over it would cost more than it saves.
       */
      inputSchema: action.inputParameters ?? {},
      effect,
      destructive,
      ...(version ? { version } : {}),
    };
  });
}

/**
 * The one sentence in a thrown Composio error that is worth showing anybody.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE READ. The top-level message is "Error executing the tool
 * GMAIL_FETCH_EMAILS", which names nothing a reader could act on. The useful sentence — "No connected
 * account found for user ID … for toolkit gmail" — is nested two levels inside `cause`, beside the
 * entire HTTP response: headers, trace ids, rate-limit counters. So this reaches in for the sentence
 * and takes nothing else, because the alternative is somebody's request id in a model's context and
 * an audit row the size of a response dump.
 *
 * openbot already had this lesson from Drive, where a generic message cost a round of probing and the
 * vendor's own "The caller does not have permission" named the problem immediately.
 *
 * Null when there is no such sentence, which leaves the caller to choose a fallback rather than
 * inventing one here. That choice is not simply "the thrown message": the thrown message is often the
 * placeholder above, and passing it on tells the reader nothing. See {@link unexplained}.
 *
 * AND THE PLACEHOLDER IS NOT A SENTENCE WHEREVER IT SITS, which is the half this function was
 * missing. Both callers check {@link VENDOR_PLACEHOLDER} against the message that was THROWN and
 * both prefer this answer over that check, so "Error executing the tool X" arriving nested inside
 * `cause` — which is where the vendor puts it when their own gateway had nothing else to say —
 * went out past a guard written for exactly that string. A reader who asked for that tool learns
 * from it only that they asked; that is true at whatever depth it was found, so the judgement
 * belongs here, in the function whose whole job is deciding what is worth passing on.
 *
 * TRIMMED ON THE WAY OUT AND NOT ONLY IN THE GUARD. The two used to disagree — the guard measured a
 * trimmed string and the return handed back the padded one — so the decision the function had
 * already made about the string was thrown away at the last line. What comes out is read by a person
 * off an admin page, put in front of a model, and measured by {@link cap}, and in the third of those
 * the padding is counted against somebody's context window.
 *
 * AND IT IS LOOKED FOR AT BOTH DEPTHS THE VENDOR THROWS IT AT, which is the half that made this
 * function blind on five of this transport's calls. `cause.error.error.message` is the sentence
 * inside a wrapper — `ComposioToolExecutionError` keeps the API error as its `cause` — but
 * `@composio/core` 0.18.1 wraps only some of what it does. The auth-config and connected-account
 * listings and the raw tool listing all `await this.client.*` with no try around them
 * (`src/models/AuthConfigs.ts`, `src/models/ConnectedAccounts.ts`, `src/models/Tools.ts:552-555`),
 * and `./composio-adapter` calls both raw deletes on the client itself — so what those five throw
 * is `@composio/client`'s own `APIError`, which hangs the response body on `.error` and sets no
 * `cause` at all (`@composio/client` 0.1.0-alpha.76, `src/core/error.ts:9-24`). The sentence is one
 * level shallower there, and reaching past it cost the reader the vendor's own words on every one.
 *
 * WHAT IT COST THEM INSTEAD IS THE WHOLE REPLY. That class builds its own `message` as
 * `${"${status}"} ${"${JSON.stringify(body)}"}` wherever the body has no top-level `message`
 * (`src/core/error.ts:26-44`), and Composio's body puts its sentence at `error.message` — so the
 * fallback to the thrown message handed `lastError`, the audit row and a model's context a status
 * code followed by the entire response. See {@link VENDOR_RESPONSE_DUMP}, which refuses it.
 *
 * THE JUDGEMENT BELOW APPLIES AT BOTH DEPTHS, because that is why it lives in this function at all.
 * A second place to read the field would otherwise be a second way past the check on the vendor's
 * placeholder, on the blank string and on a `message` that is not a string — which is exactly the
 * bypass this function was written to close.
 */
export function vendorSentence(error: unknown): string | null {
  const thrown = schemaNode(error);
  for (const carrier of [thrown, schemaNode(thrown?.cause)]) {
    const body = schemaNode(carrier?.error);
    const sentence = passableSentence(schemaNode(body?.error)?.message);
    if (sentence !== null) return sentence;
  }
  return null;
}

/**
 * THE ONE DOOR. Whether a candidate string is worth showing anybody, and the trimmed string if so.
 *
 * EVERY READER OF A CANDIDATE SENTENCE IN THIS MODULE ASKS THROUGH HERE, and that is the whole
 * point of it rather than a tidiness. There are four places a string is picked up and handed to a
 * model, to an administrator reading `lastError` off the Plugins page, or to `store.ts`'s audit
 * row: the two depths {@link vendorSentence} reaches, the message a failure was THROWN with, the
 * `error` field of a resolved envelope, and the reason a serialization failed. Each of them used to
 * make this judgement itself, and the judgement then drifted — which is not a hypothesis. A first
 * extraction moved the blank and the placeholder rules into one place and left the `error` field
 * reading `VENDOR_PLACEHOLDER` inline; {@link VENDOR_RESPONSE_DUMP} was then added to the extracted
 * side only, so a status code followed by an entire response body was refused where it was thrown
 * and passed on where it was reported. The fix for that is not a third copy of the rule. It is that
 * there is nowhere left to put one.
 *
 * THREE REFUSALS, AND THEY ARE THE SAME REFUSAL. A blank string, "Error executing the tool X" and
 * "502 {…}" are one condition wearing three shapes: the vendor emitted something where an
 * explanation belongs and none of it explains anything. What each caller does about a null differs
 * — one falls through to the next depth, one to this deployment's own words — and that is the part
 * that belongs to the caller. What is NOT worth passing on does not vary by door, and the moment it
 * is allowed to, the guard is decoration.
 *
 * A NON-STRING IS NOT A SENTENCE, which is why the parameter is `unknown` rather than `string`. The
 * types in this file are its own projection of somebody else's JSON; a `message` that is a number,
 * an object or a list reaches a reader as `1810` or `[object Object]`, and collapsing all of those
 * to the blank case here is what stops each caller inventing its own `typeof`.
 */
function passableSentence(message: unknown): string | null {
  const sentence = typeof message === "string" ? message.trim() : "";
  return sentence === "" ||
    VENDOR_PLACEHOLDER.test(sentence) ||
    VENDOR_RESPONSE_DUMP.test(sentence)
    ? null
    : sentence;
}

/**
 * The vendor's placeholder, which is the one sentence never worth passing on.
 *
 * "Error executing the tool GMAIL_FETCH_EMAILS" tells a reader only the name of the thing they asked
 * for. Matched on its opening rather than on the whole string, because the slug varies and the
 * punctuation after it has not been stable across vendor versions.
 */
export const VENDOR_PLACEHOLDER = /^error executing the tool\b/i;

/**
 * The client's other non-sentence: a status code with the whole reply stringified behind it.
 *
 * `APIError` builds its `message` from the body's own `message` where there is one and otherwise
 * from `JSON.stringify(body)` (`@composio/client` 0.1.0-alpha.76, `src/core/error.ts:26-44`), and
 * Composio's bodies put their sentence at `error.message` instead — so the second branch is the
 * common one, and it is a response dump rather than an explanation. Handed on as the fallback it
 * put a trace id and a validation payload on an admin page, in `store.ts`'s audit row and in a
 * model's context, which is the one thing {@link vendorSentence} exists to keep out of all three.
 *
 * REFUSED ON THE SAME GROUNDS THE PLACEHOLDER IS, and no wider. What is matched is a three-digit
 * status followed by the opening of a JSON document, because that is the shape the client builds
 * and nothing a person would write; "404 status code (no body)" and a body whose own `message` came
 * through — "400 Invalid auth config id" — are both sentences, and both still pass.
 */
export const VENDOR_RESPONSE_DUMP = /^\d{3} [[{]/;

/**
 * The message a failure was THROWN with, where that is worth showing, and null where it is not.
 *
 * Its own function because both callers ask the identical question and one of them used to ask it
 * differently: a guard that grew a third refusal on one path and not the other would put the
 * vendor's response dump in front of a model or an operator depending on which door they arrived
 * through, which is the divergence `callTool`'s catch already had to be corrected for once.
 *
 * WHICH IS WHY THE JUDGEMENT ITSELF IS NOT HERE ANY MORE. This function once held all three
 * refusals, and holding them is what let it drift from the other readers — the dump rule was added
 * to this copy and to no other, so the escape it closed here stayed open on the envelope's `error`
 * field and at both depths {@link vendorSentence} reads. All this owes its callers now is WHICH
 * string is the candidate on a throw; {@link passableSentence} settles what any candidate is worth.
 */
function thrownSentence(error: unknown): string | null {
  return passableSentence(error instanceof Error ? error.message : null);
}

/**
 * What to say when the vendor reported a failure and said nothing about it.
 *
 * A sentence naming the one thing the reader can actually do, because the alternative is echoing the
 * placeholder above — and a model handed "Error executing the tool X" will either retry the identical
 * call or invent a reason. The likely cause by a wide margin is a connection that has lapsed, which
 * is a person's own two-click fix on the page named here.
 */
export function unexplained(toolName: string): string {
  return `${toolName} failed and Composio did not say why. Check that this app is still connected on its Plugins page, then try again.`;
}

/**
 * Whether a thrown failure is the SDK's own schema refusing the vendor's answer.
 *
 * Duck-typed rather than `instanceof ZodError` so this file keeps no dependency on the vendor's
 * package: `@composio/core` reaches it only through {@link useComposioClient}, and importing `zod`
 * here would tie the transport to whichever major version the vendor happens to bundle — which is
 * exactly the coupling that makes a schema mismatch possible in the first place.
 *
 * WHICH IS WHY THE SHAPE HAS TO BE ASKED FOR RATHER THAN THE NAME `issues`. An array under that
 * name is not rare and is mostly not Zod's: a gateway's validation payload carries one, and so
 * does any error somebody wrote with a list of complaints in it. Answering true for those replaced
 * the one sentence saying what actually went wrong with an instruction to upgrade a package that
 * is working perfectly — the vendor's own explanation, hidden by a guess about who threw.
 *
 * A ZOD ISSUE IS RECOGNISED BY WHAT EVERY VERSION OF ONE CARRIES: a `code` naming the failure and
 * a `path` locating it. Both have been in the type since zod 3 and neither belongs to the
 * hand-written lists above. An empty array is nobody's schema complaint — a parse that refused
 * says why — so it is not one either.
 */
function isSchemaMismatch(error: unknown): boolean {
  const shaped = error as
    | { name?: unknown; issues?: unknown }
    | null
    | undefined;
  /*
   * THE NAME IS READ AS THE WORD IT IS, for the reason `conditionOf` in `./composio-adapter` reads
   * the same field that way: a class name is a discriminator compared against a literal, so padding
   * is whatever the wire or a wrapper put around it rather than part of the name. It costs less here
   * than it does there — the shape test below answers for a padded `ZodError` anyway — which is
   * exactly why the two readings of one kind of value should not differ between the two files.
   */
  const thrown = shaped?.name;
  if (typeof thrown === "string" && thrown.trim() === "ZodError") return true;

  const issues = shaped?.issues;
  return (
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.every((issue) => {
      const node = schemaNode(issue);
      return typeof node?.code === "string" && Array.isArray(node.path);
    })
  );
}

/**
 * Why an app's action list could not be read, as one sentence an operator can act on.
 *
 * The schema case names the fix, because it is a vendor change rather than a misconfiguration: the
 * answer arrived and this deployment's copy of their SDK would not accept it, so nothing an
 * administrator can do to this row will help and upgrading the package will.
 *
 * IT IS A CLAIM ABOUT THE SEAM NOW RATHER THAN ABOUT THE ADAPTER, which is worth saying because it
 * used to be the other way round. This branch was written for `getRawComposioTools`, whose last act
 * was `ToolSchema.parse`, and the listing does not go through it any more: `./composio-adapter`
 * reads `client.tools.list`, which parses nothing, so today's implementation of
 * {@link ComposioActions.listActions} cannot raise a `ZodError` here. What the branch still covers
 * is the seam — a `ComposioActions` is anything satisfying two methods — and a sentence naming the
 * package remains the only useful thing to say about a zod complaint arriving through one. Deleting
 * it would leave that answer to be reconstructed by whoever meets it; what would be wrong is
 * keeping a comment that says the adapter throws it.
 *
 * THE PLACEHOLDER IS REFUSED HERE ON THE SAME GROUNDS {@link callTool} REFUSES IT, which is the
 * half this function was missing. "Error executing the tool X" names only the thing the reader
 * asked for; on this path they asked to refresh an app, so it is the one fact they already had.
 * Falling through to the app's name at least tells them which row went wrong.
 *
 * AND A SENTENCE THIS DEPLOYMENT AUTHORED BEATS ANYTHING THE VENDOR SAID, which is the half it was
 * missing after that. This function consulted `brokerSentence` nowhere at all, and it is the rule
 * `routes.ts` follows (`brokerRefusal`, `:89-91`) and the rule {@link callTool}'s own catch was
 * corrected to. `./composio-adapter`'s `askVendor` wraps the raw tool listing exactly as it wraps
 * the execute, so a {@link BrokerRefusalError} arrives on this path as readily as on that one —
 * and the class is the promise that makes preferring it safe: `./broker` raises one only where the
 * sentence names the step that fixes the condition and is safe to show anybody who could have
 * asked. A failure it cannot explain stays a plain `Error` and falls through to the vendor's own
 * words below, exactly as before.
 *
 * WHAT IT WAS LOSING TO IS A READ ONE LEVEL SHALLOW, the same way `callTool`'s was. `vendorRefusal`
 * authors only where {@link vendorSentence} of the ORIGINAL error was null, so the vendor keeps the
 * last word wherever it had one; asking the same question of the WRAPPER reaches through its
 * `cause` to the original and lands somewhere the adapter never judged. A remedy written for the
 * exact condition was being replaced by whatever happened to sit there.
 */
function listingSentence(toolkit: string, error: unknown): string {
  const authored = brokerSentence(error);
  if (authored !== null) return authored;

  if (isSchemaMismatch(error)) {
    return `Composio's action list for ${toolkit} did not match the shape this deployment's @composio/core accepts, so the list was not refreshed and the tools already held are untouched. That is a vendor change rather than a setting: upgrading the package is the fix.`;
  }
  return (
    vendorSentence(error) ??
    thrownSentence(error) ??
    `Composio did not answer with an action list for ${toolkit}.`
  );
}

/**
 * The cap every string this module puts in front of a model goes through.
 *
 * Its own function because BOTH ANSWERS NEED IT, and only one of them used to get it. A refusal lands
 * in a model's context exactly as a result does, and a vendor's sentence is no shorter for being a
 * failure — so {@link failure} capping nothing and reporting `truncated: false` was the silent
 * truncation's mirror image: unbounded text, plus a field stating that nothing had been cut.
 */
function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated]`,
    truncated: true,
  };
}

const failure = (message: string): McpCallResult => ({
  ...cap(message),
  isError: true,
});

/**
 * The three fields a resolved answer has to carry to be the envelope at all.
 *
 * Named as a list because the refusal below quotes it: the sentence tells a reader that a
 * `{ data, error, successful }` envelope was required, and the only way that claim stays true as
 * the check changes is if the claim and the check read the same names.
 */
const ENVELOPE_FIELDS = ["data", "error", "successful"] as const;

/**
 * What is missing before a resolved value can be read as Composio's envelope, or null for one.
 *
 * ASKED AS "IS IT THE ENVELOPE" RATHER THAN "IS IT AN OBJECT", which is the correction, and the
 * third one this guard has needed. Written as a bare `typeof` it admitted arrays; written as
 * {@link schemaNode} it admitted every other object in the world. Both fixes widened the coverage
 * of a question that was the wrong question: the refusal has always told the reader that the
 * `{ data, error, successful }` envelope was required, and nothing anywhere was checking for one.
 * So a one-level-unwrapped envelope — the action's own `data` in the envelope's place, which is
 * what a client that reaches one field too far resolves — and a bare `{}` both cleared it, read
 * `error` and `successful` as absent, reported nothing, and came back `isError: false` saying "The
 * action returned nothing." `store.ts` wrote `mcp.call_succeeded` beside each one. A shape this
 * deployment could not read reaching a model as a call that worked and found nothing is the exact
 * outcome the third kind of failure exists to keep off the audit trail, and it survived two fixes
 * because each of them asked for a wider class of the wrong thing.
 *
 * ABSENCE IS THE QUESTION HERE AND TYPE IS NOT, which is the line between this and
 * {@link reportedFailure}. This one settles whether the right OBJECT arrived — whether what
 * resolved is the envelope or something else entirely. What the vendor put IN each field, and
 * whether it is readable, is a separate question asked once the envelope is in hand, and it is
 * asked there because the answer differs per field: an unreadable `error` and an unreadable
 * `successful` produce different sentences, and neither is "this is not an envelope".
 *
 * A FIELD PRESENT AS `undefined` COUNTS AS ABSENT, because no reader downstream can tell the two
 * apart and neither can the schema: `ToolExecuteResponseSchema` spells all three REQUIRED
 * (`@composio/core` 0.18.1), so a key holding nothing is as far from that shape as no key at all.
 * `error` is nullable and `null` is therefore present, which is the one distinction that matters.
 */
function envelopeGap(answer: unknown): string | null {
  const node = schemaNode(answer);
  if (node === null) return "what came back was not one";

  const absent = ENVELOPE_FIELDS.filter((field) => node[field] === undefined);
  return absent.length === 0
    ? null
    : `what came back carried no ${absent.join(" and no ")}`;
}

/**
 * The serializations that mean the action had nothing to say.
 *
 * `{}` is in here because `data` is a required RECORD: an action that matched nothing answers with an
 * empty object, so if that did not count as nothing the branch below would be unreachable and its
 * promise a fiction. `""` and `"null"` stay for a client whose projection is looser than the schema.
 */
const NOTHING = new Set(["", "null", "{}"]);

/**
 * What the model reads, capped visibly.
 *
 * THE ACTION'S DATA, NOT THE WHOLE ENVELOPE. `error`, `successful` and `logId` are what
 * {@link callTool} reads to decide the outcome; repeating them as content spends a model's context on
 * this transport's own bookkeeping and invites the model to draw its own conclusion from a field it
 * should never have seen.
 *
 * The same cap the MCP transport applies and for the same reason: a tool result goes straight into a
 * model's context, so an unbounded one is somebody else's server deciding how much of our context
 * window to spend. Truncated visibly, never silently. An empty answer is stated in words rather than
 * returned empty — an empty string reads as "the action had nothing to say" rather than "there is
 * nothing there", and a model closes that gap from memory.
 *
 * CAN THROW, and is called from outside the vendor's `try` for that reason. See {@link callTool}.
 */
function resultOf(data: ComposioResult["data"] | undefined): McpCallResult {
  const text: string | undefined = JSON.stringify(data ?? null, null, 2);
  /*
   * `JSON.stringify` ANSWERS `undefined` RATHER THAN THROWING for a value with no JSON form — a
   * function, a symbol — and this field is the vendor's while the type saying it is a record is
   * ours. That `undefined` went on to {@link cap}, which measures `.length`, so the engine's
   * `undefined is not an object (evaluating 'text.length')` became the second half of a sentence
   * this file wrote about its own failure. Thrown here instead, in words, because the caller's
   * catch is what turns this into a refusal naming the action.
   */
  if (text === undefined) {
    throw new Error(
      "its data has no JSON form at all, so there is nothing to show",
    );
  }
  if (NOTHING.has(text)) {
    return {
      text: "The action returned nothing.",
      isError: false,
      truncated: false,
    };
  }
  return { ...cap(text), isError: false };
}

/**
 * What the vendor said about its own call, read from BOTH fields its schema requires it to send.
 *
 * EITHER ONE CAN REPORT A FAILURE, and reading only the flag dropped the other. `successful ===
 * false` is the plain case. The second is an `error` sentence arriving beside `successful: true`:
 * `ToolExecuteResponseSchema` spells the two as independent required fields and correlates them
 * nowhere, and `transformToolExecuteResponse` copies both straight off the wire (`@composio/core`
 * 0.18.1, `src/models/Tools.ts:215-222`), so that combination is a shape the vendor's own schema
 * permits. Keyed on the flag alone it was audited as `mcp.call_succeeded` and the one sentence
 * saying what went wrong was shown to nobody.
 *
 * TAKING THE ERROR AT ITS WORD IS THE VENDOR'S OWN ARITHMETIC rather than a rule invented here:
 * where the SDK has to derive the flag itself it writes `successful: !response.error` (`:1247`). It
 * is also the reading this file already applies to a vendor contradicting itself — see
 * {@link effectOf} on `destructiveHint` beside `readOnlyHint`.
 *
 * WHICH IS EQUALLY WHY THE CRITERION IS A NON-EMPTY SENTENCE. By that same line `""` is a success,
 * so an empty `error` is the vendor saying nothing went wrong in the least committal way open to it.
 * Whitespace is read as empty too, and that part is this file's own reading rather than the SDK's —
 * it matches {@link vendorSentence}, because a blank sentence beside an explicit `successful: true`
 * would otherwise become a refusal saying only that the call failed and nobody said why.
 *
 * AND THE FLAG IS READ FOR ITS SHAPE BEFORE IT IS READ FOR ITS VALUE, which is the half this
 * function was missing for as long as the `error` beside it had it. `successful !== false` asked
 * one question of a field with three answers: `"false"`, `0` and `null` are none of them `false`,
 * so each one passed as a success, and a reported failure was handed to the model as content and
 * written to the audit trail as `mcp.call_succeeded`. Falsiness is not the repair either — it
 * answers `"false"` correctly by accident, since a non-empty string is truthy, and would still
 * take `0` for a considered "no" rather than for a field nobody here can read.
 *
 * SO A NON-BOOLEAN IS THE THIRD KIND OF FAILURE, exactly as an unreadable `error` is, and it gets
 * the wording that kind is owed: nothing was reported, so nothing can be passed on as the vendor's
 * report, and what this deployment has to say is that it cannot tell whether the action ran. The
 * old comment here argued that an ABSENT flag must not be read as a failure, which was right and
 * is now settled one step earlier — {@link envelopeGap} refuses an answer that carries no
 * `successful` at all, as not being the envelope. What is left to this function is a field that
 * arrived, and a field that arrived saying something unreadable is the vendor speaking, not the
 * vendor silent.
 *
 * THE VENDOR'S OWN SENTENCE STILL COMES FIRST, which is why the shape check sits below the
 * sentence rather than above it. `{ error: "Gmail rejected the query", successful: "false" }` is a
 * failure whichever way the flag is read, and the reader is better served by what Composio said
 * about it than by this file's remark that the flag was malformed. The check is reached only where
 * the alternative would be calling the answer a success.
 *
 * AN `error` THAT IS NOT A SENTENCE IS NOT SILENCE, and reading the field through a `typeof` that
 * collapsed everything else to `""` made the two indistinguishable. `{ message: … }`, or the list
 * of issues a gateway puts there, arriving beside `successful: true` came out of here as null: the
 * call was handed to the model as content, `store.ts` audited `mcp.call_succeeded`, and the field
 * the vendor put its complaint in was shown to nobody. Which branch it takes turns on the flag,
 * because the two say different things. Beside `successful: false` the vendor has already reported
 * the failure and only its reason is unreadable, which is what {@link unexplained} is for. Beside
 * anything else nothing here knows whether the action ran at all — the third kind of failure
 * {@link callTool} names, ours rather than the vendor's, and so worded in our own words.
 *
 * Null when there is nothing to report, so the caller can tell "succeeded" from "failed silently".
 *
 * AND EVERY BRANCH SAYS WHETHER COMPOSIO ANSWERED ABOUT THE CALL, which is the second thing this
 * function has always decided and never said out loud. Read the sentences below: three of them end
 * "so nothing here can tell whether the action ran", and the other two are the vendor reporting a
 * failure of a call it made. That is exactly the {@link ActionAnswer} split — a failure OUT THERE
 * against a failure to find out — and returning it beside the sentence is what keeps the two from
 * being re-derived by matching on prose. See {@link ActionAnswer} for who needs the distinction and
 * what it destroyed while nothing carried it.
 */
function reportedFailure(
  answer: ComposioResult,
  toolName: string,
): { sentence: string; answered: boolean } | null {
  // Both fields are read as `unknown` because the types are this module's projection and the values
  // are the vendor's: `ToolExecuteResponseSchema` spells `error` a nullable string and `successful`
  // a boolean, and a field that is neither is exactly what the two shape checks below are for.
  // Neither can be absent — {@link envelopeGap} settled that before this was called.
  const reported: unknown = answer.error;
  const outcome: unknown = answer.successful;

  if (reported !== null && typeof reported !== "string") {
    return outcome === false
      ? { sentence: unexplained(toolName), answered: true }
      : {
          sentence: `${toolName} was sent to Composio and Composio answered, but this deployment could not read what it said about the call: the answer's error was neither a sentence nor null, which is all Composio's own schema permits it to be, so nothing here can tell whether the action ran.`,
          answered: false,
        };
  }

  /*
   * THE SAME DOOR THE THROWN MESSAGE GOES THROUGH, which is the correction, and it is the one this
   * whole extraction was made for. This branch tested {@link VENDOR_PLACEHOLDER} inline while
   * {@link thrownSentence} had grown {@link VENDOR_RESPONSE_DUMP} beside it — so one condition, an
   * unreadable non-explanation in the `error` field, was answered two different ways depending on
   * whether Composio threw it or reported it in a 200, and on this side a status code followed by
   * the whole response body went to the model as the vendor's report and into `store.ts`'s audit
   * row beside it.
   *
   * THE PRESENCE TEST STAYS SEPARATE FROM THE JUDGEMENT, because the two answer different
   * questions and only one of them is the door's. A blank `error` means the vendor reported NO
   * failure and the flag below decides the outcome; a non-blank one this deployment will not pass
   * on means the vendor reported a failure it cannot explain, which is exactly {@link unexplained}.
   * Collapsing both to null here would turn the second into a success.
   */
  const sentence = reported === null ? "" : reported.trim();
  if (sentence !== "") {
    return {
      sentence: passableSentence(sentence) ?? unexplained(toolName),
      answered: true,
    };
  }

  if (typeof outcome !== "boolean") {
    return {
      sentence: `${toolName} was sent to Composio and Composio answered, but this deployment could not read whether the call worked: the answer's successful was neither true nor false, which is all Composio's own schema permits it to be, so nothing here can tell whether the action ran.`,
      answered: false,
    };
  }

  return outcome === false
    ? { sentence: unexplained(toolName), answered: true }
    : null;
}

/**
 * Call one action, in the account of the person this run belongs to.
 *
 * `args` is passed through with only the reserved version key removed, and is never read for an
 * identity. See the module comment: that is the property, and it holds because there is no line here
 * that could break it.
 *
 * A failure comes back as a result rather than a throw, matching `builtin-routines`. The model is
 * mid-run with a person waiting; an exception ends the turn with nothing said, and the refusal is in
 * the audit trail either way.
 *
 * THE APP THIS CALL RUNS AGAINST IS THE ONE THE URL NAMES RIGHT NOW, and it goes out WITH the call
 * rather than being checked beside it. `toolkitOf`'s answer used to be validated and then dropped,
 * which left the brokered gate and the vendor's call resting on two different facts — the app the
 * url names today, and the app whose listing recorded the slug. See {@link ComposioActions.execute}
 * for why the pair has to travel together and what an implementation owes it.
 *
 * THREE KINDS OF FAILURE, all of them `isError: true` and each with its own sentence, because
 * `store.ts` records that sentence beside the audit row: this transport refused before dialling, the
 * vendor reported a failure — by throwing, or in the `successful` field of a 200 answer — or the
 * vendor answered and this deployment could not read what it said. Only the last of those is ours,
 * and it must not arrive wearing the vendor's words.
 *
 * AND THE FLAG DOES NOT SAY WHICH OF THE THREE THIS IS, which is fine for a model reading a result
 * and is not fine for a caller writing down what the vendor made of a credential. {@link askAction}
 * is this same call answering that as well; this function is it with the answer dropped, so nothing
 * classifies a failure twice. See {@link ActionAnswer} for what reading `isError` as a verdict cost.
 */
export async function callTool(
  connection: { url: string; actorId?: string; accountId?: string | null },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  return (await askAction(connection, toolName, args)).result;
}

/**
 * What a call did, with the one fact `McpCallResult` has no room for: whether Composio ANSWERED.
 *
 * `isError` says a call did not work and cannot say what that is evidence OF, because the three
 * kinds of failure {@link callTool} documents all wear it. Two of them are failures to find out —
 * this transport refusing before it dialled, and an answer this deployment could not read — and
 * only the third is Composio running the action in somebody's account and reporting what came back.
 * For a model reading a result that difference does not change anything: the call did not work and
 * the sentence says why, which is why {@link callTool} still answers the flat shape and every
 * ordinary caller goes on using it.
 *
 * FOR A CALL THAT IS A VERIFICATION IT IS THE WHOLE MEANING. `probeBrokeredConnection` spends one
 * call to find out whether a key works and writes the answer down as a verdict on somebody's
 * account — so reading `isError` as that verdict made a COMPOSIO OUTAGE into a rejected key, and
 * the consequences were destructive at both callers: on connect the account the person had just
 * made was deleted at the vendor and they were told what they entered did not work; on re-check a
 * working connection's verification was cleared and its row marked as holding a bad key. A vendor
 * nobody could reach is a fourth thing beside connected, checked and works, and it has no state on
 * the row because it is not a fact about the connection at all — it is the absence of one.
 *
 * `answered: true` IS NARROW ON PURPOSE, and it is exactly one thing: Composio resolved with its
 * envelope, this deployment could read it, and what it said — a result, or the app's own error — is
 * a statement about the call that ran. Everything else is `false`, INCLUDING the failures that are
 * this deployment's own fault, because a caller asking "may I treat this as a verdict" is owed the
 * same no for a package that cannot parse an answer as for a socket that closed. The direction to
 * be wrong in is settled by what each mistake costs: a reachable vendor misread as unreachable
 * leaves a key unchecked, which the Re-check button fixes, and an unreachable vendor misread as a
 * refusal destroys an account somebody had just made.
 */
export type ActionAnswer = {
  /** What a model reads, and what {@link callTool} hands back unchanged. */
  result: McpCallResult;
  /** Whether Composio ran the action in the account and said how it went. See above. */
  answered: boolean;
};

/**
 * The same call as {@link callTool}, answering whether the vendor was reached as well as how it went.
 *
 * ONE IMPLEMENTATION AND NOT TWO, which is the point of the shape rather than a convenience.
 * `callTool` is this function with the reachability dropped, so the verification path and every
 * ordinary tool call dial identically, classify identically, and cannot come apart — and a new
 * refusal added below is forced to say which kind it is at the moment it is written, rather than
 * being sorted into a kind afterwards by matching on the sentence it happens to carry.
 */
export async function askAction(
  connection: { url: string; actorId?: string; accountId?: string | null },
  toolName: string,
  args: Record<string, unknown>,
): Promise<ActionAnswer> {
  /**
   * Everything that is not the vendor answering. See {@link ActionAnswer}: a transport refusing
   * before it dials and an answer nothing here can read are both "no verdict", however different
   * their remedies are for the person reading the sentence.
   */
  const unreached = (message: string): ActionAnswer => ({
    result: failure(message),
    answered: false,
  });

  const userId = connection.actorId?.trim();
  if (!userId) {
    return unreached(
      "This action runs in the account of the person asking, and this run is not attributed to anybody.",
    );
  }

  const toolkit = toolkitOf(connection.url);
  if (!toolkit) {
    return unreached(`${connection.url} does not name a Composio app.`);
  }
  if (!installed) {
    return unreached(
      "Composio is not configured for this deployment, so this action cannot be called.",
    );
  }

  const { [VERSION_ARG]: rawVersion, ...rest } = args;
  const version = typeof rawVersion === "string" ? rawVersion.trim() : "";
  if (!version) {
    /*
     * Refused rather than guessed. Composio will not execute an action without a specific version and
     * rejects `latest`, so there is no default to fall back on — and a version invented here would be
     * a call against some other revision of the action, whose arguments and behaviour are not the ones
     * that were listed, classified and granted.
     *
     * THE REMEDY IS CONDITIONAL ON THE VENDOR, and this sentence used to state it as certain.
     * "Refresh this app's tools and try again" is right for one of the two causes — a list recorded
     * before the version column existed — and wrong for the other. Where Composio published no
     * version for the action, {@link listTools} records none, `store.ts` writes `tool.version ??
     * null`, and the next refresh writes the same null back: the reader presses the button, is told
     * nothing changed, and presses it again. So the sentence names the refresh and names the
     * condition under which it helps, which is the part nobody in this deployment controls.
     */
    return unreached(
      `${toolName} has no recorded version, so it cannot be called: Composio requires a specific one and rejects "latest", so there is nothing to fall back on. Refreshing this app's tools on its Plugins page recovers it only if Composio publishes a version for this action. Where Composio publishes none, no refresh will make it callable.`,
    );
  }

  /*
   * AND THE ACCOUNT THIS CALL NAMES IS READ THE WAY THE PERSON ABOVE IT IS, WHICH IS THE GUARD IT
   * WAS OWED AND DID NOT GET.
   *
   * The pin travelled on `=== undefined` alone, so everything else went to the wire as an EXPLICIT
   * `connected_account_id` — a blank string, or the `null` a nullable column spells absence with.
   * Both are the defect pinning was added to end, arriving from the two opposite sides: a pin at an
   * account nothing holds, and a pin nobody meant that turns the app-level question a re-check asks
   * into a named one. `probeBrokeredConnection` spends a single call to find out whether ONE key
   * works and writes the answer down as a verdict on the account that key just made, so a pin that
   * misses is a verdict about a different account — a working connection condemned, or a bad key
   * verified by the person's other one.
   *
   * ABSENT IS STILL A REAL ANSWER AND IS STILL UNPINNED, which is what `null` is read as here for
   * the reason the tags and version guards read their own nulls that way: `composio_connections`
   * records no account id, so a re-check genuinely names none, and a Bot's ordinary tool call names
   * none either. What is refused is the OTHER thing — a value that is PRESENT and is not an
   * account id — because dropping that one silently is the unpinned call the paragraph above is
   * about, and sending it is a call into an account nobody holds.
   */
  const pinned = connection.accountId;
  const account =
    typeof pinned === "string" && pinned.trim() !== "" ? pinned.trim() : null;
  if (pinned !== undefined && pinned !== null && account === null) {
    return unreached(
      `This call names one account of this person's for ${toolName} to run in, and what it was handed is not an account id, so nothing was sent. An unpinned call runs in whichever account Composio picks, and a verdict written off that is a verdict about a different account.`,
    );
  }

  /*
   * THE VENDOR'S TRY HOLDS THE VENDOR'S CALL AND NOTHING ELSE.
   *
   * `resultOf` used to be invoked inside it, so a `JSON.stringify` throw of ours — a circular
   * reference, a BigInt, a RangeError on something enormous — was reported as the action having
   * failed after it ran. Those are two different events: in one the vendor refused, in the other the
   * vendor did its part and this deployment could not read the answer. The audit trail has to be able
   * to tell them apart, and it cannot if both arrive wearing the vendor's words.
   */
  let answer: ComposioResult;
  try {
    answer = await installed.execute(
      {
        toolkit,
        slug: toolName,
        userId,
        version,
        /*
         * FORWARDED AND NEVER RESOLVED, and absent where the caller named none. A Bot's tool call
         * means "in this person's account at this app" and any account they hold satisfies it; a
         * verification means one account in particular, and the difference is the caller's to
         * state. See {@link ComposioActions.execute}.
         */
        ...(account === null ? {} : { connectedAccountId: account }),
      },
      rest,
    );
  } catch (error) {
    /*
     * A SENTENCE THIS DEPLOYMENT AUTHORED BEATS ANYTHING THE VENDOR SAID, and the order was
     * inverted here against the one `routes.ts` uses on the identical class of error.
     *
     * `brokerRefusal` in that file reads `brokerSentence` first and falls back to `vendorSentence`
     * (`routes.ts:89-91`); this catch read `vendorSentence` first and reached `error.message` only
     * where that found nothing. Both see the same throws — `./composio-adapter`'s `askVendor`
     * raises a {@link BrokerRefusalError} out of the execute path as readily as out of a listing —
     * so one vendor condition was being answered with two different sentences depending on which
     * door the reader came through, and on this door the authored one lost.
     *
     * WHAT IT LOST TO IS WORSE THAN A TIE. `vendorRefusal` authors a refusal only where
     * `vendorSentence(error)` was null — that is its documented limit, so the vendor gets the last
     * word wherever it had one. Reading `vendorSentence` again on the WRAPPER is therefore not
     * reading the same thing twice: the wrapper's `cause` is the original error, so the reach for
     * `cause.error.error.message` lands one level shallower than it did on the original and can
     * come back with a string the adapter had already judged not to be the vendor's explanation.
     * A remedy written for the exact condition — "disconnect the account they already hold", "a
     * dated version is recorded when an app's actions are listed" — was being replaced by whatever
     * that shallower read happened to find.
     *
     * THE CLASS IS THE PROMISE, which is what makes preferring it safe. `./broker` raises one only
     * where the sentence names the step that fixes it and is safe to show anybody who could have
     * made the request; a failure it cannot explain stays a plain `Error` and falls through to the
     * vendor's own words below, exactly as before.
     */
    const authored = brokerSentence(error);
    if (authored !== null) return unreached(authored);

    /*
     * THE SDK'S OWN PARSE THROWS THROUGH HERE, and its message is not a sentence.
     *
     * `./composio-adapter` resolves the tool before running it — `getRawComposioToolBySlug`, which
     * runs `ToolSchema.parse` — and that happens outside the SDK's own try, so a vendor answer
     * their schema rejects arrives as a raw `ZodError` whose `message` is the issue array as JSON.
     * Handed on, 400 characters of `{"code":"invalid_type","path":[…]}` went into a model's
     * context and into `store.ts`'s audit row, wearing the vendor's words for what is a version
     * skew between this deployment and their package.
     *
     * The listing path has refused that string since it was written, and for the same reason it
     * says here: nothing an administrator does to this connection will help, and upgrading the
     * package will. There is no `cause` to hang the original on either, because a failure leaves
     * this function as a RESULT rather than as a throw — so the sentence is the whole of what the
     * reader and the audit row get, which is why it names the one step that changes anything.
     *
     * WHAT IT DOES NOT CLAIM IS THAT NOTHING RAN. The resolve is the likely thrower and it happens
     * first, but the SDK parses the execute response through a schema of its own, so the same
     * `ZodError` can arrive from after the action ran. Which of the two it was is exactly what
     * this deployment cannot read, and a refusal must not settle it by guessing.
     */
    if (isSchemaMismatch(error)) {
      return unreached(
        `Composio was asked about ${toolName} and this deployment's @composio/core would not accept what came back: it did not match the shape that package parses with, so nothing here can say whether the action ran. That is a vendor change rather than a setting on this connection — upgrading the package is the fix.`,
      );
    }
    /*
     * The vendor's own sentence when there is one, because a generic message costs a diagnosis.
     *
     * AND A THROW IS NEVER A VERDICT, whosever words it arrives in. This is where an outage lands —
     * a socket that closed, a gateway, Composio down, the SDK refusing before the request — and it
     * is also where a broker refusal about this deployment's own state lands. NONE of them show
     * that the action ran in anybody's account: what the sentence is for is the person reading it,
     * and what {@link ActionAnswer} answers is whether a caller may write a verdict down. A vendor
     * that genuinely refused a call reports it in the envelope below, which is the one branch that
     * says it did.
     */
    return unreached(
      vendorSentence(error) ?? thrownSentence(error) ?? unexplained(toolName),
    );
  }

  /*
   * NOTHING IS READ OFF THE ANSWER UNTIL IT IS AN ENVELOPE, and here the reason is stronger than
   * the listing's. {@link callTool} is documented as never throwing and `store.ts` relies on that,
   * so a shape this module did not expect has to become a refusal rather than an exception.
   * `reportedFailure` reads `answer.successful` and was called from outside every try, so a client
   * resolving null threw a `TypeError` straight out of here — ending a person's turn mid-run with
   * nothing said and nothing audited, which is exactly what returning a result instead of throwing
   * exists to prevent.
   *
   * A vendor fault it is not, so it does not get the vendor's words. This is the third kind of
   * failure the comment above names: Composio answered and this deployment could not read it.
   *
   * THE QUESTION IS ASKED THROUGH {@link envelopeGap}, which is the one that names what is wrong
   * as well as that something is. Two earlier versions of this guard asked only whether an object
   * had arrived and let every object through, including the two this refusal was written about;
   * see that function for why the shape of the question was the defect rather than its reach.
   */
  const gap = envelopeGap(answer);
  if (gap !== null) {
    return unreached(
      `${toolName} was sent to Composio and its client resolved, but this deployment could not read what it resolved with: Composio's own schema requires a { data, error, successful } envelope and ${gap}, so nothing here can tell whether the action ran. That is a change in what the vendor or this deployment's @composio/core answers with rather than a setting on this connection — upgrading the package is the fix.`,
    );
  }

  /*
   * THE ONE BRANCH THAT CAN BE A VERDICT, and it carries its own answer to that rather than being
   * judged here — see {@link reportedFailure}, where three of the five outcomes are this deployment
   * failing to read what arrived and two are Composio reporting a call it made.
   */
  const reported = reportedFailure(answer, toolName);
  if (reported !== null) {
    return { result: failure(reported.sentence), answered: reported.answered };
  }

  try {
    // The action ran and Composio answered, which is the plainest `answered` there is.
    return { result: resultOf(answer.data), answered: true };
  } catch (error) {
    /*
     * THE LAST PATH THAT REACHED A MODEL WITHOUT PASSING THE DOOR. This quoted a raw `error.message`
     * into the sentence `store.ts` records, asking nothing of it — the one refusal in this module
     * that read a candidate string and judged it nowhere.
     *
     * WHAT IT CAN BE HANDED IS NOT ONLY OURS. `resultOf`'s own throw is this file's sentence and
     * the engine's circular-reference and length errors are the engine's, but `JSON.stringify`
     * calls `toJSON` on whatever the vendor put in `data`, so a throw out of there arrives wearing
     * whatever the vendor's object felt like throwing — the same class of string refused four lines
     * above, arriving through the one reader that was not asking.
     *
     * A REASON IT WILL NOT QUOTE STILL LEAVES A FINISHED SENTENCE, which is why the fallback is a
     * clause rather than nothing. What this refusal has to carry is which of the two events it was:
     * the action ran, Composio answered, and it is this deployment that could not read the answer.
     * That claim is ours and holds whether or not there is a reason worth repeating.
     *
     * `String(error)` KEEPS THE NON-`Error` THROW READABLE, which {@link thrownSentence} does not
     * do and should not: there the alternative is the vendor's own sentence one level in, and here
     * there is no other candidate at all.
     */
    const why =
      passableSentence(
        error instanceof Error ? error.message : String(error),
      ) ?? "the reason it failed with is not one this deployment will pass on";
    /*
     * AND NOT A VERDICT EITHER, THOUGH THE VENDOR ANSWERED — which is the one classification here
     * that is worth a sentence, because the answer really did arrive and really did say the call
     * worked. What did not arrive is a reading of it: this is the third kind of failure, ours, and
     * {@link ActionAnswer} is asked by a caller deciding whether to write down what the vendor made
     * of somebody's credential. A refusal whose own sentence says this deployment could not read
     * the answer is not a thing to record a verdict from, in either direction.
     */
    return unreached(
      `${toolName} ran and Composio answered, but this deployment could not turn that answer into text: ${why}`,
    );
  }
}
