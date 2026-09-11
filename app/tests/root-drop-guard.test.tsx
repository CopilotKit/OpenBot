import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
} from "@testing-library/react";
import { useUnclaimedDropGuard } from "@/routes/__root";
import { settleReactWork } from "./settle-react-work";

/**
 * A FILE DROPPED WHERE NOTHING WAS LISTENING DOES NOT TAKE THE PAGE WITH IT.
 *
 * The browser's default for a file dropped on a document is to navigate the top-level document to
 * that file, which unloads the app and everything it was holding. `useUnclaimedDropGuard` in
 * `routes/__root.tsx` is the app-wide floor under that; its docblock has the whole account, and
 * this file pins the two halves that make it both effective and safe.
 *
 * WHY THESE ASSERT ON `defaultPrevented` AND NOT ON A NAVIGATION, said again here because it is the
 * thing a reader will doubt: happy-dom implements no navigation whatsoever — there is no unload to
 * observe, no `location` change, nothing an assertion could catch — so a test that watched for the
 * symptom would pass identically with and without the guard and would be worth nothing.
 * `defaultPrevented` is the CAUSE: it is the exact bit a real browser reads to decide whether to
 * keep the drop for itself, and it is the bit that was never set before this guard existed.
 *
 * `createEvent` + `fireEvent` rather than `fireEvent.drop(...)`, to keep a handle on the native
 * event after dispatch — matching `composer-drop-guard.test.tsx`, which explains the choice at
 * length.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`: bun walks every file into one process, and a document another file tore down
 * mid-run fails invisibly. The registration carries a `url` for the same reason it does there —
 * without one `location` is `about:blank`.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The guard on its own, with no router around it: the hook is the whole of the behaviour. */
function Guarded({ children }: { children?: React.ReactNode }) {
  useUnclaimedDropGuard();
  return <div>{children}</div>;
}

/**
 * A `dataTransfer` good enough for the guard: it reads `.files` never, and writes `.dropEffect`.
 * `dropEffect` starts at "copy" so that a test asserting "none" is asserting that the guard CHANGED
 * it rather than that nobody ever set it.
 */
function transfer() {
  return { dropEffect: "copy", files: [], items: [], types: ["Files"] };
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

test("a drop on a page region nobody claimed is refused rather than navigated to", () => {
  render(<Guarded />);

  const drop = createEvent.drop(document.body, { dataTransfer: transfer() });
  fireEvent(document.body, drop);

  expect(drop.defaultPrevented).toBe(true);
});

test("the cursor over unclaimed page says the app will not take the file", () => {
  render(<Guarded />);

  const dragOver = createEvent.dragOver(document.body, {
    dataTransfer: transfer(),
  });
  fireEvent(document.body, dragOver);

  /*
   * `preventDefault` is what stops the navigation; `dropEffect` is the only part of the refusal
   * that reaches the person BEFORE they let go. A prevented `dragover` left at the default effect
   * draws the copy badge — promising to accept a file that is about to land in nothing.
   *
   * Read back off the event rather than off the object handed to `createEvent`: happy-dom
   * implements `DataTransfer`, so testing-library copies the init onto a real one and the handler
   * never sees the literal written above.
   */
  expect(dragOver.defaultPrevented).toBe(true);
  expect(dropEffectOf(dragOver)).toBe("none");
});

test("a drop something in the tree has already claimed is left entirely alone", () => {
  /*
   * THE HALF THAT MAKES AN APP-WIDE GUARD SAFE TO HAVE. A drop target — today's composer, or any
   * surface added later — becomes one by calling `preventDefault` on `dragover`. The guard listens
   * in the bubble phase and stands down on an event that is already prevented, so the very line a
   * drop target must write in order to work at all is the line that makes the guard ignore it.
   * Without that check this guard would quietly draw a no-entry cursor over every working drop
   * target in the app, which is exactly the failure the composer's comment warned a document-level
   * listener could cause.
   */
  const claimed: string[] = [];
  const { getByTestId } = render(
    <Guarded>
      {/** biome-ignore lint/a11y/noStaticElementInteractions: a stand-in drop target, not a control. */}
      <div
        data-testid="claimant"
        onDragOver={(event) => {
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          claimed.push("drop");
        }}
      />
    </Guarded>,
  );

  const target = getByTestId("claimant");
  const dragOver = createEvent.dragOver(target, { dataTransfer: transfer() });
  fireEvent(target, dragOver);
  const drop = createEvent.drop(target, { dataTransfer: transfer() });
  fireEvent(target, drop);

  // The claimant's own answer survives the guard: it still gets the drop, and the cursor still
  // says the file is welcome.
  expect(claimed).toEqual(["drop"]);
  expect(dropEffectOf(dragOver)).toBe("copy");
});

test("the guard leaves with the app rather than outliving it", () => {
  const { unmount } = render(<Guarded />);
  unmount();

  const drop = createEvent.drop(document.body, { dataTransfer: transfer() });
  fireEvent(document.body, drop);

  /*
   * A listener left on `document` after unmount is the leak the composer's comment named as the
   * reason a leaf must not own this — installed once per mount, torn down by whichever unmounted
   * first. The root mounts once, but the teardown is what makes that claim checkable, and a test
   * process that walks many files into one document is exactly where a stray listener would start
   * answering for somebody else's test.
   */
  expect(drop.defaultPrevented).toBe(false);
});

/**
 * A DRAGGED PHRASE IS NOT THIS GUARD'S BUSINESS, AND THE DISTINCTION IS LOAD-BEARING.
 *
 * An editable element — a text input, or the composer's own contenteditable editor — is a drop
 * target the BROWSER makes, with no script preventing anything. So an app-wide guard that refused
 * every unclaimed drop would refuse dragging a selected phrase into the message box: a gesture
 * people use, that nothing in this app implements and so nothing in this app could give back. The
 * guard asks whether the drag carries FILES, which is the payload that unloads the page, and lets
 * every text drag past untouched.
 *
 * The cost of that narrowing is named in the guard's own comment: a dragged LINK let go on the page
 * margin still navigates. That is the trade, not an oversight.
 */
test("a dragged phrase carrying no file is left to the browser to handle", () => {
  render(<Guarded />);

  const dragOver = createEvent.dragOver(document.body, {
    dataTransfer: {
      dropEffect: "copy",
      files: [],
      items: [],
      types: ["text/plain"],
    },
  });
  fireEvent(document.body, dragOver);

  // Untouched on both counts: the browser still decides, and the cursor is not overwritten with
  // the no-entry badge over an input that would have taken the text.
  expect(dragOver.defaultPrevented).toBe(false);
  expect(dropEffectOf(dragOver)).toBe("copy");
});
