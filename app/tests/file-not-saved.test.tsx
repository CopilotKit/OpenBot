import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ToolLine } from "@/components/channels/tool-line";
import { ActivityLog } from "@/components/computer/activity-log";
import { failedComputerCall } from "@/lib/computers/call";
import { detailsOf, recordActivity } from "@/lib/computers/activity";
import { settleReactWork } from "./settle-react-work";

/**
 * A file the Bot never saved, said as not saved.
 *
 * Windows: in a second conversation, while the first waited on the person, the Bot's write was
 * refused because its computer was held. The step row read "Saved a file, didn't work
 * savings_goal.py" and Activity "Saved savings_goal.py": both claimed a save that never happened.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** What the step got back: the computer held for the person in another conversation (a 409). */
const held = failedComputerCall(409, {
  error:
    "Not done: the computer is waiting for the person in another conversation, where the Bot asked them for help (“Type your password”). Tell them that, and that you'll do this once they finish or cancel that request there.",
  humanHasControl: true,
  requestId: "request-a",
});

test("Activity says the file was not saved, and why", () => {
  const did = detailsOf("write_file", { path: "savings_goal.py" }, held);
  recordActivity("not-saved", [
    { id: "write", did, finishedAt: Date.parse("2026-11-13T07:21:50.000Z") },
  ]);
  const row = render(<ActivityLog computerId="not-saved" />).getAllByRole(
    "listitem",
  )[0];
  expect(row?.textContent).toContain("Didn't save");
  expect(row?.textContent).toContain("savings_goal.py");
  expect(row?.textContent).toContain(
    "Not done: the computer is waiting for the person in another conversation",
  );
  expect(row?.textContent).not.toMatch(/\bSaved\b/);
});

test("a saved file is still said as saved", () => {
  const did = detailsOf(
    "write_file",
    { path: "make_budget.py" },
    { ok: true, bytes: 120 },
  );
  recordActivity("saved", [
    { id: "write", did, finishedAt: Date.parse("2026-11-13T07:20:00.000Z") },
  ]);
  const row = render(<ActivityLog computerId="saved" />).getAllByRole(
    "listitem",
  )[0];
  expect(row?.textContent).toContain("Saved");
  expect(row?.textContent).toContain("120 bytes");
});

test("the step row says the file wasn't saved, never 'Saved a file, didn't work'", () => {
  const view = render(
    <ToolLine
      attempted="Save a file"
      detail="savings_goal.py"
      failed
      failedLabel="Didn't save a file"
      label="Saved a file"
    />,
  );
  expect(view.container.textContent).toContain(
    "Didn't save a filesavings_goal.py",
  );
  expect(view.container.textContent).not.toContain("Saved a file");
});
