import type { BackgroundToContent } from "../protocol/messages";
import { startEventCapture } from "./collector";
import { showIndicator } from "./indicator";
import { createSensitivityTracker } from "./masking-context";
import { showNotice } from "./notice";
import { contentHello, createContentPort } from "./port";

type RecorderGlobals = typeof globalThis & {
  __openbotRecorderContent?: boolean;
  __openbotRecorderActive?: string;
};

/**
 * Injected by the service worker into each committed frame of a followed tab. A frame the worker flagged
 * (`__openbotRecorderActive`, set just before this script) starts capturing at once, without waiting for its
 * port, so nothing clicked or typed during the round trip is lost; any other frame starts on
 * `background.capture { active: true }`.
 */
function startContentScript() {
  const flags = globalThis as RecorderGlobals;
  if (flags.__openbotRecorderContent) return;
  flags.__openbotRecorderContent = true;

  const port = createContentPort();
  port.post(contentHello());

  let capture: { stop(): void } | null = null;
  const startCapture = () => {
    if (capture) return;
    const tracker = createSensitivityTracker();
    const uninstall = tracker.install();
    tracker.onSensitiveValue((digest) =>
      port.post({ type: "content.sensitive", digest }),
    );
    const events = startEventCapture({
      tracker,
      send: (event) => port.post({ type: "content.event", event }),
    });
    capture = {
      stop() {
        events.stop();
        uninstall();
      },
    };
  };
  let notice: { remove(): void } | null = null;
  const stopCapture = () => {
    capture?.stop();
    capture = null;
    // Capture stopping for any reason ends the 50-action notice: its buttons would otherwise act on a later recording.
    notice?.remove();
    notice = null;
  };

  // The recording mark, in the top frame alone: from the tab's first step until Stop, whatever the frame captures.
  let mark: ReturnType<typeof showIndicator> | null = null;
  const removeMark = () => {
    mark?.remove();
    mark = null;
  };
  const onMark = (
    message: Extract<BackgroundToContent, { type: "background.capture" }>,
  ) => {
    if (window !== window.top) return;
    if (message.site === undefined) {
      removeMark();
      return;
    }
    const view = {
      site: message.site,
      excluded: message.excluded === true,
      ...(message.narrating !== undefined
        ? { narrating: message.narrating }
        : {}),
    };
    if (mark) mark.update(view);
    else
      mark = showIndicator({
        view,
        choose: (recorded) => port.post({ type: "content.site", recorded }),
      });
  };

  const onNotice = (
    message: Extract<BackgroundToContent, { type: "background.notice" }>,
  ) => {
    if (window !== window.top) return;
    notice?.remove();
    notice = null;
    if (!message.show) return;
    notice = showNotice({
      actions: message.actions,
      choose: (choice) => port.post({ type: "content.notice", choice }),
    });
  };

  // The extension was updated or removed under this page: nothing captured here can reach it any more.
  port.onOrphaned(() => {
    stopCapture();
    removeMark();
  });
  if (flags.__openbotRecorderActive) startCapture();
  port.onMessage((message) => {
    if (message.type === "background.capture") {
      if (message.active) startCapture();
      else stopCapture();
      onMark(message);
    } else onNotice(message);
  });
}

startContentScript();
