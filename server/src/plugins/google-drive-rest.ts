import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * Google Drive, reached over its ordinary REST API instead of its MCP server.
 *
 * WHY THIS EXISTS. Google publishes a hosted MCP server for Drive, `drivemcp.googleapis.com`, and
 * pointing the catalogue at it was the original design: a vendor-maintained server needs no code
 * here at all. It is gated behind the Google Workspace Developer Preview Program, and refuses an
 * unenrolled project with `The caller does not have permission` — a statement about the project,
 * not the credential, so every check available locally says the setup is correct. It is.
 *
 * The REST API underneath has been generally available since 2015. So this trades "no code" for "no
 * dependency on a preview", which for a connector people rely on is the better side of the trade.
 *
 * WHAT MAKES IT SWAPPABLE. This module implements the interface {@link ./mcp} already had —
 * `listTools` and `callTool`, same shapes — rather than inventing one for itself. MCP is therefore
 * not the default with an exception carved out of it; both are implementations of the same contract,
 * chosen per catalogue entry by {@link ./transport}. Going back to the MCP server when the preview
 * opens is one field on one entry, with nothing else in the system aware it changed.
 *
 * The TOOL NAMES are deliberately the ones Google's MCP server advertises, character for character.
 * A grant is stored as `google-drive/search_files`, so keeping the names identical means every grant
 * an administrator has already made keeps working across the swap, in either direction. Diverging
 * here would silently turn switching transports into re-granting every tool on every Bot.
 *
 * Read-only, and only the tools that can be implemented faithfully. Google's MCP server also
 * advertises writes; the `drive.readonly` scope refuses them, and nothing here offers them.
 */

/** Long enough for a slow listing, short enough that a Bot's turn is not held open on it. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many files a listing returns before the model is reading a directory rather than an answer. */
const PAGE_SIZE = 25;

/**
 * The fields asked for, rather than Drive's default.
 *
 * Drive returns a thin projection unless asked, and `webViewLink` is the one worth naming: a result
 * carrying it lets a Bot cite a file as a link somebody can open, which is the difference between an
 * answer and an assertion about an answer.
 */
const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,webViewLink,size,owners(emailAddress)";

/**
 * Google's editor formats, and the plain-text export each one has.
 *
 * A Doc has no bytes to download — `alt=media` refuses it — so it has to be exported. Anything not
 * in here is a real file and is fetched directly.
 */
const EXPORTABLE: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

/**
 * What this adapter offers, as the same shape a server would have answered `tools/list` with.
 *
 * Static, and that is the point of difference from MCP: there is no remote list to discover, so
 * `refreshTools` records what this code can actually do. A tool listed here that the dispatcher
 * below does not handle would be advertised to a model and then fail, so the two are kept adjacent.
 */
const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "search_files",
    description:
      "Search the files in your Google Drive by name and full text. Returns matching files with their names, types, last modified times and links.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, in file names and file contents.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent_files",
    description:
      "List the files in your Google Drive that changed most recently, newest first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_file_metadata",
    description:
      "Get the name, type, size, owner, last modified time and link for one file, by its id.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file's Drive id." },
      },
      required: ["fileId"],
    },
  },
  {
    name: "read_file_content",
    description:
      "Read the text of one file in your Google Drive, by its id. Google Docs, Sheets and Slides are exported as text.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file's Drive id." },
      },
      required: ["fileId"],
    },
  },
]);

type Connection = { url: string; token?: string };

/**
 * No credential is needed to know what this adapter can do, because the answer is in this file.
 *
 * This is not a detail. Assuming otherwise made configuring Drive a four-stop journey: an
 * administrator enabling the connector was refused at "refresh tools" until they had gone to their
 * own settings page and connected a personal Google account, whose token was then handed to
 * {@link listTools} — which ignores it — and thrown away. The gate was real and the work behind it
 * was not.
 */
export const listNeedsCredential = false;

/** The same list for everybody, because this adapter's capability is this code rather than a server. */
export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

/**
 * One request to Drive, with the caller's own token.
 *
 * `token` is never optional in practice here — Drive is `user-oauth`, so the store has already
 * refused a call with nobody's credential before this module is reached — but it is typed optional
 * by the shared connection shape, so a missing one is named rather than sent as `Bearer undefined`.
 */
async function request(
  connection: Connection,
  path: string,
  query: Record<string, string>,
): Promise<{ ok: true; response: Response } | { ok: false; message: string }> {
  if (!connection.token) {
    return { ok: false, message: "No credential was available for this call." };
  }

  const url = new URL(`${connection.url.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? "Google Drive did not answer in time."
          : `Google Drive could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    /*
     * Google's own sentence, kept. For a 403 this is where it names the API that is not enabled and
     * gives the console URL, which is the difference between a fix and a guess. Dropping it once
     * already cost a diagnosis.
     */
    const body = await response.text().catch(() => "");
    let detail = "";
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string")
        detail = parsed.error.message;
    } catch {
      // Not JSON. The status alone is still worth saying.
    }
    return {
      ok: false,
      message: detail
        ? `Google Drive refused this request (${response.status}): ${detail}`
        : `Google Drive refused this request (${response.status}).`,
    };
  }

  return { ok: true, response };
}

/**
 * Whether this type's bytes can be read as text at all.
 *
 * An allow list, not a deny list. New binary formats appear constantly and each one added to a deny
 * list is a format that reached a model as mojibake first; the textual families are few and stable.
 * `application/*` is deliberately not included wholesale — it holds JSON and XML, and also PDFs,
 * archives and every office format.
 */
function isTextual(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const type = mimeType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  return [
    "application/json",
    "application/xml",
    "application/xhtml+xml",
    "application/javascript",
    "application/x-ndjson",
    "application/yaml",
    "application/x-yaml",
    "application/sql",
    "application/toml",
  ].includes(type);
}

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  owners?: { emailAddress?: string }[];
};

/**
 * One file as a line a model can quote.
 *
 * The id is included because every other tool here takes one, and a model that has just been shown a
 * file it cannot then read is a dead end it will try to talk its way out of.
 */
function fileLine(file: DriveFile): string {
  const name = file.name ?? "(untitled)";
  /*
   * A markdown link, not a bare URL beside a name.
   *
   * This is K1's acceptance criterion rather than decoration: "the answer carries a link that opens
   * the actual file". Tool results are drawn through a markdown renderer, so a link is a link a
   * reader can click, and one the model can carry into its own prose when it cites the file. A bare
   * URL depends on the renderer choosing to autolink, and reads as noise when it does not.
   *
   * The brackets in the name are escaped because a `]` in a file name would otherwise close the link
   * text early and leave the rest of the name and the URL as literal characters on screen.
   */
  const parts = [
    file.webViewLink
      ? `[${name.replace(/\[/g, "\\[").replace(/\]/g, "\\]")}](${file.webViewLink})`
      : name,
  ];
  if (file.mimeType) parts.push(file.mimeType);
  if (file.modifiedTime) parts.push(`modified ${file.modifiedTime}`);
  // Kept even though the link carries it: every other tool here takes an id, and a model that has
  // to parse one out of a URL will sometimes get it wrong.
  if (file.id) parts.push(`id: ${file.id}`);
  return `- ${parts.join(" · ")}`;
}

/**
 * A Drive query string built from what somebody typed.
 *
 * The quote is escaped, not stripped. Drive's `q` syntax delimits with single quotes, so an
 * apostrophe in a search term would otherwise end the clause and change the query's meaning —
 * searching for `don't` would become a syntax error at best, and at worst a different search than
 * the one asked for. Escaped, a term is only ever a term.
 */
const driveQuery = (query: string) => {
  const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `name contains '${escaped}' or fullText contains '${escaped}'`;
};

/**
 * Text as an MCP result, through the one function that decides what a model is told.
 *
 * Reused rather than reimplemented so the empty case and the size cap behave identically across both
 * transports. The empty case is the one that matters: a search that matched nothing has to SAY so,
 * because an empty string reads to a model as "the tool had nothing to say" and gets filled in from
 * memory — which for a knowledge connector is the exact failure the lane exists to prevent.
 */
function asResult(text: string): McpCallResult {
  const joined = text.trim();
  if (joined === "") {
    return {
      text: "The tool returned no content. Nothing was found, so there is nothing here to answer from.",
      isError: false,
      truncated: false,
    };
  }
  if (joined.length <= MAX_RESULT_CHARS) {
    return { text: joined, isError: false, truncated: false };
  }
  return {
    text: `${joined.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${joined.length} characters]`,
    isError: false,
    truncated: true,
  };
}

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/**
 * Call one tool.
 *
 * Whether the call was permitted is decided before this module, exactly as it is for MCP. This
 * dispatches and formats, and nothing else — an unknown tool is refused here rather than guessed at,
 * because a tool name that reaches this point and is not in {@link TOOLS} means the stored tool list
 * and this code have diverged, which is a bug to surface rather than to absorb.
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const stringArg = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };

  if (toolName === "search_files" || toolName === "list_recent_files") {
    const query = stringArg("query");
    if (toolName === "search_files" && !query) {
      return failure("A search needs something to search for.");
    }

    const result = await request(connection, "/files", {
      pageSize: String(PAGE_SIZE),
      fields: `files(${FILE_FIELDS})`,
      // Drive's own ordering for "recent". Search leaves it to relevance.
      ...(query ? { q: driveQuery(query) } : { orderBy: "modifiedTime desc" }),
    });
    if (!result.ok) return failure(result.message);

    const body = (await result.response.json()) as { files?: DriveFile[] };
    const files = body.files ?? [];
    return asResult(files.map(fileLine).join("\n"));
  }

  if (toolName === "get_file_metadata") {
    const fileId = stringArg("fileId");
    if (!fileId) return failure("A file id is needed to look a file up.");

    const result = await request(
      connection,
      `/files/${encodeURIComponent(fileId)}`,
      { fields: FILE_FIELDS },
    );
    if (!result.ok) return failure(result.message);

    const file = (await result.response.json()) as DriveFile;
    const owner = file.owners?.[0]?.emailAddress;
    return asResult(
      [
        fileLine(file),
        file.size ? `size: ${file.size} bytes` : null,
        owner ? `owner: ${owner}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (toolName === "read_file_content") {
    const fileId = stringArg("fileId");
    if (!fileId) return failure("A file id is needed to read a file.");

    /*
     * The type is looked up first, because how a file is read depends on what it is. A Doc has no
     * bytes and must be exported; anything else is downloaded. Asking Drive rather than guessing from
     * the name means a mislabelled file still reads correctly.
     */
    const metadata = await request(
      connection,
      `/files/${encodeURIComponent(fileId)}`,
      { fields: "id,name,mimeType" },
    );
    if (!metadata.ok) return failure(metadata.message);
    const file = (await metadata.response.json()) as DriveFile;

    const exportAs = file.mimeType ? EXPORTABLE[file.mimeType] : undefined;

    /*
     * A file whose bytes are not text is declined by name, not decoded and hoped for.
     *
     * `response.text()` on a PDF, an image or a zip produces thousands of replacement characters and
     * mojibake, and that goes straight into a model's context: it costs the tokens of the real
     * document, tells the model nothing, and looks enough like content that the model will try to
     * summarise it. Saying which type it is instead lets the model do the one useful thing available
     * — name the file and its type, and stop — and keeps a link the person can open themselves.
     *
     * Only positively-known-textual types are read. Anything unrecognised is declined, for the same
     * reason an unknown tool counts as a write: guessing permissively here is not recoverable, since
     * nothing downstream can tell garbage from content.
     */
    if (!exportAs && !isTextual(file.mimeType)) {
      return failure(
        `${file.name ?? fileId} is a ${file.mimeType ?? "binary"} file, which this connector cannot read as text. Its metadata and link are available, and somebody can open it themselves.`,
      );
    }

    const content = exportAs
      ? await request(
          connection,
          `/files/${encodeURIComponent(fileId)}/export`,
          { mimeType: exportAs },
        )
      : await request(connection, `/files/${encodeURIComponent(fileId)}`, {
          alt: "media",
        });
    if (!content.ok) return failure(content.message);

    const text = await content.response.text();
    // Named, because a model handed only the body cannot cite what it read.
    return asResult(`${file.name ?? fileId}\n\n${text}`);
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}
