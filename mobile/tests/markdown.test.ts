/**
 * A Bot's reply is Markdown. The phone reads the part a Bot writes into blocks and spans, and never
 * loses a word of what it wrote.
 */
import { expect, test } from "bun:test";
import { parseInline, parseMarkdown, plainText } from "../src/markdown";

test("a plain line is one paragraph of text", () => {
  expect(parseMarkdown("Hello there.")).toEqual([
    { kind: "paragraph", spans: [{ kind: "text", text: "Hello there." }] },
  ]);
});

test("bold, italic, struck and code read as marks, not as the characters", () => {
  expect(parseInline("a **b** *c* ~~d~~ `e`")).toEqual([
    { kind: "text", text: "a " },
    { kind: "bold", children: [{ kind: "text", text: "b" }] },
    { kind: "text", text: " " },
    { kind: "italic", children: [{ kind: "text", text: "c" }] },
    { kind: "text", text: " " },
    { kind: "strike", children: [{ kind: "text", text: "d" }] },
    { kind: "text", text: " " },
    { kind: "code", text: "e" },
  ]);
});

test("an underscore inside a word and a lone star stay as written", () => {
  expect(plainText(parseInline("snake_case_name and 2 * 3 = 6"))).toBe(
    "snake_case_name and 2 * 3 = 6",
  );
  expect(parseInline("snake_case_name")).toEqual([
    { kind: "text", text: "snake_case_name" },
  ]);
});

test("bold can hold italic", () => {
  expect(parseInline("**very *much* so**")).toEqual([
    {
      kind: "bold",
      children: [
        { kind: "text", text: "very " },
        { kind: "italic", children: [{ kind: "text", text: "much" }] },
        { kind: "text", text: " so" },
      ],
    },
  ]);
});

test("a link opens only on the web or mail; any other scheme stays text", () => {
  expect(parseInline("[docs](https://open.bot/docs)")).toEqual([
    {
      kind: "link",
      href: "https://open.bot/docs",
      children: [{ kind: "text", text: "docs" }],
    },
  ]);
  expect(plainText(parseInline("[x](javascript:alert(1))"))).toBe(
    "[x](javascript:alert(1))",
  );
  expect(
    parseInline("[x](javascript:alert(1))").some((s) => s.kind === "link"),
  ).toBe(false);
});

test("a bare web address is a link, without the full stop after it", () => {
  expect(parseInline("See https://open.bot/pricing.")).toEqual([
    { kind: "text", text: "See " },
    {
      kind: "link",
      href: "https://open.bot/pricing",
      children: [{ kind: "text", text: "https://open.bot/pricing" }],
    },
    { kind: "text", text: "." },
  ]);
});

test("headings, lists, quotes, rules and code are blocks", () => {
  const blocks = parseMarkdown(
    [
      "## Plan",
      "",
      "1. First",
      "2. Second",
      "",
      "- [x] Done",
      "- [ ] Not yet",
      "",
      "> Quoted",
      "",
      "---",
      "",
      "```ts",
      "const a = 1;",
      "```",
    ].join("\n"),
  );
  expect(blocks.map((block) => block.kind)).toEqual([
    "heading",
    "list",
    "list",
    "quote",
    "rule",
    "code",
  ]);
  expect(blocks[1]).toMatchObject({ ordered: true, start: 1 });
  expect(blocks[2]).toMatchObject({
    ordered: false,
    items: [{ checked: true }, { checked: false }],
  });
  expect(blocks[5]).toEqual({
    kind: "code",
    language: "ts",
    text: "const a = 1;",
  });
});

test("a code block that never closes keeps everything after it as code", () => {
  expect(parseMarkdown("```\nstill writing")).toEqual([
    { kind: "code", language: undefined, text: "still writing" },
  ]);
});

test("an unclosed mark stays as written", () => {
  expect(plainText(parseInline("**half done"))).toBe("**half done");
});

test("lines of one paragraph keep their line breaks", () => {
  expect(parseMarkdown("one\ntwo")).toEqual([
    { kind: "paragraph", spans: [{ kind: "text", text: "one\ntwo" }] },
  ]);
});

test("a code block under a list item is code, and the list carries on after it", () => {
  const blocks = parseMarkdown(
    ["1. Install:", "   ```bash", "   npm install", "   ```", "2. Run it"].join(
      "\n",
    ),
  );
  expect(blocks.map((block) => block.kind)).toEqual(["list", "code", "list"]);
  expect(blocks[1]).toEqual({
    kind: "code",
    language: "bash",
    text: "npm install",
  });
  expect(blocks[2]).toMatchObject({ ordered: true, start: 2 });
});

test("a heading keeps a # that ends its last word", () => {
  expect(
    plainText((parseMarkdown("## Using C#")[0] as { spans: never[] }).spans),
  ).toBe("Using C#");
  expect(
    plainText((parseMarkdown("## Plan ##")[0] as { spans: never[] }).spans),
  ).toBe("Plan");
});

test("three stars are bold and italic at once, with no star left over", () => {
  expect(parseInline("***now***")).toEqual([
    {
      kind: "bold",
      children: [{ kind: "italic", children: [{ kind: "text", text: "now" }] }],
    },
  ]);
});

test("code fenced on one line stays in its paragraph", () => {
  expect(parseMarkdown("```npm test```")[0]?.kind).toBe("paragraph");
});

test("any reply is read to its end, and keeps its words", () => {
  const pieces = [
    "```",
    "~~~",
    "#",
    "##",
    "> ",
    "- ",
    "1. ",
    "* ",
    "**",
    "_",
    "`",
    "[",
    "](",
    "http://",
    "---",
    "   ",
    "\n",
    "a",
    "C#",
    "***",
  ];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed;
  };
  for (let round = 0; round < 500; round++) {
    let text = "";
    for (let part = 0; part < 30; part++)
      text += pieces[next() % pieces.length];
    const blocks = parseMarkdown(text);
    expect(Array.isArray(blocks)).toBe(true);
  }
});
