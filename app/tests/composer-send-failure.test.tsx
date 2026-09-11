import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";

/**
 * WHAT A FAILED SEND DOES TO THE WORDS, WHICH UNTIL NOW COULD NOT BE ASKED AT ALL.
 *
 * `submitDraft` used to rethrow out of its own catch, and it has exactly two callers:
 * `handleFormSubmit`, which does `void submitDraft(value)`, and PromptArea's `onSubmit`, which
 * calls it and ignores the promise. Neither awaits and neither catches, so a failed send was an
 * unhandled rejection — which bun's runner reports as a failure of whichever test is running when
 * it surfaces. `composer-attachment-lifecycle.test.tsx` and `composer-queue-attachments.test.tsx`
 * each carry a note recording that they gave up on driving a failed send for exactly that reason.
 * They are the reason this file exists: with the rethrow gone the path is reachable, and these are
 * the two things it has to get right.
 *
 * NO `fetch` STUB AND NO CHANNEL. Neither test attaches anything, so nothing here goes near the
 * network — the failure being driven is the caller's `onSubmit` rejecting, which is the whole of
 * what a failed turn looks like from inside the composer.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `composer-paste.test.tsx` for the reason recorded there: bun walks every
 * file into one process, and a document another file tore down mid-run fails invisibly.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** The editor inside the composer: the element the words actually live in. */
function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector("[contenteditable]") as HTMLElement;
}

/** What is typed in the box, with the placeholder and the strip left out of it. */
function typedText(container: HTMLElement): string {
  return editorOf(container).textContent ?? "";
}

/**
 * A send whose answer this test hands out by hand.
 *
 * The whole question is what happens BETWEEN the press and the failure, so `onSubmit` has to be a
 * promise the test still holds when it starts asking.
 */
function deferredSend() {
  let fail!: (error: Error) => void;
  const settled = new Promise<void>((_, reject) => {
    fail = reject;
  });
  return {
    onSubmit: () => settled,
    /** Fail the send, and let the composer's own `catch` and `finally` run before returning. */
    async reject() {
      fail(new Error("the turn could not be started"));
      await act(async () => {
        await settled.catch(() => undefined);
      });
    },
  };
}

/**
 * Type into the editor the one way this suite can: an ordinary text paste.
 *
 * The caret is not decoration — PromptArea inserts at the selection and gives up when there is not
 * one. A clipboard carrying text and no file is declined by the composer's own capture-phase
 * listener (`shouldClaimPaste` gives text the win), so this lands in the editor exactly as typing
 * would.
 */
function typeInto(container: HTMLElement, words: string) {
  const editor = editorOf(container);
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? words : ""),
    },
  });
}

test("a failed send puts the words back rather than throwing at nobody", async () => {
  const send = deferredSend();
  const { container, getByLabelText } = render(
    <Composer compact initialValue="ship it" onSubmit={send.onSubmit} />,
  );

  await act(async () => {
    fireEvent.click(getByLabelText("Send message"));
  });
  // Cleared optimistically, which is the state the restore has to undo.
  expect(typedText(container)).toBe("");

  await send.reject();

  expect(typedText(container)).toContain("ship it");
  // Back to a composer that can be sent from again, rather than one stuck mid-send.
  expect((getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(
    false,
  );
});

/**
 * THE EDITOR IS NEVER DISABLED MID-TURN, AND THAT IS DELIBERATE — it is how a correction gets typed
 * at a Bot that is already working. So by the time a send fails the box may well hold something
 * newer than the message that failed. `setValue(segments)` wrote straight over it: the failed
 * message came back and the sentence typed after it was gone, with nothing said about either.
 *
 * Both are somebody's words, so neither may be dropped. The restored ones go in FRONT of the newer
 * ones and the person edits the join.
 */
test("a failed send keeps what was typed while it was in flight", async () => {
  const send = deferredSend();
  const { container, getByLabelText } = render(
    <Composer compact initialValue="first" onSubmit={send.onSubmit} />,
  );

  await act(async () => {
    fireEvent.click(getByLabelText("Send message"));
  });
  expect(typedText(container)).toBe("");

  await act(async () => {
    typeInto(container, "second");
  });
  expect(typedText(container)).toContain("second");

  await send.reject();

  const restored = typedText(container);
  expect(restored).toContain("first");
  expect(restored).toContain("second");
  expect(restored.indexOf("first")).toBeLessThan(restored.indexOf("second"));
});
