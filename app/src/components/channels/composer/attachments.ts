import type { Attachment, AttachmentsConfig } from "@copilotkit/react-core/v2";
import {
  deleteAttachment,
  uploadConversationAttachment,
} from "@/lib/api/generated/conversations/conversations";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import {
  ACCEPTED_FILE_TYPES,
  type AttachmentLimits,
  attachmentUrl,
  classifyAttachment,
  largestAttachmentBytes,
} from "@/lib/channels/attachments";
import { ClientError } from "@/lib/client";
import { newId } from "@/lib/new-id";

/**
 * Uploads a picked file to this deployment and hands the composer a link to it, never the bytes.
 *
 * Neither `AttachmentUploadResult` nor `AttachmentUploadError` is exported by anything installed
 * here: `@copilotkit/shared` declares both, but it is not a dependency of `app/` — the only
 * installed CopilotKit package in this workspace is `react-core`, and its `v2` entry point does
 * not re-export these two. They are derived instead from `AttachmentsConfig["onUpload"]` /
 * `["onUploadFailed"]`, the one signature that IS public, so they can never drift from what the
 * SDK actually calls.
 */
type AttachmentUploadResult = Awaited<
  ReturnType<NonNullable<AttachmentsConfig["onUpload"]>>
>;
type AttachmentUploadError = Parameters<
  NonNullable<AttachmentsConfig["onUploadFailed"]>
>[0];

/** The shape `POST /api/channels/:channelId/attachments` sends back on success. */
type UploadedAttachment = {
  id: string;
  name: string;
  mimeType: string;
};

/**
 * The SDK's `onUpload`, scoped to one channel.
 *
 * `fetch` directly rather than `client()` from `@/lib/client`: `client()` JSON-stringifies its
 * body and sets a JSON content type, neither of which can carry a multipart upload.
 *
 * Supplying this is what keeps the bytes out of browser state: with `onUpload` set, the SDK never
 * calls its own `readFileAsBase64` and never retains the `File` it was handed, so no copy of the
 * bytes lives on past this call. Returning a `url` source rather than a `data` one is the other
 * half of that: it is what puts a small reference in the sent message instead of megabytes of
 * base64 riding along in it.
 */
export function uploadToChannel(
  channelId: string,
  uploadGroup: string,
): (file: File) => Promise<AttachmentUploadResult> {
  return async (file: File): Promise<AttachmentUploadResult> => {
    // Named after the file rather than left empty, for every way this can go wrong. It is the only
    // sentence anybody gets: the composer keeps the string verbatim and shows it as the reason.
    const couldNotUpload = new Error(
      `Couldn't upload "${file.name}". Try again.`,
    );
    let body: unknown;
    try {
      body = await uploadConversationAttachment(
        organizationId(),
        channelId,
        { file, uploadGroup },
        { "Idempotency-Key": idempotencyKey() },
        // What is said when the server sent no sentence of its own, a proxy's error page included.
        { fallback: couldNotUpload.message },
      );
    } catch (error) {
      // The server phrases refusals in the product's voice — naming the mime type or the limit
      // that was actually hit — so its sentence is preferred whenever it has really sent one.
      throw (
        (error instanceof ClientError &&
          error.status < 500 &&
          refusalIn({ error: error.message })) ||
        couldNotUpload
      );
    }

    if (!isUploadedAttachment(body)) {
      throw couldNotUpload;
    }

    return {
      type: "url",
      value: attachmentUrl(body.id),
      mimeType: body.mimeType,
      metadata: { attachmentId: body.id, filename: body.name },
    };
  };
}

/**
 * The server's own sentence, when it has actually sent one.
 *
 * `??` was doing this job and could not: it steps in only for `null` and `undefined`, so
 * `{"error":""}` — or a whitespace-only one, or a number — was preferred over the fallback and
 * reached the strip as a file refused with NO REASON BESIDE IT. A refusal with nothing to read is
 * indistinguishable from a bug, which is the one thing this whole path exists to avoid.
 */
function refusalIn(body: unknown): Error | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const { error } = body as { error?: unknown };
  if (typeof error !== "string" || error.trim().length === 0) {
    return undefined;
  }
  return new Error(error);
}

/**
 * Every field this function is about to hand the SDK, present and a string.
 *
 * `id` is checked for content and not merely for type, because it is the one that becomes a URL:
 * an empty id makes `/api/attachments/`, which is a different endpoint entirely rather than a
 * broken one.
 */
function isUploadedAttachment(body: unknown): body is UploadedAttachment {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const { id, name, mimeType } = body as Record<string, unknown>;
  return (
    typeof id === "string" &&
    id.length > 0 &&
    typeof name === "string" &&
    typeof mimeType === "string"
  );
}

/**
 * WHAT THE `+` BUTTON'S FILE DIALOG OFFERS — A HINT, AND THE ONLY PLACE `accept` IS STILL SPENT.
 *
 * This is NOT a gate. A file dialog's `accept` greys files out; it refuses nothing, every desktop
 * browser offers a way past it, and drag and paste never see it at all. So it may be as narrow as
 * is useful, where the SDK's `accept` (see `attachmentsConfigFor`) may not be narrow at all.
 *
 * THE EXTENSIONS ARE HERE FOR THE SAME REASON THE `unnamed` BRANCH EXISTS IN `picked-files.ts`. A
 * MIME-only list is matched against what the browser CLAIMS a file is, and the whole point of that
 * branch is that for a `.txt` dragged out of an editor — or anything with an extension the
 * platform has no mapping for — the browser claims `application/octet-stream` or nothing. Listing
 * the media types alone therefore greys out, in the dialog, exactly the files this composer went
 * to some trouble to accept everywhere else. `matchesAcceptFilter` and every browser's dialog both
 * read a leading-dot entry as a filename suffix, so the two doors now agree.
 *
 * Built from the one list of files OpenBot takes (`ACCEPTED_FILE_TYPES`): every type and every
 * extension that claims it, so a type added there is offered here with nothing else to change.
 */
export const FILE_PICKER_ACCEPT = ACCEPTED_FILE_TYPES.flatMap((type) => [
  type.mimeType,
  ...type.extensions.map((extension) => `.${extension}`),
]).join(",");

/**
 * `AttachmentsConfig` for one channel's composer.
 *
 * `accept` IS THE WILDCARD, AND THAT IS THE WHOLE OF THE TYPE POLICY MOVING TO ONE PLACE RATHER
 * THAN BEING ABANDONED.
 *
 * It used to be `[...ACCEPTED_IMAGE_MIME, ...ACCEPTED_TEXT_MIME].join(",")`, and that was a second
 * gate standing behind `screenPickedFiles` — a stricter one, applying a different rule, phrased for
 * a machine. `useAttachments.processFiles` runs it with `matchesAcceptFilter`, whose non-wildcard,
 * non-extension branch is a bare `file.type === filter`. `screenPickedFiles` deliberately passes a
 * claim that names no format (`application/octet-stream`, `""` — see the long note at
 * `picked-files.ts`) so the server can sniff the bytes; none of those strings equals any of the
 * eight, so the SDK refused every one of them before a request was ever made, with
 * `File "notes.txt" is not accepted. Supported types: image/png,…`. That branch was dead in the
 * running app, the drift it exists to close was still open, and the sentence somebody read was the
 * one `stageFiles` promises a screened file can never produce.
 *
 * Widening the list instead was the other option and is not enough: `""` cannot be written as an
 * accept entry at all, and `namesNoFormat` also passes anything not shaped like a MIME type, which
 * is an open set. There is no string that means what the screen means.
 *
 * WHAT THIS COSTS, STATED PLAINLY: nothing, because the SDK's filter was never reachable except
 * through us. `stageFiles` is the only caller of `processFiles` — the composer supplies its own
 * drop handler and its own `onChange`, so the hook's `handleDrop` and `handleFileUpload` are never
 * used — and the hook's own `document` paste listener is inert here, because it is scoped by a
 * `containerRef` this composer deliberately never hands it (see `containerRef` in `composer.tsx`).
 * So every file that reaches `processFiles` has already been through `screenPickedFiles`, which
 * enforces kind, BOTH size ceilings and the per-message cap — all of which the SDK's filter does
 * not — and phrases its refusals for a person. The narrow list is kept where it is honest about
 * being a hint: `FILE_PICKER_ACCEPT`, above, on the file dialog.
 *
 * `maxSize` is the largest of the server's limits (`largestAttachmentBytes`): the SDK config has
 * only one number for every kind of file. A tighter limit for one kind (text, on a server that keeps
 * 1MB for it) is enforced by our own pre-check ahead of upload, and again by the server on arrival,
 * which is the authority either way, so letting a text file past this one number costs nothing. It
 * is left in place, unlike `accept`, because it can only ever agree with the screen: the loosest
 * thing `screenPickedFiles` passes is a file of exactly that size, given the same limits, so this
 * backstop cannot fire on a file we accepted.
 */
export function attachmentsConfigFor(
  channelId: string,
  uploadGroup: string,
  onUploadFailed: (error: AttachmentUploadError) => void,
  /**
   * EVERY SERVER ROW THIS COMPOSER CREATES, REPORTED THE MOMENT IT EXISTS.
   *
   * `onUpload`'s answer normally reaches the composer the long way round, by the SDK writing it
   * onto the placeholder it minted — and that write is a no-op if the placeholder is gone, which is
   * what happens when somebody removes a chip whose upload is still in flight. The row is on the
   * server by then and the only handle to it was in that discarded answer, so the count the server
   * enforces and the count the screen shows drift apart by one, and the next pick is refused with a
   * 409 naming a file nobody can see. That is verbatim the failure `uploadGroup` was added to end.
   *
   * So the id is reported here as well, where it cannot be dropped, and `composer.tsx` reconciles
   * what it was told against what is actually on the strip. It is a separate channel rather than a
   * `wasCancelled(placeholderId)` predicate on the way in — the shape that suggests itself — for a
   * blunt reason: `onUpload` is handed a `File` and nothing else. The SDK mints the placeholder id
   * itself and never tells us which one this call belongs to, so there is no id here to be asked
   * about. Reporting the row and reconciling afterwards needs no such correlation.
   */
  onUploaded: (attachmentId: string) => void,
  /** The limits `screenPickedFiles` screened against, so the two agree. */
  limits: AttachmentLimits,
  /**
   * Each object URL made for a picture's chip, so the composer can revoke it once the chip has
   * gone. See {@link previewUrlOf}.
   */
  onPreview: (previewUrl: string) => void = () => {},
): AttachmentsConfig {
  const upload = uploadToChannel(channelId, uploadGroup);
  return {
    enabled: true,
    accept: "*/*",
    maxSize: largestAttachmentBytes(limits),
    onUpload: async (file) => {
      /*
       * A file a saved draft is putting back was uploaded before, so it is not uploaded again: the
       * answer it got then is the answer now. Still reported through `onUploaded`, so a chip put back
       * and then removed gives its row back like any other.
       */
      const restored = restoredUploadOf(file);
      if (restored) {
        const rowId = stagedRowId(restored);
        if (rowId !== undefined) onUploaded(rowId);
        return restored;
      }
      const answer = await upload(file);
      /*
       * A PICTURE'S CHIP IS DRAWN FROM THE FILE ON THIS DEVICE. Drawn from the server's address, the
       * browser downloaded the whole file again straight after uploading it, to draw an 80px square,
       * and pictures go up to 100MB. Only for a file the server read as a picture.
       */
      let uploaded = answer;
      if (answer.mimeType && classifyAttachment(answer.mimeType) === "image") {
        const previewUrl = URL.createObjectURL(file);
        onPreview(previewUrl);
        uploaded = {
          ...answer,
          metadata: { ...answer.metadata, previewUrl },
        };
      }
      const rowId = stagedRowId(uploaded);
      /*
       * `uploadToChannel` has already refused any answer without a non-empty `id`
       * (`isUploadedAttachment`), so this is narrowing rather than a real branch — `metadata` is
       * declared `unknown` by the SDK and has to be re-read as something. It is not silently
       * skipped if it ever does come back empty: the row would be one this composer never learned
       * about, which is the sweeper's to collect, and pretending otherwise by passing `undefined`
       * down would put `DELETE /api/attachments/undefined` on the wire.
       */
      if (rowId !== undefined) {
        onUploaded(rowId);
      }
      return uploaded;
    },
    onUploadFailed,
  };
}

/**
 * `AttachmentsConfig` for a composer whose conversation does not exist yet: `/channel/new` and the
 * home screen, where the first message is what creates the conversation.
 *
 * NOTHING IS UPLOADED HERE, because an upload belongs to a conversation and there is none to give
 * it. The picked file is held in this tab instead, on the attachment's own metadata, and
 * `uploadHeldFiles` sends it once the first message has made the conversation. Holding the file,
 * and not creating the conversation at the first pick, is what keeps an abandoned screen clean:
 * somebody who attaches a file and walks away leaves no empty conversation in their sidebar and no
 * row on the server counting against their limit until the sweeper finds it a day later.
 *
 * The chip's preview is an object URL onto the file, never its bytes as base64 in React state.
 * `onHeld` reports each one so the composer can revoke it once the chip has gone.
 *
 * Every file still reaches this through `screenPickedFiles` first, so kind, size and the per-message
 * cap are refused here in the same words as in a conversation. The server is still the authority:
 * it sniffs the bytes when `uploadHeldFiles` sends them, and its refusal comes back to the composer
 * with the draft.
 */
export function heldAttachmentsConfig(
  onUploadFailed: (error: AttachmentUploadError) => void,
  onHeld: (previewUrl: string) => void,
  /** The limits `screenPickedFiles` screened against, so the two agree. */
  limits: AttachmentLimits,
): AttachmentsConfig {
  return {
    enabled: true,
    accept: "*/*",
    maxSize: largestAttachmentBytes(limits),
    onUpload: async (file) => {
      const previewUrl = URL.createObjectURL(file);
      onHeld(previewUrl);
      return {
        type: "url",
        value: previewUrl,
        metadata: { heldFile: file, filename: file.name },
      };
    },
    onUploadFailed,
  };
}

/**
 * A STAGED FILE A SAVED DRAFT IS PUTTING BACK ON THE STRIP.
 *
 * The SDK's hook has no way to add an attachment that is already uploaded: its only door is
 * `processFiles`, which makes a placeholder per `File` and asks `onUpload` for the answer. So a
 * file put back goes through that same door as an empty stand-in named and typed like the original,
 * and `onUpload` recognises the stand-in and answers with what the upload said the first time. The
 * chip it makes is the one the original upload made: the same stored row, name, type and size.
 */
const restoredUploads = new WeakMap<File, AttachmentUploadResult>();

export function restoringFile(saved: {
  attachmentId: string;
  url: string;
  mimeType?: string;
  filename?: string;
  size?: number;
}): File {
  const name = saved.filename ?? "Attachment";
  const stand = new File([], name, { type: saved.mimeType ?? "" });
  // The strip shows the size the placeholder was made with; the stand-in has no bytes of its own.
  if (saved.size !== undefined) {
    Object.defineProperty(stand, "size", { value: saved.size });
  }
  restoredUploads.set(stand, {
    type: "url",
    value: saved.url,
    ...(saved.mimeType ? { mimeType: saved.mimeType } : {}),
    metadata: { attachmentId: saved.attachmentId, filename: name },
  });
  return stand;
}

/** What the first upload answered for a stand-in made by `restoringFile`, if `file` is one. */
function restoredUploadOf(file: File): AttachmentUploadResult | undefined {
  return restoredUploads.get(file);
}

/** The object URL a picture's chip is drawn from, when this tab has the file. */
export function previewUrlOf(
  carrier: { metadata?: unknown } | undefined,
): string | undefined {
  const metadata = carrier?.metadata as { previewUrl?: unknown } | undefined;
  return typeof metadata?.previewUrl === "string" && metadata.previewUrl
    ? metadata.previewUrl
    : undefined;
}

/** The file a held composer is keeping for an attachment, or `undefined` for a stored one. */
export function heldFileOf(
  carrier: { metadata?: unknown } | undefined,
): File | undefined {
  const metadata = carrier?.metadata as { heldFile?: unknown } | undefined;
  return metadata?.heldFile instanceof File ? metadata.heldFile : undefined;
}

/**
 * Send the files a held composer kept, now that the first message has created the conversation.
 *
 * Each comes back as the conversation's own composer would have made it: a `url` source naming the
 * stored row with the type the server sniffed, and `attachmentId` on its metadata. So the first
 * message is sent, stamped and drawn exactly like every later one (`toMessageContent` in
 * `channel-chat.tsx`). An attachment that already names a stored row is passed through untouched.
 *
 * ALL OR NOTHING. When one file is refused, the rows that did land are deleted before the refusal
 * is thrown, and the deletes are awaited: the caller discards the conversation next, and a row
 * whose conversation has gone can no longer be deleted by anybody but the sweeper. The draft goes
 * back to the composer with its files, and the reason is the server's own sentence naming the file
 * (`uploadToChannel`).
 */
export async function uploadHeldFiles(
  channelId: string,
  attachments: readonly Attachment[],
): Promise<Attachment[]> {
  // One group for one message: the set the server's per-message cap counts.
  const upload = uploadToChannel(channelId, newId());
  const created: string[] = [];
  const settled = await Promise.allSettled(
    attachments.map(async (attachment): Promise<Attachment> => {
      const file = heldFileOf(attachment);
      if (!file) return attachment;
      const { metadata, ...source } = await upload(file);
      const sent = { ...attachment, source, metadata };
      const rowId = stagedRowId(sent);
      if (rowId !== undefined) created.push(rowId);
      return sent;
    }),
  );
  const refused = settled.find((outcome) => outcome.status === "rejected");
  if (refused) {
    await Promise.all(created.map(discardStagedAttachment));
    throw refused.reason;
  }
  return settled.map(
    (outcome) => (outcome as PromiseFulfilledResult<Attachment>).value,
  );
}

/**
 * GIVE BACK A STAGED ROW NOTHING WILL SEND: a chip removed from the strip, or a file uploaded for a
 * first message that was then refused.
 *
 * `removeAttachment` only filters client state, so until this existed, attach-then-change-your-mind
 * left the row staged with `attachedAt IS NULL` for good. The upload handler counts exactly those
 * rows per person per channel and refuses the ninth with "You already have 8 attachments waiting to
 * send in this channel." — naming files that are on nobody's screen, with no way back.
 *
 * BEST-EFFORT, AND DELIBERATELY UNINSPECTED. The chip is gone from the strip before this is called,
 * because that is what the person asked for; making that wait on a round trip, or reporting what
 * comes back, would put an error in front of somebody for a request they never made. There are two
 * such answers — 404 for a non-uploader, 409 for an attachment already sent — and neither is
 * actionable. `cull-staged-attachments.ts` is the backstop for whatever this misses. It resolves
 * either way, so a caller that has to wait for it can.
 */
export function discardStagedAttachment(attachmentId: string): Promise<void> {
  return deleteAttachment(organizationId(), attachmentId, {
    "Idempotency-Key": idempotencyKey(),
  }).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * The server row an SDK attachment stands for, if it stands for one.
 *
 * `metadata` is `unknown` on the SDK's `Attachment` — it is whatever `onUpload` chose to return —
 * so every reader has to narrow it, and this is the one place that knows what we put there. Both
 * the composer's reconciler and this file's `onUpload` wrapper read it through here rather than
 * each spelling out the same cast, because the two must never disagree about what counts as a row.
 *
 * `undefined` for an attachment still uploading, which has no row yet, and for one the SDK built
 * itself without our `onUpload` — neither has anything on the server to give back.
 */
export function stagedRowId(
  carrier: { metadata?: unknown } | undefined,
): string | undefined {
  const metadata = carrier?.metadata as { attachmentId?: unknown } | undefined;
  return typeof metadata?.attachmentId === "string"
    ? metadata.attachmentId
    : undefined;
}
