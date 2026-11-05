import type { Message } from "@ag-ui/core";
import { toVisibleChatItems } from "./chat-messages";

/**
 * A conversation, as a Markdown file a person can keep, share or file.
 *
 * BUILT FROM THE TRANSCRIPT'S OWN PROJECTION, not from a second reading of the messages written
 * here. `toVisibleChatItems` is the one place that already knows how a turn is seen: tool calls
 * paired with the results that answered them, every file a person attached pulled out of the array
 * form of its content, and malformed rows skipped rather than thrown over. An export that read the
 * messages again would be a second opinion about all of that, and the two would drift: a file that
 * showed a tool call with no result beside a transcript that shows one is not an export of the
 * conversation, it is a different conversation.
 *
 * THE SERVER'S OWN SYSTEM ROWS ARE NOT IN IT, for the same reason they are not in the transcript:
 * the standing role and the granted-tools summary are instructions to a Bot about how to answer,
 * not part of what was said. `toVisibleChatItems` drops them, so this file does too, without either
 * naming them.
 */

/** How much of one tool result is worth putting in a file people read. Enough to remind, not enough to bury. */
const MAX_TOOL_RESULT_CHARACTERS = 4_000;

/** How much of one tool call's arguments the file names. The full input lives in the run, not the export. */
const MAX_TOOL_ARGUMENTS_CHARACTERS = 400;

/** How long a file name may be before the conversation's title is cut for it. */
const MAX_FILENAME_CHARACTERS = 80;

export type TranscriptExportInput = {
  /**
   * The conversation's own name, which for a channel is its Bot's name. What the roster falls back
   * to when nothing has named the conversation, and what the person most reliably recognises.
   */
  name: string;
  messages: ReadonlyArray<Readonly<Message>>;
  /**
   * Turns the history store holds that could not be read, as `readThreadMessages` counted them. A
   * record people keep must not have a hole in it that nothing accounts for, so the count becomes a
   * sentence at the head of the file rather than a silently shorter export.
   */
  unreadable: number;
  /** When the export was taken. Injectable so a test can hold the date still. */
  now?: Date;
};

/**
 * The whole conversation, in reading order, as Markdown.
 *
 * Nothing here throws: the projection this reads from has already refused every malformed row, and
 * an export that died on the one turn it could not parse would lose the whole conversation over it
 * — the trade `chat-messages.ts` already refuses for the transcript, made here for the same reason.
 */
export function transcriptMarkdown(input: TranscriptExportInput): string {
  const items = toVisibleChatItems(input.messages);
  const when = (input.now ?? new Date()).toLocaleString();
  const title = input.name.trim() || "Conversation";

  const parts: string[] = [
    `# ${title}`,
    "",
    `*Exported from OpenBot on ${when}.*`,
  ];

  if (input.unreadable > 0) {
    parts.push(
      "",
      `> ${input.unreadable} turn${input.unreadable === 1 ? "" : "s"} in this conversation could not be read and ${
        input.unreadable === 1 ? "is" : "are"
      } left out of this file.`,
    );
  }

  if (items.length === 0) {
    parts.push("", "Nothing has been said in this conversation yet.");
    return parts.join("\n");
  }

  for (const item of items) {
    parts.push("", ...itemMarkdown(item));
  }

  return parts.join("\n");
}

/* One transcript item, already projected, as the lines that carry it. */
function itemMarkdown(
  item: ReturnType<typeof toVisibleChatItems>[number],
): string[] {
  switch (item.kind) {
    case "text":
      return [
        `**${item.role === "user" ? "You" : "Assistant"}:**`,
        "",
        item.text,
      ];

    case "attachments":
      return [
        "**You attached:**",
        "",
        ...item.attachments.map(
          (attachment) =>
            `- ${attachment.filename ?? attachment.attachmentId}${
              attachment.modality === "image" ? " *(image)*" : ""
            }`,
        ),
      ];

    case "tool":
      return toolItemMarkdown(item);

    case "activity":
      /*
       * What an activity holds belongs to whoever renders it — the interface a Bot generated is
       * partial HTML while it grows, and this file is for reading, not for executing. That it
       * happened is the part a record of the conversation owes.
       */
      return ["**Assistant drew an interface in the conversation.**"];
  }
}

/* One tool call, with the result that answered it if it has arrived. */
function toolItemMarkdown(item: {
  toolCall: { function: { name: string; arguments: string } };
  result?: string;
}): string[] {
  const lines = [`**Assistant used \`${item.toolCall.function.name}\`:**`, ""];
  const arguments_ = compactArguments(item.toolCall.function.arguments);
  if (arguments_) {
    lines.push(fenced(arguments_), "");
  }
  if (item.result !== undefined) {
    const result = truncated(item.result, MAX_TOOL_RESULT_CHARACTERS);
    lines.push("**Result:**", "", fenced(result.text), "");
    if (result.truncated)
      lines.push("*(The rest of this result is not in the file.)*");
  }
  return lines;
}

/**
 * A tool call's arguments, short enough to name what was asked without carrying the whole input.
 *
 * Re-encoded when they parse, because the stored string is whatever the run streamed — an
 * arguments list spaced like a log line — and the compact form says the same thing in less file.
 * A string that does not parse is kept as it is, truncated: it may be a fragment of a stream that
 * never finished, and rewriting it would be guessing at what it meant to say.
 */
function compactArguments(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return truncated(
      JSON.stringify(JSON.parse(trimmed)),
      MAX_TOOL_ARGUMENTS_CHARACTERS,
    ).text;
  } catch {
    return truncated(trimmed, MAX_TOOL_ARGUMENTS_CHARACTERS).text;
  }
}

function truncated(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

/**
 * Text in a fenced block whose fence cannot be closed by the text itself.
 *
 * A result that contains ``` would close a three-backtick fence halfway and pour the rest of the
 * page into the file as Markdown. The fence is one backtick longer than the longest run the content
 * holds, so it stays a fence whatever the Bot read out of a file or a web page.
 */
function fenced(text: string): string {
  const longestRun =
    text
      .match(/`+/g)
      ?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * A file name safe to hand a browser's download dialog.
 *
 * A conversation's name is the model's own words, so `/` and `\` in it are not exotic — a title
 * like "fix src/app.ts" would otherwise name a directory the browser will not create, and the
 * download dies with no error on screen. Control characters go for the same reason, and the rest
 * is capped rather than left to the platform, because the cap is the only part of this the caller
 * can reason about.
 */
export function exportFilename(name: string): string {
  const withoutSeparatorsOrControls = name
    .trim()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point — the same class `oneLine` in server/src/channels/text.ts flattens a title with.
    .replace(/[\u0000-\u001f\u007f-\u009f/\\]+/g, " ");
  const cleaned = withoutSeparatorsOrControls.replace(/\s+/g, " ").trim();
  // Cut without an ellipsis: a file manager truncates the name for its own display anyway, and an
  // ellipsis here would spend one of the eighty characters saying nothing.
  const base =
    cleaned.length > 0
      ? cleaned.slice(0, MAX_FILENAME_CHARACTERS)
      : "conversation";
  return `${base}.md`;
}

/**
 * Offer a file to the browser as a download, and let go of the object URL behind it.
 *
 * The URL is revoked on the next tick rather than at once: the click is what starts the download,
 * and a URL released before the browser has taken the bytes is a download that never begins —
 * which reads, exactly like a failed pin, as the app ignoring the click.
 */
export function downloadMarkdown(filename: string, markdown: string): void {
  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
