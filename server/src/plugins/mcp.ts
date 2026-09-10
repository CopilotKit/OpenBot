import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * The only place in this deployment that speaks MCP to somebody else's server.
 *
 * One door. Every call out is a credential leaving the building and a result coming back
 * that a model will read, so both directions want a single place to be careful in. A second client
 * somewhere else would be a second place to forget the timeout, the credential handling or the size
 * cap, and nothing about the second one would look wrong in review.
 *
 * No connection is kept. A client is built, used and closed for every listing and every call.
 * Streamable HTTP makes that cheap, and a pooled session would mean one Bot's request could arrive
 * on a session another Bot's credential opened, which is a whole class of bug we simply decline to
 * have.
 */

/** How long a server gets before we give up on it, for a listing and for a call. */
const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

/**
 * The most result text a call may return.
 *
 * A tool result goes straight into a model's context, so an unbounded one is somebody else's server
 * deciding how much of our context window to spend, and a truncation the model can see is far better
 * than a run that fails or a bill nobody expected. Truncated visibly, never silently.
 */
export const MAX_RESULT_CHARS = 20_000;

/**
 * What a vendor said, as the string a model will read.
 *
 * Its own function, and exported, because this is a decision rather than plumbing: it settles what a
 * model is told when a vendor answers with nothing, with something enormous, or with a part we
 * cannot render. Keeping it out of {@link callTool} means it can be asserted without a server to
 * talk to.
 *
 * The empty case is the one that earns the separation. A tool that matched nothing used to produce
 * an empty string, and an empty string is the worst thing to put in front of a model: it reads as
 * "the tool had nothing to say" rather than "there is nothing there", and the model closes the gap
 * from memory. For a knowledge connector that is precisely the failure the whole slice exists to
 * prevent — an answer with nothing behind it. So nothing is stated, in words.
 */
export function resultText(content: unknown): {
  text: string;
  truncated: boolean;
} {
  const parts = Array.isArray(content) ? content : [];
  const joined = parts
    .map((part) => {
      if (!part || typeof part !== "object") return "[unknown]";
      const item = part as { type?: string; text?: string };
      if (item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      // A non-text part is named rather than dropped. A model told "[image]" can say the tool
      // returned an image; a model handed nothing concludes the tool returned nothing.
      return `[${item.type ?? "unknown"}]`;
    })
    .join("\n");

  // Trimmed only to decide emptiness, never to alter a result that has something in it. A vendor
  // that sent one newline has said nothing, and which shape of nothing arrived should not change
  // what the model is told.
  if (joined.trim() === "") {
    return {
      text: "The tool returned no content. Nothing was found, so there is nothing here to answer from.",
      truncated: false,
    };
  }

  if (joined.length <= MAX_RESULT_CHARS) {
    return { text: joined, truncated: false };
  }
  return {
    text: `${joined.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${joined.length} characters]`,
    truncated: true,
  };
}

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * A tool as a transport listed it, including anything that transport happens to know about it.
 *
 * Three optional fields rather than a separate type per transport, so `refreshTools` reads
 * `tool.effect` with no cast and no `"effect" in tool` sniffing. Optional because a transport may
 * know none of it for a given tool, and a field always left undefined would be an invitation to
 * read it as meaning something.
 *
 * AN MCP SERVER CAN PUBLISH AN EFFECT, and this docblock used to say it could not. That sentence
 * was not a stale comment, it was load bearing: the argument that surfacing a recorded effect could
 * not disturb any existing curated read rested on MCP listings never carrying one, which was true
 * only because {@link listTools} was discarding `annotations`. The specification defines
 * `annotations.destructiveHint`, servers publish it, and a tool a vendor declared destructive was
 * classifying as a read for any curated entry whose hand-written `writeTools` happened to omit the
 * name. Version is the field MCP genuinely has no concept of; effect and destructive are not.
 *
 * `McpTool` stays exactly what a `tools/list` answer contains, because that is what it is for.
 */
export type ListedTool = McpTool & {
  /** What the vendor said this action does, when it said anything. */
  effect?: "read" | "write";
  /** Whether the vendor marked it as destroying something. */
  destructive?: boolean;
  /** The vendor's version string, when calling the action requires one. */
  version?: string;
};

export class McpServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerError";
  }
}

type Connection = {
  url: string;
  /** The bearer token for this server, already decrypted. Absent for a server that needs none. */
  token?: string;
};

/**
 * The vendor's own sentence out of a failure, when there is one worth reading.
 *
 * The transport puts the response body in the message, after a fixed prefix. Two shapes turn up: a
 * plain error object, and — from Google's Workspace servers — a JSON-RPC result whose `content` holds
 * the explanation as text under `isError`. Both are worth surfacing; the tool list, which arrives in
 * the same position under a 403, is not.
 */
function reasonFrom(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const body = message.slice(message.indexOf("{"));
  if (!body.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const asRecord = (value: unknown) =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  // `{"error": {"message": "..."}}` — how Google's REST APIs refuse.
  const restMessage = asRecord(asRecord(parsed).error).message;
  if (typeof restMessage === "string" && restMessage) {
    return trimmed(restMessage);
  }

  // `{"result": {"content": [{"text": "..."}], "isError": true}}` — how its MCP servers refuse.
  const result = asRecord(asRecord(parsed).result);
  if (result.isError === true && Array.isArray(result.content)) {
    const text = result.content
      .map((part) => asRecord(part).text)
      .find((value): value is string => typeof value === "string" && !!value);
    if (text) return trimmed(text);
  }

  return null;
}

/** Long enough for a sentence and a URL, short enough not to be the wall of JSON this replaced. */
const trimmed = (value: string) =>
  value.length > 400 ? `${value.slice(0, 400)}…` : value;

/**
 * A vendor's failure, as one sentence an operator can act on.
 *
 * WHAT THIS REPLACES. The transport throws `Error POSTing to endpoint: <the whole response body>`,
 * and the status lives on the error object rather than in the message — so rewrapping by `.message`
 * alone threw away the only part that says what went wrong and kept the part that does not.
 *
 * Google's Workspace MCP servers make that worse than it sounds. Asked for a tool list with a token
 * they will not accept, they answer **401, or 403, with a complete and valid tool list in the body** —
 * verified against the live endpoint. So the message was a wall of successful-looking JSON attached
 * to a failure, which reads as a parsing bug here rather than as a refusal there.
 *
 * The status leads, and the well-known ones are named. A 403 also keeps the vendor's own sentence
 * where there is one, because that is where Google says which API is not enabled — and each Workspace
 * product is two APIs, so nothing else can tell "I enabled it" from "it is enabled".
 */
function vendorFailure(error: unknown): string {
  const status =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;

  if (status === 401) {
    return "The vendor rejected this credential (401). For a connector reached as the person asking, reconnecting the account is the usual fix; if it persists, the scopes it was granted may not cover this server.";
  }
  if (status === 403) {
    /*
     * A 403 keeps its reason, unlike a 401.
     *
     * This cost a diagnosis. Google refuses a Workspace MCP server with 403 when the API behind it is
     * not enabled for the project — and the sentence saying so, with the console URL to fix it, is in
     * the response body. Dropping the body left "the account may lack access, or the API may not be
     * enabled", which is a guess between two very different problems when the vendor had already
     * answered the question.
     *
     * Worse, each Workspace product is TWO APIs: enabling `drive.googleapis.com` does not enable
     * `drivemcp.googleapis.com`, so "I enabled it" and "it is enabled" are not the same claim and
     * only the body can tell them apart.
     *
     * Trimmed, because the body may instead be the tool list — the same server answers `tools/list`
     * with a full, valid list under a 403 — and a wall of JSON is what made the original error
     * unreadable.
     */
    const detail = reasonFrom(error);
    return detail
      ? `The vendor accepted the credential and refused the request (403). It said: ${detail}`
      : "The vendor accepted the credential and refused the request (403). The account may lack access, or the API may not be enabled for this project.";
  }
  if (typeof status === "number") {
    return `The vendor answered ${status}.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Authorization header a stored token becomes.
 *
 * Bearer by default, which is what an MCP server's own token usually is. A token that already
 * names its scheme is sent as written, because some vendors forward the header straight to an API
 * that only speaks Basic: DataForSEO's hosted server answers the handshake and the tool listing to
 * anything, then returns 401 on every real call made with Bearer, so a deployment that could only
 * say Bearer looked connected and never worked. The scheme travels with the credential rather than
 * as a setting on the server row, so rotating a token can change how it is presented and nothing
 * else has to know.
 */
export function authorizationHeader(token: string): string {
  const trimmed = token.trim();
  return /^(basic|bearer)\s+\S/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

/**
 * Build, use and close a client.
 *
 * The `finally` closes the transport whatever happened, because a thrown error is the case where a
 * leaked connection is most likely and least noticed.
 */
async function withClient<T>(
  connection: Connection,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: connection.token
      ? { headers: { Authorization: authorizationHeader(connection.token) } }
      : undefined,
  });
  const client = new Client({ name: "openbot", version: "1.0.0" });

  try {
    await client.connect(transport);
    return await use(client);
  } catch (error) {
    // Rewrapped so a caller never has to care whether the failure came from the transport, the
    // handshake or the call, and so the message that reaches an audit row and an admin page is one
    // sentence rather than a stack.
    throw new McpServerError(vendorFailure(error));
  } finally {
    await client.close().catch(() => {
      // A server that will not say goodbye is not a failure of the work that just succeeded.
    });
  }
}

/**
 * A remote server will not list its tools to nobody, so a credential is required to ask.
 *
 * Declared rather than assumed, because the other transport in this deployment answers differently
 * and the difference is the whole shape of an administrator's setup flow. See {@link ./transport}.
 */
export const listNeedsCredential = true;

/**
 * ONLY THE HINT THAT NARROWS IS BELIEVED, and the omission of the other one is the decision here.
 *
 * The SDK declares four hints on `annotations` — `readOnlyHint`, `destructiveHint`,
 * `idempotentHint`, `openWorldHint` — and warns in the same place that a client should never make
 * tool use decisions from annotations a server it does not trust supplied. That warning is the
 * whole design of this function. `destructiveHint` can only ever move an action from read to write,
 * so a server that lies with it can restrict itself and nothing else. `readOnlyHint` moves an
 * action the other way, and `classifyTool` exists to make sure nothing but review can do that.
 *
 * WHAT HONOURING `readOnlyHint` WOULD ACTUALLY BUY, which is the reason withholding it costs
 * nothing. For a curated vendor it changes no answer: an advertised name absent from the reviewed
 * `writeTools` already classifies as a read, so recording `read` for it lands on the same result by
 * a worse route. For a name the reviewed list DOES hold, `classifyTool` consults review first and
 * ignores the column, so the hint would be discarded anyway. The single case where it would change
 * an answer is a server an administrator added by URL, which has no reviewed list behind it and
 * whose every tool is a write for exactly that reason — and there, believing it means letting an
 * arbitrary server declare its own tools harmless and be believed. Zero accuracy gained, one
 * fail-open introduced, so it is not read at all.
 *
 * `destructiveHint` is taken on presence of `true` only, never inverted. The specification gives it
 * a default of true when a tool is not read-only, and applying that default would reclassify every
 * unannotated action of every MCP vendor as a write — correct by the letter and a mass revocation
 * of grants people already hold. An absent hint stays absent, which leaves the reviewed list
 * deciding exactly as it did before, and only an explicit declaration narrows anything.
 *
 * A server that sets both hints is contradicting itself, and is read as destructive. The
 * specification says `destructiveHint` is meaningless while `readOnlyHint` is true, but resolving
 * an incoherent listing towards the permissive reading is the one direction that could hurt.
 */
function declaredEffect(annotations: ToolAnnotations | undefined) {
  if (annotations?.destructiveHint !== true) return {};
  return { effect: "write", destructive: true } as const;
}

/** What this server says it offers, right now. */
export async function listTools(connection: Connection): Promise<ListedTool[]> {
  return withClient(connection, async (client) => {
    const result = await client.listTools(undefined, {
      timeout: LIST_TIMEOUT_MS,
    });
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      ...declaredEffect(tool.annotations),
    }));
  });
}

export type McpCallResult = {
  /** The result as text, which is what a model reads. Truncated visibly if it was enormous. */
  text: string;
  /** True when the server itself reported the call as an error rather than failing to answer. */
  isError: boolean;
  truncated: boolean;
};

/**
 * Call one tool.
 *
 * Whether the call was permitted is not decided here. This function's only job is to speak the
 * protocol; the grant and the policy are settled before anything reaches it. Keeping the two apart
 * means the permission check cannot be accidentally satisfied by a code path that also happens to
 * make the call.
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  return withClient(connection, async (client) => {
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );

    const { text, truncated } = resultText(result.content);
    return { text, isError: result.isError === true, truncated };
  });
}
