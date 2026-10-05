export type TranscriptionConfig = {
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKey?: string;
};

export function transcriptionConfig(
  environment: Record<string, string | undefined>,
): TranscriptionConfig | undefined {
  const provider = environment.TRANSCRIPTION_PROVIDER?.trim();
  const baseUrl = environment.TRANSCRIPTION_BASE_URL?.trim();
  const model = environment.TRANSCRIPTION_MODEL?.trim();
  const apiKey = environment.TRANSCRIPTION_API_KEY?.trim();
  if (!provider && !baseUrl && !model && !apiKey) return undefined;
  if (provider !== "openai-compatible") {
    throw new Error("TRANSCRIPTION_PROVIDER must be openai-compatible.");
  }
  if (!baseUrl || !model) {
    throw new Error(
      "TRANSCRIPTION_BASE_URL and TRANSCRIPTION_MODEL are required.",
    );
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("TRANSCRIPTION_BASE_URL must be an HTTP(S) URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "TRANSCRIPTION_BASE_URL must be HTTP(S), without credentials, query, or fragment.",
    );
  }
  return {
    provider,
    baseUrl: url.href.replace(/\/+$/, ""),
    model,
    ...(apiKey ? { apiKey } : {}),
  };
}
