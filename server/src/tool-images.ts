import type { Message } from "@ag-ui/client";
import {
  ACCEPTED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  mediaTypeOf,
} from "@openbot/shared/attachments";
import { sniffMimeType } from "./channels/attachment-mime";
import { checkNavigationTarget } from "./computer/target";

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
 * is: https only, never a private, loopback or metadata host (the same {@link checkNavigationTarget}
 * a Bot's browser answers to, with private hosts never allowed), never a bare IP address, no
 * redirects, and no more than {@link MAX_IMAGE_BYTES} read.
 */

const IMAGE_TYPES: ReadonlySet<string> = new Set(ACCEPTED_IMAGE_MIME);
/** The newest few images in a run; older ones were in front of the model on the turns they arrived. */
const MAX_IMAGES_PER_RUN = 4;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Downloads this process has already made, so the next step of the same turn does not fetch again.
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

/** Why this server will not fetch the link, or null when it will. */
function refusal(raw: string): string | null {
  const verdict = checkNavigationTarget(raw, { allowPrivateHosts: false });
  if (!verdict.allowed) return "its address is not one this server may fetch";
  const url = new URL(verdict.url);
  if (url.protocol !== "https:") return "its address is not an https link";
  // A storage link is a name. A bare address is either private or a way around the list above.
  if (/^[\d.]+$/.test(url.hostname) || url.hostname.startsWith("["))
    return "its address is not one this server may fetch";
  return null;
}

/** The body, or null once it passes `limit` bytes; read in pieces so nothing larger is held. */
async function readCapped(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) return null;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchImage(
  link: ToolImageLink,
  fetchImpl: typeof fetch,
): Promise<Fetched> {
  const held = cache.get(link.url);
  if (held) return held;
  const refused = refusal(link.url);
  if (refused) return { failed: refused };
  try {
    const response = await fetchImpl(link.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { failed: `the download answered ${response.status}` };
    }
    const bytes = await readCapped(response, MAX_IMAGE_BYTES);
    if (!bytes)
      return {
        failed: `it is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
      };
    // The bytes decide the type, not the tool's word: a provider refuses an image it cannot read.
    const mimeType = sniffMimeType(bytes, link.mimeType);
    if (!IMAGE_TYPES.has(mimeType))
      return { failed: "the download is not a png, jpeg, gif or webp image" };
    const image = { value: Buffer.from(bytes).toString("base64"), mimeType };
    remember(link.url, image);
    return image;
  } catch (error) {
    // The host only: a presigned link carries its credential in the query string.
    console.warn({
      error: "tool_image_download_failed",
      context: { host: new URL(link.url).host },
      timestamp: new Date().toISOString(),
    });
    return {
      failed:
        error instanceof Error && error.name === "TimeoutError"
          ? "the download timed out"
          : "the download failed",
    };
  }
}

/**
 * The history with a picture message after each batch of tool results that named an image, newest
 * {@link MAX_IMAGES_PER_RUN} only. The same array comes back when there is nothing to add.
 */
export async function inlineToolImages(
  messages: Message[],
  fetchImpl: typeof fetch = fetch,
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

  const added = new Map<number, { after: number; message: Message }>();
  await Promise.all(
    wanted.map(async ({ index, links }) => {
      const tool = messages[index] as Message & { toolCallId?: string };
      const call = tool.toolCallId ?? tool.id;
      const fetched = await Promise.all(
        links.map((link) => fetchImage(link, fetchImpl)),
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
