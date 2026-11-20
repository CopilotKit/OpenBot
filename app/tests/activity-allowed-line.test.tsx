import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ActivityLog } from "@/components/computer/activity-log";
import { recordActivity } from "@/lib/computers/activity";
import { settleReactWork } from "./settle-react-work";

/**
 * A step the person allowed on its card says how in Activity, as one they declined says "You
 * declined it.": after "Allow for this conversation" no row said so, though the banner above the
 * composer did.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("a step allowed on its card has a line that says how", () => {
  recordActivity("allowed-line", [
    {
      id: "sunflower",
      did: {
        kind: "browser",
        step: "computer_click",
        subject: "Place order",
        output: "",
        allowed: "allow_conversation",
      },
      finishedAt: Date.parse("2026-11-12T22:05:33.000Z"),
    },
    {
      id: "chamomile",
      did: {
        kind: "browser",
        step: "computer_click",
        subject: "Place order",
        output: "",
        allowed: "allow_once",
      },
      finishedAt: Date.parse("2026-11-12T22:06:10.000Z"),
    },
  ]);
  const view = render(<ActivityLog computerId="allowed-line" />);
  const rows = view.getAllByRole("listitem");
  expect(rows[0]?.textContent).toContain("Allowed once.");
  expect(rows[1]?.textContent).toContain("Allowed for this conversation.");
});
