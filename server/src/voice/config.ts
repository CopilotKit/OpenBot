export type VoiceConfig = {
  provider: "openai-realtime" | "xai-realtime";
  model: string;
  apiKey: string;
  voice: string;
};

/** Live voice is separately opted in; chat and dictation credentials never enable it. */
export function voiceConfig(
  environment: Record<string, string | undefined>,
): VoiceConfig | undefined {
  const provider = environment.VOICE_PROVIDER?.trim();
  const model = environment.VOICE_MODEL?.trim();
  const apiKey = environment.VOICE_API_KEY?.trim();
  const voice = environment.VOICE_NAME?.trim();
  if (!provider && !model && !apiKey && !voice) return undefined;
  if (provider !== "openai-realtime" && provider !== "xai-realtime") {
    throw new Error("VOICE_PROVIDER must be openai-realtime or xai-realtime.");
  }
  if (!model || !apiKey) {
    throw new Error("VOICE_MODEL and VOICE_API_KEY are required.");
  }
  return {
    provider,
    model,
    apiKey,
    voice: voice || (provider === "openai-realtime" ? "marin" : "ara"),
  };
}
