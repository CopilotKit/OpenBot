import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { BarChartCard } from "@/components/gallery/charts";
import { settleReactWork } from "./settle-react-work";

/**
 * The "Chart Hacker News" starter drew ten stories as standing bars, and every name under a bar was
 * cut to a few letters ("2. Car unlo…", "10. Goldm…"), so nobody could tell which bar was which
 * story. Bars with long names now lie down, largest first, each named in full beside or over its
 * bar and in its tooltip. happy-dom lays nothing out, so this pins the shape; the widths were looked
 * at in a real browser at 420px and 720px.
 */
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const STORIES = [
  {
    label:
      "1. Show HN: I built a local-first spreadsheet that syncs over email",
    value: 412,
  },
  {
    label: "2. Car unlock exploit lets anyone open a 2024 sedan with a radio",
    value: 988,
  },
  { label: "3. The case against microservices, ten years later", value: 356 },
  { label: "4. Postgres 19 adds native vector search", value: 731 },
  { label: "5. Why we moved our build system back to Make", value: 214 },
  { label: "6. A visual guide to how GPUs schedule warps", value: 529 },
  { label: "7. SQLite is not a toy database", value: 645 },
  { label: "8. Ask HN: What are you working on?", value: 187 },
  { label: "9. The hidden cost of feature flags", value: 302 },
  {
    label: "10. Goldman Sachs is quietly replacing analysts with agents",
    value: 871,
  },
];

test("bars with long names lie down, largest first, each named in full", () => {
  const view = render(
    <BarChartCard points={STORIES} title="Hacker News front page" />,
  );

  const rows = view.getAllByRole("listitem");
  const byValue = [...STORIES].sort((a, b) => b.value - a.value);
  expect(rows.length).toBe(STORIES.length);

  rows.forEach((row, index) => {
    const story = byValue[index];
    if (!story) throw new Error(`no story for row ${index}`);
    // The whole name and its figure, to a screen reader and in the tooltip, never a cut-off stub.
    expect(row.textContent).toBe(`${story.label}${story.value}`);
    expect(row.getAttribute("title")).toBe(`${story.label}: ${story.value}`);
    // The name may wrap; a single line cut with an ellipsis is the bug.
    const name = view.getByText(story.label);
    expect(name.className).not.toMatch(/\btruncate\b|whitespace-nowrap/);
  });
});

test("bars with short names still stand up as columns in the order given", () => {
  const view = render(
    <BarChartCard
      points={[
        { label: "Sales", value: 45 },
        { label: "Engineering", value: 120 },
      ]}
    />,
  );

  expect(view.queryAllByRole("listitem").length).toBe(0);
  expect(view.container.textContent).toMatch(/Sales.*Engineering/);
});
