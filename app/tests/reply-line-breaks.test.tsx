import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot asked for something "one per line" answers with single line endings, and the reader sees
 * one per line, the way a person's own message keeps the lines they typed. Markdown on its own reads
 * a single line ending as a space, which drew "Red\nGreen\nBlue" as "Red Green Blue". Code blocks,
 * lists and tables in the same reply draw as they always have.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The lines a block draws, read the way a reader sees them: a `<br>` starts a new one. */
function visibleLines(element: Element): string[] {
  const lines = [""];
  const walk = (node: Node) => {
    if (node.nodeName === "BR") lines.push("");
    else if (node.nodeType === 3)
      lines[lines.length - 1] += node.textContent ?? "";
    else node.childNodes.forEach(walk);
  };
  walk(element);
  return lines.map((line) => line.trim());
}

function transcript(person: string, bot: string) {
  const messages: Message[] = [
    { id: "u1", role: "user", content: person },
    { id: "a1", role: "assistant", content: bot },
  ];
  return render(<ChatTranscript messages={messages} restoring={false} />);
}

/** The Bot's reply, as drawn: everything Streamdown put on screen for it. */
async function reply(container: HTMLElement) {
  return waitFor(() => {
    const blocks = container.querySelectorAll("[data-streamdown], p, ul, ol");
    expect(blocks.length).toBeGreaterThan(0);
    return container;
  });
}

test("a reply's single line endings each start a new line", async () => {
  const view = transcript(
    "Now the same three in reverse alphabetical order, one per line.",
    "Red\nGreen\nBlue",
  );
  await reply(view.container);

  const paragraph = Array.from(view.container.querySelectorAll("p")).find((p) =>
    p.textContent?.includes("Green"),
  );
  expect(paragraph).toBeDefined();
  expect(visibleLines(paragraph as Element)).toEqual(["Red", "Green", "Blue"]);
});

test("code blocks, lists and tables in the same reply are drawn as before", async () => {
  const view = transcript(
    "Show me.",
    [
      "First line\nsecond line",
      "",
      "- one",
      "- two",
      "- three",
      "",
      "1. alpha",
      "2. beta",
      "",
      "| colour | hex |",
      "|---|---|",
      "| Red | #f00 |",
      "| Blue | #00f |",
      "",
      "```python",
      "def greet(name):",
      '    return f"Hello, {name}!"',
      "```",
      "",
      "Run `a\nb` and **bold\ntext**.",
    ].join("\n"),
  );
  await reply(view.container);

  // A list is still a list, one item per entry, with no stray breaks inside the items.
  const bullets = view.container.querySelector("ul");
  expect(
    Array.from(bullets?.querySelectorAll("li") ?? []).map((li) =>
      li.textContent?.trim(),
    ),
  ).toEqual(["one", "two", "three"]);
  const numbered = view.container.querySelector("ol");
  expect(
    Array.from(numbered?.querySelectorAll("li") ?? []).map((li) =>
      li.textContent?.trim(),
    ),
  ).toEqual(["alpha", "beta"]);
  expect(view.container.querySelectorAll("li br")).toHaveLength(0);

  // A table is still a table.
  const table = view.container.querySelector("table");
  expect(table?.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(table?.querySelectorAll("br")).toHaveLength(0);

  // Code keeps its own line endings as text, and gains no `<br>` from them.
  const code = await waitFor(() => {
    const body = view.container.querySelector(
      '[data-streamdown="code-block-body"]',
    );
    expect(body).not.toBeNull();
    return body as Element;
  });
  expect(code.textContent).toContain("def greet(name):");
  expect(code.textContent).toContain('return f"Hello, {name}!"');
  expect(code.querySelectorAll("br")).toHaveLength(0);

  // Inline code is code: its line ending is not turned into a break.
  const inline = view.container.querySelector(
    '[data-streamdown="inline-code"]',
  );
  expect(inline?.textContent).toBe("a b");
  expect(inline?.querySelectorAll("br")).toHaveLength(0);

  const prose = Array.from(view.container.querySelectorAll("p"));
  const first = prose.find((p) => p.textContent?.includes("First line"));
  expect(visibleLines(first as Element)).toEqual(["First line", "second line"]);
  // Emphasis across a line ending stays emphasis, broken where the Bot broke it.
  const bold = view.container.querySelector('[data-streamdown="strong"]');
  expect(visibleLines(bold as Element)).toEqual(["bold", "text"]);
});

test("a person's own message keeps its lines and is not drawn as markdown", async () => {
  const view = transcript("Red\nGreen\n*Blue*", "Noted.");
  await reply(view.container);

  const own = Array.from(
    view.container.querySelectorAll<HTMLElement>(".whitespace-pre-wrap"),
  ).find((element) => element.textContent?.includes("Green"));
  expect(own?.textContent).toBe("Red\nGreen\n*Blue*");
  expect(own?.querySelectorAll("br, em")).toHaveLength(0);
});
