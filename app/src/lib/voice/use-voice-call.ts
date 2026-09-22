import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { connectVoice, voiceSupported } from "./connection";
import { VoiceSession } from "./session";
import { saveVoiceSession } from "./archive";
import { voiceCallOwner } from "./outbox";

export function useVoiceCall(options: {
  channelId: string;
  disabled: boolean;
  askAgent(request: string, signal: AbortSignal): Promise<string>;
  context(): string | Promise<string>;
  anchorMessageId(): string | null;
}) {
  const callbacks = useRef(options);
  const ownerId = useRef(voiceCallOwner());
  callbacks.current = options;
  const { data } = useQuery(deploymentCapabilitiesQueryOptions(), queryClient);
  const [session] = useState(
    () =>
      new VoiceSession({
        channelId: options.channelId,
        connect: connectVoice,
        askAgent: (request, signal) =>
          callbacks.current.askAgent(request, signal),
        context: () => callbacks.current.context(),
        anchorMessageId: () => callbacks.current.anchorMessageId(),
        onEnd: (call) => saveVoiceSession(call, ownerId.current),
      }),
  );
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [minimized, setMinimized] = useState(false);
  useEffect(() => {
    if (options.disabled || !data?.voice) session.end();
    window.addEventListener("pagehide", session.end);
    return () => {
      window.removeEventListener("pagehide", session.end);
      session.end();
    };
  }, [options.disabled, data?.voice, session]);
  const active = state.phase === "connecting" || state.phase === "connected";
  return {
    session,
    state,
    minimized,
    setMinimized,
    active,
    available: data?.voice === true,
    supported: voiceSupported(),
    open() {
      setMinimized(false);
      if (!active) void session.start();
    },
  };
}
