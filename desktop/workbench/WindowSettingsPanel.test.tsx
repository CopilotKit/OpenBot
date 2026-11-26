import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/** Opens the select with that name and picks the option with that name. */
async function pick(
  view: ReturnType<typeof render>,
  select: string,
  option: string,
) {
  const person = userEvent.setup({ document });
  await person.click(view.getByRole("combobox", { name: select }));
  await person.click(
    await within(document.body).findByRole("option", { name: option }),
  );
}

/** The words a select shows now. */
function shown(view: ReturnType<typeof render>, select: string) {
  return view
    .getByRole("combobox", { name: select })
    .querySelector('[data-slot="select-value"]')?.textContent;
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

test("OS Windows sends only os", async () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  expect(shown(view, "OS")).toBe("Mac");
  await pick(view, "OS", "Windows");
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
  change(view.getByLabelText("Width"), "720");
  expect(p.onChange).toHaveBeenCalledWith({ width: 720 });
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

test("Theme Dark sends only theme", async () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  expect(shown(view, "Theme")).toBe("Light");
  await pick(view, "Theme", "Dark");
  expect(p.onChange).toHaveBeenCalledWith({ theme: "dark" });
});

test("Active checkbox sends only active", () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  const active = view.getByRole("checkbox", { name: "Active" });
  expect(active.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(active);
  expect(p.onChange).toHaveBeenCalledWith({ active: false });
});

test("Grid checkbox sends only grid", () => {
  const p = props();
  const view = render(<WindowSettingsPanel {...p} />);
  fireEvent.click(view.getByRole("checkbox", { name: "Grid" }));
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
  expect(view.queryByRole("combobox", { name: "Host" })).toBeNull();
});

function appProps() {
  const onAppChange = mock();
  const p: WindowSettingsPanelProps = {
    ...props(),
    app: {
      host: "desktop",
      role: null,
      skin: null,
      sidebar: null,
    },
    onAppChange,
  };
  return { p, onAppChange };
}

test("with app the App section shows its selects", () => {
  const { p } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  expect(view.container.querySelector("h3")?.textContent).toBe("App");
  expect(shown(view, "Host")).toBe("OpenBot Desktop");
  // Signed in as, Skin and Sidebar each start at "Preset default".
  expect(shown(view, "Signed in as")).toBe("Preset default");
  expect(shown(view, "Skin")).toBe("Preset default");
  expect(shown(view, "Sidebar")).toBe("Preset default");
});

test("Host sends only host", async () => {
  const { p, onAppChange } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  await pick(view, "Host", "Browser");
  expect(onAppChange).toHaveBeenCalledWith({ host: "browser" });
  expect(p.onChange).not.toHaveBeenCalled();
});

test("Signed in as sends the role, and Preset default sends null", async () => {
  const { p, onAppChange } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  await pick(view, "Signed in as", "Admin");
  expect(onAppChange).toHaveBeenLastCalledWith({ role: "admin" });
  view.rerender(
    <WindowSettingsPanel {...p} app={{ ...p.app!, role: "admin" }} />,
  );
  await pick(view, "Signed in as", "Preset default");
  expect(onAppChange).toHaveBeenLastCalledWith({ role: null });
});

test("every control has a visible label", () => {
  const { p } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  const names = Array.from(
    view.container.querySelectorAll(
      '[data-slot="field"] > [data-slot="field-label"]',
    ),
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
    "Skin",
    "Sidebar",
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

test("Skin sends the skin, and Preset default sends null", async () => {
  const { p, onAppChange } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  await pick(view, "Skin", "OpenDots");
  expect(onAppChange).toHaveBeenLastCalledWith({ skin: "opendots" });
  view.rerender(
    <WindowSettingsPanel {...p} app={{ ...p.app!, skin: "opendots" }} />,
  );
  await pick(view, "Skin", "Preset default");
  expect(onAppChange).toHaveBeenLastCalledWith({ skin: null });
});

test("Sidebar sends open or closed, and Preset default sends null", async () => {
  const { p, onAppChange } = appProps();
  const view = render(<WindowSettingsPanel {...p} />);
  await pick(view, "Sidebar", "Closed");
  expect(onAppChange).toHaveBeenLastCalledWith({ sidebar: "closed" });
  view.rerender(
    <WindowSettingsPanel {...p} app={{ ...p.app!, sidebar: "closed" }} />,
  );
  await pick(view, "Sidebar", "Preset default");
  expect(onAppChange).toHaveBeenLastCalledWith({ sidebar: null });
});

test("Select mode shows Inspect and sends off for Off", async () => {
  const p = {
    ...props(),
    selectMode: "inspect" as const,
    onSelectMode: mock(),
  };
  const view = render(<WindowSettingsPanel {...p} />);
  expect(shown(view, "Select mode")).toBe("Inspect");
  await pick(view, "Select mode", "Off");
  expect(p.onSelectMode).toHaveBeenCalledWith("off");
  expect(p.onChange).not.toHaveBeenCalled();
});

test("without onSelectMode there is no Select mode row", () => {
  const view = render(<WindowSettingsPanel {...props()} />);
  expect(view.queryByRole("combobox", { name: "Select mode" })).toBeNull();
});
