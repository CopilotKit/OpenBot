import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { ThemeProvider, useTheme } from "../src/components/theme-provider";
import {
  applyTheme,
  LEGACY_THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
  SYSTEM_DARK_QUERY,
  THEME_STORAGE_KEY,
} from "../src/lib/theme";

/**
 * OpenBot follows the system unless the person chose otherwise: System, Light or Dark, with System
 * the default, decided before the first paint.
 */
describe("theme preference", () => {
  test("nothing stored follows the system", () => {
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("nonsense")).toBe("system");
  });

  test("a stored choice is kept", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
  });

  test("OpenBot's old switch counts only when it was turned on", () => {
    // It wrote "light" on every load whether or not anybody chose it.
    expect(parseThemePreference(null, "light")).toBe("system");
    expect(parseThemePreference(null, "dark")).toBe("dark");
    // A choice made since wins over it.
    expect(parseThemePreference("light", "dark")).toBe("light");
  });

  test("following the system draws what the system is set to", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("drawing a theme sets the class and the colour scheme", () => {
    const toggles: Array<[string, boolean]> = [];
    const schemes: string[] = [];
    applyTheme("dark", {
      toggleRootClass: (name, force) => toggles.push([name, force]),
      setRootColorScheme: (scheme) => schemes.push(scheme),
    });
    applyTheme("light", {
      toggleRootClass: (name, force) => toggles.push([name, force]),
      setRootColorScheme: (scheme) => schemes.push(scheme),
    });
    expect(toggles).toEqual([
      ["dark", true],
      ["dark", false],
    ]);
    expect(schemes).toEqual(["dark", "light"]);
  });
});

describe("pre-paint theme boot", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const boot = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);

  /** Runs the inline script against a stand-in document, storage and system setting. */
  function bootWith(
    stored: Record<string, string>,
    systemDark: boolean,
    storageThrows = false,
  ) {
    const classes = new Set<string>();
    const style: { colorScheme?: string } = {};
    const queries: string[] = [];
    runInNewContext(boot?.[1] ?? "", {
      window: {
        localStorage: {
          getItem: (key: string) => {
            if (storageThrows) throw new Error("denied");
            return stored[key] ?? null;
          },
        },
        matchMedia: (query: string) => {
          queries.push(query);
          return { matches: systemDark };
        },
      },
      document: {
        documentElement: {
          classList: {
            toggle: (name: string, force: boolean) =>
              force ? classes.add(name) : classes.delete(name),
          },
          style,
        },
      },
    });
    return { dark: classes.has("dark"), scheme: style.colorScheme, queries };
  }

  test("with nothing chosen it follows the system", () => {
    expect(bootWith({}, true)).toMatchObject({ dark: true, scheme: "dark" });
    expect(bootWith({}, false)).toMatchObject({ dark: false, scheme: "light" });
    expect(bootWith({}, true).queries).toEqual([SYSTEM_DARK_QUERY]);
  });

  test("it reads the keys the app writes, and a choice beats the system", () => {
    expect(bootWith({ [THEME_STORAGE_KEY]: "light" }, true).dark).toBe(false);
    expect(bootWith({ [THEME_STORAGE_KEY]: "dark" }, false).dark).toBe(true);
    expect(bootWith({ [THEME_STORAGE_KEY]: "system" }, true).dark).toBe(true);
    expect(bootWith({ [LEGACY_THEME_STORAGE_KEY]: "dark" }, false).dark).toBe(
      true,
    );
    expect(bootWith({ [LEGACY_THEME_STORAGE_KEY]: "light" }, true).dark).toBe(
      true,
    );
    // The same rule as `lib/theme.ts` for everything either key can hold, so the app never redraws.
    const held = [undefined, "system", "light", "dark", "nonsense"];
    for (const stored of held)
      for (const legacy of held)
        for (const systemDark of [true, false]) {
          const keys: Record<string, string> = {};
          if (stored) keys[THEME_STORAGE_KEY] = stored;
          if (legacy) keys[LEGACY_THEME_STORAGE_KEY] = legacy;
          const theme = resolveTheme(
            parseThemePreference(stored ?? null, legacy ?? null),
            systemDark,
          );
          expect({
            keys,
            systemDark,
            dark: bootWith(keys, systemDark).dark,
          }).toEqual({ keys, systemDark, dark: theme === "dark" });
        }
  });

  test("storage that throws still follows the system", () => {
    expect(bootWith({}, true, true)).toMatchObject({
      dark: true,
      scheme: "dark",
    });
    expect(bootWith({}, false, true)).toMatchObject({
      dark: false,
      scheme: "light",
    });
  });
});

/**
 * The provider, once the app has loaded: it reads the keys the boot script read, follows the system
 * live while the choice is System, and writes only the new key, only when somebody chooses.
 */
describe("the theme provider", () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());

  /** A stand-in for the system's setting that a test can flip, as the system does at sunset. */
  let systemDark = false;
  const listeners = new Set<() => void>();
  function setSystemDark(next: boolean) {
    systemDark = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  }

  let originalMatchMedia: typeof window.matchMedia;
  beforeEach(() => {
    systemDark = false;
    listeners.clear();
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      media: query,
      get matches() {
        return query === SYSTEM_DARK_QUERY && systemDark;
      },
      addEventListener: (_type: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        listeners.delete(listener),
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  let theme: ReturnType<typeof useTheme> | undefined;
  function Probe() {
    theme = useTheme();
    return null;
  }
  function renderProvider() {
    theme = undefined;
    render(createElement(ThemeProvider, null, createElement(Probe)));
  }
  const drawn = () => ({
    dark: document.documentElement.classList.contains("dark"),
    scheme: document.documentElement.style.colorScheme,
  });

  test("with nothing chosen it follows the system, live", () => {
    renderProvider();
    expect(theme?.preference).toBe("system");
    expect(drawn()).toEqual({ dark: false, scheme: "light" });

    setSystemDark(true);
    expect(theme?.resolved).toBe("dark");
    expect(drawn()).toEqual({ dark: true, scheme: "dark" });

    setSystemDark(false);
    expect(drawn()).toEqual({ dark: false, scheme: "light" });
  });

  test("a choice beats the system, and stops following it", () => {
    renderProvider();
    act(() => theme?.setPreference("light"));
    setSystemDark(true);
    expect(drawn()).toEqual({ dark: false, scheme: "light" });

    act(() => theme?.setPreference("dark"));
    setSystemDark(false);
    expect(drawn()).toEqual({ dark: true, scheme: "dark" });
  });

  test("only a choice is written, and only under the new key", () => {
    renderProvider();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();

    act(() => theme?.setPreference("dark"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
  });

  test("the old switch's Light lands on System, and its Dark stays Dark", () => {
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "light");
    systemDark = true;
    renderProvider();
    expect(theme?.preference).toBe("system");
    expect(drawn().dark).toBe(true);
    cleanup();

    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "dark");
    systemDark = false;
    renderProvider();
    expect(theme?.preference).toBe("dark");
    expect(drawn().dark).toBe(true);
  });

  test("storage that throws still follows the system after the app loads", () => {
    const storage = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    try {
      expect(() => window.localStorage).toThrow("denied");
      systemDark = true;
      renderProvider();
      expect(theme?.preference).toBe("system");
      expect(drawn()).toEqual({ dark: true, scheme: "dark" });

      // The choice still holds for this visit; it just isn't remembered.
      act(() => theme?.setPreference("light"));
      expect(drawn()).toEqual({ dark: false, scheme: "light" });
    } finally {
      if (storage) Object.defineProperty(window, "localStorage", storage);
      else Reflect.deleteProperty(window, "localStorage");
    }
  });
});

describe("color scheme", () => {
  const styles = readFileSync(
    new URL("../src/theme.css", import.meta.url),
    "utf8",
  );

  test("both themes tell the browser which one they are", () => {
    expect(styles).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?color-scheme:\s*dark/);
  });

  // The Recorder's pages import theme.css too, so the chat's own rules live in styles.css.
  test("the shared theme carries no chat-only rule", () => {
    expect(styles).not.toContain("tool-line");
    expect(styles).not.toContain("websandbox");
    const app = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(app).toContain(".tool-line-running");
    expect(app).toContain("iframe.websandbox__frame");
  });
});
