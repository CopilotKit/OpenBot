import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  DictationButton,
  DictationSurface,
} from "@/components/channels/composer/dictation-controls";
import type { DictationState } from "@/lib/dictation/session";
import { pressOrb } from "@/skins/openduet/orb-dictation";
import { settleReactWork } from "./settle-react-work";

/*
 * OpenDuet's mic orb has no dictation of its own: it presses the composer's, by the names OpenBot's
 * dictation controls carry, so the recording, the waveform and the words landing in the draft are
 * all OpenBot's. These render OpenBot's real controls and press the orb over them, so a renamed
 * control fails here rather than leaving an orb that silently does nothing.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function dictation(phase: DictationState["phase"]) {
  const session = {
    start: mock(async () => {}),
    finish: mock(async () => {}),
    cancel: mock(() => {}),
    retry: mock(async () => {}),
  };
  const state: DictationState = { phase, seconds: 3, canRetry: false };
  return {
    session,
    value: {
      session,
      state,
      available: true,
      supported: true,
      busy: phase !== "idle",
    } as never,
  };
}

test("pressing the orb starts the composer's own dictation", () => {
  const { session, value } = dictation("idle");
  const view = render(
    <DictationSurface canSend dictation={value}>
      <DictationButton dictation={value} disabled={false} />
    </DictationSurface>,
  );
  expect(pressOrb(view.container)).toBe("started");
  expect(session.start).toHaveBeenCalledTimes(1);
});

test("pressing the orb while the composer records stops it and puts the words in the draft", () => {
  const { session, value } = dictation("recording");
  const view = render(
    <DictationSurface canSend dictation={value}>
      <DictationButton dictation={value} disabled={false} />
    </DictationSurface>,
  );
  expect(pressOrb(view.container)).toBe("stopped");
  expect(session.finish).toHaveBeenCalledWith("draft");
  expect(session.start).not.toHaveBeenCalled();
});

test("where the composer cannot dictate, the orb presses nothing", () => {
  const { session, value } = dictation("idle");
  const view = render(<DictationButton dictation={value} disabled />);
  expect(pressOrb(view.container)).toBe("none");
  expect(session.start).not.toHaveBeenCalled();
});

test("with no composer on screen, the orb reports it has nothing to press", () => {
  const view = render(<p>Tasks</p>);
  expect(pressOrb(view.container)).toBe("none");
});
