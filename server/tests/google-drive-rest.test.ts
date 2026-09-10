import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accessFor } from "../src/plugins/access";
import { catalogueEntry } from "../src/plugins/catalogue";
import { callTool, listTools } from "../src/plugins/google-drive-rest";
import { type McpTool, callTool as mcpCallTool } from "../src/plugins/mcp";
import { transportFor } from "../src/plugins/transport";

/**
 * The Drive REST adapter, asserted without Google.
 *
 * `fetch` is replaced rather than a server started, because what is under test is the translation:
 * which URL a tool becomes, what a refusal reads as, and that an empty listing says so in words.
 * None of that needs a network, and all of it is what breaks when Drive's shapes are misremembered.
 */

const connection = {
  url: "https://www.googleapis.com/drive/v3",
  token: "test-token",
};

const realFetch = globalThis.fetch;

/**
 * Anything this file did not stub is an escape, and an escape fails the test that let it out.
 *
 * Ordering used to matter here: a test awaited `listTools` before installing its stub, and got away
 * with it only because this adapter's list happens to be a local constant. Reordering that one call
 * fixes it once; a call made before its stub would go out to Google again the moment any of these
 * functions grows a request. So `fetch` is armed to refuse instead, before every test.
 *
 * Refusing is not enough on its own — the adapter catches its own transport errors and reports them
 * as a sentence, which would turn an escape into a plausible-looking failure message. The escapes
 * are therefore recorded and the ledger asserted empty afterwards, so one is named as what it is
 * rather than read as Drive being unreachable.
 */
let escapedToNetwork: string[] = [];

beforeEach(() => {
  escapedToNetwork = [];
  // Annotated as answering, though it never does: a function that only throws infers as returning
  // `never`, which does not overlap `fetch` enough for the cast the stub below makes freely.
  globalThis.fetch = (async (input: string | URL): Promise<Response> => {
    escapedToNetwork.push(String(input));
    throw new Error(`unstubbed fetch escaped to the network: ${String(input)}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(escapedToNetwork).toEqual([]);
});

/** Records what was requested and answers with a fixed body. */
function stubFetch(
  body: unknown,
  init: { status?: number; text?: string } = {},
) {
  const calls: { url: string; authorization: string | null }[] = [];
  globalThis.fetch = (async (input: string | URL, options?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(options?.headers).get("authorization") ?? null,
    });
    const payload = init.text ?? JSON.stringify(body);
    return new Response(payload, {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

/**
 * Arguments a tool will accept, read off the tool's own schema rather than written out here.
 *
 * A tool added to the adapter with a required argument this file has never heard of still gets
 * called with one, so the coverage below cannot quietly stop covering it.
 */
function argsFor(tool: McpTool): Record<string, unknown> {
  const required: unknown[] = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required
    : [];
  return Object.fromEntries(required.map((name) => [String(name), "given"]));
}

/**
 * A body that answers every advertised tool: a listing for the searches, a text file for the reads.
 */
const anyToolsBody = {
  files: [],
  id: "given",
  name: "notes.txt",
  mimeType: "text/plain",
};

describe("the adapter is the transport the catalogue asks for", () => {
  test("the Drive entry resolves to this adapter, not to MCP", () => {
    const entry = catalogueEntry("google-drive");
    expect(entry?.transport).toBe("google-drive-rest");
    // Identity, not shape: proves the registry wired this module rather than something MCP-shaped.
    expect(
      transportFor(
        accessFor(
          { provenance: "first-party", url: "https://www.googleapis.com" },
          entry,
        ).transport,
      ).callTool,
    ).toBe(callTool);
  });

  test("a server with no catalogue entry falls back to MCP", () => {
    // A custom server an administrator added by URL is somebody else's MCP endpoint by definition.
    // Composed through `accessFor`, which is where the absent-entry fallback now lives — and asserted
    // as MCP rather than as "not Drive", which any wrongly resolved kind would also satisfy.
    expect(
      transportFor(
        accessFor(
          { provenance: "custom", url: "https://mcp.example.com/mcp" },
          null,
        ).transport,
      ).callTool,
    ).toBe(mcpCallTool);
  });

  test("every advertised tool is one the dispatcher handles", async () => {
    // Stubbed before the first call of any kind, so nothing here depends on `listTools` staying
    // local; the guard above turns a reintroduction of that order into a named failure.
    stubFetch(anyToolsBody);
    const tools = await listTools(connection);
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      /*
       * Called with what the tool asks for, and asserted on what a handled tool DOES: it reaches
       * Drive and answers. The dispatcher's fallthrough is the failure being excluded, and it is
       * excluded by never making a request — which stays true however that refusal is worded, and
       * which a reworded, mistyped or entirely different error cannot satisfy.
       */
      const calls = stubFetch(anyToolsBody);
      const result = await callTool(connection, tool.name, argsFor(tool));
      expect(calls.length).toBeGreaterThan(0);
      expect(result.isError).toBe(false);
    }
  });

  test("a tool the dispatcher does not implement is refused without a request", async () => {
    // The other half of the pair: the fallthrough exists, and is what a tool NOT in the list gets.
    const calls = stubFetch(anyToolsBody);
    const result = await callTool(connection, "delete_everything", {});

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

/*
 * Drive is `user-oauth`, so the store refuses a call with nobody's credential long before this
 * module is reached and the adapter's own check is the second lock. It is asserted anyway: it is
 * the difference between a sentence saying so and a request to Google carrying `Bearer undefined`,
 * which Drive answers with a 401 whose meaning is a great deal less obvious.
 */
describe("a call with no credential never leaves the process", () => {
  const withoutToken = { url: connection.url };

  test("every advertised tool refuses, and none of them requests anything", async () => {
    stubFetch(anyToolsBody);
    const tools = await listTools(withoutToken);
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      const calls = stubFetch(anyToolsBody);
      const result = await callTool(withoutToken, tool.name, argsFor(tool));
      // Silence first, and asserted as silence rather than as wording: nothing was requested, so
      // no `Bearer undefined` went to Google to come back as a 401 about the wrong thing.
      expect(calls).toHaveLength(0);
      expect(result.isError).toBe(true);
    }
  });

  test("listing what the adapter offers asks nobody, so it needs nothing", async () => {
    /*
     * Two properties in one call, and the second is why this test is left unstubbed. The gate that
     * once stood here made connecting Drive a four-stop journey, so a tokenless listing has to
     * answer in full — and the reason it can is that it asks nobody, which the armed `fetch` above
     * is what proves. A `listTools` that grew a request would fail here by name.
     */
    expect(await listTools(withoutToken)).toEqual(await listTools(connection));
    expect(escapedToNetwork).toEqual([]);
  });
});

describe("a search becomes the right Drive request", () => {
  test("the query is sent as a Drive q clause, with the caller's token", async () => {
    const calls = stubFetch({ files: [] });
    await callTool(connection, "search_files", { query: "roadmap" });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/drive/v3/files",
    );
    expect(url.searchParams.get("q")).toBe(
      "name contains 'roadmap' or fullText contains 'roadmap'",
    );
    expect(calls[0].authorization).toBe("Bearer test-token");
  });

  /*
   * THE INJECTION CASE. Drive's `q` syntax delimits with single quotes, so an apostrophe in a search
   * term would close the clause early — turning a search for somebody's file into a different query
   * than the one asked for, or a syntax error. Escaped, a term is only ever a term.
   */
  test("an apostrophe in the query cannot break out of the clause", async () => {
    const calls = stubFetch({ files: [] });
    await callTool(connection, "search_files", { query: "don't ship" });

    const q = new URL(calls[0].url).searchParams.get("q");
    expect(q).toBe(
      "name contains 'don\\'t ship' or fullText contains 'don\\'t ship'",
    );
  });

  test("recent files are ordered by Drive rather than filtered", async () => {
    const calls = stubFetch({ files: [] });
    await callTool(connection, "list_recent_files", {});

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("orderBy")).toBe("modifiedTime desc");
    expect(url.searchParams.has("q")).toBe(false);
  });

  test("a search with nothing to search for is refused before the network", async () => {
    const calls = stubFetch({ files: [] });
    const result = await callTool(connection, "search_files", {});

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("what a model is told", () => {
  test("a match is named, with the id it needs to read it", async () => {
    stubFetch({
      files: [
        {
          id: "abc123",
          name: "Roadmap",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-08-21T10:00:00Z",
          webViewLink: "https://docs.google.com/document/d/abc123",
        },
      ],
    });

    const result = await callTool(connection, "search_files", {
      query: "roadmap",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Roadmap");
    // Every other tool here takes an id, so a result without one is a dead end.
    expect(result.text).toContain("abc123");
    expect(result.text).toContain("https://docs.google.com/document/d/abc123");
  });

  /*
   * The empty case, stated in words rather than returned as an empty string. An empty result reads to
   * a model as "the tool had nothing to say" and gets filled in from memory, which for a knowledge
   * connector is the exact failure the whole lane exists to prevent.
   */
  test("nothing found says so, and is not an error", async () => {
    stubFetch({ files: [] });
    const result = await callTool(connection, "search_files", {
      query: "nothing matches this",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Nothing was found");
  });

  test("Google's own refusal is passed through, not replaced", async () => {
    stubFetch(
      {},
      {
        status: 403,
        text: JSON.stringify({
          error: { message: "Google Drive API has not been used in project 1" },
        }),
      },
    );

    const result = await callTool(connection, "search_files", { query: "x" });
    expect(result.isError).toBe(true);
    // The sentence naming what to fix, which is the whole reason the body is kept.
    expect(result.text).toContain("has not been used in project 1");
    expect(result.text).toContain("403");
  });
});

describe("reading a file asks Drive what it is first", () => {
  test("a Google Doc is exported as text, never downloaded", async () => {
    const calls = stubFetch({
      id: "doc1",
      name: "Notes",
      mimeType: "application/vnd.google-apps.document",
    });

    await callTool(connection, "read_file_content", { fileId: "doc1" });

    expect(calls).toHaveLength(2);
    // `alt=media` refuses an editor file outright, so the export path is not an optimisation.
    expect(calls[1].url).toContain("/files/doc1/export");
    expect(new URL(calls[1].url).searchParams.get("mimeType")).toBe(
      "text/plain",
    );
  });

  test("an ordinary text file is downloaded", async () => {
    const calls = stubFetch({
      id: "txt1",
      name: "notes.txt",
      mimeType: "text/plain",
    });

    await callTool(connection, "read_file_content", { fileId: "txt1" });

    expect(new URL(calls[1].url).searchParams.get("alt")).toBe("media");
    expect(calls[1].url).not.toContain("/export");
  });

  /*
   * A PDF is declined by name rather than decoded and hoped for.
   *
   * `response.text()` on binary produces thousands of replacement characters, and that goes straight
   * into a model's context: it costs the tokens of the real document, says nothing, and looks enough
   * like content that the model will try to summarise it. The assertion that matters is the second
   * one — the download is never even attempted, so the bytes never exist to be mangled.
   */
  test("a binary file is declined instead of being read as text", async () => {
    const calls = stubFetch({
      id: "pdf1",
      name: "Contract.pdf",
      mimeType: "application/pdf",
    });

    const result = await callTool(connection, "read_file_content", {
      fileId: "pdf1",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("application/pdf");
    // One call: the metadata lookup. No download followed it.
    expect(calls).toHaveLength(1);
  });

  test("a file id is required, and no request is made without one", async () => {
    const calls = stubFetch({});
    const result = await callTool(connection, "read_file_content", {});

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
