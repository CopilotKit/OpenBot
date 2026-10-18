import type { BackgroundToContent } from "../protocol/messages";
import { startEventCapture } from "./collector";
import { createSensitivityTracker } from "./masking-context";
import { isNoticeEvent, showNotice } from "./notice";
import { contentHello, createContentPort } from "./port";
import { startStepCapture } from "./steps";

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
    const steps = startStepCapture({
      send: (action) => port.post({ type: "content.step", action }),
      isIgnored: isNoticeEvent,
    });
    capture = {
      stop() {
        steps.stop();
        events.stop();
        uninstall();
      },
    };
  };
  const stopCapture = () => {
    capture?.stop();
    capture = null;
  };

  let notice: { remove(): void } | null = null;
  const onNotice = (
    message: Extract<BackgroundToContent, { type: "background.notice" }>,
  ) => {
    if (window !== window.top) return;
    notice?.remove();
    notice = null;
    if (!message.show) return;
    notice = showNotice({
      steps: message.steps,
      choose: (choice) => port.post({ type: "content.notice", choice }),
    });
  };

  if (flags.__openbotRecorderActive) startCapture();
  port.onMessage((message) => {
    if (message.type === "background.capture") {
      if (message.active) startCapture();
      else stopCapture();
    } else onNotice(message);
  });
}

startContentScript();
