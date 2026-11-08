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
  const response = await fetch("/api/voice/config", {
    credentials: "include",
    signal: options.signal,
  });
  if (!response.ok)
    throw new Error(
      "Voice calls are unavailable. Check OpenBot's voice configuration.",
    );
  const config: unknown = await response.json();
  if (config && typeof config === "object" && "transport" in config) {
    if (config.transport === "webrtc") return connectWebRtc(options);
    if (config.transport === "websocket") return connectWebSocket(options);
  }
  throw new Error("OpenBot uses a voice connection this app doesn't support.");
};
