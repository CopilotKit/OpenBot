import type { RecognitionLike } from "../../src/offscreen/voice";

export type FakeTrack = {
  readyState: "live" | "ended";
  onended: (() => void) | null;
  stop(): void;
};

/** A fresh SpeechRecognition double per test: every instance it made, and what Chrome would do to them. */
export function fakeSpeech() {
  const instances: FakeRecognition[] = [];
  class FakeRecognition implements RecognitionLike {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    processLocally?: boolean;
    onstart: (() => void) | null = null;
    onresult: RecognitionLike["onresult"] = null;
    onerror: RecognitionLike["onerror"] = null;
    onend: (() => void) | null = null;
    track: MediaStreamTrack | undefined;
    started = false;
    stops = 0;
    aborts = 0;
    constructor() {
      instances.push(this);
    }
    start(track?: MediaStreamTrack) {
      this.track = track;
      this.started = true;
    }
    stop() {
      this.stops++;
    }
    abort() {
      this.aborts++;
    }
    // What Chrome does:
    begin() {
      this.onstart?.();
    }
    say(results: [string, boolean][], resultIndex = 0) {
      this.onresult?.({
        resultIndex,
        results: results.map(([transcript, isFinal]) => ({
          isFinal,
          length: 1,
          0: { transcript },
        })),
      });
    }
    error(error: string) {
      this.onerror?.({ error });
    }
    end() {
      this.onend?.();
    }
  }
  return { Recognition: FakeRecognition, instances };
}

/** A microphone getUserMedia double: every stream it opened, as one live track each. */
export function fakeMicrophone(
  before?: (constraints: MediaStreamConstraints) => Promise<void>,
) {
  const tracks: FakeTrack[] = [];
  const constraints: MediaStreamConstraints[] = [];
  return {
    tracks,
    constraints,
    getUserMedia: async (asked: MediaStreamConstraints) => {
      constraints.push(asked);
      await before?.(asked);
      const track: FakeTrack = {
        readyState: "live",
        onended: null,
        stop() {
          this.readyState = "ended";
        },
      };
      tracks.push(track);
      return {
        getTracks: () => [track],
        getAudioTracks: () => [track],
      } as unknown as MediaStream;
    },
  };
}
