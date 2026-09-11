import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
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
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import { useCallback } from "react";
import { Composer } from "@/components/channels/composer/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import type { ComposerDraft } from "@/components/channels/composer/draft";
import {
  attachmentUrl,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@/lib/channels/attachments";

/**
 * WHAT THE QUEUE DOES TO AN ATTACHMENT BEHIND SOMEBODY'S BACK, AT BOTH ENDS OF THE SAME ROW.
 *
 * The first half of the file is the composer handing a staged attachment TO the queue. The second
 * half — from `ConversationView` down — is the queue handing one back, and what has to happen to
 * the server-side row when it does. The last test is about the instrument rather than the code.
 *
 * The queue branch used to call the SDK's `consumeAttachments()`, which sweeps every `ready`
 * attachment regardless of which one a send already in flight is riding — so parking a
 * correction while a first send was still out took the first send's own attachment with it, and
 * the composer's own comment ("the catch hands them straight back") went false the moment a
 * queue happened mid-send. The fix removes only what `onQueue` is actually taking.
 *
 * WHY THE FIRST TEST SPIES ON THE SDK HOOK RATHER THAN DRIVING AN ACTUAL FAILED SEND. The
 * regression only shows up on screen once `sending` stops hiding the riding attachment, and the
 * only two things that clear `sending` are a successful send — whose own `finally` removes the
 * riding ids explicitly either way, masking the bug — and a failed one, whose `catch` this suite
 * cannot reach: `submitDraft`'s rejection reaches both call sites (`handleFormSubmit`'s form
 * submit and prompt-area's own Enter-key call) as a voided promise neither awaits nor catches,
 * so bun's test runner reports the resulting unhandled rejection as a failure of whichever test
 * is running when it surfaces — see `composer-attachment-lifecycle.test.tsx`'s second test for
 * this repository's own note on the same wall. What is reachable, and what the fix actually
 * changes, is which SDK function the queue branch calls — `consumeAttachments()` (sweeps every
 * `ready` attachment) versus `removeAttachment()` per id (surgical) — so this spies on both,
 * wrapping the real hook rather than replacing it, and asserts on the calls directly.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup`
 * in `afterEach`, matching `composer-attachment-lifecycle.test.tsx` for the reason recorded
 * there: bun walks every file into one process, and a document another file tore down mid-run
 * fails invisibly. The registration carries a `url` because without one `location` is
 * `about:blank` and the relative URLs every one of these requests uses do not resolve.
 */

/**
 * Captured before the spy is installed, because the spy replaces this very property: calling
 * `ReactCoreV2.useAttachments` from inside the implementation below would call the spy again and
 * recur forever.
 */
const realUseAttachments = ReactCoreV2.useAttachments;

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** Every id `removeAttachment` was called with, and how many times `consumeAttachments` was. */
let removeAttachmentCalls: string[];
let consumeAttachmentsCallCount: number;

/**
 * Every distinct function identity the spy has handed a rendering composer, so the test below can
 * say that it handed out exactly one of each. See the note on stability under the spy itself.
 */
const handedOut = {
  removeAttachment: new Set<unknown>(),
  consumeAttachments: new Set<unknown>(),
};

/**
 * A THIN SPY AROUND THE REAL HOOK, NOT A REPLACEMENT FOR IT. Every other field — `attachments`,
 * `processFiles`, the drag handlers — passes straight through to the real `useAttachments`, so
 * uploads, paste and drag still behave exactly as the real hook makes them; only the two calls
 * this file cares about are intercepted, on their way to doing the real thing regardless.
 *
 * `spyOn` ON THE MODULE NAMESPACE, NOT `mock.module`, BECAUSE ONLY ONE OF THE TWO COMES BACK OFF.
 * Both reach composer.tsx — its `import { useAttachments }` is a live binding, so a patch applied
 * here lands even though that import already ran. The difference is the undo. Bun has no way to
 * unregister a module mock: `mock.restore()` leaves one in place, so the honest reading of what
 * this file used to do in `afterAll` — call `mock.module` a second time with a spread snapshot —
 * is that it installed a PERMANENT mock rather than restoring anything, and every test file bun
 * walked into the same process afterwards imported that snapshot instead of the package. A
 * namespace spy is restorable, and `afterAll` genuinely puts the real function back.
 *
 * THE TWO WRAPPERS ARE MEMOISED, and that is not tidiness. The SDK builds both of these as
 * `useCallback(…, [])` — they are stable for the life of the hook, deliberately — and composer.tsx
 * depends on that: `submitDraft` lists `removeAttachment` in its dependency array, and every
 * prompt-area callback hangs off `submitDraft`. Minting fresh wrappers on each render made the
 * spy, not the code under test, the thing that decided how often those memos were rebuilt, which
 * is a harness that changes the behaviour it is measuring. Keyed on the SDK's own functions, so
 * they stay stable exactly as long as the real ones do.
 */
const useAttachmentsSpy = spyOn(ReactCoreV2, "useAttachments");

beforeAll(() => {
  useAttachmentsSpy.mockImplementation(
    (config: Parameters<typeof realUseAttachments>[0]) => {
      const hook = realUseAttachments(config);
      const removeAttachment = useCallback(
        (id: string) => {
          removeAttachmentCalls.push(id);
          return hook.removeAttachment(id);
        },
        [hook.removeAttachment],
      );
      const consumeAttachments = useCallback(() => {
        consumeAttachmentsCallCount += 1;
        return hook.consumeAttachments();
      }, [hook.consumeAttachments]);

      handedOut.removeAttachment.add(removeAttachment);
      handedOut.consumeAttachments.add(consumeAttachments);

      return { ...hook, removeAttachment, consumeAttachments };
    },
  );
});

afterAll(() => {
  useAttachmentsSpy.mockRestore();
});

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** Every `DELETE` this composer sent, by path. */
let deletes: string[];

/**
 * Every upload that actually left the browser, by file name.
 *
 * The point of a client-side cap is that a file it refuses never becomes a request. Asserting only
 * on the reason line would pass just as happily against a composer that uploaded the file and then
 * printed the server's refusal, which is the round trip the cap exists to remove — so the absence
 * of the POST is the assertion that distinguishes them.
 */
let uploads: string[];

beforeEach(() => {
  removeAttachmentCalls = [];
  consumeAttachmentsCallCount = 0;
  handedOut.removeAttachment.clear();
  handedOut.consumeAttachments.clear();
  deletes = [];
  uploads = [];
  global.fetch = (async (path: string, init: RequestInit) => {
    if (init?.method === "DELETE") {
      deletes.push(path);
      return new Response(null, { status: 204 });
    }
    const file = (init.body as FormData).get("file") as File;
    uploads.push(file.name);
    return new Response(
      JSON.stringify({
        // One stored id per file rather than one for the whole suite, so a test that stages more
        // than one attachment can say WHICH of them a DELETE was for. Derived from the name
        // because every file below is named for the role it plays.
        id: `stored-${file.name}`,
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

function correction() {
  return new File(["later"], "correction.txt", { type: "text/plain" });
}

/**
 * A dropped file, all the way up.
 *
 * `Remove <name>` on its own is not that condition — the chip goes on the strip the moment the
 * upload starts, so a wait on it can be over while `POST .../attachments` is still outstanding, and
 * both tests below then depend on a race they never state. See the note on `uploaded` in
 * `composer-attachments-ui.test.tsx` for what a test that ends mid-upload does to the document.
 *
 * The button is the one thing on screen that knows: `canSendDraft` holds it shut while any
 * attachment is still `uploading`. Which of the two it is says something in itself here — this
 * composer has an `onQueue`, so mid-run the same button is Queue — and either name being live is
 * the same answer, that the upload has been answered and the composer has re-rendered on it.
 */
async function uploaded({ queryByLabelText }: RenderResult, name: string) {
  await waitFor(() => {
    expect(queryByLabelText(`Remove ${name}`)).not.toBeNull();
    const button = (queryByLabelText("Send message") ??
      queryByLabelText("Queue message")) as HTMLButtonElement | null;
    expect(button?.disabled).toBe(false);
  });
}

test("queuing a correction mid-send removes only what it takes, never sweeps the attachment the send is riding", async () => {
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
        await run;
      }}
    />,
  );
  const { container, queryByLabelText } = view;

  const form = container.querySelector("form") as HTMLFormElement;

  // The first send takes notes.txt off the strip and holds it there for the length of the run.
  drop(form, [notes()]);
  await uploaded(view, "notes.txt");
  fireEvent.submit(form);
  await waitFor(() => expect(submitted).toHaveLength(1));
  expect(queryByLabelText("Remove notes.txt")).toBeNull();

  // A correction, staged while the first send is still out — the next message's file, not this
  // one's.
  drop(form, [correction()]);
  await uploaded(view, "correction.txt");

  // Parked, not sent: `isSubmitting` is still true from the send above, so this press queues.
  fireEvent.submit(form);
  expect(queued).toHaveLength(1);
  // Only the correction rode into the queued draft — the first send's attachment was never
  // `staged` to begin with, so it was never a candidate for this message.
  expect(queued[0].attachments).toHaveLength(1);
  expect(queued[0].attachments[0].filename).toBe("correction.txt");
  // Taken off the strip because it was queued, same as any parked attachment.
  expect(queryByLabelText("Remove correction.txt")).toBeNull();

  // THE REGRESSION, PINNED DIRECTLY. The old code called `consumeAttachments()`, which sweeps
  // every `ready` attachment regardless of `sending` — including notes.txt, which this send is
  // still riding. The fix calls `removeAttachment()` once per id `onQueue` actually took, and
  // never the sweep at all.
  expect(consumeAttachmentsCallCount).toBe(0);
  expect(removeAttachmentCalls).toEqual([queued[0].attachments[0].id]);

  land();
  // `aria-busy` IS `isSubmitting`, so this is the run finishing and the composer re-rendering
  // without it. A wait for `submitted` to have one entry was already satisfied before `land()` and
  // so let the test end with the run's own state updates still to come.
  await waitFor(() => expect(form.getAttribute("aria-busy")).toBe("false"));
});

test("removing a ready attachment issues the DELETE through attachmentUrl(), not a hand-typed path", async () => {
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const { container, getByLabelText, queryByLabelText } = view;

  drop(container.querySelector("form") as HTMLFormElement, [notes()]);
  // Ready, which is the state this test names: an `uploading` attachment has no stored row behind
  // it and issues no DELETE at all, so pressing Remove too early would pin nothing.
  await uploaded(view, "notes.txt");

  fireEvent.click(getByLabelText("Remove notes.txt"));

  // Built from the same helper the server-side comment and `chat-transcript.tsx` both insist on:
  // a hand-typed literal here is exactly the fifth spelling this repository forbids.
  await waitFor(() =>
    expect(deletes).toEqual([attachmentUrl("stored-notes.txt")]),
  );
  expect(queryByLabelText("Remove notes.txt")).toBeNull();
});

/**
 * THE OTHER END OF THE SAME ROW: WHAT THE QUEUE DOES WITH AN ATTACHMENT IT LETS GO OF.
 *
 * The tests above are about the composer handing a staged attachment TO the queue. These are about
 * the queue handing one back. The composer clears its own strip as a message is parked, so from
 * that moment the parked entry holds the only reference anything has to those rows — and when the
 * queue lets one go, nothing but `ConversationView` is left to release it.
 *
 * `ConversationView` rather than `Composer`, because the queue lives there: it owns `reduceQueue`,
 * it is what turns a transition's `droppedAttachments` into `DELETE /api/attachments/:id`, and
 * neither of the two ways a row is let go of — a person taking a queued message back, and the cap
 * re-check bumping the excess off a drained turn — is reachable from the composer alone.
 */

/** Every `Remove <name>` chip currently on the composer's strip. */
function chips({ container }: RenderResult): string[] {
  return Array.from(container.querySelectorAll("[aria-label^='Remove ']"))
    .map((button) => button.getAttribute("aria-label") ?? "")
    .filter((label) => !label.startsWith("Remove queued message"));
}

/** Drop `files` on the composer and wait for every one of them to finish uploading. */
async function dropAndWait(view: RenderResult, files: File[]) {
  drop(view.container.querySelector("form") as HTMLFormElement, files);
  await waitFor(() => expect(chips(view)).toHaveLength(files.length));
  await waitFor(() => {
    const button = (view.queryByLabelText("Send message") ??
      view.queryByLabelText("Queue message")) as HTMLButtonElement | null;
    expect(button?.disabled).toBe(false);
  });
}

function named(name: string) {
  return new File(["hello"], name, { type: "text/plain" });
}

test("taking a queued message back releases the rows it was carrying", async () => {
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={() => {}}
      // A turn is in flight, so the press below parks rather than sends.
      pending
      queueWhileBusy
    />,
  );
  const { container } = view;

  await dropAndWait(view, [notes()]);
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);

  // Parked: off the composer's strip, onto the transcript, and now referenced by nothing else.
  await waitFor(() =>
    expect(
      container.querySelector("[aria-label^='Remove queued message']"),
    ).not.toBeNull(),
  );
  expect(chips(view)).toEqual([]);
  expect(deletes).toEqual([]);

  // By attribute prefix rather than by name: this message is a file and nothing else — a
  // screenshot with no words is the whole reason `canSendDraft` unlocks on attachments alone — so
  // the row's label ends at the colon with nothing after it to match on.
  fireEvent.click(
    container.querySelector(
      "[aria-label^='Remove queued message']",
    ) as HTMLButtonElement,
  );

  // THE FINDING. The entry left the queue and took the last reference to a staged row with it.
  // Without this the row sits with `attachedAt IS NULL` until the 24-hour sweep, counted against
  // this person's per-channel limit and surfacing as a 409 naming a file on nobody's screen.
  await waitFor(() =>
    expect(deletes).toEqual([attachmentUrl("stored-notes.txt")]),
  );

  // AND THE PERSON IS TOLD, which is the other half of the same finding: a file that leaves with
  // nothing said about it is the failure this whole apparatus exists to avoid, and the removed
  // row is reported through the same `droppedAttachments` channel the cap re-check uses.
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("notes.txt");

  /*
   * AND TOLD THE RIGHT THING, WHICH IS A SEPARATE ASSERTION BECAUSE IT WAS A SEPARATE BUG.
   *
   * `reduceQueue` reports the same `Attachment[]` whichever way a row left, so the cause is read
   * off the queue ACTION here in `conversation-view.tsx` — the one place holding both halves — and
   * turned into one of `DROPPED_REASON`'s two sentences. Get that ternary backwards and every
   * removal blames a cap the person never hit, which `composer.tsx` says out loud is worse than
   * saying nothing: it sends them looking for a limit to work around.
   *
   * This suite used to decline the assertion, on the grounds that a removal deserved its own words
   * and that was composer.tsx's change to make. It has been made — `DroppedAttachmentCause` and
   * both sentences are live — so declining now leaves the wiring between them unpinned, and
   * swapping the two arms of that ternary passed the whole suite.
   */
  expect(alert.textContent).toContain("removed along with the queued message");
  expect(alert.textContent).not.toContain("merged");
  expect(alert.textContent).not.toContain("at most");
});

/**
 * THIS TEST USED TO DRIVE A DRAIN OVER THE CAP AND CANNOT ANY MORE, WHICH IS THE FIX WORKING.
 *
 * It parked eight files, dropped a ninth, parked that too, and let the two messages drain into one
 * draft of nine — then asserted that the cap re-check released the row it bumped and named the file
 * on screen. Every step of that is still the right behaviour of `reduceQueue`, and none of it is
 * reachable from here now: the ninth file never gets staged, because the composer screens picks
 * against the strip PLUS what is parked, so it is refused before it becomes a row at all.
 *
 * That is the better failure. A drop the person is told about after the fact, with a row to clean
 * up behind it, has been replaced by a pick that never happened — and the drained turn carries the
 * eight they chose first either way.
 *
 * WHAT THAT COSTS IN COVERAGE, SAID OUT LOUD SO NOBODY THINKS THE PIN MOVED BY ITSELF. The cap
 * re-check in `joinQueued` is now defensive at both layers — the client will not stage a ninth row
 * and the server will not accept one into a single `uploadGroup` — so it keeps its tests where it
 * is still reachable rather than here: `queue.test.ts` pins the rule and the `droppedAttachments`
 * it reports, and `composer-dropped-attachments.test.tsx` pins the `merged-over-cap` sentence
 * against the prop directly. What is left for this file is that the ninth never lands, and that a
 * full queue still drains whole.
 */
test("a full queue drains whole, with nothing bumped and nothing to release", async () => {
  const view = render(
    <ConversationView
      messages={[]}
      channelId="channel-1"
      onSubmit={() => {}}
      pending
      queueWhileBusy
    />,
  );
  const { container, rerender } = view;
  const form = container.querySelector("form") as HTMLFormElement;

  await dropAndWait(
    view,
    Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) =>
      named(`kept-${index}.txt`),
    ),
  );
  fireEvent.submit(form);
  await waitFor(() => expect(chips(view)).toEqual([]));

  // A ninth, refused before it becomes a row — the case the test above is about, repeated here
  // only to build the state this one is about: a queue sitting exactly on the cap.
  drop(form, [named("overflow.txt")]);
  await view.findByRole("alert");
  expect(uploads).not.toContain("overflow.txt");

  // The turn ends and the parked message drains.
  rerender(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={() => {}}
      queueWhileBusy
    />,
  );

  // Nothing was bumped, so nothing is released. The old version of this expected exactly one
  // DELETE here, for a row that no longer gets created.
  await waitFor(() => expect(chips(view)).toEqual([]));
  expect(deletes).toEqual([]);
  expect(uploads).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
});

test("the spy hands the composer one stable pair of callbacks, not a fresh pair per render", async () => {
  // THE HARNESS MEASURING ITSELF, and worth the test. The SDK builds `removeAttachment` and
  // `consumeAttachments` as `useCallback(…, [])` — stable for the life of the hook, deliberately —
  // and `submitDraft` lists `removeAttachment` in its dependency array. A spy that mints a new
  // wrapper on every render silently rebuilds that memo on every render too, so the thing under
  // test would be reacting to the instrument rather than to the code.
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );

  // Several renders: the placeholder going on the strip, the upload resolving, the strip
  // re-rendering without it.
  await dropAndWait(view, [notes()]);
  fireEvent.click(view.getByLabelText("Remove notes.txt"));
  await waitFor(() => expect(chips(view)).toEqual([]));

  expect(handedOut.removeAttachment.size).toBe(1);
  expect(handedOut.consumeAttachments.size).toBe(1);
});

/**
 * Registered after the `afterAll` that restores, so it runs after it: the real function is back on
 * the module and no file bun walks into this process after this one is holding a spy. This is the
 * assertion the old `mock.module`-based teardown could not have made — bun has no way to
 * unregister a module mock, so re-mocking with a snapshot left one installed for good.
 */
afterAll(() => {
  expect(ReactCoreV2.useAttachments).toBe(realUseAttachments);
});

test("a drained turn whose send fails releases the rows it was carrying", async () => {
  const attempted: ComposerDraft[] = [];
  // Rejects rather than resolves: this is the drained turn failing after the queue has already
  // been emptied to build it.
  const onSubmit = (draft: ComposerDraft) => {
    attempted.push(draft);
    return Promise.reject(new Error("the turn failed"));
  };

  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      pending
      queueWhileBusy
    />,
  );
  const { container, rerender } = view;

  await dropAndWait(view, [notes()]);
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);
  await waitFor(() => expect(chips(view)).toEqual([]));
  expect(deletes).toEqual([]);

  // The turn ends, so what was parked drains — and the send for it fails.
  rerender(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      queueWhileBusy
    />,
  );

  await waitFor(() => expect(attempted).toHaveLength(1));
  expect(attempted[0].attachments).toHaveLength(1);

  // THE FINDING. The queue was emptied to build this draft and there is nothing to retry it, so
  // once the send fails the row is referenced by nothing at all: not the composer's strip, which
  // let go of it when the message parked, and not the queue, which drained to produce it. Unlike
  // a failed send from the composer — which puts the chips back beside the restored words — there
  // is no box for these to go back into, so releasing them is the only thing left that is not
  // waiting a day for the sweeper.
  await waitFor(() =>
    expect(deletes).toEqual([attachmentUrl("stored-notes.txt")]),
  );
});

/**
 * THE FOURTH WAY A PARKED ROW LOSES ITS LAST REFERENCE, and the one that used to say nothing.
 *
 * The three above go through the queue: a removal, the cap re-check, and a drained turn whose send
 * failed. This one goes through React. The composer clears its strip as a message is parked, so the
 * parked entry is the only thing holding those rows — and walking to another channel unmounts the
 * whole conversation, entry and all.
 *
 * `queue.ts` is candid that switching channels "takes anything parked in it with it", but that
 * sentence is about the person's WORDS, which they watched land on screen and can retype. The
 * staged rows underneath them are what `releaseStagedAttachment` exists for, and nothing was
 * releasing them here.
 */
test("walking away with a message still parked releases the rows it was holding", async () => {
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={() => {}}
      pending
      queueWhileBusy
    />,
  );
  const { container } = view;

  await dropAndWait(view, [notes()]);
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);

  await waitFor(() =>
    expect(
      container.querySelector("[aria-label^='Remove queued message']"),
    ).not.toBeNull(),
  );
  expect(chips(view)).toEqual([]);
  expect(deletes).toEqual([]);

  // Another channel, a closed panel, a route change: whatever the gesture, this is what reaches the
  // queue — a teardown with something still in it and nobody left to ask.
  view.unmount();

  await waitFor(() =>
    expect(deletes).toEqual([attachmentUrl("stored-notes.txt")]),
  );
});

test("unmounting with an empty queue releases nothing", async () => {
  // The guard on the loop above, and not decoration: that teardown runs on EVERY unmount, including
  // the ordinary one after a turn has drained, and a version of it that reached for the composer's
  // strip rather than for the queue would delete rows behind chips somebody is still looking at.
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={() => {}}
      queueWhileBusy
    />,
  );

  await dropAndWait(view, [notes()]);
  view.unmount();

  await waitFor(() => expect(deletes).toEqual([]));
});

/**
 * THE CASE THAT MUST NOT RELEASE, which is the whole reason the queue answers "which of these has
 * nobody left holding it" rather than a caller assuming "all of them".
 *
 * An ordinary send carries only what is in the box. When it fails, `composer.tsx` puts the words
 * back and hands the chips back with them — `setSending([])` in its `finally` — so those rows are
 * referenced by something on screen that somebody can press send on again. Deleting them would
 * leave chips pointing at rows that no longer exist.
 */
test("an ordinary send that fails releases nothing, because the chips come back", async () => {
  const attempted: ComposerDraft[] = [];
  const onSubmit = (draft: ComposerDraft) => {
    attempted.push(draft);
    return Promise.reject(new Error("the turn failed"));
  };

  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      queueWhileBusy
    />,
  );
  const { container } = view;

  await dropAndWait(view, [notes()]);
  // Nothing is parked and no turn is in flight, so this sends rather than queues.
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);

  await waitFor(() => expect(attempted).toHaveLength(1));
  // Back on the strip, which is the fact the assertion after it depends on.
  await waitFor(() => expect(chips(view)).toEqual(["Remove notes.txt"]));
  expect(deletes).toEqual([]);
});

/**
 * THE TWO CAPS COUNTING THE SAME SET AGAIN, WHICH TAKES BOTH HALVES AND THIS IS THE CALLER'S.
 *
 * Parking a message takes its chips off the strip, and until this the number the client screened
 * against went with them: `stagedCount` resyncs from the strip, so after a park it read zero. The
 * server's cap counts something the park does not touch — every row this person has staged in this
 * composer's `uploadGroup` with `attachedAt IS NULL`, which a parked row is until the drained turn
 * is sent. So a ninth pick behind eight parked files was accepted here and refused there, which is
 * a per-draft cap and a per-group cap disagreeing by exactly the size of the queue.
 *
 * `composer.tsx` takes the number as `queuedAttachmentCount` and adds it to what it screens
 * against. It cannot work the number out itself — the queue is this file's, not the composer's —
 * so the composer's half is inert until something passes it, and this is the test that something
 * does. Without the prop on the `Composer` below, the ninth file uploads.
 */
test("a ninth pick behind eight parked files is refused here, without a round trip", async () => {
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={() => {}}
      // A turn is in flight, which is the only condition under which anything is parked at all.
      pending
      queueWhileBusy
    />,
  );
  const { container } = view;
  const form = container.querySelector("form") as HTMLFormElement;

  await dropAndWait(
    view,
    Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) =>
      named(`parked-${index}.txt`),
    ),
  );
  fireEvent.submit(form);

  // Parked: a full message's worth, off the strip and into the queue, with their rows untouched.
  await waitFor(() => expect(chips(view)).toEqual([]));
  expect(uploads).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);

  drop(form, [named("ninth.txt")]);

  const alert = await view.findByRole("alert");
  // Our sentence, naming the file and the limit — not the server's, which names a count against a
  // strip the person is looking at and can see is empty.
  expect(alert.textContent).toContain("ninth.txt");
  expect(alert.textContent).toContain(
    `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
  );

  // AND IT NEVER LEFT THE BROWSER. This is the half that says the refusal came from here: the
  // reason line alone would read the same if the file had been uploaded and refused on arrival.
  expect(uploads).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
  expect(uploads).not.toContain("ninth.txt");
  // And no chip for it, so nothing on screen suggests it is going anywhere.
  expect(chips(view)).toEqual([]);
});

test("taking the parked message back frees the slots it was holding", async () => {
  // THE OTHER DIRECTION, AND THE REASON THE COUNT IS READ FROM THE QUEUE RATHER THAN ACCUMULATED.
  // A count that only ever went up would leave somebody who changed their mind about a parked
  // message locked out of the slots it had been occupying — refused by their own client this time,
  // which is worse than the 409 because there is no round trip to blame it on.
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={() => {}}
      pending
      queueWhileBusy
    />,
  );
  const { container } = view;
  const form = container.querySelector("form") as HTMLFormElement;

  await dropAndWait(
    view,
    Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) =>
      named(`parked-${index}.txt`),
    ),
  );
  fireEvent.submit(form);
  await waitFor(() => expect(chips(view)).toEqual([]));

  fireEvent.click(
    container.querySelector(
      "[aria-label^='Remove queued message']",
    ) as HTMLButtonElement,
  );
  await waitFor(() =>
    expect(deletes).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE),
  );

  // Nothing parked any more, so the strip is the whole count again and a pick is a pick.
  await dropAndWait(view, [named("ninth.txt")]);

  expect(uploads).toContain("ninth.txt");
  expect(chips(view)).toEqual(["Remove ninth.txt"]);
});

/**
 * THE ONE STATE IN WHICH A QUEUE IS NON-EMPTY AND NO TURN IS IN FLIGHT, which is worth a test of
 * its own because an argument made elsewhere leans on it.
 *
 * `composer-inflight-removal.test.tsx` pins that the composer PARKS rather than sends while a turn
 * is in flight, and concludes from it that `reduceQueue`'s submit-join — send now, with messages
 * already parked — is unreachable, which is what keeps the cap bumping the live draft's rows a
 * defensive path rather than a live one. That conclusion is right, and the reason given for it is
 * not the whole reason: it says the queue is only ever non-empty while a turn is in flight, and
 * here is the state where it is not. The drain refuses while the conversation is `disabled` — a
 * coworker deleted mid-turn — so the turn can end with the queue still full.
 *
 * What closes it is the OTHER guard, in `submitDraft`: a disabled composer returns before it can
 * either send or park. So there is still no way to reach the join, by a second route, and this is
 * the test that keeps the second route shut. If `disabled` ever stops gating the drain, the queue
 * empties into a channel this screen has already said is finished; if it ever stops gating
 * `submitDraft`, the join goes live.
 */
test("a disabled conversation keeps what is parked instead of draining it", async () => {
  const attempted: ComposerDraft[] = [];
  const onSubmit = (draft: ComposerDraft) => {
    attempted.push(draft);
  };

  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      pending
      queueWhileBusy
    />,
  );
  const { container, rerender } = view;

  await dropAndWait(view, [notes()]);
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);
  await waitFor(() =>
    expect(
      container.querySelector("[aria-label^='Remove queued message']"),
    ).not.toBeNull(),
  );

  // The turn ends AND the conversation goes read-only in the same breath, which is what a deleted
  // coworker looks like from here.
  rerender(
    <ConversationView
      channelId="channel-1"
      disabled
      messages={[]}
      onSubmit={onSubmit}
      queueWhileBusy
    />,
  );

  // Still parked, still on screen, and nothing ran: a drain here would post one more user turn into
  // a channel the notice under the composer has already said cannot reply.
  expect(attempted).toEqual([]);
  expect(
    container.querySelector("[aria-label^='Remove queued message']"),
  ).not.toBeNull();
  // And nothing was released either — the message is still there to be taken back by hand, so its
  // rows still have something pointing at them.
  expect(deletes).toEqual([]);
});
