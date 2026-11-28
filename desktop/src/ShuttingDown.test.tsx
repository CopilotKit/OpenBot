import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";

const { ShuttingDown } = await import("./ShuttingDown");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  setSystemTime();
});
afterAll(() => GlobalRegistrator.unregister());

/**
 * Windows F: the Shutting down screen's journey started over partway. "Closing OpenBot's apps ·
 * 14s so far" at 46% became "Closing OpenBot's services · 1s so far" at 7%, in the moment between
 * "Stopping OpenBot" finishing and its services starting to stop, when no step was running. The
 * bar and the time so far only ever go forward, gaps and all.
 */
test("a Quit's bar and time so far never go back, in the gap between its steps", () => {
  const start = new Date("2026-11-10T07:14:24Z");
  setSystemTime(start);
  const at = (seconds: number) =>
    setSystemTime(new Date(start.getTime() + seconds * 1000));
  const stopping = {
    step: "stop-openbot",
    ok: true,
    running: true,
    detail: "",
  };
  const sequence: [number, (typeof stopping)[]][] = [
    [0, [stopping]],
    [7, [stopping]],
    [14, [stopping]],
    // OpenBot stopped; its services not yet begun.
    [15, [{ ...stopping, running: false }]],
    [16, [{ ...stopping, running: false }]],
    [
      17,
      [
        { ...stopping, running: false },
        { step: "stop-intelligence", ok: true, running: true, detail: "" },
      ],
    ],
    [
      24,
      [
        { ...stopping, running: false },
        { step: "stop-intelligence", ok: true, running: true, detail: "" },
      ],
    ],
  ];
  const view = render(<ShuttingDown status={{ seq: 1, steps: [] }} />);
  let bar = 0;
  let soFar = 0;
  for (const [second, steps] of sequence) {
    at(second);
    view.rerender(<ShuttingDown status={{ seq: second + 2, steps }} />);
    const journey = view.container.querySelector(".journey");
    expect({ second, journey: journey !== null }).toEqual({
      second,
      journey: true,
    });
    const value = Number(
      journey?.querySelector("progress")?.getAttribute("value"),
    );
    const said = journey?.querySelector(".journey-time")?.textContent ?? "";
    const seconds = Number(/(\d+)s so far/.exec(said)?.[1] ?? -1);
    expect({ second, forward: value >= bar }).toEqual({
      second,
      forward: true,
    });
    expect({ second, counting: seconds >= soFar }).toEqual({
      second,
      counting: true,
    });
    bar = value;
    soFar = seconds;
  }
  expect(soFar).toBeGreaterThanOrEqual(24);
  expect(bar).toBeGreaterThan(0.5);
});

/**
 * On a Mac where OpenBot paused the person's own Podman while it ran, Quit starts it again last,
 * and says so. Anywhere else there is no such part, and nothing waits on it.
 */
test("Quit says it is starting the person's Podman again only when OpenBot paused it", () => {
  setSystemTime(new Date("2026-11-10T07:14:24Z"));
  const done = (step: string) => ({
    step,
    ok: true,
    running: false,
    detail: "",
  });
  const view = render(
    <ShuttingDown
      status={{
        seq: 3,
        steps: [
          done("stop-openbot"),
          done("stop-intelligence"),
          { step: "start-your-podman", ok: true, running: true, detail: "" },
        ],
      }}
    />,
  );
  expect(view.container.querySelector(".journey-said")?.textContent).toBe(
    "Starting your Podman again",
  );
  view.rerender(
    <ShuttingDown
      status={{
        seq: 4,
        steps: [
          done("stop-openbot"),
          { step: "stop-intelligence", ok: true, running: true, detail: "" },
        ],
      }}
    />,
  );
  expect(view.container.textContent).not.toContain("your Podman");
  // OpenBot's own machine, stopped once its services have.
  view.rerender(
    <ShuttingDown
      status={{
        seq: 5,
        steps: [
          done("stop-openbot"),
          done("stop-intelligence"),
          { step: "stop-engine", ok: true, running: true, detail: "" },
        ],
      }}
    />,
  );
  expect(view.container.querySelector(".journey-said")?.textContent).toBe(
    "Stopping the software OpenBot runs on",
  );
  // With no services OpenBot created, their part never runs, and is not what Quit says it is
  // doing once a later part has begun (a Windows box, before sign-in).
  view.rerender(
    <ShuttingDown
      status={{
        seq: 6,
        steps: [
          done("stop-openbot"),
          { step: "stop-engine", ok: true, running: true, detail: "" },
        ],
      }}
    />,
  );
  expect(view.container.querySelector(".journey-said")?.textContent).toBe(
    "Stopping the software OpenBot runs on",
  );
});

/**
 * The journey's spinner is the one on the screen while a Quit runs: the row it is on is marked,
 * not spun. Both spun at once ("Closing OpenBot's apps" over "Stopping OpenBot · In progress").
 */
test("a running Quit shows one spinner: the journey's", () => {
  const view = render(
    <ShuttingDown
      status={{
        seq: 1,
        steps: [{ step: "stop-openbot", ok: true, running: true, detail: "" }],
      }}
    />,
  );
  const spinners = view.container.querySelectorAll(".step-spinner");
  expect(spinners).toHaveLength(1);
  expect(spinners[0]?.closest(".journey")).not.toBeNull();
  expect(view.container.querySelectorAll(".step .step-current")).toHaveLength(
    1,
  );
});

test("a Quit that stopped partway shows no journey, so its rows keep their own marks", () => {
  const view = render(
    <ShuttingDown
      status={{
        seq: 1,
        steps: [
          { step: "stop-openbot", ok: false, running: false, detail: "" },
        ],
      }}
    />,
  );
  expect(view.container.querySelector(".journey")).toBeNull();
  expect(view.container.querySelectorAll(".step-spinner")).toHaveLength(0);
});

test("local shutdown separates its progress rail from the operation and stable explanation", () => {
  const view = render(
    <ShuttingDown
      status={{
        seq: 2,
        steps: [
          { step: "stop-openbot", ok: true, running: false, detail: "" },
          { step: "stop-intelligence", ok: true, running: true, detail: "" },
        ],
      }}
    />,
  );
  const rail = view.getByRole("complementary", { name: "Shutdown stages" });
  expect(rail.querySelectorAll(".step")).toHaveLength(2);
  expect(
    view
      .getByRole("region", { name: "How far along" })
      .closest(".quit-current"),
  ).not.toBeNull();
  expect(view.getByRole("status").closest(".setup-footer")).not.toBeNull();
  expect(view.queryAllByRole("button")).toHaveLength(0);
});
