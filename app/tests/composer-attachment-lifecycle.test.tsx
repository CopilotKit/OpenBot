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
import type { ComposerDraft } from "@/components/channels/composer/draft";
import { settleReactWork } from "./settle-react-work";

/**
 * WHAT HAPPENS TO A STAGED FILE AFTER IT IS STAGED: the send it rides on, and the Remove that
 * takes it back.
 *
 * Two defects, both only reachable once `channelId` was threaded through. A send held the strip
 * for the whole length of the run, so the same attachment ids could be pressed into a second
 * message; and nothing in the app had ever called `DELETE /api/attachments/:id`, so a removed chip
 * left its row staged forever and counted against the eight-per-channel cap that later refuses an
 * upload by naming files nobody can see.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `composer-attachments-ui.test.tsx` for the reason recorded there: bun walks
 * every file into one process, and a document another file tore down mid-run fails invisibly. The
 * registration carries a `url` because without one `location` is `about:blank` and the relative
 * URLs every one of these requests uses do not resolve.
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

/** Every `DELETE` this composer sent, by path. */
let deletes: string[];
/** Held open by a test that wants an upload still in flight when it looks at the strip. */
let holdUpload: boolean;
/** A network that drops the delete on the floor, which must change nothing on screen. */
let deleteFails: boolean;

beforeEach(() => {
  deletes = [];
  holdUpload = false;
  deleteFails = false;
  global.fetch = (async (path: string, init: RequestInit) => {
    if (init?.method === "DELETE") {
      deletes.push(path);
      if (deleteFails) {
        // What a browser does when the request never reaches anything: a rejected promise, not a
        // response with a status. The 404 and 409 this endpoint really answers with are ordinary
        // responses, and are ignored for the same reason this rejection is.
        throw new TypeError("Failed to fetch");
      }
      return new Response(null, { status: 204 });
    }
    const file = (init.body as FormData).get("file") as File;
    if (holdUpload) {
      // Never settles: the placeholder stays `uploading` for the length of the test.
      return await new Promise<Response>(() => {});
    }
    return new Response(
      JSON.stringify({
        id: "stored-id",
        name: file.name,
        mimeType: "text/plain",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

/** A drop, as the browser delivers one: files hanging off `dataTransfer`. */
function drop(form: Element, files: File[]) {
  fireEvent.drop(form, {
    dataTransfer: { files, items: [], types: ["Files"] },
  });
}

function notes() {
  return new File(["hello"], "notes.txt", { type: "text/plain" });
}

/**
 * A dropped file, all the way up — and, after a run, a composer with nothing left in flight at all.
 *
 * `Remove <name>` on its own is not that: the chip goes on the strip the moment the upload starts,
 * so a wait on it can be over while `POST .../attachments` is still outstanding, and every test
 * below then depends on a race it never states — the DELETE only goes out for a `ready`
 * attachment, and `canSendDraft` will not submit one that is still uploading. See the note on
 * `uploaded` in `composer-attachments-ui.test.tsx` for what a test that ends mid-upload does to the
 * document.
 *
 * `canSend` answers both halves at once: it is false while any attachment is `uploading` AND false
 * for the whole length of a run (`isBusy`, and nothing below has anything to park), so a live Send
 * is an upload that has been answered by a composer that is not mid-send.
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

test("a send in flight takes its attachment off the composer, so a second press cannot send it twice", async () => {
  const submitted: ComposerDraft[] = [];
  const queued: ComposerDraft[] = [];
  let land: () => void = () => {};
  const run = new Promise<void>((resolve) => {
    land = resolve;
  });

  const view = render(
    <Composer
      channelId="channel-1"
      compact
      onQueue={(draft) => queued.push(draft)}
      onSubmit={async (draft) => {
        submitted.push(draft);
        // A real send does not resolve until the whole run does — which is the window the whole
        // defect lived in.
        await run;
      }}
    />,
  );
  const { container, getByLabelText, queryByLabelText } = view;

  const form = container.querySelector("form") as HTMLFormElement;
  drop(form, [notes()]);
  await uploaded(view, "notes.txt");

  fireEvent.submit(form);
  await waitFor(() => expect(submitted).toHaveLength(1));
  expect(submitted[0].attachments).toHaveLength(1);

  // The screenshot is in the transcript now. It must not also still be here: it was on screen
  // twice for the length of the run, and `canSendDraft` unlocks on attachments alone, so the empty
  // text box was not what kept the button from going again.
  expect(queryByLabelText("Remove notes.txt")).toBeNull();
  expect((getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(
    true,
  );

  // The press that used to queue the identical attachment ids into a second user message.
  fireEvent.submit(form);
  expect(queued).toEqual([]);
  expect(submitted).toHaveLength(1);

  land();
  // `aria-busy` IS `isSubmitting`, so this is the run finishing and the composer re-rendering
  // without it — and, unlike a wait for `submitted` to have one entry, it is not a condition that
  // was already true before `land()`. The assertion under it used to run before the run had landed
  // and so asked nothing.
  await waitFor(() => expect(form.getAttribute("aria-busy")).toBe("false"));
  // And it does not come back once the run lands, either: the send became a message.
  expect(queryByLabelText("Remove notes.txt")).toBeNull();
});

test("a send carries off only what it took, and a failure would have it to hand back", async () => {
  /*
   * THE TRADE-OFF THIS COMPOSER CHOSE, PINNED FROM THE ONE SIDE A TEST CAN REACH.
   *
   * The strip is HIDDEN for the length of a run, not consumed — so the ids are still the
   * composer's, and the `finally` hands them straight back when a send fails. The failing send
   * itself cannot be driven from here: `submitDraft` rethrows into two call sites that both void
   * the promise (`handleFormSubmit`, and prompt-area's Enter), which is deliberate — see the
   * "swallowed on purpose, and only here" note on `conversation-view`'s drain — and `bun test`
   * fails any test in whose tick an unhandled rejection appears. What is reachable is the property
   * the restore rests on, and it is the one the other trade-off would have broken: taking the ids
   * the send actually carried rather than consuming the queue, so nothing that was never sent is
   * swept up with them.
   */
  const submitted: ComposerDraft[] = [];
  let land: () => void = () => {};
  const run = new Promise<void>((resolve) => {
    land = resolve;
  });

  const view = render(
    <Composer
      channelId="channel-1"
      compact
      onSubmit={async (draft) => {
        submitted.push(draft);
        await run;
      }}
    />,
  );
  const { container, queryByLabelText } = view;

  const form = container.querySelector("form") as HTMLFormElement;
  drop(form, [notes()]);
  await uploaded(view, "notes.txt");

  fireEvent.submit(form);
  await waitFor(() => expect(submitted).toHaveLength(1));

  // Staged while the run is still going: a correction's file, belonging to the next message and
  // never sent by this one. Send is shut for the length of the run, so the chip is all there is to
  // wait for here — the wait after `land()` is what closes the upload out.
  drop(form, [new File(["later"], "report.txt", { type: "text/plain" })]);
  await waitFor(() =>
    expect(queryByLabelText("Remove report.txt")).not.toBeNull(),
  );

  land();
  // Send comes back only when the run has landed AND nothing is left uploading, so this one wait
  // is both — and it is the assertion that report.txt is still here, which is the half of the
  // property `consumeAttachments()` would have broken: that sweep takes every ready attachment,
  // which at this moment would include a file this send never carried. It replaces a wait for
  // notes.txt's chip to be ABSENT, which was already true before `land()` — the send had hidden it
  // — and so let everything below run on a composer that had not yet seen the run finish.
  await uploaded(view, "report.txt");

  // And the half that rode on the send is gone, and does not come back with the run.
  expect(queryByLabelText("Remove notes.txt")).toBeNull();
  expect(submitted[0].attachments).toHaveLength(1);
  expect(deletes).toEqual([]);
});

test("removing a staged attachment gives its row back to the server", async () => {
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const { container, getByLabelText, queryByLabelText } = view;

  drop(container.querySelector("form") as HTMLFormElement, [notes()]);
  // The whole point of the test is what a READY attachment gives back — an `uploading` one has no
  // row to reclaim and issues no DELETE at all — so the removal must not be pressed until the
  // upload has been answered.
  await uploaded(view, "notes.txt");

  fireEvent.click(getByLabelText("Remove notes.txt"));

  // The id the server stored it under — `metadata.attachmentId` — not the client-side placeholder
  // id the strip keys its chips on.
  await waitFor(() => expect(deletes).toEqual(["/api/attachments/stored-id"]));
  expect(queryByLabelText("Remove notes.txt")).toBeNull();
});

/**
 * NOTHING IS INVENTED FOR A ROW THE COMPOSER HAS NOT BEEN TOLD ABOUT YET.
 *
 * This test used to be named for a guard and pinned neither half of it. `discardAttachment` had two
 * checks before its DELETE — `status !== "ready"` and `typeof metadata?.attachmentId === "string"` —
 * and against an `uploading` placeholder they are redundant: it has no metadata, so deleting either
 * one on its own left the suite green. Only deleting both turned it red.
 *
 * Both are gone now, and not by being papered over. `discardAttachment` no longer decides anything
 * about rows at all — a single reconciler owns that, because the guard version could only ever
 * handle the `ready` case and silently leaked the in-flight one (see
 * `composer-inflight-removal.test.tsx`, which pins what this composer now does about it).
 *
 * What is left here is the half that stays true and is worth keeping: while the upload is still
 * outstanding there is no id, so no request goes out — in particular not a
 * `DELETE /api/attachments/undefined`, which is a different endpoint rather than a broken one.
 */
test("removing an attachment that is still uploading asks the server for nothing", async () => {
  holdUpload = true;
  const { container, getByLabelText, queryByLabelText } = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );

  drop(container.querySelector("form") as HTMLFormElement, [notes()]);
  // The placeholder is on the strip from the moment the upload starts, and there is no row behind
  // it yet: `POST .../attachments` has not answered, so there is no id to delete.
  await waitFor(() =>
    expect(queryByLabelText("Remove notes.txt")).not.toBeNull(),
  );

  fireEvent.click(getByLabelText("Remove notes.txt"));

  expect(queryByLabelText("Remove notes.txt")).toBeNull();
  expect(deletes).toEqual([]);
});

test("a delete that fails still takes the chip off the strip", async () => {
  deleteFails = true;
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const { container, getByLabelText, queryByLabelText } = view;

  drop(container.querySelector("form") as HTMLFormElement, [notes()]);
  // Ready before the press, for the same reason as the test above: an `uploading` attachment sends
  // no DELETE, so the failure this pins would never be reached.
  await uploaded(view, "notes.txt");

  fireEvent.click(getByLabelText("Remove notes.txt"));

  // Best-effort, and the person asked for it gone: the removal is not held open by the request,
  // and the sweeper is the backstop for the row this one did not reclaim.
  expect(queryByLabelText("Remove notes.txt")).toBeNull();
  await waitFor(() => expect(deletes).toEqual(["/api/attachments/stored-id"]));
});

test("a refusal is dismissible, and a send clears it", async () => {
  /*
   * A REFUSAL WAS THE ONE THING ON THIS COMPOSER WITH NO END. An attachment leaves when it is sent
   * or removed and typed words leave when they are sent; the sentence about a file that never got
   * in stayed until the tab was closed, so a send landed under a complaint about something that was
   * not in it.
   *
   * Asserted through `role="alert"` rather than the filename, which appears twice in one refusal —
   * once as the line's own subject and once inside the reason — and would make every query
   * ambiguous.
   */
  const submitted: ComposerDraft[] = [];
  const view = render(
    <Composer
      channelId="channel-1"
      compact
      onSubmit={async (draft) => {
        submitted.push(draft);
      }}
    />,
  );
  const { container, getByLabelText, queryByRole } = view;

  const form = container.querySelector("form") as HTMLFormElement;
  const svg = () => new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
  drop(form, [svg()]);
  await waitFor(() => expect(queryByRole("alert")).not.toBeNull());

  // Closable on its own, for somebody who drops a bad file and then thinks better of the whole
  // message rather than sending one.
  fireEvent.click(getByLabelText("Dismiss this refusal"));
  expect(queryByRole("alert")).toBeNull();

  // And cleared by a send, which is the other way out.
  drop(form, [svg(), notes()]);
  await waitFor(() => expect(queryByRole("alert")).not.toBeNull());
  // `canSendDraft` refuses a draft carrying an upload still in flight, so a submit fired before
  // notes.txt was answered would be a no-op and the send this test is about would never happen.
  await uploaded(view, "notes.txt");

  fireEvent.submit(form);
  await waitFor(() => expect(submitted).toHaveLength(1));
  expect(queryByRole("alert")).toBeNull();
});
