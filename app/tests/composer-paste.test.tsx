import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";

/**
 * PASTE, THE THIRD AND LAST DOOR A FILE COMES IN THROUGH.
 *
 * The `+` picker and the drop are already screened; paste was not. The SDK's own listener
 * pre-filters the clipboard with an exact `file.type === filter` match and then returns without a
 * word when nothing survives it, so a pasted text file went nowhere and said nothing. The composer
 * now claims paste ahead of it — see the fourth test, which is the pin for that whole failure.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `composer-attachments-ui.test.tsx` for the reason recorded there: bun walks
 * every file into one process, and a document another file tore down mid-run fails invisibly. The
 * registration carries a `url` because without one `location` is `about:blank` and relative URLs —
 * every attachment preview is one — do not resolve.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** Every upload this composer attempted, in order, by filename. */
let uploads: string[];

beforeEach(() => {
  uploads = [];
  global.fetch = (async (_path: string, init: RequestInit) => {
    const file = (init.body as FormData).get("file") as File;
    uploads.push(file.name);
    return new Response(
      JSON.stringify({
        id: "attachment-id",
        name: file.name,
        mimeType: file.type,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

/**
 * A clipboard as the browser hands one over: files reachable through `items`, and whatever text
 * came with them behind `getData`. Both halves matter — the decision to claim a paste or leave it
 * alone is made by comparing the two.
 */
function clipboard({
  files = [],
  text = "",
}: {
  files?: File[];
  text?: string;
}) {
  return {
    files,
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    types: [...(files.length > 0 ? ["Files"] : []), "text/plain"],
    getData: (type: string) => (type === "text/plain" ? text : ""),
  };
}

/** The editor inside the composer: the element a paste actually lands on. */
function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector("[contenteditable]") as HTMLElement;
}

/** What is typed in the box, with the placeholder and the strip left out of it. */
function typedText(container: HTMLElement): string {
  return editorOf(container).textContent ?? "";
}

/**
 * A paste into the composer, caret and all.
 *
 * The caret is not decoration. PromptArea inserts pasted text at the selection and gives up when
 * there is not one, so an editor nobody has clicked into would swallow an ordinary text paste for
 * a reason that has nothing to do with this composer — and the test that ordinary pastes still
 * reach the box would pass while proving nothing.
 */
function pasteInto(
  container: HTMLElement,
  clipboardData: ReturnType<typeof clipboard>,
) {
  const editor = editorOf(container);
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  fireEvent.paste(editor, { clipboardData });
}

/**
 * A pasted file, all the way up.
 *
 * Not `uploads`, and not the chip either: both are true while the request is still outstanding, and
 * a test that ends on either leaves the response to land after the document is gone. See the note
 * on `uploaded` in `composer-attachments-ui.test.tsx` for the whole mechanism — Send is shut while
 * anything is `uploading`, so a Send that has come back on is an upload that has been answered.
 */
async function uploaded(
  { getByLabelText, queryByLabelText }: RenderResult,
  name: string,
) {
  await waitFor(() => {
    expect(queryByLabelText(`Remove ${name}`)).not.toBeNull();
    expect((getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
}

test("a pasted screenshot is attached, and types nothing into the box", async () => {
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const { container } = view;

  const shot = new File(["png"], "screenshot.png", { type: "image/png" });
  pasteInto(container, clipboard({ files: [shot] }));

  await uploaded(view, "screenshot.png");

  /*
   * ONE UPLOAD, AND IT IS NOT `stopPropagation` THAT MAKES IT ONE.
   *
   * This assertion used to carry a comment claiming it proved the capture-phase `stopPropagation`
   * cut the SDK's listener off. It does not, and the way to see that is to delete
   * `event.stopPropagation()` from `composer.tsx` and run this suite: it stays green. The SDK's
   * listener opens `if (!containerRef.current?.contains(target)) return`, and `containerRef` is the
   * hook's own ref, which this composer deliberately never attaches — it holds its own instead, for
   * the reason recorded on that ref. So the hook's listener returns on the first line of every
   * paste, whether or not anything stopped the event, and one upload is all there could have been.
   *
   * What this line really pins is that OUR path uploads exactly once. The effect of
   * `stopPropagation` is pinned separately, by the last test in this file, which watches a
   * bubble-phase `document` listener — the exact shape the SDK installs — rather than inferring it.
   */
  expect(uploads).toEqual(["screenshot.png"]);
  expect(typedText(container)).toBe("");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("a pasted spreadsheet cell types its text and attaches nothing", async () => {
  const { container } = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );

  // A cell copied out of a spreadsheet is BOTH: an `.html` (or `.txt`) file for the formatting and
  // the plain text for everybody else. Claiming any paste that carries a file would swallow this
  // one whole and leave the person with a paste that visibly did nothing.
  pasteInto(
    container,
    clipboard({
      files: [new File(["<td>7</td>"], "cell.html", { type: "text/html" })],
      text: "7",
    }),
  );

  await waitFor(() => expect(typedText(container)).toContain("7"));
  expect(uploads).toEqual([]);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("a pasted file with no text alongside it is attached, not typed", async () => {
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const { container } = view;

  pasteInto(
    container,
    clipboard({ files: [new File(["a,b"], "rows.csv", { type: "text/csv" })] }),
  );

  await uploaded(view, "rows.csv");

  expect(uploads).toEqual(["rows.csv"]);
  // The filename is not a message. A composer that typed it would be putting words in somebody's
  // mouth on top of attaching the file they asked for.
  expect(typedText(container)).toBe("");
});

test("a pasted `text/plain;charset=utf-8` file is attached", async () => {
  // THE REGRESSION PIN FOR THIS WHOLE TASK. The SDK's paste listener compares `file.type` to its
  // accept list exactly, and this is the type a browser reports for a text file taken off the
  // clipboard — so the file was filtered out, `processFiles` was never reached, and its
  // `fileItems.length === 0` early return said nothing to anybody. Nothing uploaded, nothing
  // refused, nothing on screen.
  const notes = new File(["hello"], "notes.txt", {
    type: "text/plain;charset=utf-8",
  });

  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const { container } = view;

  pasteInto(container, clipboard({ files: [notes] }));

  await uploaded(view, "notes.txt");

  expect(uploads).toEqual(["notes.txt"]);
  // Asked once the whole upload has been through the SDK, which is the only point at which "and it
  // was not refused on the way" is a question rather than a coin toss on timing.
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(typedText(container)).toBe("");
});

test("with no channel, a pasted file does nothing and no listener is installed", async () => {
  const listeners: boolean[] = [];
  const addEventListener = document.addEventListener.bind(document);
  document.addEventListener = ((
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "paste") {
      listeners.push(true);
    }
    addEventListener(type, listener, options);
  }) as typeof document.addEventListener;

  try {
    const { container } = render(<Composer compact onSubmit={() => {}} />);

    pasteInto(
      container,
      clipboard({
        files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      }),
    );

    // Neither ours nor the SDK's: with no `channelId` there is no config, so the hook is disabled
    // and this composer is exactly the one every screen had before attachments existed.
    expect(listeners).toEqual([]);
    await waitFor(() => expect(uploads).toEqual([]));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    document.addEventListener = addEventListener;
  }
});

/**
 * THE FULL-SIZE BRANCH, WHICH IS THE ONE THE HOME AND ONBOARDING COMPOSERS DRAW.
 *
 * A clipboard carrying an image AND text is not ours: `shouldClaimPaste` gives text the win, so our
 * capture-phase listener declines it and the event goes on to reach PromptArea. Its own rule then
 * decides — Microsoft Office markup in the `text/html` means the text is what was copied, anything
 * else means the image is — and for every source that is not Word or Excel (Google Sheets, Numbers,
 * a screenshot tool that puts a caption on the clipboard too) it takes the second branch, calls
 * `onImagePaste` and returns having inserted nothing.
 *
 * Without that prop the call goes nowhere and the paste has already been `preventDefault`-ed: no
 * text typed, no file staged, no refusal shown. It was passed on the compact branch only, so this
 * composer — the one the home screen and the onboarding poster render — swallowed such a paste
 * whole, which is the one outcome this file exists to make impossible.
 *
 * ASSERTED ON THE STRIP, NOT ON THE FETCH STUB. The stub records an upload the instant it is
 * called, which is before the composer has seen the answer; a tile with the pasted file's name on
 * it is the first thing that proves the file actually went through `stageFiles`.
 */
test("a full-size composer stages an image pasted alongside text", async () => {
  const { container, queryByLabelText } = render(
    <Composer channelId="channel-1" onSubmit={() => {}} />,
  );

  const chart = new File(["png"], "chart.png", { type: "image/png" });
  // `act` around the paste, which no other test in this file needs: this branch is the only one
  // that draws PromptArea with `autoGrow`, and the measurement that follows a paste settles in a
  // task of its own. Unwrapped, that update lands outside React's test scope and is reported as a
  // warning that has nothing to do with what is being asserted.
  await act(async () => {
    pasteInto(container, clipboard({ files: [chart], text: "Q3 revenue" }));
  });

  await waitFor(() =>
    expect(queryByLabelText("Remove chart.png")).not.toBeNull(),
  );
  // All the way through the upload rather than stalled as a placeholder: the tile only draws an
  // `<img>` once `onUpload` has answered with a URL to point it at.
  await waitFor(() =>
    expect(
      container.querySelector('img[alt="chart.png"]')?.getAttribute("src"),
    ).toBe("/api/attachments/attachment-id"),
  );
  expect(uploads).toEqual(["chart.png"]);
});

/**
 * THE PASTE DOOR ANSWERS TO `disabled` TOO.
 *
 * Our capture-phase listener was installed on `attachmentsEnabled` alone, so a composer the screen
 * had already declared finished went on claiming pastes and uploading what it found in them. Same
 * settle as the drop test in `composer-attachments-ui.test.tsx`: the composer is re-enabled and
 * pasted into again, and the wait is on that second upload being ANSWERED — the first, started
 * earlier, would have had to show up before it.
 */
test("a disabled composer claims no paste and stages nothing", async () => {
  /*
   * THE CLAIM IS WHAT IS ASSERTED, AND THE UPLOAD COUNT ALONE COULD NOT SEE IT.
   *
   * This used to watch `uploads` and nothing else. Two independent guards keep a file off a
   * disabled composer — `canAttach` keeps the capture-phase listener uninstalled, and `stageFiles`
   * re-asks `disabled` at the choke point — and against an upload count they are redundant, so
   * either could be deleted on its own and this stayed green.
   *
   * Worse, the guard it names is the one that could go silently. Re-arm the listener while disabled
   * and the paste is `preventDefault`-ed and `stopPropagation`-ed and then dropped on the floor by
   * `stageFiles`: no upload, so the old assertion held, and an ordinary text paste into a finished
   * channel now types NOTHING. That is a worse outcome than the bug this test was written for.
   *
   * So the bubble-phase listener from the test below stands in for everything downstream, and the
   * assertion is that a disabled composer LET THE PASTE THROUGH untouched.
   *
   * `stageFiles`' own `disabled` return is deliberately not pinned here, and cannot be from the
   * outside: while `canAttach` is correct it closes every door — no capture listener, no drop
   * handlers, a disabled file input, and `onImagePaste` passed as `undefined` — so nothing can
   * reach `stageFiles` to be turned away by it. It is defence in depth for `onImagePaste`, which is
   * PromptArea's call to make and not ours, and its comment says exactly that.
   */
  const reached: string[] = [];
  const bubbleListener = () => reached.push("paste");
  document.addEventListener("paste", bubbleListener);

  try {
    const view = render(
      <Composer channelId="channel-1" compact disabled onSubmit={() => {}} />,
    );
    const { container, rerender } = view;

    pasteInto(
      container,
      clipboard({
        files: [new File(["png"], "refused.png", { type: "image/png" })],
      }),
    );

    // Not claimed: the event went past the composer to everything downstream of it, which is what
    // keeps an ordinary paste working in a channel that can no longer take a message.
    expect(reached).toEqual(["paste"]);

    rerender(<Composer channelId="channel-1" compact onSubmit={() => {}} />);
    pasteInto(
      container,
      clipboard({
        files: [new File(["png"], "kept.png", { type: "image/png" })],
      }),
    );
    await uploaded(view, "kept.png");

    // And re-enabled it claims again, so the paste stops here rather than bubbling on.
    expect(reached).toEqual(["paste"]);
    expect(uploads).toEqual(["kept.png"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    document.removeEventListener("paste", bubbleListener);
  }
});

/**
 * THE COMPACT BRANCH, WHICH IS THE ONE `channel-chat` DRAWS — SO IT IS WHERE MOST PASTES LAND.
 *
 * `onImagePaste` is passed twice, and the note on it in `composer.tsx` says every branch has to
 * pass it because the full-size one once did not. The test above pins the full-size branch, i.e.
 * the direction the historical failure happened in; blanking the prop on the COMPACT branch left
 * the whole suite green, on the composer a person actually types into all day.
 *
 * Same clipboard as the full-size case: an image alongside text, which `shouldClaimPaste` declines
 * so that PromptArea's own rule gets it and hands the image to `onImagePaste`. Without the prop
 * that call goes nowhere and the paste has already been `preventDefault`-ed — no text, no file, no
 * refusal.
 *
 * No `act` wrapper here, unlike the full-size case: that one is only needed for `autoGrow`'s
 * measurement, which the compact branch does not use.
 */
test("a compact composer stages an image pasted alongside text", async () => {
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );

  pasteInto(
    view.container,
    clipboard({
      files: [new File(["png"], "chart.png", { type: "image/png" })],
      text: "Q3 revenue",
    }),
  );

  await waitFor(() =>
    expect(view.queryByLabelText("Remove chart.png")).not.toBeNull(),
  );
  expect(uploads).toEqual(["chart.png"]);
});

/**
 * `stopPropagation`, PINNED DIRECTLY RATHER THAN INFERRED FROM AN UPLOAD COUNT.
 *
 * `useAttachments` registers its paste handler with a plain `document.addEventListener("paste", h)`
 * — bubble phase — so a listener of the same shape is the honest stand-in for it, and unlike the
 * real one it is not also gated on a `containerRef` this composer never attaches. A claimed paste
 * must not reach it; a declined one must, because that is the whole reason the capture-phase
 * listener stops at claiming rather than swallowing everything.
 *
 * Delete `event.stopPropagation()` from `composer.tsx` and the first half of this goes red, which
 * is what the first test in this file was mistakenly credited with doing.
 */
test("a claimed paste is stopped at the capture phase, and a declined one is not", async () => {
  const reached: string[] = [];
  const bubbleListener = () => reached.push("paste");
  document.addEventListener("paste", bubbleListener);

  try {
    const view = render(
      <Composer channelId="channel-1" compact onSubmit={() => {}} />,
    );
    const { container } = view;

    pasteInto(
      container,
      clipboard({
        files: [new File(["png"], "claimed.png", { type: "image/png" })],
      }),
    );
    // Asked once the claimed paste has been all the way up, so "it never arrived" is a settled
    // answer rather than a question asked too early.
    await uploaded(view, "claimed.png");
    expect(reached).toEqual([]);

    // Text and no file: `shouldClaimPaste` gives text the win, our listener declines, and the event
    // goes on to everything downstream of it — which is what makes an ordinary paste still work.
    pasteInto(container, clipboard({ text: "just words" }));
    await waitFor(() => expect(typedText(container)).toContain("just words"));
    expect(reached).toEqual(["paste"]);
  } finally {
    document.removeEventListener("paste", bubbleListener);
  }
});
