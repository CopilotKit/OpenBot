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
