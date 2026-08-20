import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
      ? { headers: { Authorization: `Bearer ${connection.token}` } }
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
    throw new McpServerError(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await client.close().catch(() => {
      // A server that will not say goodbye is not a failure of the work that just succeeded.
    });
  }
}

/** What this server says it offers, right now. */
export async function listTools(connection: Connection): Promise<McpTool[]> {
  return withClient(connection, async (client) => {
    const result = await client.listTools(undefined, {
      timeout: LIST_TIMEOUT_MS,
    });
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
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
