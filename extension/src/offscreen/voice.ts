// Feature off until Task 20 replaces it.
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import type { CaptureStatus } from "../protocol/messages";

export type VoiceOptions = {
  openbotUrl: string;
  token: string;
  demonstrationId: string;
  recordingStartedAt: number;
  emit(event: CapturedEvent): void;
  status(voice: CaptureStatus["voice"], reason?: string): void;
};
export type VoiceHandle = {
  stop(): Promise<void>;
  discardPending(): Promise<void>;
  retarget(next: { demonstrationId: string; recordingStartedAt: number }): void;
};

export function startVoiceSlices(
  _stream: MediaStream,
  _options: VoiceOptions,
): VoiceHandle {
  return {
    stop: async () => {},
    discardPending: async () => {},
    retarget: () => {},
  };
}

export async function transcribeBuffered(
  _options: Omit<VoiceOptions, "recordingStartedAt"> & {
    recordingStartedAt: number;
  },
): Promise<void> {}
