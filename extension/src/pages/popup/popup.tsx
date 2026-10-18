import type { RecorderBot } from "@openbot/shared/recorder-api";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  PageResponse,
  PageStateResponse,
  PageToBackground,
} from "../../protocol/messages";
import { readLocal } from "../../shared/storage";
import { Page } from "../ui/page";
import { ask as askBackground } from "../ui/runtime";
import { microphoneState as defaultMicrophoneState } from "./media";
import { Notices } from "./notices";
import { prepareRecording } from "./prepare";
import { RecordForm } from "./record-form";
import { AfterStop, isStopPending, RecordingView } from "./recording-view";

export type PopupDeps = {
  prepare: typeof prepareRecording;
  ask: typeof askBackground;
  activeTabId: () => Promise<number>;
  microphoneState: typeof defaultMicrophoneState;
  lastBotId: () => Promise<string | undefined>;
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

const openTab = (url: string) => chrome.tabs.create({ url });

/** The toolbar popup: sign-in state, Bot choice and the Record form. */
export function Popup({ deps }: { deps?: Partial<PopupDeps> }) {
  const ask = deps?.ask ?? askBackground;
  const prepare = deps?.prepare ?? prepareRecording;
  const tabId = deps?.activeTabId ?? activeTabId;
  const microphoneState = deps?.microphoneState ?? defaultMicrophoneState;
  // Read once when the popup opens, so the seam is fixed at mount.
  const [readLastBotId] = useState(
    () => deps?.lastBotId ?? (() => readLocal("lastBotId")),
  );
  const [view, setView] = useState<PageStateResponse | null>(null);
  const [bots, setBots] = useState<RecorderBot[]>([]);
  const [desktop, setDesktop] = useState(false);
  const [microphone, setMicrophone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastBotId, setLastBotId] = useState<string | null>(null);
  const [shownBotId, setShownBotId] = useState("");

  const refresh = useCallback(async () => {
    const answer = await ask<PageResponse>({ type: "page.state" });
    if (!answer.ok) {
      setError(answer.error);
      return;
    }
    if (!("state" in answer)) return;
    setView(answer);
    if (answer.connection) {
      const list = await ask<PageResponse>({ type: "page.bots" });
      if (list.ok && "bots" in list) setBots(list.bots);
      else if (!list.ok) setError(list.error);
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

  useEffect(() => {
    let live = true;
    readLastBotId().then((id) => {
      if (live && id) setLastBotId(id);
    });
    return () => {
      live = false;
    };
  }, [readLastBotId]);

  useEffect(() => {
    let live = true;
    microphoneState().then((state) => {
      if (live) setMicrophone(state === "granted");
    });
    return () => {
      live = false;
    };
  }, [microphoneState]);

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
        <Notices
          notice={view.notice}
          kept={state.kept}
          onDismiss={() => dismiss()}
        />
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
                const answer = await ask({ type: "page.connect.desktop" });
                if (!answer.ok) setError(answer.error);
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

  async function dismiss() {
    await ask({ type: "page.notice.dismiss" });
    await refresh();
  }

  const record = async (botId: string, title: string, replaceOpen = false) => {
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepare();
      if (!prepared.ok) {
        setError(
          "Allow website access in the tab that opened, then press Record again.",
        );
        return;
      }
      const answer = await ask({
        type: "page.record",
        botId,
        title,
        tabId: await tabId(),
        microphone: prepared.microphone,
        ...(replaceOpen ? { replaceOpen: true } : {}),
      });
      if (!answer.ok) setError(answer.error);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
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
  const stopPending = isStopPending(state.error);

  const refusedBotId = state.openRecording
    ? (state.botId ?? lastBotId ?? undefined)
    : undefined;
  // The open-recording refusal is about one Bot: another picked Bot neither shows it nor offers the stop.
  const refusalIsForAnotherBot =
    refusedBotId !== undefined &&
    shownBotId !== "" &&
    shownBotId !== refusedBotId;
  const shownError = refusalIsForAnotherBot
    ? null
    : (error ?? state.error ?? null);
  return (
    <Page
      title={connection.user.name}
      description={new URL(connection.openbotUrl).host}
      width="popup"
    >
      <Notices notice={view.notice} kept={state.kept} onDismiss={dismiss} />
      {state.phase === "idle" ? (
        <AfterStop
          state={state}
          openbotUrl={connection.openbotUrl}
          onDiscard={() => act({ type: "page.kept.discard" })}
          openTab={openTab}
        />
      ) : (
        <RecordingView
          state={state}
          busy={busy}
          actions={{
            onStop: () => act({ type: "page.stop" }),
            onRestart: () => act({ type: "page.restart" }),
            onNotice: (choice) => act({ type: "page.notice", choice }),
            onRecordScreen: () => act({ type: "page.screen" }),
          }}
        />
      )}
      {state.phase === "idle" && !stopPending ? (
        <RecordForm
          bots={bots}
          initialBotId={
            state.openRecording ? (state.botId ?? lastBotId) : lastBotId
          }
          openRecordingBotId={refusedBotId}
          onBotChange={setShownBotId}
          transcription={view.me?.capabilities.transcription ?? true}
          microphoneGranted={microphone}
          busy={busy}
          onRecord={(botId, title, options) =>
            record(botId, title, options?.replaceOpen)
          }
          onAllowMicrophone={() =>
            openTab(chrome.runtime.getURL("microphone.html"))
          }
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
