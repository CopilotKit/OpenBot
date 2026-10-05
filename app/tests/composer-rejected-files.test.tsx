import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RejectedFiles } from "@/components/channels/composer/rejected-files";
import { settleReactWork } from "./settle-react-work";

/**
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `agent-roster-error.test.tsx`: bun walks every file into one process, and a
 * document another file tore down mid-run fails invisibly.
 *
 * The registration carries a `url`, as every other `.test.tsx` in this directory that renders a
 * composer surface does. Without one `location` is `about:blank`, which has no origin: relative
 * URLs do not resolve and anything that touches storage or `URL` construction fails for a reason
 * that has nothing to do with the component under test. This file did not have one, and the only
 * thing that made that harmless was that it happens not to have needed an origin yet.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/**
 * THE REFUSALS AS THEY ARE READ, ONE STRING PER LINE.
 *
 * Written out because the obvious spelling does not pin what it looks like it pins.
 * `getByText(/invoice\.pdf/)` and `getByText(/Unsupported file type/)` both pass against a
 * component that has put every reason next to the wrong name: testing-library's default matcher
 * reads only an element's DIRECT text children, so `<p><span>invoice.pdf</span>: reason</p>` is two
 * separate haystacks — "invoice.pdf" in the span, ": reason" in the paragraph — and asking whether
 * each exists somewhere never asks whether they are on the same line. Which file failed for which
 * reason is the entire content of this component, so it is the paragraph text that has to be
 * asserted, whole and in order.
 */
function lines(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("p"), (p) => p.textContent);
}

/**
 * Renders while listening for what React says under its breath.
 *
 * React does not throw on a duplicate `key`, it warns — so a test that only looks at the DOM
 * cannot tell a keyed list from an unkeyed one on mount, and mostly cannot on update either, since
 * the reconciler's positional fast path papers over the mistake until something moves. The warning
 * is the observable, so this catches it.
 */
function renderWatchingReact(element: React.ReactElement) {
  const complaints: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    complaints.push(args.map(String).join(" "));
  };

  try {
    return { ...render(element), complaints };
  } finally {
    console.error = realError;
  }
}

test("shows both filenames and both reasons for two rejected files", () => {
  const { container } = render(
    <RejectedFiles
      onDismiss={() => {}}
      rejected={[
        { id: "1", name: "invoice.pdf", reason: "Unsupported file type" },
        {
          id: "2",
          name: "photo.heic",
          reason: "That is not a supported image type",
        },
      ]}
    />,
  );

  // Each file's own reason must survive next to its OWN name, in the order they were refused. A
  // single overwritten error string would report only one of these two refusals, and a reason
  // printed against the wrong file is worse than no reason at all — it sends somebody to convert a
  // PDF that was never the problem.
  expect(lines(container)).toEqual([
    "invoice.pdf: Unsupported file type",
    "photo.heic: That is not a supported image type",
  ]);
});

test("renders both entries when two rejected files share a name", () => {
  // The defect this pins: two files dragged from different folders can genuinely share a name, and
  // keying the list on `name` alone gives React two children with one key. It does not drop
  // either line on mount — which is why asserting only that both lines are there proves nothing —
  // it complains, and then loses track of which line is which the first time the list is reordered
  // or shortened. The `id` field is what tells them apart, and the complaint is what betrays its
  // absence.
  const { complaints, container } = renderWatchingReact(
    <RejectedFiles
      onDismiss={() => {}}
      rejected={[
        { id: "1", name: "screenshot.png", reason: "File is too large" },
        {
          id: "2",
          name: "screenshot.png",
          reason: "Unsupported file type",
        },
      ]}
    />,
  );

  expect(complaints.filter((line) => line.includes("same key"))).toEqual([]);
  expect(lines(container)).toEqual([
    "screenshot.png: File is too large",
    "screenshot.png: Unsupported file type",
  ]);
});

test("the surviving entry keeps its own reason when a same-named one is removed", () => {
  // Where a duplicate key stops being a warning and starts being wrong. Dropping the FIRST of two
  // identically named refusals leaves the second, and the second's reason has to come with it.
  // Keyed on `id`, React matches the remaining entry to the fiber it already had. Keyed on `name`,
  // both old children answer to the same key, the first one is what the survivor is matched
  // against, and the line that stays is the line that should have gone.
  const { container, rerender } = render(
    <RejectedFiles
      onDismiss={() => {}}
      rejected={[
        { id: "1", name: "screenshot.png", reason: "File is too large" },
        { id: "2", name: "screenshot.png", reason: "Unsupported file type" },
      ]}
    />,
  );

  const survivor = container.querySelectorAll("p")[1];

  rerender(
    <RejectedFiles
      onDismiss={() => {}}
      rejected={[
        { id: "2", name: "screenshot.png", reason: "Unsupported file type" },
      ]}
    />,
  );

  expect(lines(container)).toEqual(["screenshot.png: Unsupported file type"]);
  // Same paragraph node, not a lookalike built in its place: identity across an update is what a
  // key is FOR, and it is the thing a duplicate key cannot deliver.
  expect(container.querySelectorAll("p")[0]).toBe(survivor);
});

test("says nothing for an empty list", () => {
  // The collapsing box stays mounted — it is what animates the composer's height — but the ALERT
  // inside it does not. An empty `role="alert"` is still an alert to a screen reader.
  const { container, queryByRole } = render(
    <RejectedFiles onDismiss={() => {}} rejected={[]} />,
  );

  expect(queryByRole("alert")).toBeNull();
  expect(container.textContent).toBe("");
});

test("the dismiss button hands back every refusal at once, not one line", () => {
  // One press clears the block. Dropping eight files can refuse several together, and they are
  // read together, so a per-line dismissal would be work with no purpose.
  let dismissed = 0;
  const { getByLabelText } = render(
    <RejectedFiles
      onDismiss={() => {
        dismissed += 1;
      }}
      rejected={[
        { id: "1", name: "logo.svg", reason: "SVGs are not accepted" },
        { id: "2", name: "huge.txt", reason: "Too large" },
      ]}
    />,
  );

  fireEvent.click(getByLabelText("Dismiss these 2 refusals"));

  expect(dismissed).toBe(1);
});

test("a single refusal is dismissed in the singular", () => {
  const { getByLabelText } = render(
    <RejectedFiles
      onDismiss={() => {}}
      rejected={[
        { id: "1", name: "logo.svg", reason: "SVGs are not accepted" },
      ]}
    />,
  );

  expect(getByLabelText("Dismiss this refusal")).toBeTruthy();
});
