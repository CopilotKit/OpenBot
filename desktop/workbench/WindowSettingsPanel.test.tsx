import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  WindowSettingsPanel,
  type WindowSettingsPanelProps,
} from "./WindowSettingsPanel";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function props(): WindowSettingsPanelProps {
  return {
    value: {
      width: 1000,
      height: 800,
      os: "mac",
      active: true,
      theme: "light",
      zoom: 1,
      grid: false,
    },
    gridColor: "#ff0000",
    onChange: mock(),
    onGridColor: mock(),
    onCopyLink: mock(),
  };
}

function change(element: HTMLElement, value: string) {
  fireEvent.focusIn(element);
  fireEvent.change(element, { target: { value } });
  fireEvent.keyUp(element);
}

test("720 × 560 sends both sizes", () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  fireEvent.click(view.getByText("720 × 560"));
  expect(p.onChange).toHaveBeenCalledWith({ width: 720, height: 560 });
});

test("OS Windows sends only os", () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  change(view.getByLabelText("OS"), "windows");
  expect(p.onChange).toHaveBeenCalledWith({ os: "windows" });
});

test("Width below the minimum sends nothing", () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  change(view.getByLabelText("Width"), "500");
  expect(p.onChange).not.toHaveBeenCalled();
});

test("Width at the minimum sends only width", () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  change(view.getByLabelText("Width"), "800");
  expect(p.onChange).toHaveBeenCalledWith({ width: 800 });
});

test("Zoom outside 0.5 to 2 sends nothing, inside sends zoom", () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  change(view.getByLabelText("Zoom"), "0");
  change(view.getByLabelText("Zoom"), "3");
  expect(p.onChange).not.toHaveBeenCalled();
  change(view.getByLabelText("Zoom"), "1.5");
  expect(p.onChange).toHaveBeenCalledWith({ zoom: 1.5 });
});

test("Grid checkbox sends only grid", () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  fireEvent.click(view.getByLabelText("Grid"));
  expect(p.onChange).toHaveBeenCalledWith({ grid: true });
});

test("Copy link calls onCopyLink", () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  fireEvent.click(view.getByText("Copy link"));
  expect(p.onCopyLink).toHaveBeenCalledTimes(1);
});

test("Grid color calls onGridColor", () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  change(view.getByLabelText("Grid color"), "#00ff00");
  expect(p.onGridColor).toHaveBeenCalledWith("#00ff00");
});
