import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { createRef } from "react";
import {
  COLLAPSED_PREF,
  SceneList,
  type SceneListHandle,
  sceneMatches,
} from "./SceneList";
import type { Scene } from "./scenes/types";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());

const scenes: Scene[] = [
  {
    id: "c1",
    title: "Cloud one",
    group: "Connected",
    start: { hash: "", search: "" },
  },
  {
    id: "i1",
    title: "Install one",
    group: "Install",
    start: { hash: "", search: "" },
  },
  {
    id: "i2",
    title: "Install two",
    group: "Install",
    start: { hash: "", search: "" },
  },
];

test("groups render in SCENE_GROUPS order and empty groups have no heading", () => {
  const { container } = render(
    <SceneList scenes={scenes} current="i1" onPick={() => {}} />,
  );
  const headings = Array.from(container.querySelectorAll("h3")).map(
    (h) => h.textContent,
  );
  expect(headings).toEqual(["Install", "Connected"]);
});

test("the current scene has aria-current", () => {
  const { getByText } = render(
    <SceneList scenes={scenes} current="i2" onPick={() => {}} />,
  );
  expect(getByText("Install two").getAttribute("aria-current")).toBe("true");
  expect(getByText("Install two").hasAttribute("data-current")).toBe(true);
  expect(getByText("Install one").hasAttribute("data-current")).toBe(false);
  expect(getByText("Install one").getAttribute("aria-current")).toBeNull();
});

test("a click calls onPick with the id", () => {
  const onPick = mock((_id: string) => {});
  const { getByText } = render(
    <SceneList scenes={scenes} current="i1" onPick={onPick} />,
  );
  fireEvent.click(getByText("Cloud one"));
  expect(onPick).toHaveBeenCalledWith("c1");
});

/** The scene rows of a group: the buttons in its open part, not its heading. */
function rowsOf(group: HTMLElement): string[] {
  return Array.from(
    group.querySelectorAll<HTMLElement>("[data-slot=collapsible-content]"),
  ).flatMap((rows) =>
    within(rows)
      .getAllByRole("button")
      .map((b) => b.textContent ?? ""),
  );
}

function headingsWith(container: HTMLElement) {
  return Array.from(container.querySelectorAll("section")).map((section) => ({
    group: section.querySelector("h3")?.textContent,
    items: rowsOf(section),
  }));
}

test("with a list of groups, an app scene shows under its app group", () => {
  const items = [
    ...scenes,
    { id: "app-home", title: "Home empty", group: "App: Home" },
  ];
  const { container } = render(
    <SceneList
      scenes={items}
      current="i1"
      onPick={() => {}}
      groups={["Install", "App: Home"]}
    />,
  );
  expect(headingsWith(container)).toEqual([
    { group: "Install", items: ["Install one", "Install two"] },
    { group: "App: Home", items: ["Home empty"] },
    { group: "Other", items: ["Cloud one"] },
  ]);
});

test("a scene with an unknown group shows under Other, last", () => {
  const items = [...scenes, { id: "x1", title: "Lost one", group: "Nowhere" }];
  const { container } = render(
    <SceneList scenes={items} current="i1" onPick={() => {}} />,
  );
  expect(headingsWith(container)).toEqual([
    { group: "Install", items: ["Install one", "Install two"] },
    { group: "Connected", items: ["Cloud one"] },
    { group: "Other", items: ["Lost one"] },
  ]);
});

test("a scene row's tooltip has its full title and its id", () => {
  const { getByText } = render(
    <SceneList scenes={scenes} current="i1" onPick={() => {}} />,
  );
  expect(getByText("Install two").getAttribute("title")).toBe(
    "Install two (i2)",
  );
});

/** A change as a person makes it: React reads the value on focus, change and key up. */
function edit(el: HTMLElement, value: string) {
  fireEvent.focusIn(el);
  fireEvent.change(el, { target: { value } });
  fireEvent.keyUp(el);
}

function rowTitles(container: HTMLElement) {
  return rowsOf(container);
}

test("the filter matches the title, the id and the group", () => {
  expect(sceneMatches(scenes[1] as Scene, "one")).toBe(true);
  expect(sceneMatches(scenes[1] as Scene, "I2")).toBe(false);
  expect(sceneMatches(scenes[2] as Scene, "i2")).toBe(true);
  expect(sceneMatches(scenes[0] as Scene, "connect")).toBe(true);
  expect(sceneMatches(scenes[0] as Scene, "  ")).toBe(true);
});

test("typing in the filter keeps the matching scenes, and says when none match", () => {
  const view = render(
    <SceneList scenes={scenes} current="i1" onPick={() => {}} />,
  );
  const filter = view.getByLabelText("Filter scenes");
  edit(filter, "two");
  expect(rowTitles(view.container)).toEqual(["Install two"]);
  edit(filter, "connected");
  expect(rowTitles(view.container)).toEqual(["Cloud one"]);
  edit(filter, "zzz");
  expect(view.getByText("No scene matches “zzz”.")).not.toBeNull();
});

test("↓ and Enter in the filter open the next scene", () => {
  const onPick = mock((_id: string) => {});
  const view = render(
    <SceneList scenes={scenes} current="i1" onPick={onPick} />,
  );
  const filter = view.getByLabelText("Filter scenes");
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  expect(filter.getAttribute("aria-activedescendant")).toBe("wb-scene-i2");
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith("i2");
});

test("the handle moves the cursor and picks; the current scene is not picked again", () => {
  const onPick = mock((_id: string) => {});
  const handle = createRef<SceneListHandle>();
  const view = render(
    <SceneList scenes={scenes} current="i1" onPick={onPick} handle={handle} />,
  );
  act(() => handle.current?.move(-1));
  expect(handle.current?.pickCursor()).toBe(false);
  act(() => handle.current?.move(1));
  act(() => handle.current?.move(1));
  act(() => handle.current?.move(1));
  // The end of the list stops the cursor.
  act(() => handle.current?.move(1));
  expect(view.container.querySelector("[data-cursor]")?.textContent).toBe(
    "Cloud one",
  );
  expect(handle.current?.pickCursor()).toBe(true);
  expect(onPick).toHaveBeenCalledWith("c1");
  act(() => handle.current?.focusFilter());
  expect(document.activeElement).toBe(view.getByLabelText("Filter scenes"));
});

test("a group folds, the fold is kept, and the current scene's group stays open", () => {
  const view = render(
    <SceneList scenes={scenes} current="i1" onPick={() => {}} />,
  );
  const connected = view.getByRole("button", { name: "Connected" });
  expect(connected.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(connected);
  expect(connected.getAttribute("aria-expanded")).toBe("false");
  expect(rowTitles(view.container)).toEqual(["Install one", "Install two"]);
  expect(
    JSON.parse(
      window.localStorage.getItem(`workbench.${COLLAPSED_PREF}`) ?? "[]",
    ),
  ).toEqual(["Connected"]);
  const install = view.getByRole("button", { name: "Install" });
  fireEvent.click(install);
  expect(install.getAttribute("aria-expanded")).toBe("true");
  cleanup();
  // A new page keeps the fold.
  const again = render(
    <SceneList scenes={scenes} current="i1" onPick={() => {}} />,
  );
  expect(rowTitles(again.container)).toEqual(["Install one", "Install two"]);
});

test("Collapse all folds every group but the current one; Expand all opens them", () => {
  const view = render(
    <SceneList scenes={scenes} current="c1" onPick={() => {}} />,
  );
  fireEvent.click(view.getByText("Collapse all"));
  expect(rowTitles(view.container)).toEqual(["Cloud one"]);
  fireEvent.click(view.getByText("Expand all"));
  expect(rowTitles(view.container)).toEqual([
    "Install one",
    "Install two",
    "Cloud one",
  ]);
});

test("a filter opens a folded group that has a match", () => {
  window.localStorage.setItem(
    `workbench.${COLLAPSED_PREF}`,
    JSON.stringify(["Connected"]),
  );
  const view = render(
    <SceneList scenes={scenes} current="i1" onPick={() => {}} />,
  );
  expect(rowTitles(view.container)).toEqual(["Install one", "Install two"]);
  edit(view.getByLabelText("Filter scenes"), "cloud");
  expect(rowTitles(view.container)).toEqual(["Cloud one"]);
});

test("after the filter is cleared, the cursor is on the current scene again", () => {
  const handle = createRef<SceneListHandle>();
  const view = render(
    <SceneList
      scenes={scenes}
      current="i1"
      onPick={() => {}}
      handle={handle}
    />,
  );
  const filter = view.getByLabelText("Filter scenes");
  edit(filter, "cloud");
  expect(filter.getAttribute("aria-activedescendant")).toBe("wb-scene-c1");
  edit(filter, "");
  expect(filter.getAttribute("aria-activedescendant")).toBe("wb-scene-i1");
  expect(handle.current?.pickCursor()).toBe(false);
});

test("a group's heading shows its count, and its name stays the button's name", () => {
  const view = render(
    <SceneList scenes={scenes} current="i1" onPick={() => {}} />,
  );
  const install = view.getByRole("button", { name: "Install" });
  expect(install.getAttribute("data-count")).toBe("2");
  edit(view.getByLabelText("Filter scenes"), "two");
  expect(
    view.getByRole("button", { name: "Install" }).getAttribute("data-count"),
  ).toBe("1/2");
});

test("the clear button empties the filter and puts the focus back in it", () => {
  const view = render(
    <SceneList scenes={scenes} current="i1" onPick={() => {}} />,
  );
  expect(view.queryByRole("button", { name: "Clear the filter" })).toBeNull();
  const filter = view.getByLabelText("Filter scenes") as HTMLInputElement;
  edit(filter, "cloud");
  fireEvent.click(view.getByRole("button", { name: "Clear the filter" }));
  expect(filter.value).toBe("");
  expect(document.activeElement).toBe(filter);
  expect(rowTitles(view.container)).toEqual([
    "Install one",
    "Install two",
    "Cloud one",
  ]);
});
