import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  ChatTranscript,
  ServerToolLine,
} from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * Code a Bot writes is highlighted, in a reply and in a tool's answer, with a colour for each theme
 * so the `.dark` switch picks between them.
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

const CODE = [
  "```python",
  "def greet(name):",
  '    return f"Hello, {name}!"',
  "```",
].join("\n");

/** The token `text` was drawn as, once the grammar has loaded. */
async function token(root: HTMLElement, text: string) {
  return waitFor(() => {
    const found = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-streamdown="code-block-body"] code span',
      ),
    ).find((span) => span.textContent === text);
    expect(found?.getAttribute("style") ?? "").toContain("--shiki-dark");
    return found as HTMLElement;
  });
}

test("a reply's code block is highlighted for both themes", async () => {
  const messages: Message[] = [
    { id: "u1", role: "user", content: "Write greet." },
    { id: "a1", role: "assistant", content: `Here it is:\n\n${CODE}` },
  ];
  const view = render(<ChatTranscript messages={messages} restoring={false} />);

  const keyword = await token(view.container, "def");
  const name = await token(view.container, "greet");
  // A keyword and a function name are told apart, in light and in dark.
  const light = (span: HTMLElement) => span.style.getPropertyValue("--sdm-c");
  const dark = (span: HTMLElement) =>
    span.style.getPropertyValue("--shiki-dark");
  expect(light(keyword)).not.toBe(light(name));
  expect(dark(keyword)).not.toBe(dark(name));
  expect(keyword.className).toContain("dark:text-[var(--shiki-dark");
});

test("code in a tool's answer is highlighted too", async () => {
  const view = render(<ServerToolLine name="mcp__docs__fetch" result={CODE} />);
  (view.container.querySelector("details") as HTMLDetailsElement).open = true;
  await token(view.container, "def");
});
