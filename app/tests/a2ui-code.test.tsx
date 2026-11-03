import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import {
  GenerativeUISurface,
  standardUI,
  useGenerativeUIRuntime,
} from "@copilotkit/react-core/v2/generative-ui";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { generativeUiProviderOptions, OPENBOT_UI } from "@/lib/copilot/a2ui";
import { codeFence } from "@/lib/copilot/a2ui-code";
import { settleReactWork } from "./settle-react-work";

/**
 * Code a Bot draws in an interface it generates is drawn the way code in its reply is: highlighted
 * for both themes, with a copy button that copies the code as written.
 *
 * Since Bots answer with generated interfaces by default, a Bot asked to write code often puts it in
 * the catalog's `Code` component. The SDK's own one is a plain `<pre>`, so the same fizzbuzz came out
 * uncoloured and uncopyable in an interface and highlighted in a reply. These go through OpenBot's
 * real catalog, the provider options the app passes, and a surface as the runtime commits it.
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

const FIZZBUZZ = [
  "/// Prints the numbers 1 to 15, with Fizz, Buzz and FizzBuzz.",
  "///",
  "/// ```",
  "/// fizzbuzz();",
  "/// ```",
  "fn fizzbuzz() {",
  "    for i in 1..=15 {",
  "        match (i % 3, i % 5) {",
  '            (0, 0) => println!("FizzBuzz"),',
  '            (0, _) => println!("Fizz"),',
  '            (_, 0) => println!("Buzz"),',
  '            _ => println!("{i}"),',
  "        }",
  "    }",
  "}",
].join("\n");

/** What the runtime commits for a `render_ui` call that draws one `Code` component. */
function CommittedCode({
  surfaceId,
  text,
  language,
}: {
  surfaceId: string;
  text: string;
  language?: string;
}) {
  const runtime = useGenerativeUIRuntime();
  useEffect(() => {
    if (!runtime) return;
    runtime.manager.setActiveThread("thread-code");
    runtime.manager.ingest("thread-code", undefined, {
      surfaceId,
      target: surfaceId,
      catalogId: OPENBOT_UI.id,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "v1.0",
          createSurface: { surfaceId, catalogId: OPENBOT_UI.id },
        },
        {
          version: "v1.0",
          updateComponents: {
            surfaceId,
            components: [
              {
                id: "root",
                component: "Code",
                text,
                ...(language ? { language } : {}),
              },
            ],
          },
        },
      ],
    });
  }, [runtime, surfaceId, text, language]);
  return null;
}

function renderCode(text: string, language?: string) {
  const surfaceId = `code-${Math.random().toString(36).slice(2)}`;
  return render(
    <CopilotKitProvider {...generativeUiProviderOptions(true)}>
      <CommittedCode
        surfaceId={surfaceId}
        text={text}
        {...(language ? { language } : {})}
      />
      <GenerativeUISurface id={surfaceId} />
    </CopilotKitProvider>,
  );
}

/** Waits for the surface to have drawn `snippet` at all, highlighted or not. */
async function drawn(root: HTMLElement, snippet: string) {
  await waitFor(() =>
    expect(root.querySelector(".a2ui-surface")?.textContent ?? "").toContain(
      snippet,
    ),
  );
}

/** The highlighted code block a surface drew, once Shiki has coloured `token` in it. */
async function highlighted(root: HTMLElement, token: string) {
  return waitFor(() => {
    const span = Array.from(
      root.querySelectorAll<HTMLElement>(
        '.a2ui-surface [data-streamdown="code-block-body"] code span',
      ),
    ).find((candidate) => candidate.textContent === token);
    expect(span?.getAttribute("style") ?? "").toContain("--shiki-dark");
    return span as HTMLElement;
  });
}

/** Clicks the block's copy button and returns what reached the clipboard. */
async function copy(root: HTMLElement) {
  const written: string[] = [];
  const writeText = spyOn(navigator.clipboard, "writeText").mockImplementation(
    async (text: string) => {
      written.push(text);
    },
  );
  try {
    const button = await waitFor(() => {
      const found = root.querySelector<HTMLButtonElement>(
        '.a2ui-surface [data-streamdown="code-block-copy-button"]',
      );
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    expect(button.getAttribute("aria-label")).toBe("Copy Code");
    fireEvent.click(button);
    await waitFor(() => expect(written).toHaveLength(1));
    return written[0];
  } finally {
    writeText.mockRestore();
  }
}

test("Rust in an interface is highlighted for both themes", async () => {
  const view = renderCode(FIZZBUZZ, "rust");
  await drawn(view.container, 'println!("FizzBuzz")');
  const keyword = await highlighted(view.container, "fn");
  const name = await highlighted(view.container, "fizzbuzz");
  const light = (span: HTMLElement) => span.style.getPropertyValue("--sdm-c");
  const dark = (span: HTMLElement) =>
    span.style.getPropertyValue("--shiki-dark");
  // A keyword and a function name are told apart, in light and in dark.
  expect(light(keyword)).not.toBe(light(name));
  expect(dark(keyword)).not.toBe(dark(name));
  expect(keyword.className).toContain("dark:text-[var(--shiki-dark");
  // The doc comment's own fence did not close the block: the whole function is in it.
  const body = view.container.querySelector(
    '.a2ui-surface [data-streamdown="code-block-body"]',
  );
  expect(body?.textContent).toContain('println!("FizzBuzz")');
  expect(body?.textContent).toContain("/// ```");
});

test("the copy button copies the code exactly as the Bot wrote it", async () => {
  const view = renderCode(FIZZBUZZ, "rust");
  await drawn(view.container, 'println!("FizzBuzz")');
  // As from a reply, the copy ends with the line break that ends the last line, and nothing else.
  expect(await copy(view.container)).toBe(`${FIZZBUZZ}\n`);
});

test("code in a language Shiki does not know is drawn plain, and still copies", async () => {
  const source = "PRINT 'hello'\nGOTO 10";
  const view = renderCode(source, "not-a-language");
  await drawn(view.container, "GOTO 10");
  expect(await copy(view.container)).toBe(`${source}\n`);
  const body = view.container.querySelector(
    '.a2ui-surface [data-streamdown="code-block-body"]',
  );
  expect(body?.textContent).toContain("GOTO 10");
  // Drawn in the theme's text colour, with no token coloured as anything.
  expect(body?.querySelector("code [style*='--sdm-c']")).toBeNull();
});

test("an interface draws code with the same markup as a reply", async () => {
  // Without the doc comment, whose own fence would close a reply's three-backtick block.
  const code = FIZZBUZZ.split("\n").slice(5).join("\n");
  const reply: Message[] = [
    {
      id: "a1",
      role: "assistant",
      content: ["```rust", code, "```"].join("\n"),
    },
  ];
  const chat = render(<ChatTranscript messages={reply} restoring={false} />);
  await waitFor(() => {
    const span = Array.from(
      chat.container.querySelectorAll<HTMLElement>(
        '[data-streamdown="code-block-body"] code span',
      ),
    ).find((candidate) => candidate.textContent === "fn");
    expect(span?.getAttribute("style") ?? "").toContain("--shiki-dark");
  });
  const inReply = chat.container.querySelector(
    '[data-streamdown="code-block"]',
  )?.outerHTML;

  const surface = renderCode(code, "rust");
  await highlighted(surface.container, "fn");
  const inInterface = surface.container.querySelector(
    '.a2ui-surface [data-streamdown="code-block"]',
  )?.outerHTML;

  expect(inReply).toBeTruthy();
  expect(inInterface).toBe(inReply);
});

test("no run of backticks in the code, and nothing in the language, can close the fence early", () => {
  // Markdown that itself quotes a fenced block, four backticks deep.
  const quoted = ["````md", "```js", "let a = 1;", "```", "````"].join("\n");
  expect(codeFence(quoted, "markdown")).toBe(
    ["`````markdown", quoted, "`````"].join("\n"),
  );
  // Only the language's first word, without backticks, goes on the opening line.
  expect(codeFence("x", "rust `title`\n```")).toBe("```rust\nx\n```");
  expect(codeFence("x")).toBe("```\nx\n```");
});

test("the model is offered the standard Code, so what Bots already write keeps drawing", () => {
  expect(OPENBOT_UI.manifestComponents.Code).toEqual(
    standardUI.manifestComponents.Code,
  );
});
