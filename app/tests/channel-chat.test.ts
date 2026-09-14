import type { Attachment } from "@copilotkit/react-core/v2";
import { describe, expect, test } from "bun:test";
import { toMessageContent } from "@/components/channels/channel-chat";
import { attachmentUrl } from "@/lib/channels/attachments";

/**
 * `toMessageContent` is the wire format every attachment message is built from — the contract
 * between the composer and everything downstream: the AG-UI schema, the server's
 * `resolveAttachmentParts`, the transcript projection. It is module-private in `channel-chat.tsx`
 * and exported there only for this test; see the comment above its definition for why a narrow
 * export was the honest call rather than standing up the whole `useAgent` runtime to reach it
 * through `say`/`deliver`.
 *
 * No DOM is registered here: `toMessageContent` is a pure function, and importing the module that
 * defines it does not touch `document`/`window` at import time (only rendering `ChannelChat` itself
 * would), so this file needs none of the `happy-dom` scaffolding a rendering test would.
 */

/** A minimal but complete SDK `Attachment`, overridable per test. */
function attachment(
  overrides: Partial<Attachment> & { id: string },
): Attachment {
  return {
    type: "image",
    source: { type: "url", value: "https://example.test/placeholder" },
    status: "ready",
    metadata: { attachmentId: overrides.id },
    ...overrides,
  };
}

describe("toMessageContent", () => {
  test("text only is sent as a plain string, not a wrapped array", () => {
    const content = toMessageContent("hello there", []);

    // `typeof` rather than `toEqual("hello there")`: the whole point is that this is a string and
    // not a one-element array that happens to stringify the same way in some assertions.
    expect(typeof content).toBe("string");
    expect(content).toBe("hello there");
  });

  test("text plus one image is [text, ref], in that order", () => {
    const image = attachment({
      id: "att_img_1",
      type: "image",
      metadata: { attachmentId: "att_img_1", filename: "photo.png" },
    });

    const content = toMessageContent("check this out", [image]);

    expect(Array.isArray(content)).toBe(true);
    const parts = content as unknown[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "check this out" });
    expect(parts[1]).toEqual({
      type: "image",
      source: { type: "url", value: attachmentUrl("att_img_1") },
      metadata: { attachmentId: "att_img_1", filename: "photo.png" },
    });
  });

  test("one image with no text has no leading empty text part", () => {
    const image = attachment({
      id: "att_img_2",
      type: "image",
      metadata: { attachmentId: "att_img_2" },
    });

    const content = toMessageContent("", [image]);

    expect(Array.isArray(content)).toBe(true);
    const parts = content as unknown[];
    // Just the ref: an empty leading text part would be noise the model has to read past.
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "image",
      source: { type: "url", value: attachmentUrl("att_img_2") },
      metadata: { attachmentId: "att_img_2" },
    });
  });

  test("a document attachment carries type: document", () => {
    const document = attachment({
      id: "att_doc_1",
      type: "document",
      metadata: { attachmentId: "att_doc_1", filename: "report.pdf" },
    });

    const content = toMessageContent("", [document]);

    const parts = content as { type: string }[];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("document");
  });

  /*
   * WHAT IS WRITTEN HERE IS WHAT EVERY LATER RENDER READS, so a modality decided from the browser's
   * claim is wrong for ever rather than until the next reload.
   *
   * `attachment.type` is fixed before the upload and never reconciled with what the file turned out
   * to be. The server already refuses to trust it — `resolvePart` classifies on its own sniffed
   * `mimeType` — but that correction stays on the server and never comes back to the stored message.
   * A screenshot the browser mislabelled therefore drew a grey file card over the picture.
   */
  test("a mislabelled image is stored as an image, because the bytes say so", () => {
    const mislabelled = attachment({
      id: "att_mislabelled",
      // What the browser claimed.
      type: "document",
      // What the server sniffed, which is the only one of the two that saw the bytes.
      source: {
        type: "url",
        value: "https://example.test/placeholder",
        mimeType: "image/png",
      },
      metadata: { attachmentId: "att_mislabelled", filename: "screenshot" },
    });

    const content = toMessageContent("", [mislabelled]);

    const parts = content as { type: string }[];
    expect(parts[0]?.type).toBe("image");
  });

  /*
   * The other direction, which is what keeps the rule honest rather than merely image-favouring: a
   * corroborated text type overrides a browser claim of `image` just as readily.
   */
  test("a mislabelled document is stored as a document, for the same reason", () => {
    const mislabelled = attachment({
      id: "att_doc_sniffed",
      type: "image",
      source: {
        type: "url",
        value: "https://example.test/placeholder",
        mimeType: "text/csv",
      },
      metadata: { attachmentId: "att_doc_sniffed", filename: "rows" },
    });

    const content = toMessageContent("", [mislabelled]);

    const parts = content as { type: string }[];
    expect(parts[0]?.type).toBe("document");
  });

  /*
   * AND WHEN NOTHING CORROBORATED IT, THE CLAIM STANDS. A `data` source's `mimeType` is `file.type`
   * — the same claim, wearing the field name of an answer — so only a `url` source, which has been
   * past the server, is read. An attachment that somehow reaches here unuploaded is written exactly
   * as it always was.
   */
  test("with no corroborated type, the declared one is kept", () => {
    const unsniffed = attachment({
      id: "att_unsniffed",
      type: "document",
      source: { type: "url", value: "https://example.test/placeholder" },
      metadata: { attachmentId: "att_unsniffed" },
    });

    const content = toMessageContent("", [unsniffed]);

    const parts = content as { type: string }[];
    expect(parts[0]?.type).toBe("document");
  });

  test("the ref's id comes from metadata.attachmentId, not attachment.id", () => {
    const image = attachment({
      // The SDK's own client-side upload placeholder — must never reach the wire.
      id: "client-placeholder-xyz",
      type: "image",
      // The id this deployment actually stored the file under.
      metadata: { attachmentId: "server-stored-id-123" },
    });

    const content = toMessageContent("", [image]);

    const [ref] = content as { source: { value: string } }[];
    expect(ref?.source.value).toContain("server-stored-id-123");
    expect(ref?.source.value).not.toContain("client-placeholder-xyz");
  });

  test("the ref's url is built by attachmentUrl, matching /api/attachments/<id> exactly", () => {
    const image = attachment({
      id: "ignored-client-id",
      type: "image",
      metadata: { attachmentId: "att_url_check" },
    });

    const content = toMessageContent("", [image]);

    const [ref] = content as { source: { value: string } }[];
    expect(ref?.source.value).toBe(attachmentUrl("att_url_check"));
    expect(ref?.source.value).toBe("/api/attachments/att_url_check");
  });
});
