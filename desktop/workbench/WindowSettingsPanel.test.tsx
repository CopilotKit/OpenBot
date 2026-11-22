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

test("without app there is no App section", () => {
  const view = render(<WindowSettingsPanel {...props()} />);
  expect(view.container.querySelector("h3")).toBeNull();
  expect(view.queryByLabelText("Host")).toBeNull();
});

function appProps() {
  const onAppChange = mock();
  const p: WindowSettingsPanelProps = {
    ...props(),
    app: { host: "desktop", role: null, motion: "still" },
    onAppChange,
  };
  return { p, onAppChange };
}

test("with app the App section shows the three selects", () => {
  const { p } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  expect(view.container.querySelector("h3")?.textContent).toBe("App");
  expect((view.getByLabelText("Host") as HTMLSelectElement).value).toBe(
    "desktop",
  );
  expect(view.getByText("As the scene says")).not.toBeNull();
  expect((view.getByLabelText("Motion") as HTMLSelectElement).value).toBe(
    "still",
  );
});

test("Host sends only host", () => {
  const { p, onAppChange } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  change(view.getByLabelText("Host"), "browser");
  expect(onAppChange).toHaveBeenCalledWith({ host: "browser" });
  expect(p.onChange).not.toHaveBeenCalled();
});

test("Signed in as sends the role, and As the scene says sends null", () => {
  const { p, onAppChange } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  change(view.getByLabelText("Signed in as"), "admin");
  expect(onAppChange).toHaveBeenLastCalledWith({ role: "admin" });
  change(view.getByLabelText("Signed in as"), "scene");
  expect(onAppChange).toHaveBeenLastCalledWith({ role: null });
});

test("Motion sends only motion", () => {
  const { p, onAppChange } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  change(view.getByLabelText("Motion"), "real");
  expect(onAppChange).toHaveBeenCalledWith({ motion: "real" });
});

test("every control has a visible label", () => {
  const { p } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  const names = Array.from(
    view.container.querySelectorAll(".wb-prop > span, .wb-prop > label"),
  ).map((el) => el.textContent);
  expect(names).toEqual([
    "Size",
    "Zoom",
    "OS",
    "Theme",
    "Active",
    "Grid",
    "Host",
    "Signed in as",
    "Motion",
  ]);
});

test("Fit shows its zoom, and a click turns it off", () => {
  const onFit = mock();
  const view = render(
    <WindowSettingsPanel
      {...props()}
      fit={{ on: true, zoom: 0.734 }}
      onFit={onFit}
    />,
  );
  expect((view.getByLabelText("Zoom") as HTMLInputElement).value).toBe("0.73");
  const button = view.getByText("Fit (73%)");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(button);
  expect(onFit).toHaveBeenCalledWith(false);
});

test("with Fit off the Zoom field shows the zoom you set", () => {
  const onFit = mock();
  const view = render(
    <WindowSettingsPanel
      {...props()}
      fit={{ on: false, zoom: 0.5 }}
      onFit={onFit}
    />,
  );
  expect((view.getByLabelText("Zoom") as HTMLInputElement).value).toBe("1");
  fireEvent.click(view.getByText("Fit"));
  expect(onFit).toHaveBeenCalledWith(true);
});
