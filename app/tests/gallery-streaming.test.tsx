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

  // Refused as a failure: nothing more is coming, so it does not wait.
  expect(view.getByText("Couldn't show the data table.")).toBeTruthy();
  expect(view.queryByText(/Waiting for complete table data/)).toBeNull();
  expect(view.queryByRole("table")).toBeNull();
});

/*
 * Ten bars on a phone ran their figures together, and cutting them to "14,…" made each one a wrong
 * number. A figure that does not fit its bar is written compactly instead, and its exact value stays
 * in the accessible name and the tooltip. Layout is faked: the page has none here.
 */
test("a bar whose figure does not fit writes it compactly, and keeps the exact value", () => {
  const fake = (property: "scrollWidth" | "clientWidth", width: number) => {
    const real = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      property,
    );
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-exact-figure") ? width : 0;
      },
    });
    return () => {
      if (real) Object.defineProperty(HTMLElement.prototype, property, real);
    };
  };
  // Forty pixels of figure in a twenty-pixel bar.
  const restore = [fake("scrollWidth", 40), fake("clientWidth", 20)];
  try {
    const view = render(
      <BarChartCard
        points={[
          { label: "Support", value: 14808 },
          { label: "Billing", value: 6170 },
        ]}
      />,
    );
    const text = view.container.textContent ?? "";
    expect(text).toContain("15K");
    expect(text).not.toContain("…");
    const exact = view.getByText("14,808", { selector: ".sr-only" });
    expect(exact.parentElement?.getAttribute("title")).toBe("14,808");
  } finally {
    for (const undo of restore) undo();
  }
});

test("a bar whose figure fits writes it exactly", () => {
  const view = render(
    <BarChartCard points={[{ label: "Support", value: 14808 }]} />,
  );
  expect(view.container.textContent).not.toContain("15K");
  expect(view.queryByText("14,808", { selector: ".sr-only" })).toBeNull();
});
