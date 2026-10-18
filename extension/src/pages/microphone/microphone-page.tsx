import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Page } from "../ui/page";

type Outcome = "idle" | "asking" | "granted" | "visit-only" | "denied";

const SENTENCE = {
  granted: "Microphone allowed. You can close this tab.",
  "visit-only":
    "Chrome allowed the microphone for this visit only. Choose Allow microphone again and pick Allow while visiting the site.",
  denied:
    "Chrome blocked the microphone. Open chrome://settings/content/microphone, allow OpenBot Recorder, then try again.",
} as const;

async function permissionState(): Promise<PermissionState> {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state;
  } catch {
    return "prompt";
  }
}

/**
 * Asks Chrome for the microphone on the extension's own origin, where the grant lasts only if the
 * person picks "Allow while visiting the site". A one-time grant ends with this page and reads
 * `prompt` afterwards, which is how the page tells the two apart.
 */
export function MicrophonePage() {
  const [outcome, setOutcome] = useState<Outcome>("idle");

  const allow = async () => {
    setOutcome("asking");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      setOutcome("denied");
      return;
    }
    const state = await permissionState();
    setOutcome(
      state === "granted"
        ? "granted"
        : state === "denied"
          ? "denied"
          : "visit-only",
    );
  };

  return (
    <Page
      title="Allow the microphone"
      description="OpenBot keeps what you say while you record, transcribes it and sends the words to Intelligence with your steps, so Learning can tell why you did each one. When Chrome asks, choose Allow while visiting the site, not Allow this time: a one-time grant ends when this page closes, and the Recorder needs the microphone on later recordings too. You can change it in Chrome's site settings."
      width="prose"
    >
      <div className="mt-8">
        <Button size="lg" disabled={outcome === "asking"} onClick={allow}>
          Allow microphone
        </Button>
      </div>
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
