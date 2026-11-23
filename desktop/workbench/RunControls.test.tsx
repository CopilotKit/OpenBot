import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  formatTime,
  parseSpeed,
  RunControls,
  type RunControlsProps,
} from "./RunControls";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function props(over: Partial<RunControlsProps> = {}): RunControlsProps {
  return {
    now: 0,
    end: 100_000,
    marks: [],
    playing: false,
    speed: 1,
    onPlay: mock(),
    onPause: mock(),
    onStep: mock(),
    onSeek: mock(),
    onSpeed: mock(),
    ...over,
  };
}

test("formatTime writes m:ss", () => {
  expect(formatTime(0)).toBe("0:00");
  expect(formatTime(74_000)).toBe("1:14");
  expect(formatTime(600_000)).toBe("10:00");
  expect(formatTime(1_999)).toBe("0:01");
});

test("Play calls onPlay", () => {
  const p = props();
  const view = render(<RunControls {...p} />);
  fireEvent.click(view.getByText("Play"));
  expect(p.onPlay).toHaveBeenCalledTimes(1);
});

test("Pause shows while playing and calls onPause", () => {
  const p = props({ playing: true });
  const view = render(<RunControls {...p} />);
  expect(view.queryByText("Play")).toBeNull();
  fireEvent.click(view.getByText("Pause"));
  expect(p.onPause).toHaveBeenCalledTimes(1);
});

/** Opens the Speed list and picks the option with that name. */
async function pickSpeed(view: ReturnType<typeof render>, name: string) {
  const person = userEvent.setup({ document });
  await person.click(view.getByRole("combobox", { name: "Speed" }));
  await person.click(
    await within(document.body).findByRole("option", { name }),
  );
}

test("speed change calls onSpeed", async () => {
  const p = props();
  const view = render(<RunControls {...p} />);
  await pickSpeed(view, "Max");
  expect(p.onSpeed).toHaveBeenCalledWith("max");
});

test("the Time slider seeks with a number", async () => {
  const p = props({ now: 5000 });
  const view = render(<RunControls {...p} />);
  const time = view.getByRole("slider", { name: "Time" });
  expect(time.getAttribute("aria-valuenow")).toBe("5000");
  time.focus();
  await userEvent.setup({ document }).keyboard("{ArrowRight}");
  expect(p.onSeek).toHaveBeenCalledWith(5100);
});

test("shows time text and marks", () => {
  const view = render(
    <RunControls {...props({ now: 74_000, marks: [10_000, 50_000] })} />,
  );
  expect(view.getByText("1:14 / 1:40")).toBeTruthy();
  expect(view.getAllByTestId("mark").length).toBe(2);
});

test("the speeds are ¼×, ½×, 1×, 10× and Max", async () => {
  const view = render(<RunControls {...props()} />);
  const trigger = view.getByRole("combobox", { name: "Speed" });
  expect(trigger.textContent).toContain("1×");
  await userEvent.setup({ document }).click(trigger);
  const options = await within(document.body).findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "¼×",
    "½×",
    "1×",
    "10×",
    "Max",
  ]);
});

test("a slow speed calls onSpeed with a number", async () => {
  const p = props();
  const view = render(<RunControls {...p} />);
  await pickSpeed(view, "¼×");
  expect(p.onSpeed).toHaveBeenCalledWith(0.25);
});

test("parseSpeed reads every option and gives 1× for anything else", () => {
  expect(parseSpeed("0.25")).toBe(0.25);
  expect(parseSpeed("0.5")).toBe(0.5);
  expect(parseSpeed("1")).toBe(1);
  expect(parseSpeed("10")).toBe(10);
  expect(parseSpeed("max")).toBe("max");
  expect(parseSpeed("3")).toBe(1);
});

test("Pause at each action calls onPauseAtActions, and the next action shows", () => {
  const onPauseAtActions = mock();
  const view = render(
    <RunControls
      {...props({
        pauseAtActions: false,
        onPauseAtActions,
        next: "Click · Install",
      })}
    />,
  );
  fireEvent.click(view.getByRole("checkbox", { name: "Pause at each action" }));
  expect(onPauseAtActions).toHaveBeenCalledWith(true);
  expect(view.getByText("Next: Click · Install")).toBeTruthy();
});
