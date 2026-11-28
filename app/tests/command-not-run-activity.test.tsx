import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ActivityLog } from "@/components/computer/activity-log";
import { detailsOf, recordActivity } from "@/lib/computers/activity";
import { failedComputerCall } from "@/lib/computers/call";
import { settleReactWork } from "./settle-react-work";

/**
 * A command the computer never ran, said as not run in Activity.
 *
 * OpenBot Cloud 1.2.0-rc.3: the gate refused a Bot's command ("That unanswered tool call is not
 * saved in this conversation"). The command's card said "Didn't run", and Activity beside it said
 * "Ran … Exit 0" over the same sentence, which was read as the command having run and the Bot having
 * lost its output. Activity read a command with no exit code as one that exited 0.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** What the step got back: the gate's refusal, as the browser hands it to the Bot (a 400). */
const refused = failedComputerCall(400, {
  error: "That unanswered tool call is not saved in this conversation.",
});

test("Activity says a command the gate refused didn't run, never Exit 0", () => {
  const did = detailsOf("command", { command: "ls -la ~/reports" }, refused);
  recordActivity("not-run", [
    { id: "exec", did, finishedAt: Date.parse("2026-11-23T05:16:10.000Z") },
  ]);
  const row = render(<ActivityLog computerId="not-run" />).getAllByRole(
    "listitem",
  )[0];
  expect(row?.textContent).toContain("Didn't run");
  expect(row?.textContent).toContain("ls -la ~/reports");
  expect(row?.textContent).toContain(
    "That unanswered tool call is not saved in this conversation.",
  );
  expect(row?.textContent).not.toContain("Exit 0");
});

test("a command that ran still says how it exited, with what it printed", () => {
  const ran = detailsOf(
    "command",
    { command: "echo fernhill-$((40+2))" },
    { ok: true, exitCode: 0, stdout: "fernhill-42\n", stderr: "" },
  );
  const failed = detailsOf(
    "command",
    { command: "ls missing" },
    {
      ok: false,
      exitCode: 2,
      stdout: "",
      stderr: "ls: cannot access 'missing'",
    },
  );
  recordActivity("ran", [
    { id: "echo", did: ran, finishedAt: Date.parse("2026-11-23T05:20:00Z") },
    { id: "ls", did: failed, finishedAt: Date.parse("2026-11-23T05:20:05Z") },
  ]);
  const rows = render(<ActivityLog computerId="ran" />).getAllByRole(
    "listitem",
  );
  const text = rows.map((row) => row.textContent).join("\n");
  expect(text).toContain("Exit 0");
  expect(text).toContain("fernhill-42");
  expect(text).toContain("Exit 2");
  expect(text).not.toContain("Didn't run");
});
