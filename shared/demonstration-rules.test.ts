import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  describeDemonstrationTarget,
  SENSITIVE_FIELD,
} from "./demonstration-rules";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function render(html: string) {
  document.body.innerHTML = html;
}

test("a click on a label's text is a click on the control it names", () => {
  render(`<label for="s">Small</label><input id="s" type="radio" name="size">`);
  expect(
    describeDemonstrationTarget({
      point: null,
      element: document.querySelector("label"),
    }),
  ).toEqual({ role: "radio", name: "Small", sensitive: false });
});

test("a field is sensitive when only its separate label says so", () => {
  render(`<label for="c">Security code</label><input id="c" name="field7">`);
  expect(
    describeDemonstrationTarget({
      point: null,
      element: document.querySelector("input"),
    }),
  ).toEqual({ role: "textbox", name: "[sensitive field]", sensitive: true });
});

test("a field labelled only Card number is sensitive", () => {
  render(`<label for="n">Card number</label><input id="n" name="f7">`);
  expect(
    describeDemonstrationTarget({
      point: null,
      element: document.querySelector("input"),
    }).sensitive,
  ).toBe(true);
  expect(SENSITIVE_FIELD.test("Card number")).toBe(true);
  expect(SENSITIVE_FIELD.test("Cardholder name")).toBe(true);
  expect(SENSITIVE_FIELD.test("Card notes")).toBe(false);
});

test("emails and long tokens in names are masked", () => {
  render(
    `<button aria-label="Email ana@example.test about abcdefghijklmnopqrstuvwxyz0123456789">x</button>`,
  );
  expect(
    describeDemonstrationTarget({
      point: null,
      element: document.querySelector("button"),
    }).name,
  ).toBe("Email [redacted] about [redacted]");
});

test("words that contain pin or otp are not sensitive", () => {
  render(`<input aria-label="Shipping topping hotpot">`);
  expect(
    describeDemonstrationTarget({
      point: null,
      element: document.querySelector("input"),
    }).sensitive,
  ).toBe(false);
});

test("the in-page copy of the sensitive rule is the exported one", () => {
  expect(describeDemonstrationTarget.toString()).toContain(
    SENSITIVE_FIELD.source,
  );
});
