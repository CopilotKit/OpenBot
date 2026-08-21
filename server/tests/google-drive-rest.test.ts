import { afterEach, describe, expect, test } from "bun:test";
import { callTool, listTools } from "../src/plugins/google-drive-rest";
import { transportFor } from "../src/plugins/transport";
import { catalogueEntry } from "../src/plugins/catalogue";

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
afterEach(() => {
  globalThis.fetch = realFetch;
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

describe("the adapter is the transport the catalogue asks for", () => {
  test("the Drive entry resolves to this adapter, not to MCP", async () => {
    const entry = catalogueEntry("google-drive");
    expect(entry?.transport).toBe("google-drive-rest");
    // Identity, not shape: proves the registry wired this module rather than something MCP-shaped.
    expect(transportFor(entry).callTool).toBe(callTool);
  });

  test("a server with no catalogue entry falls back to MCP", () => {
    // A custom server an administrator added by URL is somebody else's MCP endpoint by definition.
    expect(transportFor(null).callTool).not.toBe(callTool);
  });

  test("every advertised tool is one the dispatcher handles", async () => {
    const tools = await listTools(connection);
    stubFetch({ files: [] });
    for (const tool of tools) {
      // Called with no arguments on purpose. A handled tool complains about a missing argument or
      // answers; an unhandled one says it is not implemented, which is the failure being excluded.
      const result = await callTool(connection, tool.name, {});
      expect(result.text).not.toContain("is not a tool this connector");
    }
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

  test("an ordinary file is downloaded", async () => {
    const calls = stubFetch({
      id: "pdf1",
      name: "Contract.pdf",
      mimeType: "application/pdf",
    });

    await callTool(connection, "read_file_content", { fileId: "pdf1" });

    expect(new URL(calls[1].url).searchParams.get("alt")).toBe("media");
    expect(calls[1].url).not.toContain("/export");
  });

  test("a file id is required, and no request is made without one", async () => {
    const calls = stubFetch({});
    const result = await callTool(connection, "read_file_content", {});

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
