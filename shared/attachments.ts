/**
 * What may be attached to a message, and how much of it.
 *
 * One declaration read from both sides, the same as `routine-firing.ts`: the composer refuses a
 * file before uploading it and the server refuses it again on arrival, and those two refusals have
 * to agree. A limit written twice is a limit that drifts, and the drift shows up as a file the
 * composer accepted and the server threw away with no explanation.
 */

export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/**
 * A hard ceiling, not a downscaling threshold: nothing in this path resizes
 * or re-encodes an image, so a file under this limit is stored and sent
 * whole. `resolvePart` (`server/src/channels/attachment-parts.ts`) then
 * base64-encodes those bytes into a single content part, which runs about
 * 4/3 the byte size — a file at this ceiling becomes a part of roughly
 * 10.7 MB.
 *
 * This deployment only ever targets `openai` (`tenant-package.ts` refuses
 * to load a package whose `model.provider` is anything else), and OpenAI's
 * vision input limit is 20 MB per image. 8 MB was chosen, not the 15 MB
 * that would sit exactly at that line, because it is the encoded form that
 * has to fit under the provider's number, not the stored one, and because
 * it is not certain from that number alone which side of the encoding it
 * was measured on — so this sits at roughly half of it either way.
 *
 * Downscaling is deliberately not built yet: a file over this ceiling is
 * refused at pick time rather than shrunk, and building the shrink step is
 * a known follow-up, not something this constant can stand in for.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * How large a text file may be UPLOADED. Not how much of it the model reads.
 *
 * Text files are not downscaled, so this is a hard refusal like `MAX_IMAGE_BYTES`.
 *
 * THIS IS NOT THE LIMIT THAT DECIDES WHAT REACHES THE MODEL, AND THE TWO NUMBERS ARE FAR APART.
 * `MAX_EXTRACTED_CHARACTERS` below is 120,000, and this is 1,048,576. A file accepted at this
 * ceiling is stored whole and then handed to the model as its first 120,000 characters — for
 * ASCII-ish text, where a byte is a character, roughly its first EIGHTH, with about 89% cut. Text
 * in a script that costs several bytes per character loses proportionally less, because the
 * ceilings are counted in different units, but a file anywhere near this size is cut.
 *
 * The two are deliberately different numbers because they bound different things, and neither can
 * stand in for the other:
 *
 *   - this one bounds what is UPLOADED, STORED and SERVED — bandwidth, disk, and the size of the
 *     response `/api/attachments/:id` has to produce;
 *   - `MAX_EXTRACTED_CHARACTERS` bounds what one attachment may spend of a shared CONTEXT WINDOW,
 *     which is a budget split with the conversation and with up to seven other attachments.
 *
 * REJECTED: lowering this to 120,000 so the two agree. It would refuse files the app can already
 * do something useful with — the first 120,000 characters of a large CSV usually answers the
 * question that was asked of it — and would trade a partial read for no read at all.
 *
 * REJECTED: raising `MAX_EXTRACTED_CHARACTERS` to match this. A megabyte of text is a few hundred
 * thousand tokens, which is the context window this deployment targets spent entirely on one
 * attachment. That is the outcome that constant exists to prevent.
 *
 * So the gap stays, and what it costs is stated here rather than left for somebody to derive by
 * dividing one constant by the other. What is NOT yet resolved is that the person who uploads the
 * file is not told — see `MAX_EXTRACTED_CHARACTERS`.
 */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * How large a PDF may be uploaded.
 *
 * A PDF is not read the way a text file is: its words are extracted on the server and only those
 * reach the model, capped by `MAX_EXTRACTED_CHARACTERS` like any text. Most of a PDF's bytes are
 * fonts, images and layout, so a one-page invoice can run to hundreds of kilobytes and a scanned
 * statement to several megabytes, and `MAX_FILE_BYTES` would refuse files whose text is short. The
 * image ceiling is used because it is already the largest file the upload route takes, so the
 * route's body limit holds a PDF at this size without a second number.
 */
export const MAX_DOCUMENT_BYTES = MAX_IMAGE_BYTES;

/**
 * The largest picture drawn in place in a conversation. A larger one is shown as its file (its
 * name, kind and size) with a way to open it full size, and is fetched only when somebody does.
 *
 * Pictures go up to 100MB on an install with an object store, and a thumbnail is drawn from the
 * whole file: drawing every picture would cost each reader that much on first paint. Set to the
 * image limit every install had before (`MAX_IMAGE_BYTES`), so every picture drawn in place before
 * larger ones were allowed is still drawn in place.
 */
export const LARGEST_PICTURE_DRAWN_INLINE = MAX_IMAGE_BYTES;

/**
 * How large an attached file of each kind may be, in bytes, as one server answers it.
 *
 * THE CONSTANTS ABOVE ARE THE DEFAULT, NOT THE ONLY ANSWER. A server may take larger files, and
 * says so in the API's `deployment` (`attachmentLimits`). The composer refuses at pick time with the
 * server's numbers, and the server refuses again on arrival with the same ones, so the two refusals
 * still agree: they are one answer read from one place, now the server rather than this file.
 *
 * What reaches the model is a separate limit and is the server's alone. A file larger than a model
 * provider takes is still stored and downloadable; the server hands the model what it can read, or a
 * note saying the file is too large for it to view.
 */
export type AttachmentLimits = {
  /** An image. */
  imageBytes: number;
  /** A document whose text the server reads out (a PDF). */
  documentBytes: number;
  /** Text and every other accepted kind. */
  fileBytes: number;
};

/** The limits a server that does not publish its own takes: the constants above. */
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  imageBytes: MAX_IMAGE_BYTES,
  documentBytes: MAX_DOCUMENT_BYTES,
  fileBytes: MAX_FILE_BYTES,
};

/**
 * The limits a server published, read field by field.
 *
 * Absent reads as today's numbers: an older server publishes nothing and takes exactly the defaults,
 * so assuming more would have the composer pass files that server then refuses. A field that is not
 * a positive whole number is read the same way, rather than as a limit of zero that refuses every
 * file or one of infinity that refuses none.
 */
export function attachmentLimitsFrom(published: unknown): AttachmentLimits {
  const fields =
    typeof published === "object" && published !== null
      ? (published as Record<string, unknown>)
      : {};
  const read = (key: keyof AttachmentLimits): number => {
    const value = fields[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : DEFAULT_ATTACHMENT_LIMITS[key];
  };
  return {
    imageBytes: read("imageBytes"),
    documentBytes: read("documentBytes"),
    fileBytes: read("fileBytes"),
  };
}

/** The largest file of any kind these limits take: the ceiling for a file whose kind is not known yet. */
export function largestAttachmentBytes(limits: AttachmentLimits): number {
  return Math.max(limits.imageBytes, limits.documentBytes, limits.fileBytes);
}

/**
 * A limit as a person reads it: whole megabytes, counted in 1,048,576 bytes as the limits are
 * ("8MB", "1MB", "100MB"). One function for the composer and the server, so a refusal names the same
 * number whichever side said it.
 */
export function formatAttachmentLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/**
 * How much extracted text may reach the model from one file.
 *
 * The real limit on a text attachment is tokens, not bytes: a one-megabyte file is a few hundred
 * thousand tokens and would fill the window on its own. 120,000 characters is roughly 30,000
 * tokens, which every model this deployment targets can hold alongside a conversation. Text past
 * this point is cut and the part says so, rather than being silently dropped.
 *
 * THE PART SAYS SO TO THE MODEL. NOBODY SAYS SO TO THE PERSON WHO ATTACHED THE FILE.
 *
 * `extractDocumentText` (`server/src/channels/attachment-parts.ts`) appends
 * `[attachment truncated at 120000 characters]` to what it sends, so the model is never left
 * answering questions about a file it read only part of without knowing. That is half the promise.
 * The other half is not kept: this ceiling is 120,000 while `MAX_FILE_BYTES` above is 1,048,576, so
 * a 1 MB CSV is accepted at pick time, uploaded whole, shown as a `1.0MB` tile — and then read by
 * the model as roughly its first eighth, with nothing anywhere in the UI saying so. Somebody who
 * asks "how many rows have status=failed" gets a confident answer about the part that fit.
 *
 * That is a real gap and it is recorded rather than fixed here, because the fix is a composer
 * change and this file is only where the number lives. What the composer needs is already exported:
 * a file whose SIZE IN BYTES exceeds this constant may be truncated, and one at or under it cannot
 * be. That direction is exact rather than approximate — UTF-8 spends at least one byte per code
 * point, so a file of N bytes can never decode to more than N characters — which makes
 * `file.size > MAX_EXTRACTED_CHARACTERS` a warning that never fires on a file that will arrive
 * whole. It is deliberately a "may", since the same byte count is fewer characters in any script
 * that costs more than a byte each.
 */
export const MAX_EXTRACTED_CHARACTERS = 120_000;

/**
 * Whether a file of this many BYTES may reach the model truncated.
 *
 * Exact in the safe direction: UTF-8 decodes N bytes to at most N characters,
 * so `size <= MAX_EXTRACTED_CHARACTERS` cannot be cut, and `size > ...` may be
 * (fewer characters for multi-byte scripts, hence "may"). Callers show a
 * warning, never a refusal — the server still accepts and reads the prefix.
 */
export function mayBeTruncatedForModel(sizeBytes: number): boolean {
  return sizeBytes > MAX_EXTRACTED_CHARACTERS;
}

/**
 * EVERY KIND OF FILE OPENBOT TAKES, IN ONE LIST, AND THE ONE PLACE TO ADD ONE.
 *
 * What a person may attach and what a Bot may send from its computer are both read from here: the
 * composer's picker and its refusals, the server's sniff and its refusals, the Bot's send tool, its
 * description and its refusal sentence. So the two can never take different files, and a kind added
 * here is added everywhere at once.
 *
 * A row is the media type the server serves the file as, its kind (which decides its size limit and
 * how the model reads it), the name a person reads, and the extensions that claim it. A Bot's file
 * has no browser to name its type, so its extension is the claim; the bytes still decide.
 *
 * ADDING A ROW IS NOT ALL OF ADDING A TYPE. A type needs four things, and the row is one of them:
 *
 *   1. The row here, with the name a person reads (a document's name takes an "s" in a list, so
 *      "Word document" becomes "Word documents") and every extension that claims it.
 *   2. The server recognising it by its BYTES, never by its name or the client's word: images and
 *      PDFs by their signatures, text only when every byte is UTF-8, and an Office file only when it
 *      is a zip package whose `[Content_Types].xml` gives its main part the row's `mainPartType`.
 *   3. A way for the model to read it: a document's text is extracted on the server and handed on
 *      as text, cut at `MAX_EXTRACTED_CHARACTERS` and marked so, and a file whose text cannot be read
 *      reaches the model as a note saying so.
 *   4. An icon for the file's card in the app.
 *
 * Without all four, a row makes a file the composer offers and the server refuses, or one the server
 * stores and the model cannot read. The test beside this file pins today's set, so a change here is
 * one somebody decided on.
 *
 * `image/svg+xml` is deliberately absent. An SVG is an image and can also carry script. Served inline
 * from this app's own origin, one pasted into a channel is stored XSS against everybody in it. Nobody
 * pastes an SVG expecting a model to read it, so it is refused at the door rather than sanitised.
 *
 * DOCUMENTS ARE READ, NEVER RENDERED. A PDF is accepted only when the bytes start with the PDF
 * signature. A Word, Excel or PowerPoint file is accepted only in the Office Open XML form (.docx,
 * .xlsx, .pptx): a zip package naming its main part. The older binary forms (.doc, .xls, .ppt) and the
 * macro-enabled ones (.docm, .xlsm, .pptm) are not on the list; a macro-enabled package names a
 * different main part, so renaming one to .xlsx does not get it in. Every document is served back as
 * a download, never inline, like every type that is not an image.
 */
export const ACCEPTED_FILE_TYPES = [
  { mimeType: "image/png", kind: "image", name: "PNG", extensions: ["png"] },
  {
    mimeType: "image/jpeg",
    kind: "image",
    name: "JPEG",
    extensions: ["jpg", "jpeg"],
  },
  { mimeType: "image/gif", kind: "image", name: "GIF", extensions: ["gif"] },
  { mimeType: "image/webp", kind: "image", name: "WebP", extensions: ["webp"] },
  {
    mimeType: "application/pdf",
    kind: "document",
    name: "PDF",
    extensions: ["pdf"],
  },
  {
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "document",
    name: "Word document",
    extensions: ["docx"],
    mainPartType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  },
  {
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "document",
    name: "Excel workbook",
    extensions: ["xlsx"],
    mainPartType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  },
  {
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    kind: "document",
    name: "PowerPoint presentation",
    extensions: ["pptx"],
    mainPartType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  },
  {
    mimeType: "text/plain",
    kind: "text",
    name: "text",
    extensions: ["txt", "text", "log"],
  },
  {
    mimeType: "text/markdown",
    kind: "text",
    name: "Markdown",
    extensions: ["md", "markdown"],
  },
  { mimeType: "text/csv", kind: "text", name: "CSV", extensions: ["csv"] },
  {
    mimeType: "application/json",
    kind: "text",
    name: "JSON",
    extensions: ["json"],
  },
] as const satisfies readonly {
  mimeType: string;
  kind: "image" | "text" | "document";
  name: string;
  extensions: readonly string[];
  /**
   * An Office file's main part, as its package's `[Content_Types].xml` types it. The server takes a
   * zip as this file only when that part is in the package with exactly this type.
   */
  mainPartType?: string;
}[];

export type AcceptedFileType = (typeof ACCEPTED_FILE_TYPES)[number];

type MimeTypeOf<Kind extends AcceptedFileType["kind"]> = Extract<
  AcceptedFileType,
  { kind: Kind }
>["mimeType"];

/** The media types of one kind, from {@link ACCEPTED_FILE_TYPES}. */
function mimeTypesOf<Kind extends AcceptedFileType["kind"]>(
  kind: Kind,
): readonly MimeTypeOf<Kind>[] {
  return ACCEPTED_FILE_TYPES.filter((type) => type.kind === kind).map(
    (type) => type.mimeType as MimeTypeOf<Kind>,
  );
}

export const ACCEPTED_IMAGE_MIME = mimeTypesOf("image");

export const ACCEPTED_TEXT_MIME = mimeTypesOf("text");

/** Documents whose text the server extracts before the model sees them: PDF, Word, Excel and PowerPoint. */
export const ACCEPTED_DOCUMENT_MIME = mimeTypesOf("document");

/** The accepted Office types: each is a zip package, known by the main part it names. */
export type OfficeFileType = Extract<
  AcceptedFileType,
  { mainPartType: string }
>;

/**
 * The Office type whose package names this main part, or undefined for any other part type (a
 * macro-enabled workbook, a template, a slide show, or anything that is not an accepted Office file).
 * Compared as media types are, ignoring case and surrounding space.
 */
export function officeFileTypeOfMainPart(
  mainPartType: string,
): OfficeFileType | undefined {
  const wanted = mainPartType.trim().toLowerCase();
  return ACCEPTED_FILE_TYPES.find(
    (type): type is OfficeFileType =>
      "mainPartType" in type && type.mainPartType.toLowerCase() === wanted,
  );
}

/** The accepted Office type a media type names, or undefined for any other type. */
export function officeFileTypeOf(mimeType: string): OfficeFileType | undefined {
  const type = acceptedFileTypeOf(mimeType);
  return type && "mainPartType" in type ? (type as OfficeFileType) : undefined;
}

/** Whether a media type is one of the accepted Office types. */
export function isOfficeFileType(mimeType: string): boolean {
  return officeFileTypeOf(mimeType) !== undefined;
}

/** The accepted type a media type names, or undefined for one OpenBot does not take. */
export function acceptedFileTypeOf(
  mimeType: string,
): AcceptedFileType | undefined {
  const mediaType = mediaTypeOf(mimeType);
  return ACCEPTED_FILE_TYPES.find((type) => type.mimeType === mediaType);
}

/**
 * The type a file's name claims, for the server's sniff to corroborate. Blank for an extension no
 * accepted type has, which the sniff reads as a claim that names nothing.
 */
export function claimedTypeOfName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const extension = name.slice(dot + 1).toLowerCase();
  return (
    ACCEPTED_FILE_TYPES.find((type) =>
      (type.extensions as readonly string[]).includes(extension),
    )?.mimeType ?? ""
  );
}

/**
 * What can be sent, as a person or a model reads it: "images (PNG, JPEG, GIF, WebP), PDFs, Word
 * documents, Excel workbooks, PowerPoint presentations, and text, Markdown, CSV or JSON files". Built from {@link ACCEPTED_FILE_TYPES}, so it never lists a kind the
 * server refuses or leaves out one it takes.
 */
export function acceptedFilesInWords(): string {
  const names = (kind: AcceptedFileType["kind"]) =>
    ACCEPTED_FILE_TYPES.filter((type) => type.kind === kind).map(
      (type) => type.name,
    );
  const either = (words: string[]) =>
    words.length < 2
      ? words.join("")
      : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
  const images = names("image");
  const documents = names("document");
  const texts = names("text");
  const groups = [
    images.length > 0 ? `images (${images.join(", ")})` : "",
    ...documents.map((name) => `${name}s`),
    texts.length > 0 ? `${either(texts)} files` : "",
  ].filter(Boolean);
  if (groups.length < 2) return groups.join("");
  return `${groups.slice(0, -1).join(", ")}, and ${groups[groups.length - 1]}`;
}

/**
 * A document's kind as a size refusal names it, from the one list: one of them ("a PDF", "an Excel
 * workbook") for the composer's "too large for ...", and several ("PDFs", "Excel workbooks") for the
 * server's "the limit for ...". One function for both sides, so the two refusals name the same kind.
 * A type that is not a document on the list reads as a document in general.
 */
export function documentKindInWords(
  mimeType: string,
  form: "one" | "many",
): string {
  const type = acceptedFileTypeOf(mimeType);
  const name = type?.kind === "document" ? type.name : "document";
  if (form === "many") return `${name}s`;
  return `${/^[AEIOU]/i.test(name) ? "an" : "a"} ${name}`;
}

/**
 * THE MEDIA TYPE ON ITS OWN: LOWER CASE, PARAMETERS GONE — AND THE ONLY FORM ANYTHING HERE COMPARES.
 *
 * A `File`'s type is whatever produced it. Bun's constructor appends `;charset=utf-8` to
 * `text/plain` and `application/json`, and a browser does the same for some clipboard entries; RFC
 * 2045 makes the type case-insensitive besides, and while `new File(...)` ASCII-lower-cases what it
 * is given, a `File` this app never built — one off a drop or a clipboard — carries whatever its
 * source wrote. `sniffMimeType` already normalises the same two ways before handing its answer to
 * `classifyAttachment`.
 *
 * Exported because the composer needs the identical normalisation for a different reason: the SDK's
 * own `accept` check is a case-sensitive `file.type === filter`, so anything handed to it has to
 * have been through here first or the two gates disagree about the same file.
 */
export function mediaTypeOf(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0].trim();
}

/**
 * CLAIMS THAT NAME NO FORMAT AT ALL, AND THE ONE COPY OF THAT LIST.
 *
 * A browser sends one of these for a file it has no mapping for — a `.txt` dragged out of an
 * editor, anything with an unfamiliar extension. Both sides have to treat them the same way and for
 * a while did not: `sniffMimeType` discards such a claim and reads the bytes, so the server accepts
 * the text file behind it, while the composer screened the claim alone and refused the same file at
 * pick time. That is the drift the note at the top of this file exists to prevent, so the list lives
 * here and `attachment-mime.ts` reads it from here rather than keeping its own.
 *
 * A blank claim, and anything not shaped like a MIME type, names nothing by the same reasoning.
 */
const MIME_NAMES_NOTHING: ReadonlySet<string> = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
  "application/force-download",
]);

export function namesNoFormat(mimeType: string): boolean {
  const mediaType = mediaTypeOf(mimeType);
  return !mediaType.includes("/") || MIME_NAMES_NOTHING.has(mediaType);
}

export type AttachmentKind =
  | "image"
  | "text"
  | "document"
  | "unsupported-image"
  | "unsupported";

/**
 * `unsupported-image` is a separate answer from `unsupported` so the refusal can name the real
 * problem. "That is not a supported image type" tells somebody with a HEIC photo what to do;
 * "unsupported file" leaves them guessing whether images work at all.
 *
 * THE MIME TYPE AND NOTHING ELSE, WHICH IS WHY THE FILENAME IS NO LONGER ASKED FOR. This took
 * `{ name, mimeType }` and read only the second, and the dead argument was not merely untidy: it
 * read as a promise that a file called `notes.txt` would be given the benefit of the doubt, which
 * is exactly the doubt the composer's callers had. It must not be kept, either. The server calls
 * this with the type `sniffMimeType` earned from the BYTES, and letting an extension override that
 * answer is how a binary blob named `.txt` — or an empty file, which sniffs to
 * `application/octet-stream` on purpose — would be stored and served from this origin as text.
 * Where a name does deserve the benefit of the doubt the door is `namesNoFormat`, and it is the
 * client's alone: it is asked of a claim nobody has corroborated yet, not of an answer the bytes
 * have already given.
 */
export function classifyAttachment(mimeType: string): AttachmentKind {
  // The media type is what decides here — see `mediaTypeOf`. Without this the composer refused a
  // file the server then accepted, which is the drift the note at the top of this file exists to
  // prevent.
  const mediaType = mediaTypeOf(mimeType);
  if ((ACCEPTED_IMAGE_MIME as readonly string[]).includes(mediaType)) {
    return "image";
  }
  if (mediaType.startsWith("image/")) return "unsupported-image";
  if ((ACCEPTED_TEXT_MIME as readonly string[]).includes(mediaType)) {
    return "text";
  }
  if ((ACCEPTED_DOCUMENT_MIME as readonly string[]).includes(mediaType)) {
    return "document";
  }
  return "unsupported";
}

/**
 * Whether a paste is an attachment or an ordinary text paste.
 *
 * Text wins whenever the clipboard carries any. A file is ours only when there is no text to
 * prefer.
 *
 * This is the one rule here that is NOT T3 Code's. Theirs claims an image even when text came with
 * it, on the reasoning that an image is unambiguously what was meant. It is not: copying a cell
 * from a spreadsheet, or a block from a word processor, puts an `image/png` rendering of the
 * selection on the clipboard ALONGSIDE the text. Under "an image always wins" that paste attached a
 * screenshot of the cell and typed nothing — verified in Chrome against the real app, not
 * theorised.
 *
 * A screenshot carries no text at all, so the case this rule exists for is untouched.
 *
 * DECLINING A PASTE IS NOT THE SAME AS THE TEXT BEING TYPED, AND FOR SOME SOURCES IT IS NOT WHAT
 * HAPPENS. This function only says "not ours". What the paste then does is PromptArea's rule, and
 * that rule is: if the clipboard carries an image AND the `text/html` is Microsoft Office markup —
 * it looks for `urn:schemas-microsoft-com:office`, a `ProgId` name, a `Mso` class, or an `mso-*`
 * property — the text is inserted and the image ignored. Anything else with an image on the
 * clipboard calls `onImagePaste` and RETURNS, having already called `preventDefault` and inserted
 * nothing.
 *
 * So the two halves of the spreadsheet case land differently, and it is worth being exact about
 * which is which:
 *
 *   - Word and Excel put Office markup in the `text/html`. Their text is typed. Handled.
 *   - Google Sheets, Numbers, and every other source that behaves like Office without being it,
 *     take the second branch. Their IMAGE is attached and THEIR TEXT IS NOT TYPED — the same
 *     outcome "an image always wins" gave, arrived at by a different route.
 *
 * That second bullet is a known defect and is being kept for now rather than fixed, so this comment
 * says so instead of implying the spreadsheet case is covered. Fixing it means teaching this rule
 * or PromptArea's the difference between an image that IS the selection and an image that merely
 * accompanies it, which no clipboard flag reports.
 *
 * The other trade-off, stated because it is also real: copying an image from a web page can put the
 * image's URL in `text/plain`, and that pastes the URL rather than attaching the image. Drag or the
 * `+` button still attach it, and a URL landing in the box is visible and undoable — where a
 * swallowed paste is neither.
 */
export function shouldClaimPaste(input: {
  kinds: readonly AttachmentKind[];
  plainText: string;
}): boolean {
  if (input.plainText.length > 0) return false;
  return input.kinds.length > 0;
}

/**
 * What a sent message carries instead of the bytes.
 *
 * This is an AG-UI `image`/`document` part with a URL source, NOT a part type of our own. AG-UI has
 * no reference member: `RunAgentInputSchema.parse` rejects `{type:"attachment"}` outright and the
 * runtime answers 400, verified against the installed 0.0.59 schema. The union is
 * `text | image | audio | video | document | binary`, and a source is `{type:"data"|"url"}` — there
 * is no `base64` literal and no `media_type` key anywhere.
 *
 * The URL is relative and is never fetched by a provider. `copilot.ts` swaps the source for
 * `{type:"data", value:<base64>}` as the run is built, which is what keeps the bytes out of the
 * stored thread while still putting the image in front of the model. `metadata` carries the id
 * because it is `z.unknown().optional()` and survives the parse; a sibling key would be silently
 * stripped.
 */
export type AttachmentSource =
  | { type: "data"; value: string; mimeType: string }
  | { type: "url"; value: string; mimeType?: string };

export type AttachmentPart = {
  type: "image" | "document";
  source: AttachmentSource;
  metadata?: {
    attachmentId: string;
    filename?: string;
    /** The file's size, so a reader can decide how to show it without fetching it. */
    sizeBytes?: number;
  };
};

/** The relative URL form stored in a sent message. Resolved server-side, never by a provider. */
export function attachmentUrl(attachmentId: string): string {
  return `/api/attachments/${attachmentId}`;
}
