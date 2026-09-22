import {
  DICTATION_TIMEOUT_MS,
  dictationExtension,
  dictationMediaType,
  MAX_DICTATION_BYTES,
} from "../../../../shared/dictation";

export interface Recording {
  /** Shared with the visualizer; the recorder owns this stream's lifetime. */
  readonly stream?: MediaStream;
  finish(): Promise<Blob>;
  cancel(): void;
}

export function recordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

export async function startRecording(
  onError: (error: Error) => void,
): Promise<Recording> {
  if (!recordingSupported())
    throw new Error(
      "Dictation requires a supported browser and HTTPS (or localhost).",
    );
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
    (type) => MediaRecorder.isTypeSupported(type),
  );
  if (!mimeType)
    throw new Error("This browser cannot record a supported audio format.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (error) {
    release();
    throw error;
  }
  let chunks: Blob[] = [];
  let size = 0;
  let done: ReturnType<typeof Promise.withResolvers<Blob>> | undefined;
  const cancel = () => {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    if (recorder.state !== "inactive") recorder.stop();
    release();
    chunks = [];
    done?.reject(new DOMException("Recording cancelled", "AbortError"));
  };
  recorder.ondataavailable = (event) => {
    size += event.data.size;
    if (size > MAX_DICTATION_BYTES) {
      cancel();
      onError(new Error("Recording is too large. Try a shorter message."));
      return;
    }
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onerror = () => {
    cancel();
    onError(new Error("The microphone stopped recording. Please try again."));
  };
  recorder.onstop = () => {
    release();
    if (!done) {
      onError(new Error("Recording was interrupted. Please try again."));
      return;
    }
    done.resolve(
      new Blob(chunks, { type: dictationMediaType(recorder.mimeType) }),
    );
    chunks = [];
  };
  try {
    recorder.start(250);
  } catch (error) {
    cancel();
    throw error;
  }
  return {
    stream,
    cancel,
    finish() {
      if (done) return done.promise;
      done = Promise.withResolvers<Blob>();
      if (recorder.state === "inactive") {
        release();
        done.reject(
          new Error("Recording stopped before audio could be collected."),
        );
      } else {
        recorder.stop();
        release();
      }
      return done.promise;
    },
  };
}

export async function transcribeRecording(
  audio: Blob,
  signal: AbortSignal,
): Promise<string> {
  const type = dictationMediaType(audio.type);
  const extension = dictationExtension(type);
  if (!extension || !audio.size || audio.size > MAX_DICTATION_BYTES) {
    throw new Error(
      "The recording is empty or unsupported. Please record again.",
    );
  }
  const body = new FormData();
  body.set("file", audio, `recording.${extension}`);
  const response = await fetch("/api/audio/transcriptions", {
    method: "POST",
    credentials: "include",
    headers: { "x-openbot-dictation": "1" },
    body,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(DICTATION_TIMEOUT_MS + 5_000),
    ]),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      result &&
        typeof result === "object" &&
        "error" in result &&
        typeof result.error === "string"
        ? result.error
        : "Transcription failed. Please retry.",
    );
  }
  if (
    !result ||
    typeof result !== "object" ||
    !("text" in result) ||
    typeof result.text !== "string" ||
    !result.text.trim()
  ) {
    throw new Error("No speech was detected. Try recording again.");
  }
  return result.text.trim();
}
