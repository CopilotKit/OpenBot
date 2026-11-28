import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { GridOverlay } from "./GridOverlay";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("renders an svg that ignores the pointer", () => {
  const { container } = render(
    <GridOverlay width={100} height={50} zoom={2} color="red" />,
  );
  const svg = container.querySelector("svg[data-workbench-grid]");
  expect(svg).not.toBeNull();
  expect((svg as SVGElement).style.pointerEvents).toBe("none");
  expect(svg?.getAttribute("width")).toBe("200");
  expect(svg?.getAttribute("height")).toBe("100");
});

test.each([1, 2])(
  "minor lines every 4 and major every 8 at zoom %i",
  (zoom) => {
    const { container } = render(
      <GridOverlay width={100} height={50} zoom={zoom} color="red" />,
    );
    const [minor, major] = Array.from(container.querySelectorAll("pattern"));
    expect(minor?.getAttribute("width")).toBe(String(4 * zoom));
    expect(major?.getAttribute("width")).toBe(String(8 * zoom));
  },
);

test("with no picked color the lines take the app's ring token", () => {
  const { container } = render(
    <GridOverlay width={100} height={50} zoom={1} />,
  );
  const paths = Array.from(container.querySelectorAll("path"));
  expect(paths.map((path) => path.getAttribute("class"))).toEqual([
    "stroke-ring/15",
    "stroke-ring/30",
  ]);
  expect(paths.every((path) => !path.hasAttribute("stroke"))).toBe(true);
});
