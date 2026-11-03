import { Streamdown } from "streamdown";
import { markdownComponents, markdownPlugins } from "@/lib/markdown";

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
 * The `Code` component a Bot draws in an interface, drawn the way a code block in its reply is.
 *
 * WHY NOT THE STANDARD ONE. CopilotKit's `Code` is a plain `<pre>`: no highlighting and no copy
 * button. Since Bots answer with generated interfaces by default, code a Bot is asked to write often
 * lands in one, and it read as a step down from the same code in a reply, which Streamdown draws with
 * Shiki and a copy button.
 *
 * WHY THROUGH MARKDOWN. The code goes through the same Streamdown, components and plugins as a reply,
 * as one fenced block, rather than through a second highlighter. The two are then the same markup, the
 * same themes, the same lazy load of Shiki and the same copy button, and cannot drift apart. Static,
 * because the fence is always closed: there is no half-written markdown to repair while it streams.
 */
export function A2UICode({
  text,
  language,
}: {
  text: string;
  language?: string | undefined;
}) {
  return (
    <Streamdown
      components={markdownComponents}
      mode="static"
      plugins={markdownPlugins}
    >
      {codeFence(text, language)}
    </Streamdown>
  );
}
