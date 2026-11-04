import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  AreaChartProps,
  BarChartCard,
  BarChartProps,
  GALLERY,
  LineChartCard,
  LineChartProps,
  PieChartProps,
  ProgressChartProps,
} from "@/components/gallery/charts";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const POINTS = [
  { label: "France", value: 3.1 },
  { label: "Japan", value: 4.2 },
];

test("a chart drawn from what the Bot read names and links its sources", () => {
  const view = render(
    <BarChartCard
      asOf="2025"
      basis="read"
      points={POINTS}
      sources={[
        { title: "IMF World Economic Outlook", url: "https://imf.org/weo" },
        { title: "Annual report" },
      ]}
      title="GDP"
    />,
  );
  const link = view.getByRole("link", { name: "IMF World Economic Outlook" });
  expect(link.getAttribute("href")).toBe("https://imf.org/weo");
  expect(view.getByText(/Annual report/)).toBeTruthy();
  expect(view.getByText(/As of 2025/)).toBeTruthy();
});

test("figures from the Bot's own knowledge are marked as unchecked", () => {
  const view = render(
    <LineChartCard
      basis="own-knowledge"
      labels={["2023", "2024"]}
      series={[{ name: "GDP", values: [1, 2] }]}
      title="GDP"
    />,
  );
  expect(view.getByText(/Not checked against a source/)).toBeTruthy();
});

test("the unchecked note and the sources read as separate parts", () => {
  const view = render(
    <BarChartCard
      basis="own-knowledge"
      points={POINTS}
      sources={[{ title: "Annual report" }]}
      title="GDP"
    />,
  );
  expect(view.container.textContent).toContain(
    "Not checked against a source. · Sources: Annual report",
  );
});

test("sources the model wrote in the wrong shape are skipped, not fatal", () => {
  const view = render(
    <BarChartCard
      {...({
        basis: "read",
        points: POINTS,
        sources: [null, { title: 3 }, { title: "Notes" }, { title: "Notes" }],
        asOf: { year: 2025 },
        title: "GDP",
      } as unknown as Parameters<typeof BarChartCard>[0])}
    />,
  );
  expect(view.container.textContent).toContain("Sources: Notes");
  expect(view.container.textContent).not.toContain("Notes, Notes");
  expect(view.queryByText(/As of/)).toBeNull();
});

test("only web addresses become links", () => {
  const view = render(
    <BarChartCard
      basis="read"
      points={POINTS}
      sources={[{ title: "Notes", url: "javascript:alert(1)" }]}
      title="GDP"
    />,
  );
  expect(view.queryByRole("link")).toBeNull();
  expect(view.getByText(/Notes/)).toBeTruthy();
});

test("a chart from before sources existed still renders, with no footer", () => {
  const view = render(<BarChartCard points={POINTS} title="GDP" />);
  expect(view.getByText("GDP")).toBeTruthy();
  expect(view.queryByText(/Sources:|As of|Not checked/)).toBeNull();
});

test("the model has to say where a chart's figures came from", () => {
  expect(
    BarChartProps.safeParse({ title: "GDP", points: POINTS }).success,
  ).toBe(false);
  const schemas = [
    BarChartProps,
    PieChartProps,
    LineChartProps,
    AreaChartProps,
    ProgressChartProps,
  ];
  GALLERY.forEach((chart, index) => {
    expect(schemas[index].safeParse(chart.preview).success).toBe(true);
  });
});
