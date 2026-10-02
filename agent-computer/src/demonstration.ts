import type { Page } from "playwright";
import type { InputMessage } from "./screencast";
export type RecordedGesture = {
  kind: "click" | "type" | "key" | "scroll";
  key?: string;
  deltaY?: number;
};
export function gestureForRecording(
  input: InputMessage,
): RecordedGesture | null {
  if (input.type === "mouse")
    return input.event === "released" && input.button !== "right"
      ? { kind: "click" }
      : null;
  if (input.type === "wheel")
    return {
      kind: "scroll",
      deltaY: Math.max(-2000, Math.min(2000, input.deltaY)),
    };
  if (input.type === "text") return { kind: "type" };
  if (input.event !== "down") return null;
  if (input.key.length === 1 || (input.text && input.key !== "Enter"))
    return { kind: "type" };
  if (
    [
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowDown",
      "ArrowUp",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageDown",
      "PageUp",
    ].includes(input.key)
  )
    return { kind: "key", key: input.key };
  return null;
}
export function safeDemonstrationUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "about:blank";
    const path = url.pathname
      .split("/")
      .map((part) =>
        part.length > 40 || /token|secret|password|credential/i.test(part)
          ? "[redacted]"
          : part,
      )
      .join("/");
    return `${url.origin}${path}`;
  } catch {
    return "about:blank";
  }
}
/** Never reads a field's value, page body, clipboard or image. All text entry is parameterized. */
export async function describeHumanGesture(page: Page, input: InputMessage) {
  const gesture = gestureForRecording(input);
  if (!gesture) return null;
  const point =
    input.type === "mouse" || input.type === "wheel"
      ? { x: input.x, y: input.y }
      : null;
  const target = await page.evaluate((point) => {
    const hit = point
      ? document.elementFromPoint(point.x, point.y)
      : document.activeElement;
    const closest =
      hit?.closest(
        "button,a,input,textarea,select,label,[role],[contenteditable=true]",
      ) ?? hit;
    // A click on a label's text is a click on the control it names: "Small", a radio, not a label.
    const element =
      closest instanceof HTMLLabelElement
        ? (closest.control ?? closest)
        : closest;
    if (!element) return { role: "page", name: "Page", sensitive: false };
    const tag = element.tagName.toLowerCase();
    const inputType =
      element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
    const role =
      element.getAttribute("role") ||
      (
        {
          checkbox: "checkbox",
          radio: "radio",
          button: "button",
          submit: "button",
          reset: "button",
          image: "button",
          range: "slider",
          file: "button",
        } as Record<string, string>
      )[inputType] ||
      (
        {
          button: "button",
          a: "link",
          input: "textbox",
          textarea: "textbox",
          select: "combobox",
        } as Record<string, string>
      )[tag] ||
      tag;
    const label =
      element.getAttribute("aria-label") ||
      (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? Array.from(element.labels ?? [])
            .map((entry) => entry.textContent ?? "")
            .join(" ")
        : "") ||
      (tag === "button" || tag === "a" ? element.textContent : "") ||
      element.getAttribute("placeholder") ||
      role;
    const sensitive =
      element.getAttribute("type") === "password" ||
      // Short words only as whole words: "pin" is in "topping" and "shipping", "otp" in "hotpot".
      /password|secret|token|one.time|verification|credit.card|security.code|passcode|(?:^|[^a-z])(?:cc-|(?:cvc|cvv|pin|otp)(?![a-z]))/i.test(
        [
          label,
          element.getAttribute("name"),
          element.getAttribute("autocomplete"),
        ].join(" "),
      );
    const name = sensitive
      ? "[sensitive field]"
      : label
          .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted]")
          .replace(/[^\s@]+@[^\s@]+/g, "[redacted]")
          .trim()
          .slice(0, 120);
    return { role: role.slice(0, 40), name: name || role, sensitive };
  }, point);
  return { ...gesture, url: safeDemonstrationUrl(page.url()), target };
}
