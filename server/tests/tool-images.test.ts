import { expect, test } from "bun:test";
import { createServer } from "node:net";
import type { Message } from "@ag-ui/client";
import { MAX_IMAGE_BYTES } from "@openbot/shared/attachments";
import {
  inlineToolImages,
  type ToolImageDownload,
  toolImageLinks,
} from "../src/tool-images";
import { markUntrusted } from "../src/untrusted-content";

/** Where Composio stages a tool's file; the one host a tool's image link may be on. */
const STORAGE = "https://storage.composio.dev/projects/pr_test/requests/gmail";

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

/** A download that records what it was asked for and answers `body`. */
function fakeDownload(body: Uint8Array = PNG) {
  const asked: string[] = [];
  const download: ToolImageDownload = async (url) => {
    asked.push(url.href);
    return { data: body };
  };
  return { asked, download };
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
  expect(toolImageLinks(attachmentResult(`${STORAGE}/a.jpg`))).toEqual([
    { url: `${STORAGE}/a.jpg`, mimeType: "image/jpeg", name: "mug.jpg" },
  ]);
  expect(
    toolImageLinks(attachmentResult(`${STORAGE}/a.pdf`, "application/pdf")),
  ).toEqual([]);
});

test("the image is added straight after the tool result as a picture, typed by its bytes", async () => {
  const { asked, download } = fakeDownload();
  const out = await inlineToolImages(
    history(attachmentResult(`${STORAGE}/b.jpg?X-Amz-Signature=s`)),
    { download },
  );
  expect(asked).toEqual([`${STORAGE}/b.jpg?X-Amz-Signature=s`]);
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

test("a Gmail attachment on the bucket Composio really answers with is fetched", async () => {
  // The shape a live GMAIL_GET_ATTACHMENT returned: a presigned link on Composio's R2 bucket, not
  // on storage.composio.dev. With only the client's host listed, every Gmail picture was refused.
  const url =
    "https://temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com/project_scope/pr_test/gmail/img.png?X-Amz-Signature=s";
  const { asked, download } = fakeDownload();
  const out = await inlineToolImages(
    history(attachmentResult(url, "image/png")),
    { download },
  );
  expect(asked).toEqual([url]);
  const parts = out[3]?.content as Part[];
  expect(parts[1]?.type).toBe("image");
});
test("a link off Composio's storage host, or over http, is never fetched, and says so", async () => {
  for (const url of [
    // Any text a tool returns can carry this shape: an email body, a web page.
    "https://attacker.example/a.png",
    "https://169.254.169.254.nip.io/latest/meta-data",
    "https://bucket.s3.amazonaws.com/a.png",
    "https://storage.composio.dev.attacker.example/a.png",
    // Another R2 bucket, and Composio's own bucket name under another account: not Composio's.
    "https://attacker.r2.cloudflarestorage.com/a.png",
    "https://temp.00000000000000000000000000000000.r2.cloudflarestorage.com/a.png",
    "https://127.0.0.1/secret.png",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/a.png",
    `${STORAGE.replace("https:", "http:")}/a.png`,
  ]) {
    const { asked, download } = fakeDownload();
    const out = await inlineToolImages(
      history(attachmentResult(url, "image/png")),
      { download },
    );
    expect(asked).toEqual([]);
    const parts = out[3]?.content as Part[];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).toContain("could not be loaded");
  }
});

test("a name that resolves to a non-public address is refused before any connection, even on an allowed host", async () => {
  // A listener on the address `localhost` resolves to, counting whoever reaches it.
  let connections = 0;
  const listener = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const { port } = listener.address() as { port: number };
  try {
    // The real downloader, with the name allowed, so only its address check stands in the way.
    const out = await inlineToolImages(
      history(
        attachmentResult(`https://localhost:${port}/rebind.png`, "image/png"),
      ),
      { allowedHosts: ["localhost"] },
    );
    const parts = out[3]?.content as Part[];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).toContain(
      "could not be loaded (its address is not one this server may fetch)",
    );
    expect(connections).toBe(0);
  } finally {
    listener.close();
  }
});

test("a download that is not an image, or is too large, is not put in front of the model", async () => {
  for (const [url, body] of [
    [`${STORAGE}/html.png`, new TextEncoder().encode("<html>expired</html>")],
    [`${STORAGE}/huge.png`, new Uint8Array(MAX_IMAGE_BYTES + 1)],
  ] as const) {
    const out = await inlineToolImages(
      history(attachmentResult(url, "image/png")),
      fakeDownload(body),
    );
    const parts = out[3]?.content as Part[];
    expect(parts.map((part) => part.type)).toEqual(["text"]);
    expect(parts[0]?.text).toContain("could not be loaded");
  }
});

test("a download that answers an error status says which, and never the link", async () => {
  const download: ToolImageDownload = async () => {
    throw Object.assign(
      new Error("The server answered with HTTP status 403."),
      {
        statusCode: 403,
      },
    );
  };
  const out = await inlineToolImages(
    history(attachmentResult(`${STORAGE}/expired.png?X-Amz-Signature=s`)),
    { download },
  );
  const text = (out[3]?.content as Part[] | undefined)?.[0]?.text ?? "";
  expect(text).toContain("(the download answered 403)");
  expect(text).not.toContain("X-Amz-Signature");
});

test("only the newest four images in a run are fetched", async () => {
  const { asked, download } = fakeDownload();
  const urls = [1, 2, 3, 4, 5].map((n) => `${STORAGE}/newest-${n}.png`);
  const out = await inlineToolImages(
    history(...urls.map((url) => attachmentResult(url, "image/png"))),
    { download },
  );
  expect(asked.sort()).toEqual(urls.slice(1).sort());
  expect(out.some((message) => message.id === "t0-images")).toBe(false);
  expect(out.some((message) => message.id === "t4-images")).toBe(true);
});

test("the picture waits until every result of the same batch of calls is in", async () => {
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
      content: attachmentResult(`${STORAGE}/batch.png`),
    },
    { id: "t1", role: "tool", toolCallId: "call_1", content: "{}" },
  ] as Message[];
  const out = await inlineToolImages(input, fakeDownload());
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
  expect(await inlineToolImages(input, fakeDownload())).toBe(input);
});
