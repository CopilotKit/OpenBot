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

test("a line made only of sources or citations is left out: it is not what the task found", () => {
  // The Bot closed its research on the list of what it read, cut short where the server cuts.
  expect(
    taskLine(
      "[The Seattle Times](https://www.seattletimes.com/seattle-news/smith-tower-history/); [SAH Archipedia](https://sah-archipedia.org/buildings/WA-01-033-0083); [KING 5](https://www.king5.com/article/news/history/smith-tower-…",
    ),
  ).toBeNull();
  expect(
    taskLine(
      "[HistoryLink: New Central Library](https://www.historylink.org/File/5370); [Seattle Public Library: Central Library History](https://www.spl.org/hours-and-locations/central-library); [Hoffman Construction](https://www.hoffmancorp.com/projects/seattle-central-library)…",
    ),
  ).toBeNull();
  // As a list, bare addresses, or numbered and bracketed citations, it is the same.
  expect(
    taskLine(
      "- [HistoryLink](https://www.historylink.org/File/5370)\n- [Seattle Times](https://www.seattletimes.com/a)",
    ),
  ).toBeNull();
  expect(
    taskLine(
      "https://www.historylink.org/File/5370, https://www.spl.org/central",
    ),
  ).toBeNull();
  expect(taskLine("[1] [2] [3]")).toBeNull();
  expect(taskLine("【4†source】【7†source】")).toBeNull();
});

test("a sentence that cites a source keeps its words", () => {
  expect(
    taskLine(
      "It opened on July 4, 1914 ([HistoryLink](https://www.historylink.org/File/5370)).",
    ),
  ).toBe("It opened on July 4, 1914 (HistoryLink).");
  expect(
    taskLine(
      "Read more in [the Seattle Times](https://www.seattletimes.com/a) and [KING 5](https://www.king5.com/b).",
    ),
  ).toBe("Read more in the Seattle Times and KING 5.");
  expect(taskLine("The tower is 462 feet tall [1].")).toBe(
    "The tower is 462 feet tall [1].",
  );
});
