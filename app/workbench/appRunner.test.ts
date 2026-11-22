import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { NativeControl } from "../../desktop/src/fakeNative/control";
import type {
  ApiControl,
  AppRunStep,
  SocketControl,
  StreamControl,
} from "../../desktop/workbench/appContract";
import {
  type ClockTarget,
  installClock,
  type PageClock,
  SCENE_EPOCH,
} from "../../desktop/workbench/clock";
import type { RunAction } from "../../desktop/workbench/domSteps";
import { type AppRunDeps, navigateIn, startAppRun } from "./appRunner";

beforeAll(() =>
  GlobalRegistrator.register({
    url: "http://localhost:3021/",
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterAll(() => GlobalRegistrator.unregister());

let clock: PageClock;
let seen: string[];
let socketMatches: number;

function fakeDeps(): AppRunDeps {
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      seen.push(`${clock.now()} ${name} ${JSON.stringify(args)}`);
    };
  const control = {
    setAnswer: record("control.setAnswer"),
  } as unknown as NativeControl;
  const api = {
    setAnswer: record("api.setAnswer"),
    clearAnswer: record("api.clearAnswer"),
  } as unknown as ApiControl;
  const streams = {
    push: record("streams.push"),
    end: record("streams.end"),
  } as unknown as StreamControl;
  const sockets = {
    send: (...args: unknown[]) => {
      record("sockets.send")(...args);
      return socketMatches;
    },
  } as unknown as SocketControl;
  return {
    control,
    api,
    streams,
    sockets,
    root: document,
    navigate: record("navigate"),
  };
}

beforeEach(() => {
  seen = [];
  socketMatches = 1;
  document.body.innerHTML = "";
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

const problem = { said: "It failed." };

test("each step kind reaches its dep at its time", () => {
  const steps: AppRunStep[] = [
    { at: 1, answer: "cmd", with: { mode: "never" } },
    { at: 2, settle: "cmd", value: "done" },
    { at: 3, fail: "cmd", problem },
    {
      at: 4,
      api: "GET /api/v2/me",
      with: { mode: "value", body: { ok: true } },
    },
    { at: 5, api: "GET /api/v2/me", with: null },
    { at: 6, stream: "bot", events: [{ type: "RUN_STARTED" }] },
    { at: 7, streamEnd: "bot" },
    { at: 8, socket: "/ws", send: { hello: 1 } },
    { at: 9, navigate: "/settings" },
  ];
  startAppRun(steps, clock, fakeDeps());
  clock.advanceTo(999);
  expect(seen).toEqual([]);
  clock.advanceTo(9000);
  expect(seen).toEqual([
    `1000 control.setAnswer ["cmd",{"mode":"never"}]`,
    `2000 control.setAnswer ["cmd",{"mode":"value","value":"done"}]`,
    `3000 control.setAnswer ["cmd",{"mode":"fail","problem":{"said":"It failed."}}]`,
    `4000 api.setAnswer ["GET /api/v2/me",{"mode":"value","body":{"ok":true}}]`,
    `5000 api.clearAnswer ["GET /api/v2/me"]`,
    `6000 streams.push ["bot",[{"type":"RUN_STARTED"}]]`,
    `7000 streams.end ["bot"]`,
    `8000 sockets.send ["/ws",{"hello":1}]`,
    `9000 navigate ["/settings"]`,
  ]);
});

test("onAction gets a click and a type action with the target before the act", () => {
  document.body.innerHTML =
    '<button type="button">Save</button><label>Name <input id="n" /></label>';
  const button = document.querySelector("button") as HTMLButtonElement;
  const input = document.querySelector("input") as HTMLInputElement;
  const order: string[] = [];
  button.addEventListener("click", () => order.push("clicked"));
  input.addEventListener("input", () => order.push("typed"));
  const actions: RunAction[] = [];
  startAppRun(
    [
      { at: 1, click: "Save" },
      { at: 2, type: "Sam Rivera", into: "Name" },
    ],
    clock,
    fakeDeps(),
    {
      onAction(action) {
        order.push(`action ${action.kind}`);
        actions.push(action);
      },
    },
  );
  clock.advanceTo(2000);
  expect(order).toEqual(["action click", "clicked", "action type", "typed"]);
  expect(actions).toEqual([
    { kind: "click", name: "Save", at: 1000, target: button },
    {
      kind: "type",
      name: "Name",
      text: "Sam Rivera",
      at: 2000,
      target: input,
    },
  ]);
  expect(input.value).toBe("Sam Rivera");
});

test("end and nextAt are in milliseconds", () => {
  const run = startAppRun(
    [
      { at: 3, navigate: "/a" },
      { at: 1.5, navigate: "/b" },
    ],
    clock,
    fakeDeps(),
  );
  expect(run.end).toBe(3000);
  expect(run.nextAt(0)).toBe(1500);
  expect(run.nextAt(1500)).toBe(3000);
  expect(run.nextAt(3000)).toBeNull();
  expect(startAppRun([], clock, fakeDeps()).end).toBe(0);
});

test("a socket step with no open socket warns", () => {
  socketMatches = 0;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    startAppRun([{ at: 1, socket: "/ws", send: "x" }], clock, fakeDeps());
    clock.advanceTo(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toStartWith("Run step:");
  } finally {
    warn.mockRestore();
  }
});

test("navigateIn pushes the path and sends popstate", () => {
  const popped = mock((_e: Event) => {});
  window.addEventListener("popstate", popped);
  try {
    navigateIn(window, "/settings/computer");
    expect(window.location.pathname).toBe("/settings/computer");
    expect(popped).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("popstate", popped);
  }
});
