export const MAX_DICTATION_BYTES = 10 * 1024 * 1024;
export const MAX_DICTATION_SECONDS = 120;
export const DICTATION_TIMEOUT_MS = 60_000;
// Leave time for the API's timeout response to reach the browser through the app proxy.
export const DICTATION_HTTP_IDLE_SECONDS = DICTATION_TIMEOUT_MS / 1000 + 10;

/** MediaRecorder formats supported by the initial transcription adapter. */
export const DICTATION_FORMATS: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/wav": "wav",
};

export function dictationExtension(type: string): string | undefined {
  const normalized = dictationMediaType(type);
  return Object.hasOwn(DICTATION_FORMATS, normalized)
    ? DICTATION_FORMATS[normalized]
    : undefined;
}

export function dictationMediaType(type: string): string {
  const base = type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  // Bun's multipart parser can infer the container MIME from the filename.
  if (base === "video/webm") return "audio/webm";
  if (base === "video/mp4") return "audio/mp4";
  if (base === "audio/x-wav") return "audio/wav";
  return base;
}
