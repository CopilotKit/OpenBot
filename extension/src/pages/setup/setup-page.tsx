import {
  installOnDeviceSpeech,
  type OnDeviceSpeech,
  onDeviceSpeech,
} from "@openbot/shared/on-device-speech";
import {
  IconMicrophone,
  IconMicrophoneOff,
  IconWaveSine,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-parts";
import { RecorderCollectsRows } from "@/components/recorder/recorder-collects";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { PageResponse } from "../../protocol/messages";
import { narrationLanguage } from "../../shared/speech-language";
import { microphoneState } from "../popup/voice";
import { DISCLOSURE, DISCLOSURE_TITLE } from "../ui/disclosure";
import { Page } from "../ui/page";
import { ask } from "../ui/runtime";

type Status =
  | "checking"
  | "asking"
  | "granted"
  | "visit-only"
  | "dismissed"
  | "denied"
  | "no-microphone";

type Choice = "on" | "off" | null;

export type SetupPageDeps = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  microphoneState: () => Promise<PermissionState | null>;
  /** Edge names its settings pages edge://, not chrome://. */
  isEdge: () => boolean;
  /** The browser's speech recognition (`SpeechRecognition`), asked whether it can keep speech on the computer. */
  Recognition: unknown;
  /** The language narration is heard in until a page says its own: the browser's. */
  language: () => string;
  /** The person's choice to narrate, as the Recorder keeps it: null until they made one. */
  narration: () => Promise<Choice>;
  setNarration: (on: boolean) => Promise<void>;
  /** How long a download under way waits before the browser is asked again. */
  downloadPollMs?: number;
};

type BrandedNavigator = Navigator & {
  userAgentData?: { brands?: { brand: string }[] };
};

const defaults: SetupPageDeps = {
  getUserMedia: (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
  microphoneState,
  isEdge: () =>
    (navigator as BrandedNavigator).userAgentData?.brands?.some(
      (entry) => entry.brand === "Microsoft Edge",
    ) ?? /\bEdg\//.test(navigator.userAgent),
  Recognition: (globalThis as { SpeechRecognition?: unknown })
    .SpeechRecognition,
  language: () => narrationLanguage(null, navigator.language),
  narration: async () => {
    const answer = await ask<PageResponse>({ type: "page.state" });
    return answer.ok && "narration" in answer ? answer.narration : null;
  },
  setNarration: async (on) => {
    await ask({ type: "page.narration", on });
  },
};

/** No microphone to open, or one another app holds: a prompt answered or not, nothing can be heard. */
const NO_DEVICE = new Set(["NotFoundError", "NotReadableError", "AbortError"]);

/** What each browser calls the lasting grant on its prompt: Chrome offers it beside a one-time "Allow this time", Edge
 * shows only Block and Allow. */
type Browser = {
  name: string;
  settings: string;
  lasting: string;
  hint: string;
};
const CHROME: Browser = {
  name: "Chrome",
  settings: "chrome://settings/content/microphone",
  lasting: "Allow while visiting the site",
  hint: "When Chrome asks, choose Allow while visiting the site, not Allow this time: the Recorder listens from a page you do not see, which can use only a lasting grant.",
};
const EDGE: Browser = {
  name: "Edge",
  settings: "edge://settings/content/microphone",
  lasting: "Allow",
  hint: "When Edge asks, choose Allow: the Recorder listens from a page you do not see, which can use only a lasting grant.",
};

const NARRATION =
  "Talk through what you do while you record, and the Recorder adds what you say to your steps as text, so Learning knows why you did each one. Your browser turns your words into text on your own computer: your voice never leaves it, and the Recorder keeps no recording of it. Without narration the Recorder still records.";

function sentence(status: Status, browser: Browser): string {
  switch (status) {
    case "checking":
      return "Checking the microphone";
    case "asking":
      return "Waiting for your answer in the browser's prompt";
    case "granted":
      return "Allowed. You can close this tab and press Record in the Recorder whenever you are ready.";
    case "visit-only":
      return `Allowed for this visit only, so the Recorder could not listen while you record. Choose Allow microphone and pick ${browser.lasting}.`;
    case "dismissed":
      return "Not allowed yet. Choose Allow microphone and answer the browser's prompt.";
    case "denied":
      return `Blocked. Open ${browser.settings}, allow OpenBot Recorder, then choose Allow microphone.`;
    case "no-microphone":
      return "No microphone was found, or another app is using it. Connect one, then choose Allow microphone.";
  }
}

function languageName(language: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(language) ??
      language
    );
  } catch {
    return language;
  }
}

/** What the speech recognition row says, from what the browser answered about keeping speech on the computer. */
function speechSentence(
  speech: OnDeviceSpeech | "checking",
  language: string,
  browser: Browser,
): string {
  const spoken = languageName(language);
  switch (speech) {
    case "checking":
      return `Checking whether ${browser.name} can turn speech into text on your computer`;
    case "available":
      return `${browser.name} turns your ${spoken} speech into text on your computer. Your voice never leaves it.`;
    case "downloading":
      return `Downloading ${browser.name}'s ${spoken} speech recognition to your computer`;
    case "downloadable":
      return `${browser.name} has to download its ${spoken} speech recognition to your computer first. Choose Download.`;
    case "unavailable":
      return `${browser.name} cannot turn ${spoken} speech into text on your computer, so the Recorder cannot narrate here. It still records.`;
    case "unsupported":
      return `This version of ${browser.name} cannot turn speech into text on your computer, so the Recorder cannot narrate here. It still records.`;
  }
}

/**
 * The page a fresh install opens: it says first what the Recorder collects and where it goes (the store's prominent
 * disclosure, ui/disclosure.ts), as its heading, with the list of what a recording holds, before anything is recorded.
 * Then narration, which the person chooses: the Recorder opens no microphone until they turn it on, here or in the
 * Record form, and the choice is kept for every recording.
 *
 * Turning it on asks, on that one click, for the two things only a click can get: the microphone, on the extension's own
 * origin (the Recorder listens from its hidden offscreen document, which cannot show a prompt and can use only a lasting
 * grant, Chrome's "Allow while visiting the site", Edge's "Allow"; a one-time grant ends with this page and reads
 * `prompt` afterwards, which is how the page tells the two apart), and the browser's speech recognition for the
 * person's language on their own computer (@openbot/shared/on-device-speech), which the browser downloads or unmasks
 * only on a click. Where the browser cannot keep speech on the computer, the page says so: the Recorder never sends a
 * voice anywhere. Website access needs nothing here: the install granted it.
 */
export function SetupPage({ deps }: { deps?: Partial<SetupPageDeps> }) {
  const [d] = useState(() => ({ ...defaults, ...deps }));
  const [choice, setChoice] = useState<Choice | undefined>();
  const [status, setStatus] = useState<Status>("checking");
  const [speech, setSpeech] = useState<OnDeviceSpeech | "checking">("checking");
  const asked = useRef(false);
  const language = d.language();

  const checkSpeech = async () =>
    setSpeech(await onDeviceSpeech(d.Recognition, language));

  // A download under way: asked again until it is done.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `checkSpeech` reads only the fixed seams.
  useEffect(() => {
    if (speech !== "downloading") return;
    const timer = setTimeout(
      () => void checkSpeech(),
      d.downloadPollMs ?? 3_000,
    );
    return () => clearTimeout(timer);
  }, [speech]);

  /** On the person's click: the browser downloads (or unmasks) the language only on one. */
  const download = () => {
    const installing = installOnDeviceSpeech(d.Recognition, language);
    setSpeech((current) =>
      current === "unsupported" || current === "unavailable"
        ? current
        : "downloading",
    );
    void installing.then(() => checkSpeech());
  };

  const askMicrophone = async () => {
    setStatus("asking");
    try {
      const stream = await d.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (NO_DEVICE.has(name)) {
        setStatus("no-microphone");
        return;
      }
      // Refused: blocked for good, or the prompt closed with no answer.
      setStatus(
        (await d.microphoneState()) === "denied" ? "denied" : "dismissed",
      );
      return;
    }
    const state = await d.microphoneState();
    setStatus(
      state === "granted"
        ? "granted"
        : state === "denied"
          ? "denied"
          : "visit-only",
    );
  };

  /** The microphone as the browser has it, asked for when it can still be: a blocked one shows no prompt, and one
   * already allowed needs nothing. */
  const followMicrophone = async () => {
    const state = await d.microphoneState();
    if (state === "granted") setStatus("granted");
    else if (state === "denied") setStatus("denied");
    else await askMicrophone();
  };

  const turnOn = () => {
    // The download first, while the click still counts for it; the microphone's prompt needs no click.
    download();
    setChoice("on");
    void d.setNarration(true);
    void followMicrophone();
  };

  const turnOff = () => {
    setChoice("off");
    void d.setNarration(false);
  };

  // The choice the person made before, read once: on, the page carries on where it left off, asking for the microphone
  // as it opens, as it always has.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on load; it reads only the fixed seams.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void d.narration().then((made) => {
      setChoice(made);
      if (made !== "on") return;
      void checkSpeech();
      void followMicrophone();
    });
  }, []);

  const browser = d.isEdge() ? EDGE : CHROME;
  // Every answer short of a lasting grant: the row says why and offers to ask again, under the sentence (as the popup's
  // Voice row does) so a narrow window never squeezes the words beside the button.
  const problem =
    status === "visit-only" ||
    status === "dismissed" ||
    status === "denied" ||
    status === "no-microphone";

  return (
    // The store's disclosure is the page's own heading, so it is the first thing the person reads, before the
    // microphone is asked for and before anything is recorded.
    <Page title={DISCLOSURE_TITLE} description={DISCLOSURE} width="prose">
      <RecorderCollectsRows />
      <PageSection title="Narration" description={NARRATION}>
        {choice === undefined ? null : (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                {choice === "on" ? <IconMicrophone /> : <IconMicrophoneOff />}
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Narration</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {choice === null
                    ? "Choose whether the Recorder listens to you while you record. You can change it before any recording."
                    : choice === "on"
                      ? "On. The Recorder listens while you record, and you can mute it in any recording."
                      : "Off. The Recorder never opens your microphone."}
                </ItemDescription>
              </ItemContent>
              {choice === null ? (
                <ItemFooter className="justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={turnOff}>
                    Not now
                  </Button>
                  <Button size="sm" onClick={turnOn}>
                    Turn on narration
                  </Button>
                </ItemFooter>
              ) : (
                <ItemActions>
                  {/* Binary and immediate: on asks for what it needs at once, off closes nothing it opened. */}
                  <Switch
                    aria-label="Narration"
                    checked={choice === "on"}
                    onCheckedChange={(on) => (on ? turnOn() : turnOff())}
                  />
                </ItemActions>
              )}
            </Item>
            {choice === "on" ? (
              <>
                <Separator />
                <Item size="sm">
                  <ItemMedia variant="icon">
                    {status === "granted" ? (
                      <IconMicrophone />
                    ) : (
                      <IconMicrophoneOff />
                    )}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>Microphone</ItemTitle>
                    <ItemDescription
                      className="line-clamp-none"
                      role={problem ? "alert" : "status"}
                    >
                      {sentence(status, browser)}
                    </ItemDescription>
                  </ItemContent>
                  {problem ? (
                    <ItemFooter className="justify-end">
                      <Button size="sm" onClick={askMicrophone}>
                        Allow microphone
                      </Button>
                    </ItemFooter>
                  ) : null}
                </Item>
                <Separator />
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconWaveSine />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>Speech to text</ItemTitle>
                    <ItemDescription
                      className="line-clamp-none"
                      role={
                        speech === "unavailable" || speech === "unsupported"
                          ? "alert"
                          : "status"
                      }
                    >
                      {speechSentence(speech, language, browser)}
                    </ItemDescription>
                  </ItemContent>
                  {speech === "downloadable" ? (
                    <ItemFooter className="justify-end">
                      <Button size="sm" onClick={download}>
                        Download
                      </Button>
                    </ItemFooter>
                  ) : null}
                </Item>
              </>
            ) : null}
          </PageRows>
        )}
      </PageSection>
      {/* How to answer the prompt, while there is one to answer: not once allowed, blocked or without a microphone. */}
      {choice !== "on" ||
      status === "granted" ||
      status === "denied" ||
      status === "no-microphone" ? null : (
        <p className="mt-4 text-muted-foreground text-sm">{browser.hint}</p>
      )}
    </Page>
  );
}
