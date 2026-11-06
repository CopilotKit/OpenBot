import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
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
import { codeFence } from "@/lib/copilot/a2ui-markdown";
import { settleReactWork } from "./settle-react-work";

/**
 * Code and markdown a Bot draws in an interface it generates are drawn the way its reply draws them:
 * code highlighted for both themes, with a copy button that copies it as written, and prose, tables
 * and links in the reply's own markup.
 *
 * Since Bots answer with generated interfaces by default, a Bot asked to write code often puts it in
 * the catalog's `Code` or `Markdown` component. The SDK's `Code` is a plain `<pre>`, and its
 * `Markdown` renders through its own, older Streamdown, whose code colours OpenBot's stylesheet does
 * not carry for the dark theme. These go through OpenBot's real catalog, the provider options the app
 * passes, and a surface as the runtime commits it.
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

/** The function alone, without the doc comment whose own fence would close a three-backtick block. */
const FUNCTION = FIZZBUZZ.split("\n").slice(5).join("\n");

/** Prose a Bot might put next to other components: a heading, a list, links, a table and code. */
const PROSE = [
  "## FizzBuzz in Rust",
  "",
  "With a [reference](https://doc.rust-lang.org/book/), the [spec](https://docs.google.com/document/d/abc/edit) and a [trap](javascript:alert(1)):",
  "",
  "- loops from **1** to `15`",
  "- prints *Fizz*, *Buzz* or both",
  "",
  "| n | prints |",
  "|---|---|",
  "| 3 | Fizz |",
  "| 15 | FizzBuzz |",
  "",
  "```rust",
  FUNCTION,
  "```",
].join("\n");

type Drawn =
  | { component: "Code"; text: string; language?: string }
  | { component: "Markdown"; text: string; streaming?: boolean };

/** What the runtime commits for a `render_ui` call that draws one component, inside a Card. */
function Committed({ surfaceId, drawn }: { surfaceId: string; drawn: Drawn }) {
  const runtime = useGenerativeUIRuntime();
  useEffect(() => {
    if (!runtime) return;
    runtime.manager.setActiveThread("thread-a2ui-markdown");
    runtime.manager.ingest("thread-a2ui-markdown", undefined, {
      surfaceId,
      target: surfaceId,
      catalogId: OPENBOT_UI.id,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "1.0",
          createSurface: { surfaceId, catalogId: OPENBOT_UI.id },
        },
        {
          version: "1.0",
          updateComponents: {
            surfaceId,
            components: [
              { id: "root", component: "Card", child: "drawn" },
              { id: "drawn", ...drawn },
            ],
          },
        },
      ],
    });
  }, [runtime, surfaceId, drawn]);
  return null;
}

function renderSurface(drawn: Drawn) {
  const surfaceId = `surface-${Math.random().toString(36).slice(2)}`;
  return render(
    <CopilotKitProvider {...generativeUiProviderOptions(true)}>
      <Committed surfaceId={surfaceId} drawn={drawn} />
      <GenerativeUISurface id={surfaceId} />
    </CopilotKitProvider>,
  );
}

function renderReply(content: string) {
  const messages: Message[] = [{ id: "a1", role: "assistant", content }];
  return render(<ChatTranscript messages={messages} restoring={false} />);
}

/** Waits for the surface to have drawn `snippet` at all, highlighted or not. */
async function drawn(root: HTMLElement, snippet: string) {
  await waitFor(() =>
    expect(root.querySelector(".a2ui-surface")?.textContent ?? "").toContain(
      snippet,
    ),
  );
}

/**
 * The span Shiki drew `token` as, once it has, coloured for both themes by the classes OpenBot's
 * stylesheet carries. The SDK's own Streamdown colours a token too, but through classes the app's
 * Tailwind never scanned, so in the dark theme its tokens keep their light colours.
 */
async function highlighted(root: HTMLElement, token: string) {
  return waitFor(() => {
    const span = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-streamdown="code-block-body"] code span',
      ),
    ).find((candidate) => candidate.textContent === token);
    expect(span?.getAttribute("style") ?? "").toContain("--shiki-dark");
    expect(span?.className ?? "").toContain("dark:text-[var(--shiki-dark");
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

/** The markup of what `selector` finds, once the code in it is highlighted. */
async function markup(root: HTMLElement, selector: string) {
  await highlighted(root, "fn");
  const found = root.querySelector(selector)?.outerHTML;
  expect(found).toBeTruthy();
  return found;
}

test("Rust in a Code component is highlighted for both themes", async () => {
  const view = renderSurface({
    component: "Code",
    text: FIZZBUZZ,
    language: "rust",
  });
  await drawn(view.container, 'println!("FizzBuzz")');
  const keyword = await highlighted(view.container, "fn");
  const name = await highlighted(view.container, "fizzbuzz");
  const light = (span: HTMLElement) => span.style.getPropertyValue("--sdm-c");
  const dark = (span: HTMLElement) =>
    span.style.getPropertyValue("--shiki-dark");
  // A keyword and a function name are told apart, in light and in dark.
  expect(light(keyword)).not.toBe(light(name));
  expect(dark(keyword)).not.toBe(dark(name));
  // The doc comment's own fence did not close the block: the whole function is in it.
  const body = view.container.querySelector(
    '.a2ui-surface [data-streamdown="code-block-body"]',
  );
  expect(body?.textContent).toContain('println!("FizzBuzz")');
  expect(body?.textContent).toContain("/// ```");
});

test("a Code component's copy button copies the code exactly as the Bot wrote it", async () => {
  const view = renderSurface({
    component: "Code",
    text: FIZZBUZZ,
    language: "rust",
  });
  await drawn(view.container, 'println!("FizzBuzz")');
  // As from a reply, the copy ends with the line break that ends the last line, and nothing else.
  expect(await copy(view.container)).toBe(`${FIZZBUZZ}\n`);
});

test("code in a language Shiki does not know is drawn plain, and still copies", async () => {
  const source = "PRINT 'hello'\nGOTO 10";
  const view = renderSurface({
    component: "Code",
    text: source,
    language: "not-a-language",
  });
  await drawn(view.container, "GOTO 10");
  expect(await copy(view.container)).toBe(`${source}\n`);
  const body = view.container.querySelector(
    '.a2ui-surface [data-streamdown="code-block-body"]',
  );
  expect(body?.textContent).toContain("GOTO 10");
  // Drawn in the theme's text colour, with no token coloured as anything.
  expect(body?.querySelector("code [style*='--sdm-c']")).toBeNull();
});

test("a Code component draws the same code block as a reply", async () => {
  const reply = renderReply(["```rust", FUNCTION, "```"].join("\n"));
  const inReply = await markup(
    reply.container,
    '[data-streamdown="code-block"]',
  );
  cleanup();
  const surface = renderSurface({
    component: "Code",
    text: FUNCTION,
    language: "rust",
  });
  expect(
    await markup(
      surface.container,
      '.a2ui-surface [data-streamdown="code-block"]',
    ),
  ).toBe(inReply);
});

test("a fenced Rust block in a Markdown component is highlighted, and copies exactly", async () => {
  const view = renderSurface({ component: "Markdown", text: PROSE });
  await drawn(view.container, 'println!("FizzBuzz")');
  const keyword = await highlighted(view.container, "fn");
  const name = await highlighted(view.container, "fizzbuzz");
  expect(keyword.style.getPropertyValue("--sdm-c")).not.toBe(
    name.style.getPropertyValue("--sdm-c"),
  );
  expect(await copy(view.container)).toBe(`${FUNCTION}\n`);
});

test("a Markdown component draws the same markup as the same markdown in a reply", async () => {
  // The Streamdown root: headings, list, links, table and code block, all of it.
  const root = '[data-streamdown="heading-2"]';
  const reply = renderReply(PROSE);
  await highlighted(reply.container, "fn");
  const inReply = reply.container.querySelector(root)?.parentElement?.outerHTML;
  expect(inReply).toBeTruthy();
  cleanup();

  const surface = renderSurface({ component: "Markdown", text: PROSE });
  await highlighted(surface.container, "fn");
  const inInterface = surface.container.querySelector(`.a2ui-surface ${root}`)
    ?.parentElement?.outerHTML;
  expect(inInterface).toBe(inReply);
});

test("links in a Markdown component open the way a reply's do", async () => {
  const view = renderSurface({ component: "Markdown", text: PROSE });
  await drawn(view.container, "FizzBuzz in Rust");
  const links = Array.from(
    view.container.querySelectorAll<HTMLAnchorElement>(".a2ui-surface a"),
  );
  // In a new tab, with no opener and no referrer: the text came from a model.
  const reference = links.find((link) => link.textContent === "reference");
  expect(reference?.getAttribute("href")).toBe(
    "https://doc.rust-lang.org/book/",
  );
  expect(reference?.getAttribute("target")).toBe("_blank");
  const rel = (link: HTMLAnchorElement | undefined) =>
    (link?.getAttribute("rel") ?? "").split(/\s+/).sort();
  expect(rel(reference)).toEqual(["noopener", "noreferrer"]);
  // A document in a connected system is the reply's chip, with its type after its name.
  const spec = links.find((link) =>
    link.getAttribute("href")?.startsWith("https://docs.google.com/"),
  );
  expect(spec?.textContent).toBe("specDoc");
  expect(rel(spec)).toEqual(["noopener", "noreferrer"]);
  // A script URL a model wrote never becomes a link that runs it.
  for (const link of links)
    expect(link.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
});

test("a streaming Markdown component closes what is still half-written, as a streaming reply does", async () => {
  const view = renderSurface({
    component: "Markdown",
    text: "Counting to **fifteen",
    streaming: true,
  });
  await drawn(view.container, "fifteen");
  const surface = view.container.querySelector(".a2ui-surface") as HTMLElement;
  expect(surface.textContent).not.toContain("**");
  expect(surface.querySelector('[data-streamdown="strong"]')?.textContent).toBe(
    "fifteen",
  );
});

test("the model is offered the standard Code and Markdown, so what Bots already write keeps drawing", () => {
  for (const name of ["Code", "Markdown"] as const)
    expect(OPENBOT_UI.manifestComponents[name]).toEqual(
      standardUI.manifestComponents[name],
    );
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

/**
 * CopilotKit's standard stylesheet is in no cascade layer, so in a browser it outranks Tailwind's
 * utilities, which are, whatever their specificity. Every property it sets on a heading or a button
 * that is not exempted for markdown would restyle the reply's markup inside an interface, so
 * styles.css must hand each one back to the layers.
 *
 * Read as the SDK injects it: the react-core module the app imports puts `STANDARD_CSS` in the page,
 * and takes it from `@copilotkit/shared`, resolved here from that module so it is the same copy. The
 * module picks its injection hook while it loads, before a test has a DOM, so it injects nothing here.
 */
test("everything the SDK's stylesheet sets on headings and buttons is handed back inside interface markdown", async () => {
  const module = Bun.resolveSync(
    "@copilotkit/react-core/v2/generative-ui",
    import.meta.dir,
  );
  expect(readFileSync(module, "utf8")).toContain(
    "style.textContent = STANDARD_CSS;",
  );
  const { STANDARD_CSS: sdk } = (await import(
    Bun.resolveSync("@copilotkit/shared/generative-ui", dirname(module))
  )) as { STANDARD_CSS: string };
  expect(sdk).toContain(".a2ui-surface");

  const rules = (css: string) =>
    Array.from(
      css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
      ([, selector, body]) => ({
        selector: selector.trim(),
        properties: Array.from(
          body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g),
          ([, name, value]) => ({ name, value: value.trim() }),
        ),
      }),
    );
  const reaching = rules(sdk).filter(
    ({ selector }) =>
      /\b(h[1-6]|button|input|select|textarea)\b/.test(selector) &&
      !selector.includes(":not(.a2ui-markdown *)") &&
      !/^\.a2ui-std-|^\[data-a2ui-(input|row)/.test(selector),
  );
  expect(reaching.length).toBeGreaterThan(0);

  const ours = rules(
    readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"),
  ).find(({ selector }) => selector.includes(".openbot-markdown"));
  expect(ours?.selector ?? "").toContain(":is(h1, h2, h3, h4, h5, h6, button");
  const reverted = new Set(
    ours?.properties
      .filter(({ value }) => value === "revert-layer")
      .map(({ name }) => name),
  );
  const FONT = /^(font-(size|weight|family|style)|line-height)$/;
  for (const { properties } of reaching)
    for (const { name } of properties)
      expect(
        reverted.has(name) || (FONT.test(name) && reverted.has("font"))
          ? name
          : `${name} is not handed back`,
      ).toBe(name);
});
