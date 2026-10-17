// Feature off until Task 19 replaces it.
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import type { CaptureStatus, StreamSession } from "../protocol/messages";
import type { DrainRecord } from "../shared/storage";

export type MediaSinks = {
  emit(event: CapturedEvent): void;
  status(capture: Partial<CaptureStatus>): void;
  uploadsPending(count: number): void;
};
export type MediaHandle = {
  screen(tabStreamId: string): Promise<void>;
  /** Start over: drop the old recording's buffered screen chunks and untranscribed voice, record into the new one. */
  rotate(next: { demonstrationId: string }): Promise<void>;
  /** Stop recorders and drain voice: resolves after the last transcript has been emitted (or has failed for good). */
  stop(): Promise<void>;
  /** Resolves when every buffered chunk is uploaded and the media completed. */
  finished(): Promise<void>;
};

export async function startMedia(
  _session: StreamSession,
  _sinks: MediaSinks,
): Promise<MediaHandle> {
  return {
    screen: async () => {},
    rotate: async () => {},
    stop: async () => {},
    finished: async () => {},
  };
}

/** After a browser restart: transcribe buffered voice slices (emitting transcripts) and upload buffered chunks. */
export async function recoverMedia(
  _drain: DrainRecord,
  _target: { openbotUrl: string; token: string },
  _sinks: MediaSinks,
): Promise<void> {}

export async function discardMedia(_demonstrationId: string): Promise<void> {}
