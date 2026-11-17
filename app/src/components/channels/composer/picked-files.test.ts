import { describe, expect, test } from "bun:test";
import {
  attachmentLimitsFrom,
  DEFAULT_ATTACHMENT_LIMITS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOCUMENT_BYTES,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from "@/lib/channels/attachments";
import { FILE_PICKER_ACCEPT } from "./attachments";
import { screenPickedFiles } from "./picked-files";

/** A server that publishes nothing: today's 8MB and 1MB. */
const limits = DEFAULT_ATTACHMENT_LIMITS;

function file(name: string, type: string, size = 3): File {
  return new File(["x".repeat(size)], name, { type });
}

/**
 * A `File` that says it is `size` bytes without holding them, so a 100MB pick costs nothing to
 * build. `screenPickedFiles` reads `size` and `type` and never the bytes.
 */
function sized(name: string, type: string, size: number): File {
  const picked = new File(["x"], name, { type });
  Object.defineProperty(picked, "size", { value: size });
  return picked;
}

const MIB = 1024 * 1024;

describe("screenPickedFiles with the limits the server publishes", () => {
  /** What a server that keeps files in an object store answers: 100MB for every kind. */
  const larger = attachmentLimitsFrom({
    imageBytes: 100 * MIB,
    documentBytes: 100 * MIB,
    fileBytes: 100 * MIB,
  });

  test("takes files the defaults refuse, up to the server's number", () => {
    const image = sized("site-photo.png", "image/png", 40 * MIB);
    const pdf = sized("survey.pdf", "application/pdf", 100 * MIB);
    const csv = sized("export.csv", "text/csv", 20 * MIB);

    const result = screenPickedFiles([image, pdf, csv], {
      alreadyStaged: 0,
      limits: larger,
    });

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([image, pdf, csv]);
  });

  test("refuses past the server's number and names it", () => {
    const image = sized("drone.png", "image/png", 100 * MIB + 1);
    const pdf = sized("scan.pdf", "application/pdf", 100 * MIB + 1);
    const text = sized("dump.txt", "text/plain", 100 * MIB + 1);
    const unnamed = sized("blob", "", 100 * MIB + 1);

    const result = screenPickedFiles([image, pdf, text, unnamed], {
      alreadyStaged: 0,
      limits: larger,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((rejection) => rejection.reason)).toEqual([
      "'drone.png' is too large for an image. The limit is 100MB.",
      "'scan.pdf' is too large for a PDF. The limit is 100MB.",
      "'dump.txt' is too large for a text file. The limit is 100MB.",
      "'blob' is too large. The limit is 100MB.",
    ]);
  });

  test("a server that says nothing is held to today's 8MB and 1MB", () => {
    const fromAnOlderServer = attachmentLimitsFrom(undefined);
    const image = sized("photo.png", "image/png", 8 * MIB + 1);
    const text = sized("notes.txt", "text/plain", MIB + 1);

    const result = screenPickedFiles([image, text], {
      alreadyStaged: 0,
      limits: fromAnOlderServer,
    });

    expect(fromAnOlderServer).toEqual(DEFAULT_ATTACHMENT_LIMITS);
    expect(result.rejected.map((rejection) => rejection.reason)).toEqual([
      "'photo.png' is too large for an image. The limit is 8MB.",
      "'notes.txt' is too large for a text file. The limit is 1MB.",
    ]);
  });

  test("a field that is not a positive whole number reads as today's limit", () => {
    expect(
      attachmentLimitsFrom({
        imageBytes: 0,
        documentBytes: "100",
        fileBytes: 1.5,
      }),
    ).toEqual(DEFAULT_ATTACHMENT_LIMITS);
    expect(attachmentLimitsFrom({ imageBytes: 100 * MIB }).documentBytes).toBe(
      MAX_DOCUMENT_BYTES,
    );
  });
});

describe("screenPickedFiles", () => {
  test("accepts a PNG under the ceiling", () => {
    const png = file("photo.png", "image/png");
    const result = screenPickedFiles([png], { alreadyStaged: 0, limits });

    expect(result.accepted).toEqual([png]);
    expect(result.rejected).toEqual([]);
  });

  test("rejects an SVG with a reason naming the script risk", () => {
    const svg = file("logo.svg", "image/svg+xml");
    const result = screenPickedFiles([svg], { alreadyStaged: 0, limits });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/SVG/);
    expect(result.rejected[0].name).toBe("logo.svg");
  });

  /**
   * The wording used to compare `file.type` raw while `classifyAttachment` — and the server, and
   * the SDK's accept check — all normalise first. An SVG off a clipboard arrives as
   * `image/svg+xml;charset=utf-8`, so it was still refused, but with the generic "an image format
   * that is not supported" instead of the one sentence that says WHY this one in particular:
   * an SVG can carry script. The person is left thinking their editor exported the wrong format.
   */
  test("keeps the script-risk wording for an SVG whose type carries a charset", () => {
    const svg = file("logo.svg", "image/svg+xml;charset=utf-8");
    const result = screenPickedFiles([svg], { alreadyStaged: 0, limits });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/SVG/);
  });

  test("keeps the script-risk wording for an SVG whose type differs only in case", () => {
    const svg = file("logo.svg", "image/png");
    Object.defineProperty(svg, "type", { value: "IMAGE/SVG+XML" });
    const result = screenPickedFiles([svg], { alreadyStaged: 0, limits });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/SVG/);
  });

  test("rejects an oversized text file with a reason naming the size problem", () => {
    const big = file("notes.md", "text/plain", MAX_FILE_BYTES + 1);
    const result = screenPickedFiles([big], { alreadyStaged: 0, limits });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/too large/);
  });

  /**
   * The Northwind story's invoice beat: a PDF invoice was refused at pick time with "isn't a file
   * type you can attach", so the Bot never saw it. A PDF is staged like any other file, and the
   * file dialog offers it.
   */
  test("accepts a PDF invoice, and the file dialog offers PDFs", () => {
    const invoice = file("invoice-NW-4471.pdf", "application/pdf", 200_000);
    const result = screenPickedFiles([invoice], { alreadyStaged: 0, limits });

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([invoice]);
    expect(FILE_PICKER_ACCEPT.split(",")).toContain("application/pdf");
    expect(FILE_PICKER_ACCEPT.split(",")).toContain(".pdf");
  });

  test("rejects a PDF over its limit, naming the limit", () => {
    const big = file("scan.pdf", "application/pdf", MAX_DOCUMENT_BYTES + 1);
    const result = screenPickedFiles([big], { alreadyStaged: 0, limits });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe(
      "'scan.pdf' is too large for a PDF. The limit is 8MB.",
    );
  });

  test("rejects an oversized image", () => {
    const big = file("huge.png", "image/png", MAX_IMAGE_BYTES + 1);
    const result = screenPickedFiles([big], { alreadyStaged: 0, limits });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/too large/);
  });

  /**
   * THE CLIENT MUST NOT REFUSE WHAT THE SERVER ACCEPTS, AND IT DID.
   *
   * A browser reports `""` or `application/octet-stream` for a file it has no mapping for — a
   * `.txt` dragged out of an editor, anything with an unfamiliar extension. `sniffMimeType`
   * discards exactly those claims and reads the bytes instead, so the server takes such a file and
   * stores it as `text/plain`. Screening on the claim alone refused it here first, and the person
   * was told their plain text file "is not a file type this chat accepts" by the half of the
   * system that had not looked at it.
   */
  test("lets a file the browser could not name through for the server to sniff", () => {
    const unnamed = file("notes.txt", "");
    const generic = file("notes.txt", "application/octet-stream");

    const result = screenPickedFiles([unnamed, generic], {
      alreadyStaged: 0,
      limits,
    });

    expect(result.accepted).toEqual([unnamed, generic]);
    expect(result.rejected).toEqual([]);
  });

  /**
   * The loose ceiling, not the tight one, for the same reason: the client does not yet know which
   * of the two limits applies, and guessing the tight one would put back a refusal the server would
   * not have made. The server has the bytes and applies the right limit on arrival.
   */
  test("still holds a file the browser could not name to the larger ceiling", () => {
    const huge = file("notes.txt", "", MAX_IMAGE_BYTES + 1);
    const result = screenPickedFiles([huge], { alreadyStaged: 0, limits });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/too large|larger than/);
  });

  test("a claim that names a format it does not accept is still refused here", () => {
    // The fall-through is only for claims that name NOTHING. `application/zip` names a format, and
    // `sniffMimeType` hands that name straight back for the server to refuse by name, so refusing
    // it at pick time is the two halves agreeing rather than disagreeing.
    const zip = file("archive.zip", "application/zip");
    const result = screenPickedFiles([zip], { alreadyStaged: 0, limits });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  test("rejects an unsupported file type with a reason distinct from the SVG one", () => {
    const zip = file("archive.zip", "application/zip");
    const result = screenPickedFiles([zip], { alreadyStaged: 0, limits });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).not.toMatch(/SVG/);
  });

  test("reports one rejection per bad file, each naming its own file", () => {
    const svg = file("a.svg", "image/svg+xml");
    const zip = file("b.zip", "application/zip");
    const result = screenPickedFiles([svg, zip], { alreadyStaged: 0, limits });

    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0].name).toBe("a.svg");
    expect(result.rejected[1].name).toBe("b.zip");
  });

  test("counts the cap after kind and size, against already-staged files", () => {
    const first = file("one.png", "image/png");
    const second = file("two.png", "image/png");
    const result = screenPickedFiles([first, second], {
      alreadyStaged: MAX_ATTACHMENTS_PER_MESSAGE - 1,
      limits,
    });

    expect(result.accepted).toEqual([first]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].name).toBe("two.png");
    expect(result.rejected[0].reason).toMatch(
      new RegExp(String(MAX_ATTACHMENTS_PER_MESSAGE)),
    );
  });

  /**
   * THE ORDERING THE DOCSTRING NAMES, WHICH THE TEST ABOVE CANNOT SEE.
   *
   * "Counts the cap after kind and size" was pinned with two acceptable PNGs, so no file in it ever
   * failed kind or size AND the cap — the two orderings produce identical output for that input, and
   * hoisting the cap check to the top of the loop left the whole suite green.
   *
   * The observable difference is WHICH SENTENCE the person is given, and it only appears for a file
   * that would fail both. A full composer and one SVG: judged in the documented order it is refused
   * for being an SVG, which tells somebody what to do about it. Judged cap-first it is refused for a
   * limit that had nothing to do with why it was never going to be accepted — and re-sending with
   * fewer files would not help, because the SVG is still an SVG.
   *
   * The other half of the docstring — that a refused file must never eat a slot — is true under
   * either ordering, because the cap counts `accepted.length`. That is exactly why the reason half
   * is the one that needs a test.
   */
  test("a file that fails kind is refused for its kind, not for the cap", () => {
    const svg = file("logo.svg", "image/svg+xml");
    const result = screenPickedFiles([svg], {
      alreadyStaged: MAX_ATTACHMENTS_PER_MESSAGE,
      limits,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/SVG/);
    expect(result.rejected[0].reason).not.toMatch(/at most/);
  });

  /** The same, for the size ceiling: an oversized image is too large, not one file too many. */
  test("a file that fails size is refused for its size, not for the cap", () => {
    const huge = file("huge.png", "image/png", MAX_IMAGE_BYTES + 1);
    const result = screenPickedFiles([huge], {
      alreadyStaged: MAX_ATTACHMENTS_PER_MESSAGE,
      limits,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/too large for an image/);
    expect(result.rejected[0].reason).not.toMatch(/at most/);
  });

  test("keeps accepted files in input order when good and bad are interleaved", () => {
    const good1 = file("good1.png", "image/png");
    const bad = file("bad.svg", "image/svg+xml");
    const good2 = file("good2.md", "text/plain");

    const result = screenPickedFiles([good1, bad, good2], {
      alreadyStaged: 0,
      limits,
    });

    expect(result.accepted).toEqual([good1, good2]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].name).toBe("bad.svg");
  });
});
