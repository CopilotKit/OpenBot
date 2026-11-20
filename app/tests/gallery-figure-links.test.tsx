import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { MetricsCard } from "@/components/gallery/cards";
import {
  BarChartCard,
  PieChartCard,
  ProgressChartCard,
} from "@/components/gallery/charts";
import { settleReactWork } from "./settle-react-work";

/**
 * A figure a Bot draws may open where it came from: a bar, a progress row, a headline figure or a
 * donut's legend row. Optional, so a chart without links draws exactly as it did, and only a web
 * address becomes a link.
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

const RECORD = "https://crm.example.com/accounts/4821";

const charts = (link?: string) => [
  <BarChartCard
    key="bar"
    points={[{ label: "Support", value: 12, ...(link ? { link } : {}) }]}
  />,
  <PieChartCard
    key="pie"
    points={[
      { label: "Cloud", value: 3, ...(link ? { link } : {}) },
      { label: "People", value: 1 },
    ]}
  />,
  <ProgressChartCard
    key="progress"
    points={[
      { label: "Hiring", value: 3, target: 8, ...(link ? { link } : {}) },
    ]}
  />,
  <MetricsCard
    key="metrics"
    metrics={[{ label: "Revenue", value: "$412k", ...(link ? { link } : {}) }]}
  />,
];

test("a figure with no link is not a link", () => {
  for (const chart of charts()) {
    const { container, unmount } = render(chart);
    expect(container.querySelector("a")).toBeNull();
    unmount();
  }
});

test("a link that is not a web address is dropped, and the figure draws as if it had none", () => {
  const plain = charts().map((chart) => {
    const { container, unmount } = render(chart);
    const html = container.innerHTML;
    unmount();
    return html;
  });
  charts("javascript:alert(1)").forEach((chart, index) => {
    const { container, unmount } = render(chart);
    expect(container.innerHTML).toBe(plain[index] as string);
    unmount();
  });
});

test("a figure with a web address opens it in a new tab with no referrer, named by its label and value", () => {
  const names = [
    "Support: 12",
    "Cloud: 75%",
    "Hiring: 3 of 8",
    "Revenue: $412k",
  ];
  charts(RECORD).forEach((chart, index) => {
    const view = render(chart);
    const link = view.getByRole("link", { name: names[index] });
    expect(link.getAttribute("href")).toBe(RECORD);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    view.unmount();
  });
});
