import { describe, expect, test } from "bun:test";
import { MAX_RESULT_CHARS, resultText } from "../src/plugins/mcp";

/**
 * What a vendor's answer looks like by the time a model reads it.
 *
 * Separated from the protocol so it can be asserted without a server to talk to. The case worth
 * having tests for is the empty one: a tool that matched nothing used to hand back an empty string,
 * and an empty string is the single most dangerous thing to put in front of a model. It reads as
 * "the tool had nothing to say" rather than "there is nothing there", and the model fills the gap
 * from memory — which is exactly the answer with nothing behind it that a knowledge connector must
 * never give.
 */

describe("a result with nothing in it", () => {
  test("says so, rather than being an empty string", () => {
    const { text } = resultText([]);
    expect(text).not.toBe("");
    expect(text.toLowerCase()).toContain("no content");
    // The clause that matters: it tells the model there is nothing here to answer from.
    expect(text.toLowerCase()).toContain("nothing");
  });

  test("treats whitespace and a missing content field the same as empty", () => {
    // A vendor sending a single newline has said nothing, and "nothing" should not depend on which
    // shape of nothing arrived.
    const blank = resultText([{ type: "text", text: "   \n  " }]).text;
    expect(blank).toBe(resultText([]).text);
    expect(resultText(undefined).text).toBe(resultText([]).text);
    expect(resultText("not an array").text).toBe(resultText([]).text);
  });

  test("is not reported as truncated", () => {
    expect(resultText([]).truncated).toBe(false);
  });

  test("reads structuredContent when the content list was empty", () => {
    // Tools that declare an output schema often put the answer only in structuredContent.
    // An empty content list used to be reported as nothing found, so the model filled the
    // gap from memory while the vendor had answered.
    const { text, truncated } = resultText([], {
      title: "Expense policy",
      meals: "under $75 need no receipt",
    });
    expect(truncated).toBe(false);
    expect(text).toContain("Expense policy");
    expect(text).toContain("under $75 need no receipt");
    expect(text.toLowerCase()).not.toContain("no content");
  });

  test("does not replace a text part with structuredContent", () => {
    const { text } = resultText(
      [{ type: "text", text: "the prose the server chose" }],
      { title: "ignored" },
    );
    expect(text).toBe("the prose the server chose");
    expect(text).not.toContain("ignored");
  });

  test("empty content and empty structuredContent still say nothing was found", () => {
    expect(resultText([], null).text).toBe(resultText([]).text);
    expect(resultText([], undefined).text).toBe(resultText([]).text);
  });
});

describe("a result with something in it", () => {
  test("is passed through as the vendor wrote it", () => {
    const { text, truncated } = resultText([
      {
        type: "text",
        text: "# Expense policy\n\nMeals under $75 need no receipt.",
      },
    ]);
    expect(text).toBe("# Expense policy\n\nMeals under $75 need no receipt.");
    expect(truncated).toBe(false);
  });

  test("joins several parts", () => {
    expect(
      resultText([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]).text,
    ).toBe("first\nsecond");
  });

  test("names a part it cannot read rather than dropping it", () => {
    // A model told "[image]" can say the tool returned an image. A model handed nothing concludes
    // the tool returned nothing, which is a different and false statement.
    expect(resultText([{ type: "image", data: "..." }]).text).toBe("[image]");
    expect(resultText([{}]).text).toBe("[unknown]");
  });

  test("reads the text of an embedded resource, as a server returns a file it read", () => {
    // The shape GitHub's MCP server answers `get_file_contents` with for a text file: a line saying
    // the download worked, then the file itself as an embedded resource. Named as "[resource]", the
    // model was told the file arrived and never shown what was in it.
    expect(
      resultText([
        { type: "text", text: "successfully downloaded text file (SHA: abc)" },
        {
          type: "resource",
          resource: {
            uri: "repo://octo/docs/contents/README.md",
            mimeType: "text/markdown",
            text: "# Expense policy\n\nMeals under $75 need no receipt.",
          },
        },
      ]).text,
    ).toBe(
      "successfully downloaded text file (SHA: abc)\n# Expense policy\n\nMeals under $75 need no receipt.",
    );
  });

  test("still names an embedded resource that carries bytes rather than text", () => {
    expect(
      resultText([
        {
          type: "resource",
          resource: {
            uri: "file:///logo.png",
            mimeType: "image/png",
            blob: "iVBORw0KGgo=",
          },
        },
      ]).text,
    ).toBe("[resource]");
    expect(resultText([{ type: "resource", resource: null }]).text).toBe(
      "[resource]",
    );
  });

  test("reads a resource_link's uri, name and description, as a server points at a file", () => {
    // MCP's resource_link is a pointer, not the file: a URI, a name, and often a sentence of
    // what it is. Named as "[resource_link]", the model was told a link arrived and never shown
    // where it went, so a search that answered with pages produced no pages it could open.
    // The URI leads and each field is labelled, so the model tells them apart by name.
    expect(
      resultText([
        {
          type: "resource_link",
          uri: "notion://page/q3-budget",
          name: "Q3 budget",
          description: "The approved numbers for the quarter",
          mimeType: "text/html",
        },
      ]).text,
    ).toBe(
      "uri: notion://page/q3-budget\nname: Q3 budget\ndescription: The approved numbers for the quarter",
    );
  });

  test("shows a resource_link's title over its name, when the server gives one", () => {
    // The spec's `title` is the name meant for people; `name` is the one meant for programs.
    expect(
      resultText([
        {
          type: "resource_link",
          uri: "notion://page/q3-budget",
          name: "q3_budget",
          title: "Q3 budget",
        },
      ]).text,
    ).toBe("uri: notion://page/q3-budget\ntitle: Q3 budget");
  });

  test("a resource_link with only a uri is still that uri, not an empty name", () => {
    expect(
      resultText([{ type: "resource_link", uri: "file:///notes.md" }]).text,
    ).toBe("uri: file:///notes.md");
  });

  test("a resource_link's long name cannot push its uri past the result cap", () => {
    // The URI is the link's identity; the name is metadata. Truncation may lose what a resource
    // was called, never where it is: a name as long as the whole cap must leave the pointer
    // readable, rather than a link with nowhere to go, which is the failure this reader removes.
    const { text, truncated } = resultText([
      {
        type: "resource_link",
        name: "x".repeat(MAX_RESULT_CHARS),
        uri: "https://example.com/source",
      },
    ]);
    expect(text.startsWith("uri: https://example.com/source\n")).toBe(true);
    expect(text).toContain("https://example.com/source");
    expect(truncated).toBe(false);
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS);
  });

  test("bounds a resource_link's description, and marks the cut", () => {
    const description = "d".repeat(1_000);
    const { text } = resultText([
      { type: "resource_link", uri: "file:///a.md", description },
    ]);
    expect(text).toBe(`uri: file:///a.md\ndescription: ${"d".repeat(400)}…`);
  });

  test("a resource_link that names nothing is still named, rather than dropped", () => {
    expect(resultText([{ type: "resource_link" }]).text).toBe(
      "[resource_link]",
    );
    expect(
      resultText([{ type: "resource_link", uri: "   ", name: "" }]).text,
    ).toBe("[resource_link]");
  });

  test("joins a resource_link beside a text part", () => {
    expect(
      resultText([
        { type: "text", text: "matching pages:" },
        {
          type: "resource_link",
          uri: "https://example.com/policy",
          name: "Expense policy",
        },
      ]).text,
    ).toBe(
      "matching pages:\nuri: https://example.com/policy\nname: Expense policy",
    );
  });

  test("names a null or non-object part rather than throwing", () => {
    // Content arrives from a vendor's server; a null entry must not throw.
    expect(resultText([null]).text).toBe("[unknown]");
    expect(resultText([undefined]).text).toBe("[unknown]");
    expect(resultText([42]).text).toBe("[unknown]");
  });

  test("a part that is only whitespace still counts as something being there", () => {
    // One blank part beside a real one must not make the whole result look empty.
    expect(
      resultText([
        { type: "text", text: " " },
        { type: "text", text: "real" },
      ]).text,
    ).toContain("real");
  });
});

describe("a result too large to hand a model", () => {
  test("is cut, and says that it was", () => {
    const enormous = "x".repeat(MAX_RESULT_CHARS + 500);
    const { text, truncated } = resultText([{ type: "text", text: enormous }]);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(enormous.length);
    // Visibly, never silently: a model that cannot tell it was given a fragment answers from the
    // fragment as though it were the whole thing.
    expect(text).toContain("truncated");
    expect(text).toContain(String(enormous.length));
  });

  test("a result exactly at the limit is left alone", () => {
    const exact = "x".repeat(MAX_RESULT_CHARS);
    const { text, truncated } = resultText([{ type: "text", text: exact }]);
    expect(truncated).toBe(false);
    expect(text).toBe(exact);
  });

  test("a cut that would land inside a character stops one code unit short", () => {
    // The limit counts UTF-16 code units, and an emoji is two of them. Cut between the two and the
    // result ends on a lone high surrogate: `JSON.stringify` sends it as a bare `\ud83d` and UTF-8
    // turns it into U+FFFD, so the model is handed a broken character for a reason that has nothing
    // to do with what the tool said. `extractDocumentText` guards the same cut on attachments.
    const emoji = "😀";
    expect(emoji.length).toBe(2);
    const input = `${"a".repeat(MAX_RESULT_CHARS - 1)}${emoji}tail`;
    const { text, truncated } = resultText([{ type: "text", text: input }]);
    expect(truncated).toBe(true);
    expect(text).toBe(
      `${"a".repeat(MAX_RESULT_CHARS - 1)}\n\n[truncated: the tool returned ${input.length} characters]`,
    );
  });

  test("a cut that lands between characters still keeps the whole limit", () => {
    const input = `${"a".repeat(MAX_RESULT_CHARS - 2)}😀tail`;
    const { text } = resultText([{ type: "text", text: input }]);
    expect(text).toBe(
      `${"a".repeat(MAX_RESULT_CHARS - 2)}😀\n\n[truncated: the tool returned ${input.length} characters]`,
    );
  });
});
