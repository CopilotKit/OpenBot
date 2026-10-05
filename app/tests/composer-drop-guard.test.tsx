import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
} from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { settleReactWork } from "./settle-react-work";

/**
 * WHAT HAPPENS TO A FILE DROPPED ON A COMPOSER THAT CANNOT ACCEPT IT.
 *
 * The composer used to spread `{}` in place of its drag handlers whenever `canAttach` was false —
 * no `channelId`, or a `disabled` conversation. An element with no `dragover` handler is not a
 * drop target at all, so the browser keeps the drop and performs its own default for a file
 * dropped on a document: it navigates the top-level document to that file. The single-page app
 * unloads and takes the typed sentence and the parked queue with it. See `refuseDragOver` in
 * `composer.tsx` for the whole account.
 *
 * WHY THESE ASSERT ON `defaultPrevented` AND NOT ON A NAVIGATION. happy-dom implements no
 * navigation whatsoever — there is no unload to observe, no `location` change, nothing an
 * assertion could catch — so a test that tried to watch the symptom would pass identically before
 * and after the fix and would be worth nothing. `defaultPrevented` is the CAUSE: it is the exact
 * bit a real browser reads to decide whether to keep the drop, and it is the bit the old code
 * never set. Pinning the cause is the only honest thing this environment can pin.
 *
 * `createEvent` + `fireEvent` rather than `fireEvent.drop(...)`, because it keeps a handle on the
 * native event after dispatch. React's synthetic `preventDefault` forwards to that native event,
 * so `event.defaultPrevented` is a direct read of what the browser would see. The events are
 * cancelable by way of testing-library's own defaults for the drag family; an uncancelable event
 * would report `false` here forever and quietly turn these into tautologies.
 *
 * BOTH FORM BRANCHES ARE EXERCISED. `dropZone` is spread onto the compact form AND the full-size
 * one, and the full-size branch is what the home screen draws — a screen with no `channelId`, so
 * one of the two states under test. `composer-paste.test.tsx` exists because that branch was once
 * missed for exactly this kind of prop, and this file does not repeat the mistake.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `composer-dropped-attachments.test.tsx`: bun walks every file into one
 * process, and a document another file tore down mid-run fails invisibly. The registration carries
 * a `url` for the same reason it does there — without one `location` is `about:blank`.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/**
 * A `dataTransfer` good enough for the handler under test: it reads `.files` and writes
 * `.dropEffect`, and nothing here is asked to be a real `DataTransfer`.
 */
function transfer(...files: File[]) {
  return { dropEffect: "copy", files, items: [], types: ["Files"] };
}

/*
 * `createEvent.dragOver` is typed as returning a bare `Event`, which carries no `dataTransfer`.
 * testing-library copies the init's `dataTransfer` straight onto the event object it builds, so
 * the property really is there at run time: it is the very stub handed in at the call site. This
 * names that one fact, rather than asserting the event is a full `DragEvent` carrying a real
 * `DataTransfer` -- which is exactly what the stub above documents itself as not being.
 */
function dropEffectOf(event: Event) {
  return (event as Event & { dataTransfer: { dropEffect: string } })
    .dataTransfer.dropEffect;
}

function png(name: string) {
  return new File(["x"], name, { type: "image/png" });
}

function formIn(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector("form");
  if (!form) {
    throw new Error("the composer rendered no form to drop onto");
  }
  return form;
}

test("a file dropped on a composer with no channel does not reach the browser", () => {
  const { container } = render(<Composer compact onSubmit={() => {}} />);
  const form = formIn(container);

  /*
   * THE `dragover` ASSERTION IS THE LOAD-BEARING ONE, and it is the one the old code failed in a
   * way happy-dom cannot show. In a real browser an unprevented `dragover` means the element never
   * becomes a drop target and the `drop` below would not fire on it AT ALL — the browser would
   * take it. happy-dom dispatches whatever it is told to dispatch, so `drop` "arrives" here either
   * way; only this line distinguishes a form that would have caught the file from one that would
   * have watched the page navigate away.
   */
  const dragOver = createEvent.dragOver(form, { dataTransfer: transfer() });
  fireEvent(form, dragOver);
  expect(dragOver.defaultPrevented).toBe(true);

  const drop = createEvent.drop(form, { dataTransfer: transfer(png("a.png")) });
  fireEvent(form, drop);
  expect(drop.defaultPrevented).toBe(true);
});

test("a file dropped on a disabled conversation does not reach the browser", () => {
  const { container } = render(
    <Composer channelId="channel-1" compact disabled onSubmit={() => {}} />,
  );
  const form = formIn(container);

  const dragOver = createEvent.dragOver(form, { dataTransfer: transfer() });
  fireEvent(form, dragOver);
  expect(dragOver.defaultPrevented).toBe(true);

  const drop = createEvent.drop(form, { dataTransfer: transfer(png("b.png")) });
  fireEvent(form, drop);
  expect(drop.defaultPrevented).toBe(true);
});

test("the full-size composer with no channel guards its drop too", () => {
  // Not `compact`: the shape the home screen draws, which is also a screen with no `channelId`.
  const { container } = render(<Composer onSubmit={() => {}} />);
  const form = formIn(container);

  const dragOver = createEvent.dragOver(form, { dataTransfer: transfer() });
  fireEvent(form, dragOver);
  expect(dragOver.defaultPrevented).toBe(true);

  const drop = createEvent.drop(form, { dataTransfer: transfer(png("c.png")) });
  fireEvent(form, drop);
  expect(drop.defaultPrevented).toBe(true);
  // Refusing the drop is the floor, not the whole answer: the file is still gone, so it is named.
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "c.png",
  );
});

test("a drop with no channel behind it says so, and says what to do instead", async () => {
  const { container, findByRole } = render(
    <Composer compact onSubmit={() => {}} />,
  );

  fireEvent(
    formIn(container),
    createEvent.drop(formIn(container), {
      dataTransfer: transfer(png("screenshot.png")),
    }),
  );

  const alert = await findByRole("alert");
  expect(alert.textContent).toContain("screenshot.png");
  // The "not yet" sentence: there is a next step, and it is the one the compose screen is for.
  expect(alert.textContent).toContain("no conversation here yet");
  // And NOT the other one. Telling somebody on `/channel/new` that their conversation is over
  // would be false about a conversation that has not started.
  expect(alert.textContent).not.toContain("can no longer take messages");
});

test("a drop on a disabled conversation says that one instead", async () => {
  const { container, findByRole } = render(
    <Composer channelId="channel-1" compact disabled onSubmit={() => {}} />,
  );

  fireEvent(
    formIn(container),
    createEvent.drop(formIn(container), {
      dataTransfer: transfer(png("receipt.png")),
    }),
  );

  const alert = await findByRole("alert");
  expect(alert.textContent).toContain("receipt.png");
  expect(alert.textContent).toContain("can no longer take messages");
  // No "send this first" advice on a conversation where sending is the thing that cannot happen.
  expect(alert.textContent).not.toContain("no conversation here yet");
});

test("two files refused at once produce two lines, one per file", async () => {
  const { container, findByRole } = render(
    <Composer compact onSubmit={() => {}} />,
  );

  fireEvent(
    formIn(container),
    createEvent.drop(formIn(container), {
      dataTransfer: transfer(png("one.png"), png("two.png")),
    }),
  );

  const alert = await findByRole("alert");
  // Matching every other refusal on this composer: folding a batch into one line loses which file
  // the reason was about, and two files dragged from two folders share a name routinely.
  expect(container.querySelectorAll('[role="alert"] p')).toHaveLength(2);
  expect(alert.textContent).toContain("one.png");
  expect(alert.textContent).toContain("two.png");
});

test("a drop carrying no file is still refused, and says nothing", () => {
  const { container } = render(<Composer compact onSubmit={() => {}} />);
  const form = formIn(container);

  // A dragged link or a text selection. The browser navigates for these too, so the default still
  // has to be refused — but nothing was attached, there is no filename, and a refusal written here
  // would be one invented for a gesture nobody made.
  const drop = createEvent.drop(form, {
    dataTransfer: {
      dropEffect: "copy",
      files: [],
      items: [],
      types: ["text/uri-list"],
    },
  });
  fireEvent(form, drop);

  expect(drop.defaultPrevented).toBe(true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("the cursor over a composer that cannot take the file says so before it is let go", () => {
  const { container } = render(<Composer compact onSubmit={() => {}} />);
  const form = formIn(container);

  /*
   * READ BACK OFF THE EVENT, NOT OFF THE OBJECT HANDED TO `createEvent`, and the difference is not
   * a detail. happy-dom implements `DataTransfer`, so testing-library takes the branch that copies
   * each property of the init onto a REAL `new DataTransfer()` rather than attaching the literal
   * — the handler therefore never sees the object written here, and an assertion against it reads
   * an untouched "copy" forever no matter what the composer does. Asserting through the event is
   * asserting against the thing the handler was actually given.
   */
  const dragOver = createEvent.dragOver(form, {
    dataTransfer: transfer(png("d.png")),
  });
  fireEvent(form, dragOver);

  /*
   * `preventDefault` on `dragover` makes the form a drop target, and a drop target left at the
   * default effect draws the same copy-badge cursor the working composer draws — advertising an
   * acceptance that is about to be refused. "none" is the no-entry cursor, and it is the only part
   * of this refusal the person sees BEFORE they commit to the gesture. The init above says "copy",
   * so this passing means the composer changed it rather than that it was never set.
   */
  expect(dropEffectOf(dragOver)).toBe("none");
});

/**
 * THE BRANCH THAT ACCEPTS FILES IS A DROP TARGET TOO, AND NOTHING USED TO SAY SO.
 *
 * Every test above this one renders a composer that REFUSES. That left the whole file pinning one
 * half of `dropZone`: deleting `onDragOver` from the accepting branch kept all 600 tests green
 * while, in a real browser, a file dropped on a perfectly working composer navigated the page away
 * — the exact bug this file was written for, on the branch people use every day. An element is a
 * drop target only if something calls `preventDefault` on its `dragover`; "it has an `onDrop`" is
 * not the same claim and does not imply it.
 *
 * WHY THE `dropEffect` LINE IS HERE AND NOT JUST THE FIRST ONE. Since `useUnclaimedDropGuard`
 * (`routes/__root.tsx`) now refuses every unclaimed drop app-wide, a composer that quietly stopped
 * claiming its own `dragover` would no longer navigate the page — the root would catch it — but it
 * WOULD start drawing the root's no-entry cursor over a box that is about to accept the file. This
 * asserts the effect is untouched at the "copy" the init sets, which is the cursor that says yes.
 */
test("a composer that can take the file claims the drag before the browser does", () => {
  const { container } = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const form = formIn(container);

  const dragOver = createEvent.dragOver(form, {
    dataTransfer: transfer(png("welcome.png")),
  });
  fireEvent(form, dragOver);

  expect(dragOver.defaultPrevented).toBe(true);
  expect(dropEffectOf(dragOver)).toBe("copy");
});

/**
 * THE SECOND DROP LANDS ON THE FIRST REFUSAL, AND THAT IS NOT A CONTRIVED GESTURE.
 *
 * `RejectedFiles` renders ABOVE the form — deliberately, so the reasons sit next to the box rather
 * than below it — and the handlers used to be on the form alone. So the strip was a hole in the
 * guard, and the likeliest drop in the whole app aims straight at it: somebody drops a file, reads
 * the sentence saying why it was not taken, and drops the retry on the sentence they are reading.
 * That one went to the browser, and the page unloaded with the refusal still on screen.
 *
 * The handlers sit on the container that wraps both now — the same element `containerRef` marks for
 * the paste listener, so "inside this composer" means one thing for both doors.
 */
test("a file let go over the refusal it caused is caught as well", async () => {
  const view = render(<Composer compact onSubmit={() => {}} />);
  const { container, findByRole } = view;
  const form = formIn(container);

  fireEvent(
    form,
    createEvent.drop(form, { dataTransfer: transfer(png("first.png")) }),
  );
  const alert = await findByRole("alert");

  const second = createEvent.drop(alert, {
    dataTransfer: transfer(png("second.png")),
  });
  fireEvent(alert, second);

  expect(second.defaultPrevented).toBe(true);
  // And it is answered rather than merely swallowed: two files were let go, so two lines say so.
  expect(container.querySelectorAll('[role="alert"] p')).toHaveLength(2);
  expect(container.textContent).toContain("second.png");
});

/**
 * ADVICE THAT CANNOT BE FOLLOWED IS WORSE THAN NONE.
 *
 * The sentence used to be chosen by `attachmentsEnabled` — is there a channel — which is right for
 * three of the four states and wrong for this one. A composer that is BOTH `disabled` and
 * channel-less was told "there is no conversation here yet. Send this message first, then attach to
 * the one it opens", with the Send button beside it shut. Following that instruction is pressing a
 * dead button; the person concludes the app is broken rather than that this conversation is over.
 * `disabled` is the question actually being answered: can they do the thing the sentence is about
 * to tell them to do.
 */
test("a disabled composer with no channel does not tell people to send first", async () => {
  const { container, findByRole, getByLabelText } = render(
    <Composer compact disabled onSubmit={() => {}} />,
  );
  const form = formIn(container);

  fireEvent(
    form,
    createEvent.drop(form, { dataTransfer: transfer(png("late.png")) }),
  );

  const alert = await findByRole("alert");
  expect(alert.textContent).toContain("late.png");
  expect(alert.textContent).toContain("can no longer take messages");
  // The half that made the old sentence a lie, asserted rather than assumed: the control it sent
  // them to is shut.
  expect((getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(alert.textContent).not.toContain("Send this message first");
});
