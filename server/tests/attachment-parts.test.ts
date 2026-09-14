import { describe, expect, test } from "bun:test";
import { MAX_EXTRACTED_CHARACTERS } from "../../shared/attachments";
import {
  newInlineBudget,
  resolveAttachmentParts,
  type StoredAttachment,
} from "../src/channels/attachment-parts";

function loadFrom(
  store: Record<string, StoredAttachment>,
): (id: string) => Promise<StoredAttachment | null> {
  return async (id: string) => store[id] ?? null;
}

describe("resolving stored attachment references into model-readable content", () => {
  test("a url-source image part gets inline data, metadata preserved", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const metadata = { attachmentId: "img1", filename: "photo.png" };
    const content = [
      {
        type: "image",
        source: {
          type: "url",
          value: "/api/attachments/img1",
          mimeType: "image/png",
        },
        metadata,
      },
    ];

    const result = (await resolveAttachmentParts(
      content,
      loadFrom({
        img1: { mimeType: "image/png", name: "photo.png", bytes },
      }),
    )) as Array<Record<string, unknown>>;

    expect(result[0].type).toBe("image");
    expect(result[0].metadata).toBe(metadata);
    expect(result[0].source).toEqual({
      type: "data",
      value: bytes.toString("base64"),
      mimeType: "image/png",
    });
  });

  test("a url-source document part becomes a text part naming the file", async () => {
    const bytes = Buffer.from("hello world", "utf8");
    const content = [
      {
        type: "document",
        source: { type: "url", value: "/api/attachments/doc1" },
        metadata: { attachmentId: "doc1", filename: "notes.txt" },
      },
    ];

    const result = (await resolveAttachmentParts(
      content,
      loadFrom({
        doc1: { mimeType: "text/plain", name: "notes.txt", bytes },
      }),
    )) as Array<Record<string, unknown>>;

    expect(result[0]).toEqual({
      type: "text",
      text: 'Attached file "notes.txt":\n\nhello world',
    });
  });

  test("text past MAX_EXTRACTED_CHARACTERS is cut AT that many characters", async () => {
    /*
     * THE WHOLE PART, NOT `toContain("truncated")`.
     *
     * The looser assertions this replaces — that the text mentions truncation and is shorter than
     * the file — hold for a cut at one character just as well as for a cut at 120,000, so the one
     * number the constant exists to set was the one thing not being checked. Written out in full
     * so a change to the caption, the blank line before it, or the cut itself is a red test rather
     * than a silent change to what every model is shown.
     */
    const long = "a".repeat(MAX_EXTRACTED_CHARACTERS + 5000);
    const content = [
      {
        type: "document",
        source: { type: "url", value: "/api/attachments/doc2" },
      },
    ];

    const result = (await resolveAttachmentParts(
      content,
      loadFrom({
        doc2: {
          mimeType: "text/plain",
          name: "big.txt",
          bytes: Buffer.from(long, "utf8"),
        },
      }),
    )) as Array<{ text: string }>;

    expect(result[0].text).toBe(
      [
        'Attached file "big.txt":',
        "",
        "a".repeat(MAX_EXTRACTED_CHARACTERS),
        "",
        `[attachment truncated at ${MAX_EXTRACTED_CHARACTERS} characters]`,
      ].join("\n"),
    );
  });

  test("text exactly MAX_EXTRACTED_CHARACTERS long is not cut at all", async () => {
    // The other side of the same boundary: an off-by-one in `extractDocumentText` shows up here as
    // a truncation marker on a file that fitted, and above as a cut in the wrong place.
    const exact = "b".repeat(MAX_EXTRACTED_CHARACTERS);
    const content = [
      {
        type: "document",
        source: { type: "url", value: "/api/attachments/doc3" },
      },
    ];

    const result = (await resolveAttachmentParts(
      content,
      loadFrom({
        doc3: {
          mimeType: "text/plain",
          name: "exact.txt",
          bytes: Buffer.from(exact, "utf8"),
        },
      }),
    )) as Array<{ text: string }>;

    expect(result[0].text).toBe(`Attached file "exact.txt":\n\n${exact}`);
  });

  test("a cut that would land inside a character stops one code unit short", async () => {
    /*
     * `slice` counts UTF-16 code units, so a limit landing between the halves of a surrogate pair
     * left a lone high surrogate as the last code unit of the extracted text. That is not a
     * character: `JSON.stringify` emits it as a bare `\ud83d` escape, which a provider either
     * rejects or silently replaces with U+FFFD — so a file whose 120,000th code unit happens to
     * fall inside an emoji damaged a turn for a reason with nothing to do with its contents.
     * `withinFilenameLimit` in `channels/attachments.ts` guards the same hazard on the same kind of
     * cut, and said so in a comment, while this one — applied to far more bytes, far more often —
     * did not.
     *
     * Built so the pair straddles the limit exactly: MAX-1 filler characters, then one emoji whose
     * high half sits at MAX-1 and whose low half sits at MAX, then enough after it to truncate.
     */
    const emoji = "😀";
    expect(emoji.length).toBe(2);
    const long = `${"a".repeat(MAX_EXTRACTED_CHARACTERS - 1)}${emoji}tail`;
    const content = [
      {
        type: "document",
        source: { type: "url", value: "/api/attachments/pair1" },
      },
    ];

    const result = (await resolveAttachmentParts(
      content,
      loadFrom({
        pair1: {
          mimeType: "text/plain",
          name: "emoji.txt",
          bytes: Buffer.from(long, "utf8"),
        },
      }),
    )) as Array<{ text: string }>;

    // The whole part, for the reason the test above spells out: a looser assertion would hold for
    // a cut in the wrong place just as well.
    expect(result[0].text).toBe(
      [
        'Attached file "emoji.txt":',
        "",
        "a".repeat(MAX_EXTRACTED_CHARACTERS - 1),
        "",
        `[attachment truncated at ${MAX_EXTRACTED_CHARACTERS - 1} characters]`,
      ].join("\n"),
    );
    // Said directly as well, because it is the property and the line above is one instance of it:
    // no lone surrogate survives the cut.
    const body = result[0].text.split("\n\n")[1] ?? "";
    const lastUnit = body.charCodeAt(body.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
  });

  test("a cut that lands cleanly still cuts at exactly the limit", async () => {
    // The guard must not cost a character on the ordinary file. An emoji ending one unit BEFORE the
    // limit is whole inside the cut, so nothing is dropped and the count is the constant.
    const long = `${"a".repeat(MAX_EXTRACTED_CHARACTERS - 2)}😀tail`;
    const content = [
      {
        type: "document",
        source: { type: "url", value: "/api/attachments/pair2" },
      },
    ];

    const result = (await resolveAttachmentParts(
      content,
      loadFrom({
        pair2: {
          mimeType: "text/plain",
          name: "emoji2.txt",
          bytes: Buffer.from(long, "utf8"),
        },
      }),
    )) as Array<{ text: string }>;

    expect(result[0].text).toBe(
      [
        'Attached file "emoji2.txt":',
        "",
        `${"a".repeat(MAX_EXTRACTED_CHARACTERS - 2)}😀`,
        "",
        `[attachment truncated at ${MAX_EXTRACTED_CHARACTERS} characters]`,
      ].join("\n"),
    );
  });

  test("a missing attachment throws, naming the attachment id", async () => {
    const content = [
      {
        type: "image",
        source: { type: "url", value: "/api/attachments/missing1" },
      },
    ];

    await expect(resolveAttachmentParts(content, loadFrom({}))).rejects.toThrow(
      /missing1/,
    );
  });

  test("the refusal names the file the person chose, not only the id they never saw", async () => {
    /*
     * The uuid is minted by the upload route; what the person picked out of a file dialog is
     * `quarterly.png`, and it is the only one of the two they can match against what they did. The
     * id stays behind it for whoever is reading a log next to a table.
     *
     * AND IT DOES NOT COLLAPSE FOUR SITUATIONS INTO ONE CLAIM. `load` answers null for a row the
     * sweeper reclaimed, for a file of somebody this asker cannot see, for one in another channel,
     * and for an id naming no row at all — different situations with different things to do about
     * them, flattened by the `(id) => Promise<StoredAttachment | null>` seam. Naming one would be a
     * guess printed as a fact, so the sentence offers the possibilities instead of picking.
     */
    const content = [
      {
        type: "image",
        source: { type: "url", value: "/api/attachments/missing2" },
        metadata: { attachmentId: "missing2", filename: "quarterly.png" },
      },
    ];

    const failure = resolveAttachmentParts(content, loadFrom({}));

    await expect(failure).rejects.toThrow(/"quarterly\.png" \(id "missing2"\)/);
    await expect(failure).rejects.toThrow(/deleted/);
    await expect(failure).rejects.toThrow(/another channel/);
  });

  test("a part with no filename is named once, not twice over", async () => {
    // `displayName` falls back to the id, and every part not written by our own composer arrives
    // without a filename — so the id would otherwise be printed beside itself.
    const content = [
      {
        type: "image",
        source: { type: "url", value: "/api/attachments/missing3" },
      },
    ];

    await expect(resolveAttachmentParts(content, loadFrom({}))).rejects.toThrow(
      'Attachment "missing3" could not be loaded',
    );
  });

  test("a missing attachment in history becomes a text part naming the file", async () => {
    /*
     * "note" is what an older message gets, because history is replayed on
     * every turn and a throw there would fail this channel for ever — the
     * failure `agents/history-sanitize.ts` records finding in production
     * twice. The part still SAYS the file is gone, so nothing answers as
     * though it were there.
     */
    const content = [
      {
        type: "image",
        source: { type: "url", value: "/api/attachments/gone1" },
        metadata: { attachmentId: "gone1", filename: "budget.png" },
      },
    ];

    const result = (await resolveAttachmentParts(
      content,
      loadFrom({}),
      "note",
    )) as Array<Record<string, unknown>>;

    expect(result[0]).toEqual({
      type: "text",
      text: '[attachment "budget.png" is no longer available]',
    });
  });

  test("a missing attachment with no filename is named by its id", async () => {
    const content = [
      {
        type: "document",
        source: { type: "url", value: "/api/attachments/gone2" },
      },
    ];

    const result = (await resolveAttachmentParts(
      content,
      loadFrom({}),
      "note",
    )) as Array<Record<string, unknown>>;

    expect(result[0]).toEqual({
      type: "text",
      text: '[attachment "gone2" is no longer available]',
    });
  });

  test('an attachment that still loads is inlined under "note" too', async () => {
    // "note" changes what a MISSING row does and nothing else: a row that is
    // still there resolves exactly as it does for the asked-about message.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const content = [
      {
        type: "image",
        source: { type: "url", value: "/api/attachments/img3" },
        metadata: { attachmentId: "img3", filename: "kept.png" },
      },
    ];

    const result = (await resolveAttachmentParts(
      content,
      loadFrom({ img3: { mimeType: "image/png", name: "kept.png", bytes } }),
      "note",
    )) as Array<Record<string, unknown>>;

    expect(result[0].source).toEqual({
      type: "data",
      value: bytes.toString("base64"),
      mimeType: "image/png",
    });
  });

  test("a part that already carries a data source is left alone", async () => {
    const content = [
      {
        type: "image",
        source: { type: "data", value: "AAAA", mimeType: "image/png" },
        metadata: { attachmentId: "img2", filename: "already.png" },
      },
    ];

    const result = await resolveAttachmentParts(content, loadFrom({}));

    expect(result).toBe(content);
  });

  test("string content is returned by identity", async () => {
    const content = "just some plain message text";

    const result = await resolveAttachmentParts(content, loadFrom({}));

    expect(result).toBe(content);
  });
});

/**
 * WHICH SIDE DECIDES WHAT A FILE IS.
 *
 * A part's `type` is the browser's claim, fixed from `file.type` before the upload and never
 * reconciled with what the upload answered. `mimeType` is `sniffMimeType`'s reading of the actual
 * bytes. They disagree in production for an ordinary reason: `sniffMimeType` runs the image
 * signatures FIRST, so a PNG whose browser claim was `text/plain` is stored as `image/png` while
 * the part that named it still says `document`.
 *
 * Every test here fails if `resolvePart` goes back to reading `part.type`.
 */
describe("what a stored attachment becomes is decided by its bytes, not by the part", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function partOf(type: string, id: string, filename?: string) {
    return [
      {
        type,
        source: { type: "url", value: `/api/attachments/${id}` },
        metadata: { attachmentId: id, ...(filename ? { filename } : {}) },
      },
    ];
  }

  test('a "document" part naming a stored image is sent as an image, not as mojibake', async () => {
    /*
     * The defect in full: `photo.png` renamed and dragged out of an editor arrives claiming
     * `text/plain`, the SDK fixes the modality to `document` from that claim, the server sniffs the
     * bytes and stores `image/png` — and the old branch ran a PNG through `toString("utf8")` and
     * captioned the result `Attached file "photo.png":`. The model was handed a page of noise and
     * nothing anywhere said the picture had not been sent.
     */
    const result = (await resolveAttachmentParts(
      partOf("document", "shot1", "photo.png"),
      loadFrom({
        shot1: { mimeType: "image/png", name: "photo.png", bytes: png },
      }),
    )) as Array<Record<string, unknown>>;

    // `type` is REWRITTEN, not merely left alone: a provider shown a `document` part does not look
    // at the picture, so inlining the bytes under the claimed type would fix nothing.
    expect(result[0].type).toBe("image");
    expect(result[0].source).toEqual({
      type: "data",
      value: png.toString("base64"),
      mimeType: "image/png",
    });
  });

  test('an "image" part naming a stored text file is extracted, not base64-ed', async () => {
    const result = (await resolveAttachmentParts(
      partOf("image", "note1", "notes.txt"),
      loadFrom({
        note1: {
          mimeType: "text/markdown",
          name: "notes.txt",
          bytes: Buffer.from("# hello", "utf8"),
        },
      }),
    )) as Array<Record<string, unknown>>;

    expect(result[0]).toEqual({
      type: "text",
      text: 'Attached file "notes.txt":\n\n# hello',
    });
  });

  test("a part type AG-UI has and this app never sends still respects MAX_EXTRACTED_CHARACTERS", async () => {
    /*
     * AG-UI's union is `text | image | audio | video | document | binary`, and message content is
     * written by the browser, so all six are constructible by anyone who composes their own request
     * — our composer only ever emitting `image`/`document` is not a gate.
     *
     * Under the old `part.type === "document"` test, `binary` took the else branch: a text file at
     * the `MAX_FILE_BYTES` ceiling went to the model as ~1.4 MB of base64 with the extraction cap
     * bypassed entirely. The cut is what this asserts, because the cut is what was bypassed.
     */
    const long = "c".repeat(MAX_EXTRACTED_CHARACTERS + 1);

    const result = (await resolveAttachmentParts(
      partOf("binary", "sneak1", "notes.txt"),
      loadFrom({
        sneak1: {
          mimeType: "text/plain",
          name: "notes.txt",
          bytes: Buffer.from(long, "utf8"),
        },
      }),
    )) as Array<{ type: string; text: string }>;

    expect(result[0].type).toBe("text");
    expect(result[0].text).toBe(
      [
        'Attached file "notes.txt":',
        "",
        "c".repeat(MAX_EXTRACTED_CHARACTERS),
        "",
        `[attachment truncated at ${MAX_EXTRACTED_CHARACTERS} characters]`,
      ].join("\n"),
    );
  });

  test("a stored type this app cannot read becomes a note naming the type", async () => {
    // Not reachable through today's upload route, which runs `classifyAttachment` first. It becomes
    // reachable the day a type leaves the accepted lists with rows of it still in the table, and
    // the answer must not be mojibake — the model has to be told it cannot see the file.
    const result = (await resolveAttachmentParts(
      partOf("document", "pdf1", "invoice.pdf"),
      loadFrom({
        pdf1: {
          mimeType: "application/pdf",
          name: "invoice.pdf",
          bytes: Buffer.from("%PDF-1.7", "utf8"),
        },
      }),
    )) as Array<Record<string, unknown>>;

    expect(result[0]).toEqual({
      type: "text",
      text: '[attachment "invoice.pdf" is a application/pdf file, which cannot be put in front of the model]',
    });
  });

  test("one id named twice in a message is read once and encoded twice", async () => {
    // Two parts must not be handed the same object, but they must not cost two reads either. What
    // they DO cost twice is the budget, which the next test asserts: two encoded copies, two
    // charges, one read.
    const reads: string[] = [];
    const content = [
      ...partOf("image", "twice1"),
      ...partOf("image", "twice1"),
    ];

    const result = (await resolveAttachmentParts(content, async (id) => {
      reads.push(id);
      return { mimeType: "image/png", name: "photo.png", bytes: png };
    })) as Array<Record<string, unknown>>;

    expect(reads).toEqual(["twice1"]);
    expect(result[0]).not.toBe(result[1]);
    expect(result[0]).toEqual(result[1]);
  });

  /*
   * THE OTHER HALF OF THAT SENTENCE, WHICH THE TEST ABOVE DOES NOT REACH: ONE READ, TWO CHARGES.
   *
   * This test used to assert the opposite — "charged to the budget once", budget 20 minus one
   * 8-byte file leaving 12 — and it was wrong in the direction that matters. Deduplicating the
   * READ is a saving and stays; deduplicating the CHARGE made every copy after the first free,
   * which took the ceiling off the one thing the budget bounds. Two parts naming one file really
   * are two base64 strings live at once, so they are two charges.
   *
   * The two properties are asserted together here precisely because they were once collapsed into
   * one claim ("one read per distinct id, and one charge") that read as coherent and was not.
   */
  test("one id named twice is read once and charged twice", async () => {
    const content = [
      ...partOf("image", "charged1"),
      ...partOf("image", "charged1"),
    ];
    const eightBytes = Buffer.from("12345678", "utf8");
    const budget = newInlineBudget(20);
    const reads: string[] = [];

    const result = (await resolveAttachmentParts(
      content,
      async (id) => {
        reads.push(id);
        return {
          mimeType: "image/png",
          name: "photo.png",
          bytes: eightBytes,
        };
      },
      "note",
      budget,
    )) as Array<Record<string, unknown>>;

    // One trip to `bytea`: the memo is untouched by the fix.
    expect(reads).toEqual(["charged1"]);
    // Two copies emitted, so 16 of the 20 bytes are spent, not 8.
    expect(budget.remaining).toBe(4);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(result[1]);
  });

  /*
   * The consequence, stated separately because it is the one a reader coming from the old behaviour
   * would doubt: once the room is gone, a part naming an id that ALREADY FIT is cut like any other.
   *
   * The rejected argument was that its bytes are in the run already, so the second mention is free
   * and cutting it puts one file in front of the model twice over — once as itself, once as a note.
   * It is not free. The second mention is a second encoded copy, and exempting it is exactly what
   * let a repeated id inline without limit. A note saying one of two mentions was left out is a
   * true statement about a turn that ran out of room, and the file is still there on the first.
   */
  test("a repeated id is cut like any other once the budget is gone", async () => {
    const content = [
      ...partOf("image", "paid"),
      ...partOf("image", "big"),
      ...partOf("image", "paid"),
    ];
    const budget = newInlineBudget(12);

    const result = (await resolveAttachmentParts(
      content,
      async (id) => ({
        mimeType: "image/png",
        name: `${id}.png`,
        bytes: Buffer.from(id === "big" ? "1234567890123456" : "12345678"),
      }),
      "note",
      budget,
    )) as Array<Record<string, unknown>>;

    expect(budget.remaining).toBe(0);
    // The first mention fit and was inlined.
    expect(result[0]).toMatchObject({ source: { type: "data" } });
    // The oversized one is cut...
    expect(JSON.stringify(result[1])).toContain("not included");
    // ...and so is the third, which names a paid id but would cost a second copy of it.
    expect(JSON.stringify(result[2])).toContain("not included");
  });
});

/**
 * HOW MUCH ONE TURN MAY SPEND ON FILES.
 *
 * `MAX_IMAGE_BYTES` bounds a file. Nothing bounded a run: history is replayed on every turn, so a
 * channel that had seen a few large images re-read and re-base64-ed all of them on every later
 * turn, and the way that fails is the pod's heap rather than any refusal a person can read.
 *
 * The budget is spent NEWEST-FIRST by `inlineAttachments`, so what runs out is the room for
 * history. The asked message is the one under `onMissing: "fail"`, and it is never cut — it is
 * served whole, or, past the limit, it refuses the turn. Both halves of that sentence are asserted
 * below, because for a while only the first was true and the second was not bounded at all.
 */
describe("a run's inlining budget", () => {
  const eightBytes = Buffer.from("12345678", "utf8");

  function imagePart(id: string, filename: string) {
    return {
      type: "image",
      source: { type: "url", value: `/api/attachments/${id}` },
      metadata: { attachmentId: id, filename },
    };
  }

  function pngStore(id: string) {
    return {
      [id]: { mimeType: "image/png", name: `${id}.png`, bytes: eightBytes },
    };
  }

  test("a history part that does not fit becomes a note that does not claim the file is gone", async () => {
    const budget = newInlineBudget(4);

    const result = (await resolveAttachmentParts(
      [imagePart("big1", "chart.png")],
      loadFrom(pngStore("big1")),
      "note",
      budget,
    )) as Array<Record<string, unknown>>;

    /*
     * NOT the `is no longer available` wording. The row is still there and a question about it
     * makes it the asked message, which the budget is spent on first; telling somebody their file
     * was deleted when it was not is a wrong answer that gets acted on.
     */
    expect(result[0]).toEqual({
      type: "text",
      text: '[attachment "chart.png" from an earlier message was not included in this turn]',
    });
    expect(budget.remaining).toBe(0);
  });

  test("a spent budget stops the database read, not just the encoding", async () => {
    // The read out of `bytea` is most of what the budget exists to bound, so a part that cannot fit
    // must not be fetched to discover that. Once the budget is at zero, later parts cost one
    // comparison each.
    const reads: string[] = [];
    const budget = newInlineBudget(0);

    await resolveAttachmentParts(
      [imagePart("skip1", "chart.png")],
      async (id) => {
        reads.push(id);
        return { mimeType: "image/png", name: "chart.png", bytes: eightBytes };
      },
      "note",
      budget,
    );

    expect(reads).toEqual([]);
  });

  test("the message being asked about spends the budget and is never cut by it", async () => {
    /*
     * The property that makes the budget defensible at all. `inlineAttachments` walks backwards, so
     * the asked message is charged first; if it were also cuttable, a person attaching one large
     * file would be told their own question's attachment was left out of their own turn.
     *
     * "fail" is what marks that message — the same flag that says an unloadable row there must not
     * degrade — so this asserts the two travel together.
     *
     * Sized to FIT, unlike the version of this test that stood here while the asked message had no
     * ceiling at all. That one passed a budget of 4 against an 8-byte file and asserted it was
     * inlined anyway, which read as "never cut" but was really "never bounded" — the assertion that
     * made the hole below look deliberate. What "never cut" means is asserted here; what happens
     * past the limit is the next test, and it is not this.
     */
    const budget = newInlineBudget(20);

    const result = (await resolveAttachmentParts(
      [imagePart("asked1", "chart.png")],
      loadFrom(pngStore("asked1")),
      "fail",
      budget,
    )) as Array<Record<string, unknown>>;

    expect(result[0].source).toMatchObject({ type: "data" });
    // Charged, not exempted: it is what leaves less for the history behind it.
    expect(budget.remaining).toBe(12);
  });

  /*
   * THE HOLE THE BUDGET LEFT OPEN, AND THE SHAPE OF THE ANSWER.
   *
   * Both places that stopped spending tested `onMissing === "note"`, and the message being asked
   * about is resolved under `"fail"`, so neither ever fired for it: nothing capped how many
   * attachment parts a browser-written message could carry. Two hundred previously-sent 8 MiB files
   * named in one message inlined about 1.6 GiB plus its base64, in one turn — the exact heap
   * exhaustion `MAX_INLINED_BYTES_PER_RUN` was written to stop, through the one door it left open.
   *
   * The answer is NOT to make that message cuttable, which is why these tests assert a rejection
   * rather than a note. Cutting it would drop files out of the message somebody is asking a question
   * about, silently, which is the failure the strict mode exists to prevent. "Served in full or the
   * turn fails loudly" survives; "in full" acquires a ceiling.
   */
  test("the message being asked about refuses the turn rather than being cut down to fit", async () => {
    const budget = newInlineBudget(4);

    const failure = resolveAttachmentParts(
      [imagePart("asked2", "chart.png")],
      loadFrom(pngStore("asked2")),
      "fail",
      budget,
    );

    // The file, so the person knows which one; the limit, so "too big" is a number; and a way out,
    // because this is their own most recent action and the message is still in front of them.
    await expect(failure).rejects.toThrow(/"chart\.png" \(id "asked2"\)/);
    await expect(failure).rejects.toThrow(/more than the 4 bytes/);
    await expect(failure).rejects.toThrow(/Send fewer files/);
  });

  test("a refused message is refused, not quietly turned into a note", async () => {
    /*
     * Stated separately because it is the regression that would be easy to introduce while fixing
     * the one above: reusing `notIncludedNote` for the asked message would bound the bytes just as
     * well and would be exactly the silent truncation `onMissing: "fail"` exists to rule out. The
     * turn must end, not continue with a file missing from the question it is answering.
     */
    const budget = newInlineBudget(4);
    let resolved: unknown = "never assigned";

    try {
      resolved = await resolveAttachmentParts(
        [imagePart("asked3", "chart.png")],
        loadFrom(pngStore("asked3")),
        "fail",
        budget,
      );
    } catch {
      resolved = "threw";
    }

    expect(resolved).toBe("threw");
  });

  test("the part past the limit refuses the turn without reading it first", async () => {
    /*
     * The refusal inherits "cut before the load", because a turn that is going to be refused should
     * not pay for the bytes it cannot afford on the way to saying so. Two 8-byte files against a
     * budget of 8: the first fits exactly and is read, and the second finds nothing left and must
     * never reach the database.
     */
    const reads: string[] = [];
    const budget = newInlineBudget(8);

    const failure = resolveAttachmentParts(
      [imagePart("first", "one.png"), imagePart("second", "two.png")],
      async (id) => {
        reads.push(id);
        return { mimeType: "image/png", name: `${id}.png`, bytes: eightBytes };
      },
      "fail",
      budget,
    );

    await expect(failure).rejects.toThrow(/"two\.png"/);
    expect(reads).toEqual(["first"]);
  });

  test("a message that fills the budget exactly is served, not refused", async () => {
    // The other side of that boundary. An off-by-one turning `>` into `>=` would refuse a message
    // that fits, which is a person told their own question is too big when it is not.
    const budget = newInlineBudget(8);

    const result = (await resolveAttachmentParts(
      [imagePart("exact1", "chart.png")],
      loadFrom(pngStore("exact1")),
      "fail",
      budget,
    )) as Array<Record<string, unknown>>;

    expect(result[0].source).toMatchObject({ type: "data" });
    expect(budget.remaining).toBe(0);
  });

  test("an unbudgeted caller is still unbounded, refusal or not", async () => {
    /*
     * The refusal is a property of the BUDGET, not of `onMissing: "fail"`. A single-message caller
     * that passes no budget — the documented "absent means unbounded" case, and what every caller
     * did before the budget existed — must not start failing because its message is large.
     */
    const result = (await resolveAttachmentParts(
      [imagePart("free2", "chart.png"), imagePart("free3", "other.png")],
      async (id) => ({
        mimeType: "image/png",
        name: `${id}.png`,
        bytes: Buffer.alloc(64 * 1024 * 1024),
      }),
      "fail",
    )) as Array<Record<string, unknown>>;

    expect(result[0].source).toMatchObject({ type: "data" });
    expect(result[1].source).toMatchObject({ type: "data" });
  });

  /*
   * WHAT THE READ MEMO IS SCOPED TO, ASSERTED RATHER THAN ASSUMED.
   *
   * `resolveAttachmentParts` builds `loadOnce` per call, and it is called once per message, so an
   * id quoted in two messages of one thread is read twice. The comment on it once said "this run",
   * which was simply false, and the fix was to the comment: per message is the intended scope. A
   * run-scoped memo would pin every attachment's buffer live for the whole backward walk — worse
   * for the heap this budget exists to protect than the second read is for the clock.
   *
   * The CHARGE has no scope question left to answer. It runs once per part emitted, here and
   * everywhere, so two messages quoting one id pay for it twice for the same reason two parts of
   * one message do: two encoded copies reach the run.
   */
  test("an id quoted in two messages is read once per message and charged once per part", async () => {
    const budget = newInlineBudget(20);
    const reads: string[] = [];
    const load = async (id: string) => {
      reads.push(id);
      return { mimeType: "image/png", name: `${id}.png`, bytes: eightBytes };
    };

    // Two calls, because two messages are two calls: this is the seam the scope question is about.
    await resolveAttachmentParts(
      [imagePart("quoted", "chart.png")],
      load,
      "note",
      budget,
    );
    await resolveAttachmentParts(
      [imagePart("quoted", "chart.png")],
      load,
      "note",
      budget,
    );

    expect(reads).toEqual(["quoted", "quoted"]);
    expect(budget.remaining).toBe(4);
  });

  test("a history part that fits draws the budget down by the stored bytes", async () => {
    const budget = newInlineBudget(20);

    const result = (await resolveAttachmentParts(
      [imagePart("fits1", "chart.png")],
      loadFrom(pngStore("fits1")),
      "note",
      budget,
    )) as Array<Record<string, unknown>>;

    expect(result[0].source).toMatchObject({ type: "data" });
    expect(budget.remaining).toBe(12);
  });

  test("no budget means no ceiling, which is what a single-message caller wants", async () => {
    const result = (await resolveAttachmentParts(
      [imagePart("free1", "chart.png")],
      loadFrom(pngStore("free1")),
      "note",
    )) as Array<Record<string, unknown>>;

    expect(result[0].source).toMatchObject({ type: "data" });
  });

  /*
   * THE BUDGET BOUNDS WHAT COMES OUT, NOT HOW MANY DISTINCT FILES WENT IN.
   *
   * This is the regression that made the whole number decorative. The charge was deduplicated per
   * id, on the reasoning that one id is read once so it should be billed once — but this function
   * emits a base64 part for EVERY OCCURRENCE of an id, and every one of those strings is live at the
   * same time. Forty parts naming one 1 KiB file against a 1 KiB budget inlined 40 KiB and reported
   * the budget spent exactly to zero. At the 8 MiB upload ceiling a hundred references came to about
   * 1.04 GiB of base64 against a 32 MiB budget: the heap exhaustion the budget exists to prevent,
   * with the counter insisting nothing was wrong.
   *
   * SO THIS ASSERTS ON DECODED OUTPUT BYTES AND NOT ON `budget.remaining`. The counter is precisely
   * what lied: it read zero while forty copies went out. What a run can afford to hold is a fact
   * about the parts it returns, so that is the thing measured — sum the bytes behind every `data`
   * source that actually left this function.
   *
   * The read memo is asserted in the same breath, because the fix must not buy the bound back by
   * giving up `loadOnce`: one id, one trip to `bytea`, many charges.
   */
  test("one id repeated past the budget inlines no more bytes than the budget", async () => {
    const kilobyte = Buffer.alloc(1024, 0x41);
    const budget = newInlineBudget(1024);
    const reads: string[] = [];
    const content = Array.from({ length: 40 }, () =>
      imagePart("repeated", "chart.png"),
    );

    const result = (await resolveAttachmentParts(
      content,
      async (id) => {
        reads.push(id);
        return { mimeType: "image/png", name: "chart.png", bytes: kilobyte };
      },
      "note",
      budget,
    )) as Array<Record<string, unknown>>;

    const inlinedBytes = result.reduce((total, part) => {
      const source = part.source as
        | { type?: unknown; value?: unknown }
        | undefined;
      if (source?.type !== "data" || typeof source.value !== "string") {
        return total;
      }
      return total + Buffer.from(source.value, "base64").length;
    }, 0);

    // One read, because `loadOnce` still memoises: the fix is to the charge, not to the fetch.
    expect(reads).toEqual(["repeated"]);
    // The bound, measured where it matters: one copy's worth of bytes left this function.
    expect(inlinedBytes).toBe(1024);
    // Every part is still accounted for — the ones past the bound say so rather than vanishing.
    expect(result).toHaveLength(40);
    expect(JSON.stringify(result[1])).toContain("not included");
  });
});
