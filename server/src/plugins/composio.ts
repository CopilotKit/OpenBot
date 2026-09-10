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
 * would have to arrive through a setter rather than a constructor — the registry is built at import
 * time, long before anything has read configuration. {@link useComposioClient} is that setter.
 *
 * NOTHING IN THE SHIPPED PRODUCT CALLS IT. There is no adapter under `server/src`: the only caller
 * is the test suite. So on every real deployment `installed` is null, which is a state this module
 * is written for rather than an outage — {@link listTools} throws a sentence saying so and
 * {@link callTool} refuses with one. Read every mention of "the client" below as a description of
 * the seam an adapter would plug into, not of wiring that exists.
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
 * How many actions one listing asks for, which is as many as this SDK can be made to answer with.
 *
 * A NUMBER RATHER THAN NO NUMBER, because omitting it is not "no opinion". Composio's page defaults
 * to 20 and Gmail publishes 63 actions, so an omitted limit truncates — and worse, it NARROWS:
 * `getRawComposioTools` sets `important=true` whenever the query named toolkits and gave no limit,
 * no tags and no search (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), so the short
 * answer is a filtered one and nothing in it says a filter was applied. Passing a limit is what
 * turns the flag off.
 *
 * 1000 BECAUSE THAT IS THE CEILING, not because it is generous. The REST parameter documents "max
 * allowed is 1000" (`@composio/client` 0.1.0-alpha.76, `resources/tools.d.ts:441-444`), and the
 * core SDK exposes no way to go past it: `ToolListParamsSchema` has no cursor field, and
 * `getRawComposioTools` reads `tools.items` and drops the response's `next_cursor`. So one page at
 * the ceiling is not a page — it is the whole listing, and the only listing expressible here.
 *
 * Which is why {@link listTools} refuses a page that came back FULL. At the ceiling a complete
 * answer and a truncated one are the same array, and there is no second request that could tell
 * them apart.
 */
export const LISTING_LIMIT = 1000;

/** One action, as much of Composio's listing as anything here reads. */
export type ComposioAction = {
  slug: string;
  description?: string;
  /**
   * The action's JSON Schema as `@composio/core` re-spells it, which is NOT as Composio published it.
   *
   * This used to say "as they spell it", and that claim travelled: whatever lands in this field is
   * what {@link listTools} puts in front of a model as the vendor's own schema. The SDK parses the
   * response through `ToolSchema`, and its `ParametersSchema` is a plain `z.object` with no
   * passthrough (`@composio/core` 0.18.1, `src/types/tool.types.ts:134-174`), so every key it does
   * not name is dropped before anything here can see it. At the schema ROOT that is `if`, `then`,
   * `else`, `examples` and every `x-` extension. Per property, `JSONSchemaPropertySchema` (`:77-131`)
   * does keep `if`/`then`/`else`/`examples`, but names neither `deprecated` nor `contentEncoding`,
   * so both of those go.
   *
   * WHY THE CLAIM WAS DROPPED RATHER THAN THE LOSS FIXED. The strip happens inside the vendor's own
   * parse, upstream of every byte this module receives, so there is nothing here to restore a key
   * from — "stop losing them" is not an option this file has. The one place it could be avoided is
   * the adapter that has yet to be written, by reading `client.tools.list` directly rather than
   * `tools.getRawComposioTools` and never running `ToolSchema` over the answer; that is a decision
   * about the vendor's types, and it belongs where the vendor's types belong. What this module can
   * honestly promise is the narrower thing: it adds nothing to this schema and removes nothing from
   * it, so what the SDK handed over is exactly what a model is shown.
   *
   * Absent for the occasional action that publishes none — and equally for one that published `{}`,
   * which the SDK normalizes to absent before parsing (`src/models/Tools.ts:76-93`).
   */
  inputParameters?: Record<string, unknown>;
  /** Behaviour labels mixed in with topical ones. See {@link effectOf}. */
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
 * keeps no compile-time dependency on the vendor's package; the adapter that would install a real
 * client is the one place their types belong, and it has not been written.
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
 * SDK's shape is confined to one place: the adapter that would install a real client. No such
 * adapter exists yet, so today the only implementations of this type are stubs.
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
   * Every action of one app, for a page the CALLER has to name.
   *
   * `page` is required rather than optional, and that is the whole point of it being here. The
   * previous signature took the toolkit alone, so an adapter had nothing to pass a limit through
   * and the SDK's default applied — 20 rows, silently narrowed to the vendor's "important" subset.
   * A required argument makes the narrowed listing a thing a caller has to ask for on purpose
   * instead of a thing they get by leaving something out. See {@link LISTING_LIMIT}.
   */
  listActions(
    toolkit: string,
    page: { limit: number },
  ): Promise<ComposioAction[]>;
  execute(
    slug: string,
    userId: string,
    version: string,
    args: Record<string, unknown>,
  ): Promise<ComposioResult>;
};

let installed: ComposioActions | null = null;

/**
 * The seam an adapter would hand this module its client through, once, at startup.
 *
 * WOULD, BECAUSE NO SUCH ADAPTER EXISTS. Nothing under `server/src` calls this function — the only
 * callers are tests — so `installed` is null on every deployment of the shipped product. The
 * comment here used to describe `index.ts` doing the installing, and the code below was written
 * around a state that was treated as an edge case when it is in fact the only state.
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

/** The tool list needs no credential: Composio publishes an action's schema to anybody. */
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
  const labels = new Set(tags ?? []);
  if (labels.has("destructiveHint"))
    return { effect: "write", destructive: true };
  if (labels.has("readOnlyHint")) return { effect: "read", destructive: false };
  return { effect: "write", destructive: false };
}

/** A JSON Schema node, or null for anything that is not one. */
function schemaNode(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

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
 * The keys walked are the composition keywords `ParametersSchema` and `JSONSchemaPropertySchema`
 * actually keep, and no others: a key those two strip cannot be present to be walked.
 */
function stagesAFile(schema: unknown): boolean {
  const node = schemaNode(schema);
  if (!node) return false;
  if (node.file_uploadable === true) return true;

  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
  ]) {
    const children = schemaNode(node[key]);
    if (children && Object.values(children).some(stagesAFile)) return true;
  }

  for (const key of ["anyOf", "oneOf", "allOf", "items", "not"]) {
    const branch = node[key];
    if (
      Array.isArray(branch) ? branch.some(stagesAFile) : stagesAFile(branch)
    ) {
      return true;
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
     * Nothing under `server/src` installs a Composio client — see {@link useComposioClient} — so
     * this is what every Composio refresh on every real deployment answers today, by design and
     * not by accident. An operator who reads it as a crash goes looking for a broken vendor; what
     * they need to know is that the connector is not wired up here and that nothing was lost.
     */
    throw new Error(
      `Composio is not configured for this deployment, so nothing could be asked what ${toolkit} offers. That is the expected answer until a Composio client is installed at startup, and the actions already recorded for this app are kept rather than cleared.`,
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
     * What propagates is a sentence. `refreshTools` puts `error.message` on the admin page, and a
     * `ToolSchema` mismatch's message is the Zod issue array as JSON — an operator reading 400
     * characters of `{"code":"invalid_type","path":[...]}` learns nothing they can act on, and the
     * same string was reaching a model's context. The original is kept as `cause` for a log.
     */
    throw new Error(listingSentence(toolkit, error), { cause: error });
  }

  if (actions.length >= LISTING_LIMIT) {
    /*
     * A FULL PAGE IS NOT A COMPLETE LISTING, and this deployment cannot find out which it is.
     *
     * `LISTING_LIMIT` is the largest page the vendor's REST parameter allows, and the core SDK
     * offers no cursor to ask for a second one. So an app with exactly that many actions and an app
     * with more of them answer identically here. Committed as complete, the second one has every
     * action past the cut deleted from `mcp_tools` under a refresh that reported success — the same
     * loss the empty answer used to cause, arriving by a different route.
     */
    throw new Error(
      `Composio answered with ${actions.length} actions for ${toolkit}, which is the largest page this deployment's @composio/core can ask for, so there may be more that it cannot see. The actions already recorded are kept rather than replaced by a listing that might be a fragment.`,
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
   * WHY THIS IS NOT THE SAME AS THE SCHEMALESS ACTION ABOVE, which is deliberately still offered.
   * There the vendor is the right party to reject a bad argument, and the action might well
   * succeed. Here it cannot: every call is a rejection, and an advertised action that can only
   * fail is worse than an absent one, because an administrator grants it, the audit trail records
   * attempts against it, and the model spends turns retrying with a different invented key.
   *
   * ENABLING AUTO-UPLOAD WOULD NOT FIX IT EITHER, which is why the answer is not "turn the flag
   * on". That flag collapses the parameter to `{ type: 'string', format: 'path' }` — a promise
   * that the SDK will read a local path off this server's disk. A model naming a server-side path
   * is a worse offer than one naming a bucket key, not a better one.
   */
  return actions
    .filter((action) => !stagesAFile(action.inputParameters))
    .map((action) => {
      const { effect, destructive } = effectOf(action.tags);
      return {
        name: action.slug,
        description: action.description ?? "",
        inputSchema: action.inputParameters ?? {},
        effect,
        destructive,
        ...(action.version ? { version: action.version } : {}),
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
 */
export function vendorSentence(error: unknown): string | null {
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  const outer = (cause as { error?: unknown } | null | undefined)?.error;
  const inner = (outer as { error?: unknown } | null | undefined)?.error;
  const message = (inner as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.trim() !== "" ? message : null;
}

/**
 * The vendor's placeholder, which is the one sentence never worth passing on.
 *
 * "Error executing the tool GMAIL_FETCH_EMAILS" tells a reader only the name of the thing they asked
 * for. Matched on its opening rather than on the whole string, because the slug varies and the
 * punctuation after it has not been stable across vendor versions.
 */
const VENDOR_PLACEHOLDER = /^error executing the tool\b/i;

/**
 * What to say when the vendor reported a failure and said nothing about it.
 *
 * A sentence naming the one thing the reader can actually do, because the alternative is echoing the
 * placeholder above — and a model handed "Error executing the tool X" will either retry the identical
 * call or invent a reason. The likely cause by a wide margin is a connection that has lapsed, which
 * is a person's own two-click fix on the page named here.
 */
function unexplained(toolName: string): string {
  return `${toolName} failed and Composio did not say why. Check that this app is still connected on its Plugins page, then try again.`;
}

/**
 * Whether a thrown listing failure is the SDK's own schema refusing the vendor's answer.
 *
 * Duck-typed rather than `instanceof ZodError` so this file keeps no dependency on the vendor's
 * package: `@composio/core` reaches it only through {@link useComposioClient}, and importing `zod`
 * here would tie the transport to whichever major version the vendor happens to bundle — which is
 * exactly the coupling that makes a schema mismatch possible in the first place.
 */
function isSchemaMismatch(error: unknown): boolean {
  const shaped = error as
    | { name?: unknown; issues?: unknown }
    | null
    | undefined;
  return shaped?.name === "ZodError" || Array.isArray(shaped?.issues);
}

/**
 * Why an app's action list could not be read, as one sentence an operator can act on.
 *
 * The schema case names the fix, because it is a vendor change rather than a misconfiguration: the
 * answer arrived and this deployment's copy of their SDK would not accept it, so nothing an
 * administrator can do to this row will help and upgrading the package will.
 */
function listingSentence(toolkit: string, error: unknown): string {
  if (isSchemaMismatch(error)) {
    return `Composio's action list for ${toolkit} did not match the shape this deployment's @composio/core accepts, so the list was not refreshed and the tools already held are untouched. That is a vendor change rather than a setting: upgrading the package is the fix.`;
  }
  const thrown = error instanceof Error ? error.message.trim() : "";
  return (
    vendorSentence(error) ??
    (thrown === ""
      ? `Composio did not answer with an action list for ${toolkit}.`
      : thrown)
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
  const text = JSON.stringify(data ?? null, null, 2);
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
 * What the vendor said about its own call, read from the field its schema requires it to send.
 *
 * The criterion is that the vendor SAID the call did not succeed, which is `successful === false` and
 * not a falsy `successful`. An absent field is not the vendor reporting a failure — the schema makes
 * it impossible from the real client, and reading it as a failure would turn a projection looser than
 * the schema into a refusal of a call that worked.
 *
 * Null when there is nothing to report, so the caller can tell "succeeded" from "failed silently".
 */
function reportedFailure(
  answer: ComposioResult,
  toolName: string,
): string | null {
  if (answer.successful !== false) return null;
  const sentence = typeof answer.error === "string" ? answer.error.trim() : "";
  return sentence === "" || VENDOR_PLACEHOLDER.test(sentence)
    ? unexplained(toolName)
    : sentence;
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
 * THREE KINDS OF FAILURE, all of them `isError: true` and each with its own sentence, because
 * `store.ts` records that sentence beside the audit row: this transport refused before dialling, the
 * vendor reported a failure — by throwing, or in the `successful` field of a 200 answer — or the
 * vendor answered and this deployment could not read what it said. Only the last of those is ours,
 * and it must not arrive wearing the vendor's words.
 */
export async function callTool(
  connection: { url: string; actorId?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const userId = connection.actorId?.trim();
  if (!userId) {
    return failure(
      "This action runs in the account of the person asking, and this run is not attributed to anybody.",
    );
  }

  const toolkit = toolkitOf(connection.url);
  if (!toolkit) {
    return failure(`${connection.url} does not name a Composio app.`);
  }
  if (!installed) {
    return failure(
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
    return failure(
      `${toolName} has no recorded version, so it cannot be called: Composio requires a specific one and rejects "latest", so there is nothing to fall back on. Refreshing this app's tools on its Plugins page recovers it only if Composio publishes a version for this action. Where Composio publishes none, no refresh will make it callable.`,
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
    answer = await installed.execute(toolName, userId, version, rest);
  } catch (error) {
    // The vendor's own sentence when there is one, because a generic message costs a diagnosis.
    const thrown = error instanceof Error ? error.message.trim() : "";
    return failure(
      vendorSentence(error) ??
        (thrown === "" || VENDOR_PLACEHOLDER.test(thrown)
          ? unexplained(toolName)
          : thrown),
    );
  }

  const reported = reportedFailure(answer, toolName);
  if (reported !== null) return failure(reported);

  try {
    return resultOf(answer.data);
  } catch (error) {
    return failure(
      `${toolName} ran and Composio answered, but this deployment could not turn that answer into text: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
