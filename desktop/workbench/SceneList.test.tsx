import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SceneList } from "./SceneList";
import type { Scene } from "./scenes/types";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(cleanup);
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
  expect(getByText("Install two").className).toBe("wb-scene-current");
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

function headingsWith(container: HTMLElement) {
  return Array.from(container.querySelectorAll("section")).map((section) => ({
    group: section.querySelector("h3")?.textContent,
    items: Array.from(section.querySelectorAll("button")).map(
      (b) => b.textContent,
    ),
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
