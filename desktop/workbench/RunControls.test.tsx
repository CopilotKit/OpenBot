import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { formatTime, RunControls, type RunControlsProps } from "./RunControls";

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

test("speed change calls onSpeed", () => {
  const p = props();
  const view = render(<RunControls {...p} />);
  fireEvent.change(view.getByLabelText("Speed"), { target: { value: "max" } });
  expect(p.onSpeed).toHaveBeenCalledWith("max");
});

test("range change calls onSeek with a number", () => {
  const p = props();
  const view = render(<RunControls {...p} />);
  const t = view.getByLabelText("Time");
  fireEvent.focusIn(t);
  fireEvent.change(t, { target: { value: "5000" } });
  fireEvent.keyUp(t);
  expect(p.onSeek).toHaveBeenCalledWith(5000);
});

test("shows time text and marks", () => {
  const view = render(
    <RunControls {...props({ now: 74_000, marks: [10_000, 50_000] })} />,
  );
  expect(view.getByText("1:14 / 1:40")).toBeTruthy();
  expect(view.getAllByTestId("mark").length).toBe(2);
});
