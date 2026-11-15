import { getVoiceConfiguration } from "@/lib/api/generated/voice/voice";
import { organizationId } from "@/lib/api/request";
import type { ConnectVoice } from "./types";
import { connectWebRtc } from "./webrtc";
import { connectWebSocket } from "./websocket";

export function voiceSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

export const connectVoice: ConnectVoice = async (options) => {
  if (!voiceSupported())
    throw new Error(
      "Voice calls need a supported browser and HTTPS or localhost.",
    );
  const config: unknown = await getVoiceConfiguration(organizationId(), {
    signal: options.signal,
  }).catch((error: unknown) => {
    // A call that was hung up while this was asked is not a fault to report.
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new Error(
      "Voice calls are unavailable. Check OpenBot's voice configuration.",
    );
  });
  if (config && typeof config === "object" && "transport" in config) {
    if (config.transport === "webrtc") return connectWebRtc(options);
    if (config.transport === "websocket") return connectWebSocket(options);
  }
  throw new Error("OpenBot uses a voice connection this app doesn't support.");
};
