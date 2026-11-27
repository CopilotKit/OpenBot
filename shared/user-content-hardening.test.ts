import { describe, expect, test } from "bun:test";
import { userContent } from "./user-content";

const png = Buffer.from([137, 80, 78, 71]).toString("base64");

/**
 * The mime type reaches a `data:` URL sent to model providers. It is allowlisted, and the bytes
 * are shape-checked. `text/html`, an empty value, and padding with no data degrade to a named
 * part. Whitespace inside an otherwise valid payload is stripped before the URL is built.
 */
describe("userContent image hardening", () => {
  test("passes an allowlisted png through", () => {
    expect(
      userContent([
        {
          type: "image",
          source: { type: "data", value: png, mimeType: "image/png" },
        },
      ]),
    ).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
    ]);
  });

  test.each([["text/html"], ["application/javascript"], ["text/plain"]])(
    "names a %s attachment instead of sending it",
    (mimeType) => {
      expect(
        userContent([
          {
            type: "image",
            source: { type: "data", value: png, mimeType },
          },
        ]),
      ).toEqual([{ type: "text", text: "[image]" }]);
    },
  );

  test("names an empty value instead of sending it", () => {
    expect(
      userContent([
        {
          type: "image",
          source: { type: "data", value: "   ", mimeType: "image/png" },
        },
      ]),
    ).toEqual([{ type: "text", text: "[image]" }]);
  });

  test("strips whitespace out of an otherwise valid data URL", () => {
    const wrapped = "iVBORw0K\r\nGg==";
    expect(
      userContent([
        {
          type: "image",
          source: { type: "data", value: wrapped, mimeType: "image/png" },
        },
      ]),
    ).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGg==" },
      },
    ]);
  });

  test.each([["="], ["=="], [" \n==\n "]])(
    "names a padding-only value %j instead of sending it",
    (value) => {
      expect(
        userContent([
          {
            type: "image",
            source: { type: "data", value, mimeType: "image/png" },
          },
        ]),
      ).toEqual([{ type: "text", text: "[image]" }]);
    },
  );

  test("normalises a padded, upper-case mime type", () => {
    expect(
      userContent([
        {
          type: "image",
          source: { type: "data", value: png, mimeType: "  IMAGE/JPEG  " },
        },
      ]),
    ).toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${png}` },
      },
    ]);
  });
});
