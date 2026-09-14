import type { AttachmentsConfig } from "@copilotkit/react-core/v2";
import {
  ACCEPTED_IMAGE_MIME,
  ACCEPTED_TEXT_MIME,
  attachmentUrl,
  MAX_IMAGE_BYTES,
} from "@/lib/channels/attachments";

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
    const formData = new FormData();
    formData.append("file", file);
    /*
     * WHICH COMPOSER STAGED IT, so the server's cap counts the set this composer can see.
     *
     * The cap is per message. The composer counts what is on its own screen; without this field the
     * server counted every unsent row this person had in this channel, which is not the same set
     * the moment anything leaves a row behind — a closed tab, a stopped run, a removed queued
     * message. The client would then accept a pick the server refused with a 409 naming files that
     * were on nobody's screen, and eight such orphans locked uploads in that channel until the
     * sweeper's window expired. Sending the group is what makes the two sides count the same rows.
     */
    formData.append("uploadGroup", uploadGroup);

    const response = await fetch(`/api/channels/${channelId}/attachments`, {
      method: "POST",
      credentials: "include",
      body: formData,
    });

    /*
     * READ ONCE, FOR EITHER OUTCOME, AND NEVER TRUSTED.
     *
     * The refusal path has been careful since a body that was not JSON put "Failed to parse JSON"
     * on screen as the reason a file was rejected. The success path was not: it went straight to
     * `as UploadedAttachment`, which is a cast and not a check, so the same malformed body threw a
     * raw `SyntaxError` that the SDK reported as the refusal — and a body that parsed but carried
     * no `id` was worse, because it succeeded: `attachmentUrl(undefined)` became a chip pointing at
     * `/api/attachments/undefined`, Send unlocked, and the message went out carrying a link to no
     * attachment. Both halves of one response are held to the same standard here.
     */
    const body: unknown = await response.json().catch(() => undefined);
    // Named after the file rather than left empty, for every way this can go wrong. It is the only
    // sentence anybody gets: the composer keeps the string verbatim and shows it as the reason.
    const couldNotUpload = new Error(`Could not upload "${file.name}".`);

    if (!response.ok) {
      // The server phrases refusals in the product's voice — naming the mime type or the limit
      // that was actually hit — so its sentence is preferred whenever it has really sent one.
      throw refusalIn(body) ?? couldNotUpload;
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
 */
export const FILE_PICKER_ACCEPT = [
  ...ACCEPTED_IMAGE_MIME,
  ...ACCEPTED_TEXT_MIME,
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".txt",
  ".md",
  ".csv",
  ".json",
].join(",");

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
 * `maxSize` is `MAX_IMAGE_BYTES`, the larger of the two ceilings: the SDK config has only one
 * number for every kind of file. The tighter `MAX_FILE_BYTES` limit for text attachments is
 * enforced by our own pre-check ahead of upload, and again by the server on arrival — which is
 * the authority either way, so letting a text file past this one number costs nothing. It is left
 * in place, unlike `accept`, because it can only ever agree with the screen: the loosest thing
 * `screenPickedFiles` passes is a file of exactly `MAX_IMAGE_BYTES`, so this backstop cannot fire
 * on a file we accepted.
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
): AttachmentsConfig {
  const upload = uploadToChannel(channelId, uploadGroup);
  return {
    enabled: true,
    accept: "*/*",
    maxSize: MAX_IMAGE_BYTES,
    onUpload: async (file) => {
      const uploaded = await upload(file);
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
