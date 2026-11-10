import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { LiveDictation, liveDictationSource } from "@/lib/dictation/live";
import {
  recordingSupported,
  startRecording,
  transcribeRecording,
} from "@/lib/dictation/recording";
import {
  type DictationIntent,
  DictationSession,
} from "@/lib/dictation/session";
import { queryClient } from "@/query-client";

/**
 * How this composer dictates:
 * - `recording`: OpenBot has a transcription provider. The composer records, then the server
 *   transcribes. This wins whenever a provider is configured.
 * - `live`: no provider, but this computer or browser recognises speech. Words stream into the box.
 * - null: neither, and there is no microphone button.
 */
export type DictationMode = "recording" | "live" | null;

export function useDictation(
  handlers: {
    onTranscript: (text: string, intent: DictationIntent) => void;
    onLiveStart: () => void;
    onLiveText: (text: string) => void;
  },
  disabled: boolean,
) {
  const { data, isError } = useQuery(
    { ...deploymentCapabilitiesQueryOptions(), enabled: !disabled },
    queryClient,
  );
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [session] = useState(
    () =>
      new DictationSession({
        record: startRecording,
        transcribe: transcribeRecording,
        onTranscript: (text, intent) =>
          handlersRef.current.onTranscript(text, intent),
      }),
  );
  const [source] = useState(() => liveDictationSource());
  const [live] = useState(
    () =>
      new LiveDictation({
        source: () => source,
        language: () =>
          (typeof navigator !== "undefined" && navigator.language) || "en-US",
        onStart: () => handlersRef.current.onLiveStart(),
        onText: (text) => handlersRef.current.onLiveText(text),
      }),
  );
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const liveState = useSyncExternalStore(
    live.subscribe,
    live.getSnapshot,
    live.getSnapshot,
  );
  const mode: DictationMode =
    data?.transcription === true
      ? "recording"
      : (data || isError) && source
        ? "live"
        : null;
  useEffect(() => {
    if (disabled || mode !== "recording") session.cancel();
    if (disabled || mode !== "live") live.release();
    return () => {
      session.cancel();
      live.release();
    };
  }, [disabled, mode, session, live]);
  return {
    mode,
    session,
    state,
    available: mode !== null,
    supported: mode === "live" || recordingSupported(),
    /** A recording is under way and has the composer's place: the box is hidden. */
    busy: state.phase !== "idle",
    live: {
      session: live,
      state: liveState,
      /** Listening, about to, or finishing: Enter stops it, and nothing sends. */
      active:
        liveState.phase === "preparing" ||
        liveState.phase === "listening" ||
        liveState.phase === "stopping",
    },
  };
}
