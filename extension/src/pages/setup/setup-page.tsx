import { IconMicrophone, IconMicrophoneOff } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-parts";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { microphoneState } from "../popup/voice";
import { Page } from "../ui/page";

type Status =
  | "checking"
  | "asking"
  | "granted"
  | "visit-only"
  | "dismissed"
  | "denied"
  | "no-microphone";

export type SetupPageDeps = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  microphoneState: () => Promise<PermissionState | null>;
  /** Edge names its settings pages edge://, not chrome://. */
  isEdge: () => boolean;
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
};

/** No microphone to open, or one another app holds: a prompt answered or not, nothing can be heard. */
const NO_DEVICE = new Set(["NotFoundError", "NotReadableError", "AbortError"]);

/** What each browser calls the lasting grant on its prompt: Chrome offers it beside a one-time "Allow this time", Edge
 * shows only Block and Allow. */
type Browser = { settings: string; lasting: string; hint: string };
const CHROME: Browser = {
  settings: "chrome://settings/content/microphone",
  lasting: "Allow while visiting the site",
  hint: "When Chrome asks, choose Allow while visiting the site, not Allow this time: the Recorder listens from a page you do not see, which can use only a lasting grant.",
};
const EDGE: Browser = {
  settings: "edge://settings/content/microphone",
  lasting: "Allow",
  hint: "When Edge asks, choose Allow: the Recorder listens from a page you do not see, which can use only a lasting grant.",
};

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

/**
 * The page a fresh install opens: it asks for the microphone on the extension's own origin as soon as it loads, with a
 * button to ask again, and says in plain words what the browser answered. The Recorder listens from its hidden
 * offscreen document, which cannot show a prompt and can use only a lasting grant (Chrome's "Allow while visiting the
 * site", Edge's "Allow"); a
 * one-time grant ends with this page and reads `prompt` afterwards, which is how the page tells the two apart. Website
 * access needs nothing here: the install granted it.
 */
export function SetupPage({ deps }: { deps?: Partial<SetupPageDeps> }) {
  const [d] = useState(() => ({ ...defaults, ...deps }));
  const [status, setStatus] = useState<Status>("checking");
  const asked = useRef(false);

  const ask = async () => {
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

  // Asked once, when the page opens: a blocked microphone shows no prompt, and one already allowed needs nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on load; `ask` reads only the fixed seams.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    d.microphoneState().then((state) => {
      if (state === "granted") setStatus("granted");
      else if (state === "denied") setStatus("denied");
      else void ask();
    });
  }, []);

  const browser = d.isEdge() ? EDGE : CHROME;
  // Every answer short of a lasting grant: the row says why in red and offers to ask again.
  const problem =
    status === "visit-only" ||
    status === "dismissed" ||
    status === "denied" ||
    status === "no-microphone";

  return (
    <Page
      title="Allow the microphone"
      description="Talk through what you do while you record. Your browser turns your words into text, and the Recorder sends only the text to Intelligence with your steps, so Learning knows why you did each one. The Recorder keeps no recording of your voice, and you can mute it in any recording. Without the microphone it still records, with no narration."
      width="prose"
    >
      <PageSection>
        <PageRows>
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
                className={
                  problem
                    ? "line-clamp-none text-destructive"
                    : "line-clamp-none"
                }
                role={problem ? "alert" : "status"}
              >
                {sentence(status, browser)}
              </ItemDescription>
            </ItemContent>
            {problem ? (
              <ItemActions>
                <Button size="sm" onClick={ask}>
                  Allow microphone
                </Button>
              </ItemActions>
            ) : null}
          </Item>
        </PageRows>
      </PageSection>
      {status === "granted" ? null : (
        <p className="mt-4 text-muted-foreground text-sm">{browser.hint}</p>
      )}
    </Page>
  );
}
