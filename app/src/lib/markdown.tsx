import {
  IconFile,
  IconFileText,
  IconPresentation,
  IconTable,
} from "@tabler/icons-react";
import type { ComponentProps } from "react";
import {
  type CodeHighlighterPlugin,
  defaultRemarkPlugins,
  type StreamdownProps,
} from "streamdown";

/**
 * Shared markdown rendering for Bot prose and tool results.
 *
 * Links open in a new tab with `noreferrer` because content can come from a model or remote MCP
 * server.
 */

/**
 * A document this deployment can recognise, drawn as a chip rather than as underlined text.
 *
 * WHY A CHIP. A knowledge answer is mostly a claim plus the thing it came from, and those two want
 * to look different. Underlined blue text in the middle of a sentence reads as "more about this";
 * a chip with the file's own type on it reads as "this is the document", which is the whole point of
 * a connector that answers from a live system. It also survives the model's phrasing: whether it
 * writes "I found it in X" or lists three files, each one is drawn the same way.
 *
 * Recognition is by URL, and only document hosts this deployment knows about. Anything else is an
 * ordinary link, because a chip asserts "this is a file in a system you have connected" and that
 * is not something to claim about a URL a model wrote.
 */
const DRIVE_KINDS = [
  { match: "/document/", icon: IconFileText, label: "Doc" },
  { match: "/spreadsheets/", icon: IconTable, label: "Sheet" },
  { match: "/presentation/", icon: IconPresentation, label: "Slides" },
] as const;

export function documentChipKind(href: string | undefined) {
  if (!href) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // A relative or malformed href is not a recognised document, and is not worth throwing over.
    return null;
  }

  /*
   * Exact hosts, never a suffix test. `docs.google.com.evil.test` ends with the string and is
   * somebody else's domain, and a chip is a statement that this is a real file in a real connected
   * system — the one kind of link where dressing up an impostor does actual harm.
   */
  if (url.protocol !== "https:") return null;
  if (url.hostname === "docs.google.com") {
    const kind = DRIVE_KINDS.find((entry) =>
      url.pathname.includes(entry.match),
    );
    // A docs.google.com URL of some other shape is still a Drive document, just not one of the three.
    return kind ?? { match: "", icon: IconFile, label: "Drive" };
  }
  if (url.hostname === "drive.google.com") {
    return { match: "", icon: IconFile, label: "Drive" };
  }
  /*
   * Same exact-host rule as Drive: a chip asserts "this is a document in a system you have
   * connected", and notion.so.evil.test is somebody else's domain wearing the name.
   */
  if (url.hostname === "notion.so" || url.hostname === "www.notion.so") {
    return { match: "", icon: IconFileText, label: "Notion" };
  }
  return null;
}

export const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentProps<"a">) => {
    const kind = documentChipKind(href);

    if (kind) {
      const Icon = kind.icon;
      return (
        <a
          {...rest}
          /*
           * `align-middle` and the tighter line height keep a chip from pushing the line it sits in
           * taller than its neighbours, which is what turns a paragraph with three citations in it
           * into a ragged block.
           */
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-1.5 py-0.5 align-middle text-xs leading-tight no-underline transition-colors hover:bg-muted"
          href={href}
          rel="noreferrer noopener"
          target="_blank"
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          {/* Truncated rather than wrapped: a long file name should not reflow the sentence around it. */}
          <span className="truncate">{children}</span>
          {/*
           * The type, after the name. It answers "can I open this, and with what" without the reader
           * hovering to read a URL, and it is the part a file name often leaves out.
           */}
          <span className="shrink-0 text-muted-foreground">{kind.label}</span>
        </a>
      );
    }

    return (
      <a
        {...rest}
        className="underline underline-offset-2 hover:no-underline"
        href={href}
        rel="noreferrer noopener"
        target="_blank"
      >
        {children}
      </a>
    );
  },
};

type Highlighted = Parameters<
  NonNullable<Parameters<CodeHighlighterPlugin["highlight"]>[1]>
>[0];

/** [light, dark]: Streamdown colours each token with both and OpenBot's `.dark` class picks one. */
const CODE_THEMES: ["github-light", "github-dark"] = [
  "github-light",
  "github-dark",
];

let codePlugin: Promise<CodeHighlighterPlugin> | undefined;

/** Streamdown's code plugin, fetched the first time a code block is drawn and kept from then on. */
function loadCodePlugin(): Promise<CodeHighlighterPlugin> {
  codePlugin ??= import("@streamdown/code").then(({ createCodePlugin }) =>
    createCodePlugin({ themes: CODE_THEMES }),
  );
  return codePlugin;
}

let loadedCodePlugin: CodeHighlighterPlugin | undefined;

/**
 * Syntax highlighting for fenced code, through Streamdown's own code plugin (Shiki), on every surface
 * that draws a Bot's markdown, so a code block follows the theme switch without being redrawn.
 *
 * LOADED WITH THE FIRST CODE BLOCK, NOT WITH THE CHAT. `@streamdown/code` imports Shiki's full entry
 * and its JavaScript regex engine at the top, so importing it here statically put Shiki's core in the
 * chunk every conversation loads, highlighted code or not. Shiki's grammars and themes were already
 * separate chunks, fetched per language. This stands in for the plugin with the same interface,
 * answers "not ready yet" to the first code block (Streamdown draws the plain code and waits for the
 * callback, exactly as it does while a grammar loads) and hands every call on once the plugin is in.
 */
export const markdownPlugins: { code: CodeHighlighterPlugin } = {
  code: {
    name: "shiki",
    type: "code-highlighter",
    getThemes: () => CODE_THEMES,
    supportsLanguage: (language) =>
      loadedCodePlugin?.supportsLanguage(language) ?? true,
    getSupportedLanguages: () =>
      loadedCodePlugin?.getSupportedLanguages() ?? [],
    highlight(options, callback) {
      if (loadedCodePlugin)
        return loadedCodePlugin.highlight(options, callback);
      loadCodePlugin()
        .then((plugin) => {
          loadedCodePlugin = plugin;
          const highlighted: Highlighted | null = plugin.highlight(
            options,
            callback,
          );
          if (highlighted) callback?.(highlighted);
        })
        .catch((error: unknown) => {
          // The code stays drawn, unhighlighted; say why rather than leave it plain for no reason.
          console.error("Couldn't load syntax highlighting:", error);
          codePlugin = undefined;
        });
      return null;
    },
  },
};

/** The part of a markdown tree this reads: a node, its text if it is text, and what it contains. */
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

const LINE_ENDING = /\r\n|\r|\n/;

/**
 * Every line ending inside running text becomes a line break, the way a chat shows what was typed.
 *
 * Only `text` nodes are split. Fenced and inline code, and raw HTML, keep their text in `value` with
 * no children, so their line endings are never touched; a line ending inside a list item, a quote, a
 * link or emphasis is a break where the Bot put it.
 */
function breakLineEndings(node: MarkdownNode) {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (
      child.type !== "text" ||
      !child.value ||
      !LINE_ENDING.test(child.value)
    ) {
      breakLineEndings(child);
      return [child];
    }
    return child.value
      .split(LINE_ENDING)
      .flatMap((line, index): MarkdownNode[] => [
        ...(index > 0 ? [{ type: "break" }] : []),
        ...(line ? [{ type: "text", value: line }] : []),
      ]);
  });
}

/**
 * The remark plugins for a Bot's reply in a conversation: Streamdown's own, plus a single line ending
 * drawn as a line break.
 *
 * WHY. Markdown reads one line ending as a space and wants a blank line or two trailing spaces for a
 * new line. A Bot asked for something "one per line" writes `Red\nGreen\nBlue` and the reader saw
 * "Red Green Blue", while their own message beside it keeps every line they typed. In a chat a line
 * ending is a line ending. Streamdown has no setting for it; its docs point at `remark-breaks`, whose
 * last release was September 2023, so this is the same transform written here in a dozen lines.
 *
 * ONLY FOR REPLIES. A document, a SKILL.md or a tool's answer is markdown written to be read as
 * markdown, where a wrapped line is meant to join the line before it, and keeps Streamdown's
 * defaults. One array for the module, so Streamdown sees the same plugins on every render.
 */
export const replyRemarkPlugins: NonNullable<StreamdownProps["remarkPlugins"]> =
  [
    ...Object.values(defaultRemarkPlugins),
    () => (tree: MarkdownNode) => breakLineEndings(tree),
  ];
