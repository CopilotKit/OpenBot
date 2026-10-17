import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import { startStepCapture } from "../src/content/steps";

beforeAll(() =>
  GlobalRegistrator.register({ url: "https://app.example.test/page" }),
);
afterAll(() => GlobalRegistrator.unregister());

let sent: DemonstrationAction[];
let stop: (() => void) | undefined;
beforeEach(() => {
  document.body.innerHTML = "";
  sent = [];
});
afterEach(() => {
  stop?.();
  stop = undefined;
});

function start(
  options: {
    isIgnored?: (target: EventTarget | null, path: EventTarget[]) => boolean;
    isTrusted?: (event: Event) => boolean;
    scrollWindowMs?: number;
  } = {},
) {
  const capture = startStepCapture({
    send: (action) => sent.push(action),
    isIgnored: options.isIgnored ?? (() => false),
    isTrusted: options.isTrusted ?? (() => true),
    scrollWindowMs: options.scrollWindowMs,
  });
  stop = capture.stop;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a click on a labelled button becomes a click step with OpenBot's label", () => {
  document.body.innerHTML = `<button>Save</button>`;
  start();
  document
    .querySelector("button")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  expect(sent).toEqual([
    {
      kind: "click",
      url: "https://app.example.test/page",
      target: { role: "button", name: "Save", sensitive: false },
    },
  ]);
});

test("a right click is not a step and a middle click is", () => {
  document.body.innerHTML = `<a href="#x">Docs</a>`;
  start();
  const link = document.querySelector("a")!;
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 2 }));
  expect(sent).toEqual([]);
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 1 }));
  expect(sent.map((step) => step.kind)).toEqual(["click"]);
});

test("untrusted and ignored events are skipped", () => {
  document.body.innerHTML = `<button id="a">A</button><button id="b" data-copilotkit-ignore>B</button>`;
  start({
    isTrusted: (event) => (event.target as Element).id !== "a",
    isIgnored: (target) => (target as Element).id === "b",
  });
  for (const id of ["a", "b"])
    document
      .getElementById(id)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  expect(sent).toEqual([]);
});

test("typing produces one type step per focus streak", () => {
  document.body.innerHTML = `<label for="n">Name</label><input id="n">`;
  start();
  const input = document.querySelector("input")!;
  const type = () => input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  type();
  type();
  type();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    kind: "type",
    target: { role: "textbox", name: "Name", sensitive: false },
  });
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  type();
  expect(sent.map((step) => step.kind)).toEqual(["type", "type"]);
});

test("input on a checkbox is not a type step", () => {
  document.body.innerHTML = `<input type="checkbox" aria-label="Agree">`;
  start();
  document
    .querySelector("input")!
    .dispatchEvent(new Event("input", { bubbles: true }));
  expect(sent).toEqual([]);
});

test("typing into a password field names it as sensitive and never carries a value", () => {
  document.body.innerHTML = `<input type="password" aria-label="Pass">`;
  start();
  const input = document.querySelector("input")!;
  input.value = "hunter22";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(sent[0]).toMatchObject({
    target: { name: "[sensitive field]", sensitive: true },
  });
  expect(JSON.stringify(sent)).not.toContain("hunter22");
});

test("Enter in a field is a key step; letters are not", () => {
  document.body.innerHTML = `<input aria-label="Search">`;
  start();
  const input = document.querySelector("input")!;
  input.focus();
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "a", bubbles: true }),
  );
  expect(sent).toEqual([]);
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  expect(sent).toEqual([
    {
      kind: "key",
      key: "Enter",
      url: "https://app.example.test/page",
      target: { role: "textbox", name: "Search", sensitive: false },
    },
  ]);
});

test("wheel events within the window add up to one scroll step, clamped", async () => {
  document.body.innerHTML = `<main id="m">x</main>`;
  start({ scrollWindowMs: 20 });
  const main = document.getElementById("m")!;
  for (const deltaY of [100, 150, 80])
    main.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
  expect(sent).toEqual([]);
  await wait(60);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ kind: "scroll", deltaY: 330 });
  main.dispatchEvent(new WheelEvent("wheel", { deltaY: 9000, bubbles: true }));
  main.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -50000, bubbles: true }),
  );
  main.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -50000, bubbles: true }),
  );
  await wait(60);
  expect(sent[1]).toMatchObject({ kind: "scroll", deltaY: -2000 });
});

test("stop removes the listeners and drops a pending scroll", async () => {
  document.body.innerHTML = `<button>Go</button>`;
  start({ scrollWindowMs: 20 });
  const button = document.querySelector("button")!;
  button.dispatchEvent(new WheelEvent("wheel", { deltaY: 10, bubbles: true }));
  stop?.();
  stop = undefined;
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  await wait(60);
  expect(sent).toEqual([]);
});

function shadowFixture() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<input aria-label="Inner field"><button>Inner save</button>`;
  const input = root.querySelector("input")!;
  const button = root.querySelector("button")!;
  const retargeted = (event: Event, inner: Element) => {
    Object.defineProperty(event, "composedPath", {
      value: () => [
        inner,
        root,
        host,
        document.body,
        document.documentElement,
        document,
        window,
      ],
    });
    return event;
  };
  return { host, root, input, button, retargeted };
}

test("typing into an input inside a shadow root names the inner input", () => {
  const { host, input, retargeted } = shadowFixture();
  start();
  host.dispatchEvent(retargeted(new Event("input", { bubbles: true }), input));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    kind: "type",
    target: { role: "textbox", name: "Inner field" },
  });
});

test("a click on a button inside a shadow root names the button, not its host", () => {
  const { host, button, retargeted } = shadowFixture();
  start();
  host.dispatchEvent(
    retargeted(new MouseEvent("click", { bubbles: true, button: 0 }), button),
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    kind: "click",
    target: { role: "button", name: "Inner save" },
  });
});

test("Enter while focus is inside a shadow root names the inner focused control", () => {
  const { host, root, input } = shadowFixture();
  host.tabIndex = 0;
  host.focus();
  Object.defineProperty(root, "activeElement", { value: input });
  start();
  host.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    kind: "key",
    key: "Enter",
    target: { role: "textbox", name: "Inner field" },
  });
});
