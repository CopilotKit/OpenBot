import { expect, test } from "bun:test";
import { taskLine } from "@/lib/tasks/line";

/*
 * The one line a task's row says under its title. These are the lines real tasks came back with:
 * the Bot's closing words as the server hands them over, Markdown and all.
 */

test("a line that was the last row of a table is said as plain text, without the pipes", () => {
  expect(
    taskLine(
      "| Begins / headwaters | Columbia Lake, British Columbia, between the Canadian Rockies and Selkirk Mountains, at roughly 2,650 ft elevation.",
    ),
  ).toBe(
    "Begins / headwaters: Columbia Lake, British Columbia, between the Canadian Rockies and Selkirk Mountains, at roughly 2,650 ft elevation.",
  );
  expect(
    taskLine(
      "| Where it begins | Columbia Lake in southeastern British Columbia, Canada |",
    ),
  ).toBe(
    "Where it begins: Columbia Lake in southeastern British Columbia, Canada",
  );
  expect(taskLine("| Total length | **1,243 miles** | about 2,000 km |")).toBe(
    "Total length: 1,243 miles, about 2,000 km",
  );
});

test("Markdown's marks come off and the words stay", () => {
  expect(
    taskLine(
      "## Done: the **draft** is in [your folder](https://example.com/a_(b)) as `plan_v2.md`.",
    ),
  ).toBe("Done: the draft is in your folder as plan_v2.md.");
  expect(taskLine("- _Sent_ the invite to ~~Ana~~ Ben.")).toBe(
    "Sent the invite to Ben.",
  );
  expect(taskLine("> I couldn't reach the supplier\\. Try again?")).toBe(
    "I couldn't reach the supplier. Try again?",
  );
});

test("a line cut short inside a link keeps the link's words and drops its address", () => {
  expect(
    taskLine(
      "Completed in 1990, it was selected by residents as part of a neighborhood project to transform a littered space into public art ([Seattle Municipal Archives](http://primarysources.seattle.gov/2026/02…",
    ),
  ).toBe(
    "Completed in 1990, it was selected by residents as part of a neighborhood project to transform a littered space into public art (Seattle Municipal Archives…",
  );
  expect(taskLine("It is described in [the city's own his…")).toBe(
    "It is described in the city's own his…",
  );
});

test("a line that says nothing about the task is left out", () => {
  // Where the answer came from, cut short: a footnote to a result the row does not hold.
  expect(taskLine("Source: Lake Washington Ship …")).toBeNull();
  expect(taskLine("**Sources:** [USGS](https://usgs.gov)")).toBeNull();
  // A table's rule, and marks with no words.
  expect(taskLine("| --- | :---: |")).toBeNull();
  expect(taskLine("***")).toBeNull();
  expect(taskLine("  ")).toBeNull();
  expect(taskLine(null)).toBeNull();
});

test("an ordinary sentence is said as it came", () => {
  const said =
    "There is a height discrepancy: the official site says 60 meters (about 197 feet), while the Seattle Times reported it as 175 feet at opening.";
  expect(taskLine(said)).toBe(said);
  expect(taskLine("I drafted a reply. Want me to send it?")).toBe(
    "I drafted a reply. Want me to send it?",
  );
});
