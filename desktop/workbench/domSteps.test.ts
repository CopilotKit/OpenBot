import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  findClickable,
  findField,
  performDomStep,
  runActions,
  typeInto,
} from "./domSteps";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterAll(() => GlobalRegistrator.unregister());

beforeEach(() => {
  document.body.innerHTML = "";
});

test("a label for a radio gives the input", () => {
  document.body.innerHTML = `
    <input type="radio" id="local" name="where" />
    <label for="local">This computer</label>`;
  expect(findClickable(document, "This computer")).toBe(
    document.getElementById("local"),
  );
});

test("an exact name wins over a prefix", () => {
  document.body.innerHTML = `
    <button id="long">Install later</button>
    <button id="exact">Install</button>`;
  expect(findClickable(document, "Install")?.id).toBe("exact");
  expect(findClickable(document, "Install l")?.id).toBe("long");
});

test("typeInto fires input and change", () => {
  document.body.innerHTML = `<label for="code">Code</label><input id="code" />`;
  const field = findField(document, "Code") as HTMLInputElement;
  expect(field).toBe(document.getElementById("code") as HTMLInputElement);
  const seen: string[] = [];
  field.addEventListener("input", () => seen.push("input"));
  field.addEventListener("change", () => seen.push("change"));
  typeInto(field, "ABCD-1234");
  expect(field.value).toBe("ABCD-1234");
  expect(seen).toEqual(["input", "change"]);
});

test("performDomStep calls onFound with the target before the click", () => {
  document.body.innerHTML = `<button id="go">Go</button>`;
  const order: string[] = [];
  const button = document.getElementById("go") as HTMLElement;
  button.addEventListener("click", () => order.push("click"));
  const ok = performDomStep({ click: "Go" }, document, (target) => {
    expect(target).toBe(button);
    order.push("found");
  });
  expect(ok).toBe(true);
  expect(order).toEqual(["found", "click"]);
});

test("performDomStep returns false, calls onFound(null) and warns when nothing matches", () => {
  const warn = mock((..._args: unknown[]) => {});
  const original = console.warn;
  console.warn = warn;
  try {
    const found: unknown[] = [];
    expect(
      performDomStep({ click: "Missing" }, document, (t) => found.push(t)),
    ).toBe(false);
    expect(
      performDomStep({ type: "x", into: "Nowhere" }, document, (t) =>
        found.push(t),
      ),
    ).toBe(false);
    expect(found).toEqual([null, null]);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toEqual([
      'Run step: nothing named "Missing" to click on the page.',
      'Run step: nothing named "Nowhere" to type into on the page.',
    ]);
  } finally {
    console.warn = original;
  }
});

test("runActions accepts a mixed list with other step kinds and sorts by time", () => {
  expect(
    runActions([
      { at: 2, type: "hi", into: "Message" },
      { at: 0.5, emit: "event", payload: {} },
      { at: 1, click: "Send" },
      { at: 3, api: "GET /api/me" },
    ]),
  ).toEqual([
    { kind: "click", name: "Send", at: 1000 },
    { kind: "type", name: "Message", text: "hi", at: 2000 },
  ]);
});
