import {
  attachmentUrl,
  classifyAttachment,
  MAX_EXTRACTED_CHARACTERS,
} from "../../../shared/attachments";

/**
 * What `load` hands back for an attachment id: the bytes and the metadata
 * needed to put them in front of the model, nothing about how they were
 * stored.
 */
export type StoredAttachment = {
  mimeType: string;
  name: string;
  bytes: Buffer;
};

/**
 * `attachmentUrl("")` rather than a hand-typed literal, so this file cannot
 * drift from the one place (`shared/attachments.ts`) that defines the URL
 * shape a stored message actually carries.
 */
const ATTACHMENT_URL_PREFIX = attachmentUrl("");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The attachment id a part points at, or null if this part is not one of
 * ours — already-inline content (`source.type === "data"`), a plain text
 * part with no `source` at all, or a URL that does not name an attachment.
 * Any of those pass through untouched.
 *
 * THE SOURCE URL IS THE ONLY GATE, AND `part.type` IS DELIBERATELY NOT READ.
 * AG-UI's part union is `text | image | audio | video | document | binary`,
 * so a client that writes its own message content can send any of the six
 * naming one of our URLs; the `AttachmentPart` type in `shared/attachments.ts`
 * only says what OUR composer emits. Gating on `image`/`document` here was the
 * alternative and is worse: an `audio` part naming a real attachment would
 * then keep its `/api/attachments/<id>` source, which no model provider goes
 * and fetches, so the file would be silently absent from a turn that claims to
 * carry it — and never stamped `attachedAt`, so the sweeper would reclaim it a
 * day later. Resolving every part that names one of our ids and deciding the
 * modality from the STORED MIME TYPE instead (see `resolvePart`) leaves the
 * declared type with nothing to lie about.
 */
function attachmentIdFor(part: unknown): string | null {
  if (!isRecord(part) || !isRecord(part.source)) return null;
  const source = part.source;
  if (source.type !== "url" || typeof source.value !== "string") return null;
  if (!source.value.startsWith(ATTACHMENT_URL_PREFIX)) return null;
  return source.value.slice(ATTACHMENT_URL_PREFIX.length);
}

/**
 * Every attachment id a message's content names, in the order the parts carry them and each one
 * only once.
 *
 * Exported so the caller that knows WHICH message it is holding — `inlineAttachments` in
 * `copilot.ts`, the one place that can tell the message being asked about from the history behind
 * it — can say those ids went out in a send. Resolving a part cannot make that statement itself:
 * every message in the thread is resolved on every turn, and only one of them is the send.
 *
 * Content that is not an array of parts, or an array naming no attachment, is an empty list rather
 * than an error: that is almost every message in almost every thread.
 */
export function attachmentIdsIn(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids = new Set<string>();
  for (const part of content) {
    const id = attachmentIdFor(part);
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

/**
 * Cuts extracted text at `MAX_EXTRACTED_CHARACTERS` and says so, rather
 * than either sending the whole file (which can blow the context window on
 * its own, see `shared/attachments.ts`) or dropping the overflow silently,
 * which would leave the model answering questions about a file it read
 * only part of with no sign that happened.
 *
 * AND NEVER THROUGH THE MIDDLE OF A CHARACTER. `slice` counts UTF-16 code
 * units, so a limit landing between the two halves of a surrogate pair — and
 * every emoji, every astral-plane glyph, every CJK extension character is one
 * pair — left a lone high surrogate as the last code unit of the text. That is
 * not a character: it means nothing on its own, `JSON.stringify` emits it as a
 * bare `\ud83d` escape, and a provider handed one either rejects the request
 * outright or silently substitutes U+FFFD. Either way a file whose
 * hundred-and-twenty-thousandth code unit happens to land inside a glyph
 * damages a turn for a reason having nothing to do with what the file says.
 * `withinFilenameLimit` in `channels/attachments.ts` guards exactly this hazard
 * on exactly this kind of cut, and says so in a comment; the cut here — applied
 * to far more bytes, far more often — did not.
 *
 * DROPPING THE ORPHAN RATHER THAN REACHING FOR ITS PAIR, because the pair's
 * other half sits AT `MAX_EXTRACTED_CHARACTERS`, past the limit, and a
 * truncation that goes one code unit over the stated bound to stay whole is a
 * stranger rule than one that stops one short of it. The orphan also cannot be
 * a lone surrogate that was already in the file: `toString("utf8")` turns every
 * malformed sequence into U+FFFD, so the only thing that can leave a high
 * surrogate last here is a pair this slice just split.
 *
 * The note names how many characters were actually KEPT rather than naming the
 * constant. The two differ by one, exactly when this guard fires, and a note
 * that named the constant either way would be describing a cut that did not
 * happen — which is the class of failure this whole function exists to avoid.
 */
function extractDocumentText(bytes: Buffer): string {
  const full = bytes.toString("utf8");
  if (full.length <= MAX_EXTRACTED_CHARACTERS) return full;
  const sliced = full.slice(0, MAX_EXTRACTED_CHARACTERS);
  const last = sliced.charCodeAt(sliced.length - 1);
  const splitAPair = last >= 0xd800 && last <= 0xdbff;
  const cut = splitAPair ? sliced.slice(0, -1) : sliced;
  return `${cut}\n\n[attachment truncated at ${cut.length} characters]`;
}

/**
 * What a turn does about an attachment this deployment can no longer load.
 *
 * "fail" for the message being asked about, "note" for everything behind
 * it. See {@link resolveAttachmentParts} for why those are different
 * answers to the same missing row.
 */
export type MissingAttachment = "fail" | "note";

/**
 * The name to call an attachment in a note the model reads.
 *
 * `metadata.filename` when the part carries one, because that is the name the
 * person saw when they attached it and the name they will use if they ask
 * about it again. The id is the fallback: less use to a reader, but it is
 * what the stored part always has.
 */
function displayName(part: Record<string, unknown>, id: string): string {
  const metadata = isRecord(part.metadata) ? part.metadata : undefined;
  return typeof metadata?.filename === "string" && metadata.filename.length > 0
    ? metadata.filename
    : id;
}

/**
 * How a failure names an attachment: the name the person gave it, and the id behind it.
 *
 * The two errors in this file used to name the raw uuid alone, which is the one identifier the
 * person who attached the file has never seen — they picked `photo.png` out of a file dialog and
 * the uuid was minted by the upload route afterwards. So the display name leads. The id stays,
 * because it is what an operator correlating a failure against a row or a log line needs, and it is
 * the only one of the two guaranteed to be unique.
 *
 * THE PARENTHETICAL IS DROPPED WHEN IT WOULD REPEAT ITSELF. `displayName` falls back to the id for
 * a part carrying no `metadata.filename`, and those parts are common — anything not written by our
 * own composer. `Attachment "abc" (id "abc")` reads like a bug in the sentence rather than a fact
 * about the file.
 */
function namedForFailure(part: Record<string, unknown>, id: string): string {
  const name = displayName(part, id);
  return name === id ? `"${id}"` : `"${name}" (id "${id}")`;
}

/** The text part that stands in for a vanished attachment. */
function unavailableNote(part: Record<string, unknown>, id: string): unknown {
  return {
    type: "text",
    text: `[attachment "${displayName(part, id)}" is no longer available]`,
  };
}

/**
 * The text part that stands in for an attachment this run had no room left for.
 *
 * A DIFFERENT SENTENCE FROM {@link unavailableNote}, ON PURPOSE. "No longer
 * available" is a statement about the deployment: the row is gone and asking
 * again will not bring it back. This one is about this turn only — the file is
 * still there, and a question about it directly makes it the message being
 * asked about, which is the first thing the budget is spent on and so is served
 * whole — or refused outright, never quietly reduced to this note. Telling
 * somebody their file was deleted when it was not is the kind of wrong answer
 * that gets acted on.
 */
function notIncludedNote(part: Record<string, unknown>, id: string): unknown {
  return {
    type: "text",
    text: `[attachment "${displayName(part, id)}" from an earlier message was not included in this turn]`,
  };
}

/**
 * The refusal for an attachment on the message being asked about that this run has no room for.
 *
 * A THROW WHERE HISTORY GETS {@link notIncludedNote}, AND THAT ASYMMETRY IS THE WHOLE POINT.
 * `MAX_INLINED_BYTES_PER_RUN` used to bound only the half of a run that could degrade: both places
 * that stopped spending tested for `onMissing === "note"`, and the message being asked about is
 * resolved under `"fail"`, so nothing at all bounded the one message a browser had just written.
 * A member naming two hundred previously-sent 8 MiB attachments in a single message inlined about
 * 1.6 GiB, plus its base64 on top, in one turn — precisely the heap exhaustion the budget exists to
 * prevent, arriving through the one door it left open.
 *
 * THE FIX IS NOT TO MAKE THAT MESSAGE CUTTABLE. Cutting it would silently drop files out of the
 * message somebody is asking a question ABOUT, which is the exact failure the strict `"fail"` mode
 * was written to prevent: an answer given confidently about a file the model never received, with
 * nothing in the transcript saying so. The guarantee worth keeping is "the asked message is served
 * in full, or the turn fails loudly"; all that was missing is that "in full" be a BOUNDED quantity.
 * Past the bound, the turn fails loudly. A refusal naming the problem is an answer somebody can act
 * on, and silent truncation is not.
 *
 * IT NAMES THE FILE, THE ID, THE LIMIT AND A WAY OUT, because unlike every other failure in this
 * file this one is about the person's own most recent action, which they can still change: the
 * message is still in front of them. The display name is what they will recognise, the id is what
 * an operator reading a log can grep for, and the limit is what turns "too big" into a number.
 */
function tooMuchToInline(
  part: Record<string, unknown>,
  id: string,
  limit: number,
): never {
  throw new Error(
    `Attachment ${namedForFailure(part, id)} could not be included: this message's attachments come to more than the ${limit} bytes one turn may put in front of the model. Send fewer files, or ask about them across more than one message.`,
  );
}

/**
 * The text part that stands in for a stored file nothing here knows how to read.
 *
 * Unreachable through today's upload route, which runs `classifyAttachment`
 * over the sniffed type before it stores anything. It becomes reachable the
 * day a type leaves `ACCEPTED_IMAGE_MIME` or `ACCEPTED_TEXT_MIME` while rows
 * of it are still in the table, and the two alternatives are both worse:
 * `toString("utf8")` on a PDF hands the model a page of mojibake it will
 * happily summarise, and throwing would fail every future turn in the channel
 * over a file the person cannot re-attach either — the composer would refuse
 * the same type at pick time. A note keeps the one property that matters,
 * that nothing answers as though the file were in front of it, and names the
 * type so a person reading the transcript can tell what happened.
 */
function unreadableNote(
  part: Record<string, unknown>,
  id: string,
  mimeType: string,
): unknown {
  return {
    type: "text",
    text: `[attachment "${displayName(part, id)}" is a ${mimeType} file, which cannot be put in front of the model]`,
  };
}

/**
 * How many STORED bytes one run may put in front of the model.
 *
 * `MAX_IMAGE_BYTES` bounds one file; until this existed nothing bounded a
 * turn. History is replayed in full on every turn, so a channel that has seen
 * four messages of eight 8 MB images cost every later turn ~256 MB read out of
 * `bytea` and ~340 MB of base64 on top of it, all live at once — and the way
 * that fails is not a refusal anybody can read, it is the pod's heap, which
 * takes every other person's in-flight run down with it.
 *
 * 32 MiB of stored bytes is about 43 MB once base64'd. Four files at the
 * `MAX_IMAGE_BYTES` ceiling, or thirty-two at the `MAX_FILE_BYTES` one: well
 * past what a conversation refers back to, and far short of what exhausts a
 * process.
 *
 * SPENT NEWEST-FIRST, WHICH IS WHY THE ASKED MESSAGE IS SERVED WHOLE.
 * `inlineAttachments` walks the history backwards, so the message being asked
 * about is charged first and is never the one cut; what runs out is the room
 * left for the messages behind it, which the model has already been shown once
 * in the turn they arrived.
 *
 * AND IT BOUNDS THAT MESSAGE TOO, BY REFUSING IT RATHER THAN CUTTING IT.
 * Charged first is not the same as bounded, though for a while this comment was
 * read that way: both places that stopped spending tested for
 * `onMissing === "note"`, so this number bounded only the half of a run that
 * could degrade, and a message a browser wrote naming two hundred
 * previously-sent 8 MiB files inlined every one of them. A message past this
 * limit now fails its turn with a sentence a person can act on — see
 * {@link tooMuchToInline} — which keeps what the strict mode is for, that the
 * asked message arrives in full or not at all, while giving "in full" a
 * ceiling.
 *
 * It lives HERE and not in `shared/attachments.ts` beside the other limits on
 * purpose. Those are limits two sides have to agree on — the composer refuses
 * a file and the server refuses it again — and that file's whole argument is
 * the drift between the two. This one is neither: the composer has no say in
 * how much of a thread a turn replays, and nothing in a browser can observe
 * it.
 */
export const MAX_INLINED_BYTES_PER_RUN = 32 * 1024 * 1024;

/**
 * What one run has left to spend, threaded through every message in it.
 *
 * A mutable object rather than a number passed back and forth, because the
 * spending is across messages and not within one: `inlineAttachments` hands
 * the same object to each message in turn and each draws it down. A caller
 * with nothing to bound — a unit test, one message resolved on its own —
 * passes nothing and gets the unbounded behaviour this had before.
 */
export type InlineBudget = {
  /** Bytes still unspent. Drawn down once per distinct id a message charges to it. */
  remaining: number;
  /**
   * What `remaining` started at, carried only so that a refusal can name it.
   *
   * The message being asked about is refused rather than cut when it does not fit
   * ({@link tooMuchToInline}), and a refusal that cannot say what the limit WAS is a failure with
   * no action behind it. By the time one is raised `remaining` has already been drawn down by the
   * parts of that message that did fit, so it is no longer the number to quote; this is. Set from
   * `remaining` rather than from {@link MAX_INLINED_BYTES_PER_RUN} so a caller that constructs a
   * smaller budget — every test here does — gets a sentence about the budget it actually passed.
   */
  limit: number;
};

export function newInlineBudget(
  remaining: number = MAX_INLINED_BYTES_PER_RUN,
): InlineBudget {
  return { remaining, limit: remaining };
}

async function resolvePart(
  part: Record<string, unknown>,
  id: string,
  load: (id: string) => Promise<StoredAttachment | null>,
  onMissing: MissingAttachment,
  budget: InlineBudget | undefined,
  /**
   * The ids THIS MESSAGE has already spent bytes on, so a second part of it naming one costs
   * nothing.
   *
   * `loadOnce` deduplicates the READ, which is what made "one read per distinct id" true; the charge
   * lived here and ran once per PART, so a message quoting one image twice was billed twice for
   * bytes fetched once. The budget is spent newest-first precisely so the asked message is served
   * whole, and over-charging cut real history off the end of the run to pay for reads that never
   * happened.
   *
   * PER MESSAGE AND NOT PER RUN, DELIBERATELY. This said "this run" for a while and the sentence was
   * simply false: `resolveAttachmentParts` builds one of these per call, and it is called once per
   * message, so an id quoted in two messages is read twice and charged twice. Hoisting the set to
   * the run was considered and rejected, on two grounds.
   *
   * The first is that it cannot travel alone. Hoisting the charge without hoisting `loadOnce`'s memo
   * would bill once for bytes genuinely read N times, replacing one false statement with another.
   * The second is that hoisting the memo is worse than the read it saves: a run-scoped memo holds
   * every distinct attachment's `Buffer` live for the whole backward walk, while a per-message one
   * lets each message's buffers go once its parts are encoded — and what is live at the peak is the
   * thing this budget exists to bound. Trading a rare second read (the same person re-attaching the
   * same file in two messages) for unbounded buffer retention is the wrong way round.
   *
   * Charging twice is also the honest number rather than a concession. An id quoted in two messages
   * IS read out of `bytea` twice and IS base64-ed into the run twice; the budget measures what a
   * turn spends, and a turn that spends those bytes twice should be billed for them twice.
   */
  charged: Set<string>,
): Promise<unknown> {
  /*
   * CUT BEFORE THE LOAD, NOT AFTER IT. The read out of `bytea` is most of what
   * this budget exists to bound, so a part that cannot fit must not be fetched
   * to find that out. Once the budget reaches zero every later part costs one
   * comparison and no database round trip at all.
   *
   * `onMissing` DECIDES WHAT RUNNING OUT MEANS, NOT WHETHER THE BUDGET APPLIES,
   * and that distinction is the fix for what this used to do. The test was
   * `onMissing === "note" && budget !== undefined` — one flag standing for both
   * questions — so the message being asked about, resolved under `"fail"`, was
   * never stopped at all and no ceiling existed on what a browser-written
   * message could inline. The budget now applies to every part under it. What
   * differs is the answer when it runs out: `"note"` is history and degrades
   * into text saying the file was left out of this turn, so the conversation
   * still runs; `"fail"` is the message being asked about and does not degrade
   * in either direction — it is served in full, or the turn is refused naming
   * the file. See {@link notIncludedNote} and {@link tooMuchToInline} for why
   * those must be different answers rather than one.
   */
  const noRoomLeft = budget !== undefined && budget.remaining <= 0;
  /*
   * An id already paid for is never cut, however little is left. Its bytes are in this run whatever
   * happens next, so cutting the second mention would put one file in front of the model twice over
   * — once as itself, once as a note saying it was left out — which is a worse answer than either.
   * It is not refused either, for the same reason: the run is not about to save anything by failing
   * over bytes it has already spent.
   */
  if (noRoomLeft && !charged.has(id)) {
    if (onMissing === "note") return notIncludedNote(part, id);
    tooMuchToInline(part, id, budget.limit);
  }

  const attachment = await load(id);
  /*
   * Dropping a part whose attachment vanished would let the Bot answer
   * confidently about an image or file it never actually received, and
   * neither the person who attached it nor the person reading the answer
   * could tell that is what happened. A turn that fails outright is
   * recoverable; an answer about a file nobody sent is not. So "fail"
   * throws, naming the id, instead of silently continuing without it.
   *
   * "note" is not that same silence. The part is replaced by text that
   * says the file is gone, so the model is told there was an attachment
   * and told it cannot see it, which is the one thing dropping the part
   * would have hidden. What it is not allowed to do is answer as though
   * the file were there.
   *
   * The refusal leads with the name the person gave the file and keeps the id
   * behind it; see {@link namedForFailure} for why that order.
   *
   * AND IT DOES NOT PRETEND TO KNOW WHICH OF FOUR THINGS HAPPENED. `load`
   * answers `null` for a row the sweeper reclaimed, for a file belonging to
   * somebody this asker cannot see, for one belonging to another channel, and
   * for an id that never named a row at all — four different situations, with
   * four different things to do about them, flattened into one absent value by
   * the `(id) => Promise<StoredAttachment | null>` seam this function is handed.
   * Naming one of them would be a guess printed as a fact, so this names the
   * ones it could be and leaves the choice to the reader, who has the context
   * to make it. Telling them apart properly means a richer result from the
   * loader in `channels/attachments.ts`, which is a change on the other side of
   * this seam and not one this sentence can make.
   */
  if (!attachment) {
    if (onMissing === "note") return unavailableNote(part, id);
    throw new Error(
      `Attachment ${namedForFailure(part, id)} could not be loaded: it may have been deleted, or it may belong to another channel or to somebody whose files you cannot see.`,
    );
  }

  if (budget && !charged.has(id)) {
    /*
     * The same fork as above, one step later, for the file whose size could not
     * be known until it was read. In history a file that does not fit takes the
     * budget to zero rather than leaving a sliver behind: half an image is not a
     * smaller image, and a remainder left lying about would tempt one more read
     * out of every later part instead of stopping the reads here. On the message
     * being asked about there is nothing to zero, because the turn ends here.
     */
    if (attachment.bytes.length > budget.remaining) {
      if (onMissing === "note") {
        budget.remaining = 0;
        return notIncludedNote(part, id);
      }
      tooMuchToInline(part, id, budget.limit);
    }
    charged.add(id);
    budget.remaining = Math.max(0, budget.remaining - attachment.bytes.length);
  }

  /*
   * THE STORED MIME TYPE DECIDES, NOT `part.type`.
   *
   * `mimeType` is `sniffMimeType`'s answer, earned from the bytes when the
   * file was uploaded. `part.type` is the browser's claim, fixed from
   * `file.type` BEFORE that upload happened and never reconciled with what
   * came back. The two disagree in a way that reaches the model: a PNG whose
   * browser claim was `text/plain` is sniffed and stored as `image/png` while
   * the sent part still says `document`, and reading `part.type` there ran a
   * PNG through `toString("utf8")` and captioned the mojibake
   * `Attached file "photo.txt":`. The same read let any of AG-UI's other part
   * types — `binary`, `audio` — base64 a whole text file, around
   * `MAX_EXTRACTED_CHARACTERS` entirely.
   *
   * `classifyAttachment` is the same function the upload route decided to
   * accept the row with, so this asks the stored bytes the identical question
   * that let them be stored, and the answer cannot be moved by anything a
   * client writes.
   */
  const kind = classifyAttachment(attachment.mimeType);

  if (kind === "text") {
    const text = extractDocumentText(attachment.bytes);
    return {
      type: "text",
      text: `Attached file "${attachment.name}":\n\n${text}`,
    };
  }

  if (kind !== "image") return unreadableNote(part, id, attachment.mimeType);

  /*
   * `type: "image"` is asserted rather than inherited. A stored PNG that
   * arrived on a `document` part has to reach the provider AS an image, or the
   * one thing this whole path exists for — the model actually seeing the
   * picture — does not happen.
   */
  return {
    ...part,
    type: "image",
    source: {
      type: "data",
      value: attachment.bytes.toString("base64"),
      mimeType: attachment.mimeType,
    },
  };
}

/**
 * Swaps a stored attachment reference for content the model can actually
 * read, resolving every part in `content` whose source is a
 * `/api/attachments/<id>` URL against `load` — whatever type that part
 * declares itself to be, and into whatever the STORED bytes turn out to be.
 * See `attachmentIdFor` for why the declared type is not a gate, and
 * `resolvePart` for why it does not choose the modality either.
 *
 * Returns `content` BY IDENTITY when no part needs resolving. Every message
 * in a thread passes through here on every turn and almost none carry an
 * attachment, so that early return is load-bearing, not an optimization:
 * callers that compare the result to the input (e.g. to decide whether a
 * cache entry changed) depend on getting the same reference back.
 *
 * `onMissing` DEFAULTS TO "fail", so a caller that has not thought about
 * which message this is gets the strict answer. It is the message being
 * asked about that must fail: an unloadable attachment there is one the
 * answer was supposed to be about.
 *
 * For an older message it must not. History is replayed in full on every
 * turn, so a row that vanished once would fail this channel's every future
 * turn, for ever, with no recovery but starting another channel — the same
 * shape as the dangling tool call in `agents/history-sanitize.ts`, found in
 * production twice: a permanent failure grown out of transient damage, and
 * nothing the person did wrong. That file's answer is this one's. History is
 * CONTEXT for a turn, not a transaction to resume; the attachment is already
 * permanently gone and there is nothing to fetch; so the choice is between a
 * conversation that can never run again and the same conversation with one
 * old file marked missing.
 *
 * `budget`, when given, is how much this RUN may still inline; see
 * {@link MAX_INLINED_BYTES_PER_RUN}. Absent means unbounded, which is what
 * this did before the budget existed and what a single-message caller wants.
 *
 * IT BOUNDS THIS MESSAGE WHICHEVER `onMissing` SAYS — what changes is the answer when it runs out.
 * Under `"note"` the parts that did not fit become text saying so and the call returns; under
 * `"fail"` the call REJECTS, because that mode is the message being asked about and a person's own
 * question is not something to quietly serve half of. A caller passing `"fail"` with a budget is
 * therefore asking for "all of it or an error", which is what {@link tooMuchToInline} spells out.
 *
 * PARTS RESOLVE ONE AT A TIME, not through `Promise.all`. Two reasons, and the
 * first is correctness: a budget spent by whichever load happened to settle
 * first would cut a different part on each run over the same thread. The
 * second is the peak — `Promise.all` over eight parts holds eight files and
 * their base64 at once, which is the shape that exhausts a heap. What is given
 * up is concurrency across a handful of small reads, on the rare message that
 * carries a file at all.
 *
 * ONE READ PER DISTINCT ID, AND ONE CHARGE. The same id on two parts of one
 * message is loaded once and billed to the budget once. It is still encoded per
 * part, because two parts must not share one object: whatever runs after this is
 * entitled to treat the parts it was handed as its own.
 *
 * The read half is `loadOnce` below; the charge half is the `charged` set it is
 * handed alongside. They were not always both true — the memo made the sentence
 * look satisfied while the charge still ran per part — so they are asserted
 * separately in `attachment-parts.test.ts` rather than as one claim.
 *
 * WITHIN ONE MESSAGE, WHICH IS ONE CALL OF THIS FUNCTION, AND NOT ACROSS THE RUN.
 * Both the memo and the set are built here, so neither outlives the message, and an
 * id quoted in two messages of one thread is read twice and charged twice. That is
 * the intended scope and not an oversight: see `resolvePart`'s `charged` parameter
 * for why the pair has to move together and why moving it costs more heap than the
 * second read costs time.
 */
export async function resolveAttachmentParts(
  content: unknown,
  load: (id: string) => Promise<StoredAttachment | null>,
  onMissing: MissingAttachment = "fail",
  budget?: InlineBudget,
): Promise<unknown> {
  if (!Array.isArray(content)) return content;

  const ids = content.map((part) => attachmentIdFor(part));
  if (ids.every((id) => id === null)) return content;

  const reads = new Map<string, Promise<StoredAttachment | null>>();
  const loadOnce = (id: string): Promise<StoredAttachment | null> => {
    const already = reads.get(id);
    if (already) return already;
    const reading = load(id);
    reads.set(id, reading);
    return reading;
  };

  /**
   * Ids THIS MESSAGE has already spent bytes on — see `resolvePart`'s `charged` parameter for why
   * the scope is the message rather than the run it belongs to.
   */
  const charged = new Set<string>();

  const resolved: unknown[] = [];
  for (const [index, part] of content.entries()) {
    const id = ids[index];
    resolved.push(
      id === null
        ? part
        : await resolvePart(
            part as Record<string, unknown>,
            id,
            loadOnce,
            onMissing,
            budget,
            charged,
          ),
    );
  }
  return resolved;
}
