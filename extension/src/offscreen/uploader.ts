import {
  type MediaRecord,
  RECORDER_MEDIA_CHUNK_BYTES,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import {
  OpenBotError,
  openbotJson,
  openbotRaw,
  readErrorBody,
} from "../shared/openbot-client";
import type { MediaBuffer, MediaKind } from "./media-buffer";

/** Seconds to wait after the 1st, 2nd, ... failed attempt at one chunk; the last delay repeats until it goes through. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 30_000];
const CHUNK_TIMEOUT_MS = 60_000;

export type MediaUploader = {
  /** Buffers the blob (split into server-sized pieces) and starts sending; resolves once it is buffered. */
  add(blob: Blob): Promise<void>;
  /** Uploads what is left and completes the media. After a sign-out it resolves with the chunks still buffered and the
   * media not completed: the next `offscreen.recover` sends them. */
  finish(): Promise<void>;
  /** Start over: stops sending and drops every buffered chunk. */
  abandon(): Promise<void>;
};

export type MediaUploaderDeps = {
  target: () => { openbotUrl: string; token: string; demonstrationId: string };
  buffer: MediaBuffer;
  kind: MediaKind;
  mimeType: string;
  onPending(count: number): void;
  /** Waits between retries; a test seam, defaulting to a timer. */
  sleep?: (ms: number) => Promise<void>;
};

const timerSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One uploader per media (the screen and the audio each have their own): chunks go up one at a time, in index order. */
export async function createMediaUploader(
  deps: MediaUploaderDeps,
): Promise<MediaUploader> {
  const { buffer, kind, mimeType } = deps;
  const sleep = deps.sleep ?? timerSleep;
  const abort = new AbortController();
  const { demonstrationId } = deps.target();
  const { media } = await openbotJson<{ media: MediaRecord }>(
    deps.target(),
    recorderPaths.media(demonstrationId),
    { body: { kind, mimeType } },
  );
  const mediaId = media.id;
  await buffer.remember(demonstrationId, kind, mediaId);

  let nextIndex = 0;
  let pending = 0;
  let signedOut = false;
  let abandoned = false;
  let adding: Promise<void> = Promise.resolve();
  let sending: Promise<void> | null = null;
  let finishing: Promise<void> | null = null;

  const setPending = (count: number) => {
    pending = count;
    deps.onPending(count);
  };

  async function putChunk(index: number, blob: Blob): Promise<void> {
    const target = deps.target();
    const response = await openbotRaw(
      target,
      recorderPaths.mediaChunk(target.demonstrationId, mediaId, index),
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: blob,
        signal: AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(CHUNK_TIMEOUT_MS),
        ]),
      },
    );
    if (response.ok) return;
    const body = await readErrorBody(response);
    throw new OpenBotError(
      response.status,
      body?.error ?? `OpenBot answered ${response.status} for a chunk.`,
      body,
    );
  }

  /** Sends one chunk, retrying until it goes through. Returns false when sending must stop (signed out or abandoned). */
  async function send(index: number, blob: Blob): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      if (abandoned) return false;
      try {
        await putChunk(index, blob);
        return true;
      } catch (error) {
        if (abandoned) return false;
        if (error instanceof OpenBotError && error.signedOut) {
          signedOut = true;
          return false;
        }
        await Promise.race([
          sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]),
          new Promise<void>((resolve) =>
            abort.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          ),
        ]);
      }
    }
  }

  async function sendAll(): Promise<void> {
    for (;;) {
      if (signedOut || abandoned) return;
      const [next] = await buffer.take(mediaId);
      if (!next || abandoned) return;
      if (!(await send(next.index, next.blob))) return;
      await buffer.remove(mediaId, next.index);
      setPending(Math.max(0, pending - 1));
    }
  }

  function kick(): Promise<void> {
    if (!sending) {
      sending = sendAll().finally(() => {
        sending = null;
      });
    }
    return sending;
  }

  /** Waits until a pass has found the buffer empty (or sending must stop). */
  async function drained(): Promise<void> {
    await adding;
    for (;;) {
      await kick();
      const left = signedOut || abandoned ? [] : await buffer.take(mediaId);
      if (left.length === 0) return;
    }
  }

  return {
    add(blob) {
      const buffered = adding.then(async () => {
        if (abandoned) return;
        for (
          let start = 0;
          start < blob.size;
          start += RECORDER_MEDIA_CHUNK_BYTES
        ) {
          await buffer.put(
            mediaId,
            nextIndex++,
            blob.slice(start, start + RECORDER_MEDIA_CHUNK_BYTES),
          );
          setPending(pending + 1);
        }
        if (!signedOut) void kick();
      });
      adding = buffered.catch(() => {});
      return buffered;
    },

    finish() {
      finishing ??= (async () => {
        await drained();
        if (signedOut || abandoned) return;
        await openbotJson<{ media: MediaRecord }>(
          deps.target(),
          recorderPaths.mediaComplete(demonstrationId, mediaId),
          { body: { chunkCount: nextIndex } },
        );
      })().catch((error: unknown) => {
        finishing = null;
        throw error;
      });
      return finishing;
    },

    async abandon() {
      abandoned = true;
      abort.abort();
      await adding;
      await sending?.catch(() => {});
      await buffer.drop(mediaId);
      setPending(0);
    },
  };
}
