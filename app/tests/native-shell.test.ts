import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type NativeTab,
  postToShell,
  type ShellMessage,
  tabForPath,
} from "../src/lib/native-shell/bridge";
import {
  detectNativeShell,
  NATIVE_SHELL_STORAGE_KEY,
  type NativeShellEnvironment,
} from "../src/lib/native-shell/shell";

/*
 * The phone app's native shell and the web app agree on a small contract (lib/native-shell): how the
 * page knows it is in the shell, which of the shell's tabs a page belongs to, and how it tells the
 * shell. index.html works out the same answer before the first paint, so the two are held together
 * here case by case.
 */

/** Where the phone apps' UI tests and the screenshot scripts open the app. */
const LOCAL = "127.0.0.1";
/** A real deployment, where the testing override must not count. */
const PRODUCTION = "my.open.bot";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const html = readFileSync(join(import.meta.dir, "..", "index.html"), "utf8");
const inline = html.slice(
  html.indexOf("<script>") + "<script>".length,
  html.indexOf("</script>"),
);

/** index.html's inline script, run against `environment`: what it marks, and the viewport it leaves. */
function beforeFirstPaint(environment: NativeShellEnvironment) {
  const dataset: Record<string, string> = {};
  const viewport = { content: "width=device-width, initial-scale=1.0" };
  const window = {
    location: {
      search: environment.search,
      hash: "",
      pathname: "/",
      hostname: environment.hostname,
    },
    navigator: { userAgent: environment.userAgent },
    sessionStorage: environment.storage,
    localStorage: { getItem: () => null },
    matchMedia: () => ({ matches: false }),
    history: { state: null, replaceState() {} },
    __OPENBOT_NATIVE_SHELL__: environment.injected,
  };
  const document = {
    documentElement: { classList: { toggle() {} }, style: {}, dataset },
    querySelector: (selector: string) =>
      selector === 'meta[name="viewport"]' ? viewport : null,
  };
  new Function("window", "document", inline)(window, document);
  return { platform: dataset.nativeShell ?? null, viewport: viewport.content };
}

const CASES: {
  name: string;
  environment: () => NativeShellEnvironment;
  platform: "ios" | "android" | "test" | null;
}[] = [
  {
    name: "a plain browser",
    environment: () => ({
      injected: undefined,
      userAgent: IPHONE,
      search: "",
      hostname: LOCAL,
      storage: memoryStorage(),
    }),
    platform: null,
  },
  {
    name: "what the shell injects",
    environment: () => ({
      injected: { platform: "android", version: "0.1", bridge: 1 },
      userAgent: IPHONE,
      search: "",
      hostname: LOCAL,
      storage: memoryStorage(),
    }),
    platform: "android",
  },
  {
    name: "something injected that is not the shell's",
    environment: () => ({
      injected: { platform: "windows" },
      userAgent: IPHONE,
      search: "",
      hostname: LOCAL,
      storage: memoryStorage(),
    }),
    platform: null,
  },
  {
    name: "the shell's user agent on iOS",
    environment: () => ({
      injected: undefined,
      userAgent: `${IPHONE} OpenBotShell-iOS/0.1`,
      search: "",
      hostname: LOCAL,
      storage: memoryStorage(),
    }),
    platform: "ios",
  },
  {
    name: "the shell's user agent on Android",
    environment: () => ({
      injected: undefined,
      userAgent: "Mozilla/5.0 (Linux; Android 15) OpenBotShell-Android/0.1",
      search: "",
      hostname: LOCAL,
      storage: memoryStorage(),
    }),
    platform: "android",
  },
  {
    name: "?native-shell=ios for testing",
    environment: () => ({
      injected: undefined,
      userAgent: IPHONE,
      search: "?native-shell=ios",
      hostname: LOCAL,
      storage: memoryStorage(),
    }),
    platform: "test",
  },
  {
    name: "the override remembered by the tab",
    environment: () => ({
      injected: undefined,
      userAgent: IPHONE,
      search: "",
      hostname: LOCAL,
      storage: memoryStorage({ [NATIVE_SHELL_STORAGE_KEY]: "test" }),
    }),
    platform: "test",
  },
  {
    name: "?native-shell=off forgetting it",
    environment: () => ({
      injected: undefined,
      userAgent: IPHONE,
      search: "?native-shell=off",
      hostname: LOCAL,
      storage: memoryStorage({ [NATIVE_SHELL_STORAGE_KEY]: "test" }),
    }),
    platform: null,
  },
  {
    name: "?native-shell=off inside the real shell",
    environment: () => ({
      injected: undefined,
      userAgent: `${IPHONE} OpenBotShell-iOS/0.1`,
      search: "?native-shell=off",
      hostname: LOCAL,
      storage: memoryStorage(),
    }),
    platform: "ios",
  },
  {
    name: "?native-shell=ios where storage throws",
    environment: () => ({
      injected: undefined,
      userAgent: IPHONE,
      search: "?native-shell=ios",
      hostname: LOCAL,
      storage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
        removeItem: () => {
          throw new Error("denied");
        },
      },
    }),
    platform: "test",
  },
];

CASES.push(
  {
    name: "?native-shell=ios on a production host",
    environment: () => ({
      injected: undefined,
      userAgent: IPHONE,
      search: "?native-shell=ios",
      hostname: PRODUCTION,
      storage: memoryStorage(),
    }),
    platform: null,
  },
  {
    name: "the override a tab remembered, on a production host",
    environment: () => ({
      injected: undefined,
      userAgent: IPHONE,
      search: "",
      hostname: PRODUCTION,
      storage: memoryStorage({ [NATIVE_SHELL_STORAGE_KEY]: "test" }),
    }),
    platform: null,
  },
  {
    name: "the shell's user agent on a production host",
    environment: () => ({
      injected: undefined,
      userAgent: `${IPHONE} OpenBotShell-iOS/0.1`,
      search: "",
      hostname: PRODUCTION,
      storage: memoryStorage(),
    }),
    platform: "ios",
  },
  {
    name: "what the shell injects, on a production host",
    environment: () => ({
      injected: { platform: "android", version: "0.1", bridge: 1 },
      userAgent: "Mozilla/5.0 (Linux; Android 15)",
      search: "?native-shell=off",
      hostname: PRODUCTION,
      storage: memoryStorage(),
    }),
    platform: "android",
  },
  {
    name: "?native-shell=ios on a .localhost name",
    environment: () => ({
      injected: undefined,
      userAgent: IPHONE,
      search: "?native-shell=ios",
      hostname: "openbot.localhost",
      storage: memoryStorage(),
    }),
    platform: "test",
  },
);

describe("which shell the page is in", () => {
  for (const { name, environment, platform } of CASES) {
    test(`${name}: ${platform ?? "none"}, the same before the first paint`, () => {
      expect(detectNativeShell(environment())?.platform ?? null).toBe(platform);
      const painted = beforeFirstPaint(environment());
      expect(painted.platform as string | null).toBe(platform);
      // The viewport takes the whole web view in the shell, and is left alone in a browser.
      expect(painted.viewport.includes("viewport-fit=cover")).toBe(
        platform !== null,
      );
    });
  }

  test("on a production host the override is not remembered, and off still forgets one kept from before", () => {
    const storage = memoryStorage();
    detectNativeShell({
      injected: undefined,
      userAgent: IPHONE,
      search: "?native-shell=ios",
      hostname: PRODUCTION,
      storage,
    });
    expect(storage.values.has(NATIVE_SHELL_STORAGE_KEY)).toBe(false);
    storage.values.set(NATIVE_SHELL_STORAGE_KEY, "test");
    detectNativeShell({
      injected: undefined,
      userAgent: IPHONE,
      search: "?native-shell=off",
      hostname: PRODUCTION,
      storage,
    });
    expect(storage.values.has(NATIVE_SHELL_STORAGE_KEY)).toBe(false);
  });

  test("a development build honours the override on any host", () => {
    expect(
      detectNativeShell({
        injected: undefined,
        userAgent: IPHONE,
        search: "?native-shell=ios",
        hostname: PRODUCTION,
        dev: true,
        storage: memoryStorage(),
      })?.platform,
    ).toBe("test");
  });

  test("the override is remembered for the tab, and forgotten again", () => {
    const storage = memoryStorage();
    detectNativeShell({
      injected: undefined,
      userAgent: IPHONE,
      search: "?native-shell=ios",
      hostname: LOCAL,
      storage,
    });
    expect(storage.values.get(NATIVE_SHELL_STORAGE_KEY)).toBe("test");
    detectNativeShell({
      injected: undefined,
      userAgent: IPHONE,
      search: "?native-shell=off",
      hostname: LOCAL,
      storage,
    });
    expect(storage.values.has(NATIVE_SHELL_STORAGE_KEY)).toBe(false);
  });
});

describe("which of the shell's tabs a page belongs to", () => {
  const TABLE: [string, NativeTab | null][] = [
    ["/", "home"],
    ["/bot", "home"],
    ["/conversations", "conversations"],
    ["/conversations/", "conversations"],
    ["/channel/c-1", "conversations"],
    ["/channel/new", "conversations"],
    ["/group/g-1", "conversations"],
    ["/start/s-1", "conversations"],
    ["/bots", "bots"],
    ["/bots/", "bots"],
    ["/bots/b-1", "bots"],
    ["/bots/b-1/routines", "bots"],
    ["/channel", null],
    ["/botsy", null],
    ["/settings", null],
    ["/routines", null],
    ["/admin", null],
    ["/sign", null],
  ];
  for (const [path, tab] of TABLE) {
    test(`${path} → ${tab ?? "none"}`, () => {
      expect(tabForPath(path)).toBe(tab);
    });
  }
});

describe("telling the shell", () => {
  const route: ShellMessage = {
    type: "route",
    path: "/bots",
    tab: "bots",
    signedIn: true,
    canGoBack: false,
  };

  test("on iOS, the object itself to the openbotShell handler", () => {
    const got: unknown[] = [];
    postToShell(route, {
      webkit: {
        messageHandlers: {
          openbotShell: { postMessage: (message) => got.push(message) },
        },
      },
    });
    expect(got).toEqual([route]);
  });

  test("on Android, as JSON", () => {
    const got: string[] = [];
    postToShell(
      { type: "ready" },
      { OpenBotShellAndroid: { postMessage: (json) => got.push(json) } },
    );
    expect(got).toEqual(['{"type":"ready"}']);
  });

  test("nothing, and no error, with no shell or a shell that throws", () => {
    expect(() => postToShell({ type: "signed-out" }, {})).not.toThrow();
    expect(() =>
      postToShell(
        { type: "signed-out" },
        {
          webkit: {
            messageHandlers: {
              openbotShell: {
                postMessage: () => {
                  throw new Error("gone");
                },
              },
            },
          },
        },
      ),
    ).not.toThrow();
  });
});

describe("the shell's fields", () => {
  const styles = readFileSync(
    join(import.meta.dir, "..", "src", "styles.css"),
    "utf8",
  );
  const rule = (selector: string) => {
    const at = styles.indexOf(selector);
    expect(at).toBeGreaterThan(-1);
    return styles.slice(at, styles.indexOf("}", at));
  };

  // iOS zooms the page into any field under 16px when it is focused.
  test("every field a person types in is 16px, so iOS does not zoom in on it", () => {
    const fields = rule("html[data-native-shell]\n:is(\n  input:not(");
    expect(fields).toContain("textarea");
    expect(fields).toContain("font-size: 1rem;");
  });
});
