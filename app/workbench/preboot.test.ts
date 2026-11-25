import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AppFrameConfig } from "../../desktop/workbench/appContract";

type MediaList = {
  media: string;
  readonly matches: boolean;
  onchange: ((event: { matches: boolean; media: string }) => void) | null;
  addEventListener(
    type: string,
    listener: (event: { matches: boolean; media: string }) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: { matches: boolean; media: string }) => void,
  ): void;
};

type FakeWindow = {
  parent: { __workbenchAppFrame: AppFrameConfig } | FakeWindow;
  matchMedia: (query: string) => MediaList | { matches: boolean };
  localStorage?: Storage;
  sessionStorage?: Storage;
  __workbenchPrebootTheme?: (theme: "light" | "dark") => void;
  __workbenchPreboot?: boolean;
};

type Preboot = (win: FakeWindow) => void;

const PREBOOT = join(import.meta.dir, "preboot.js");

function config(overrides: Partial<AppFrameConfig> = {}): AppFrameConfig {
  return {
    scene: "app-home",
    host: "desktop",
    os: "mac",
    theme: "dark",
    skin: null,
    sidebar: null,
    role: "owner",
    api: {},
    answers: {},
    storage: { "openbot-theme-choice": "dark", count: "3" },
    ...overrides,
  };
}

function fakeWindow(frame: AppFrameConfig): FakeWindow {
  return {
    parent: { __workbenchAppFrame: frame },
    matchMedia: () => ({ matches: false }),
  };
}

let preboot: Preboot;

beforeAll(() => {
  GlobalRegistrator.register();
  const text = readFileSync(PREBOOT, "utf8");
  // The file runs as a function body: its own call returns early (no parent), and the body hands
  // the function back. A page's classic script puts it on the window instead.
  const run = new Function("window", `${text}\nreturn workbenchPreboot;`);
  preboot = run(window) as Preboot;
});

afterAll(() => GlobalRegistrator.unregister());

describe("workbenchPreboot", () => {
  test("its own call outside a workbench frame does nothing", () => {
    expect(
      (window as unknown as { __workbenchPreboot?: boolean })
        .__workbenchPreboot,
    ).toBeUndefined();
  });

  test("a window with no frame config stays the same", () => {
    const win: FakeWindow = {
      parent: undefined as never,
      matchMedia: () => ({ matches: false }),
    };
    win.parent = win;
    preboot(win);
    expect(win.__workbenchPreboot).toBeUndefined();
    expect(win.localStorage).toBeUndefined();
  });

  test("localStorage starts with the scene's storage and is not the real one", () => {
    const win = fakeWindow(config());
    preboot(win);
    expect(win.__workbenchPreboot).toBe(true);
    const local = win.localStorage as Storage;
    expect(local.getItem("openbot-theme-choice")).toBe("dark");
    expect(local.getItem("count")).toBe("3");
    expect(local.length).toBe(2);
    expect(local.getItem("missing")).toBeNull();
    local.setItem("number", 5 as unknown as string);
    expect(local.getItem("number")).toBe("5");
    expect(local.key(2)).toBe("number");
    expect(local.key(9)).toBeNull();
    expect(window.localStorage.getItem("number")).toBeNull();
    expect(local).not.toBe(window.localStorage);
    local.removeItem("count");
    expect(local.getItem("count")).toBeNull();
    local.clear();
    expect(local.length).toBe(0);
    const session = win.sessionStorage as Storage;
    expect(session.length).toBe(0);
    expect(session).not.toBe(local);
  });

  test("two frames do not share storage", () => {
    const first = fakeWindow(config());
    const second = fakeWindow(config({ storage: {} }));
    preboot(first);
    preboot(second);
    first.localStorage?.setItem("only-first", "yes");
    expect(second.localStorage?.getItem("only-first")).toBeNull();
    expect(second.localStorage?.length).toBe(0);
  });

  test("the color scheme follows the frame's theme", () => {
    const win = fakeWindow(config({ theme: "dark" }));
    preboot(win);
    const dark = win.matchMedia("(prefers-color-scheme: dark)") as MediaList;
    const light = win.matchMedia("(prefers-color-scheme:light)") as MediaList;
    expect(dark.matches).toBe(true);
    expect(light.matches).toBe(false);
    expect(dark.media).toBe("(prefers-color-scheme: dark)");
  });

  test("a theme change flips matches and tells each listener once", () => {
    const win = fakeWindow(config({ theme: "dark" }));
    preboot(win);
    const dark = win.matchMedia("(prefers-color-scheme: dark)") as MediaList;
    const events: { matches: boolean; media: string }[] = [];
    const changes: boolean[] = [];
    const listener = (event: { matches: boolean; media: string }) => {
      events.push(event);
    };
    dark.addEventListener("change", listener);
    dark.addEventListener("change", listener);
    dark.onchange = (event) => changes.push(event.matches);
    win.__workbenchPrebootTheme?.("light");
    expect(dark.matches).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.matches).toBe(false);
    expect(events[0]?.media).toBe("(prefers-color-scheme: dark)");
    expect(changes).toEqual([false]);
    dark.removeEventListener("change", listener);
    win.__workbenchPrebootTheme?.("dark");
    expect(dark.matches).toBe(true);
    expect(events).toHaveLength(1);
  });

  test("other queries go to the real matchMedia", () => {
    const win = fakeWindow(config());
    const asked: string[] = [];
    win.matchMedia = (query) => {
      asked.push(query);
      return { matches: true };
    };
    preboot(win);
    expect(win.matchMedia("(min-width: 600px)").matches).toBe(true);
    expect(asked).toEqual(["(min-width: 600px)"]);
  });
});
