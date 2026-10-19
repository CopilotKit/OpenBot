import { useState } from "react";
import { Button } from "@/components/ui/button";
import { microphoneState } from "../popup/voice";
import { Page } from "../ui/page";

type Outcome = "idle" | "asking" | "granted" | "visit-only" | "denied";

const SENTENCE = {
  granted:
    "Microphone allowed. Go back to the tab you want to record and press Record.",
  "visit-only":
    "Chrome allowed the microphone for this visit only. Choose Allow microphone again and pick Allow while visiting the site.",
  denied:
    "Chrome blocked the microphone. Open chrome://settings/content/microphone, allow OpenBot Recorder, then try again.",
} as const;

export type MicrophonePageDeps = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  microphoneState: () => Promise<PermissionState | null>;
};

const defaults: MicrophonePageDeps = {
  getUserMedia: (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
  microphoneState,
};

/**
 * Asks Chrome for the microphone on the extension's own origin, on a visible tab: the Recorder listens from its hidden
 * offscreen document, which cannot show a prompt and can use only a lasting grant ("Allow while visiting the site"). A
 * one-time grant ends with this page and reads `prompt` afterwards, which is how the page tells the two apart.
 */
export function MicrophonePage({
  deps,
}: {
  deps?: Partial<MicrophonePageDeps>;
}) {
  const d = { ...defaults, ...deps };
  const [outcome, setOutcome] = useState<Outcome>("idle");

  const allow = async () => {
    setOutcome("asking");
    try {
      const stream = await d.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      setOutcome("denied");
      return;
    }
    const state = await d.microphoneState();
    setOutcome(
      state === "granted"
        ? "granted"
        : state === "denied"
          ? "denied"
          : "visit-only",
    );
  };

  const asking =
    outcome === "idle" ||
    outcome === "asking" ||
    outcome === "denied" ||
    outcome === "visit-only";

  return (
    <Page
      title="Allow the microphone"
      description="Talk through what you do while you record. The browser's own speech recognition turns your words into text, and the Recorder sends only the text to Intelligence with your steps, so Learning knows why you did each one. The Recorder keeps no recording of your voice. When Chrome asks, choose Allow while visiting the site, not Allow this time: the Recorder listens from a page you do not see, which can use only a lasting grant. You can mute it during any recording."
      width="prose"
    >
      {asking ? (
        <div className="mt-8 flex gap-2">
          <Button size="lg" disabled={outcome === "asking"} onClick={allow}>
            Allow microphone
          </Button>
          <Button size="lg" variant="ghost" onClick={() => window.close()}>
            Not now
          </Button>
        </div>
      ) : null}
      {outcome === "granted" ||
      outcome === "visit-only" ||
      outcome === "denied" ? (
        <p
          className={
            outcome === "granted"
              ? "mt-4 text-sm"
              : "mt-4 text-destructive text-sm"
          }
          role={outcome === "granted" ? "status" : "alert"}
        >
          {SENTENCE[outcome]}
        </p>
      ) : null}
    </Page>
  );
}
