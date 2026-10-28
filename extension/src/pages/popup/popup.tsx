import { installOnDeviceSpeech } from "@openbot/shared/on-device-speech";
import type { LearningSpaceState } from "@openbot/shared/recorder-api";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  PageResponse,
  PageStateResponse,
  PageToBackground,
} from "../../protocol/messages";
import { narrationLanguage } from "../../shared/speech-language";
import { Page } from "../ui/page";
import { ask as askBackground } from "../ui/runtime";
import { desktopSentence } from "./desktop-sentence";
import { Notices } from "./notices";
import { RecordForm } from "./record-form";
import {
  AfterStop,
  afterStopLearningSentence,
  RecordingView,
} from "./recording-view";
import {
  microphoneState as defaultMicrophoneState,
  pageLanguage as defaultPageLanguage,
} from "./voice";

type PopupDeps = {
  ask: typeof askBackground;
  activeTabId: () => Promise<number>;
  pageLanguage: (tabId: number) => Promise<string | null>;
  browserLanguage: () => string;
  microphoneState: () => Promise<PermissionState | null>;
  /** The browser's speech recognition, which downloads a language for on-device recognition on the person's click. */
  Recognition: unknown;
};

/** The active tab; in the e2e variant only, the tab named by RECORDER_E2E_TARGET_TAB (Playwright cannot click the toolbar). */
async function activeTabId(): Promise<number> {
  if (import.meta.env.RECORDER_VARIANT === "e2e") {
    const target = Number(
      new URLSearchParams(location.search).get("RECORDER_E2E_TARGET_TAB"),
    );
    if (Number.isInteger(target) && target > 0) return target;
  }
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (tab?.id === undefined) throw new Error("No active tab");
  return tab.id;
}

const openTab = (url: string) => {
  void chrome.tabs.create({ url });
};

/**
 * The toolbar popup. Signed out: how to connect, plus any recordings kept in this browser (with Discard). Connected:
 * the title and Record (every recording goes into the person's own Learning space); while recording, time, actions,
 * the capture rows, Stop and Start over; after Stop, that the recording went to Intelligence and into their Learning
 * space, and what is still sending or kept.
 */
export function Popup({ deps }: { deps?: Partial<PopupDeps> }) {
  const ask = deps?.ask ?? askBackground;
  const tabId = deps?.activeTabId ?? activeTabId;
  const readPageLanguage = deps?.pageLanguage ?? defaultPageLanguage;
  const browserLanguage = deps?.browserLanguage ?? (() => navigator.language);
  const [readMicrophone] = useState(
    () => deps?.microphoneState ?? defaultMicrophoneState,
  );
  const Recognition =
    deps && "Recognition" in deps
      ? deps.Recognition
      : (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
  /** On the person's click, while it still counts: the browser downloads (or unmasks) a language for recognition on
   * their own computer only on one (@openbot/shared/on-device-speech). Not waited for: the Voice row says while it
   * downloads, and voice starts once it is there. */
  const getSpeech = (language: string) =>
    void installOnDeviceSpeech(Recognition, language);
  const [view, setView] = useState<PageStateResponse | null>(null);
  const [learning, setLearning] = useState<LearningSpaceState | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [microphone, setMicrophone] = useState<PermissionState | null>(null);

  const refresh = useCallback(async () => {
    const answer = await ask<PageResponse>({ type: "page.state" });
    if (!answer.ok) {
      setError(answer.error);
      return;
    }
    if (!("state" in answer)) return;
    setView(answer);
    if (answer.connection) {
      const space = await ask<PageResponse>({ type: "page.learning" });
      if (space.ok && "learning" in space) setLearning(space.learning);
      else if (!space.ok) setError(space.error);
    } else {
      const probe = await ask<PageResponse>({
        type: "page.desktop.available",
      });
      setDesktop(probe.ok && "available" in probe && probe.available);
    }
  }, [ask]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // While a recording runs or the last of one is still sending, the state keeps changing under the popup.
  const live =
    view !== null && (view.state.phase !== "idle" || view.state.draining > 0);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    const timer = setInterval(async () => {
      const answer = await ask<PageResponse>({ type: "page.state" });
      if (alive && answer.ok && "state" in answer) setView(answer);
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [live, ask]);

  // Read when the popup opens: the Record form offers the setup page when the microphone is not allowed.
  useEffect(() => {
    let mounted = true;
    readMicrophone().then((state) => {
      if (mounted) setMicrophone(state);
    });
    return () => {
      mounted = false;
    };
  }, [readMicrophone]);

  const dismiss = async () => {
    await ask({ type: "page.notice.dismiss" });
    await refresh();
  };

  const act = async (message: PageToBackground) => {
    setBusy(true);
    setError(null);
    try {
      const answer = await ask(message);
      if (!answer.ok) setError(answer.error);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const discardKept = () => act({ type: "page.kept.discard" });

  if (!view) {
    return (
      <Page title="OpenBot Recorder" width="popup">
        {error ? <ErrorLine message={error} /> : null}
      </Page>
    );
  }

  const { connection, policy, state } = view;

  if (!connection) {
    const openAddress = !policy.invalid ? policy.openbotUrl : null;
    return (
      <Page
        title="Connect the Recorder to OpenBot"
        description="Open OpenBot, go to Settings, Browsers, and choose Connect this browser."
        width="popup"
      >
        <Notices notice={view.notice} kept={state.kept} onDismiss={dismiss} />
        {/* Signed out with recordings kept for the person (Decision 19): how to send them, or Discard. */}
        <AfterStop state={state} connected={false} onDiscard={discardKept} />
        {policy.invalid ? (
          <p className="mt-4 text-muted-foreground text-sm">
            Your organization's Recorder policy names an OpenBot address the
            Recorder cannot use. Ask your IT team.
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-2">
          {openAddress ? (
            <Button
              size="lg"
              onClick={() => {
                const origin = new URL(openAddress);
                openTab(`${origin.origin}/settings/browsers`);
              }}
            >
              Open {new URL(openAddress).host}
            </Button>
          ) : null}
          {desktop ? (
            <Button
              size="lg"
              variant="secondary"
              onClick={async () => {
                setError(null);
                const answer = await ask<PageResponse>({
                  type: "page.connect.desktop",
                });
                // A good ping does not promise a good handoff: OpenBot Desktop says why it could not connect. Connected,
                // the refresh shows the Record form; there is no Connect page to confirm.
                if (!answer.ok) setError(answer.error);
                else if ("connected" in answer && !answer.connected)
                  setError(desktopSentence(answer.reason));
                await refresh();
              }}
            >
              Connect with OpenBot Desktop
            </Button>
          ) : null}
        </div>
        {error ? <ErrorLine message={error} /> : null}
      </Page>
    );
  }

  // Records at once: website access came with the install, and a recording without the microphone goes on (its Voice
  // row says so and offers the setup page). The popup never opens a tab or asks for a permission here.
  const record = async (title: string) => {
    setBusy(true);
    setError(null);
    try {
      const tab = await tabId();
      const language = narrationLanguage(
        await readPageLanguage(tab),
        browserLanguage(),
      );
      if (view.narration === "on") getSpeech(language);
      const answer = await ask({
        type: "page.record",
        title,
        tabId: tab,
        language,
      });
      if (!answer.ok) setError(answer.error);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // Only ever on the person's click: the setup page asks for the microphone on a tab they can see.
  const allowMicrophone = () => openTab(chrome.runtime.getURL("setup.html"));

  /** The person's choice to narrate, kept for every recording. On asks for the speech recognition of their own language
   * on this click, and for the microphone where the browser has not allowed it (on the setup page: a popup cannot show
   * the browser's prompt). */
  const chooseNarration = async (on: boolean) => {
    if (on) getSpeech(narrationLanguage(null, browserLanguage()));
    await act({ type: "page.narration", on });
    if (on && microphone !== "granted") allowMicrophone();
  };

  const shownError = error ?? state.error ?? null;
  return (
    <Page
      title={connection.user.name}
      description={new URL(connection.openbotUrl).host}
      width="popup"
    >
      <Notices notice={view.notice} kept={state.kept} onDismiss={dismiss} />
      {state.phase === "idle" ? (
        <AfterStop state={state} connected onDiscard={discardKept} />
      ) : (
        <RecordingView
          state={state}
          busy={busy}
          actions={{
            onStop: () => act({ type: "page.stop" }),
            onRestart: () => act({ type: "page.restart" }),
            onNotice: (choice) => act({ type: "page.notice", choice }),
            voice: {
              onMute: (muted) => act({ type: "page.voice", muted }),
              onAllowMicrophone: allowMicrophone,
              // The language the browser has to download, on this click, then voice on: it starts once it is there.
              onDownload: (language) => {
                getSpeech(language);
                void act({ type: "page.voice", muted: false });
              },
            },
          }}
        />
      )}
      {state.phase === "idle" ? (
        <RecordForm
          learning={learning}
          busy={busy}
          onRecord={record}
          learningShown={afterStopLearningSentence(state, true)}
          microphoneBlocked={microphone === "denied" || microphone === "prompt"}
          onAllowMicrophone={allowMicrophone}
          narration={view.narration}
          onNarration={(on) => void chooseNarration(on)}
        />
      ) : null}
      {shownError ? <ErrorLine message={shownError} /> : null}
    </Page>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p
      className="mt-4 flex items-start gap-1.5 text-destructive text-sm"
      role="alert"
    >
      <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
      {message}
    </p>
  );
}
