import { describe, expect, test } from "bun:test";
import {
  classifyAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_EXTRACTED_CHARACTERS,
  MAX_FILE_BYTES,
  mediaTypeOf,
  namesNoFormat,
  shouldClaimPaste,
} from "./attachments";

describe("classifyAttachment", () => {
  test("names the four accepted image types", () => {
    for (const mimeType of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]) {
      expect(classifyAttachment(mimeType)).toBe("image");
    }
  });

  test("an SVG is not an image we will serve", () => {
    expect(classifyAttachment("image/svg+xml")).toBe("unsupported-image");
  });

  test("a HEIC photo is refused as an image, not as an unknown file", () => {
    expect(classifyAttachment("image/heic")).toBe("unsupported-image");
  });

  test("text-ish files are text", () => {
    expect(classifyAttachment("text/markdown")).toBe("text");
    expect(classifyAttachment("application/json")).toBe("text");
  });

  test("anything else is unsupported", () => {
    expect(classifyAttachment("application/zip")).toBe("unsupported");
  });

  test("a charset parameter does not defeat the match", () => {
    expect(classifyAttachment("text/plain;charset=utf-8")).toBe("text");
    expect(classifyAttachment("application/json;charset=utf-8")).toBe("text");
  });

  test("a parameter with a space and mixed case still matches", () => {
    expect(classifyAttachment("text/plain; charset=UTF-8")).toBe("text");
  });

  test("a trailing space does not misfire as an unsupported image", () => {
    expect(classifyAttachment("image/png ")).toBe("image");
  });
});

describe("shouldClaimPaste", () => {
  test("a spreadsheet cell pastes its text, and does not attach a screenshot of itself", () => {
    // The flavour Chrome really produces for a copied cell: an `image/png` file AND the text. An
    // earlier version of this test used `kinds: ["text"]`, which is a text FILE — a shape Excel
    // never puts on the clipboard — so it passed while the real paste was broken.
    expect(shouldClaimPaste({ kinds: ["image"], plainText: "a\tb" })).toBe(
      false,
    );
  });

  test("a screenshot is claimed, because it arrives with no text at all", () => {
    expect(shouldClaimPaste({ kinds: ["image"], plainText: "" })).toBe(true);
  });

  test("an unsupported image with no text is claimed, so it can be refused out loud", () => {
    expect(
      shouldClaimPaste({ kinds: ["unsupported-image"], plainText: "" }),
    ).toBe(true);
  });

  test("an unsupported file with no text is claimed, so it can be refused out loud", () => {
    // The sibling of the `unsupported-image` case above, and the branch that
    // matters for a pasted `.zip`. Not claiming it would let the paste fall
    // through to the browser's default, which does nothing visible at all —
    // the file would simply not appear, with no reason given.
    expect(shouldClaimPaste({ kinds: ["unsupported"], plainText: "" })).toBe(
      true,
    );
  });

  test("text wins over a plain file too", () => {
    expect(shouldClaimPaste({ kinds: ["text"], plainText: "a\tb" })).toBe(
      false,
    );
  });

  test("a file with no text alongside it is claimed", () => {
    expect(shouldClaimPaste({ kinds: ["text"], plainText: "" })).toBe(true);
  });

  test("an empty clipboard is not claimed", () => {
    expect(shouldClaimPaste({ kinds: [], plainText: "" })).toBe(false);
  });
});

test("the per-message cap is eight", () => {
  expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(8);
});

/**
 * The two text limits, pinned against each other rather than each alone.
 *
 * They bound different things — bytes uploaded versus characters the model
 * reads — and they are far apart, so a text file can be accepted whole and
 * still reach the model as a fraction of itself. That is deliberate and the
 * constants now explain it, but it is the kind of relationship that gets
 * broken by an innocent-looking edit to one number. This is here so the edit
 * lands on a failing test with the reasoning attached, rather than silently
 * changing what a person gets an answer about.
 */
describe("what is uploaded and what the model reads are different limits", () => {
  test("a text file may be accepted far larger than the model will read", () => {
    // If these ever converge, the truncation warning the composer owes the
    // sender stops being needed — and if they invert, `MAX_EXTRACTED_CHARACTERS`
    // stops doing anything at all, since no accepted file could reach it.
    expect(MAX_FILE_BYTES).toBeGreaterThan(MAX_EXTRACTED_CHARACTERS);
  });

  test("a file at the byte ceiling reaches the model as about an eighth of itself", () => {
    // Stated as the ratio rather than as the two numbers, because the ratio is
    // the thing a person would be surprised by. ASCII text, where a byte is a
    // character; anything multi-byte loses proportionally less.
    const readable = MAX_EXTRACTED_CHARACTERS / MAX_FILE_BYTES;
    expect(readable).toBeLessThan(0.125);
    expect(readable).toBeGreaterThan(0.1);
  });

  test("the byte size is a sound one-sided test for whether text will be cut", () => {
    // The predicate the composer can screen with: UTF-8 spends at least one
    // byte per code point, so a file of N bytes never decodes to more than N
    // characters. A file at or under the character ceiling therefore CANNOT be
    // truncated, which is what makes `file.size > MAX_EXTRACTED_CHARACTERS` a
    // warning that never fires on a file that arrives whole.
    const mayBeTruncated = (byteLength: number) =>
      byteLength > MAX_EXTRACTED_CHARACTERS;

    expect(mayBeTruncated(MAX_EXTRACTED_CHARACTERS)).toBe(false);
    expect(mayBeTruncated(MAX_EXTRACTED_CHARACTERS + 1)).toBe(true);
    // The case the gap is about: an accepted upload that will still be cut.
    expect(mayBeTruncated(MAX_FILE_BYTES)).toBe(true);
  });
});

/**
 * The two functions the "the browser told us nothing, so the server gets to
 * look" design rests on, neither of which was tested anywhere in the repo.
 *
 * That is a gap worth closing rather than a style point. `namesNoFormat` is
 * the ONE copy of the list both halves screen against, and its whole reason
 * for living in this file is that the composer and the server drifted apart on
 * it once already: the server threw an unnamed claim away and read the bytes,
 * while the composer refused the same file at pick time on the claim alone.
 * Nothing failed while they disagreed, because nothing asked either of them
 * anything. `mediaTypeOf` is the normalisation every comparison in this file
 * and in `attachment-mime.ts` runs first, so a change to it moves every gate
 * at once.
 */
describe("mediaTypeOf", () => {
  test("a bare media type is handed back unchanged", () => {
    expect(mediaTypeOf("text/plain")).toBe("text/plain");
  });

  test("the charset Bun's File constructor appends is dropped", () => {
    // Not hypothetical: `new File(["x"], "a.txt", { type: "text/plain" })`
    // reports `text/plain;charset=utf-8`, so test fixtures and clipboard
    // entries in this app routinely arrive with a parameter attached.
    expect(mediaTypeOf("text/plain;charset=utf-8")).toBe("text/plain");
    expect(mediaTypeOf("application/json;charset=utf-8")).toBe(
      "application/json",
    );
  });

  test("a space after the semicolon does not survive into the type", () => {
    expect(mediaTypeOf("text/plain; charset=UTF-8")).toBe("text/plain");
  });

  test("case is folded, because RFC 2045 makes the type case-insensitive", () => {
    // A `File` this app never built — one off a drop or a clipboard — carries
    // whatever its source wrote, and `new File(...)` only lower-cases what it
    // is handed itself.
    expect(mediaTypeOf("IMAGE/PNG")).toBe("image/png");
    expect(mediaTypeOf("Text/Markdown")).toBe("text/markdown");
  });

  test("surrounding whitespace is trimmed", () => {
    expect(mediaTypeOf("  image/png  ")).toBe("image/png");
    expect(mediaTypeOf("image/png ")).toBe("image/png");
  });

  test("case, parameter and whitespace are all handled at once", () => {
    // The combination is the realistic one; handling each alone is not enough.
    expect(mediaTypeOf("  TEXT/CSV ; charset=UTF-8 ")).toBe("text/csv");
  });

  test("more than one parameter still leaves just the type", () => {
    expect(mediaTypeOf("text/plain; charset=utf-8; boundary=xyz")).toBe(
      "text/plain",
    );
  });

  test("a blank claim normalises to a blank string, not to a guess", () => {
    // This function normalises; it does not invent. `namesNoFormat` is what
    // turns the blank into a decision.
    expect(mediaTypeOf("")).toBe("");
    expect(mediaTypeOf("   ")).toBe("");
  });
});

describe("namesNoFormat", () => {
  test("every generic placeholder a browser sends names nothing", () => {
    // All four members of MIME_NAMES_NOTHING. Only the first had coverage
    // anywhere in the repo, and this list is precisely what the two sides
    // drifted on, so it is pinned member by member rather than sampled.
    for (const claim of [
      "application/octet-stream",
      "binary/octet-stream",
      "application/unknown",
      "application/force-download",
    ]) {
      expect(namesNoFormat(claim)).toBe(true);
    }
  });

  test("a blank claim names nothing", () => {
    // The commonest case of all: a browser with no mapping for an extension
    // sets `file.type` to the empty string rather than to a placeholder.
    expect(namesNoFormat("")).toBe(true);
  });

  test("anything not shaped like a MIME type names nothing", () => {
    // The `!mediaType.includes("/")` half of the rule, which nothing covered.
    expect(namesNoFormat("garbage")).toBe(true);
    expect(namesNoFormat("text")).toBe(true);
    expect(namesNoFormat("plain-text-please")).toBe(true);
  });

  test("a placeholder still names nothing through case and parameters", () => {
    // The list is matched against the NORMALISED form. Matching the raw claim
    // would let `APPLICATION/OCTET-STREAM` pose as a named format and be
    // refused at pick time — the exact drift this list exists to prevent.
    expect(namesNoFormat("APPLICATION/OCTET-STREAM")).toBe(true);
    expect(namesNoFormat("Application/Octet-Stream; charset=binary")).toBe(
      true,
    );
    expect(namesNoFormat("  binary/octet-stream  ")).toBe(true);
  });

  test("a claim that names a real format names a format", () => {
    for (const claim of [
      "text/plain",
      "text/csv",
      "image/png",
      "image/heic",
      "image/svg+xml",
      "text/html",
      "application/zip",
      "application/pdf",
    ]) {
      expect(namesNoFormat(claim)).toBe(false);
    }
  });

  test("a near-miss of a placeholder is not a placeholder", () => {
    // Set membership on the whole media type, not a prefix or a substring, so
    // a real format whose name merely starts the same way is not swept up.
    expect(namesNoFormat("application/octet-stream-plus")).toBe(false);
    expect(namesNoFormat("application/unknown-format")).toBe(false);
  });
});

/**
 * The pairing that actually decides what happens to an unnamed file.
 *
 * The composer defers to the server only when BOTH are true of a pick:
 * `classifyAttachment` says `unsupported` AND `namesNoFormat` says the claim
 * named nothing (`picked-files.ts`, the `unnamed` branch). Testing the two
 * functions apart would not catch a change that broke the conjunction — if a
 * placeholder ever started classifying as something other than `unsupported`,
 * that branch would stop firing and the round trip that lets the server read
 * the bytes would quietly disappear, with both functions still passing their
 * own tests.
 */
describe("an unnamed claim is unsupported AND unnamed, which is what defers to the server", () => {
  test("each placeholder is refused by kind and excused by name", () => {
    for (const claim of [
      "application/octet-stream",
      "binary/octet-stream",
      "application/unknown",
      "application/force-download",
      "",
    ]) {
      expect(classifyAttachment(claim)).toBe("unsupported");
      expect(namesNoFormat(claim)).toBe(true);
    }
  });

  test("a named refusal is refused by kind and NOT excused by name", () => {
    // The other half of the branch: the two sides already agree about a claim
    // that names a format, so the composer refuses it itself rather than
    // spending a round trip to be told the same thing.
    for (const claim of ["application/zip", "text/html"]) {
      expect(classifyAttachment(claim)).toBe("unsupported");
      expect(namesNoFormat(claim)).toBe(false);
    }
  });
});
