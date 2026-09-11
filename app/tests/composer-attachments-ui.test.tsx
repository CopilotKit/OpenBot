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
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { settleReactWork } from "./settle-react-work";

/**
 * What the composer does with a file, from the outside: the button that opens the picker, the drop
 * that gets refused, and the screen that has no channel to upload to and so must go on behaving
 * exactly as it did before any of this existed.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `agent-roster-error.test.tsx` for the reason recorded there: bun walks
 * every file into one process, and a document another file tore down mid-run fails invisibly.
 *
 * The registration carries a `url`. Without one `location` is `about:blank`, relative URLs do not
 * resolve, and an assertion about an attachment's preview would pass or fail for a reason that has
 * nothing to do with the composer.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** Every upload this composer attempted: where it went, and what it carried. */
let uploads: { path: string; name: string }[];

beforeEach(() => {
  uploads = [];
  global.fetch = (async (path: string, init: RequestInit) => {
    const body = init.body as FormData;
    uploads.push({ path, name: (body.get("file") as File).name });
    return new Response(
      JSON.stringify({
        id: "attachment-id",
        name: (body.get("file") as File).name,
        mimeType: "text/plain",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

/**
 * The same upload stub, with the one answer that matters here under the test's control: what the
 * SERVER says the file is, having read its bytes, as against what the browser claimed when it was
 * picked up. `POST /api/channels/:id/attachments` returns a sniffed `mimeType`, and
 * `uploadToChannel` puts it on the `url` source it hands back to the SDK.
 */
function serverSniffs(mimeType: string) {
  global.fetch = (async (path: string, init: RequestInit) => {
    const body = init.body as FormData;
    uploads.push({ path, name: (body.get("file") as File).name });
    return new Response(
      JSON.stringify({
        id: "attachment-id",
        name: (body.get("file") as File).name,
        mimeType,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

/** A drop, as the browser delivers one: files hanging off `dataTransfer`. */
function drop(form: Element, files: File[]) {
  fireEvent.drop(form, {
    dataTransfer: { files, items: [], types: ["Files"] },
  });
}

/**
 * WAIT FOR A FILE TO BE ALL THE WAY UP, NOT MERELY ON ITS WAY. Written out here because the other
 * three composer test files wait on the same thing and cite this note.
 *
 * Neither of the two obvious conditions is that one. The stub above records a request BEFORE it
 * answers it, so a wait on `uploads` is over while `POST .../attachments` is still outstanding; and
 * the chip goes on the strip the moment an upload starts, so a wait on `Remove <name>` can be over
 * there too. A test that ends on either one ends with a `fetch` continuation still to come:
 * `cleanup` takes the document away, `afterAll` unregisters happy-dom, and React lands the state
 * update in a world with no `window`. That is the ` 1 error` this suite used to print next to 0
 * failures.
 *
 * Send is the part of the screen that knows the difference. `canSendDraft` holds the button shut
 * while any attachment is still `uploading`, so a Send that has come back on is an upload that has
 * been answered and a composer that has re-rendered on the answer. It is also FALSE when the wait
 * begins — the box is empty and nothing is staged — which is what makes it a wait at all, and so
 * what makes anything asserted after it a question that was actually asked.
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

test("a composer with a channel offers a file picker behind the plus button", () => {
  const { getByLabelText } = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );

  const attach = getByLabelText("Attach a file") as HTMLButtonElement;
  expect(attach.disabled).toBe(false);

  // The button is only worth anything if it has an input to open. Clicking it must reach a real
  // `<input type="file">` — the one the hook's ref is on — rather than a placeholder.
  let opened = false;
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  input.addEventListener("click", () => {
    opened = true;
  });
  fireEvent.click(attach);
  expect(opened).toBe(true);
});

/**
 * NOT ASSERTED ON AN EMPTY `uploads` ALONE — the same rule the disabled-composer test below states
 * and this one used to break. A synchronous `expect(uploads).toEqual([])` is true before anything
 * has had a chance to happen, so it proves nothing about the claim in this test's own name.
 *
 * The composer is given a channel and a second file is dropped; waiting for THAT upload to be
 * answered puts the question after the point by which the first — started earlier — would have had
 * to appear. Two files go down on the channel-less composer because they prove different halves:
 * the SVG is a file the screen WOULD refuse out loud if the drag handlers were installed, so a
 * silent drop is what says they are not; the text file is one that WOULD upload, so its absence
 * from `uploads` is what says nothing was sent.
 */
test("a composer with no channel keeps the button that says so, and takes no files", async () => {
  const view = render(<Composer compact onSubmit={() => {}} />);
  const { container, getByLabelText, queryByLabelText, rerender } = view;
  const form = () => container.querySelector("form") as HTMLFormElement;

  // The old affordance, untouched: nothing to offer and it says so, rather than a live button
  // that would open a picker with nowhere to upload to.
  const placeholder = getByLabelText(
    "More message options unavailable",
  ) as HTMLButtonElement;
  expect(placeholder.disabled).toBe(true);
  expect(queryByLabelText("Attach a file")).toBeNull();
  expect(container.querySelector('input[type="file"]')).toBeNull();

  /*
   * THE DROP IS CAUGHT AND ANSWERED, WHICH INVERTS WHAT THESE TWO LINES USED TO PIN.
   *
   * They read "a file dropped on this composer is the browser's business and not ours" and
   * asserted an empty alert. "The browser's business" turned out to mean the browser NAVIGATING
   * THE TOP-LEVEL DOCUMENT TO THE FILE — the single-page app unloads and takes the typed message
   * with it — because an element with no `dragover` handler is not a drop target at all. See
   * `refuseDragOver` in `composer.tsx`, and `composer-drop-guard.test.tsx` for the guard itself.
   *
   * What this test still owns is the half that has NOT changed, and it is the half its name is
   * about: no picker, no upload, nothing staged. Only the silence is gone.
   */
  drop(form(), [
    new File(["<svg />"], "logo.svg", { type: "image/svg+xml" }),
    new File(["hello"], "ignored.txt", { type: "text/plain" }),
  ]);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "no conversation here yet",
  );

  rerender(<Composer channelId="channel-1" compact onSubmit={() => {}} />);
  drop(form(), [new File(["hello"], "kept.txt", { type: "text/plain" })]);
  await uploaded(view, "kept.txt");

  // Only the file dropped once there was somewhere to put it.
  expect(uploads.map((upload) => upload.name)).toEqual(["kept.txt"]);
  expect(queryByLabelText("Remove ignored.txt")).toBeNull();
  expect(queryByLabelText("Remove logo.svg")).toBeNull();
  /*
   * AND THE SVG WAS NEVER SCREENED FOR BEING AN SVG, which is the claim this line still carries
   * after the assertion above it changed. `screenPickedFiles` phrases that particular refusal with
   * an upper-case "SVG" in it (see "a dropped file the screen refuses says why, in our words"
   * below); the filename is lower-case, so the ABSENCE of the upper-case token is what says the
   * file was turned down for having nowhere to go rather than for its type. The type screen sits
   * downstream of a channel that did not exist, and it must not have run.
   */
  const refusal = container.querySelector('[role="alert"]');
  expect(refusal?.textContent).toContain("logo.svg");
  expect(refusal?.textContent).not.toContain("SVG");
});

test("a dropped file the screen refuses says why, in our words", async () => {
  const { container, findByRole } = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );

  const form = container.querySelector("form") as HTMLFormElement;
  drop(form, [new File(["<svg />"], "logo.svg", { type: "image/svg+xml" })]);

  const alert = await findByRole("alert");
  expect(alert.textContent).toContain("logo.svg");
  expect(alert.textContent).toContain("SVG");
  // Screened before `processFiles`, so the SDK never sees it: no second refusal in its own
  // machine wording, and no upload of a file we had already decided against.
  expect(alert.textContent).not.toContain("Supported types:");
  expect(uploads).toEqual([]);
});

test("a text file the screen accepts is not refused a second time by the SDK", async () => {
  // The two-gate collision, pinned. `processFiles` compares `file.type` to the accept list
  // exactly, while our screen (and the server behind it) drop MIME parameters first. A `File`
  // really does arrive carrying them — this is the type a browser reports for a text file taken
  // off the clipboard, and Bun's own `File` appends it to every text type — and left unreconciled
  // the SDK refuses a file the composer had already accepted, in wording nobody wrote for a
  // person to read.
  const notes = new File(["hello"], "notes.txt", {
    type: "text/plain;charset=utf-8",
  });

  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const { container } = view;

  drop(container.querySelector("form") as HTMLFormElement, [notes]);

  await uploaded(view, "notes.txt");

  expect(uploads).toEqual([
    { path: "/api/channels/channel-1/attachments", name: "notes.txt" },
  ]);
  // Asked once the SDK has been all the way through the file it was handed, which is the only
  // point at which the absence of a second refusal means anything: waiting on `uploads` put this
  // question before `processFiles` could have answered it either way.
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

/**
 * `disabled` IS THE CONVERSATION REFUSING ANOTHER MESSAGE AT ALL, AND IT USED TO GATE ONLY SENDING.
 *
 * A channel whose coworker was deleted still took files: the drop handlers were installed, the `+`
 * button opened the picker, and the input behind it was live. Each one uploaded into a channel that
 * can never reply — a row staged server-side, counted against that channel's cap and left for the
 * sweeper, with nothing on screen connecting it to a message that cannot be sent.
 *
 * NOT ASSERTED ON AN EMPTY `uploads` ALONE, which is true before anything has had a chance to
 * happen and so proves nothing. The composer is re-enabled and a second file dropped; waiting for
 * THAT upload to be answered puts the question after the point by which the first — started
 * earlier — would have had to appear.
 */
test("a disabled composer takes no dropped file, and offers no way to pick one", async () => {
  const view = render(
    <Composer channelId="channel-1" compact disabled onSubmit={() => {}} />,
  );
  const { container, getByLabelText, queryByLabelText, rerender } = view;
  const form = () => container.querySelector("form") as HTMLFormElement;

  drop(form(), [new File(["hello"], "refused.txt", { type: "text/plain" })]);

  // Visibly shut rather than merely ignored: a button that opens a picker whose file will be
  // dropped on the floor is worse than one that says it cannot.
  expect((getByLabelText("Attach a file") as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(
    (container.querySelector('input[type="file"]') as HTMLInputElement)
      .disabled,
  ).toBe(true);

  rerender(<Composer channelId="channel-1" compact onSubmit={() => {}} />);
  drop(form(), [new File(["hello"], "kept.txt", { type: "text/plain" })]);
  await uploaded(view, "kept.txt");

  expect(uploads.map((upload) => upload.name)).toEqual(["kept.txt"]);
  expect(queryByLabelText("Remove refused.txt")).toBeNull();
  /*
   * REFUSED OUT LOUD RATHER THAN SWALLOWED, and this line used to pin the swallow.
   *
   * The drop is caught now — an uncaught one navigated the whole app to the file, and on a
   * `disabled` channel that unload takes the parked queue with it (see `refuseDragOver` in
   * `composer.tsx`). A caught file that says nothing is still a file that vanished from under the
   * person's cursor, so it gets the same one sentence every other refusal on this composer gets.
   *
   * The claims this test is named for are untouched by that: `uploads` above proves nothing was
   * sent, and `Remove refused.txt` proves nothing was staged.
   */
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "can no longer take messages",
  );
});

/**
 * MIME TYPES ARE CASE-INSENSITIVE AND THE SDK'S ACCEPT CHECK IS NOT.
 *
 * `matchesAcceptFilter` compares `file.type === filter` against a lower-case list, while
 * `classifyAttachment` — ours and the server's — lower-cases before it compares.
 * `withMediaTypeOnly` exists to keep those two answers the same and did only half the job: it
 * dropped the `;charset=` parameter and left the case alone, so a type that differs from the accept
 * list only in case went through our screen and was then refused by the SDK in its own machine
 * wording, which is the one outcome that function exists to make impossible.
 *
 * THE TYPE IS FORCED ON RATHER THAN CONSTRUCTED, because it cannot be constructed: `new File(...)`
 * ASCII-lower-cases `type` per the Blob spec, so the constructor would quietly repair the very
 * thing being tested — and it is also why the parameter-carrying case is not the interesting one.
 * `TEXT/PLAIN` with no parameter is: `file.type.split(";")[0].trim()` gives back the string it was
 * handed, the old function decided nothing needed doing, and the file went to the SDK untouched.
 * A `File` this app never built is exactly what a drop or a clipboard hands over.
 */
test("a text file whose type differs only in case is not refused by the SDK", async () => {
  const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
  Object.defineProperty(notes, "type", { value: "TEXT/PLAIN" });

  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const { container } = view;

  drop(container.querySelector("form") as HTMLFormElement, [notes]);

  await uploaded(view, "notes.txt");

  expect(uploads).toEqual([
    { path: "/api/channels/channel-1/attachments", name: "notes.txt" },
  ]);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

/**
 * THE STRIP DRAWS WHAT THE FILE IS, NOT WHAT THE BROWSER CALLED IT.
 *
 * `file.type` is a guess made from a filename before anything read a byte, and plenty of real
 * sources get it wrong: a screenshot dragged out of another app arrives as
 * `application/octet-stream` routinely. The server sniffs the bytes and sends back the type it
 * found, and both the send path (`toAttachmentPart` in `channel-chat.tsx`) and the parked tiles
 * (`parkedTiles` in `chat-transcript.tsx`) already read THAT through the shared
 * `attachmentModality`. The composer strip read the browser's claim instead, so one file had two
 * answers on three surfaces: a grey file card while it sat in the composer, a thumbnail the instant
 * it was parked or sent. The tile visibly changed shape at the moment of sending.
 *
 * `img[alt=...]` IS THE DISCRIMINATOR because it is the whole difference: an image tile renders an
 * `<img>` with the filename as its alt text, a file tile renders an `IconFile` and the name. Both
 * carry a `Remove <name>` button, so that label cannot tell the two apart.
 */
test("a screenshot the browser could not name is drawn as a picture once the server names it", async () => {
  serverSniffs("image/png");
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const { container } = view;

  // What a drag out of another application actually hands over: real PNG bytes under a type that
  // names no format at all. `screenPickedFiles` lets this one through for exactly that reason —
  // the claim is an absence rather than a claim, and only the server can settle it.
  drop(container.querySelector("form") as HTMLFormElement, [
    new File(["\x89PNG"], "shot.bin", { type: "application/octet-stream" }),
  ]);

  await uploaded(view, "shot.bin");

  expect(container.querySelector('img[alt="shot.bin"]')).not.toBeNull();
});

/**
 * THE OTHER DIRECTION, WHICH IS THE WORSE ONE. A mislabelled image is a grey card where a preview
 * should be; a mislabelled TEXT FILE handed to an `<img>` is a broken-image icon, because there is
 * no image there and there never was. The browser's claim is wrong in both directions and the
 * server's answer settles both.
 */
test("a file the browser called an image is drawn as a file once the server reads it", async () => {
  serverSniffs("text/plain");
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const { container } = view;

  drop(container.querySelector("form") as HTMLFormElement, [
    new File(["hello"], "notes.png", { type: "image/png" }),
  ]);

  await uploaded(view, "notes.png");

  // No `<img>` at all: the tile is the card that names the file, which is the only honest thing to
  // draw for bytes that cannot be rendered.
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("notes.png");
});
