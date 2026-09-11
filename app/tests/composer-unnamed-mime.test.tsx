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
 * A CLAIM THAT NAMES NO FORMAT, ALL THE WAY TO THE UPLOAD — WHICH IS THE ONLY PLACE IT CAN BE SEEN.
 *
 * `screenPickedFiles` deliberately lets `application/octet-stream` and a blank type through so the
 * server can read the bytes (`picked-files.ts`, "THE BROWSER TOLD US NOTHING, SO THE SERVER GETS TO
 * LOOK"), and `picked-files.test.ts` pins that. It pins the pure function, and the pure function was
 * never the problem: the SDK's `processFiles` applies `AttachmentsConfig.accept` itself with an
 * exact `file.type === filter`, so for eighteen months the branch could be — and was — completely
 * dead downstream of a unit test that went on passing. Four reviewers found it by reading; nothing
 * in the suite could.
 *
 * So these tests are deliberately NOT about `screenPickedFiles`. They drive a real `Composer` with
 * the real `useAttachments`, and they assert on the two things only the whole path can show: that a
 * request went out, and that no refusal was drawn. That is the gap, and this is the level it lives
 * at.
 *
 * THE HARNESS IS THIS REPOSITORY'S, matching `composer-upload-group.test.tsx` — `GlobalRegistrator`
 * in `beforeAll`/`afterAll` and `cleanup` in `afterEach`, because bun walks every file into one
 * process and a document another file tore down mid-run fails invisibly. The registration carries a
 * `url` because without one `location` is `about:blank` and the relative upload URL does not
 * resolve.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** The `type` of every file this composer actually tried to upload, in order. */
let uploaded: { name: string; type: string }[];

beforeEach(() => {
  uploaded = [];
  global.fetch = (async (_path: string, init: RequestInit) => {
    const file = (init.body as FormData).get("file") as File;
    uploaded.push({ name: file.name, type: file.type });
    return new Response(
      JSON.stringify({
        // The server's answer, and the point of the round trip: it read the bytes and named the
        // format the browser could not.
        id: `stored-${uploaded.length}`,
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

/**
 * The two ways a browser says "I have no idea what this is": the generic binary claim it attaches
 * to an unfamiliar extension, and no claim at all. `namesNoFormat` treats them identically and so
 * does the server, so both have to survive the same journey.
 */
const unnamed = [
  { label: "application/octet-stream", type: "application/octet-stream" },
  { label: "a blank type", type: "" },
] as const;

for (const claim of unnamed) {
  test(`a file claiming ${claim.label} is uploaded for the server to sniff`, async () => {
    const view = render(
      <Composer channelId="channel-1" compact onSubmit={() => {}} />,
    );
    const form = view.container.querySelector("form") as HTMLFormElement;

    drop(form, [new File(["hello"], "notes.txt", { type: claim.type })]);

    // The request is the assertion. Before this was fixed the SDK's `accept` filter refused the
    // file first, so nothing was ever sent and the branch that let it through was decoration.
    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(uploaded[0].name).toBe("notes.txt");
    // Handed over exactly as the browser reported it: `withMediaTypeOnly` normalises case and
    // strips parameters, and neither of these has either, so the server sees what we saw.
    expect(uploaded[0].type).toBe(claim.type);

    // And no refusal is drawn for it — not ours, and above all not the SDK's
    // `File "notes.txt" is not accepted. Supported types: …`, which is the machine sentence
    // `stageFiles` promises a screened file can never produce.
    await waitFor(() =>
      expect(view.queryByLabelText("Remove notes.txt")).not.toBeNull(),
    );
    expect(view.queryByRole("alert")).toBeNull();
  });
}

/**
 * The other half, and the reason `accept` cannot simply be deleted from the design: opening the
 * gate for unnamed claims must not open it for named ones. An SVG says exactly what it is, and the
 * screen still refuses it in the product's own words rather than passing it to the SDK to refuse in
 * the SDK's.
 */
test("a file that does name its format is still refused here, in our words", async () => {
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  drop(form, [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })]);

  await waitFor(() => expect(view.queryByRole("alert")).not.toBeNull());
  expect(
    view.queryByText(/can carry scripts and is not accepted/),
  ).not.toBeNull();
  expect(view.queryByText(/Supported types:/)).toBeNull();
  expect(uploaded).toEqual([]);
});
