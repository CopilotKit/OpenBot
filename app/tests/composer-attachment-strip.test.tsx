import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  AttachmentStrip,
  type StagedFile,
} from "@/components/channels/composer/attachment-strip";
import { settleReactWork } from "./settle-react-work";

/**
 * WHAT A SCREEN READER IS OFFERED BY THE ROW ACROSS THE TOP OF THE COMPOSER, AND WHEN.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `agent-roster-error.test.tsx`: bun walks every file into one process, and a
 * document another file tore down mid-run fails invisibly.
 *
 * The registration carries a `url` for the reason `composer-attachments-ui.test.tsx` records:
 * without one `location` is `about:blank` and a thumbnail's relative `src` does not resolve.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const notes: StagedFile = {
  id: "1",
  name: "notes.txt",
  size: 2048,
  loading: false,
};

test("the empty strip stays mounted but leaves the accessibility tree", () => {
  // Two halves of one bargain, and the file's comment used to claim only the first.
  //
  // The list is deliberately NOT unmounted while the composer carries nothing: it is the element
  // `Collapse` measures, and a box with nothing in it to measure cannot animate its own height.
  //
  // What that costs is the part the comment got wrong. Height 0 under `overflow-hidden` is a
  // visual state, not an accessibility one, so an `aria-label`led `<ul>` sitting at zero height is
  // still a labelled list a screen reader walks into and announces — "Attachments, list, 0 items"
  // — on a composer with no attachments on it. Nothing is drawn; something is still read.
  const { container, queryByRole } = render(
    <AttachmentStrip files={[]} images={[]} onRemove={() => {}} />,
  );

  expect(container.querySelector("ul")).toBeTruthy();
  expect(queryByRole("list")).toBeNull();
  expect(queryByRole("list", { name: "Attachments" })).toBeNull();
});

test("the strip is announced once it carries something", () => {
  // The other half: hiding the empty list must not hide the full one, or the label stops being
  // worth having at the only moment it says anything.
  const { getAllByRole, getByRole } = render(
    <AttachmentStrip files={[notes]} images={[]} onRemove={() => {}} />,
  );

  expect(getByRole("list", { name: "Attachments" })).toBeTruthy();
  expect(getAllByRole("listitem")).toHaveLength(1);
});

test("the strip leaves the accessibility tree again when the last one goes", () => {
  // Removing the last attachment is the ordinary way back to empty, and it is the path that would
  // leave a stale labelled list behind if the hiding were done once at mount.
  const { queryByRole, rerender } = render(
    <AttachmentStrip files={[notes]} images={[]} onRemove={() => {}} />,
  );

  expect(queryByRole("list", { name: "Attachments" })).toBeTruthy();

  rerender(<AttachmentStrip files={[]} images={[]} onRemove={() => {}} />);

  expect(queryByRole("list")).toBeNull();
});

test("an image on its own puts the strip back in the accessibility tree", () => {
  // `occupied` is either list being non-empty; a strip carrying only a picture is announced too.
  const { getAllByRole, getByRole } = render(
    <AttachmentStrip
      files={[]}
      images={[{ id: "2", url: "/a.png", alt: "A cat", loading: false }]}
      onRemove={() => {}}
    />,
  );

  expect(getByRole("list", { name: "Attachments" })).toBeTruthy();
  expect(getAllByRole("listitem")).toHaveLength(1);
});

test("an image still going up is named rather than left a blank box", () => {
  // The same pattern as the empty list, one level down. The skeleton is drawn to hold the tile's
  // shape while the bytes are in flight, and holding a shape was all it was asked to do — so the
  // tile announced nothing at all, and the only thing a screen reader found inside it was a button
  // offering to remove something that had never been named. The file tile beside it has said
  // "Uploading…" in plain text all along; the picture said nothing.
  //
  // Named, not announced: no live region here. The file tile does not have one either, and a paste
  // of eight images would otherwise interrupt with eight of them.
  const { getByRole } = render(
    <AttachmentStrip
      files={[]}
      images={[{ id: "3", url: "", alt: "A cat", loading: true }]}
      onRemove={() => {}}
    />,
  );

  expect(getByRole("img", { name: "A cat, uploading" })).toBeTruthy();
});

test("an unnamed image going up falls back to the same word the finished one uses", () => {
  const { getByRole } = render(
    <AttachmentStrip
      files={[]}
      images={[{ id: "4", url: "", loading: true }]}
      onRemove={() => {}}
    />,
  );

  expect(getByRole("img", { name: "Attachment, uploading" })).toBeTruthy();
});
