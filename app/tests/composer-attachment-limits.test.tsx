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
import {
  attachmentLimitsFrom,
  DEFAULT_ATTACHMENT_LIMITS,
} from "@/lib/channels/attachments";
import { problem } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * The composer refuses a picked file with the server's numbers, and with today's 8MB and 1MB when
 * the server says nothing. Harness as in `composer-attachments-ui.test.tsx`.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const MIB = 1024 * 1024;
const originalFetch = global.fetch;
let uploads: string[];

beforeEach(() => {
  uploads = [];
  global.fetch = (async (path: string, init: RequestInit) => {
    if (!/\/conversations\/[^/]+\/attachments$/.test(path))
      return problem(404, "Not found.");
    const file = (init.body as FormData).get("file") as File;
    uploads.push(file.name);
    return new Response(
      JSON.stringify({
        id: "attachment-id",
        name: file.name,
        mimeType: "image/png",
        sizeBytes: file.size,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function drop(form: Element, files: File[]) {
  fireEvent.drop(form, {
    dataTransfer: { files, items: [], types: ["Files"] },
  });
}

/** A `File` that reports `size` bytes without holding them; the screen reads only the size. */
function sized(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/** What a server keeping files in an object store publishes. */
const larger = attachmentLimitsFrom({
  imageBytes: 100 * MIB,
  documentBytes: 100 * MIB,
  fileBytes: 100 * MIB,
});

test("with no limits from the server, a 9MB image is refused at today's 8MB", async () => {
  const view = render(
    <Composer channelId="channel-1" compact onSubmit={() => {}} />,
  );

  drop(view.container.querySelector("form") as HTMLFormElement, [
    sized("site-photo.png", "image/png", 9 * MIB),
  ]);

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain(
    "'site-photo.png' is too large for an image. The limit is 8MB.",
  );
  expect(uploads).toEqual([]);
});

test("with the server's 100MB, the same 9MB image goes up, and 101MB is refused naming 100MB", async () => {
  let refreshed = 0;
  const view = render(
    <Composer
      channelId="channel-1"
      compact
      onSubmit={() => {}}
      attachmentLimits={{ limits: larger, refresh: () => refreshed++ }}
    />,
  );
  const form = view.container.querySelector("form") as HTMLFormElement;

  const photo = new File([new Uint8Array(9 * MIB)], "site-photo.png", {
    type: "image/png",
  });
  drop(form, [photo]);
  await waitFor(() => {
    expect(view.queryByLabelText("Remove site-photo.png")).not.toBeNull();
    expect(
      (view.getByLabelText("Send message") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  expect(uploads).toEqual(["site-photo.png"]);
  expect(refreshed).toBe(0);

  drop(form, [sized("drone.png", "image/png", 100 * MIB + 1)]);
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain(
    "'drone.png' is too large for an image. The limit is 100MB.",
  );
  expect(uploads).toEqual(["site-photo.png"]);
  // A refusal asks the server for its limits again: it may be the first sign they changed.
  expect(refreshed).toBe(1);
});

test("the defaults are the smallest a server takes", () => {
  expect(DEFAULT_ATTACHMENT_LIMITS).toEqual({
    imageBytes: 8 * MIB,
    documentBytes: 8 * MIB,
    fileBytes: MIB,
  });
});
