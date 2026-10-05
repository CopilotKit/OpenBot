import { describe, expect, test } from "bun:test";
import { classifyAttachment, namesNoFormat } from "../../shared/attachments";
import { sniffMimeType } from "../src/channels/attachment-mime";

/**
 * `claimed` here is `file.type` from the uploading client — a value this
 * server later serves back as the `Content-Type` header on its own origin.
 * These tests exist to pin down that the byte signature wins over that
 * claim, not the other way around.
 */
describe("sniffing a file's real MIME type from its bytes", () => {
  test("recognizes a PNG signature", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(sniffMimeType(bytes, "application/octet-stream")).toBe("image/png");
  });

  test("recognizes a JPEG signature", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffMimeType(bytes, "application/octet-stream")).toBe("image/jpeg");
  });

  test("recognizes a GIF signature", () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(sniffMimeType(bytes, "application/octet-stream")).toBe("image/gif");
  });

  test("recognizes a WEBP signature (RIFF at 0, WEBP at 8)", () => {
    const bytes = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x00,
      0x00,
      0x00,
      0x00, // chunk size, irrelevant here
      0x57,
      0x45,
      0x42,
      0x50, // "WEBP"
    ]);
    expect(sniffMimeType(bytes, "application/octet-stream")).toBe("image/webp");
  });

  test("a PNG claiming to be text/plain still sniffs as image/png", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(sniffMimeType(bytes, "text/plain")).toBe("image/png");
  });

  test("an SVG body claiming image/svg+xml is returned by that name", () => {
    // "<svg/>" decodes as perfectly valid UTF-8, so if the claimed-MIME
    // branch didn't win first this would fall through to "text/plain" —
    // and the caller's SVG denylist could never see it to refuse it.
    const bytes = new TextEncoder().encode("<svg/>");
    expect(sniffMimeType(bytes, "image/svg+xml")).toBe("image/svg+xml");
  });

  test("plain text with no recognized claim sniffs as text/plain", () => {
    const bytes = new TextEncoder().encode("just some notes");
    expect(sniffMimeType(bytes, "")).toBe("text/plain");
  });

  test("binary junk with an unknown claim returns the claim", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02, 0xc0]);
    expect(sniffMimeType(bytes, "application/x-widget")).toBe(
      "application/x-widget",
    );
  });

  test("recognized claims win outright once no image signature matches", () => {
    const bytes = new TextEncoder().encode('{"ok":true}');
    expect(sniffMimeType(bytes, "application/json; charset=utf-8")).toBe(
      "application/json",
    );
  });

  test("a .txt claiming application/octet-stream sniffs as text/plain", () => {
    // "application/octet-stream" names nothing — it's what a browser sends
    // for a file it has no idea about — so it must not be preserved over
    // the byte sniff the way a specific claim like "image/svg+xml" is.
    const bytes = new TextEncoder().encode("just some notes");
    expect(sniffMimeType(bytes, "application/octet-stream")).toBe("text/plain");
  });

  test("a text/html claim is returned by that name, on purpose", () => {
    // "text/html" names a specific format, so it comes back verbatim just
    // like "image/svg+xml" does — refusing it is classifyAttachment's job
    // downstream, not sniffMimeType's.
    const bytes = new TextEncoder().encode("<script>alert(1)</script>");
    expect(sniffMimeType(bytes, "text/html")).toBe("text/html");
  });

  test("bytes that are no known image, claimed image/png, are not image/png", () => {
    // The claim names a type this app accepts, and nothing in these bytes
    // agrees with it. Handing the name back would let any bytes at all be
    // stored and served as an accepted image on this app's own origin.
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xc0, 0xff, 0xfe]);
    const sniffed = sniffMimeType(bytes, "image/png");
    expect(sniffed).not.toBe("image/png");
    expect(classifyAttachment(sniffed)).not.toBe("image");
  });

  test("an SVG body claiming image/png is not accepted as anything", () => {
    // The exact laundering the SVG refusal exists to stop: relabel the SVG
    // and the caller's denylist never sees the name it refuses by. It must
    // not come back as an image, and it must not fall through to
    // "text/plain" either — that would still store and serve it.
    const bytes = new TextEncoder().encode(
      "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    );
    const sniffed = sniffMimeType(bytes, "image/png");
    expect(sniffed).not.toBe("image/png");
    const kind = classifyAttachment(sniffed);
    expect(kind).not.toBe("image");
    expect(kind).not.toBe("text");
  });

  test("a JPEG claiming image/png comes back as what the bytes say", () => {
    // Corroboration is per-format, not per-claim: the bytes decide which
    // image it is, and a wrong-but-honest claim does not make it unreadable.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffMimeType(bytes, "image/png")).toBe("image/jpeg");
  });

  test("a real PNG claiming image/png is still image/png", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(sniffMimeType(bytes, "image/png")).toBe("image/png");
  });

  test("an image claim this app does not accept still comes back by name", () => {
    // "image/heic" is not corroborated either, but it is refused by name
    // downstream, and that name is what makes the refusal say "this app
    // cannot read HEIC" instead of "unsupported file".
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74]);
    expect(sniffMimeType(bytes, "image/heic")).toBe("image/heic");
    expect(classifyAttachment("image/heic")).toBe("unsupported-image");
  });
});

/**
 * The text half of the same rule the image tests above pin down.
 *
 * A text claim is corroborated, not verified: the bytes can only say whether
 * the file is text AT ALL, never which of the four text formats it is. That is
 * still worth doing — it is the difference between "the client said `text/plain`
 * so it is" and "the client said `text/plain` and the bytes are at least text."
 *
 * The PNG guard for the other half is `a real PNG claiming image/png is still
 * image/png` above; these two are the text-side pair.
 */
describe("a text claim has to be corroborated by the bytes", () => {
  test("bytes that are not UTF-8 at all, claimed text/plain, are not text", () => {
    // 0xC0 0xC0 is an overlong-prefix pair no UTF-8 decoder accepts, and 0xFF
    // never appears in UTF-8 at any position. Nothing here is text, so the
    // claim has nothing to stand on.
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xc0, 0xc0]);
    const sniffed = sniffMimeType(bytes, "text/plain");
    expect(sniffed).not.toBe("text/plain");
    expect(classifyAttachment(sniffed)).not.toBe("text");
  });

  test("a zero-byte file claiming text/plain is not accepted as anything", () => {
    // `isValidUtf8` is trivially true for no bytes, so an empty file used to
    // walk straight through the claim branch. Nothing corroborates a claim
    // about a file that has no contents to corroborate it with.
    const sniffed = sniffMimeType(new Uint8Array(0), "text/plain");
    const kind = classifyAttachment(sniffed);
    expect(kind).not.toBe("text");
    expect(kind).not.toBe("image");
  });

  test("a zero-byte file with no claim at all is not accepted either", () => {
    // The other way into the same hole: with a blank claim the function falls
    // through to the UTF-8 guess, which an empty file also passes trivially.
    const sniffed = sniffMimeType(new Uint8Array(0), "");
    const kind = classifyAttachment(sniffed);
    expect(kind).not.toBe("text");
    expect(kind).not.toBe("image");
  });

  test("real UTF-8 text claiming text/plain is still text/plain", () => {
    // The guard on the change above: corroboration must not cost the ordinary
    // case anything. A .txt file full of text is exactly what this path is for.
    const bytes = new TextEncoder().encode("just some notes\n");
    expect(sniffMimeType(bytes, "text/plain")).toBe("text/plain");
    expect(classifyAttachment("text/plain")).toBe("text");
  });
});

/**
 * THIS FUNCTION'S ANSWER IS READ ALOUD, SO IT HAS TO BE A NAME.
 *
 * `attachments.ts` puts the returned string into a refusal a person reads:
 * `'x.bin' is not a file type this app can read (<answer>).` A blank answer
 * renders that sentence with a hole in it — `... can read ().` — and the
 * parenthetical names nothing because there was nothing to name.
 *
 * Every path out of `sniffMimeType` must therefore hand back a media type,
 * never the empty string and never a fragment that is not one. The claim is
 * not a safe thing to echo at that point: the only way to REACH the last
 * line is for `namesNoFormat` to have already said the claim names no
 * format, so echoing it is echoing a non-answer by construction.
 */
describe("the answer is always a media type, because a person reads it", () => {
  test("binary bytes with a blank claim do not come back blank", () => {
    // No image signature, not valid UTF-8, and nothing claimed: the case a
    // `.bin` dragged out of a folder by a browser that would not guess hits.
    // 0xFF never appears in UTF-8 at any position, and 0xFF 0x00 is not the
    // JPEG signature (which needs 0xFF 0xD8 0xFF).
    const bytes = new Uint8Array([0xff, 0x00, 0x01, 0xc0]);
    const sniffed = sniffMimeType(bytes, "");
    expect(sniffed).not.toBe("");
    expect(sniffed).toBe("application/octet-stream");
  });

  test("what comes back is a name the refusal knows to say nothing about", () => {
    // WHAT THIS PINS, AND WHY IT NO LONGER PINS A SENTENCE. This test used to
    // build the refusal here with a template literal and assert it equalled
    // the same string spelled out — which could only ever fail if
    // `sniffMimeType` changed, and which claimed in its comment to be "the
    // exact string `attachments.ts` builds". That claim is false: the route
    // asks `describeType`, which suppresses the parenthetical for any type
    // `namesNoFormat` recognises, so the real sentence has no parenthetical
    // at all. A test asserting a sentence the product does not produce is
    // worse than no test, and the sentence itself is pinned where it is
    // actually built, in `attachment-routes.test.ts`.
    //
    // The contract that belongs at THIS layer is the handshake between the
    // two files: the sniffer promises never to return a claim that names
    // nothing, and to return one the shared list recognises, which is exactly
    // what lets the route decide to stay quiet. Both halves are asserted.
    const bytes = new Uint8Array([0xff, 0x00, 0x01, 0xc0]);
    const sniffed = sniffMimeType(bytes, "");
    expect(classifyAttachment(sniffed)).toBe("unsupported");
    expect(namesNoFormat(sniffed)).toBe(true);
  });

  test("a claim that is not shaped like a MIME type is not echoed back", () => {
    // `namesNoFormat` throws this away for having no slash, so by the time
    // the last line is reached the claim has already been judged to name
    // nothing. Handing "garbage" to the caller would put that word in the
    // refusal as though it were a format.
    const bytes = new Uint8Array([0xff, 0x00, 0x01, 0xc0]);
    expect(sniffMimeType(bytes, "garbage")).toBe("application/octet-stream");
  });

  test("a generic placeholder claim is normalised to the one generic name", () => {
    // `application/unknown` is in `MIME_NAMES_NOTHING` for the same reason
    // `application/octet-stream` is. Two spellings of "I don't know" should
    // not produce two different refusals for the same file.
    const bytes = new Uint8Array([0xff, 0x00, 0x01, 0xc0]);
    expect(sniffMimeType(bytes, "application/unknown")).toBe(
      "application/octet-stream",
    );
  });

  test("a claim that DOES name a format is still echoed back", () => {
    // The guard on the change above. Naming a format the caller will refuse
    // is the whole reason `image/svg+xml` and `text/html` survive this
    // function, and collapsing them into the generic name would erase the
    // signal the caller refuses by.
    const bytes = new Uint8Array([0xff, 0x00, 0x01, 0xc0]);
    expect(sniffMimeType(bytes, "application/x-widget")).toBe(
      "application/x-widget",
    );
  });
});

/**
 * The claim is normalised by `mediaTypeOf` and by nothing else.
 *
 * These do not fail against the inline copy this function used to carry —
 * that copy was `mediaTypeOf`'s body character for character, so there was no
 * behaviour to change and no red to watch. They are here to make the shared
 * normalisation load-bearing rather than coincidental: if `mediaTypeOf` grows
 * a step (RFC 2045 permits quoted parameters and space before the `;`) these
 * follow it, and a future inline copy that did not would fail them.
 */
describe("the claim goes through the shared normalisation", () => {
  test("an upper-case claim matches an accepted text type", () => {
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    expect(sniffMimeType(bytes, "TEXT/CSV")).toBe("text/csv");
  });

  test("case and parameter are stripped together, not one or the other", () => {
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    expect(sniffMimeType(bytes, "Text/CSV; charset=UTF-8")).toBe("text/csv");
  });

  test("an upper-case accepted image claim is still dropped, not returned", () => {
    // The corroboration branch is keyed on the normalised form too. A claim
    // of "IMAGE/PNG" over bytes that are not a PNG must not slip past the
    // drop by virtue of its spelling.
    const bytes = new Uint8Array([0xff, 0x00, 0x01, 0xc0]);
    expect(sniffMimeType(bytes, "IMAGE/PNG")).toBe("application/octet-stream");
  });

  test("an upper-case placeholder claim still names nothing", () => {
    const bytes = new TextEncoder().encode("just some notes");
    expect(sniffMimeType(bytes, "Application/Octet-Stream")).toBe("text/plain");
  });
});
