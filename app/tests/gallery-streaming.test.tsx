import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { MetricsCard } from "@/components/gallery/cards";
import { BarChartCard } from "@/components/gallery/charts";
import { GalleryStreamingContext } from "@/components/gallery/streaming";
import { DataTable } from "@/components/gallery/table";
import { settleReactWork } from "./settle-react-work";

/**
 * A gallery component is drawn from arguments that are still arriving. Its list items are keyed by
 * position, never by a label that is still being typed: "Re", "Rev", "Revenue" were three keys, so
 * an item was torn down and rebuilt on every chunk. And a number that has not arrived yet holds its
 * place instead of drawing as NaN.
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

const bars = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>(".rounded-t-md"),
];

test("a bar keeps its node while its label streams", () => {
  const view = render(<BarChartCard points={[{ label: "Re", value: 3 }]} />);
  const before = bars(view.container)[0];

  view.rerender(<BarChartCard points={[{ label: "Revenue", value: 3 }]} />);

  expect(bars(view.container)[0]).toBe(before);
});

test("a bar without a value yet holds its place", () => {
  const view = render(
    <BarChartCard
      points={[{ label: "A", value: 4 }, { label: "B" } as never]}
    />,
  );

  const drawn = bars(view.container);
  expect(drawn.length).toBe(2);
  expect(drawn.some((bar) => /NaN/.test(bar.style.height))).toBe(false);
  expect(drawn[1]?.style.height).toBe("2%");
  expect(view.container.textContent).not.toContain("NaN");
});

test("duplicate labels both draw", () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const view = render(
    <BarChartCard
      points={[
        { label: "Q1", value: 1 },
        { label: "Q1", value: 2 },
      ]}
    />,
  );

  expect(bars(view.container).length).toBe(2);
  expect(
    errors.mock.calls.some((call) => String(call[0]).includes("same key")),
  ).toBe(false);
  errors.mockRestore();
});

test("a metric keeps its node while its label streams", () => {
  const view = render(<MetricsCard metrics={[{ label: "Re", value: "3" }]} />);
  const before = view.getByText("3");

  view.rerender(<MetricsCard metrics={[{ label: "Revenue", value: "3" }]} />);

  expect(view.getByText("3")).toBe(before);
});

test("a table cell keeps its node while its column name streams", () => {
  const view = render(
    <DataTable columns={["Re"]} rows={[{ cells: ["north"] }]} title="Sales" />,
  );
  const before = view.getByText("north").closest("td");

  view.rerender(
    <DataTable
      columns={["Revenue"]}
      rows={[{ cells: ["north"] }]}
      title="Sales"
    />,
  );

  expect(view.getByText("north").closest("td")).toBe(before);
});

test("a table draws its complete rows while the last one is still arriving", () => {
  const view = render(
    <GalleryStreamingContext.Provider value>
      <DataTable
        columns={["Quarter", "Revenue"]}
        rows={[{ cells: ["Q1", 8] }, { cells: ["Q2"] }]}
        title="Sales"
      />
    </GalleryStreamingContext.Provider>,
  );

  expect(view.queryByText(/Waiting for complete table data/)).toBeNull();
  expect(view.getByText("Q1")).toBeTruthy();
  expect(view.container.querySelectorAll("tbody tr").length).toBe(2);
});

test("a complete table with a short last row is still refused", () => {
  const view = render(
    <DataTable
      columns={["Quarter", "Revenue"]}
      rows={[{ cells: ["Q1", 8] }, { cells: ["Q2"] }]}
      title="Sales"
    />,
  );

  expect(view.getByText(/Waiting for complete table data/)).toBeTruthy();
});
