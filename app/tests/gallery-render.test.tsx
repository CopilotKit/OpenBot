import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { BarChartCard } from "@/components/gallery/charts";
import { ArgumentsArrivingContext } from "@/components/gallery/streaming";
import { DataTable } from "@/components/gallery/table";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import {
  makeDecisionRender,
  makeGalleryRender,
} from "@/lib/copilot/gallery-tools";
import { createGrantStore } from "@/lib/copilot/grant-store";
import { settleReactWork } from "./settle-react-work";

/**
 * A card a Bot draws is created ONCE and grows in place. The SDK remounts a card whenever the render
 * function it was registered with changes identity, so the render is made once per component and
 * reads the grants from a store: grants arriving or changing re-render the card instead of tearing
 * it down. Mounts are counted with an effect that runs once per mount.
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

let mounts = 0;
let lastRespond: unknown = "unset";

function Counted(props: { title?: string }) {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <p>{props.title ?? "untitled"}</p>;
}

function CountedDecision(props: {
  args?: { title?: string };
  respond?: unknown;
}) {
  useEffect(() => {
    mounts += 1;
  }, []);
  lastRespond = props.respond;
  return <p>{props.args?.title ?? "untitled"}</p>;
}

const spec = (Component: GalleryComponent["Component"]) =>
  ({
    name: "chart",
    title: "Bar chart",
    kind: "chart",
    description: "A chart.",
    parameters: {},
    Component,
  }) as unknown as GalleryComponent;

const heldGrants = {
  status: "known" as const,
  held: new Map([["chart", "A chart."]]),
};

afterEach(() => {
  mounts = 0;
  lastRespond = "unset";
});

test("waits without refusing while grants are unknown", () => {
  const Render = makeGalleryRender(spec(Counted), createGrantStore());
  const view = render(
    <Render args={{ title: "Revenue" }} status="inProgress" toolCallId="c1" />,
  );

  expect(view.getByText("Revenue")).toBeTruthy();
  expect(view.queryByText(/not available/)).toBeNull();
});

test("mounts once while grants load and args stream", () => {
  const store = createGrantStore();
  const Render = makeGalleryRender(spec(Counted), store);
  const view = render(
    <Render args={{ title: "Re" }} status="inProgress" toolCallId="c1" />,
  );

  act(() => store.set({ grants: heldGrants }));
  view.rerender(
    <Render args={{ title: "Revenue" }} status="complete" toolCallId="c1" />,
  );

  expect(view.getByText("Revenue")).toBeTruthy();
  expect(mounts).toBe(1);
});

test("refuses once grants say not held", () => {
  const store = createGrantStore();
  store.set({ grants: { status: "known", held: new Map() } });
  const Render = makeGalleryRender(spec(Counted), store);
  const view = render(
    <Render args={{ title: "Revenue" }} status="complete" toolCallId="c1" />,
  );

  expect(view.getByText(/not available to this Bot/)).toBeTruthy();
});

test("refuses with the couldn't-check reason when grants failed", () => {
  const store = createGrantStore();
  store.set({ grants: { status: "failed" } });
  const Render = makeGalleryRender(spec(Counted), store);
  const view = render(
    <Render args={{ title: "Revenue" }} status="complete" toolCallId="c1" />,
  );

  expect(
    view.getByText(/Couldn't check whether this Bot may show Bar chart/),
  ).toBeTruthy();
});

test("an earlier call keeps drawing after a revoke while a new call is refused", () => {
  const store = createGrantStore();
  store.set({
    grants: heldGrants,
    refusals: new Map([["call-2", "That component was just switched off."]]),
  });
  const Render = makeGalleryRender(spec(Counted), store);
  const view = render(
    <>
      <Render
        args={{ title: "Earlier" }}
        status="complete"
        toolCallId="call-1"
      />
      <Render args={{ title: "Later" }} status="complete" toolCallId="call-2" />
    </>,
  );

  expect(view.getByText("Earlier")).toBeTruthy();
  expect(view.queryByText("Later")).toBeNull();
  expect(view.getByText(/just switched off/)).toBeTruthy();
});

test("a decision waits disabled, then enables in place", async () => {
  const store = createGrantStore();
  const answered: unknown[][] = [];
  const respond = async (...args: unknown[]) => {
    answered.push(args);
  };
  const Render = makeDecisionRender(spec(CountedDecision), store, respond);
  const view = render(
    <Render
      args={{ title: "Approve" }}
      status="executing"
      toolCallId="call-1"
    />,
  );

  expect(lastRespond).toBeUndefined();
  act(() => store.set({ grants: heldGrants }));
  view.rerender(
    <Render
      args={{ title: "Approve" }}
      status="executing"
      toolCallId="call-1"
    />,
  );

  // Enabled in place, answering the call it was drawn for.
  expect(mounts).toBe(1);
  await (lastRespond as (result: unknown) => Promise<void>)("approved");
  expect(answered).toEqual([["approved", "call-1"]]);
});

function ShowsValue(props: { title?: string; value?: number }) {
  return (
    <p>
      {props.title}: {props.value ?? "pending"}
    </p>
  );
}

test("a half-arrived number is held back until the call completes", () => {
  const store = createGrantStore();
  store.set({ grants: heldGrants });
  const Render = makeGalleryRender(spec(ShowsValue), store);
  const view = render(
    <Render args={{ title: "Sales", value: 12 }} status="inProgress" />,
  );
  expect(view.getByText("Sales: pending")).toBeTruthy();

  view.rerender(
    <Render args={{ title: "Sales", value: 125 }} status="complete" />,
  );
  expect(view.getByText("Sales: 125")).toBeTruthy();
});

test("a streaming table draws its complete rows through the gallery render", () => {
  const store = createGrantStore();
  store.set({ grants: heldGrants });
  const Render = makeGalleryRender(
    spec(DataTable as GalleryComponent["Component"]),
    store,
  );
  const view = render(
    <Render
      args={{
        title: "Sales",
        columns: ["Quarter", "Revenue"],
        rows: [{ cells: ["Q1", 8] }, { cells: ["Q2", 9] }],
      }}
      status="inProgress"
    />,
  );

  expect(view.queryByText(/Waiting for complete table data/)).toBeNull();
  expect(view.getByText("Q1")).toBeTruthy();
});

/*
 * `executing` is a call whose arguments are final and whose handler is still answering; a call with
 * no result outside the running turn (a stopped run, a page closed mid-call, reloaded) stays
 * `inProgress` for good. Neither is still arriving, so neither holds its last value back.
 */
test("a call whose arguments are final draws its last number", () => {
  const store = createGrantStore();
  store.set({ grants: heldGrants });
  const Render = makeGalleryRender(spec(ShowsValue), store);
  const view = render(
    <Render args={{ title: "Sales", value: 125 }} status="executing" />,
  );
  expect(view.getByText("Sales: 125")).toBeTruthy();
});

test("a call left without a result outside the running turn draws its last number", () => {
  const store = createGrantStore();
  store.set({ grants: heldGrants });
  const Render = makeGalleryRender(spec(ShowsValue), store);
  const view = render(
    <ArgumentsArrivingContext.Provider value={false}>
      <Render args={{ title: "Sales", value: 125 }} status="inProgress" />
    </ArgumentsArrivingContext.Provider>,
  );
  expect(view.getByText("Sales: 125")).toBeTruthy();
});

/*
 * A chart has no points until its first one streams in. It read "There is no data to chart." for
 * that whole wait, as if the Bot had come back empty.
 */
const barChart = () => {
  const store = createGrantStore();
  store.set({ grants: heldGrants });
  return makeGalleryRender(
    spec(BarChartCard as GalleryComponent["Component"]),
    store,
  );
};

test("a chart whose figures are still arriving shimmers, and does not say it has no data", () => {
  const Render = barChart();
  const view = render(
    <Render args={{ title: "Revenue" }} status="inProgress" />,
  );
  expect(view.getByRole("status").textContent).toBe("Drawing the chart…");
  expect(view.queryByText("There is no data to chart.")).toBeNull();
});

test("a finished chart with no figures says so", () => {
  const Render = barChart();
  const view = render(
    <Render args={{ title: "Revenue", points: [] }} status="complete" />,
  );
  expect(view.getByText("There is no data to chart.")).toBeTruthy();
  expect(view.queryByRole("status")).toBeNull();
});

test("a chart stopped before its figures arrived says it has no data, and never shimmers for good", () => {
  const Render = barChart();
  const view = render(
    <ArgumentsArrivingContext.Provider value={false}>
      <Render args={{ title: "Revenue" }} status="inProgress" />
    </ArgumentsArrivingContext.Provider>,
  );
  expect(view.getByText("There is no data to chart.")).toBeTruthy();
  expect(view.queryByRole("status")).toBeNull();
});
