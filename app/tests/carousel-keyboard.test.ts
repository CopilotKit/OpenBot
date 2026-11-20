import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { carouselKeyboardAction } from "../src/components/ui/carousel";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

test("horizontal carousels use left and right arrows", () => {
  const target = document.createElement("div");
  expect(carouselKeyboardAction("horizontal", "ArrowLeft", target)).toBe(
    "prev",
  );
  expect(carouselKeyboardAction("horizontal", "ArrowRight", target)).toBe(
    "next",
  );
  expect(carouselKeyboardAction("horizontal", "ArrowUp", target)).toBeNull();
});

test("vertical carousels use up and down arrows", () => {
  const target = document.createElement("div");
  expect(carouselKeyboardAction("vertical", "ArrowUp", target)).toBe("prev");
  expect(carouselKeyboardAction("vertical", "ArrowDown", target)).toBe("next");
  expect(carouselKeyboardAction("vertical", "ArrowLeft", target)).toBeNull();
});

test("editable descendants keep their native arrow keys", () => {
  for (const tag of ["input", "textarea", "select"] as const) {
    const target = document.createElement(tag);
    expect(
      carouselKeyboardAction("horizontal", "ArrowLeft", target),
    ).toBeNull();
    expect(
      carouselKeyboardAction("horizontal", "ArrowRight", target),
    ).toBeNull();
  }
  const editable = document.createElement("div");
  editable.contentEditable = "true";
  expect(
    carouselKeyboardAction("horizontal", "ArrowLeft", editable),
  ).toBeNull();
});
