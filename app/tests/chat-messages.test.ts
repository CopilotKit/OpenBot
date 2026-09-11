import type { Message, ToolCall } from "@ag-ui/core";
import { describe, expect, test } from "bun:test";
import { toVisibleChatItems } from "../src/components/channels/chat-messages";

/**
 * What a channel transcript shows, out of the messages a run produced.
 *
 * The projection used to name the roles it understood and drop everything else, which was correct
 * while every answer was prose or a tool call. It stopped being correct once a Bot could answer by
 * drawing: a generated interface arrives as an activity message, says nothing in `content`, and
 * pairs with no tool result — so the turn rendered as silence. These cases hold that shut.
 */

const PROSE: Message = {
  id: "assistant-1",
  role: "assistant",
  content: "Here is how those issues group.",
};

/** A generated interface, mid-stream: the HTML grows on every chunk and `generating` is still true. */
const DRAWING: Message = {
  id: "activity-1",
  role: "activity",
  activityType: "open-generative-ui",
  content: {
    css: ".card { color: #0a0a0a }",
    cssComplete: true,
    html: ['<div class="card">'],
    htmlComplete: false,
    generating: true,
  },
};

describe("toVisibleChatItems", () => {
  test("keeps an activity, carrying the message whole", () => {
    expect(toVisibleChatItems([DRAWING])).toEqual([
      { kind: "activity", id: "activity-1", message: DRAWING },
    ]);
  });

  /*
   * The regression this projection had. A Bot that answers only by drawing produces exactly this
   * one message, so dropping it left a turn that had plainly happened showing nothing at all.
   */
  test("does not render a drawing-only turn as silence", () => {
    expect(toVisibleChatItems([DRAWING])).not.toEqual([]);
  });

  test("keeps an activity in its place beside the prose", () => {
    expect(
      toVisibleChatItems([PROSE, DRAWING]).map((item) => item.kind),
    ).toEqual(["text", "activity"]);
  });

  /*
   * An activity is a message in its own right, not something folded into the assistant turn that
   * preceded it: it renders as its own row, and both survive.
   */
  test("draws prose and an activity as two items", () => {
    const items = toVisibleChatItems([PROSE, DRAWING]);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      kind: "text",
      id: "assistant-1",
      role: "assistant",
      text: "Here is how those issues group.",
    });
  });

  // The roles this file already understood, so the addition above is not paid for elsewhere.
  test("still pairs a tool call with the result that answers it", () => {
    const toolCall: ToolCall = {
      id: "call-1",
      type: "function",
      function: { name: "botActivity", arguments: '{"days":7}' },
    };
    const called: Message = {
      id: "assistant-2",
      role: "assistant",
      content: "",
      toolCalls: [toolCall],
    };
    const answered: Message = {
      id: "result-1",
      role: "tool",
      toolCallId: "call-1",
      content: "42",
    };

    expect(toVisibleChatItems([called, answered])).toEqual([
      {
        kind: "tool",
        id: "call-1",
        toolCall,
        result: "42",
      },
    ]);
  });

  /*
   * The call that produces a generated interface is not a row of its own.
   *
   * Its renderer shows the waiting message and then returns nothing, so keeping the item left an
   * empty child in a `gap-6` column and every generated interface gained a stray gap beneath it.
   */
  test("drops the call that draws an interface, and keeps the interface", () => {
    const drawing: Message = {
      id: "assistant-3",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-2",
          type: "function",
          function: { name: "generateSandboxedUi", arguments: "{}" },
        },
      ],
    };

    expect(toVisibleChatItems([drawing, DRAWING])).toEqual([
      { kind: "activity", id: "activity-1", message: DRAWING },
    ]);
  });

  // Every other tool still gets its row: only the one whose output is the activity is dropped.
  test("keeps a call from any other tool", () => {
    const other: Message = {
      id: "assistant-4",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-3",
          type: "function",
          function: { name: "botActivity", arguments: "{}" },
        },
      ],
    };

    expect(toVisibleChatItems([other]).map((item) => item.kind)).toEqual([
      "tool",
    ]);
  });

  // Roles the transcript has nothing to draw for are still dropped rather than rendered empty.
  test("drops a role it has nothing to show", () => {
    const thinking: Message = {
      id: "reasoning-1",
      role: "reasoning",
      content: "considering the grouping",
    };

    expect(toVisibleChatItems([thinking])).toEqual([]);
  });

  test("drops a malformed live user turn instead of throwing", () => {
    // Live turns bypass schema validation; one bad turn must not unmount the transcript.
    for (const content of [undefined, null, 42] as unknown[]) {
      const bad = {
        id: "user-bad",
        role: "user",
        content,
      } as unknown as Message;
      expect(toVisibleChatItems([bad])).toEqual([]);
    }
  });

  /*
   * THE SAME DEFENCE, ONE LEVEL DOWN, AND THE CASE ABOVE WAS NOT IT. Non-array content never
   * reaches the part loop at all, so it proved nothing about what the loop does with a part that
   * is not a part: `[null]` was read for `.type` and `[{ type: "image" }]` for `.source.type`, and
   * either one threw a TypeError out of `toVisibleChatItems` — which runs inside `ChatTranscript`'s
   * own render, so the throw did not spoil one row, it UNMOUNTED THE WHOLE CHANNEL VIEW. One
   * malformed turn anywhere in a channel's history took the conversation with it.
   *
   * Every shape here is one a live turn can carry: content arrays skip the schema the stored ones
   * are parsed by, so a part with a missing `source`, a source with no `value`, or a hole in the
   * array is only ever a bad producer away.
   */
  test("drops a malformed part instead of throwing out of render", () => {
    const malformed: unknown[][] = [
      [null],
      [undefined],
      [42],
      ["a bare string"],
      [{}],
      [{ type: "image" }],
      [{ type: "document" }],
      [{ type: "image", source: null }],
      [{ type: "image", source: { type: "url" } }],
      [{ type: "text" }],
    ];

    for (const content of malformed) {
      const bad = {
        id: "user-bad",
        role: "user",
        content,
      } as unknown as Message;
      expect(() => toVisibleChatItems([bad])).not.toThrow();
      expect(toVisibleChatItems([bad])).toEqual([]);
    }
  });

  /*
   * And the turn is not thrown away wholesale either: the good part beside the bad one still
   * draws, keeping its own index, because that index is what the render key is built from.
   */
  test("keeps the sound parts of a turn that also carries a malformed one", () => {
    const mixed = {
      id: "user-6",
      role: "user",
      content: [
        null,
        { type: "text", text: "the second one is fine" },
        {
          type: "image",
          source: { type: "url", value: "/api/attachments/att-7" },
          metadata: { attachmentId: "att-7", filename: "shot.png" },
        },
      ],
    } as unknown as Message;

    expect(toVisibleChatItems([mixed])).toEqual([
      {
        kind: "attachments",
        id: "user-6:attachments",
        attachments: [
          {
            // The PART's index, counted over the whole array — the malformed hole included, since
            // dropping it from the count would renumber every file after it.
            id: "user-6:2",
            attachmentId: "att-7",
            url: "/api/attachments/att-7",
            filename: "shot.png",
            modality: "image",
          },
        ],
      },
      {
        kind: "text",
        id: "user-6",
        role: "user",
        text: "the second one is fine",
      },
    ]);
  });

  /*
   * Every stored channel message is a plain string, never the array form a live composer produces.
   * Adding array-content handling below must not so much as touch this path.
   */
  test("projects a string-content user message exactly as before", () => {
    const said: Message = {
      id: "user-1",
      role: "user",
      content: "Here is the screenshot you asked for.",
    };

    expect(toVisibleChatItems([said])).toEqual([
      {
        kind: "text",
        id: "user-1",
        role: "user",
        text: "Here is the screenshot you asked for.",
      },
    ]);
  });

  /*
   * The regression this task fixes. A screenshot pasted with no caption is a content array holding
   * only an attachment part, so the joined text is empty — the old code returned `[]` for the whole
   * message, and a bare screenshot showed as though nothing had been sent.
   */
  test("does not drop a user turn that is only an attachment, with no caption", () => {
    const screenshotOnly: Message = {
      id: "user-2",
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "url", value: "/api/attachments/att-1" },
          metadata: { attachmentId: "att-1", filename: "screenshot.png" },
        },
      ],
    } as unknown as Message;

    expect(toVisibleChatItems([screenshotOnly])).toEqual([
      {
        kind: "attachments",
        id: "user-2:attachments",
        attachments: [
          {
            id: "user-2:0",
            attachmentId: "att-1",
            url: "/api/attachments/att-1",
            filename: "screenshot.png",
            modality: "image",
          },
        ],
      },
    ]);
  });

  // ONE ROW FOR ALL OF THEM, and the caption after it. Three files used to be three stacked rows
  // each as wide as the transcript; they are drawn as a single row of thumbnails now, so they are a
  // single item to lay out, to animate and to anchor the scroller on.
  test("gathers a turn's files into one row, above the caption", () => {
    const captioned: Message = {
      id: "user-3",
      role: "user",
      content: [
        { type: "text", text: "Two files, see attached." },
        {
          type: "image",
          source: { type: "url", value: "/api/attachments/att-2" },
          metadata: { attachmentId: "att-2", filename: "photo.jpg" },
        },
        {
          type: "document",
          source: { type: "url", value: "/api/attachments/att-3" },
          metadata: { attachmentId: "att-3" },
        },
      ],
    } as unknown as Message;

    expect(toVisibleChatItems([captioned])).toEqual([
      {
        kind: "attachments",
        id: "user-3:attachments",
        attachments: [
          {
            // The PART's index, so it does not shift when the caption above it is added or removed.
            id: "user-3:1",
            attachmentId: "att-2",
            url: "/api/attachments/att-2",
            filename: "photo.jpg",
            modality: "image",
          },
          {
            id: "user-3:2",
            attachmentId: "att-3",
            url: "/api/attachments/att-3",
            modality: "document",
          },
        ],
      },
      {
        kind: "text",
        id: "user-3",
        role: "user",
        text: "Two files, see attached.",
      },
    ]);
  });

  // A data-sourced part never reaches the browser as a stored message, but must not throw either.
  test("skips an attachment part whose source is not a url", () => {
    const dataSourced: Message = {
      id: "user-4",
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "data", value: "aGVsbG8=", mimeType: "image/png" },
        },
      ],
    } as unknown as Message;

    expect(toVisibleChatItems([dataSourced])).toEqual([]);
  });

  // No attachmentId in metadata: falls back to the trailing path segment of the url.
  test("derives the attachment id from the url when metadata carries none", () => {
    const noMetadata: Message = {
      id: "user-5",
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "url", value: "/api/attachments/att-9" },
        },
      ],
    } as unknown as Message;

    expect(toVisibleChatItems([noMetadata])).toEqual([
      {
        kind: "attachments",
        id: "user-5:attachments",
        attachments: [
          {
            id: "user-5:0",
            attachmentId: "att-9",
            url: "/api/attachments/att-9",
            modality: "document",
          },
        ],
      },
    ]);
  });

  /*
   * THE SAME DEFENCE THE USER BRANCH HAS, ON THE BRANCH BESIDE IT. A live assistant turn skips the
   * schema exactly as a live user turn does, and this branch trusted `content` to be a string on
   * the strength of the type alone: `if (message.content)` is TRUE for `[]` and for `{}`, so both
   * were passed down as the `text` of a text item and handed to the markdown renderer, which reads
   * them as a string and throws. A throw here unmounts the channel view, same as the user branch's
   * did — the two are one flatMap apart.
   */
  test("drops an assistant turn whose content is not words", () => {
    for (const content of [
      [],
      {},
      42,
      [{ type: "text", text: "hi" }],
    ] as unknown[]) {
      const bad = {
        id: "assistant-bad",
        role: "assistant",
        content,
      } as unknown as Message;
      expect(() => toVisibleChatItems([bad])).not.toThrow();
      expect(toVisibleChatItems([bad])).toEqual([]);
    }
  });

  /*
   * And the calls beside it, which are read three fields deep — `toolCall.function.name` — off
   * whatever the run put in the array. A hole in it, or a call with no function, threw before the
   * transcript could draw a single row.
   */
  test("skips a malformed tool call rather than throwing", () => {
    const malformed: unknown[] = [
      null,
      undefined,
      42,
      {},
      { id: "call-x" },
      { id: "call-x", function: null },
      { id: "call-x", function: {} },
    ];

    for (const toolCall of malformed) {
      const bad = {
        id: "assistant-bad",
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
      } as unknown as Message;
      expect(() => toVisibleChatItems([bad])).not.toThrow();
      expect(toVisibleChatItems([bad])).toEqual([]);
    }
  });

  test("keeps a sound tool call beside a malformed one", () => {
    const mixed = {
      id: "assistant-5",
      role: "assistant",
      content: "",
      toolCalls: [
        null,
        {
          id: "call-4",
          type: "function",
          function: { name: "botActivity", arguments: "{}" },
        },
      ],
    } as unknown as Message;

    expect(toVisibleChatItems([mixed]).map((item) => item.id)).toEqual([
      "call-4",
    ]);
  });

  // `toolCalls` that is not a list at all is not iterable, and `for...of` says so by throwing.
  test("survives a toolCalls that is not a list", () => {
    const bad = {
      id: "assistant-6",
      role: "assistant",
      content: "still talking",
      toolCalls: { id: "call-5" },
    } as unknown as Message;

    expect(toVisibleChatItems([bad])).toEqual([
      {
        kind: "text",
        id: "assistant-6",
        role: "assistant",
        text: "still talking",
      },
    ]);
  });

  /*
   * A HOLE IN THE MESSAGE ARRAY, WHICH IS THE ONE THIS FILE HAD NOT DEFENDED.
   *
   * Every guard above is about a bad PART, or bad `toolCalls`, inside a message that is itself an
   * object. A `null` MESSAGE throws earlier than any of them: `isToolResult` reads `message.role`
   * in the results-gathering loop that runs before the projection begins, so the whole array is
   * lost — not the one hole in it — and none of the per-message care below ever gets to run.
   *
   * Same stakes as the rest: `toVisibleChatItems` runs inside `ChatTranscript`'s render, so the
   * TypeError escapes into React and the channel view unmounts. A history with one hole in it is a
   * blank screen instead of a conversation with one turn missing.
   *
   * `undefined` beside `null` because a sparse array and a dropped element produce different holes
   * and only one of them is `null`.
   */
  test("drops a hole in the message array instead of throwing out of render", () => {
    for (const hole of [null, undefined]) {
      const messages = [hole, PROSE] as unknown as Message[];

      expect(() => toVisibleChatItems(messages)).not.toThrow();
      // And the sound message beside the hole still projects: the hole costs itself and nothing
      // else, which is the whole point of skipping it rather than bailing on the array.
      expect(toVisibleChatItems(messages)).toEqual([
        {
          kind: "text",
          id: PROSE.id,
          role: "assistant",
          text: PROSE.content as string,
        },
      ]);
    }
  });

  /*
   * A hole where a TOOL RESULT would have been, which is the other half of the same loop.
   *
   * The results pass and the projection pass walk the same array, so a guard added to only one of
   * them moves the throw rather than removing it. This pins that a hole sitting beside a real
   * call-and-result pair costs neither of them: the call still finds its answer.
   */
  test("a hole beside a tool result still lets the call find its answer", () => {
    const messages = [
      null,
      {
        id: "assistant-7",
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: "the answer" },
    ] as unknown as Message[];

    expect(toVisibleChatItems(messages)).toEqual([
      {
        kind: "tool",
        id: "call-1",
        toolCall: {
          id: "call-1",
          type: "function",
          function: { name: "search", arguments: "{}" },
        },
        result: "the answer",
      },
    ]);
  });

  /*
   * `metadata` IS READ OFF THE SAME UNVALIDATED ARRAY AS EVERYTHING ELSE HERE, and was the one
   * field taken on trust. It does not throw — `?.` covers a null, and a string or a number yields
   * `undefined` for both keys — so the damage is quieter than the crashes the guards above exist
   * for: a number lands in `attachmentId`, which is DECLARED `string` and compared for identity by
   * `sameAttachmentRow`, and in `filename`, which reaches `title={filename}` and an `alt` template.
   *
   * A number is used rather than an object because it is the shape that survives furthest: `?.`
   * and the truthiness check at the `filename` spread both wave it through.
   */
  test("ignores metadata fields that are not strings", () => {
    const wrong: Message = {
      id: "user-meta",
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "url", value: "/api/attachments/att-9" },
          metadata: { attachmentId: 42, filename: 99 },
        },
      ],
    } as unknown as Message;

    expect(toVisibleChatItems([wrong])).toEqual([
      {
        kind: "attachments",
        id: "user-meta:attachments",
        attachments: [
          {
            id: "user-meta:0",
            // Fell back to the url rather than carrying the number: the field is named for an id
            // and a number is not one.
            attachmentId: "att-9",
            url: "/api/attachments/att-9",
            // Absent, not `99`. A tile draws "Untitled file" for a name it does not have, which is
            // honest; drawing a number is not.
            modality: "image",
          },
        ],
      },
    ]);
  });

  /*
   * A metadata that is not an object at all takes the same route, rather than the cast's route.
   * The cast said `{ attachmentId?: string } | undefined` about whatever was there, and a string
   * `metadata` has an `attachmentId` of `undefined` only by luck of it not being an array index.
   */
  test("ignores a metadata that is not an object", () => {
    for (const metadata of ["att-nope", 7, [], true]) {
      const odd: Message = {
        id: "user-odd",
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "url", value: "/api/attachments/att-10" },
            metadata,
          },
        ],
      } as unknown as Message;

      expect(toVisibleChatItems([odd])).toEqual([
        {
          kind: "attachments",
          id: "user-odd:attachments",
          attachments: [
            {
              id: "user-odd:0",
              attachmentId: "att-10",
              url: "/api/attachments/att-10",
              modality: "document",
            },
          ],
        },
      ]);
    }
  });

  /*
   * THE URL FALLBACK IS AN ID, NOT THE LAST PATH SEGMENT.
   *
   * `url.split("/").at(-1)` kept everything after the last slash, query string and fragment
   * included, so `/api/attachments/<id>?v=2` produced `"<id>?v=2"` in a field named for an id.
   * Nothing renders it today, which is exactly why it is worth pinning: it is a wrong value
   * sitting quietly in a typed field, waiting for the first reader that builds a url back out of
   * it — and the server's own `attachmentIdFor` slices a browser-supplied url the same way, so
   * this is the shape of mistake this field is downstream of.
   */
  test("the url fallback for an attachment id drops a query string and a fragment", () => {
    const urls = [
      "/api/attachments/att-11?v=2",
      "/api/attachments/att-11#page=3",
      "/api/attachments/att-11?v=2#page=3",
    ];

    for (const url of urls) {
      const part: Message = {
        id: "user-q",
        role: "user",
        content: [{ type: "document", source: { type: "url", value: url } }],
      } as unknown as Message;

      const [item] = toVisibleChatItems([part]);
      expect(item).toMatchObject({ kind: "attachments" });
      /*
       * Narrowed on the discriminant rather than cast to a hand-written shape. The projection
       * returns `readonly SentAttachment[]`, and the old cast both dropped that `readonly` and
       * re-declared a two-field subset of the row — so it would have gone on compiling through a
       * rename of any field it did not happen to mention.
       */
      if (item.kind !== "attachments") {
        throw new Error(`expected an attachments item, got ${item.kind}`);
      }
      expect(item.attachments[0].attachmentId).toBe("att-11");
      // The url itself is untouched — it is what the tile fetches, and the query string may well
      // be load-bearing to whoever put it there.
      expect(item.attachments[0].url).toBe(url);
    }
  });

  /*
   * AN EMPTY TEXT PART IS NOT A BLANK LINE IN SOMEBODY'S MESSAGE.
   *
   * `readText` returns `""` for a text part carrying an empty string — not `null`, which is what
   * the `.filter` drops — so `.join("\n")` put a newline in front of the real caption. A composer
   * that sends a text part alongside a screenshot with nothing typed in it produces exactly this,
   * and Streamdown renders the result with a leading blank line above the person's own words.
   *
   * The empty part contributes nothing at either end or in the middle; two real parts either side
   * of it are still joined to each other.
   */
  test("an empty text part does not become a blank line in the caption", () => {
    const cases: [unknown[], string][] = [
      [
        [
          { type: "text", text: "" },
          { type: "text", text: "hi" },
        ],
        "hi",
      ],
      [
        [
          { type: "text", text: "hi" },
          { type: "text", text: "" },
        ],
        "hi",
      ],
      [
        [
          { type: "text", text: "one" },
          { type: "text", text: "" },
          { type: "text", text: "two" },
        ],
        "one\ntwo",
      ],
    ];

    for (const [content, text] of cases) {
      const said = {
        id: "user-blank",
        role: "user",
        content,
      } as unknown as Message;

      expect(toVisibleChatItems([said])).toEqual([
        { kind: "text", id: "user-blank", role: "user", text },
      ]);
    }
  });

  /*
   * And a turn whose only text part is empty is not a text item at all — the same rule the
   * string-content branch above already follows, where `""` produces no row rather than an empty
   * bubble.
   */
  test("a turn whose only text part is empty draws no caption", () => {
    const said = {
      id: "user-empty",
      role: "user",
      content: [
        { type: "text", text: "" },
        {
          type: "image",
          source: { type: "url", value: "/api/attachments/att-12" },
          metadata: { attachmentId: "att-12", filename: "shot.png" },
        },
      ],
    } as unknown as Message;

    expect(toVisibleChatItems([said])).toEqual([
      {
        kind: "attachments",
        id: "user-empty:attachments",
        attachments: [
          {
            id: "user-empty:1",
            attachmentId: "att-12",
            url: "/api/attachments/att-12",
            filename: "shot.png",
            modality: "image",
          },
        ],
      },
    ]);
  });

  /*
   * THE ID IS THE ONE FIELD EVERYTHING DOWNSTREAM IS KEYED ON, so it is the one an unvalidated
   * live message must not be trusted for.
   *
   * `isReadableToolCall` has checked `toolCall.id` from the day it was written, for a reason its
   * own comment gives — "the row it builds is keyed on the id". `message.id` is keyed on harder:
   * it is the React key, `MessageScrollerItem`'s `messageId`, the grouping key `anchorRowIds` and
   * `turnOf` cut apart, and the memo key for the entrance delay. It went unchecked for the reason
   * `readAttachmentMetadata`'s comment gives for its own fields — it does not THROW, so nothing
   * ever pointed at it.
   *
   * Nothing throws here either. That is the point: a missing id renders, quietly and wrongly.
   */
  test("drops a live message whose id is not a string", () => {
    // `""` sits in this list rather than beside it: it is a string, so it passes a `typeof` check,
    // and it names nothing — the same reason `readAttachmentMetadata` refuses an empty
    // `attachmentId`. Two turns carrying it collide exactly as two carrying a hole do.
    const ids: unknown[] = [undefined, null, 42, {}, ""];

    for (const id of ids) {
      const said = { id, role: "user", content: "hi" } as unknown as Message;
      expect(toVisibleChatItems([said])).toEqual([]);
    }
  });

  /*
   * THE QUIET ONE, AND THE REASON THE GUARD IS ON THE MESSAGE RATHER THAN AT EACH READ. A text
   * item with `id: undefined` is loud — React logs a duplicate-key warning. The attachments item
   * beside it is silent: `` `${message.id}:attachments` `` STRINGIFIES the hole, so two such turns
   * both come out as the literal `"undefined:attachments"` and collide on one render key, one
   * scroller registration and one memoised entrance delay. Two files from two different turns are
   * drawn as one row.
   */
  test("two id-less turns do not collide on one attachments row", () => {
    const attached = (value: string) =>
      ({
        role: "user",
        content: [{ type: "image", source: { type: "url", value } }],
      }) as unknown as Message;

    expect(
      toVisibleChatItems([
        attached("/api/attachments/att-a"),
        attached("/api/attachments/att-b"),
      ]),
    ).toEqual([]);
  });

  /*
   * AN EMPTY STRING IS A MALFORMED SOURCE, WHICH IS WHAT `readUrlSource`'S OWN DOC ALREADY SAID.
   *
   * It promised null for "a source that is missing, or carries no `value`", and `""` carries no
   * value by any reading — but `typeof value === "string"` let it through. What came out the other
   * side was a tile: `attachmentIdFromUrl("")` is `""`, so the row got an `attachmentId` naming
   * nothing, and `SentAttachmentTile` refuses a url that does not start with the attachment prefix,
   * so the reader was shown "This attachment is unavailable." over a message that never had a file
   * the server lost. Every sibling narrowing in this file already refuses `""` — `metadata.filename`,
   * `metadata.attachmentId`, `source.mimeType`, `readText` — and for the same reason.
   */
  test("an attachment part whose source value is empty draws no tile", () => {
    const empty = {
      id: "user-empty-source",
      role: "user",
      content: [{ type: "image", source: { type: "url", value: "" } }],
    } as unknown as Message;

    expect(toVisibleChatItems([empty])).toEqual([]);
  });

  /*
   * THE GATE IS THE SOURCE URL, NOT `part.type`, WHICH IS THE RULE THE SERVER ALREADY APPLIES.
   *
   * `attachmentIdFor` in `server/src/channels/attachment-parts.ts` reads the source and deliberately
   * never reads `part.type`, with the alternative spelled out in its comment: AG-UI's part union is
   * `text | image | audio | video | document | binary`, and a client writing its own content can
   * send any of the six naming one of our urls. The server therefore RESOLVES such a part — inlines
   * the bytes and stamps `attachedAt` so the sweeper spares it — while this projection dropped it,
   * so the file went to the model, survived on the shelf, and was drawn to the person nowhere.
   *
   * Drawn as a document rather than guessed at: `attachmentModality` maps everything that is not
   * `image` to the file card, which is the honest tile for a kind this app has no viewer for.
   */
  test("a part type this app does not send still draws the file it names", () => {
    const exotic = {
      id: "user-audio",
      role: "user",
      content: [
        {
          type: "audio",
          source: { type: "url", value: "/api/attachments/att-audio" },
          metadata: { attachmentId: "att-audio", filename: "note.m4a" },
        },
      ],
    } as unknown as Message;

    expect(toVisibleChatItems([exotic])).toEqual([
      {
        kind: "attachments",
        id: "user-audio:attachments",
        attachments: [
          {
            id: "user-audio:0",
            attachmentId: "att-audio",
            url: "/api/attachments/att-audio",
            filename: "note.m4a",
            modality: "document",
          },
        ],
      },
    ]);
  });

  /*
   * AND A TEXT PART IS STILL NOT A TILE, because a well-formed one carries no `source` at all —
   * including the three the SERVER substitutes for an attachment it could not send
   * (`unavailableNote`, `notIncludedNote`, `unreadableNote` all write `{ type: "text", text }` and
   * nothing else). Widening the gate to the source url therefore costs the caption path nothing,
   * and this pins that rather than leaving it to the argument.
   */
  test("a text part is read as a caption, never as an attachment", () => {
    const noted = {
      id: "user-note",
      role: "user",
      content: [
        { type: "text", text: '[attachment "a.pdf" is no longer available]' },
      ],
    } as unknown as Message;

    expect(toVisibleChatItems([noted])).toEqual([
      {
        kind: "text",
        id: "user-note",
        role: "user",
        text: '[attachment "a.pdf" is no longer available]',
      },
    ]);
  });
});

/*
 * THE MODALITY IS THE SERVER'S ANSWER ABOUT THE BYTES, NOT THE BROWSER'S GUESS ABOUT THE FILE.
 *
 * These are the client half of the defect `server/src/channels/attachment-parts.ts` was fixed for.
 * The chain, verified against the installed SDK rather than assumed:
 *
 *   1. `useAttachments.processFiles` sets `type: getModalityFromMimeType(file.type)` on the
 *      placeholder — `file.type` being what the BROWSER claimed before a byte was uploaded, and
 *      that function maps everything that is not `image/`, `audio/` or `video/` to `"document"`.
 *   2. `onUpload` answers with our `uploadToChannel`, whose `mimeType` is the type the SERVER
 *      earned from `sniffMimeType` over the actual bytes.
 *   3. The merge back onto the staged attachment is
 *      `{ ...att, source, status: "ready", thumbnail, metadata }` — it replaces the SOURCE and
 *      NEVER the `type`.
 *   4. So the stale guess and the fresh answer sit side by side on the staged object: `type` says
 *      one thing, `source.mimeType` says another.
 *
 * `composer/picked-files.ts` makes step 1 wrong ON PURPOSE: `screenPickedFiles` deliberately lets
 * through a claim that names no format (`application/octet-stream`, `""`) so the server can sniff
 * the bytes, which is exactly the case where the guess and the answer disagree. A PNG dragged out
 * of an editor is claimed as text, so `type` is `"document"` while the bytes are `image/png` — and
 * the transcript drew a grey file card over somebody's screenshot.
 *
 * `source.mimeType` is not an invented field. It is declared on `AttachmentSource` in
 * `shared/attachments.ts`, and it is a first-class optional key on AG-UI's own
 * `InputContentUrlSourceSchema`, so it survives the parse a stored message is put through — unlike
 * a sibling key on `metadata`, which that file's comment notes would be silently stripped.
 *
 * WHAT THESE CASES DO AND DO NOT PROVE, STATED UP FRONT SO NOBODY READS THEM AS MORE THAN THEY ARE.
 * They pin the RULE this projection applies to a part, and the rule is now right. They do NOT show
 * that a real sent message is drawn correctly, because no real sent message reaches here carrying a
 * `mimeType` at all: OpenBot does not use the SDK's own send path but `toAttachmentPart` in
 * `channel-chat.tsx`, which rebuilds the source as `{ type: "url", value }` and discards the
 * `mimeType` `onUpload` returned. Every part below that carries one is therefore a shape this app
 * cannot currently produce — deliberately so, because the reader has to be correct BEFORE the one
 * line upstream that would start supplying it, or that line would land on a projection that ignores
 * it. The surface where the answer really is in hand today is the parked row, and it is pinned for
 * real in `transcript-attachments.test.tsx`.
 */
describe("what a sent attachment is drawn as", () => {
  /** The one field under test, pulled out of the row the projection builds. */
  function modalityOf(part: unknown): string | undefined {
    const said = {
      id: "user-modality",
      role: "user",
      content: [part],
    } as unknown as Message;

    const [item] = toVisibleChatItems([said]);
    return (item as { attachments?: { modality: string }[] })?.attachments?.[0]
      ?.modality;
  }

  function part(type: string, mimeType?: string) {
    return {
      type,
      source: {
        type: "url",
        value: "/api/attachments/att-1",
        ...(mimeType === undefined ? {} : { mimeType }),
      },
      metadata: { attachmentId: "att-1", filename: "picture.png" },
    };
  }

  /*
   * THE DEFECT ITSELF. The model is shown the picture — `resolvePart` decides with
   * `classifyAttachment(attachment.mimeType)` off the stored row — and the person who attached it
   * was shown a document tile. The wrong drawing is the whole of it: a grey card with a filename
   * where somebody's screenshot should be.
   *
   * This note used to add that the tile "also cost the server a whole-file read out of Postgres on
   * every render", because `SentAttachmentTile` probes a document with HEAD and a picture not at
   * all. That stopped being true when the attachment route grew a HEAD branch selecting `sizeBytes`
   * rather than `bytes`; the mislabelled tile now buys one cheap round trip. Corrected rather than
   * cut, because the same claim was repeated in three places and read as current twice.
   */
  test("a document part whose bytes the server read as an image is drawn as an image", () => {
    expect(modalityOf(part("document", "image/png"))).toBe("image");
  });

  /*
   * AND THE SAME MISTAKE POINTING THE OTHER WAY, which is the louder failure of the two. A text
   * file claimed as an image draws an `<img>` at a url the route answers 200 for with text; the
   * browser cannot decode it, `onError` fires, and the tile swaps itself for the destructive card
   * reading "notes.txt is unavailable." — an accusation that a file was deleted when it is sitting
   * right there. Reachable the moment a browser claims `image/png` for something that is not one.
   */
  test("an image part whose bytes the server read as text is drawn as a document", () => {
    expect(modalityOf(part("image", "text/plain"))).toBe("document");
  });

  /*
   * A PICTURE THIS BROWSER CANNOT DRAW IS NOT A PICTURE, and `classifyAttachment` is asked rather
   * than `mimeType.startsWith("image/")` precisely so this case answers correctly. A HEIC is an
   * image by media type and an `<img>` renders nothing for it, so the honest tile is the card
   * naming the file. Asking `classifyAttachment` also makes the tile agree with the model by
   * construction: `resolvePart` gates on that same function returning `"image"`, so a picture is
   * drawn to the person exactly when a picture was put in front of the Bot.
   */
  test("an image type this app does not accept is a document, not a broken picture", () => {
    expect(modalityOf(part("image", "image/heic"))).toBe("document");
    expect(modalityOf(part("document", "image/heic"))).toBe("document");
  });

  /*
   * WITHOUT THE SERVER'S ANSWER, THE DECLARED TYPE IS ALL THERE IS, and it is used rather than
   * everything collapsing to a document. `mimeType` is OPTIONAL on both `AttachmentSource` and
   * AG-UI's url-source schema, so a part without one is well-formed: every message sent before
   * `uploadToChannel` began returning it is one, and those threads are still in the database.
   * Falling back keeps them drawing exactly as they do today instead of turning every stored
   * screenshot into a file card.
   */
  test("a part carrying no server type falls back to the type the browser declared", () => {
    expect(modalityOf(part("image"))).toBe("image");
    expect(modalityOf(part("document"))).toBe("document");
  });

  /*
   * The same standard the rest of this file holds `metadata` to, applied to the field beside it: a
   * live turn is whatever the run put in the array, so a `mimeType` that is not a non-empty string
   * is not an answer. `""` is the one that matters — `classifyAttachment("")` returns
   * `"unsupported"`, so trusting it would turn a screenshot into a file card on the strength of a
   * field that says nothing.
   */
  test("a source mimeType that is not a usable string is not trusted", () => {
    for (const bad of ["", 42, null, {}, undefined]) {
      expect(
        modalityOf({
          type: "image",
          source: {
            type: "url",
            value: "/api/attachments/att-1",
            mimeType: bad,
          },
          metadata: { attachmentId: "att-1" },
        }),
      ).toBe("image");
    }
  });
});
