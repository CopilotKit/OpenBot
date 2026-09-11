import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";

/**
 * A CHIP REMOVED WHILE ITS UPLOAD IS STILL IN THE AIR, WHICH USED TO LEAVE A ROW NOBODY COULD SEE.
 *
 * `removeAttachment` drops the SDK's placeholder. The upload it belonged to is mid-flight, so when
 * it lands the SDK writes its answer onto a placeholder that no longer exists and the write is a
 * no-op — but the row is on the server by then, in THIS composer's `uploadGroup`, which is minted
 * once per mount and lives as long as the composer does. The screen counts seven, the server counts
 * eight, and the next pick comes back `409 You already have 8 attachments waiting to send in this
 * channel.` naming files that are on nobody's screen. That is verbatim the failure `uploadGroup`
 * was introduced to remove, reached through a Remove button rather than through a closed tab.
 *
 * The composer cannot ask "was my chip removed?" at the moment the upload lands: `onUpload` is
 * handed a `File` and the SDK never says which placeholder the call belongs to. So it reconciles
 * instead — every row it uploaded against every row still drawn — and these tests drive that from
 * both sides, because a reconciler that deletes too much is worse than the leak it replaces.
 *
 * A HARNESS OF ITS OWN RATHER THAN `composer-attachment-lifecycle.test.tsx`'s, for two reasons that
 * file's fixture cannot give: an upload that can be RELEASED on demand rather than merely held
 * open forever, and a distinct server id per file, since the whole question here is which row was
 * given back. That file answers `stored-id` to everything, which cannot tell two rows apart.
 *
 * `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in `afterEach` is this repository's
 * pattern, because bun walks every file into one process and a document another file tore down
 * mid-run fails invisibly. The registration carries a `url` because without one `location` is
 * `about:blank` and the relative upload URL does not resolve.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** Every `DELETE` this composer sent, by path. */
let deletes: string[];
/** Uploads that have started and are waiting to be let go, in the order they started. */
let held: (() => void)[];

/** Let every upload currently in the air answer. */
function releaseUploads() {
  const waiting = held;
  held = [];
  for (const release of waiting) {
    release();
  }
}

beforeEach(() => {
  deletes = [];
  held = [];
  global.fetch = (async (path: string, init: RequestInit) => {
    if (init?.method === "DELETE") {
      deletes.push(path);
      return new Response(null, { status: 204 });
    }
    const file = (init.body as FormData).get("file") as File;
    // Held until the test says otherwise, which is what makes "still in flight" a state a test can
    // stand in rather than a race it has to win.
    await new Promise<void>((resolve) => {
      held.push(resolve);
    });
    return new Response(
      JSON.stringify({
        // Named after the file so an assertion can say WHICH row was given back. That is the whole
        // question in the two-file case below.
        id: `row-${file.name}`,
        name: file.name,
        mimeType: "text/plain",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

function drop(form: Element, files: File[]) {
  fireEvent.drop(form, {
    dataTransfer: { files, items: [], types: ["Files"] },
  });
}

function textFile(name: string): File {
  return new File(["hello"], name, { type: "text/plain" });
}

test("a chip removed mid-upload gives its row back once the upload lands", async () => {
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  drop(form, [textFile("notes.txt")]);
  // The placeholder goes on the strip the moment the upload starts, which is the window this whole
  // test lives in: a chip on screen with no row behind it yet.
  await waitFor(() =>
    expect(view.queryByLabelText("Remove notes.txt")).not.toBeNull(),
  );

  fireEvent.click(view.getByLabelText("Remove notes.txt"));
  expect(view.queryByLabelText("Remove notes.txt")).toBeNull();
  // Nothing to delete yet, and nothing invented: the row does not exist until the upload answers,
  // so a DELETE here would be for an id the composer has never been told.
  expect(deletes).toEqual([]);

  releaseUploads();

  // And now it does exist, with no chip left to stand for it — so it goes back rather than sitting
  // out the sweeper's 24-hour window counting against this channel's cap.
  await waitFor(() =>
    expect(deletes).toEqual(["/api/attachments/row-notes.txt"]),
  );
});

test("only the removed one is given back when two uploads are in the air", async () => {
  /*
   * The half a reconciler gets wrong. Two uploads are in flight at once — two drops, two
   * concurrent `processFiles` calls, since the SDK's own loop is sequential within one call — and
   * only one chip is removed. Giving back both, or giving back the wrong one, would leave a live
   * chip on the strip pointing at a row that has just been deleted: a message sent carrying a link
   * to nothing, which is worse than the leak.
   */
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  drop(form, [textFile("gone.txt")]);
  drop(form, [textFile("kept.txt")]);
  await waitFor(() => {
    expect(view.queryByLabelText("Remove gone.txt")).not.toBeNull();
    expect(view.queryByLabelText("Remove kept.txt")).not.toBeNull();
  });

  fireEvent.click(view.getByLabelText("Remove gone.txt"));
  releaseUploads();

  await waitFor(() =>
    expect(deletes).toEqual(["/api/attachments/row-gone.txt"]),
  );
  // The one nobody touched is still on the strip, and still owns its row.
  expect(view.queryByLabelText("Remove kept.txt")).not.toBeNull();
});

test("an upload nobody removed keeps its row", async () => {
  /*
   * The reconciler's own restraint, pinned on its own. Every test above removes something, so a
   * reconciler that simply deleted every row it had ever heard about would pass all of them.
   */
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  drop(form, [textFile("notes.txt")]);
  await waitFor(() =>
    expect(view.queryByLabelText("Remove notes.txt")).not.toBeNull(),
  );
  releaseUploads();

  // Waited for through the Send button rather than through the chip: the chip is on screen from the
  // moment the upload starts, so it settles BEFORE the upload lands and would let this assert
  // against a composer that had not yet reconciled anything. `canSendDraft` refuses a draft
  // carrying an upload in flight, so a live Send is an upload that has been answered.
  await waitFor(() =>
    expect(
      (view.getByLabelText("Send message") as HTMLButtonElement).disabled,
    ).toBe(false),
  );

  expect(deletes).toEqual([]);
  expect(view.queryByLabelText("Remove notes.txt")).not.toBeNull();
});

test("a message that was sent keeps the rows it carried", async () => {
  /*
   * The send's half of the same rule as the queue's, below. A landed send takes its chips off the
   * strip, which to the reconciler is indistinguishable from somebody removing them — and deleting
   * those rows would delete attachments out of a message that has already gone.
   *
   * `composer-attachment-lifecycle.test.tsx` covers the same ground and cannot see this: its
   * fixture answers `stored-id` to every upload, so the row released by the send is the same string
   * as every other row and the mistake cancels itself out. Distinct ids per file are the whole
   * reason this file has a fixture of its own.
   */
  const sent: unknown[] = [];
  const view = render(
    <Composer
      channelId="channel-1"
      compact
      onSubmit={(draft) => {
        sent.push(draft);
      }}
    />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  drop(form, [textFile("notes.txt")]);
  await waitFor(() =>
    expect(view.queryByLabelText("Remove notes.txt")).not.toBeNull(),
  );
  releaseUploads();
  // `canSendDraft` refuses a draft carrying an upload in flight, so a live Send is an upload that
  // has been answered — and a submit fired before that would be a no-op.
  await waitFor(() =>
    expect(
      (view.getByLabelText("Send message") as HTMLButtonElement).disabled,
    ).toBe(false),
  );

  fireEvent.submit(form);

  await waitFor(() => expect(sent).toHaveLength(1));
  await waitFor(() =>
    expect(view.queryByLabelText("Remove notes.txt")).toBeNull(),
  );
  expect(deletes).toEqual([]);
});

test("a parked message keeps the rows it is carrying", async () => {
  /*
   * The queue takes the chips off the strip without the attachments having been sent, so to the
   * reconciler this looks exactly like a removal — and it must not be treated as one. The parked
   * message still holds those attachments and will send them when the turn drains; deleting their
   * rows here would send it carrying links to nothing.
   */
  const queued: unknown[] = [];
  const sent: unknown[] = [];
  const view = render(
    <Composer
      channelId="channel-1"
      compact
      onQueue={(draft) => queued.push(draft)}
      // A turn is in flight, which is what makes the send park rather than send.
      pending
      onSubmit={(draft) => {
        sent.push(draft);
      }}
    />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  drop(form, [textFile("notes.txt")]);
  await waitFor(() =>
    expect(view.queryByLabelText("Remove notes.txt")).not.toBeNull(),
  );
  releaseUploads();
  await waitFor(() =>
    expect(
      (view.getByLabelText("Queue message") as HTMLButtonElement).disabled,
    ).toBe(false),
  );

  fireEvent.submit(form);

  await waitFor(() => expect(queued).toHaveLength(1));
  // The chip has left the strip with the parked message, and the row has NOT been given back.
  expect(view.queryByLabelText("Remove notes.txt")).toBeNull();
  expect(deletes).toEqual([]);

  /*
   * AND `onSubmit` WAS NOT CALLED, WHICH IS LOAD-BEARING SOMEWHERE ELSE ENTIRELY.
   *
   * `reduceQueue`'s submit branch has a join for "send now, with messages already parked" and says
   * of it: "The two disagreeing is not supposed to be reachable — the drain empties the queue on
   * the same edge that frees the composer." That join is the one path on which the cap can bump the
   * LIVE draft's attachments, `conversation-view` deletes their rows as `droppedAttachments`, and
   * this composer's failure path then hands the same chips back — chips pointing at rows that no
   * longer exist.
   *
   * It is unreachable because of the line asserted here: the composer parks instead of sending
   * whenever a turn is in flight, so `conversation-view`'s `submit(draft, false)` — the only caller
   * that can pass `busy: false` — cannot fire while anything is parked. The queue is only ever
   * non-empty while a turn is in flight, and the drain runs on the same commit that ends it.
   *
   * So the join is defensive, and this is the assertion that keeps it that way. If the composer
   * ever sends while busy, that whole path goes live and the restore in `submitDraft`'s catch is
   * where it will show up.
   */
  expect(sent).toEqual([]);
});
