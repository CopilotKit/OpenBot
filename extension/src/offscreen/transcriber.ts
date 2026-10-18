import { recorderPaths } from "@openbot/shared/recorder-api";
import { scrubText } from "@openbot/shared/recorder-masking";
import { OpenBotError, openbotRaw } from "../shared/openbot-client";

export type VoiceSlice = {
  demonstrationId: string;
  index: number;
  startedAt: number;
  endedAt: number;
  blob: Blob;
};

export type TranscribeResult =
  | { text: string }
  | { skipped: "no-speech" }
  | { unavailable: string }
  | { signedOut: true }
  | { failed: string };

async function errorOf(response: Response): Promise<OpenBotError> {
  let body: { error: string; code?: string } | null = null;
  try {
    const parsed: unknown = await response.json();
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { error?: unknown }).error === "string"
    ) {
      body = parsed as { error: string; code?: string };
    }
  } catch {
    // A body that is not JSON carries no error code.
  }
  return new OpenBotError(
    response.status,
    body?.error ?? `OpenBot answered ${response.status}.`,
    body,
  );
}

/** Sends one voice slice to OpenBot's dictation route with the Recorder's bearer. */
export function createTranscriber(options: {
  openbotUrl: string;
  token: string;
}): { transcribe(slice: VoiceSlice): Promise<TranscribeResult> } {
  return {
    async transcribe(slice) {
      const form = new FormData();
      form.append(
        "file",
        new File([slice.blob], `slice-${slice.index}.webm`, {
          type: "audio/webm",
        }),
      );
      let response: Response;
      try {
        response = await openbotRaw(options, recorderPaths.transcriptions, {
          method: "POST",
          headers: { "x-openbot-dictation": "1" },
          body: form,
        });
      } catch (error) {
        return {
          failed: error instanceof Error ? error.message : String(error),
        };
      }
      if (response.ok) {
        try {
          const body: unknown = await response.json();
          const text = (body as { text?: unknown } | null)?.text;
          if (typeof text === "string") return { text: scrubText(text) };
        } catch {
          // Falls through to the failure below.
        }
        return { failed: "OpenBot answered without a transcript." };
      }
      const error = await errorOf(response);
      if (error.signedOut) return { signedOut: true };
      if (response.status === 422) return { skipped: "no-speech" };
      if (response.status === 503) return { unavailable: error.message };
      return { failed: error.message };
    },
  };
}
