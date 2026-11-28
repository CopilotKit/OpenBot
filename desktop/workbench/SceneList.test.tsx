import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SceneList, type SceneListItem } from "./SceneList";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const scenes: SceneListItem[] = [
  { id: "setup", title: "Setup", group: "Setup" },
  { id: "app-home", title: "Home", group: "App" },
  { id: "app-settings", title: "Settings", group: "App" },
];

test("App and Setup show their starting points together", () => {
  const view = render(
    <SceneList scenes={scenes} current="app-home" onPick={() => {}} />,
  );
  const sections = [...view.container.querySelectorAll("section")].map(
    (section) => ({
      name: within(section).getByRole("heading").textContent,
      views: within(section)
        .getAllByRole("button")
        .map((button) => button.textContent),
    }),
  );
  expect(sections).toEqual([
    { name: "App", views: ["Home", "Settings"] },
    { name: "Setup", views: ["Setup"] },
  ]);
});

test("the current view is identified and each title keeps its link id", () => {
  const view = render(
    <SceneList scenes={scenes} current="app-settings" onPick={() => {}} />,
  );
  const settings = view.getByRole("button", { name: "Settings" });
  const home = view.getByRole("button", { name: "Home" });
  expect(settings.getAttribute("aria-current")).toBe("true");
  expect(settings.hasAttribute("data-current")).toBe(true);
  expect(settings.getAttribute("title")).toBe("Settings (app-settings)");
  expect(home.getAttribute("aria-current")).toBeNull();
  view.rerender(
    <SceneList scenes={scenes} current="app-home" onPick={() => {}} />,
  );
  expect(settings.hasAttribute("data-current")).toBe(false);
  expect(home.getAttribute("aria-current")).toBe("true");
});

test("a click opens the picked view", () => {
  const onPick = mock();
  const view = render(
    <SceneList scenes={scenes} current="app-home" onPick={onPick} />,
  );
  fireEvent.click(view.getByRole("button", { name: "Setup" }));
  expect(onPick).toHaveBeenCalledWith("setup");
});

test("Tab reaches both groups and Enter or Space opens the focused view", async () => {
  const onPick = mock();
  const view = render(
    <SceneList scenes={scenes} current="app-home" onPick={onPick} />,
  );
  const person = userEvent.setup({ document });
  await person.tab();
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: "Home" }),
  );
  await person.keyboard("{Enter}");
  await person.tab();
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: "Settings" }),
  );
  await person.keyboard(" ");
  await person.tab();
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: "Setup" }),
  );
  await person.keyboard("{Enter}");
  expect(onPick.mock.calls.map(([id]) => id)).toEqual([
    "app-home",
    "app-settings",
    "setup",
  ]);
});
