import type { ActivityMessage, Message, ToolCall } from "@ag-ui/core";
import { classifyAttachment } from "@/lib/channels/attachments";

/**
 * Transcript projection that pairs assistant tool calls with later tool-result messages.
 */

export type VisibleChatItem =
  | { kind: "text"; id: string; role: "user" | "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      toolCall: ToolCall;
      /** The result, once there is one. Absent means the call is still in flight. */
      result?: string;
    }
  /**
   * Something a Bot is drawing rather than saying.
   *
   * Carried whole rather than projected into fields of our own, because what is inside an activity
   * belongs to whoever renders it: an interface a Bot generated arrives here as partial HTML that
   * grows on every chunk, and the renderer that paints it is the one that knows what a half-finished
   * one looks like. Reshaping it on the way past would mean this file had to understand every
   * activity type anybody registers.
   */
  | { kind: "activity"; id: string; message: ActivityMessage }
  /**
   * EVERY file a person attached to one turn, pulled out of the array form of its content.
   *
   * One item for the whole turn rather than one per file, because they are drawn as one row of
   * thumbnails and a row is a single thing to lay out, to animate and to anchor the scroller on.
   * Splitting them made three files into three stacked rows, each as wide as the transcript.
   *
   * Still separate from the text item rather than riding inside it: a screenshot pasted with no
   * caption is an array holding only attachment parts, and the text item only exists when there is
   * text to show.
   */
  | {
      kind: "attachments";
      id: string;
      attachments: readonly SentAttachment[];
    };

/** One file on a sent turn. `id` is unique across the transcript, so it is also the render key. */
export type SentAttachment = {
  id: string;
  attachmentId: string;
  url: string;
  filename?: string;
  modality: "image" | "document";
};

/**
 * The SDK's own tool for drawing an interface, whose output is an activity rather than a result.
 *
 * Named here rather than imported because the SDK exports the renderer and the argument schema but
 * not the tool name; it is the string the runtime middleware matches on to emit the activity.
 */
const GENERATE_SANDBOXED_UI = "generateSandboxedUi";

/**
 * A content part this projection is willing to read, checked rather than trusted.
 *
 * THE TYPES SAY THIS CANNOT HAPPEN AND THE TYPES ARE NOT LOAD-BEARING HERE. A stored message is
 * parsed against a schema on its way out of the database; a LIVE one is whatever the run put in
 * the array the agent hands back, and nothing between that array and this function checks it. So
 * `[null]` and `[{ type: "image" }]` are both reachable, and both used to throw a TypeError —
 * `part.type` on the hole, `part.source.type` on the sourceless part.
 *
 * A THROW HERE IS NOT ONE BAD ROW. `toVisibleChatItems` runs inside `ChatTranscript`'s render, so
 * the exception escapes into React and takes the whole channel view down with it: one malformed
 * turn anywhere in a history and the conversation is a blank screen. Skipping the part instead
 * costs that part alone, which is the same caution the malformed-content bail below already takes
 * with the message as a whole.
 */
function isReadablePart(part: unknown): part is { type: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    typeof (part as { type?: unknown }).type === "string"
  );
}

/**
 * The words of a text part, when it actually carries any.
 *
 * AN EMPTY STRING IS NOT "ANY", and saying so here rather than at the join is what keeps the two
 * in step. `""` is a text part in good standing as far as the wire is concerned — a composer that
 * sends a caption part alongside a screenshot produces one whenever nothing was typed — but it has
 * no words in it, so returning it made `.join("\n")` prefix the real caption with a blank line and
 * Streamdown render a person's own message with an empty first row.
 */
function readText(part: { type: string }): string | null {
  if (part.type !== "text") return null;
  const text = (part as { text?: unknown }).text;
  return typeof text === "string" && text !== "" ? text : null;
}

/**
 * The attachment id named by a url, for a part that did not carry a usable one in its metadata.
 *
 * THE QUERY STRING AND THE FRAGMENT ARE NOT PART OF THE ID. Cutting at the last slash alone left
 * them on — `/api/attachments/<id>?v=2` became `"<id>?v=2"` — which is a wrong value sitting in a
 * field named for an id, and the field is typed `string` so nothing downstream has any reason to
 * doubt it. Only `sameAttachmentRow` compares it today, and it compares two values built the same
 * wrong way, which is exactly why this went unnoticed and why it is worth cutting properly now
 * rather than when the first reader builds a url back out of it.
 *
 * A fallback at all, rather than an empty string, because the id IS in the url for every url this
 * projection accepts: `SentAttachmentTile` refuses anything that does not start with
 * `attachmentUrl("")`, so the last segment of a servable url is the id the route will be asked for.
 */
function attachmentIdFromUrl(url: string): string {
  const [path = ""] = url.split(/[?#]/);
  return path.split("/").at(-1) ?? "";
}

/**
 * The two fields a tile reads off a part's `metadata`, checked rather than cast.
 *
 * THE LAST UNCHECKED READ IN THIS FILE, and it was unchecked for the least good reason: it does not
 * throw, so nothing ever pointed at it. `isReadablePart` and `isReadableToolCall` above were both
 * written after a TypeError took the channel view down; `metadata` fails quietly instead. `?.`
 * covers a null and a non-object yields `undefined` for both keys, so a bad value does not crash —
 * it just arrives. `metadata: { attachmentId: 42 }` put a number in `SentAttachment.attachmentId`,
 * which is DECLARED `string` and compared for identity by `sameAttachmentRow`, and a number
 * `filename` passed the truthiness spread below into `title={filename}` and an `alt` template.
 *
 * The source is the same unvalidated live-run array everything else here guards against: a stored
 * message is parsed against a schema on its way out of the database, a live one is whatever the run
 * put in the array. The types are not load-bearing here, which is this file's whole thesis.
 *
 * An EMPTY string is refused alongside a non-string, for both fields. An `attachmentId` of `""`
 * names nothing and would beat the url fallback that does; a `filename` of `""` draws a tile with a
 * blank name where "Untitled file" is the honest answer.
 */
function readAttachmentMetadata(part: { type: string }): {
  attachmentId?: string;
  filename?: string;
} {
  const raw = (part as { metadata?: unknown }).metadata;
  if (typeof raw !== "object" || raw === null) return {};
  const { attachmentId, filename } = raw as {
    attachmentId?: unknown;
    filename?: unknown;
  };

  return {
    ...(typeof attachmentId === "string" && attachmentId
      ? { attachmentId }
      : {}),
    ...(typeof filename === "string" && filename ? { filename } : {}),
  };
}

/**
 * The url a part points at and the type the SERVER gave the bytes behind it, or null when the part
 * does not point at a url at all.
 *
 * A `data` source is the ordinary reason for null — `copilot.ts` swaps the bytes in as the run is
 * built, so one can exist on a live turn — and a source that is missing, or carries no `value`, is
 * the malformed reason. Both answer the same question the same way: there is nothing to draw.
 *
 * `mimeType` IS READ OFF THE SOURCE AND NOT OFF `metadata` BECAUSE IT IS A REAL FIELD OF THE
 * SOURCE. `AttachmentSource` in `shared/attachments.ts` declares it optional on the url member, and
 * AG-UI's own `InputContentUrlSourceSchema` has it as `z.string().optional()` — so unlike a sibling
 * key hung off `metadata`, which that file's comment notes would be silently stripped, it survives
 * the `RunAgentInputSchema.parse` every stored message is put through on its way back through a
 * run. It is a declared field, not one invented here.
 *
 * Returned together with the url rather than through a second reader, because both come off ONE
 * value that has to be proved an object first. Two readers meant validating `source` twice and left
 * it possible for a caller to take the url from a source whose type it never checked.
 *
 * OPTIONAL, AND NARROWED THE WAY `readAttachmentMetadata` NARROWS ITS TWO. The same unvalidated
 * live-run array feeds this, so a non-string is refused — and so is `""`, which matters more than
 * it looks: `classifyAttachment("")` answers `"unsupported"`, so an empty string taken as an answer
 * would draw a file card over a screenshot on the strength of a field that says nothing.
 */
function readUrlSource(part: { type: string }): {
  url: string;
  mimeType?: string;
} | null {
  const source = (part as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) return null;
  const { type, value, mimeType } = source as {
    type?: unknown;
    value?: unknown;
    mimeType?: unknown;
  };
  /*
   * `""` IS THE "CARRIES NO `value`" CASE THIS DOC ALREADY PROMISED TO REFUSE, and `typeof` alone
   * let it through. What came out was a row rather than a skip: `attachmentIdFromUrl("")` answers
   * `""`, so `attachmentId` — a field named for an id, declared `string`, compared for identity by
   * `sameAttachmentRow` — held a value naming nothing, and `SentAttachmentTile` refuses any url
   * that does not start with `attachmentUrl("")`, so the reader was shown "This attachment is
   * unavailable." in the name of a file the server had never been asked about and had not lost.
   * That is the accusation the whole absent-file path is written to avoid, arrived at from a part
   * that simply had nothing in it.
   *
   * Narrowed the way every sibling in this file narrows: `readText`, both fields of
   * `readAttachmentMetadata`, and `mimeType` two lines below all refuse `""` as well as a
   * non-string, because an empty string is a value in good standing to `typeof` and an answer to
   * nobody.
   */
  if (type !== "url" || typeof value !== "string" || value === "") return null;
  return {
    url: value,
    ...(typeof mimeType === "string" && mimeType ? { mimeType } : {}),
  };
}

/**
 * WHAT A FILE IS DRAWN AS, DECIDED FROM THE BYTES WHEN THE BYTES HAVE BEEN READ, AND FROM THE
 * BROWSER'S GUESS ONLY WHEN THEY HAVE NOT.
 *
 * A staged attachment's `type` is a guess made before the file was uploaded and never revisited.
 * Verified against the installed SDK rather than assumed: `useAttachments.processFiles` sets
 * `type: getModalityFromMimeType(file.type)` on the placeholder, and that function maps everything
 * that is not `image/`, `audio/` or `video/` to `"document"`; when `onUpload` answers, the merge is
 * `{ ...att, source, status: "ready", thumbnail, metadata }`, which replaces the SOURCE and never
 * the `type`. So the stale guess and the server's answer sit side by side on the same object.
 *
 * THE DISAGREEMENT IS ENGINEERED, NOT EXOTIC. `composer/picked-files.ts` deliberately passes a
 * claim that names no format — `application/octet-stream`, or `""` — so that the server is the one
 * that decides, from `sniffMimeType` over the actual bytes. A PNG dragged out of an editor is
 * therefore an attachment whose `type` says `document` and whose source says `image/png`.
 *
 * IT IS NOT ONLY THE WRONG PICTURE, AND THE LOUD HALF IS THE ONE THAT MATTERS. A text file claimed
 * as an image draws an `<img>` the browser cannot decode, `onError` fires, and the tile asserts in
 * the file's own name that it is unavailable — telling somebody a file was deleted while it sits
 * there intact. That is the reason this function exists.
 *
 * The other direction used to be argued here as a cost and no longer is. `SentAttachmentTile` does
 * send a HEAD probe for a document and none for an image, and this paragraph claimed the probe
 * "costs the server the whole file out of Postgres", so that a mislabelled screenshot bought "a
 * megabyte read on every render of the transcript". The attachment route has since grown a HEAD
 * branch that selects `sizeBytes` and never the bytes, so what a mislabelled screenshot buys is one
 * cheap metadata round trip nobody needed. Still waste, not worth a sentence in this size — kept
 * only to say that the sentence it replaces is wrong, since two review rounds read it as current.
 *
 * `classifyAttachment` RATHER THAN `mimeType.startsWith("image/")`, and this is the load-bearing
 * choice. It is the same function `server/src/channels/attachment-parts.ts` gates on, so a picture
 * is drawn to the person exactly when a picture was put in front of the Bot; the two sides cannot
 * drift because they ask one question. It also settles HEIC correctly — an image by media type that
 * no `<img>` here can render, whose honest tile is the card naming the file.
 *
 * THE FALLBACK IS THE DECLARED TYPE, NOT `"document"`. `mimeType` is optional on both schemas, so a
 * part without one is well-formed rather than malformed, and today that is EVERY sent message: see
 * the note at the `modality` field in `toVisibleChatItems`. Collapsing them to file cards would
 * break every stored transcript that renders correctly now, which is a far larger population than
 * the mislabelled files this exists to fix.
 *
 * Exported because the QUEUE asks the same question of a parked message (`parkedTiles` in
 * `chat-transcript.tsx`) and a second copy of this rule is a second thing to get wrong. Those tiles
 * are meant to be the ones the turn will draw once it runs, so two rules that disagreed would show
 * as a tile changing shape at the moment of sending.
 */
export function attachmentModality(
  declaredType: string,
  mimeType?: string,
): "image" | "document" {
  if (mimeType === undefined) {
    return declaredType === "image" ? "image" : "document";
  }
  return classifyAttachment(mimeType) === "image" ? "image" : "document";
}

/**
 * A tool call with the three fields the transcript reads off it, checked rather than trusted.
 *
 * The same caution as `isReadablePart`, on the branch beside it: `toolCall.function.name` is read
 * three fields deep off whatever a live run put in the array, and the row it builds is keyed on the
 * id. Nothing between the run and here checks any of it.
 */
function isReadableToolCall(toolCall: unknown): toolCall is ToolCall {
  if (typeof toolCall !== "object" || toolCall === null) return false;
  const { id, function: called } = toolCall as {
    id?: unknown;
    function?: unknown;
  };
  if (typeof id !== "string") return false;
  if (typeof called !== "object" || called === null) return false;
  return typeof (called as { name?: unknown }).name === "string";
}

/** A tool result, as it arrives, its own message, pointing back at the call it answers. */
type ToolResultMessage = { role: "tool"; toolCallId: string; content?: string };

/**
 * A MESSAGE THAT IS AN OBJECT AT ALL AND CARRIES AN ID, which is a lower bar than any guard above
 * and was the one nobody had checked.
 *
 * Every other guard in this file defends the INSIDE of a message — a bad part, a bad tool call, a
 * `content` that is not what it claims. This defends the message itself, and it has to, because a
 * hole in the array throws EARLIER than any of them: `isToolResult` reads `.role` in the
 * results-gathering pass that runs before the projection begins, so `[null]` cost the whole array
 * rather than the one hole in it, and every careful skip below was bypassed on the way past.
 *
 * Same stakes the rest of the file was written for, and the same answer: `toVisibleChatItems` runs
 * inside `ChatTranscript`'s render, so the TypeError escapes into React and unmounts the channel
 * view. One malformed turn anywhere in a history and the conversation is a blank screen.
 *
 * Reachable for the reason `isReadablePart` gives: a stored message is parsed against a schema on
 * its way out of the database, but a LIVE one is whatever the run put in the array the agent hands
 * back, and nothing between that array and this function checks it.
 *
 * IT DOES NOT CHECK THE ID, AND `isDrawableMessage` BELOW IS WHERE THAT LIVES. Both passes need
 * the object check; only one of them keys anything on an id.
 */
function isReadableMessage(message: unknown): message is Readonly<Message> {
  return typeof message === "object" && message !== null;
}

/**
 * A MESSAGE THIS PROJECTION CAN KEY A ROW ON, which is the check `message.id` never had.
 *
 * IT IS THE FIELD THIS FILE WAS KEYED ON HARDEST WHILE TRUSTING IT MOST. `isReadableToolCall` below
 * has checked `toolCall.id` since the day it was written, with the reason in its own comment — "the
 * row it builds is keyed on the id". `message.id` is keyed on harder and was checked nowhere: it
 * becomes `VisibleChatItem.id`, which is DECLARED `string`, and downstream that one value is the
 * React key, `MessageScrollerItem`'s `messageId`, the turn-grouping key `anchorRowIds` and `turnOf`
 * cut apart at the last colon, and the memo key `createFirstPaintDelays` hangs an entrance delay
 * off.
 *
 * IT SURVIVED BECAUSE IT DOES NOT THROW — the same reason `readAttachmentMetadata` gives for its
 * own fields having gone unchecked, and the claim there that `metadata` was "the last unchecked
 * read in this file" was simply wrong; this was. A hole gets a text row `key={undefined}`, so React
 * warns and reconciles those rows by POSITION, and `data-message-id` is omitted so the scroller
 * never registers the row and it can never be a scroll anchor. The attachments row is quieter and
 * worse: `` `${message.id}:attachments` `` stringifies the hole, so every id-less turn in a history
 * collides on the literal `"undefined:attachments"` — one render key, one registration, one delay,
 * and two people's files drawn as one row.
 *
 * SEPARATE FROM `isReadableMessage` RATHER THAN FOLDED INTO IT, and the difference is which pass
 * runs it. The results-gathering pass above reads only `role`, `toolCallId` and `content` off a
 * tool result and keys the map on the TOOL CALL's id, which `isReadableToolCall` already checks; it
 * never keys anything on `message.id`. Refusing an id-less tool result there would drop the entry
 * from `results`, and the tool line it answers would then render as still-in-flight and shimmer for
 * ever — trading a real defect for a quieter one. So the object check guards both passes and the id
 * check guards only the pass that needs it.
 *
 * SKIPPING THE MESSAGE IS THE ANSWER RATHER THAN SYNTHESISING AN ID, because an id we invented
 * would be stable only within one render: `toVisibleChatItems` runs again on every chunk of a
 * streaming answer, so a counter or a `crypto.randomUUID()` would hand React a different key for
 * the same row on every frame and remount the message — entrance animation, scroll registration and
 * all — several times a second. A row nobody can key is a row this projection cannot draw, and
 * dropping it costs that row alone, which is the caution every other guard in this file takes.
 *
 * `""` IS REFUSED ALONGSIDE A NON-STRING, for the reason `readAttachmentMetadata` refuses an empty
 * `attachmentId`: it is a string, so a bare `typeof` admits it, and it names nothing. Two turns
 * carrying it collide on `":attachments"` exactly as two holes collide on `"undefined:attachments"`.
 */
function isDrawableMessage(message: Readonly<Message>): boolean {
  const { id } = message as { id?: unknown };
  return typeof id === "string" && id !== "";
}

function isToolResult(
  message: Readonly<Message>,
): message is Readonly<Message> & ToolResultMessage {
  return message.role === "tool" && "toolCallId" in message;
}

export function toVisibleChatItems(
  messages: ReadonlyArray<Readonly<Message>>,
): VisibleChatItem[] {
  // Gather results first so calls render with their current completion state in the same pass.
  const results = new Map<string, string | undefined>();
  for (const message of messages) {
    // Both passes over this array are guarded, not just this one: a guard on only the first would
    // move the throw into the flatMap below rather than remove it.
    if (!isReadableMessage(message)) continue;
    if (isToolResult(message)) results.set(message.toolCallId, message.content);
  }

  return messages.flatMap((message): VisibleChatItem[] => {
    if (!isReadableMessage(message)) return [];
    // Every row built below is keyed on `message.id`, including the one that keys on it by string
    // interpolation. See `isDrawableMessage` for why an unkeyable row is dropped rather than given
    // an id of our own.
    if (!isDrawableMessage(message)) return [];

    if (message.role === "assistant") {
      const items: VisibleChatItem[] = [];
      /*
       * `typeof`, NOT TRUTHINESS, and for the same reason the user branch below checks its own
       * content: a live turn is whatever the run produced, not whatever the type says. `[]` and
       * `{}` are both truthy, so both used to be pushed on as the `text` of a text item and handed
       * to the markdown renderer, which reads a string and throws on anything else — one flatMap
       * away from the throw the user branch was already defended against, and with the same cost:
       * the transcript renders this, so the exception unmounts the channel.
       */
      if (typeof message.content === "string" && message.content) {
        items.push({
          kind: "text",
          id: message.id,
          role: "assistant",
          text: message.content,
        });
      }
      // A `toolCalls` that is not a list is not iterable, and `for...of` reports that by throwing.
      for (const toolCall of Array.isArray(message.toolCalls)
        ? message.toolCalls
        : []) {
        // Read three fields deep off something nothing has validated: a hole in the array, or a
        // call with no `function`, threw before a single row could be drawn.
        if (!isReadableToolCall(toolCall)) continue;
        /*
         * The call that draws an interface is not a row of its own; the interface is.
         *
         * Its renderer shows the waiting message and then returns nothing, so once the interface has
         * arrived this leaves an empty item behind — invisible in itself, but still a child of a
         * `gap-6` column, so every generated interface gained a stray gap under it. The activity
         * beside it already shows its own progress while it is being written.
         */
        if (toolCall.function.name === GENERATE_SANDBOXED_UI) continue;
        items.push({
          kind: "tool",
          // One assistant message can carry multiple tool calls.
          id: toolCall.id,
          toolCall,
          ...(results.has(toolCall.id)
            ? { result: results.get(toolCall.id) }
            : {}),
        });
      }
      return items;
    }

    /*
     * Activities are their own messages, in order, beside the prose.
     *
     * Kept rather than dropped, which is what this projection used to do with every role it did not
     * name. A Bot that draws its own interface says nothing in `content` and calls no tool the
     * transcript can pair a result with — the whole answer is the activity. Falling through to the
     * bail below meant the turn rendered as silence.
     */
    if (message.role === "activity") {
      return [{ kind: "activity", id: message.id, message }];
    }

    if (message.role !== "user") return [];

    if (
      typeof message.content !== "string" &&
      !Array.isArray(message.content)
    ) {
      return [];
    }

    if (typeof message.content === "string") {
      const text = message.content;
      return text ? [{ kind: "text", id: message.id, role: "user", text }] : [];
    }

    const text = message.content
      .map((part) => (isReadablePart(part) ? readText(part) : null))
      .filter((part) => part !== null)
      .join("\n");

    /*
     * ATTACHMENTS FIRST, THEN THE CAPTION, which is the order they are read in and the order every
     * chat that carries files puts them in: the picture is what the sentence is about, so a
     * question that arrives above its own screenshot asks about something the reader has not seen
     * yet. This is the reverse of the parts' order inside the message — a composer sends the text
     * part first — and deliberately so; nothing downstream depends on matching the wire order, and
     * `anchorRowIds` picks whichever of these comes first, so a turn with a picture now anchors on
     * the picture.
     */
    const items: VisibleChatItem[] = [];

    /*
     * One row for all of them, with the caption appended after it (and absent rather than empty
     * when there is none). Only a `url` source ever reaches the browser this way —
     * `copilot.ts` swaps in the `data` source later, building the run — but a part is skipped
     * rather than thrown on if one ever did arrive here, and so is a part that is not a part at
     * all: see `isReadablePart`, and the whole-message caution above it that it extends.
     */
    const attachments: SentAttachment[] = [];
    message.content.forEach((part, index) => {
      if (!isReadablePart(part)) return;
      /*
       * THE SOURCE IS THE GATE AND `part.type` IS NOT, WHICH IS THE RULE THE SERVER ALREADY
       * APPLIES TO THE SAME PART.
       *
       * This used to require `part.type` to be `image` or `document`, and
       * `attachmentIdFor` in `server/src/channels/attachment-parts.ts` deliberately does the
       * opposite — its comment names gating on those two as "the alternative and is worse". AG-UI's
       * part union is `text | image | audio | video | document | binary`, and a client writing its
       * own message content can send any of the six naming one of our urls. The server therefore
       * RESOLVES such a part: it inlines the bytes into the run and stamps `attachedAt`, so the
       * sweeper spares the row. This file dropped it. The file went to the model, stayed on the
       * shelf for ever, and was drawn to the person who sent it nowhere at all — the one shape of
       * bug where the two sides disagreeing is invisible from either side alone.
       *
       * `readUrlSource` below is now the whole gate, and it is the same question the server asks:
       * is there a `url` source with something in it. A `text` part is unaffected, and that is not
       * luck — a well-formed one carries no `source` key, including all three the server
       * substitutes for an attachment it could not send (`unavailableNote`, `notIncludedNote` and
       * `unreadableNote` each write `{ type: "text", text }` and nothing else), so they all still
       * fall to `readText` and become the caption.
       *
       * WHAT THE PART TYPE IS STILL GOOD FOR IS THE MODALITY, AND ONLY AS A FALLBACK. It is handed
       * to `attachmentModality` below, which prefers the type the SERVER sniffed off the bytes
       * whenever the part carries one. So an `audio` part gets the file card rather than an `<img>`
       * that cannot decode — the honest tile for a kind this app has no viewer for — and a declared
       * type is never given the chance to claim a picture the bytes do not support.
       */
      const source = readUrlSource(part);
      if (source === null) return;
      const { url } = source;

      const metadata = readAttachmentMetadata(part);
      const attachmentId = metadata.attachmentId ?? attachmentIdFromUrl(url);

      attachments.push({
        // The PART's index, not the attachment's, so the id survives a caption being added or
        // removed above it and stays unique when one turn carries the same file twice. Counted
        // over the whole array, malformed parts included: skipping them in the count would
        // renumber every file after one and change the render key of a row already on screen.
        id: `${message.id}:${index}`,
        attachmentId,
        url,
        // Already narrowed to a non-empty string, or absent: see `readAttachmentMetadata`.
        ...(metadata.filename ? { filename: metadata.filename } : {}),
        /*
         * `source.mimeType` IS ALWAYS ABSENT HERE, AND THAT IS NO LONGER THE PROBLEM IT WAS.
         *
         * A sent message's part is built by `toAttachmentPart` in `channel-chat.tsx`, which writes
         * `source: { type: "url", value }` and carries no `mimeType` — so this call always falls
         * through to `part.type`. What changed is what `part.type` MEANS: that function now derives
         * it with this same `attachmentModality`, off the `mimeType` the server sniffed from the
         * bytes, instead of casting the browser's claim. The stored `type` is the corroborated
         * answer, so falling back to it is right rather than merely tolerable.
         *
         * The call keeps both arguments anyway. It costs nothing, it is the same rule the parked
         * tiles apply, and if a stored part ever does carry a `mimeType` — see the paragraph below,
         * which is the obvious way to fix history — this reads it without another change here.
         *
         * WHAT IS STILL WRONG IS HISTORY, AND ONLY HISTORY. A thread stored before that change kept
         * whatever the browser claimed, and no amount of client work will correct a row that is
         * already written. Putting it right means whoever serves a stored thread to the browser
         * supplying the type the attachment row already holds — a server change, written down here
         * rather than quietly half-done.
         */
        modality: attachmentModality(part.type, source.mimeType),
      });
    });

    if (attachments.length > 0) {
      items.push({
        kind: "attachments",
        // `turnOf` reads the message id back off this by cutting at the last colon, which is why
        // the suffix is a word rather than something that could be mistaken for one.
        id: `${message.id}:attachments`,
        attachments,
      });
    }

    if (text) items.push({ kind: "text", id: message.id, role: "user", text });

    return items;
  });
}
