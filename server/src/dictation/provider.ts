import type { TranscriptionConfig } from "./config";

export interface TranscriptionProvider {
  transcribe(file: File, signal: AbortSignal): Promise<string>;
}

/** A safe, actionable message; upstream response bodies can contain deployment secrets. */
export class TranscriptionError extends Error {}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

export function createTranscriptionProvider(
  config: TranscriptionConfig,
  transport: Transport = fetch,
): TranscriptionProvider {
  switch (config.provider) {
    case "openai-compatible":
      return {
        async transcribe(file, signal) {
          const body = new FormData();
          body.set("file", file);
          body.set("model", config.model);
          const response = await transport(
            `${config.baseUrl}/audio/transcriptions`,
            {
              method: "POST",
              headers: config.apiKey
                ? { authorization: `Bearer ${config.apiKey}` }
                : {},
              body,
              signal,
              // A redirect must never send a recording to an unconfigured destination.
              redirect: "error",
            },
          );
          if (!response.ok) {
            throw new TranscriptionError(
              response.status === 429
                ? "The transcription service is busy. Please retry shortly."
                : "The transcription service could not process this recording. Retry or contact your administrator.",
            );
          }
          const result: unknown = await response.json().catch(() => null);
          if (
            !result ||
            typeof result !== "object" ||
            !("text" in result) ||
            typeof result.text !== "string"
          ) {
            throw new TranscriptionError(
              "The transcription service returned an invalid response. Please retry.",
            );
          }
          return result.text.trim();
        },
      };
  }
}
