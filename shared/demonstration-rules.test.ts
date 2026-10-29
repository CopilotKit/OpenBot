import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  describeDemonstrationTarget,
  gestureForRecording,
  SENSITIVE_FIELD,
  safeDemonstrationUrl,
} from "./demonstration-rules";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function render(html: string) {
  document.body.innerHTML = html;
}

test("passwords, pasted text and printable key values are never part of a recorded gesture", () => {
  expect(
    gestureForRecording({ type: "text", text: "secret-password" }),
  ).toEqual({ kind: "type" });
  expect(
    gestureForRecording({
      type: "key",
      event: "down",
      key: "s",
      code: "KeyS",
      text: "s",
    }),
  ).toEqual({ kind: "type" });
});
test("pointer movement and releases are not false completed actions", () => {
  expect(
    gestureForRecording({ type: "mouse", event: "moved", x: 1, y: 2 }),
  ).toBeNull();
  expect(
    gestureForRecording({
      type: "key",
      event: "up",
      key: "Enter",
      code: "Enter",
    }),
  ).toBeNull();
});
test("URL provenance omits credentials, query tokens and fragments", () => {
  expect(
    safeDemonstrationUrl(
      "https://user:password@example.test/form?token=secret#secret",
    ),
  ).toBe("https://example.test/form");
});

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

test("a key gesture carries a typed demonstration key", () => {
  // `code` is required by InputMessage (`screencast.ts` `InputMessage`'s `key` variant), so GestureInput keeps it required too.
  expect(
    gestureForRecording({
      type: "key",
      event: "down",
      key: "Enter",
      code: "Enter",
    }),
  ).toEqual({ kind: "key", key: "Enter" });
  expect(
    gestureForRecording({
      type: "key",
      event: "down",
      key: "F5",
      code: "F5",
    }),
  ).toBeNull();
});

test("the function runs on its own, as Playwright serialises it", () => {
  const isolated = new Function(
    `return (${describeDemonstrationTarget.toString()})`,
  )() as typeof describeDemonstrationTarget;
  render(`<a href="/x">Invoices</a>`);
  expect(
    isolated({ point: null, element: document.querySelector("a") }),
  ).toEqual({ role: "link", name: "Invoices", sensitive: false });
});

test("the in-page copy of the sensitive rule is the exported one", () => {
  expect(describeDemonstrationTarget.toString()).toContain(
    SENSITIVE_FIELD.source,
  );
});
