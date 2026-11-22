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
