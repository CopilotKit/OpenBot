import {
  ACCEPTED_IMAGE_MIME,
  ACCEPTED_TEXT_MIME,
  mediaTypeOf,
  namesNoFormat,
} from "../../../shared/attachments";

/**
 * The text claims this function will hand back under their own name.
 *
 * Built from `ACCEPTED_TEXT_MIME` rather than listed again, because the two
 * lists have to be the same list: a name returned here that `classifyAttachment`
 * does not accept is a file refused for a reason nobody can read, and a name
 * accepted there but missing here is a text file the byte guess relabels as
 * `text/plain` — a `.csv` silently becoming a `.txt`.
 *
 * THIS IS NOT DEAD CODE, AND THE BRANCH IT GUARDS IS NOT REDUNDANT WITH THE
 * `namesNoFormat` CHECK FURTHER DOWN. Two review rounds have now called it
 * dead, so the refutation is written down here rather than rediscovered a
 * third time.
 *
 * It is REACHED by every text claim: nothing between the top of
 * `sniffMimeType` and its use filters those out. `bytes.length === 0` returns
 * first, and `sniffImageType` returns first, but a `.csv` claiming `text/csv`
 * is neither empty nor an image, so it arrives here. The test "recognized
 * claims win outright once no image signature matches" walks that path.
 *
 * It also CHANGES THE ANSWER, which is the half that looks redundant and is
 * not. The tempting reading is that `if (!namesNoFormat(normalizedClaim))
 * return normalizedClaim` below would return `text/plain` for a `text/plain`
 * claim anyway, so this branch merely arrives at the same place early. That
 * is true for bytes that ARE text and false for bytes that are not, and the
 * false case is the whole point: delete this branch and a stripped executable
 * claiming `text/plain` falls through to that line, is returned as
 * `text/plain`, and is stored and served as accepted text from this app's own
 * origin on the client's word alone. With the branch it becomes
 * `application/octet-stream` and is refused. The test "bytes that are not
 * UTF-8 at all, claimed text/plain, are not text" fails the moment this is
 * removed.
 */
const MIME_BY_LOWER_CLAIM = new Set<string>(ACCEPTED_TEXT_MIME);

function hasSignature(
  bytes: Uint8Array,
  signature: number[],
  offset = 0,
): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

function sniffImageType(bytes: Uint8Array): string | null {
  if (hasSignature(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (hasSignature(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasSignature(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (
    hasSignature(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    hasSignature(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

// TextDecoder in "fatal" mode throws on invalid UTF-8 instead of substituting
// U+FFFD, which is what lets the checks below tell "genuinely UTF-8 text"
// apart from "bytes that happen to decode without error but were never text."
// Both callers depend on that: the guess at the end of `sniffMimeType`, and
// the corroboration of a text claim before it.
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8Decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * A file's `type` field is whatever the uploading client said it was, and
 * this app turns around and serves that string back as the `Content-Type`
 * header on its own origin. This function *resolves* that claim rather than
 * trusting it, but how much the bytes can settle differs sharply between the
 * two families of type this app accepts, and it is worth being exact about
 * which is which.
 *
 * For the four ACCEPTED IMAGE types the bytes decide outright. Each one has a
 * magic number in `sniffImageType`, so the bytes name the format, and the
 * claim is only ever a tie-breaker that the bytes can overrule — a JPEG
 * claiming `image/png` comes back `image/jpeg`.
 *
 * For the four ACCEPTED TEXT types the bytes decide much less. There is no
 * signature that distinguishes Markdown from CSV from JSON from prose; every
 * one of them is just UTF-8. So the bytes can only answer whether the file is
 * text AT ALL, never which text format it is, and the format that comes back
 * is the CLIENT'S CLAIM — corroborated by the UTF-8 check, but not verified.
 * A `.csv` uploaded as `text/markdown` is stored and served as Markdown, and
 * nothing here can tell. What the corroboration buys is narrower than
 * verification and still worth having: bytes that are not text cannot wear a
 * text name, so a binary blob can no longer be stored and served as
 * `text/plain` on this origin just by saying so.
 *
 * The corroboration is real content or nothing: a zero-byte file is refused
 * outright, because "these bytes decode as UTF-8" is trivially true of no
 * bytes and would otherwise wave an empty file through as accepted text.
 *
 * A claim that names nothing (blank, or a generic
 * "I don't know what this is" like `application/octet-stream`) is
 * discarded and the bytes are sniffed instead. But a claim that names a
 * specific format — `image/svg+xml`, `text/html` — comes back by name on
 * purpose, even though it is not verified against the bytes, because the
 * caller needs that name to refuse it (an inline SVG is valid UTF-8 text,
 * and laundering it into `text/plain` here would erase the one signal
 * that lets the caller block it). Identifying a format is not the same as
 * authorizing it: the caller MUST run this function's result through
 * `classifyAttachment` before anything is stored or served.
 *
 * The exceptions to "a specific claim comes back by name" are the eight
 * claims naming a type this app ACCEPTS. Naming a format the caller will
 * refuse is harmless; naming one it will store and serve is not, so those
 * eight names have to be earned from the bytes rather than asserted — the
 * four image names in full, from a signature, and the four text names as far
 * as bytes can go, from the UTF-8 check. Those two lists are
 * `ACCEPTED_IMAGE_MIME`, imported from `shared/attachments.ts` because the
 * composer screens against the same one, and `MIME_BY_LOWER_CLAIM`, at the top
 * of this file.
 */
export function sniffMimeType(bytes: Uint8Array, claimed: string): string {
  /*
   * A file with no bytes corroborates nothing, and every accepted answer
   * below is earned from content: an image signature, or bytes that decode
   * as UTF-8. The second of those is trivially true of an empty file —
   * `isValidUtf8(new Uint8Array(0))` is `true` — so without this line an
   * empty upload came back `text/plain` and was stored and served as an
   * accepted text attachment, whether it claimed a text type or claimed
   * nothing at all. Refused once here rather than in each branch, so no
   * later path can hand back an accepted name for a file that isn't there.
   */
  if (bytes.length === 0) return "application/octet-stream";

  const sniffedImage = sniffImageType(bytes);
  if (sniffedImage) return sniffedImage;

  /*
   * `mediaTypeOf`, NOT A LOCAL COPY OF WHAT IT DOES.
   *
   * This line used to be `claimed.toLowerCase().split(";")[0].trim()` —
   * character for character the body of `mediaTypeOf`, and the two stayed in
   * agreement only by coincidence. `shared/attachments.ts` calls that form
   * "THE ONLY FORM ANYTHING HERE COMPARES" and its doc names this function as
   * a caller that "already normalises the same two ways", which was a claim
   * about a duplicate rather than a reference to the original.
   *
   * The cost of the duplicate is the drift the shared file exists to prevent.
   * RFC 2045 also allows quoted parameters and whitespace before the `;`, so
   * if `mediaTypeOf` ever grows a third step the composer would start reading
   * a file one way and this server another — one side taking a file the other
   * turns away, which is exactly the failure the top-of-file note describes.
   *
   * `namesNoFormat` below normalises again internally. That is deliberate
   * redundancy, not waste: it is exported for callers holding a raw claim, so
   * it cannot assume it has been through here first, and the operation is
   * idempotent.
   */
  const normalizedClaim = mediaTypeOf(claimed);

  /*
   * A text claim this app accepts is corroborated the only way text can be:
   * the bytes are asked whether this is text at all, not which text format
   * it is, because no signature tells Markdown from CSV from JSON. So the
   * claim survives the check rather than being replaced by it.
   *
   * Unverified is not the same as untested. Before this check, `text/plain`
   * was returned on the client's word alone, which meant any bytes at all —
   * a stripped executable, an encrypted blob — could be stored and served
   * from this origin under a text name simply by claiming one. Bytes that
   * are not text now fail here.
   *
   * The failure drops to the generic "just bytes" type, which
   * `classifyAttachment` refuses, exactly as the accepted-image branch below
   * does and for the same reason: falling through to the guesses further
   * down would let a refused claim try its luck under a different name.
   */
  if (MIME_BY_LOWER_CLAIM.has(normalizedClaim)) {
    return isValidUtf8(bytes) ? normalizedClaim : "application/octet-stream";
  }

  /*
   * An image claim this app accepts is the one claim the bytes have to
   * corroborate. `sniffImageType` knows a signature for every member of
   * `ACCEPTED_IMAGE_MIME`, so reaching this line with such a claim means
   * the bytes are NOT that image — and returning the name anyway is what
   * let arbitrary bytes (an SVG, most of all) be labelled `image/png` and
   * come back as an accepted image. The SVG refusal in
   * `shared/attachments.ts` is keyed on this function's answer, so a claim
   * that is never checked is a refusal that can be renamed around.
   *
   * The claim is dropped for the generic "just bytes" type, which
   * `classifyAttachment` refuses, rather than falling through to the
   * UTF-8 guess below — an SVG decodes as valid UTF-8, and turning it into
   * `text/plain` would store and serve the very file that was being
   * smuggled, just under a different label.
   *
   * Only the ACCEPTED names are dropped. An image claim this app does not
   * accept (`image/svg+xml`, `image/heic`) still comes back verbatim below,
   * because the caller refuses it by name and that name is what makes the
   * refusal say something useful. The coupling runs one way: adding a type
   * to `ACCEPTED_IMAGE_MIME` without adding its signature to
   * `sniffImageType` refuses every file of that type outright — a loud
   * failure, which is the right direction for this to break in.
   */
  if ((ACCEPTED_IMAGE_MIME as readonly string[]).includes(normalizedClaim)) {
    return "application/octet-stream";
  }

  // A claim shaped like a real MIME type (e.g. "image/svg+xml") names a
  // specific format the caller may need to refuse by name — an inline SVG
  // is valid UTF-8 text, but laundering it into "text/plain" here would
  // erase the one signal ("this claims to be SVG") the caller needs to
  // block it. A claim that names nothing (blank, not shaped like a MIME
  // type, or a generic placeholder such as "application/octet-stream")
  // falls through to content-guessing instead. `namesNoFormat` is that
  // question, and it lives in `shared/attachments.ts` because the composer
  // asks the identical one before it refuses a pick: a list kept twice is a
  // list that drifts, and the drift here is a file one side takes and the
  // other turns away.
  if (!namesNoFormat(normalizedClaim)) {
    return normalizedClaim;
  }

  if (isValidUtf8(bytes)) return "text/plain";

  /*
   * Neither an image signature, a trusted claim, nor guessable UTF-8 text.
   *
   * THE CLAIM IS NOT HANDED BACK HERE, AND THE REASON IS THE LINE ABOVE THIS
   * BLOCK RATHER THAN ANYTHING ABOUT THESE BYTES. The only way to reach this
   * line is for `namesNoFormat` to have already judged the claim to name no
   * format — blank, not shaped like a MIME type, or one of the generic
   * placeholders. Returning it would be returning a non-answer under the
   * pretence that it is a media type.
   *
   * That mattered because this function's answer is read aloud. `attachments.ts`
   * builds `'x.bin' is not a file type this app can read (<answer>).` from it,
   * and a browser that claimed nothing at all made `normalizedClaim` the empty
   * string — so the sentence came out `... can read ().`, a parenthetical that
   * names nothing because there was nothing to name. The generic sentence it
   * was meant to improve on was better than that.
   *
   * `application/octet-stream` is the name this file already uses for "these
   * are just bytes" in three other places (the empty file above, the
   * uncorroborated text claim, the uncorroborated image claim), so the caller
   * sees one name for one situation rather than a different spelling of "I
   * don't know" for each browser — `application/unknown` and
   * `binary/octet-stream` reach here too, and used to produce three different
   * refusals for the same unreadable file.
   *
   * REJECTED: leaving this alone and having `attachments.ts` drop the
   * parenthetical when the string is empty. That puts the repair in the caller
   * and leaves the hole here for the next caller to fall into, and this
   * function's contract is better stated as "always returns a media type" than
   * as "returns a media type, or sometimes not, mind how you print it".
   *
   * A claim that DOES name a format never reaches this line — it returned
   * verbatim above, which is what keeps `image/svg+xml` and `text/html`
   * refusable by name.
   */
  return "application/octet-stream";
}
