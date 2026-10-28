import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import {
  DictationButton,
  DictationSurface,
} from "@/components/channels/composer/dictation-controls";
import type { DictationState } from "@/lib/dictation/session";
import {
  EDITOR_SELECTOR,
  pressOrb,
  useComposerPresence,
} from "@/skins/openduet/orb-dictation";
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

/** What the orb reads from the composer drawn inside it. */
function Presence({ root }: { root: HTMLElement | null }) {
  const presence = useComposerPresence(root);
  return (
    <output
      data-recording={presence.recording}
      data-working={presence.working}
    />
  );
}

/*
 * Found live: the orb rested while a Bot browsed with its computer, because it only read the
 * roster's busy flag, which comes over the socket and missed the person's own run. The composer
 * draws its Stop control for exactly as long as a turn runs, so the orb reads that.
 */
test("the orb reads the Bot as working for as long as the real composer offers to stop it", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const probe = render(<Presence root={host} />);
  const output = () => probe.container.querySelector("output");
  const composer = render(
    <Composer compact onStop={() => {}} onSubmit={() => {}} pending />,
    { container: host },
  );
  await waitFor(() => expect(output()?.dataset.working).toBe("true"), {
    timeout: 2_000,
  });
  composer.rerender(
    <Composer compact onStop={() => {}} onSubmit={() => {}} pending={false} />,
  );
  await waitFor(() => expect(output()?.dataset.working).toBe("false"));
  host.remove();
});

/*
 * Found live: opening any conversation flashed the orb's "Thinking" for half a second, because the
 * composer shows Stop for a moment while it checks for a turn already running. A Stop that comes
 * and goes that quickly is not the Bot working.
 */
test("a Stop the composer shows only for a moment does not make the orb think", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const probe = render(<Presence root={host} />);
  const output = () => probe.container.querySelector("output");
  const composer = render(
    <Composer compact onStop={() => {}} onSubmit={() => {}} pending />,
    { container: host },
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  composer.rerender(
    <Composer compact onStop={() => {}} onSubmit={() => {}} pending={false} />,
  );
  const seen = new Set<string | undefined>();
  for (let i = 0; i < 10; i++) {
    seen.add(output()?.dataset.working);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect([...seen]).toEqual(["false"]);
  host.remove();
});

/*
 * The orb finds the composer by OpenBot's `composer-input` hook, and puts the caret in its editor
 * where it cannot dictate. This holds that selector to the real composer's editor.
 */
test("the orb finds the real composer's editor by its hook", () => {
  const view = render(<Composer compact onSubmit={() => {}} />);
  const editor = view.container.querySelector(EDITOR_SELECTOR);
  expect(editor).not.toBeNull();
  expect(editor?.getAttribute("aria-label")).toBe("Message");
});
