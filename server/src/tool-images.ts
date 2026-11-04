import type { Message } from "@ag-ui/client";
import { createSafeUrlDownload } from "@copilotkit/runtime/v2";
import {
  ACCEPTED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  mediaTypeOf,
} from "@openbot/shared/attachments";
import { sniffMimeType } from "./channels/attachment-mime";

/**
 * The images a tool handed back, put in front of the model as images.
 *
 * A tool result reaches the model as text, so a file a tool downloaded (Gmail's attachment, as
 * Composio returns it: `{ name, mimetype, s3url }`) arrives as a link the model cannot open. Here
 * each such image is fetched and added straight after the result, as a user message carrying the
 * picture, because a user message is the one place every provider takes an image (a `tool` message
 * takes text only). It takes the shape a file the person attached takes after `inlineAttachments`:
 * an `image` part with `data`, which every Bot's history already turns into the provider's own part.
 *
 * ON EVERY RUN, LIKE THE ATTACHMENTS. The loop runs one tool step per run and each run is sent the
 * whole history again, so the picture is in front of the model on the step after the tool returned
 * and on every later one, up to {@link MAX_IMAGES_PER_RUN}. Nothing is stored: the history keeps the
 * tool's text, and the picture is rebuilt from the link each time.
 *
 * NEVER FAILS A TURN. An image that cannot be fetched (an expired presigned link, a private address,
 * bytes that are not the image they claim to be) becomes a sentence saying the picture is not in
 * front of the model, so it is never left to describe something it did not get.
 *
 * The link is outside content and this server fetches it, so it is held to more than a browser link
 * is: https only, only on a host Composio stores files on ({@link TOOL_IMAGE_HOSTS}), never to an
 * address that is not public, no redirects, and no more than {@link MAX_IMAGE_BYTES} read. The host
 * list matters because the link is found by its shape alone: an email body or a web page a tool
 * returns as text can carry the same `{ "s3url": … }`, and without the list that text would choose
 * what this server fetches.
 */

const IMAGE_TYPES: ReadonlySet<string> = new Set(ACCEPTED_IMAGE_MIME);
/** The newest few images in a run; older ones were in front of the model on the turns they arrived. */
const MAX_IMAGES_PER_RUN = 4;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * The hosts a tool's image link may be on: where Composio stages the files its tools return.
 * `storage.composio.dev` is the one `@composio/client` gives for its presigned file links
 * (`resources/files.d.ts`: `https://storage.composio.dev/projects/…`). The Cloudflare R2 name is
 * where a real `GMAIL_GET_ATTACHMENT` put its `s3url` on 2026-11-04 (`…/project_scope/…`): the
 * client's host alone refused every Gmail attachment. Exact names only, no wildcards: any R2
 * customer can serve `*.r2.cloudflarestorage.com`, so a wildcard would let a planted link choose
 * what this server fetches again. A link anywhere else is never fetched and the model is told so.
 * Add a host here only from a link a Composio tool really returned.
 */
export const TOOL_IMAGE_HOSTS: readonly string[] = [
  "storage.composio.dev",
  "temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com",
];

/** Fetches one link, or throws. A seam for tests; the default is {@link safeDownload}. */
export type ToolImageDownload = (url: URL) => Promise<{ data: Uint8Array }>;

/**
 * The runtime's guarded downloader, held to the limits above. It resolves the name itself, refuses
 * the link when any address it resolves to is not public (private, loopback, link-local and so the
 * metadata service), and connects only to the addresses it checked, so a name that answers
 * differently the second time cannot move the request. It is handed the same host list as the check
 * in {@link refusal}, so the two cannot disagree.
 */
export function safeDownload(
  allowedHosts: readonly string[] = TOOL_IMAGE_HOSTS,
): ToolImageDownload {
  const download = createSafeUrlDownload({
    allowedHosts: [...allowedHosts],
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: 0,
  });
  return async (url) => {
    // One link per call: a failure inside a call stops every other download in it.
    const [result] = await download([{ url, isUrlSupportedByModel: false }]);
    if (!result) throw new Error("the downloader left the link alone");
    return { data: result.data };
  };
}

/**
 * Downloads this process has already made, so the next step of the same turn does not fetch again.
 *
 * SHARED BY EVERY PERSON ON THIS PROCESS, KEYED BY THE LINK. One person's run can be answered from a
 * picture another person's run downloaded, but only by holding the same link, and a presigned link
 * carries a signature nobody can guess, so holding it already means being able to download it.
 *
 * AN OPTIMISATION, NOT A PROMISE. This is a module-level map, so it is this process's alone: a run
 * that lands on another replica, or on this one after a restart or an eviction, downloads again.
 * When the link has expired by then, that download fails and the model is told the picture is not
 * in front of it, which is the same answer it gets for any other link that will not load. Nothing
 * here depends on a hit. Bounded by bytes rather than entries, because one entry can be 8 MiB.
 */
const CACHE_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, { value: string; mimeType: string }>();
let cachedBytes = 0;

function remember(url: string, image: { value: string; mimeType: string }) {
  cache.set(url, image);
  cachedBytes += image.value.length;
  for (const [key, held] of cache) {
    if (cachedBytes <= CACHE_BYTES) break;
    cache.delete(key);
    cachedBytes -= held.value.length;
  }
}

type ToolImageLink = { url: string; mimeType: string; name?: string };
type Fetched = { value: string; mimeType: string } | { failed: string };

/** Each `s3url` beside an image `mimetype` in a tool's JSON answer, in order. */
export function toolImageLinks(content: string): ToolImageLink[] {
  const found: ToolImageLink[] = [];
  // One flat JSON object at a time, which a `{ name, mimetype, s3url }` file always is.
  for (const match of content.matchAll(/\{[^{}]*"s3url"[^{}]*\}/g)) {
    let file: { s3url?: unknown; mimetype?: unknown; name?: unknown };
    try {
      file = JSON.parse(match[0]);
    } catch {
      continue;
    }
    if (typeof file.s3url !== "string" || typeof file.mimetype !== "string")
      continue;
    const mimeType = mediaTypeOf(file.mimetype);
    if (!IMAGE_TYPES.has(mimeType)) continue;
    found.push({
      url: file.s3url,
      mimeType,
      ...(typeof file.name === "string" ? { name: file.name } : {}),
    });
  }
  return found;
}

const NOT_FETCHABLE = "its address is not one this server may fetch";

/** Why this server will not fetch the link, or null when it will. */
function refusal(raw: string, allowedHosts: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return NOT_FETCHABLE;
  }
  if (url.protocol !== "https:") return "its address is not an https link";
  if (!allowedHosts.includes(url.hostname.replace(/\.$/, "")))
    return NOT_FETCHABLE;
  return null;
}

/** What the model is told about a download that threw. Never the link: it carries its credential. */
function failure(error: unknown): string {
  const { name, message, statusCode } = (error ?? {}) as {
    name?: unknown;
    message?: unknown;
    statusCode?: unknown;
  };
  const said = typeof message === "string" ? message : "";
  if (typeof statusCode === "number")
    return `the download answered ${statusCode}`;
  if (/not a public address|allowed hosts/.test(said)) return NOT_FETCHABLE;
  if (/larger than/.test(said))
    return `it is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`;
  if (/timed out/.test(said) || name === "TimeoutError")
    return "the download timed out";
  return "the download failed";
}

async function fetchImage(
  link: ToolImageLink,
  download: ToolImageDownload,
  allowedHosts: readonly string[],
): Promise<Fetched> {
  const refused = refusal(link.url, allowedHosts);
  if (refused) return { failed: refused };
  const held = cache.get(link.url);
  if (held) return held;
  let bytes: Uint8Array;
  try {
    ({ data: bytes } = await download(new URL(link.url)));
  } catch (error) {
    // The host only: a presigned link carries its credential in the query string.
    console.warn({
      error: "tool_image_download_failed",
      context: { host: new URL(link.url).host },
      timestamp: new Date().toISOString(),
    });
    return { failed: failure(error) };
  }
  // The downloader stops reading past the cap; this holds an injected one to it too.
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    return { failed: `it is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
  // The bytes decide the type, not the tool's word: a provider refuses an image it cannot read.
  const mimeType = sniffMimeType(bytes, link.mimeType);
  if (!IMAGE_TYPES.has(mimeType))
    return { failed: "the download is not a png, jpeg, gif or webp image" };
  const image = { value: Buffer.from(bytes).toString("base64"), mimeType };
  remember(link.url, image);
  return image;
}

/** Building it loads nothing: the networking modules are loaded on the first download. */
const defaultDownload = safeDownload();

/**
 * The history with a picture message after each batch of tool results that named an image, newest
 * {@link MAX_IMAGES_PER_RUN} only. The same array comes back when there is nothing to add.
 *
 * The downloads run side by side and the step waits for them, so a slow storage link delays the
 * step by up to {@link FETCH_TIMEOUT_MS}. A cache hit skips the wait, but only on the process that
 * made the download.
 *
 * `allowedHosts` and `download` are for tests. Without them, the links are held to
 * {@link TOOL_IMAGE_HOSTS} and fetched by {@link safeDownload}.
 */
export async function inlineToolImages(
  messages: Message[],
  {
    allowedHosts = TOOL_IMAGE_HOSTS,
    download,
  }: { allowedHosts?: readonly string[]; download?: ToolImageDownload } = {},
): Promise<Message[]> {
  const wanted: { index: number; links: ToolImageLink[] }[] = [];
  let left = MAX_IMAGES_PER_RUN;
  for (let index = messages.length - 1; index >= 0 && left > 0; index--) {
    const message = messages[index];
    if (message.role !== "tool" || typeof message.content !== "string")
      continue;
    const links = toolImageLinks(message.content).slice(-left);
    if (links.length === 0) continue;
    wanted.push({ index, links });
    left -= links.length;
  }
  if (wanted.length === 0) return messages;
  const fetcher =
    download ??
    (allowedHosts === TOOL_IMAGE_HOSTS
      ? defaultDownload
      : safeDownload(allowedHosts));

  const added = new Map<number, { after: number; message: Message }>();
  await Promise.all(
    wanted.map(async ({ index, links }) => {
      const tool = messages[index] as Message & { toolCallId?: string };
      const call = tool.toolCallId ?? tool.id;
      const fetched = await Promise.all(
        links.map((link) => fetchImage(link, fetcher, allowedHosts)),
      );
      const parts = links.flatMap((link, at) => {
        const label = link.name
          ? `"${link.name.replace(/["\n\r]/g, " ").slice(0, 120)}"`
          : "an image";
        const image = fetched[at] as Fetched;
        return "value" in image
          ? [
              {
                type: "text",
                text: `The image ${label} returned by tool call ${call} (not a message from the person):`,
              },
              {
                type: "image",
                source: {
                  type: "data",
                  value: image.value,
                  mimeType: image.mimeType,
                },
              },
            ]
          : [
              {
                type: "text",
                text: `The image ${label} returned by tool call ${call} could not be loaded (${image.failed}), so it is not in front of you: do not describe it.`,
              },
            ];
      });
      /*
       * After the LAST of the tool results that answer the same assistant message, not this one.
       * A provider wants every result of a batch of calls straight after the calls, and a user
       * message between two of them is a request it refuses.
       */
      let after = index;
      while (messages[after + 1]?.role === "tool") after++;
      added.set(index, {
        after,
        message: {
          id: `${tool.id}-images`,
          role: "user",
          content: parts,
        } as Message,
      });
    }),
  );
  const byAnchor = new Map<number, Message[]>();
  for (const index of [...added.keys()].sort((a, b) => a - b)) {
    const { after, message } = added.get(index) as {
      after: number;
      message: Message;
    };
    byAnchor.set(after, [...(byAnchor.get(after) ?? []), message]);
  }
  return messages.flatMap((message, index) => [
    message,
    ...(byAnchor.get(index) ?? []),
  ]);
}
