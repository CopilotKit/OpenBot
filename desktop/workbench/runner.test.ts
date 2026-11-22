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
import {
  actionLabel,
  findTarget,
  playTo,
  type RunAction,
  runActions,
  startRun,
} from "./runner";

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

test("onAction sees each click and type step, with its target, before it acts", () => {
  document.body.innerHTML = `<button>Install</button><label>Code <input /></label>`;
  const button = document.querySelector("button");
  const clicked: boolean[] = [];
  button?.addEventListener("click", () => clicked.push(true));
  const seen: RunAction[] = [];
  startRun(
    [
      { at: 1, click: "Install" },
      { at: 2, emit: "x", payload: null },
      { at: 3, type: "abc", into: "Code" },
    ],
    clock,
    undefined,
    {
      onAction: (action) => {
        // Before the click: the button has not been pressed yet.
        if (action.kind === "click") expect(clicked).toEqual([]);
        seen.push(action);
      },
    },
  );
  clock.advanceTo(3000);
  expect(clicked).toEqual([true]);
  expect(seen.map(({ target, ...rest }) => rest)).toEqual([
    { kind: "click", name: "Install", at: 1000 },
    { kind: "type", name: "Code", text: "abc", at: 3000 },
  ]);
  expect(seen[0]?.target).toBe(button);
  expect(seen[1]?.target).toBe(document.querySelector("input"));
});

test("runActions lists the click and type steps in time order", () => {
  expect(
    runActions([
      { at: 5, type: "x", into: "Field" },
      { at: 1, click: "Install" },
      { at: 2, emit: "e", payload: null },
    ]),
  ).toEqual([
    { kind: "click", name: "Install", at: 1000 },
    { kind: "type", name: "Field", text: "x", at: 5000 },
  ]);
});

test("findTarget finds what the run would act on, and actionLabel names it", () => {
  document.body.innerHTML = `<button>Install</button><input aria-label="Code" />`;
  expect(findTarget(document, { kind: "click", name: "Install" })).toBe(
    document.querySelector("button"),
  );
  expect(findTarget(document, { kind: "type", name: "Code" })).toBe(
    document.querySelector("input"),
  );
  expect(findTarget(document, { kind: "click", name: "Missing" })).toBeNull();
  expect(actionLabel({ kind: "click", name: "Install" })).toBe(
    "Click · Install",
  );
  expect(actionLabel({ kind: "type", name: "Code from your browser" })).toBe(
    "Type · Code from your browser",
  );
});

test("playTo stops 1 ms before the next action", () => {
  expect(playTo(0, 600, [500, 2000])).toEqual({ to: 499, stopAt: 500 });
  // An action later than the play goes: no stop.
  expect(playTo(0, 400, [500])).toEqual({ to: 400, stopAt: null });
  // Exactly at 1 ms before: the play reaches it and stops.
  expect(playTo(0, 499, [500])).toEqual({ to: 499, stopAt: 500 });
});

test("playTo goes on through the action it stopped before", () => {
  expect(playTo(499, 700, [500, 2000])).toEqual({ to: 700, stopAt: null });
  expect(playTo(499, 5000, [500, 2000])).toEqual({ to: 1999, stopAt: 2000 });
});

test("playTo with no actions, or none ahead, goes where it is asked", () => {
  expect(playTo(100, 300, [])).toEqual({ to: 300, stopAt: null });
  expect(playTo(3000, 4000, [500, 2000])).toEqual({ to: 4000, stopAt: null });
});
