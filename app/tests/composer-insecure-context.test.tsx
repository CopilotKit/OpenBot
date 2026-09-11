import type { Attachment } from "@copilotkit/react-core/v2";
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
 * THE COMPOSER ON A DEPLOYMENT THAT IS NOT A SECURE CONTEXT.
 *
 * `crypto.randomUUID` is a secure-context-only API. `http://localhost` is one, which is why a
 * laptop never sees this; a deployment reached at plain `http://<address>` is not, and the property
 * is simply ABSENT there — so the call does not degrade, it throws a `TypeError`. `lib/new-id.ts`
 * exists for that reason alone and `new-id.test.ts` pins the function itself.
 *
 * These pin the CALLERS, which is the half that was wrong. Three id-minting sites in this composer
 * called `crypto.randomUUID` directly, and all three are on the path that reports a refusal — so on
 * an http deployment the composer's answer to a bad file was to break in a different way each time
 * and say nothing at all. Every test below removes the function, exactly as that deployment does,
 * and asserts the sentence still arrives.
 *
 * WHY IT IS DONE HERE AND NOT WITH A MOCK. The throw has to come from the real call site inside the
 * real render, because what made this dangerous was never the id: it was where the throw landed —
 * inside `screenPickedFiles` (taking the whole screening pass), inside the SDK's per-file upload
 * loop, and inside a `useEffect` (taking the tree). A stub that returns a fake id would test the
 * stub.
 *
 * THE HARNESS IS THIS REPOSITORY'S, matching `composer-attachment-lifecycle.test.tsx` —
 * `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in `afterEach`, because bun walks
 * every file into one process and a document another file tore down mid-run fails invisibly. The
 * registration carries a `url` because without one `location` is `about:blank` and the relative
 * upload URL does not resolve.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let originalRandomUUID: typeof crypto.randomUUID;

/**
 * An origin that is not a secure context, spelled the way `new-id.test.ts` spells it: the property
 * is gone, not merely different.
 *
 * Taken in `beforeEach` rather than once at module scope because bun runs every test file into one
 * process, and a sibling that installs its own stub would otherwise be restored over.
 */
beforeEach(() => {
  originalRandomUUID = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: originalRandomUUID,
  });
  global.fetch = originalFetch;
});

/**
 * The SDK mints its own placeholder ids with `uuid`'s v4, which reads `crypto.getRandomValues` and
 * has no secure-context requirement — so removing `randomUUID` leaves uploads themselves working
 * and breaks only our own refusal bookkeeping. That is the worst way round, and it is why these
 * tests can drive a full upload with the function missing.
 */
function drop(form: Element, files: File[]) {
  fireEvent.drop(form, {
    dataTransfer: { files, items: [], types: ["Files"] },
  });
}

test("a pick-time refusal still names the file with no crypto.randomUUID", async () => {
  /*
   * `picked-files.ts`'s `reject()`. The throw came out of `screenPickedFiles` itself, which is the
   * single door every drag, paste and file dialog goes through — so the FIRST refusable file in a
   * gesture aborted the whole pass and the acceptable files beside it were never staged either.
   * Both halves are asserted: the sentence about the SVG, and notes.txt staged from the same drop.
   */
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  global.fetch = (async (_path: string, init: RequestInit) => {
    const file = (init.body as FormData).get("file") as File;
    return new Response(
      JSON.stringify({ id: "stored-1", name: file.name, mimeType: file.type }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const form = view.container.querySelector("form") as HTMLFormElement;

  drop(form, [
    new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
    new File(["hello"], "notes.txt", { type: "text/plain" }),
  ]);

  await waitFor(() => expect(view.queryByRole("alert")).not.toBeNull());
  expect(
    view.queryByText(/can carry scripts and is not accepted/),
  ).not.toBeNull();
  // The rest of the gesture survived the refusal, which is the part the throw used to take with it.
  await waitFor(() =>
    expect(view.queryByLabelText("Remove notes.txt")).not.toBeNull(),
  );
});

test("an upload refusal still reaches the strip with no crypto.randomUUID", async () => {
  /*
   * `recordRejection`, which is the SDK's `onUploadFailed` — called from inside `processFiles`'
   * per-file loop. A throw there escaped the loop, so the report of a failed upload itself failed:
   * the file left the strip the way a failed upload always does and the sentence never arrived.
   */
  global.fetch = (async () =>
    new Response(JSON.stringify({ error: "That file is not allowed here." }), {
      status: 415,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  /*
   * The SDK `console.error`s every failed upload before it calls `onUploadFailed`, and this test
   * fails one on purpose — so without this the suite reports an error for the one thing here that
   * is meant to happen, and a real error would be lost in the noise. Silenced the way
   * `composer-rejected-files.test.tsx` silences React's key warning, and restored in a `finally` so
   * a failing assertion cannot leave the console swallowed for every file after this one.
   */
  const realError = console.error;
  console.error = () => {};
  try {
    const view = render(
      <Composer channelId="channel-1" compact onSubmit={() => {}} />,
    );
    const form = view.container.querySelector("form") as HTMLFormElement;

    drop(form, [new File(["hello"], "notes.txt", { type: "text/plain" })]);

    await waitFor(() =>
      expect(
        view.queryByText(/That file is not allowed here\./),
      ).not.toBeNull(),
    );
  } finally {
    console.error = realError;
  }
});

test("a queue drop still names its files with no crypto.randomUUID", () => {
  /*
   * The `droppedAttachments` effect, and the least survivable of the three: an effect body that
   * throws propagates out of React's commit, so this rendered nothing at all rather than rendering
   * the list of files the queue had just thrown away.
   */
  const view = render(
    <Composer
      compact
      droppedAttachments={{
        attachments: [
          {
            filename: "invoice.pdf",
            id: "one",
            source: { type: "url", value: "https://example.com/one.pdf" },
            status: "ready",
            type: "image",
          } satisfies Attachment,
        ],
        cause: "queued-message-removed",
      }}
      onSubmit={() => {}}
    />,
  );

  expect(view.queryByRole("alert")).not.toBeNull();
  expect(view.queryByText(/invoice\.pdf/)).not.toBeNull();
});
