import { Streamdown } from "streamdown";
import { markdownComponents, markdownPlugins } from "@/lib/markdown";

/**
 * Markdown and code a Bot draws in an interface, drawn the way its reply draws them.
 *
 * WHY NOT THE STANDARD ONES. CopilotKit's `Code` is a plain `<pre>`: no highlighting and no copy
 * button. Its `Markdown` renders through the SDK's own, older Streamdown, whose markup OpenBot's
 * stylesheet was never built from: its code blocks keep their light colours in the dark theme, where
 * they are close to unreadable, its tables and code blocks are a different design, and a link to a
 * connected document is underlined text rather than the chip a reply draws. Since Bots answer with
 * generated interfaces by default, code and prose a Bot is asked to write often land in one, and
 * they read as a step down from the same thing in a reply.
 *
 * WHY THE REPLY'S RENDERER. Both go through the same Streamdown, components and plugins as a reply,
 * rather than through a second highlighter. They are then the same markup, the same themes, the same
 * lazy load of Shiki, the same copy and download buttons and the same link handling, and cannot
 * drift apart.
 *
 * `a2ui-markdown` is the class the SDK's own `Markdown` wraps itself in, and the one its stylesheet
 * exempts from the surface's resets, which zero the margins of every paragraph, heading and `<pre>`.
 * Without it the spacing between paragraphs, lists and blocks would collapse. `openbot-markdown`
 * takes back the few properties the rest of that stylesheet still overrides; see styles.css.
 */
function ReplyMarkdown({
  children,
  streaming,
}: {
  children: string;
  streaming: boolean;
}) {
  return (
    <div className="a2ui-markdown openbot-markdown">
      <Streamdown
        components={markdownComponents}
        // As the transcript does for a message still arriving: half a list or an unclosed bold
        // marker is closed for the duration, rather than drawn as literal markers.
        mode={streaming ? "streaming" : "static"}
        plugins={markdownPlugins}
      >
        {children}
      </Streamdown>
    </div>
  );
}

/**
 * `text` as one fenced code block, in `language`, that nothing in `text` can close early.
 *
 * A fence closes on a line of backticks at least as long as the one that opened it, so the fence is
 * one longer than the longest run of backticks anywhere in the code, and never shorter than the usual
 * three. Code that quotes markdown, or a Rust doc comment with an example in it, then stays one block.
 *
 * The language goes on the opening line as its info string. A backtick fence's info string cannot
 * hold a backtick, and markdown reads only its first word as the language, so the language is cut to
 * that word without backticks. Anything left that Shiki does not know is drawn plain, as in a reply.
 */
export function codeFence(text: string, language?: string): string {
  const longestRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const info = (language ?? "").replace(/`/g, "").trim().split(/\s+/)[0];
  return `${fence}${info}\n${text}\n${fence}`;
}

/**
 * The catalog's `Code`: one fenced block. Never streaming, because the fence is always closed, so
 * there is no half-written markdown to repair.
 */
export function A2UICode({
  text,
  language,
}: {
  text: string;
  language?: string | undefined;
}) {
  return (
    <ReplyMarkdown streaming={false}>{codeFence(text, language)}</ReplyMarkdown>
  );
}

/** The catalog's `Markdown`, with its `streaming` flag doing what it does in the SDK's own. */
export function A2UIMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean | undefined;
}) {
  return <ReplyMarkdown streaming={streaming === true}>{text}</ReplyMarkdown>;
}
