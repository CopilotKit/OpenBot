import {
  IconFile,
  IconFileText,
  IconPresentation,
  IconTable,
} from "@tabler/icons-react";
import { useRouter } from "@tanstack/react-router";
import {
  type ComponentProps,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  type CodeHighlighterPlugin,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type MathPlugin,
  type PluginConfig,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { attachmentUrl as storedAttachmentUrl } from "@openbot/shared/attachments";
import { attachmentAddress } from "@/lib/channels/attachments";
import { MarkdownTable, TABLE_EXPORT_SKIP } from "@/lib/markdown-table";
import { hasMaths, withMathDelimiters } from "@/lib/maths";
import {
  NO_SLACK_NAMES,
  remarkSlackMentions,
  type SlackNames,
} from "@/lib/slack/mentions";

/**
 * Shared markdown rendering for Bot prose and tool results.
 *
 * Links open in a new tab with `noreferrer` because content can come from a model or remote MCP
 * server. A link to a page of the app itself, such as a task thread, opens in place.
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

/**
 * The app's own address a link names, as a path, or null for a link that leaves the app.
 *
 * A Bot links to one of its task threads by the path the app opens it at (`/channel/…`), and may
 * write it as a full address on this origin. Either is a page of the app, not somewhere else.
 */
export function inAppPath(
  href: string | undefined,
  origin = typeof window === "undefined" ? undefined : window.location.origin,
): string | null {
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (!origin) return null;
  try {
    const url = new URL(href);
    return url.origin === origin
      ? `${url.pathname}${url.search}${url.hash}`
      : null;
  } catch {
    return null;
  }
}

/**
 * A link to a page of the app, opened in place the way the app's own links open. Sent to a new tab
 * it opened a second window inside OpenBot Desktop, and lost the conversation the person was in.
 * A modified click still does what the browser does with it.
 */
function AppLink({
  path,
  children,
  // Streamdown hands every link a new tab; a page of the app keeps the window it is in.
  target: _target,
  rel: _rel,
  ...rest
}: ComponentProps<"a"> & { path: string }) {
  const router = useRouter({ warn: false });
  return (
    <a
      {...rest}
      className="underline underline-offset-2 hover:no-underline"
      href={path}
      onClick={(event) => {
        if (
          !router ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        void router.navigate({ to: path });
      }}
    >
      {children}
    </a>
  );
}

/**
 * The address a link to a stored file downloads it from, or null for a link that is not one.
 *
 * A Bot that sends a file names it in its words, linked to the form a message stores
 * (`/api/attachments/<id>`, from the send's answer), or now and then to the API's own address. Read
 * as a page of the app, a click asked the router for it, found no such page and landed on home, so
 * the person never got the file from the words (found by the end-to-end pass). It is the file, from
 * the conversation's own address, the one the card's Download button uses.
 */
export function fileAddress(path: string): string | null {
  if (path.startsWith(storedAttachmentUrl(""))) return attachmentAddress(path);
  return /^\/api\/v2\/organizations\/[^/]+\/attachments\/[^/?#]+/.test(path)
    ? path
    : null;
}

/** A file the conversation was sent, by its name and the stored form of its address. */
export type LinkedFile = { name: string; url: string };

const NO_FILES: readonly LinkedFile[] = [];

/**
 * The files a conversation was sent (a Bot's `computer_send_file` answers), for the Bot's words that
 * link one of them. The transcript provides it; a surface with no conversation has none.
 */
export const SentFilesContext = createContext<readonly LinkedFile[]>(NO_FILES);

/** Schemes that are never a link, whatever the rest of the address says. */
const NEVER_A_LINK = /^\s*(?:javascript|vbscript|data):/i;

/**
 * The file name a link names when it points at a place on a computer rather than at an address the
 * chat can open, or null for one that does not.
 *
 * A Bot that made a file sometimes links it by where it sits on its own computer: its workspace path
 * (`historical_mystery.pptx`, `decks/q3.pptx`), a folder there (`/tmp/outputs/q3.pptx`), or the
 * address some models give a file in their own sandbox (`sandbox:/mnt/data/q3.pptx`, `file:///…`).
 * The last part of any of them is the file's name. A web address, a mail or phone link, and a
 * protocol-relative address are addresses, not places on a computer.
 */
export function linkedFileName(href: string): string | null {
  if (NEVER_A_LINK.test(href)) return null;
  if (/^(?:https?|mailto|tel):/i.test(href) || href.startsWith("//"))
    return null;
  const path = href.split(/[?#]/, 1)[0] ?? "";
  let name = path.split(/[\\/]/).at(-1) ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // A malformed escape is not a name worth throwing over; match it as written.
  }
  // `sandbox:q3.pptx`: the scheme is not part of the name.
  name = name.replace(/^[a-z][a-z0-9+.-]*:/i, "").trim();
  return name || null;
}

/** The part of an HTML tree the link plugin reads and changes. */
type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/**
 * A rehype plugin: a link in a Bot's words that names, by its place on the Bot's computer, a file
 * the conversation was sent becomes a link to that stored file. `markdownComponents.a` then draws it
 * as the download the card's Download button is (`fileAddress`).
 *
 * WHY. Asked for a slide deck, a Bot made historical_mystery.pptx and sent it, and the card downloaded
 * it fine, but the Bot's words said "Download the presentation [blocked]". It had linked the file by
 * its workspace path, which no browser can open, and Streamdown's safety step (rehype-harden) swapped
 * the link for its words and a marker that reads like a security error. The person meant the file
 * the card holds, so that is where the link goes.
 *
 * RUNS BEFORE THE SANITIZER, which drops an href with a scheme it does not know (`sandbox:`,
 * `file:`) before anything after it can read the name. Only a name the conversation was sent is
 * changed, and only to that file's stored address, so it never makes a link out of anything else.
 *
 * THE FILES ARE ITS OPTIONS, NOT SOMETHING IT CLOSES OVER: Streamdown keeps one processor per set of
 * plugins, keyed by each plugin's name and the JSON of its options (as `remarkSlackMentions`).
 */
export function rehypeSentFileLinks(options?: {
  files?: readonly (readonly [string, string])[];
}) {
  // A later send of the same name is the one the words mean.
  const exact = new Map(options?.files ?? []);
  const anyCase = new Map(
    [...exact].map(([name, url]) => [name.toLowerCase(), url]),
  );
  const visit = (node: HastNode) => {
    if (node.type === "element" && node.tagName === "a") {
      const href = node.properties?.href;
      const name = typeof href === "string" ? linkedFileName(href) : null;
      const url =
        name === null
          ? undefined
          : (exact.get(name) ?? anyCase.get(name.toLowerCase()));
      if (url !== undefined)
        node.properties = { ...node.properties, href: url };
    }
    for (const child of node.children ?? []) visit(child);
  };
  return (tree: HastNode) => visit(tree);
}

const {
  raw: rehypeRaw,
  sanitize: rehypeSanitize,
  harden: hardenPluggable,
} = defaultRehypePlugins;
const [harden, hardenOptions] = hardenPluggable as unknown as [
  (...args: never[]) => unknown,
  Record<string, unknown>,
];

/**
 * Streamdown's own safety step, with one setting changed: a link it refuses is drawn as its words,
 * not as its words and " [blocked]" (rehype-harden's `linkBlockPolicy`, "text-only"). What it
 * refuses is unchanged: `javascript:`, `data:`, `file:`, `vbscript:` and anything it can't read as
 * an address are never links. A Bot's words are not a security report; a link the chat can't open
 * is still what the Bot meant to say.
 */
const hardenWithoutMarker = [
  harden,
  { ...hardenOptions, linkBlockPolicy: "text-only" },
] as const;

const rehypePluginsByFiles = new Map<
  string,
  NonNullable<StreamdownProps["rehypePlugins"]>
>();

/** The rehype plugins for a Bot's words, given the files its conversation was sent. */
function botRehypePlugins(
  files: readonly LinkedFile[],
): NonNullable<StreamdownProps["rehypePlugins"]> {
  // Only a stored file's own address, never anything else a caller handed in.
  const named = files
    .filter((file) => file.name && fileAddress(file.url) !== null)
    .map((file) => [file.name, file.url] as const);
  const key = JSON.stringify(named);
  let plugins = rehypePluginsByFiles.get(key);
  if (!plugins) {
    plugins = [
      rehypeRaw,
      ...(named.length > 0
        ? [[rehypeSentFileLinks, { files: named }] as const]
        : []),
      rehypeSanitize,
      hardenWithoutMarker,
    ] as NonNullable<StreamdownProps["rehypePlugins"]>;
    rehypePluginsByFiles.set(key, plugins);
  }
  return plugins;
}

/**
 * A link to a stored file: a download, so it never replaces the conversation. Saved under the
 * file's own name when the conversation was sent it, as the card's Download button saves it;
 * otherwise the server names it.
 */
function FileLink({
  address,
  children,
  // A download stays in the window it was asked from.
  target: _target,
  rel: _rel,
  ...rest
}: ComponentProps<"a"> & { address: string }) {
  const files = useContext(SentFilesContext);
  const name = files.findLast(
    (each) => fileAddress(each.url) === address,
  )?.name;
  return (
    <a
      {...rest}
      className="underline underline-offset-2 hover:no-underline"
      download={name ?? true}
      href={address}
    >
      {children}
    </a>
  );
}

export const markdownComponents = {
  // Streamdown's table, whose Copy and Download keep the table's links (`lib/markdown-table.tsx`).
  table: MarkdownTable,
  a: ({ href, children, ...rest }: ComponentProps<"a">) => {
    const path = inAppPath(href);
    const file = path === null ? null : fileAddress(path);
    if (file !== null)
      return (
        <FileLink {...rest} address={file}>
          {children}
        </FileLink>
      );
    // Any other address under /api is the server's, not a page: the router has nothing to open.
    if (path !== null && !path.startsWith("/api/"))
      return (
        <AppLink {...rest} path={path}>
          {children}
        </AppLink>
      );
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
          <span
            className="shrink-0 text-muted-foreground"
            {...TABLE_EXPORT_SKIP}
          >
            {kind.label}
          </span>
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
 * The remark plugins for a Bot's reply in a conversation: Streamdown's own, a single line ending
 * drawn as a line break, and Slack's mention markup shown as names (`lib/slack/mentions.ts`).
 *
 * WHY. Markdown reads one line ending as a space and wants a blank line or two trailing spaces for a
 * new line. A Bot asked for something "one per line" writes `Red\nGreen\nBlue` and the reader saw
 * "Red Green Blue", while their own message beside it keeps every line they typed. In a chat a line
 * ending is a line ending. Streamdown has no setting for it; its docs point at `remark-breaks`, whose
 * last release was September 2023, so this is the same transform written here in a dozen lines.
 *
 * ONLY FOR REPLIES. A document, a SKILL.md or a tool's answer is markdown written to be read as
 * markdown, where a wrapped line is meant to join the line before it, and keeps Streamdown's
 * defaults. One array per set of Slack names, so Streamdown sees the same plugins on every render
 * while the conversation's names are the same.
 */
const replyPlugins = new WeakMap<
  SlackNames,
  NonNullable<StreamdownProps["remarkPlugins"]>
>();

export function replyRemarkPluginsFor(
  names: SlackNames,
): NonNullable<StreamdownProps["remarkPlugins"]> {
  let plugins = replyPlugins.get(names);
  if (!plugins) {
    plugins = [
      ...Object.values(defaultRemarkPlugins),
      () => (tree: MarkdownNode) => breakLineEndings(tree),
      [remarkSlackMentions, { names: [...names] }],
    ];
    replyPlugins.set(names, plugins);
  }
  return plugins;
}

/** A reply with no conversation's Slack names to hand: mentions still never show as ids. */
export const replyRemarkPlugins = replyRemarkPluginsFor(NO_SLACK_NAMES);

let mathPlugin: MathPlugin | undefined;
let mathLoad: Promise<void> | undefined;
const mathListeners = new Set<() => void>();

/** Streamdown's maths plugin and KaTeX's stylesheet, fetched the first time a formula is drawn. */
function loadMathPlugin() {
  mathLoad ??= import("@/lib/math-plugin")
    .then(({ math }) => {
      mathPlugin = math;
      for (const listener of mathListeners) listener();
    })
    .catch((error: unknown) => {
      // The formula stays drawn as its source; say why rather than leave it so for no reason.
      console.error("Couldn't load maths rendering:", error);
      mathLoad = undefined;
    });
  return mathLoad;
}

function onMathPlugin(listener: () => void) {
  mathListeners.add(listener);
  return () => {
    mathListeners.delete(listener);
  };
}

const currentMathPlugin = () => mathPlugin;

/** One plugin set per set the caller passes, so Streamdown sees the same object on every render. */
const withMath = new WeakMap<PluginConfig, PluginConfig>();
const NO_PLUGINS: PluginConfig = {};

function pluginsWithMath(
  plugins: PluginConfig | undefined,
  math: MathPlugin | undefined,
): PluginConfig | undefined {
  if (!math) return plugins;
  const base = plugins ?? NO_PLUGINS;
  let all = withMath.get(base);
  if (!all) {
    all = { ...base, math };
    withMath.set(base, all);
  }
  return all;
}

/**
 * Streamdown, for a Bot's words wherever they are drawn, with its maths drawn as formulas.
 *
 * Takes everything Streamdown takes. The markdown has its `\( \)` and `\[ \]` written in the `$$`
 * the maths plugin reads (`lib/maths.ts`), and the plugin is added to the caller's plugins.
 *
 * LOADED WITH THE FIRST FORMULA, NOT WITH THE CHAT, as the code plugin is. KaTeX and its stylesheet
 * are most of the weight of drawing maths, and most conversations have none. The first formula is
 * drawn as its source for the moment the plugin takes to arrive, then as a formula; every one after
 * that draws as a formula from the start. Once in, the plugin stays with every surface, so a reply
 * that grows a formula as it streams keeps the same plugins.
 */
export function BotMarkdown({
  children,
  plugins,
  files,
  ...props
}: Omit<StreamdownProps, "children"> & {
  children: string;
  /**
   * The files sent with these words, for a surface that keeps them on the message (a group's).
   * Without it, the conversation's (`SentFilesContext`).
   */
  files?: readonly LinkedFile[];
}) {
  const conversationFiles = useContext(SentFilesContext);
  const sent = files ?? conversationFiles;
  const rehypePlugins = botRehypePlugins(sent);
  const markdown = useMemo(() => withMathDelimiters(children), [children]);
  const wantsMaths = hasMaths(markdown);
  const math = useSyncExternalStore(
    onMathPlugin,
    currentMathPlugin,
    currentMathPlugin,
  );
  useEffect(() => {
    if (wantsMaths && !math) void loadMathPlugin();
  }, [wantsMaths, math]);
  return (
    // The links in the words read the same files (`FileLink`).
    <SentFilesContext.Provider value={sent}>
      <Streamdown
        rehypePlugins={rehypePlugins}
        {...props}
        plugins={pluginsWithMath(plugins, math)}
      >
        {markdown}
      </Streamdown>
    </SentFilesContext.Provider>
  );
}
