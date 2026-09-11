import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attachmentsConfigFor,
  FILE_PICKER_ACCEPT,
  uploadToChannel,
} from "@/components/channels/composer/attachments";
import { MAX_IMAGE_BYTES } from "@/lib/channels/attachments";

/**
 * `uploadToChannel` is the SDK's `onUpload`, called with a raw `File`; `attachmentsConfigFor`
 * assembles the whole `AttachmentsConfig` around it. Both are exercised here against a stubbed
 * `global.fetch` rather than a real server, matching `agent-roster-error.test.tsx`'s pattern for
 * the one other file in this app that stubs `fetch` directly.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function file(name: string, mimeType: string): File {
  return new File(["stub bytes"], name, { type: mimeType });
}

describe("uploadToChannel", () => {
  let requests: { path: string; init: RequestInit }[];

  beforeEach(() => {
    requests = [];
  });

  test("a successful upload returns a url source pointing at our endpoint, with metadata", async () => {
    global.fetch = (async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      return jsonResponse(
        { id: "att_1", name: "receipt.png", mimeType: "image/png" },
        201,
      );
    }) as typeof fetch;

    const result = await uploadToChannel(
      "chan_1",
      "group_1",
    )(file("receipt.png", "image/png"));

    expect(requests).toHaveLength(1);
    const [sent] = requests;
    const body = sent?.init.body;

    expect(sent?.path).toBe("/api/channels/chan_1/attachments");
    expect(sent?.init.method).toBe("POST");
    expect(sent?.init.credentials).toBe("include");
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("file")).toBeInstanceOf(File);
    // The composer's own upload group rides with every upload, which is what makes the server's
    // per-message cap count the same rows this composer can see. It arrived here as `undefined`
    // for as long as these tests called `uploadToChannel` with the arity it had before the group
    // existed, so the field went out as the string "undefined" and nothing said so.
    expect((body as FormData).get("uploadGroup")).toBe("group_1");

    expect(result).toEqual({
      type: "url",
      value: "/api/attachments/att_1",
      mimeType: "image/png",
      metadata: { attachmentId: "att_1", filename: "receipt.png" },
    });
  });

  test("a 415 refusal throws the server's reason, not a generic string", async () => {
    global.fetch = (async () =>
      jsonResponse(
        {
          error:
            "'icon.svg' is an SVG, which can carry scripts and is not accepted.",
        },
        415,
      )) as unknown as typeof fetch;

    await expect(
      uploadToChannel("chan_1", "group_1")(file("icon.svg", "image/svg+xml")),
    ).rejects.toThrow(/SVG/);
  });

  test("a non-JSON error body throws a named fallback, not a JSON parse error", async () => {
    global.fetch = (async () =>
      new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;

    await expect(
      uploadToChannel("chan_1", "group_1")(file("receipt.png", "image/png")),
    ).rejects.toThrow(/receipt\.png/);
    await expect(
      uploadToChannel("chan_1", "group_1")(file("receipt.png", "image/png")),
    ).rejects.not.toThrow(/JSON/);
  });

  test("a JSON error body with no `error` key throws the named fallback, not an empty message", async () => {
    global.fetch = (async () =>
      jsonResponse({}, 500)) as unknown as typeof fetch;

    await expect(
      uploadToChannel("chan_1", "group_1")(file("receipt.png", "image/png")),
    ).rejects.toThrow('Could not upload "receipt.png".');
  });

  test("a refusal whose `error` is empty throws the named fallback, not an empty refusal", async () => {
    // `??` only steps in for `null` and `undefined`, so an `error` of `""` was preferred over the
    // fallback and reached the strip as a file refused with no reason beside it at all.
    global.fetch = (async () =>
      jsonResponse({ error: "   " }, 415)) as unknown as typeof fetch;

    await expect(
      uploadToChannel("chan_1", "group_1")(file("receipt.png", "image/png")),
    ).rejects.toThrow('Could not upload "receipt.png".');
  });

  test("a refusal whose `error` is not a string throws the named fallback", async () => {
    global.fetch = (async () =>
      jsonResponse({ error: 415 }, 415)) as unknown as typeof fetch;

    await expect(
      uploadToChannel("chan_1", "group_1")(file("receipt.png", "image/png")),
    ).rejects.toThrow('Could not upload "receipt.png".');
  });

  /**
   * THE SUCCESS BODY WAS THE ONE ANSWER NOBODY CHECKED.
   *
   * The failure path directly above it has been careful since `2f1d68b` — parse, fall back, never
   * show a parse error as a refusal. The success path went straight to `as UploadedAttachment` and
   * trusted whatever came back, so the two halves of the same response were held to opposite
   * standards. A 200 from a proxy, or any handler that answers before the JSON is written, lands
   * here.
   */
  test("a 2xx body that is not JSON throws the named fallback, not a parse error", async () => {
    global.fetch = (async () =>
      new Response("<html>OK</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    const upload = uploadToChannel("chan_1", "group_1");
    await expect(upload(file("receipt.png", "image/png"))).rejects.toThrow(
      'Could not upload "receipt.png".',
    );
    await expect(upload(file("receipt.png", "image/png"))).rejects.not.toThrow(
      /JSON/,
    );
  });

  test("a 2xx body with no id is refused rather than made into a chip pointing at nothing", async () => {
    // Unchecked, `attachmentUrl(uploaded.id)` produced "/api/attachments/undefined": a tile on the
    // strip, a Send button that unlocks, and a message that carries a link to no attachment.
    global.fetch = (async () =>
      jsonResponse(
        { name: "receipt.png", mimeType: "image/png" },
        201,
      )) as unknown as typeof fetch;

    await expect(
      uploadToChannel("chan_1", "group_1")(file("receipt.png", "image/png")),
    ).rejects.toThrow('Could not upload "receipt.png".');
  });
});

describe("attachmentsConfigFor", () => {
  test("maxSize is MAX_IMAGE_BYTES", () => {
    const config = attachmentsConfigFor(
      "chan_1",
      "group_1",
      () => {},
      () => {},
    );
    expect(config.maxSize).toBe(MAX_IMAGE_BYTES);
  });

  /**
   * THE SDK'S `accept` REFUSES NOTHING, ON PURPOSE, AND THAT IS THE CONTRACT NOW.
   *
   * This used to assert the config carried the eight media types. It did, and that was the defect:
   * `processFiles` applies `accept` with an exact `file.type === filter`, so it stood behind
   * `screenPickedFiles` as a second, stricter, machine-worded gate and refused the very files that
   * screen deliberately passes — a claim naming no format, which the server is supposed to sniff.
   * See `attachmentsConfigFor` for the full argument, and `composer-unnamed-mime.test.tsx` for the
   * end-to-end proof, which is the level this could only ever have been caught at.
   */
  test("accept refuses nothing, leaving screenPickedFiles the only client gate", () => {
    const config = attachmentsConfigFor(
      "chan_1",
      "group_1",
      () => {},
      () => {},
    );

    expect(config.accept).toBe("*/*");
  });

  /**
   * The narrow list still exists; it has moved to the one place it is honest — the `+` button's
   * file dialog, which greys files out rather than refusing them. SVG stays off it for the reason
   * `ACCEPTED_IMAGE_MIME` states: an SVG served inline from this origin is stored XSS.
   */
  test("the file dialog offers the accepted types and their extensions, never SVG", () => {
    const offered = FILE_PICKER_ACCEPT.split(",");

    expect(offered).toContain("image/png");
    expect(offered).toContain("text/markdown");
    expect(offered).not.toContain("image/svg+xml");
    expect(offered).not.toContain(".svg");
    // The extensions are the half that makes the dialog agree with the screen: a `.txt` dragged out
    // of an editor is claimed as `application/octet-stream`, so a MIME-only list greys out exactly
    // the files `screenPickedFiles` goes to some trouble to accept.
    expect(offered).toContain(".txt");
    expect(offered).toContain(".md");
  });
});
