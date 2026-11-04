import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { realpathSync } from "node:fs";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { settleReactWork } from "./settle-react-work";

/**
 * Shiki is fetched with the first code block, not with the conversation. `@streamdown/code` imports
 * Shiki's core and regex engine at its top, so whatever imports it statically puts them in the chunk
 * every chat surface loads. Its loads are counted here; what it hands back is the real module.
 *
 * Not named `.test`: it only means something in a process where nothing has loaded Shiki yet, so
 * `code-highlighting-lazy.test.ts` runs it in one of its own.
 */

let loads = 0;
const real = realpathSync(Bun.resolveSync("@streamdown/code", import.meta.dir));
mock.module("@streamdown/code", async () => {
  loads += 1;
  // The same file under another specifier, so the mock does not resolve to itself.
  return await import(`${real}?real`);
});

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

test("a conversation loads Shiki only once it has code to highlight", async () => {
  const { ChatTranscript } = await import(
    "@/components/channels/chat-transcript"
  );
  const prose: Message[] = [
    { id: "u1", role: "user", content: "Hello" },
    { id: "a1", role: "assistant", content: "Hi. What are we building?" },
  ];
  const view = render(<ChatTranscript messages={prose} restoring={false} />);
  await view.findByText("Hi. What are we building?");
  expect(loads).toBe(0);
  cleanup();

  const code: Message[] = [
    ...prose,
    {
      id: "a2",
      role: "assistant",
      content: ["```python", "def greet(name):", "    return name", "```"].join(
        "\n",
      ),
    },
  ];
  const highlighted = render(
    <ChatTranscript messages={code} restoring={false} />,
  );
  await waitFor(() => {
    const keyword = Array.from(
      highlighted.container.querySelectorAll<HTMLElement>(
        '[data-streamdown="code-block-body"] code span',
      ),
    ).find((span) => span.textContent === "def");
    expect(keyword?.getAttribute("style") ?? "").toContain("--shiki-dark");
  });
  expect(loads).toBe(1);
});
