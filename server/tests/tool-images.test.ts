import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { MAX_IMAGE_BYTES } from "@openbot/shared/attachments";
import { inlineToolImages, toolImageLinks } from "../src/tool-images";
import { markUntrusted } from "../src/untrusted-content";

/** Gmail's attachment, as Composio answers it and OpenBot hands it to the model. */
function attachmentResult(url: string, mimetype = "image/jpeg"): string {
  return markUntrusted(
    JSON.stringify(
      { file: { name: "mug.jpg", mimetype, s3url: url } },
      null,
      2,
    ),
    "Gmail",
  );
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A fetch that records what it was asked for and answers `body`. */
function fakeFetch(body: Uint8Array<ArrayBuffer> = PNG) {
  const asked: string[] = [];
  const impl = (async (input: URL | string) => {
    asked.push(String(input));
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { asked, impl };
}

function history(...results: string[]): Message[] {
  return [
    { id: "u1", role: "user", content: "Handle the claim" },
    ...results.flatMap((content, at) => [
      {
        id: `a${at}`,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: `call_${at}`,
            type: "function",
            function: { name: "GMAIL_GET_ATTACHMENT", arguments: "{}" },
          },
        ],
      },
      { id: `t${at}`, role: "tool", toolCallId: `call_${at}`, content },
    ]),
  ] as Message[];
}

type Part = {
  type: string;
  text?: string;
  source?: { type: string; value: string; mimeType: string };
};

test("an image link in a tool result is found, a non-image one is not", () => {
  expect(
    toolImageLinks(attachmentResult("https://bucket.s3.amazonaws.com/a.jpg")),
  ).toEqual([
    {
      url: "https://bucket.s3.amazonaws.com/a.jpg",
      mimeType: "image/jpeg",
      name: "mug.jpg",
    },
  ]);
  expect(
    toolImageLinks(
      attachmentResult(
        "https://bucket.s3.amazonaws.com/a.pdf",
        "application/pdf",
      ),
    ),
  ).toEqual([]);
});

test("the image is added straight after the tool result as a picture, typed by its bytes", async () => {
  const { impl } = fakeFetch();
  const out = await inlineToolImages(
    history(attachmentResult("https://bucket.s3.amazonaws.com/b.jpg")),
    impl,
  );
  expect(out.map((message) => message.id)).toEqual([
    "u1",
    "a0",
    "t0",
    "t0-images",
  ]);
  expect(out[3]?.role).toBe("user");
  const parts = out[3]?.content as Part[];
  expect(parts[0]?.text).toContain("returned by tool call call_0");
  // The tool said jpeg; the bytes are a png, and the provider is told what the bytes are.
  expect(parts[1]).toEqual({
    type: "image",
    source: {
      type: "data",
      value: Buffer.from(PNG).toString("base64"),
      mimeType: "image/png",
    },
  });
});

test("a link to a private address, or over http, is never fetched, and says so", async () => {
  for (const url of [
    "https://127.0.0.1/secret.png",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/a.png",
    "http://bucket.s3.amazonaws.com/a.png",
  ]) {
    const { asked, impl } = fakeFetch();
    const out = await inlineToolImages(
      history(attachmentResult(url, "image/png")),
      impl,
    );
    expect(asked).toEqual([]);
    const parts = out[3]?.content as Part[];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).toContain("could not be loaded");
  }
});

test("a download that is not an image, or is too large, is not put in front of the model", async () => {
  const notImage = fakeFetch(new TextEncoder().encode("<html>expired</html>"));
  const tooLarge = fakeFetch(new Uint8Array(MAX_IMAGE_BYTES + 1));
  for (const [url, impl] of [
    ["https://bucket.s3.amazonaws.com/html.png", notImage.impl],
    ["https://bucket.s3.amazonaws.com/huge.png", tooLarge.impl],
  ] as const) {
    const out = await inlineToolImages(
      history(attachmentResult(url, "image/png")),
      impl,
    );
    const parts = out[3]?.content as Part[];
    expect(parts.map((part) => part.type)).toEqual(["text"]);
    expect(parts[0]?.text).toContain("could not be loaded");
  }
});

test("only the newest four images in a run are fetched", async () => {
  const { asked, impl } = fakeFetch();
  const urls = [1, 2, 3, 4, 5].map(
    (n) => `https://bucket.s3.amazonaws.com/newest-${n}.png`,
  );
  const out = await inlineToolImages(
    history(...urls.map((url) => attachmentResult(url, "image/png"))),
    impl,
  );
  expect(asked.sort()).toEqual(urls.slice(1).sort());
  expect(out.some((message) => message.id === "t0-images")).toBe(false);
  expect(out.some((message) => message.id === "t4-images")).toBe(true);
});

test("the picture waits until every result of the same batch of calls is in", async () => {
  const { impl } = fakeFetch();
  const input = [
    { id: "u1", role: "user", content: "Handle the claim" },
    {
      id: "a0",
      role: "assistant",
      content: "",
      toolCalls: ["call_0", "call_1"].map((id) => ({
        id,
        type: "function",
        function: { name: "GMAIL_GET_ATTACHMENT", arguments: "{}" },
      })),
    },
    {
      id: "t0",
      role: "tool",
      toolCallId: "call_0",
      content: attachmentResult("https://bucket.s3.amazonaws.com/batch.png"),
    },
    { id: "t1", role: "tool", toolCallId: "call_1", content: "{}" },
  ] as Message[];
  const out = await inlineToolImages(input, impl);
  expect(out.map((message) => message.id)).toEqual([
    "u1",
    "a0",
    "t0",
    "t1",
    "t0-images",
  ]);
});

test("a history with no tool images comes back as it was", async () => {
  const input = history('{"messages": []}');
  expect(await inlineToolImages(input, fakeFetch().impl)).toBe(input);
});
