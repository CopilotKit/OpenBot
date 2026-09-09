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
 * arrives through {@link useComposioClient} rather than a constructor — the registry is built at
 * import time, long before `index.ts` has configuration.
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

/** One action, as much of Composio's listing as anything here reads. */
export type ComposioAction = {
  slug: string;
  description?: string;
  /** JSON Schema, as they spell it. Absent for the occasional action that publishes none. */
  inputParameters?: Record<string, unknown>;
  /** Behaviour labels mixed in with topical ones. See {@link effectOf}. */
  tags?: string[];
  /** The version calling this action requires — `20260903_00` and the like. */
  version?: string;
};

/**
 * What this module needs of Composio, and nothing more.
 *
 * A narrow projection rather than their client, so a test satisfies it with two functions and the
 * SDK's shape is somebody else's problem in exactly one place: the adapter that installs the real one.
 *
 * `execute` RESOLVES OR THROWS, with no error field to check. That is not a simplification — it is
 * what the live API does, confirmed by calling it. An earlier draft of this module checked a
 * `{ data, error }` shape that never occurs, so every stubbed test passed against a fiction.
 */
export type ComposioActions = {
  listActions(toolkit: string): Promise<ComposioAction[]>;
  execute(
    slug: string,
    userId: string,
    version: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
};

let installed: ComposioActions | null = null;

/**
 * Hand this module its client, once, from the place that reads configuration.
 *
 * `null` is a supported argument, and not only for symmetry: the suite is one process, so a test that
 * installs a stub has to be able to take it back out. It is also the unconfigured state — a
 * deployment with no Composio key installs nothing, and every function here answers emptily or
 * refuses rather than failing, so an app nobody configured is absent rather than broken.
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
 */
export function toolkitOf(url: string): string | null {
  const prefix = "composio://";
  if (!url.startsWith(prefix)) return null;
  const slug = url.slice(prefix.length).replace(/\/+$/, "").trim();
  return slug === "" ? null : slug;
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
  if (labels.has("destructiveHint")) return { effect: "write", destructive: true };
  if (labels.has("readOnlyHint")) return { effect: "read", destructive: false };
  return { effect: "write", destructive: false };
}

/**
 * Every action this app publishes, in the shape a `tools/list` answer has, plus what we know about it.
 *
 * An action with no schema is still listed, with an open one. The vendor is the right party to reject a
 * bad argument, and an action silently missing from the list reads to an administrator as an app that
 * does not have it.
 */
export async function listTools(connection: {
  url: string;
}): Promise<ListedTool[]> {
  const toolkit = toolkitOf(connection.url);
  if (!toolkit || !installed) return [];

  const actions = await installed.listActions(toolkit);

  return actions.map((action) => {
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
 * Null when there is no such sentence, so the caller falls back to the thrown message rather than
 * inventing one.
 */
export function vendorSentence(error: unknown): string | null {
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  const outer = (cause as { error?: unknown } | null | undefined)?.error;
  const inner = (outer as { error?: unknown } | null | undefined)?.error;
  const message = (inner as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.trim() !== ""
    ? message
    : null;
}

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/**
 * What the model reads, capped visibly.
 *
 * The same cap the MCP transport applies and for the same reason: a tool result goes straight into a
 * model's context, so an unbounded one is somebody else's server deciding how much of our context
 * window to spend. Truncated visibly, never silently. An empty answer is stated in words rather than
 * returned empty — an empty string reads as "the action had nothing to say" rather than "there is
 * nothing there", and a model closes that gap from memory.
 */
function resultOf(data: unknown): McpCallResult {
  const text =
    typeof data === "string" ? data : JSON.stringify(data ?? null, null, 2);
  const truncated = text.length > MAX_RESULT_CHARS;
  if (!truncated && (text === "" || text === "null")) {
    return { text: "The action returned nothing.", isError: false, truncated: false };
  }
  return {
    text: truncated ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated]` : text,
    isError: false,
    truncated,
  };
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
     * In practice this means the app's tool list has not been refreshed since the version column
     * existed, which is an operator's one-click fix rather than anything a person asking can do.
     */
    return failure(
      `${toolName} has no recorded version, so it cannot be called. Refresh this app's tools on its Plugins page and try again.`,
    );
  }

  try {
    return resultOf(await installed.execute(toolName, userId, version, rest));
  } catch (error) {
    // The vendor's own sentence when there is one, because a generic message costs a diagnosis.
    return failure(
      vendorSentence(error) ??
        (error instanceof Error
          ? error.message
          : "Composio did not answer this action."),
    );
  }
}
