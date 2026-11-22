import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  callNative,
  listenNative,
  nativeControl,
} from "../src/fakeNative/control";
import {
  type ClockTarget,
  installClock,
  type PageClock,
  SCENE_EPOCH,
} from "./clock";
import { startRun } from "./runner";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterAll(() => GlobalRegistrator.unregister());

let clock: PageClock;

beforeEach(() => {
  nativeControl().reset();
  const target: ClockTarget = {
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => 0 },
  };
  clock = installClock(SCENE_EPOCH, target);
});
afterEach(() => clock.uninstall());

const problem = { code: "x", message: "no" } as never;

test("an emit step reaches a listener on time", () => {
  const seen = mock((_e: unknown) => {});
  listenNative("tick", seen);
  startRun([{ at: 2, emit: "tick", payload: 1 }], clock);
  clock.advanceTo(1999);
  expect(seen).toHaveBeenCalledTimes(0);
  clock.advanceTo(2000);
  expect(seen).toHaveBeenCalledTimes(1);
});

test("a settle step settles a waiting call", async () => {
  nativeControl().setAnswer("cmd", { mode: "never" });
  const p = callNative("cmd");
  startRun([{ at: 1, settle: "cmd", value: "done" }], clock);
  clock.advanceTo(1000);
  expect(await p).toBe("done");
});

test("a fail step rejects a waiting call", async () => {
  nativeControl().setAnswer("cmd", { mode: "never" });
  const p = callNative("cmd");
  startRun([{ at: 1, fail: "cmd", problem }], clock);
  clock.advanceTo(1000);
  await expect(p).rejects.toBe(problem);
});

test("an answer step sets the answer", () => {
  startRun([{ at: 1, answer: "cmd", with: { mode: "never" } }], clock);
  clock.advanceTo(1000);
  expect(nativeControl().answers().get("cmd")).toEqual({ mode: "never" });
});

test("nextAt and end", () => {
  const run = startRun(
    [
      { at: 3, emit: "a", payload: null },
      { at: 1, emit: "a", payload: null },
    ],
    clock,
  );
  expect(run.end).toBe(3000);
  expect(run.nextAt(0)).toBe(1000);
  expect(run.nextAt(1000)).toBe(3000);
  expect(run.nextAt(3000)).toBeNull();
  expect(startRun([], clock).end).toBe(0);
});

test("a click step clicks a button by its text", () => {
  document.body.innerHTML = "<button> Go   on </button>";
  const clicked = mock(() => {});
  document.querySelector("button")?.addEventListener("click", clicked);
  startRun([{ at: 1, click: "Go on" }], clock);
  clock.advanceTo(1000);
  expect(clicked).toHaveBeenCalledTimes(1);
});

test("a click step picks a radio by its label's text", () => {
  document.body.innerHTML = `
    <label><input type="radio" name="provider" value="openai" /><span>OpenAI</span><span>Sign in with ChatGPT.</span></label>
    <label><input type="radio" name="provider" value="anthropic" /><span>Anthropic</span><span>Sign in with Claude.</span></label>`;
  const changed = mock(() => {});
  const [openai, anthropic] =
    document.querySelectorAll<HTMLInputElement>("input[type=radio]");
  anthropic.addEventListener("change", changed);
  startRun([{ at: 1, click: "Anthropic" }], clock);
  clock.advanceTo(1000);
  expect(anthropic.checked).toBe(true);
  expect(openai.checked).toBe(false);
  expect(changed).toHaveBeenCalledTimes(1);
});

test("a click step clicks a tab by its text", () => {
  document.body.innerHTML = `
    <div role="tablist">
      <div role="tab">Sign in with my plan</div>
      <div role="tab"> Use an  API key </div>
    </div>`;
  const clicked = mock(() => {});
  document
    .querySelectorAll("[role=tab]")[1]
    ?.addEventListener("click", clicked);
  startRun([{ at: 1, click: "Use an API key" }], clock);
  clock.advanceTo(1000);
  expect(clicked).toHaveBeenCalledTimes(1);
});

test("a click step warns when nothing has that name", () => {
  document.body.innerHTML = "<button>Go on</button>";
  const warn = mock((_message: string) => {});
  const before = console.warn;
  console.warn = warn;
  try {
    startRun([{ at: 1, click: "Stop" }], clock);
    clock.advanceTo(1000);
  } finally {
    console.warn = before;
  }
  expect(warn).toHaveBeenCalledTimes(1);
});

// React tracks an input's value with its own `value` property on the element. A type step that sets
// the value through that property hides the change from React, so onChange never fires. This test
// puts the same kind of property on the input (React itself cannot load here: it would share its
// scheduler with other test files).
test("a type step goes past an own value property, as React's tracker needs", () => {
  document.body.innerHTML = `<label for="code">Code from your browser</label><input id="code" />`;
  const input = document.querySelector("input") as HTMLInputElement;
  const native = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  );
  const ownSets: string[] = [];
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return native?.get?.call(this);
    },
    set(next: string) {
      ownSets.push(next);
      native?.set?.call(this, next);
    },
  });
  const seen: string[] = [];
  input.addEventListener("input", () => seen.push(input.value));
  startRun(
    [{ at: 1, type: "abc123#xyz", into: "Code from your browser" }],
    clock,
  );
  clock.advanceTo(1000);
  expect(ownSets).toEqual([]);
  expect(input.value).toBe("abc123#xyz");
  expect(seen).toEqual(["abc123#xyz"]);
});

test("a type step fills a textarea by its label", () => {
  document.body.innerHTML = `<label>Notes <textarea></textarea></label>`;
  startRun([{ at: 1, type: "hello", into: "Notes" }], clock);
  clock.advanceTo(1000);
  expect(document.querySelector("textarea")?.value).toBe("hello");
});

test("a type step warns when no field has that name", () => {
  document.body.innerHTML = "<input aria-label='Name' />";
  const warn = mock((_message: string) => {});
  const before = console.warn;
  console.warn = warn;
  try {
    startRun([{ at: 1, type: "x", into: "Missing" }], clock);
    clock.advanceTo(1000);
  } finally {
    console.warn = before;
  }
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("Missing");
});
