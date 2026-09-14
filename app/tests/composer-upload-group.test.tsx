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
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/channels/attachments";
import { settleReactWork } from "./settle-react-work";

/**
 * THE TWO HALVES OF ONE CAP, AND THE TICK IN WHICH THE CLIENT'S HALF USED TO MISCOUNT.
 *
 * The per-message cap has two enforcers. This file pins the client's: that every upload carries the
 * key the server counts by, and that two gestures landing in the same tick cannot between them
 * stage more than the cap allows.
 *
 * THE HARNESS IS THIS REPOSITORY'S, matching `composer-attachment-lifecycle.test.tsx` —
 * `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in `afterEach`, because bun walks
 * every file into one process and a document another file tore down mid-run fails invisibly. The
 * registration carries a `url` because without one `location` is `about:blank` and the relative
 * upload URL does not resolve.
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

/** The `uploadGroup` field of every upload this composer sent, in order. */
let groups: (string | null)[];

beforeEach(() => {
  groups = [];
  global.fetch = (async (_path: string, init: RequestInit) => {
    const body = init.body as FormData;
    const file = body.get("file") as File;
    const group = body.get("uploadGroup");
    groups.push(typeof group === "string" ? group : null);
    return new Response(
      JSON.stringify({
        id: `stored-${groups.length}`,
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

function textFiles(prefix: string, count: number): File[] {
  return Array.from(
    { length: count },
    (_, index) =>
      new File(["hello"], `${prefix}-${index}.txt`, { type: "text/plain" }),
  );
}

/**
 * TWO GESTURES, ONE TICK — a drop landing while another is still being screened.
 *
 * `stageFiles` used to screen against `staged.length`, a number captured at render, and it is
 * async: neither drop below has re-rendered the composer by the time the other reads it, so both
 * read zero and both accepted a full batch. Ten uploads went out against a cap of eight, and the
 * server refused the last two — a refusal the person had been given no chance to avoid.
 *
 * The uploads actually attempted are what is counted, not only the chips: the cap exists to bound
 * what reaches the server, and the chips are waited on first only because they settle after the
 * uploads do, which is what gives a surplus a chance to be seen rather than merely missed.
 */
test("two batches staged in one tick cannot exceed the per-message cap", async () => {
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  // No await between them: this is the whole point. Five and five is ten, and the cap is eight.
  drop(form, textFiles("first", 5));
  drop(form, textFiles("second", 5));

  // The chips settle after the uploads do, so waiting on them is what lets a batch that should
  // have been refused go out first and be counted — an over-count shows up here as a surplus
  // rather than as a wait that merely has not finished yet.
  await waitFor(() =>
    expect(view.queryAllByLabelText(/^Remove /)).toHaveLength(
      MAX_ATTACHMENTS_PER_MESSAGE,
    ),
  );

  expect(groups).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
  // And the two that did not fit are refused in our words, naming each file, rather than by a
  // server 409 the person was given no chance to avoid.
  //
  // Built from the constant rather than written out, because the literal `8` two lines under
  // `MAX_ATTACHMENTS_PER_MESSAGE` is the same number in two spellings: change the cap and this
  // regex quietly stops matching the sentence it is checking, and the failure reads as a
  // rejection-count problem rather than as a stale literal.
  expect(
    view.queryAllByText(
      new RegExp(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`),
    ),
  ).toHaveLength(2);
});

/**
 * One key per composer, on every upload it makes — which is what lets the server count the same set
 * this composer can see instead of every unsent row in the channel.
 */
test("every upload from one composer carries the same upload group", async () => {
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  drop(form, textFiles("first", 1));
  await waitFor(() => expect(groups).toHaveLength(1));
  drop(form, textFiles("second", 1));
  await waitFor(() => expect(groups).toHaveLength(2));

  const [first, second] = groups;
  expect(typeof first).toBe("string");
  expect((first as string).length).toBeGreaterThan(0);
  expect(second).toBe(first);
});

/**
 * WHAT IS PARKED COUNTS TOO, BECAUSE THE SERVER IS STILL COUNTING IT.
 *
 * Parking a message takes its chips off the strip, but `attachedAt` is written only when the
 * message is really sent — so those rows stay `attached_at IS NULL` in this composer's
 * `uploadGroup` for the whole life of the turn, and the server's cap counts exactly that set. With
 * the strip empty the client screened against zero, accepted the pick, and let the server refuse it
 * with a 409 the person had been given no chance to avoid.
 *
 * The count arrives as a prop because the composer cannot see the queue: `conversation-view.tsx`
 * owns it. This drives the prop directly, which is the whole of the composer's half of the
 * contract — the caller's half is one `reduce` there.
 */
test("attachments parked in the queue are counted against the per-message cap", async () => {
  const view = render(
    <Composer
      channelId="channel-1"
      compact
      onSubmit={() => {}}
      // A full cap's worth already parked, and nothing at all on this composer's strip.
      queuedAttachmentCount={MAX_ATTACHMENTS_PER_MESSAGE}
    />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  drop(form, textFiles("ninth", 1));

  // Refused here, in our words, naming the file — rather than uploaded and then refused by the
  // server in its own.
  await waitFor(() =>
    expect(
      view.queryAllByText(
        new RegExp(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`),
      ),
    ).toHaveLength(1),
  );
  expect(groups).toEqual([]);
});

/**
 * And the prop is an addend, not an override: a composer told about parked files still counts what
 * is on its own strip. Seven parked plus one staged is the cap, so the next pick is the ninth.
 */
test("parked attachments are counted alongside the ones on the strip", async () => {
  const view = render(
    <Composer
      channelId="channel-1"
      compact
      onSubmit={() => {}}
      queuedAttachmentCount={MAX_ATTACHMENTS_PER_MESSAGE - 1}
    />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  // The eighth overall, and the first this composer can see: accepted.
  drop(form, textFiles("eighth", 1));
  await waitFor(() => expect(groups).toHaveLength(1));

  // The ninth: refused, without the strip ever having held more than one chip.
  drop(form, textFiles("ninth", 1));
  await waitFor(() =>
    expect(
      view.queryAllByText(
        new RegExp(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`),
      ),
    ).toHaveLength(1),
  );
  expect(groups).toHaveLength(1);
});

/** Two composers are two sessions, and the cap they are counted against is per session. */
test("a second composer mints a group of its own", async () => {
  const first = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  drop(first.container.querySelector("form") as HTMLFormElement, [
    new File(["hello"], "a.txt", { type: "text/plain" }),
  ]);
  await waitFor(() => expect(groups).toHaveLength(1));

  const second = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  drop(second.container.querySelector("form") as HTMLFormElement, [
    new File(["hello"], "b.txt", { type: "text/plain" }),
  ]);
  await waitFor(() => expect(groups).toHaveLength(2));

  expect(groups[1]).not.toBe(groups[0]);
});
