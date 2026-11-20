/** Short words only as whole words: "pin" is in "topping" and "shipping", "otp" in "hotpot". */
export const SENSITIVE_FIELD =
  /password|secret|token|one.time|verification|credit.card|security.code|passcode|card.?(?:number|num|no)(?![a-z])|cardholder|card.?verification|(?:^|[^a-z])(?:cc-|(?:cvc|cvv|csc|pin|otp)(?![a-z]))/i;

type DemonstrationTarget = {
  role: string;
  name: string;
  sensitive: boolean;
};

/**
 * What a field is, as the Recorder's masking asks it (`extension/src/content/masking-context.ts`): its role, a name a
 * person would read, and whether it holds a secret. Never reads a field's value, page body, clipboard or image.
 * Self-contained, with the sensitive rule written out in it; `demonstration-rules.test.ts` keeps that copy equal to
 * `SENSITIVE_FIELD`.
 */
export function describeDemonstrationTarget(input: {
  point: { x: number; y: number } | null;
  element?: Element | null;
}): DemonstrationTarget {
  const hit =
    input.element ??
    (input.point
      ? document.elementFromPoint(input.point.x, input.point.y)
      : document.activeElement);
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
    /password|secret|token|one.time|verification|credit.card|security.code|passcode|card.?(?:number|num|no)(?![a-z])|cardholder|card.?verification|(?:^|[^a-z])(?:cc-|(?:cvc|cvv|csc|pin|otp)(?![a-z]))/i.test(
      [
        label,
        element.getAttribute("name"),
        element.getAttribute("autocomplete"),
      ].join(" "),
    );
  const name = sensitive
    ? "[sensitive field]"
    : (label ?? "")
        .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted]")
        .replace(/[^\s@]+@[^\s@]+/g, "[redacted]")
        .trim()
        .slice(0, 120);
  return { role: role.slice(0, 40), name: name || role, sensitive };
}
